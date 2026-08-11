/**
 * The things that only break in a browser, checked in a browser. Offline.
 *
 *   npm run e2e:preflight
 *
 * THIS IS THE CHECK THAT SHOULD HAVE EXISTED FIRST. Buying chips failed in
 * production with `wallet_error — Buffer is not defined`, while the devnet
 * payment suite was 18/18 green. That suite runs in Node, where `Buffer` is a
 * global that is simply there; it exercised replays, wrong recipient, dust and
 * reconciliation without once touching the thing that was broken. A test that
 * passes in the wrong runtime is not evidence about the right one.
 *
 * So this runs the browser half of the purchase path where it actually lives —
 * in Chromium, through the app's own module graph, calling the same `sendUsdc`
 * the shop calls.
 *
 * IT NEEDS NO NETWORK AND NO WALLET. The one RPC call (`getLatestBlockhash`) is
 * intercepted and answered with a canned blockhash, and the wallet is a stub
 * that captures the transaction instead of signing it. Everything before that
 * point — four base58 decodes, two associated-token-address derivations, the
 * instruction encoding, the transaction assembly — is the real library doing
 * real work, and every bit of it is what needed Buffer. That makes this cheap
 * enough to run in CI, which is the only way it stays true.
 *
 * What it asserts, beyond "did not throw":
 *   - Buffer goes from absent to present, so the shim is what fixed it
 *   - the transfer carries the intent's reference as a read-only, non-signer
 *     key — the binding that stops one player claiming another's payment
 *   - the amount is exact in base units, decoded back out of the instruction
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { chromiumLaunchOptions } from './chromium.mjs';

const PORT = Number(process.env.EVENSHOCK_DEV_PORT ?? 5174);
const BASE = `http://localhost:${PORT}/evenshock/`;

// Values with no secrets in them; the point is the shape, not the accounts.
const INTENT = {
  cluster: 'devnet',
  usdc_mint: '4LudrR5cjEEve6hYa6aSQ2m2rrVVAbPJt9vgoP9dQzSf',
  treasury_address: 'CzVLg3pPP6sszaPxgdX8LNh8duG7r6dyQGiojeLsmAB7',
  reference: 'HcR5SobxKLymJewRRpo3WTee8Pd5k2Kn1ASNSDH6aQg',
  usdc_decimals: 6,
  expected_usdc: 1,
};
const EXPECTED_RAW = '1000000'; // 1 USDC at 6 decimals, exactly

const results = [];
let failures = 0;
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  if (!pass) failures += 1;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!pass) console.log(`        ${JSON.stringify(detail)}`);
}

// ------------------------------------------------------------- dev server

const dev = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stop = () => {
  try {
    dev.kill('SIGTERM');
  } catch {
    /* already gone */
  }
};
process.on('exit', stop);

