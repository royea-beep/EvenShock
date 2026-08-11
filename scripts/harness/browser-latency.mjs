/**
 * The submit round trip, measured from a real browser playing the real app.
 *
 *   npm run e2e:browser
 *
 * This is the number the project has never had. Every latency figure so far was
 * server-to-server — p50 294ms measured from inside a datacentre — which says
 * nothing about whether fast mode's 501ms reveal survives contact with a client.
 *
 * It drives the deployed site through its own UI: click Connect, pick a format,
 * click Rock, click Next round. So it measures more than a socket. It proves the
 * built bundle loads, the CSP allows the Supabase origin (which it did not,
 * once), sign-in works end to end, and the round protocol completes — in
 * production, which no test has ever done.
 *
 * The figure itself comes from `window.evenshockLatency()`, the app's OWN
 * instrumentation, so it is the same measurement a player's console would show
 * rather than a second stopwatch that could disagree with it.
 *
 * WHAT IT IS NOT: the number in src/utils/latency.ts's docstring. That needs a
 * phone on mobile data. This is a FLOOR — a desktop on a good connection is the
 * best case and a real player is somewhere worse. A comfortable result here
 * means "not yet disproved", never "fast mode is fine".
 *
 * The wallet is a stub backed by a keypair, injected before any page script
 * runs, so sign-in takes the real Sign-In With Solana path. THE PRIVATE KEY
 * NEVER ENTERS THE BROWSER: signing is an exposed binding and the page only
 * ever receives the finished signature.
 */
import { chromium } from 'playwright-core';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { chromiumLaunchOptions } from './chromium.mjs';

const SITE = process.env.EVENSHOCK_SITE ?? 'https://ftable.co.il/evenshock/';
const MATCHES = Number(process.env.EVENSHOCK_MATCHES ?? 4);
const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const HEADLESS = process.env.EVENSHOCK_HEADED !== '1';

// From src/constants/gameConfig.ts. A submit slower than these means the reveal
// animation waits for the network, which is the thing that must not happen —
// the animation is the product, and the latency is the constraint.
const FAST_BUDGET_MS = 501;
const NORMAL_BUDGET_MS = 870;

const player = Keypair.fromSeed(new Uint8Array(32).fill(9));

const browser = await chromium.launch(chromiumLaunchOptions({ headless: HEADLESS }));
const page = await (await browser.newContext()).newPage();

const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// Signing stays here, in Node. The page asks and receives bytes; it never holds
// anything it could sign a second message with.
await page.exposeFunction('__evenshockSign', (bytes) => [
  ...nacl.sign.detached(Uint8Array.from(bytes), player.secretKey),
]);

// Transaction signing, for the shop. Same rule as the message signing above:
// the key stays in Node and the page receives only the signature.
await page.exposeFunction('__evenshockSignTx', (bytes) => [
  ...nacl.sign.detached(Uint8Array.from(bytes), player.secretKey),
]);

// A real wallet broadcasts as well as signs. Doing it from Node keeps the page
// honest — it exercises purchase.ts's construction, not a shortcut around it.
await page.exposeFunction('__evenshockSendRaw', async (raw) => {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [Buffer.from(Uint8Array.from(raw)).toString('base64'), { encoding: 'base64' }],
    }),
  });
  const doc = await res.json();
  if (doc.error) throw new Error(doc.error.message ?? 'sendTransaction failed');
  return doc.result;
});

await page.addInitScript(
  ({ address }) => {
    // The minimal shape auth-js looks for on window.solana. Injected before any
    // page script, so the app finds a wallet on first render exactly as it would
    // with an extension installed.
    window.solana = {
      isPhantom: true,
      publicKey: { toBase58: () => address, toString: () => address },
      connect: async () => ({ publicKey: { toBase58: () => address } }),
      signMessage: async (message) => Uint8Array.from(await window.__evenshockSign([...message])),
    };
  },
  { address: player.publicKey.toBase58() },
);

/**
 * Clicks a control by its accessible name, or explains what it could not find.
 *
 * `role` matters more than it looks: the format pills are `role="radio"` inside
 * a radiogroup, not buttons, so asking for a button silently never matches them
 * and the harness quietly plays the wrong format. Found exactly that way.
 */
async function click(name, { optional = false, timeout = 15_000, role = 'button' } = {}) {
  const target = page.getByRole(role, { name, exact: false }).first();
  try {
    await target.click({ timeout });
    return true;
  } catch (err) {
    if (optional) return false;
    throw new Error(
      `could not click "${name}" — the UI copy may have changed since this harness was written.\n` +
        `  copy lives in src/constants/copy.ts; run with EVENSHOCK_HEADED=1 to watch.\n  ${err.message}`,
    );
  }
}

console.log(`\n  loading ${SITE}`);
const response = await page.goto(SITE, { waitUntil: 'networkidle', timeout: 60_000 });
console.log(`  HTTP ${response?.status()}`);

// The probe is installed by an effect in App.tsx, so its presence is proof the
// app mounted rather than the shell merely having loaded.
await page.waitForFunction(() => typeof window.evenshockLatency === 'function', null, {
  timeout: 30_000,
});
console.log('  app mounted');

await click('Connect wallet');
await click('Connect anyway', { optional: true, timeout: 3_000 }); // guest-progress notice
await page.waitForTimeout(2_000);
console.log(`  signed in as ${player.publicKey.toBase58()}`);

// ------------------------------------------------------------------ play
//
// Best of 5 to get the most submits per match. Rock every time: the server
// draws uniformly and independently, so the player's move cannot bias how long
// a round takes.

