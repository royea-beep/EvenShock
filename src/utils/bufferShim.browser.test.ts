import { describe, expect, it } from 'vitest';

/**
 * The Buffer bug, as a test, in the runtime where it was real.
 *
 * Buying chips failed in production with `wallet_error — Buffer is not
 * defined` while the devnet payment suite was 18/18 green, because that suite
 * runs in Node where Buffer simply exists. This file exists to make that
 * impossible to repeat: it asserts the absence FIRST, so if someone ever adds a
 * global polyfill and quietly makes the shim redundant, this fails and says so
 * rather than passing for a reason nobody intended.
 */

describe('the browser runtime, before anything shims it', () => {
  it('has no Buffer of its own — which is the entire bug', async () => {
    // Read through a dynamic property so the bundler cannot fold it away.
    const g = globalThis as Record<string, unknown>;
    const key = 'Buffer';
    // If this ever fails, the shim is no longer what makes purchases work and
    // the comment in bufferShim.ts has become a lie. Find out why before
    // deleting this assertion.
    expect(typeof g[key]).toBe('undefined');
  });
});

describe('the shim', () => {
  it('installs a working Buffer just by being imported', async () => {
    const { bufferAvailable } = await import('./bufferShim');
    expect(bufferAvailable()).toBe(true);
    expect(typeof globalThis.Buffer.from).toBe('function');
  });

  it('produces a Buffer the Solana libraries can actually use', () => {
    // Not "is it defined" but "does it behave": bs58 and bn.js round-trip
    // through these three, and a stub that only satisfies typeof would pass a
    // presence check and still fail at `new PublicKey(...)`.
    const b = globalThis.Buffer.from([1, 2, 3, 255]);
    expect(b.length).toBe(4);
    expect(b.toString('hex')).toBe('010203ff');
    expect(globalThis.Buffer.isBuffer(b)).toBe(true);
    expect([...globalThis.Buffer.alloc(3)]).toEqual([0, 0, 0]);
  });

  it('is idempotent, so a second import cannot swap it out mid-flight', async () => {
    const first = globalThis.Buffer;
    await import('./bufferShim');
    expect(globalThis.Buffer).toBe(first);
  });
});
