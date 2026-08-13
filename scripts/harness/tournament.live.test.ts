/**
 * A whole tournament, played through the code the UI calls.
 *
 *   TOURNAMENT_ID=<uuid> npm run e2e:tournament
 *
 * WHAT MAKES THIS A UI PROOF AND NOT A DATABASE PROOF. Every call below goes
 * through `createTournaments` and `createMultiplayer` — the same two modules
 * `TournamentsPanel` and the versus screen import. Those talk to the deployed
 * `tournaments` and `mp` Edge Functions over real user sessions obtained by
 * Sign-In With Solana. Nothing here holds the service role, and nothing calls
 * a `tournament_*` RPC directly, because a browser cannot: they are all
 * revoked from `anon` and `authenticated`. If this suite passes, the path a
 * player takes works; if it were written against the database it could pass
 * while the player-facing path was broken.
 *
 * THE TOURNAMENT IS CREATED BY AN OPERATOR, not by this suite, and that is the
 * design rather than a gap. `tournament_create` is deliberately absent from the
 * Edge Function — see its header — so there is no player-reachable way to open
 * one, and a test that invented its own would be testing an endpoint that does
 * not exist. Pass the id in.
 *
 * IT WRITES TO PRODUCTION: two real entry fees move, a real pot is paid. That
 * is the point — the brief asks for conservation after a REAL settlement — so
 * it is fenced behind EVENSHOCK_LIVE like every other suite that spends
 * anything.
 */
import { Keypair } from '@solana/web3.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMultiplayer, type MultiplayerApi } from '../../src/data/multiplayer';
import { createTournaments, nextPlayableSlot, type TournamentsApi } from '../../src/data/tournaments';
import { signInWithKeypair } from './auth.mjs';
import { ANON_KEY, SUPABASE_URL } from './env.mjs';
import { SEED_STAKE_A as SEED_A, SEED_STAKE_B as SEED_B } from './wallets.mjs';

if (process.env.EVENSHOCK_LIVE !== '1') {
  throw new Error(
    'refusing to run: this suite moves real chips through a real tournament. Set EVENSHOCK_LIVE=1.',
  );
}
if (!SUPABASE_URL || !ANON_KEY) throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (.env)');

const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
if (!TOURNAMENT_ID) {
  throw new Error('TOURNAMENT_ID must name a tournament in `registering` with max_players 2.');
}

/** The two funded harness wallets the stake suite already uses. */

let clientA: SupabaseClient;
let clientB: SupabaseClient;
let tourA: TournamentsApi;
let tourB: TournamentsApi;
let mpA: MultiplayerApi;
let mpB: MultiplayerApi;
let userA: string;
let userB: string;

/** Own-row read, exactly as the balance strip does it. */
async function chips(client: SupabaseClient, userId: string): Promise<number> {
  const { data } = await client.from('balances').select('chips').eq('user_id', userId).single();
  return Number((data as { chips: number } | null)?.chips ?? 0);
}

beforeAll(async () => {
  const a = await signInWithKeypair(SUPABASE_URL, ANON_KEY, Keypair.fromSeed(SEED_A), 'tourn-a');
  const b = await signInWithKeypair(SUPABASE_URL, ANON_KEY, Keypair.fromSeed(SEED_B), 'tourn-b');
  clientA = a.client;
  clientB = b.client;
  userA = a.userId;
  userB = b.userId;

  // The product's own modules from here on. No stub past this line.
  tourA = createTournaments(clientA);
  tourB = createTournaments(clientB);
  mpA = createMultiplayer(clientA);
  mpB = createMultiplayer(clientB);
});

