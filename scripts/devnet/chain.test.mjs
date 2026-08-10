import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The harness holds the mint authority for its own currency, so "it only runs
 * on devnet" is a safety property rather than a convenience, and safety
 * properties get tests.
 *
 * What is asserted here is the shape of the refusal, not just its existence:
 * the gate must be the CHAIN'S answer rather than our configuration, and the
 * keys must be unreachable until that answer arrives. A harness that checks the
 * network and then signs anyway is no better than one that never checked.
 */

const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/** Loads chain.mjs with a chain that claims the given genesis hash. */
async function withGenesis(genesis) {
  vi.resetModules();
  vi.doMock('@solana/web3.js', () => ({
    Connection: class {
      async getGenesisHash() {
        return genesis;
      }
    },
    Keypair: { generate: () => ({ publicKey: { toBase58: () => 'fake' }, secretKey: new Uint8Array(64) }) },
  }));
  return await import('./chain.mjs');
}

afterEach(() => {
  vi.doUnmock('@solana/web3.js');
  vi.restoreAllMocks();
});

describe('the devnet gate', () => {
  it('will not hand out a key before the chain has identified itself', async () => {
    const chain = await withGenesis(DEVNET);
    // assertDevnet deliberately not called.
    expect(() => chain.loadKeypair('payer')).toThrow(/assertDevnet/);
  });

  it('refuses mainnet outright, and leaves the keys locked', async () => {
    const chain = await withGenesis(MAINNET);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exited');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(chain.assertDevnet('https://example.invalid')).rejects.toThrow('exited');
    expect(exit).toHaveBeenCalledWith(1);

    // The point of the whole design: a refused run is a run holding no keys,
    // not one that declined to use them.
    expect(() => chain.loadKeypair('payer')).toThrow(/assertDevnet/);
  });

  it('refuses testnet too — devnet is an allow-list of one, not "anything but mainnet"', async () => {
    const chain = await withGenesis('4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY');
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exited');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(chain.assertDevnet('https://example.invalid')).rejects.toThrow('exited');
  });

  it('accepts devnet', async () => {
    const chain = await withGenesis(DEVNET);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { genesis } = await chain.assertDevnet('https://example.invalid');
    expect(genesis).toBe(DEVNET);
  });
});

describe('money arithmetic', () => {
  it('converts base units to decimals without floats', async () => {
    const chain = await withGenesis(DEVNET);
    expect(chain.formatUnits(1_000_000n, 6)).toBe('1.000000');
    expect(chain.formatUnits(5_000n, 6)).toBe('0.005000');
    expect(chain.formatUnits(0n, 6)).toBe('0.000000');
  });

  it('parses decimals to base units exactly', async () => {
    const chain = await withGenesis(DEVNET);
    expect(chain.parseUnits('1', 6)).toBe(1_000_000n);
    expect(chain.parseUnits('0.37', 6)).toBe(370_000n);
    expect(chain.parseUnits('3.575', 6)).toBe(3_575_000n);
    // 0.1 + 0.2 territory: the exact reason this is string arithmetic.
    expect(chain.parseUnits('0.1', 6) + chain.parseUnits('0.2', 6)).toBe(chain.parseUnits('0.3', 6));
  });

  it('refuses more precision than the mint has, rather than rounding money', async () => {
    const chain = await withGenesis(DEVNET);
    expect(() => chain.parseUnits('0.0000001', 6)).toThrow(/decimals/);
  });

  it('round-trips', async () => {
    const chain = await withGenesis(DEVNET);
    for (const v of ['0.000001', '1.000000', '3.575000', '10000.000000']) {
      expect(chain.formatUnits(chain.parseUnits(v, 6), 6)).toBe(v);
    }
  });
});
