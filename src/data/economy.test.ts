import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalEconomy, createServerEconomy } from './economy';

const GUEST_KEY = 'evenshock:guest-economy';

/** A localStorage good enough for the guest implementation. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

describe('guest economy', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = installStorage();
  });

  it('never claims to be persistent', () => {
    expect(createLocalEconomy().persistent).toBe(false);
  });

  it('earns at exactly the shared rates', async () => {
    const api = createLocalEconomy();
    const state = await api.recordMatch(4, 2);
    expect(state).toMatchObject({ xp: 40, chips: 10 });
  });

  it('accumulates across matches', async () => {
    const api = createLocalEconomy();
    await api.recordMatch(3, 1);
    const state = await api.recordMatch(2, 2);
    expect(state).toMatchObject({ xp: 50, chips: 15 });
  });

  it('refuses a purchase it cannot afford, and charges nothing', async () => {
    const api = createLocalEconomy();
    await api.recordMatch(1, 1); // 10 xp, 5 chips — frost costs 60
    await expect(api.buy('frost')).rejects.toThrow('insufficient_chips');
    expect((await api.load(null)).chips).toBe(5);
  });

  it('debits exactly once and will not charge twice for the same theme', async () => {
    const api = createLocalEconomy();
    await api.recordMatch(20, 20); // 100 chips

    const first = await api.buy('frost');
    expect(first).toMatchObject({ alreadyOwned: false, chips: 40 });

    const second = await api.buy('frost');
    expect(second).toMatchObject({ alreadyOwned: true, chips: 40 });
    expect((await api.load(null)).chips).toBe(40);
  });

  it('refuses to sell something that is not for sale', async () => {
    const api = createLocalEconomy();
    await expect(api.buy('studio')).rejects.toThrow('bad_request');
  });

  it('grants a priced theme the player is already using rather than locking it', async () => {
    const api = createLocalEconomy();
    const state = await api.load('jade');
    expect(state.owned).toContain('jade');
    expect(state.chips).toBe(0); // granted, not bought
  });

  it('survives corrupt storage instead of throwing', async () => {
    store.set(GUEST_KEY, 'not json');
    expect(await createLocalEconomy().load(null)).toEqual({ xp: 0, chips: 0, owned: [] });
  });

  it('never reports a negative balance from tampered storage', async () => {
    store.set(GUEST_KEY, JSON.stringify({ xp: -500, chips: -20, owned: [] }));
    expect(await createLocalEconomy().load(null)).toMatchObject({ xp: 0, chips: 0 });
  });
});

/**
 * The non-migration guarantee.
 *
 * Guest progress is a demo of the loop, not a credit. If connecting a wallet
 * carried it across, anyone could clear their browser, replay, and claim again
 * — which is precisely a free-tokens exploit. The server implementation must
 * therefore never consult local storage at all.
 */
describe('guest progress does not migrate to an account', () => {
  it('the server implementation never reads the guest balance', async () => {
    const store = installStorage();
    store.set(GUEST_KEY, JSON.stringify({ xp: 9999, chips: 9999, owned: ['frost'] }));

    const getItem = vi.spyOn(globalThis.localStorage, 'getItem');

    const client = {
      functions: {
        invoke: async () => ({ data: { xp: 0, chips: 0, owned: [] }, error: null }),
      },
    } as unknown as SupabaseClient;

    const state = await createServerEconomy(client).load(null);

    // The account's own balance, not the browser's.
    expect(state).toEqual({ xp: 0, chips: 0, owned: [] });
    expect(getItem).not.toHaveBeenCalledWith(GUEST_KEY);
  });

  it('recordMatch on the server path sends no counts the client could inflate', async () => {
    const bodies: unknown[] = [];
    const client = {
      functions: {
        invoke: async (_fn: string, opts: { body: unknown }) => {
          bodies.push(opts.body);
          return { data: { xp: 30, chips: 10, owned: [] }, error: null };
        },
      },
    } as unknown as SupabaseClient;

    await createServerEconomy(client).recordMatch(999, 999);

    // Only a state read went out — the award was already decided server-side.
    expect(bodies).toEqual([{ action: 'economy_state', current_theme: null }]);
  });
});
