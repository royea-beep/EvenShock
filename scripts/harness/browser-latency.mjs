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
import nacl from 'tweetnacl';
import { Transaction } from '@solana/web3.js';
import { chromiumLaunchOptions } from './chromium.mjs';
import { BROWSER_WALLET } from './browser-wallet-key.mjs';

const SITE = process.env.EVENSHOCK_SITE ?? 'https://ftable.co.il/evenshock/';
const MATCHES = Number(process.env.EVENSHOCK_MATCHES ?? 4);
const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const HEADLESS = process.env.EVENSHOCK_HEADED !== '1';
const OVERALL_BUDGET_MS = Number(process.env.EVENSHOCK_BUDGET_MS ?? 10 * 60_000);

// A silent hang once burned a whole terminal — no output, no diagnosis. Every
// await now goes through step(), which names what it was waiting for on
// timeout, and a top-level watchdog kills the process if the whole run exceeds
// its budget. Never sit forever again.
async function step(label, work, ms = 30_000) {
  const started = Date.now();
  process.stdout.write(`  · ${label}…`);
  let handle;
  try {
    const timeout = new Promise((_, reject) => {
      handle = setTimeout(
        () => reject(new Error(`step "${label}" exceeded ${ms}ms — nothing came back`)),
        ms,
      );
    });
    const value = await Promise.race([Promise.resolve().then(work), timeout]);
    process.stdout.write(` ${Date.now() - started}ms\n`);
    return value;
  } catch (err) {
    process.stdout.write(` FAILED after ${Date.now() - started}ms\n`);
    throw err;
  } finally {
    clearTimeout(handle);
  }
}

const watchdog = setTimeout(() => {
  console.error(
    `\n  WATCHDOG — the whole harness exceeded ${OVERALL_BUDGET_MS}ms. Killing the process so it cannot sit forever.\n`,
  );
  process.exit(2);
}, OVERALL_BUDGET_MS);
watchdog.unref?.();

// From src/constants/gameConfig.ts. A submit slower than these means the reveal
// animation waits for the network, which is the thing that must not happen —
// the animation is the product, and the latency is the constraint.
const FAST_BUDGET_MS = 501;
const NORMAL_BUDGET_MS = 870;

// The seed and derived keypair live in ./browser-wallet-key.mjs so that
// devnet:setup, fund-browser-wallet, and this file cannot drift.
const player = BROWSER_WALLET;

const browser = await step(
  'launch chromium',
  () => chromium.launch(chromiumLaunchOptions({ headless: HEADLESS })),
  60_000,
);
const page = await step('open new page', async () => (await browser.newContext()).newPage(), 15_000);

const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// Signing stays here, in Node. The page asks and receives bytes; it never holds
// anything it could sign a second message with.
await page.exposeFunction('__evenshockSign', (bytes) => [
  ...nacl.sign.detached(Uint8Array.from(bytes), player.secretKey),
]);

