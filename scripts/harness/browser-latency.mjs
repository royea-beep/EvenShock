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

const SITE = process.env.EVENSHOCK_SITE ?? 'https://ftable.co.il/evenshock/';
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const MATCHES = Number(process.env.EVENSHOCK_MATCHES ?? 4);
const HEADLESS = process.env.EVENSHOCK_HEADED !== '1';

// From src/constants/gameConfig.ts. A submit slower than these means the reveal
// animation waits for the network, which is the thing that must not happen —
// the animation is the product, and the latency is the constraint.
const FAST_BUDGET_MS = 501;
const NORMAL_BUDGET_MS = 870;

const player = Keypair.fromSeed(new Uint8Array(32).fill(9));

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: HEADLESS });
const page = await (await browser.newContext()).newPage();

const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// Signing stays here, in Node. The page asks and receives bytes; it never holds
// anything it could sign a second message with.
await page.exposeFunction('__evenshockSign', (bytes) => [
  ...nacl.sign.detached(Uint8Array.from(bytes), player.secretKey),
]);

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

console.log(
  `\n  This is a desktop floor, not the phone number src/utils/latency.ts asks for.\n` +
    `  A real player is somewhere worse than this.\n`,
);