describe('a tournament, end to end, through the player-facing path', () => {
  let entryFee = 0;
  let beforeA = 0;
  let beforeB = 0;

  it('shows the entry fee and the pool in the lobby before anyone commits', async () => {
    const list = await tourA.list();
    const row = list.find((t) => t.id === TOURNAMENT_ID);
    expect(row, 'the tournament must be listed as joinable').toBeTruthy();
    expect(row!.status).toBe('registering');

    // The disclosure the confirm step is built on. Both numbers must be present
    // BEFORE registration, or the screen is asking for a commitment it has not
    // priced.
    expect(row!.entryFee).toBeGreaterThan(0);
    expect(typeof row!.prizePool).toBe('number');
    expect(row!.joinBlock).toBeNull();

    entryFee = row!.entryFee;
    beforeA = await chips(clientA, userA);
    beforeB = await chips(clientB, userB);
  });

  it('charges exactly the advertised fee, and fills the pool with it', async () => {
    await tourA.register(TOURNAMENT_ID!);
    expect(await chips(clientA, userA)).toBe(beforeA - entryFee);

    // Filling the last seat draws the bracket on its own — there is no
    // operator step between a full lobby and a playable draw.
    await tourB.register(TOURNAMENT_ID!);
    expect(await chips(clientB, userB)).toBe(beforeB - entryFee);

    const { money } = await tourA.bracket(TOURNAMENT_ID!);
    expect(money.pool).toBe(entryFee * 2);
    expect(money.houseCut).toBe(0);
    expect(money.status).toBe('running');
  });

  it('refuses a second entry from someone already in', async () => {
    await expect(tourA.register(TOURNAMENT_ID!)).rejects.toMatchObject({ code: 'already_entered' });
    // And no chips moved on the refusal.
    expect(await chips(clientA, userA)).toBe(beforeA - entryFee);
  });

  it('draws a bracket both players can see themselves in', async () => {
    const { slots } = await tourA.bracket(TOURNAMENT_ID!);
    expect(slots).toHaveLength(1);
    expect(slots[0].roundNo).toBe(1);
    expect([slots[0].a.id, slots[0].b.id].sort()).toEqual([userA, userB].sort());
    // Seeded, both sides named, and it is this player's turn.
    expect(slots[0].a.seed).toBeGreaterThan(0);
    expect(slots[0].a.name).toBeTruthy();
    expect(nextPlayableSlot(slots)?.slot).toBe(1);

    const fromB = await tourB.bracket(TOURNAMENT_ID!);
    expect(nextPlayableSlot(fromB.slots)?.slot).toBe(1);
  });

  it('opens the slot as an ordinary mp table and plays it out', async () => {
    // What the Play button does: open the slot, then hand the invite code to
    // the friend-match flow. Both players take the same route.
    const opened = await tourA.openMatch(TOURNAMENT_ID!, 1, 1);
    expect(opened.inviteCode).toMatch(/^[A-Z0-9]{8}$/);

    const joinedA = await mpA.joinTable(opened.inviteCode!);
    const joinedB = await mpB.joinTable(opened.inviteCode!);
    expect(joinedA.tableId).toBe(opened.tableId);
    expect(joinedB.tableId).toBe(opened.tableId);

    // A tournament table is FREE. The entry fee was the wager-shaped thing and
    // it was taken once, at registration; the table itself carries no stake, so
    // nothing here goes near the stake-tables flag.
    expect(joinedA.stake).toBe(0);
    expect(joinedB.stake).toBe(0);

    // Single format: one round decides it. Rock beats scissors, so seat A wins.
    const roundId = await mpA.openRound(opened.tableId);
    await mpA.commit(opened.tableId, roundId, 'rock');
    await mpB.commit(opened.tableId, roundId, 'scissors');
    await mpA.reveal(roundId);
    await mpB.reveal(roundId);

    const result = await mpA.result(roundId);
    expect(result.verified).toBe(true);
    expect(result.outcome).toBe(joinedA.seat);
  });

  it('reports the winner into the bracket and settles the pool by itself', async () => {
    const { slots, money } = await tourA.bracket(TOURNAMENT_ID!);
    expect(slots[0].status).toBe('complete');
    expect(slots[0].winner).toBeTruthy();
    // Finishing the final settles. Nobody pressed anything to make this happen.
    expect(money.status).toBe('complete');
  });

  it('pays the whole pool out, and says so in the numbers the panel renders', async () => {
    const money = await tourA.result(TOURNAMENT_ID!);
    const pool = entryFee * 2;

    expect(money.pool).toBe(pool);
    expect(money.houseCut).toBe(0);

    // First and second, summing to the pool exactly — no chip created, none
    // lost at the rounding boundary.
    const paid = money.podium.reduce((sum, p) => sum + p.prize, 0);
    expect(paid).toBe(pool);
    expect(money.podium.map((p) => p.position)).toEqual([1, 2]);
    expect(money.podium[0].prize).toBe(pool - Math.floor((pool * 3500) / 10000));
    expect(money.podium[1].prize).toBe(Math.floor((pool * 3500) / 10000));

    // And what each player's own panel says, checked against their real balance.
    const moneyB = await tourB.result(TOURNAMENT_ID!);
    expect(money.you!.paid).toBe(entryFee);
    expect(money.you!.net).toBe(money.you!.prize - entryFee);
    expect(await chips(clientA, userA)).toBe(beforeA - entryFee + money.you!.prize);
    expect(await chips(clientB, userB)).toBe(beforeB - entryFee + moneyB.you!.prize);

    // The players' two prizes are the whole pool: nothing stayed behind.
    expect(money.you!.prize + moneyB.you!.prize).toBe(pool);
  });
});