let matchesPlayed = 0;
for (let m = 0; m < MATCHES; m += 1) {
  await click('Best of 5', { role: 'radio', optional: true, timeout: 5_000 });
  if (!(await click('Start game', { optional: m > 0, timeout: 10_000 }))) break;

  // A bo5 needs three wins by one side and ties replay, so it usually lands in
  // six or seven rounds. Twenty is headroom, not an expectation — stopping
  // short would leave the match unfinished and the next iteration confused.
  for (let round = 0; round < 20; round += 1) {
    // The move controls appear only after the countdown animation, so the
    // timeout here is waiting for choreography rather than for the network.
    if (!(await click('Rock', { optional: true, timeout: 20_000 }))) break;
    // Wait for whichever button the result screen offers.
    const next = await click('Next round', { optional: true, timeout: 20_000 });
    if (!next) {
      await click('See results', { optional: true, timeout: 20_000 });
      break;
    }
  }

  matchesPlayed += 1;
  await click('Play again', { optional: true, timeout: 10_000 });
}

const summary = await page.evaluate(() => window.evenshockLatency());

// ------------------------------------------------------------ the shop
//
// The purchase flow, driven through its own UI against the live server. This
// is the half `browser-preflight.mjs` cannot reach: the preflight stubs the RPC
// and the wallet, so it proves the transfer is BUILT correctly and stops there.
// Everything after the signature — the wallet signing, the chain accepting it,
// confirm_payment verifying it, chips landing — has still never run in a
// browser, and that is where "Buffer is not defined" was hiding.
//
// The stub wallet signs for real with the harness keypair, so this needs that
// account funded with devnet USDC (npm run devnet:setup handles the payer; this
// is a different key). Skipped rather than failed when it is not.

const shop = { attempted: false, reached: null, credited: null, error: null };
if (process.env.EVENSHOCK_SKIP_SHOP !== '1') {
  shop.attempted = true;
  try {
    // signAndSendTransaction is what purchase.ts asks for — distinct from the
    // signMessage the sign-in path uses.
    await page.evaluate(() => {
      const w = window;
      w.solana.signAndSendTransaction = async (tx) => {
        const bytes = [...tx.serializeMessage()];
        const sig = await w.__evenshockSignTx(bytes);
        tx.addSignature(w.solana.publicKey, Uint8Array.from(sig));
        const raw = [...tx.serialize()];
        return { signature: await w.__evenshockSendRaw(raw) };
      };
    });

    const opened = await click('Buy 100 chips', { optional: true, timeout: 10_000 });
    if (!opened) {
      shop.reached = 'no buy button — is the shop visible for this account?';
    } else {
      // Order matters and mirrors usePurchase.buy(): an open intent is checked
      // BEFORE the ToS state, so the resume prompt can appear first.
      await click('Cancel that and start a new purchase', { optional: true, timeout: 5_000 });

      // The ToS gate is deliberately blocking, and its continue button stays
      // disabled until the checkbox is ticked BY the player. Clicking straight
      // for "continue" hangs on a disabled control — which is the gate working.
      const gate = page.getByRole('checkbox').first();
      if (await gate.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await gate.check();
        await click('I understand — continue', { optional: true, timeout: 5_000 });
      }

      // Credited, or still pending after the network takes its time — both are
      // successful outcomes of the browser half. Only an error modal is a fail.
      const credited = await page
        .getByText(/Credited: \+\d+ chips/i)
        .first()
        .waitFor({ timeout: 120_000 })
        .then(() => true)
        .catch(() => false);
      shop.credited = credited;
      shop.reached = credited ? 'credited' : await currentPurchaseState();
    }
  } catch (err) {
    shop.error = String(err?.message ?? err);
  }
}

/** Whatever the purchase modal is currently saying, for the report. */
async function currentPurchaseState() {
  return await page
    .evaluate(() => document.querySelector('[role="dialog"]')?.textContent?.slice(0, 200) ?? null)
    .catch(() => null);
}

await browser.close();

// --------------------------------------------------------------- report

const round1 = (n) => Math.round(n);
console.log(`\n  matches played: ${matchesPlayed}`);
console.log(`  submits measured: ${summary.n}`);

if (!summary.n) {
  console.error('\n  No submits recorded — the app never completed a round. Nothing to report.\n');
  process.exit(1);
}

console.log(`\n  submit round trip, from the browser:`);
console.log(`    p50   ${round1(summary.p50)}ms`);
console.log(`    p95   ${round1(summary.p95)}ms`);
console.log(`    worst ${round1(summary.worst)}ms`);
console.log(`\n  against the reveal budgets:`);
for (const [label, budget] of [
  ['fast  ', FAST_BUDGET_MS],
  ['normal', NORMAL_BUDGET_MS],
]) {
  const p50 = summary.p50 <= budget ? 'within' : 'OVER';
  const p95 = summary.p95 <= budget ? 'within' : 'OVER';
  console.log(`    ${label} ${budget}ms — p50 ${p50}, p95 ${p95}`);
}

console.log(`\n  console errors: ${consoleErrors.length}`);
for (const e of consoleErrors.slice(0, 5)) console.log(`    ${e}`);

console.log(`\n  purchase flow:`);
if (!shop.attempted) console.log('    skipped (EVENSHOCK_SKIP_SHOP=1)');
else if (shop.error) console.log(`    ERROR — ${shop.error}`);
else if (shop.credited) console.log('    credited — the browser purchase path works end to end');
else console.log(`    not credited — ${shop.reached}`);

console.log(
  `\n  This is a desktop floor, not the phone number src/utils/latency.ts asks for.\n` +
    `  A real player is somewhere worse than this.\n`,
);

process.exit(shop.error ? 1 : 0);
