import { Keypair } from '@solana/web3.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMultiplayer, type MultiplayerApi } from '../../src/data/multiplayer';
import { signInWithKeypair } from './auth.mjs';
import { ANON_KEY, SERVICE_ROLE_KEY, SUPABASE_URL } from './env.mjs';
import { SEED_STAKE_A as SEED_A, SEED_STAKE_B as SEED_B } from './wallets.mjs';

/**
 * A full stake match, two real accounts, against the deployed `mp` function.
 *
 *   npm run e2e:stake
 *
 * WHY THIS EXISTS. Production held 0 rows in `mp_tables`: every escrow, rake
 * and conservation result reported to date came from a SQL harness that rolled
 * itself back. The RPC layer has since been proven with a committed match, but
 * that ran as the service role, straight against Postgres — it bypassed the
 * deployed Edge Function, the JWT verification, the seat lookup, and the client
 * module that actually runs in a browser. This suite is the layer between: real
 * SIWS sessions, the real `mp` function over HTTPS, the real `createMultiplayer`
 * seam, and the ledger read back afterwards as an operator.
 *
 * It drives `createMultiplayer`, NOT a copy of it — including `verifyRound`,
 * which is where the commitment check lives. A digest mismatch surfaces here as
 * the same `MultiplayerFairnessError` a player's browser would raise.
 *
 * WHAT IT STILL DOES NOT COVER: React. The screens are unexercised; this proves
 * everything underneath them. `npm run e2e:entry` is the browser-level harness,
 * and a UI-level stake run is the piece still owed.
 *
 * IT WRITES REAL ROWS — a settled table, two escrow postings, a payout, and a
 * rake row in `house_ledger`. That is the point: an unsettled path is an
 * unproven one. Two fixed throwaway keypairs, so runs reuse two accounts rather
 * than accumulating one per run.
 */

if (process.env.EVENSHOCK_LIVE !== '1') {
  throw new Error(
    'refusing to run: this suite stakes chips and writes settlement rows to the live project. Set EVENSHOCK_LIVE=1.',
  );
}
if (!SUPABASE_URL || !ANON_KEY) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (.env)');
}
if (!SERVICE_ROLE_KEY) {
  throw new Error(
    'SUPABASE_SERVICE_ROLE_KEY must be set in .env.local — the suite reads the ledger and house_ledger back as an operator would, past the RLS a player sees.',
  );
}

const STAKE = 10;
const EXPECTED_POT = STAKE * 2;
const EXPECTED_RAKE = 1; // 5% of 20, and whole by construction
const EXPECTED_PAYOUT = EXPECTED_POT - EXPECTED_RAKE;

/** Fixed seeds: throwaway identities in a test project, not wallets. */

let admin: SupabaseClient;
let apiA: MultiplayerApi;
let apiB: MultiplayerApi;
let userA: string;
let userB: string;
let tableId: string;
let houseBefore: number;

/** Enough chips to sit down, granted through the ledger so conservation still
 *  holds — never by writing `balances` directly, which would mint outside the
 *  record and make every assertion below meaningless. */
async function fund(userId: string, chips: number) {
  await admin.rpc('credit_ledger', {
    p_user_id: userId,
    p_currency: 'chips',
    p_delta: chips,
    p_reason: 'chip_purchase',
    p_idem_key: `stake-suite:${userId}:${Date.now()}`,
  });
}

async function balance(userId: string): Promise<number> {
  const { data } = await admin.from('balances').select('chips').eq('user_id', userId).maybeSingle();
  return Number(data?.chips ?? 0);
}

async function houseBalance(): Promise<number> {
  const { data } = await admin.rpc('house_balance');
  return Number(data ?? 0);
}

beforeAll(async () => {
  admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const a = await signInWithKeypair(SUPABASE_URL, ANON_KEY, Keypair.fromSeed(SEED_A), 'stake-a');
  const b = await signInWithKeypair(SUPABASE_URL, ANON_KEY, Keypair.fromSeed(SEED_B), 'stake-b');
  userA = a.userId;
  userB = b.userId;

  await fund(userA, 100);
  await fund(userB, 100);

  // The product's own module, over real sessions. No stub past this line.
  apiA = createMultiplayer(a.client);
  apiB = createMultiplayer(b.client);
  houseBefore = await houseBalance();
});