// The shop tx signer/sender lives entirely in Node, and the page only ever
// receives the final signature. Doing tx assembly in the browser stub required
// `tx.addSignature(publicKey, sig)` where publicKey is our fake `window.solana`
// object — web3.js does `.equals()` and `.toBuffer()` on it, so the signature
// lands in the wrong slot, the RPC accepts the malformed bytes and returns a
// signature-shaped response, and the tx never actually lands on chain. The
// symptom is a "not yet verified" failure with no USDC missing from the
// wallet — which is exactly the ghost we chased before this rewrite.
//
// Instead, the browser stub serializes the UNSIGNED tx (which is valid — the
// wallet is the only required signer) and Node rebuilds it with a real
// Keypair, signs it properly, and broadcasts.
// Mirrors what Phantom's signAndSendTransaction does in production: sign,
// broadcast, and only return once the network has at least seen the tx.
// The previous fire-and-forget version returned a signature the moment RPC
// accepted the base64 blob, even when the tx failed on chain or the blockhash
// expired before it landed — the app would then call confirm_payment with a
// signature for a tx that had never landed, and the server would correctly
// say "Payment could not be verified." Confirming here means a real failure
// throws in the browser at signAndSendTransaction and the app sees the shape
// it would see from a real wallet.
await page.exposeFunction('__evenshockSignAndSendUnsignedTx', async (rawUnsigned) => {
  const { Connection } = await import('@solana/web3.js');
  const conn = new Connection(RPC_URL, 'confirmed');

  // Rebuild the transaction from scratch rather than mutating the one the app
  // built. Two reasons:
  //
  // 1. The app's blockhash comes from browserRpc() — currently
  //    https://api.devnet.solana.com — while the shim broadcasts to RPC_URL
  //    (Helius in the harness env). Devnet's public RPC and Helius are not
  //    slot-synced, so a hash minted on one is often "not found" on the other
  //    at broadcast time. A real wallet doesn't hit this because Phantom owns
  //    both fetch and broadcast; the shim can just use a hash from the RPC
  //    that will receive the send.
  //
  // 2. Transaction.from() + mutate recentBlockhash + partialSign() lands a
  //    valid signature at RPC (RPC returns a signature) but validators drop
  //    the tx — the signature covers the pre-mutation message. Extracting
  //    instructions and building a fresh Transaction sidesteps that.
  //
  // 'finalized' commitment because Helius load-balances across backends: a
  // 'confirmed' hash from one backend often is not yet visible to the one
  // that receives the send. A finalized hash has propagated everywhere.
  const received = Transaction.from(Uint8Array.from(rawUnsigned));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
  const tx = new Transaction();
  for (const ix of received.instructions) tx.add(ix);
  tx.feePayer = received.feePayer ?? player.publicKey;
  tx.recentBlockhash = blockhash;
  console.log(`  [shim] rebuilt tx with blockhash ${blockhash.slice(0, 12)}… (finalized)`);

  tx.partialSign(player);

  // Simulate first so a rejected tx tells us exactly why, not "expired 60s
  // later." Preflight the same way the RPC would but with the same node we're
  // about to send to, so blockhash-visibility issues can't mask a real error.
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    console.log(`  [shim] simulateTransaction failed: ${JSON.stringify(sim.value.err)}`);
    if (sim.value.logs) for (const l of sim.value.logs) console.log(`      ${l}`);
    throw new Error(`simulate: ${JSON.stringify(sim.value.err)}`);
  }

  const signed = tx.serialize();
  const signature = await conn.sendRawTransaction(signed, {
    skipPreflight: true,
    maxRetries: 5,
  });
  console.log(`  [shim] tx submitted: ${signature}`);

  // Confirm the way a real wallet does — return only after the network has
  // actually accepted the tx, so signAndSendTransaction rejecting means a
  // real rejection the app can render, not a signature for a tx that never
  // landed.
  try {
    const status = await conn.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (status.value.err) {
      console.log(`  [shim] tx failed on chain: ${JSON.stringify(status.value.err)}`);
      const detail = await conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (detail?.meta?.logMessages) {
        console.log('  [shim] program logs:');
        for (const line of detail.meta.logMessages) console.log(`      ${line}`);
      }
      throw new Error(`tx failed on chain: ${JSON.stringify(status.value.err)}`);
    }
    console.log(`  [shim] tx confirmed: ${signature}`);
  } catch (err) {
    console.log(`  [shim] confirmTransaction threw: ${err.message}`);
    throw err;
  }
  return signature;
});