async function waitForServer(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server did not come up on ${BASE}`);
}

console.log(`\n  starting dev server on ${PORT}…`);
await waitForServer();

// ------------------------------------------------------------------ page

const browser = await chromium.launch(chromiumLaunchOptions());
const page = await (await browser.newContext()).newPage();

// The single RPC call, answered locally. A real blockhash is 32 base58 bytes
// and the library validates the shape, so this is a genuine-looking one rather
// than a placeholder string.
await page.route('https://api.devnet.solana.com/**', async (route) => {
  const body = route.request().postDataJSON?.() ?? {};
  if (body.method === 'getLatestBlockhash') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          context: { slot: 1 },
          value: {
            blockhash: '9zqPQ8kZ7YvcRAcVYAvPd1sfxAo4cCP6qMDkGnFsCZk7',
            lastValidBlockHeight: 1000,
          },
        },
      }),
    });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result: null }),
  });
});

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });

const outcome = await page.evaluate(
  async ({ intent }) => {
    const out = { bufferBefore: typeof globalThis.Buffer };
    try {
      const mod = await import('/evenshock/src/data/purchase.ts');
      let captured = null;
      const wallet = {
        publicKey: { toBase58: () => 'D9bzBJ2Sv96XVK9udrhWVPNKCg2pSQzKzGUoKvujBSRF' },
        signAndSendTransaction: async (tx) => {
          captured = tx;
          return { signature: 'S'.repeat(88) };
        },
      };

      const res = await mod.sendUsdc(intent, wallet);
      out.signature = res.signature;
      out.bufferAfter = typeof globalThis.Buffer;

      const ixs = captured?.instructions ?? [];
      out.instructionCount = ixs.length;
      out.feePayer = captured?.feePayer?.toBase58?.();
      out.hasBlockhash = typeof captured?.recentBlockhash === 'string';

      // The transfer is the instruction carrying the reference.
      const transfer = ixs.find((i) =>
        (i.keys ?? []).some((k) => k.pubkey?.toBase58?.() === intent.reference),
      );
      const refKey = (transfer?.keys ?? []).find(
        (k) => k.pubkey.toBase58() === intent.reference,
      );
      out.referencePresent = !!refKey;
      out.referenceReadOnly = refKey ? !refKey.isWritable && !refKey.isSigner : null;

      // Decode the amount back out of the encoded instruction: TransferChecked
      // is tag 12, then a little-endian u64, then the decimals byte.
      if (transfer?.data) {
        const data = Uint8Array.from(transfer.data);
        out.tag = data[0];
        let amount = 0n;
        for (let i = 8; i >= 1; i -= 1) amount = (amount << 8n) | BigInt(data[i]);
        out.amountRaw = amount.toString();
        out.decimals = data[9];
      }
    } catch (e) {
      out.error = String(e?.message ?? e);
      out.bufferAfter = typeof globalThis.Buffer;
    }
    return out;
  },
  { intent: INTENT },
);

// ======================================================= storage-hostile round
//
// The second bug of the same family, found auditing for the first.
//
// `useRounds` writes the committed move to sessionStorage so a mid-round reload
// is not a lost move. Three of its four calls were wrapped against storage
// being unavailable; the fourth — on the SUCCESS path — was not, and a throw
// there was caught by the handler for submit failures. So in a browser that
// refuses storage, a round that had genuinely resolved was retried three times
// and then shown as failed. Everything worked except the part that told the
// player so.
//
// Node has no sessionStorage at all, so no unit test could reach this. Here it
// is a browser that throws on every access, playing a real round.

const hostile = await browser2Context();
async function browser2Context() {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    const deny = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    Object.defineProperty(window, 'sessionStorage', { get: deny, configurable: true });
  });
  return ctx;
}

const hostilePage = await hostile.newPage();
const hostileErrors = [];
hostilePage.on('pageerror', (e) => hostileErrors.push(String(e)));

await hostilePage.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });

const clickBy = async (role, name, timeout = 15_000) => {
  try {
    await hostilePage.getByRole(role, { name, exact: false }).first().click({ timeout });
    return true;
  } catch {
    return false;
  }
};

// Guest mode plays locally, but it runs through the identical useRounds path —
// including the success-path storage write that used to throw.
const storage = { started: false, played: 0, advanced: false };
storage.started = await clickBy('button', 'Start game');
if (storage.started) {
  storage.played = (await clickBy('button', 'Rock', 20_000)) ? 1 : 0;
  // Reaching a result screen is the whole assertion: under the old code the
  // round resolved and the UI sat in "retrying" instead.
  storage.advanced =
    (await clickBy('button', 'Next round', 20_000)) ||
    (await clickBy('button', 'See results', 20_000));
}

await browser.close();
stop();

// --------------------------------------------------------------- assertions

console.log('');
check('the browser had no Buffer to begin with', outcome.bufferBefore === 'undefined', outcome);
check('sendUsdc built and handed over a transaction', !outcome.error, outcome);
check('the shim supplied Buffer', outcome.bufferAfter === 'function', outcome);
check('a signature came back', typeof outcome.signature === 'string', outcome);
check('two instructions: priority fee and transfer', outcome.instructionCount === 2, outcome);
check('a recent blockhash was attached', outcome.hasBlockhash === true, outcome);
check("the intent's reference travels with the transfer", outcome.referencePresent === true, outcome);
check(
  'the reference is read-only and not a signer',
  outcome.referenceReadOnly === true,
  outcome,
);
check('the instruction is TransferChecked', outcome.tag === 12, outcome);
check(`the amount is exactly ${EXPECTED_RAW} base units`, outcome.amountRaw === EXPECTED_RAW, outcome);
check('the decimals match the intent', outcome.decimals === INTENT.usdc_decimals, outcome);

console.log('');
check('a round starts in a browser that refuses storage', storage.started === true, storage);
check('the move is accepted there', storage.played === 1, storage);
check(
  'and the round resolves instead of being retried into failure',
  storage.advanced === true,
  { ...storage, pageErrors: hostileErrors.slice(0, 3) },
);

console.log(`\n  ${results.length - failures}/${results.length} passed\n`);
process.exit(failures === 0 ? 0 : 1);
