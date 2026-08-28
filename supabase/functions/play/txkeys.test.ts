import { describe, expect, it } from 'vitest';
import { collectAccountKeys } from './txkeys.ts';

/**
 * The reference check reads THESE keys. A key missed here is a payment that
 * verifies as "reference_absent" — someone's real money refused — so the
 * collection is pinned by fixture for every shape the RPC hands back.
 */
describe('collectAccountKeys', () => {
  it('reads plain string keys', () => {
    const keys = collectAccountKeys({
      transaction: { message: { accountKeys: ['aaa', 'bbb'] } },
    });
    expect(keys).toEqual(['aaa', 'bbb']);
  });

  it('reads jsonParsed object keys', () => {
    const keys = collectAccountKeys({
      transaction: { message: { accountKeys: [{ pubkey: 'aaa' }, { pubkey: 'bbb' }] } },
    });
    expect(keys).toEqual(['aaa', 'bbb']);
  });

  it('includes lookup-table-loaded keys from meta.loadedAddresses', () => {
    // A versioned transaction: the reference travelled through an ALT, so it
    // is absent from the static message keys. It must still be found.
    const keys = collectAccountKeys({
      transaction: { message: { accountKeys: [{ pubkey: 'static1' }] } },
      meta: { loadedAddresses: { writable: ['w1'], readonly: ['ref-key', 'r2'] } },
    });
    expect(keys).toContain('static1');
    expect(keys).toContain('w1');
    expect(keys).toContain('ref-key');
    expect(keys).toContain('r2');
  });

  it('tolerates every field being absent', () => {
    expect(collectAccountKeys({})).toEqual([]);
    expect(collectAccountKeys({ meta: {} })).toEqual([]);
    expect(collectAccountKeys({ meta: { loadedAddresses: {} } })).toEqual([]);
  });
});
