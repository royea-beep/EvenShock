/**
 * `Buffer` for the browser, because the Solana libraries assume Node.
 *
 * This existed as a bug before it existed as a file. Buying chips failed with
 * `wallet_error — Buffer is not defined`: @solana/web3.js and @solana/spl-token
 * use Node's Buffer internally (bn.js, bs58, borsh all reach for it), Vite does
 * not polyfill Node globals, and so the transfer was never built and never
 * signed.
 *
 * WHAT MAKES THAT WORTH A COMMENT rather than a one-line fix: the devnet suite
 * was 18/18 green at the time. It runs in Node, where `Buffer` is a global that
 * is simply there, so it exercised every payment branch — replays, wrong
 * recipient, dust, reconciliation — without ever touching the thing that was
 * broken. A test that passes in the wrong runtime is not evidence about the
 * right one, and this is the second time that exact shape has bitten this
 * project. `scripts/harness/purchase-preflight.mjs` is the check that fails if
 * this file stops working.
 *
 * A targeted shim rather than vite-plugin-node-polyfills: one global is needed,
 * not a Node emulation layer, and the narrow fix cannot quietly make some other
 * Node-only code appear to work in a browser — which would recreate the same
 * class of bug one level down.
 *
 * Importing this module IS the installation; it has no exported behaviour.
 */
import { Buffer } from 'buffer';

declare global {
  // eslint-disable-next-line no-var
  var Buffer: typeof import('buffer').Buffer;
}

// Never overwrite a real one. Under Node — the harnesses, and any future SSR —
// the native Buffer is already present and is the one that should be used.
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer;
}

/** True when a usable `Buffer` is in scope. Exported for the preflight check. */
export function bufferAvailable(): boolean {
  return typeof globalThis.Buffer === 'function' && typeof globalThis.Buffer.from === 'function';
}