await page.addInitScript(
  ({ address }) => {
    // The minimal shape auth-js looks for on window.solana. Injected before any
    // page script, so the app finds a wallet on first render exactly as it would
    // with an extension installed.
    //
    // signAndSendTransaction lives here rather than being tacked on later,
    // because purchase.ts's getBrowserSolanaWallet() calls it at ChipsShop's
    // FIRST render — if it isn't a function then, the shop mounts with the buy
    // button disabled and `wallet: 'Chip purchases need a Solana wallet in
    // this release.'` copy showing, and no amount of later assignment recovers
    // that render. The harness caught this the hard way: shop section present,
    // Buy button present, but disabled — for a full run.
    window.solana = {
      isPhantom: true,
      publicKey: { toBase58: () => address, toString: () => address },
      connect: async () => ({ publicKey: { toBase58: () => address } }),
      signMessage: async (message) => Uint8Array.from(await window.__evenshockSign([...message])),
      signAndSendTransaction: async (tx) => {
        // The unsigned tx round-trips to Node, which owns the Keypair and does
        // the real signing + broadcast. `serialize` with signature checks off
        // is valid on an unsigned wallet-signer tx because there are no other
        // required signers to verify. The page only ever receives the final
        // signature back — the key never enters the browser.
        const raw = [
          ...tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ];
        return { signature: await window.__evenshockSignAndSendUnsignedTx(raw) };
      },
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
const response = await step(
  'page.goto',
  () => page.goto(SITE, { waitUntil: 'networkidle', timeout: 60_000 }),
  75_000,
);
console.log(`  HTTP ${response?.status()}`);

// The probe is installed by an effect in App.tsx, so its presence is proof the
// app mounted rather than the shell merely having loaded.
await step(
  'wait for window.evenshockLatency',
  () =>
    page.waitForFunction(() => typeof window.evenshockLatency === 'function', null, {
      timeout: 30_000,
    }),
  35_000,
);
console.log('  app mounted');

await step('click Connect wallet', () => click('Connect wallet'), 20_000);
await step(
  'dismiss guest-progress notice',
  () => click('Connect anyway', { optional: true, timeout: 3_000 }),
  6_000,
);

// Was: `waitForTimeout(2_000)` and a printed guess. That is not a
// verification — the harness would happily continue reporting "signed in" while
// auth was actually stuck. WalletButton renders the shortened address (first
// four chars + "…" + last four) once auth.status === 'authenticated', so wait
// for the address to actually appear.
const shortAddress = `${player.publicKey.toBase58().slice(0, 4)}…${player.publicKey.toBase58().slice(-4)}`;
await step(
  `wait for authenticated (button shows ${shortAddress})`,
  () =>
    page
      .getByRole('button', { name: shortAddress, exact: false })
      .first()
      .waitFor({ timeout: 20_000 }),
  22_000,
);
console.log(`  signed in as ${player.publicKey.toBase58()}`);

// ------------------------------------------------------------------ play
//
// Best of 5 to get the most submits per match. Rock every time: the server
// draws uniformly and independently, so the player's move cannot bias how long
// a round takes.

let matchesPlayed = 0;
for (let m = 0; m < MATCHES; m += 1) {
  await step(
    `match ${m + 1}: select Best of 5`,
    () => click('Best of 5', { role: 'radio', optional: true, timeout: 5_000 }),
    7_000,
  );
  const started = await step(
    `match ${m + 1}: click Start game`,
    () => click('Start game', { optional: m > 0, timeout: 10_000 }),
    12_000,
  );
  if (!started) break;

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
  // "Play again" fires handleStart directly and jumps to RoundScreen — it does
  // NOT go back to Home. To keep iterating matches (and to leave the app on a
  // screen where the shop card is mounted), take "Change look" instead, which
  // is bound to handleLeave and returns to Home. Getting that wrong once cost
  // three matches and a false "no buy button" report.
  await step(
    `match ${m + 1}: return to Home via Change look`,
    () => click('Change look', { optional: true, timeout: 10_000 }),
    12_000,
  );
}

const summary = await step(
  'collect window.evenshockLatency() summary',
  () => page.evaluate(() => window.evenshockLatency()),
  10_000,
);

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
    // ChipsShop is only mounted on HomeScreen (App.tsx line 262 — the shop is
    // gated on both `auth.status === 'authenticated'` AND `screen === 'home'`).
    // If a prior step left us on RoundScreen or MatchEndScreen, the buy button
    // is genuinely not in the DOM. Require Home before we call the shop
    // "unreachable" — otherwise we're diagnosing a harness bug, not the app.
    const onHome = await step(
      'confirm HomeScreen (Start game button visible)',
      () =>
        page
          .getByRole('button', { name: 'Start game', exact: false })
          .first()
          .waitFor({ timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
      7_000,
    );
    if (!onHome) {
      shop.reached =
        'harness did not return to HomeScreen — buy button is only mounted there';
      throw new Error(shop.reached);
    }

    // signAndSendTransaction is now installed in addInitScript above, before
    // any page script runs — see the comment there for why it must be present
    // at ChipsShop's first render rather than assigned later.

    const opened = await step(
      'click Buy 100 chips',
      () => click('Buy 100 chips', { optional: true, timeout: 10_000 }),
      12_000,
    );
    if (!opened) {
      // Dump what the DOM actually says so "no buy button" stops being a
      // black box. If Buy 100 chips is present-but-not-clickable we want to
      // know; if the shop section is missing entirely we want to know that too.
      const diag = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button')).map((b) => ({
          text: (b.textContent || '').trim().slice(0, 60),
          disabled: b.disabled,
        }));
        const shopSection = document.querySelector('section[aria-label="Buy chips"]');
        return {
          hasShopSection: !!shopSection,
          shopSectionText: shopSection?.textContent?.trim().slice(0, 200) ?? null,
          bodyMentionsBuy: /Buy 100 chips|Get 100 chips/i.test(document.body.textContent || ''),
          buttonCount: buttons.length,
          buttons: buttons.slice(0, 20),
        };
      });
      console.log('  buy-button DIAGNOSTICS:');
      console.log(`    aria section "Buy chips" present: ${diag.hasShopSection}`);
      console.log(`    "Buy 100 chips" or "Get 100 chips" text anywhere: ${diag.bodyMentionsBuy}`);
      if (diag.shopSectionText) console.log(`    section text: ${diag.shopSectionText}`);
      console.log(`    button count: ${diag.buttonCount}`);
      for (const b of diag.buttons) {
        console.log(`      [${b.disabled ? 'disabled' : 'enabled '}] "${b.text}"`);
      }
      shop.reached = diag.hasShopSection
        ? 'shop section rendered but Buy 100 chips button not clickable'
        : diag.bodyMentionsBuy
          ? 'buy text present but no matching button — check selector'
          : 'shop section not mounted — ChipsShop did not render on HomeScreen';
    } else {
      // Order matters and mirrors usePurchase.buy(): an open intent is checked
      // BEFORE the ToS state, so the resume prompt can appear first.
      await click('Cancel that and start a new purchase', { optional: true, timeout: 5_000 });

      // The ToS gate is deliberately blocking, and its continue button stays
      // disabled until the checkbox is ticked BY the player. Clicking straight
      // for "continue" hangs on a disabled control — which is the gate working.
      const gate = page.getByRole('checkbox').first();
      if (await gate.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await step('tick ToS checkbox', () => gate.check({ timeout: 10_000 }), 12_000);
        await step(
          'click ToS continue',
          () => click('I understand — continue', { optional: true, timeout: 5_000 }),
          8_000,
        );
      }

      // Credited, or still pending after the network takes its time — both are
      // successful outcomes of the browser half. Only an error modal is a fail.
      const credited = await step(
        'wait for "Credited: +N chips"',
        () =>
          page
            .getByText(/Credited: \+\d+ chips/i)
            .first()
            .waitFor({ timeout: 120_000 })
            .then(() => true)
            .catch(() => false),
        130_000,
      );
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

await step('browser.close', () => browser.close(), 15_000).catch((err) => {
  console.error(`  browser.close warning — ${err.message}`);
});
clearTimeout(watchdog);

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