describe('a staked match, end to end, through the deployed function', () => {
  it('seats both players and escrows both stakes atomically', async () => {
    const beforeA = await balance(userA);
    const beforeB = await balance(userB);

    const table = await apiA.createTable('single', STAKE);
    tableId = table.tableId;
    expect(table.inviteCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(table.stake).toBe(STAKE);
    expect(table.pot).toBe(EXPECTED_POT);
    expect(table.rake).toBe(EXPECTED_RAKE);
    expect(table.payout).toBe(EXPECTED_PAYOUT);

    // Creating must not charge anyone: escrow happens at JOIN, in the same
    // transaction as the seating.
    expect(await balance(userA)).toBe(beforeA);

    const joined = await apiB.joinTable(table.inviteCode!);
    expect(joined.tableId).toBe(tableId);
    expect(joined.seat).toBe('b');

    // Both sides down exactly one stake, together.
    expect(await balance(userA)).toBe(beforeA - STAKE);
    expect(await balance(userB)).toBe(beforeB - STAKE);
  });

  it('never tells a player whether the opponent has moved', async () => {
    const roundId = await apiA.openRound(tableId);
    expect(roundId).toBeGreaterThan(0);

    await apiA.commit(tableId, roundId, 'rock');

    // A has committed, B has not. Nothing A can read may distinguish "B has
    // moved" from "B has not" — the whole protocol rests on this.
    const stateA = await apiA.state(tableId);
    expect(stateA.round?.youCommitted).toBe(true);
    expect(stateA.round?.bothCommitted).toBe(false);
    expect(JSON.stringify(stateA)).not.toMatch(/scissors|paper/);

    // And B, who has not moved, learns nothing about A either.
    const stateB = await apiB.state(tableId);
    expect(stateB.round?.youCommitted).toBe(false);
    expect(stateB.round?.bothCommitted).toBe(false);
    expect(JSON.stringify(stateB)).not.toMatch(/rock|scissors|paper/);
  });

  it('resolves the round and verifies the server revealed what it committed', async () => {
    const state = await apiA.state(tableId);
    const roundId = state.round!.roundId;

    await apiB.commit(tableId, roundId, 'scissors');

    // The first revealer learns nothing; the second gets the answer. Revealing
    // in this order is deliberate — it is the asymmetry that makes non-reveal a
    // losing move.
    await apiA.reveal(roundId);
    await apiB.reveal(roundId);

    // result() runs verifyRound internally and throws MultiplayerFairnessError
    // on a digest mismatch, so reaching this line at all is the integrity
    // assertion. `verified` is checked anyway, because a silently-true flag is
    // the thing worth being paranoid about.
    const result = await apiA.result(roundId);
    expect(result.settled).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.resolution).toBe('played');
    expect(result.yourMove).toBe('rock');
    expect(result.opponentMove).toBe('scissors');
    expect(result.outcome).toBe('a'); // rock beats scissors
  });

  it('settles the pot exactly: stakes in = payout + rake', async () => {
    const { data: rows } = await admin.rpc('mp_conservation_check', { p_table_id: tableId });
    const row = (rows as Array<Record<string, unknown>>)[0];

    expect(Number(row.posted)).toBe(EXPECTED_POT);
    expect(Number(row.paid)).toBe(EXPECTED_PAYOUT);
    expect(Number(row.rake)).toBe(EXPECTED_RAKE);
    expect(Number(row.net)).toBe(0);
    expect(row.conserved).toBe(true);
  });

  it('writes the rake to house_ledger, exactly once', async () => {
    expect(await houseBalance()).toBe(houseBefore + EXPECTED_RAKE);

    const { data } = await admin
      .from('house_ledger')
      .select('delta, reason, idem_key')
      .eq('table_id', tableId);
    expect(data).toHaveLength(1);
    expect(data![0].delta).toBe(EXPECTED_RAKE);
    expect(data![0].reason).toBe('rake');

    // Settling again must be a no-op. The idem key is the guarantee, and a
    // backstop sweep that double-paid the house would be a financial bug.
    await admin.rpc('mp_settle', { p_table_id: tableId, p_kind: 'decided' });
    expect(await houseBalance()).toBe(houseBefore + EXPECTED_RAKE);
  });

  it('leaves no negative balance and keeps the system-wide identity', async () => {
    const { count } = await admin
      .from('balances')
      .select('user_id', { count: 'exact', head: true })
      .lt('chips', 0);
    expect(count).toBe(0);

    // minted = players + house. The rake moves a chip from one side of that
    // identity to the other; it must never create or destroy one.
    const { data: ledger } = await admin.from('ledger').select('delta, reason, currency');
    const rows = (ledger ?? []) as Array<{ delta: number; reason: string; currency: string }>;
    const chips = rows.filter((r) => r.currency === 'chips');
    const players = chips.reduce((n, r) => n + Number(r.delta), 0);
    const minted = chips
      .filter((r) => r.reason === 'chip_purchase' || r.reason === 'match_reward')
      .reduce((n, r) => n + Number(r.delta), 0);
    expect(players + (await houseBalance())).toBe(minted);
  });
});
