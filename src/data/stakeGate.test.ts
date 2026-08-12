import { describe, expect, it, vi } from 'vitest';
import { STAKE_TABLES_ENABLED } from '../constants/features';
import { loadStakeOptions, createMultiplayer } from './multiplayer';

/**
 * The narrowing, asserted: with stake tables off, no reachable client path
 * sends a wager.
 *
 * This is the client half of a three-layer answer, and deliberately the least
 * important layer — the server refuses independently (`feature_flags`,
 * deactivated stake options, and a trigger on `mp_tables`), and those hold
 * against the service role, which is stronger than anything a browser can
 * reach. What these tests prove is narrower and still worth having: the app
 * does not ask for something the server would refuse, and a caller who tries
 * cannot get a nonzero stake past the boundary.
 */

/** A client stub that records what would have gone over the wire. */
function recordingClient() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    functions: {
      invoke: vi.fn(async (_name: string, opts: { body: Record<string, unknown> }) => {
        calls.push(opts.body);
        return {
          data: { ok: true, table_id: 't', invite_code: 'ABCDEFGH', stake: 0, pot: 0, rake: 0, payout: 0 },
          error: null,
        };
      }),
    },
    from: () => ({
      select: () => ({
        order: async () => ({
          // Deliberately answers as though the server still offered stakes.
          // If the gate depended on the server's answer rather than on the
          // flag, this row would leak a priced option into the picker.
          data: [
            { stake_chips: 0, rake_bps: 0 },
            { stake_chips: 100, rake_bps: 500 },
          ],
          error: null,
        }),
      }),
    }),
  } as never;
}

describe('stake tables, off', () => {
  it('is off in this build', () => {
    expect(STAKE_TABLES_ENABLED).toBe(false);
  });

  it('offers only the free table, even when the server lists priced ones', async () => {
    const options = await loadStakeOptions(recordingClient());
    expect(options).toEqual([{ stake: 0, pot: 0, rake: 0, payout: 0 }]);
    expect(options.some((o) => o.stake > 0)).toBe(false);
  });

  it('drops a nonzero stake at the boundary rather than sending it', async () => {
    // The adversary here is not a player — it is a future refactor, or a
    // console. Whatever the caller passes, what leaves must be 0.
    const client = recordingClient() as unknown as { calls: Array<Record<string, unknown>> };
    const api = createMultiplayer(client as never);

    await api.createTable('bo3', 100);
    await api.createTable('single', 10);

    expect(client.calls).toHaveLength(2);
    for (const body of client.calls) {
      expect(body.action).toBe('mp_create');
      expect(body.stake).toBe(0);
    }
  });

  it('never carries a stake or rake reason in anything the client sends', async () => {
    const client = recordingClient() as unknown as { calls: Array<Record<string, unknown>> };
    const api = createMultiplayer(client as never);
    await api.createTable('bo3', 50);
    const wire = JSON.stringify(client.calls);
    expect(wire).not.toMatch(/stake_post|stake_payout|stake_refund|rake/);
  });
});
