/**
 * The game loop, against the live project.
 *
 *   npm run e2e:rounds
 *
 * Everything shipped since the payment work has been protecting a path nobody
 * had walked: as of this file, production held 0 matches, 0 rounds and 0 XP.
 * Eighteen green end-to-end tests, all of them payments. This is the one that
 * exercises the actual product.
 *
 * IT DRIVES `createServerRounds`, NOT A COPY OF IT. The commitment check and
 * the outcome cross-check already live in src/data/rounds.ts, where the browser
 * runs them; re-implementing either here would test a second copy of the thing
 * and let the real one rot. So the suite builds a signed-in Supabase client,
 * hands it to the product's own seam, and plays. A tampered commitment or a
 * disagreed outcome arrives as the same `FairnessError` a player would hit.
 *
 * That is also why this is a vitest file rather than a plain script like the
 * payment suite: rounds.ts imports `'../utils/rules'` without an extension, and
 * bare Node will not resolve that. Vite's resolver will.
 *
 * IT WRITES TO PRODUCTION, so it is fenced twice — excluded from `npm test` by
 * the `*.live.test.ts` glob in vite.config.ts, and refused outright unless
 * EVENSHOCK_LIVE=1. One careless glob should not be all that stands between a
 * CI run and real rows.
 */
import { Keypair } from '@solana/web3.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServerRounds, type RoundsApi } from '../../src/data/rounds';
import { matchAward } from '../../src/utils/economy';
import { CHOICES, computeCommitment, getRoundOutcome, type Choice } from '../../src/utils/rules';
import { submitLatencySummary } from '../../src/utils/latency';
import { signInWithKeypair } from './auth.mjs';
import { ANON_KEY, SERVICE_ROLE_KEY, SUPABASE_URL } from './env.mjs';

if (process.env.EVENSHOCK_LIVE !== '1') {
  throw new Error(
    'refusing to run: this suite writes matches, rounds and ledger rows to the live project. Set EVENSHOCK_LIVE=1.',
  );
}
// Thrown rather than `requireServiceRole()`, which exits the process — right
// for a standalone script, wrong inside a test worker where it takes the
// reporter down with it and prints nothing useful.
if (!SUPABASE_URL || !ANON_KEY) throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (.env)');
if (!SERVICE_ROLE_KEY) {
  throw new Error(
    'SUPABASE_SERVICE_ROLE_KEY must be set in .env.local — the suite reads matches, rounds and ledger back as an operator would, past the RLS a player sees.',
  );
}

/**
 * A fixed keypair, so the suite reuses one player rather than accumulating a
 * profile per run. Derived from a constant seed and therefore reproducible:
 * this is a throwaway identity in a test project, not a wallet.
 */
const PLAYER_SEED = new Uint8Array(32).fill(7);
const player = Keypair.fromSeed(PLAYER_SEED);

let admin: SupabaseClient;
let rounds: RoundsApi;
let userId: string;

/** Everything this player has ever done, gone. Keeps the totals below exact. */
async function reset(id: string) {
  await admin.from('ledger').delete().eq('user_id', id).throwOnError();
  await admin.from('rounds').delete().eq('user_id', id).throwOnError();
  await admin.from('matches').delete().eq('user_id', id).throwOnError();
  await admin.from('balances').delete().eq('user_id', id).throwOnError();
  await admin.from('inventory').delete().eq('user_id', id).throwOnError();
}

beforeAll(async () => {
  admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const session = await signInWithKeypair(SUPABASE_URL, ANON_KEY, player, 'round-player');
  userId = session.userId;
  await reset(userId);

  // The product's own seam, over a real session. No stub anywhere below here.
  rounds = createServerRounds(session.client);
}, 60_000);

afterAll(() => {
  const summary = submitLatencySummary();
  if (summary.n > 0) {
    // Not an assertion. This is a datacentre-to-Supabase figure and the budget
    // is about phones — printing it as a pass would be dressing up the wrong
    // number. See scripts/harness/browser-latency.mjs for the browser one.
    console.log(`\n  submit round trip (harness → Edge Function, not a browser):`);
    console.log(`  ${JSON.stringify(summary)}\n`);
  }
});

/** Plays one round and returns what the server revealed. */
async function playRound(matchId: string, choice: Choice) {
  const open = await rounds.openRound(matchId);
  const reveal = await rounds.submit(open, choice);
  return { open, reveal };
}

describe('a best-of-three, through the same code the browser runs', () => {
  let matchId: string;
  let played: Array<{ choice: Choice; outcome: string }> = [];
  let complete = false;

  it('opens a match', async () => {
    matchId = await rounds.openMatch('bo3', 'studio', true);
    expect(matchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('plays to completion without a fairness failure', async () => {
    // `submit` verifies the commitment and cross-checks the outcome internally
    // and throws FairnessError on either. Reaching the end of this loop IS the
    // assertion that both held on every round — against a live server, which is
    // the part the unit tests could never cover.
    for (let i = 0; i < 12 && !complete; i += 1) {
      const choice = CHOICES[i % 3];
      const { reveal } = await playRound(matchId, choice);
      played.push({ choice, outcome: reveal.outcome });
      complete = reveal.matchComplete;
    }
    expect(complete).toBe(true);
    // bo3 needs two wins by one side; ties replay, so the floor is two rounds.
    expect(played.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('never revealed its move before the player had committed', async () => {
    // The seam throws `reveal_before_move` if open_round carries opponent_choice
    // or nonce, so the rounds above already proved it. This re-proves it against
    // the row the server actually stored: the commitment must be reproducible
    // from the stored move and nonce, and it was issued before the player moved.
    const { data } = await admin
      .from('rounds')
      .select('round_number, commitment, opponent_choice, nonce, player_choice, outcome, state')
      .eq('match_id', matchId)
      .order('round_number');

    expect(data?.length).toBe(played.length);
    for (const row of data ?? []) {
      expect(row.state).toBe('resolved');
      const recomputed = await computeCommitment(row.opponent_choice as Choice, row.nonce);
      expect(recomputed).toBe(row.commitment);
      // And the stored outcome agrees with the shared rules, read from the
      // database rather than from the response we already checked.
      expect(row.outcome).toBe(
        getRoundOutcome(row.player_choice as Choice, row.opponent_choice as Choice),
      );
    }
  });

  it('wrote a finalized match with the score the rounds imply', async () => {
    const { data } = await admin
      .from('matches')
      .select('status, result, player_score, opponent_score, format, fast_mode')
      .eq('id', matchId)
      .single();

    const wins = played.filter((p) => p.outcome === 'win').length;
    const losses = played.filter((p) => p.outcome === 'lose').length;

    expect(data?.status).toBe('complete');
    expect(data?.format).toBe('bo3');
    expect(data?.fast_mode).toBe(true);
    expect(data?.player_score).toBe(wins);
    expect(data?.opponent_score).toBe(losses);
    expect(data?.result).toBe(wins > losses ? 'win' : 'lose');
    // A finished match can never be a draw: it ends exactly when someone
    // reaches the wins needed.
    expect(data?.result).not.toBe('tie');
  });

  it('paid exactly what the curve says, in one ledger entry per currency', async () => {
    const wins = played.filter((p) => p.outcome === 'win').length;
    const expected = matchAward(played.length, wins);

    const { data: balance } = await admin
      .from('balances')
      .select('xp, chips')
      .eq('user_id', userId)
      .single();

    expect(Number(balance?.xp)).toBe(expected.xp);
    expect(Number(balance?.chips)).toBe(expected.chips);

    const { data: ledger } = await admin
      .from('ledger')
      .select('currency, delta, reason, idem_key, match_id')
      .eq('user_id', userId);

    // Exactly-once, by idem key. Chips are omitted rather than posted as zero
    // when no round was won, so the row count follows the award.
    const keys = (ledger ?? []).map((r) => r.idem_key).sort();
    const wanted = [`reward:${matchId}:xp`];
    if (expected.chips > 0) wanted.push(`reward:${matchId}:chips`);
    expect(keys).toEqual(wanted.sort());

    const sum = (currency: string) =>
      (ledger ?? [])
        .filter((r) => r.currency === currency)
        .reduce((total, r) => total + Number(r.delta), 0);
    expect(sum('xp')).toBe(Number(balance?.xp));
    expect(sum('chips')).toBe(Number(balance?.chips));
    for (const row of ledger ?? []) expect(row.reason).toBe('match_reward');
  });
});

describe('submitting the same round twice', () => {
  let matchId: string;
  let openRound: Awaited<ReturnType<RoundsApi['openRound']>>;

  beforeAll(async () => {
    matchId = await rounds.openMatch('bo5', 'studio', false);
    openRound = await rounds.openRound(matchId);
  }, 60_000);

  it('returns the same answer to a retry with the same move', async () => {
    // The dropped-response case. A retry must be indistinguishable from the
    // original, or a flaky connection turns into a lost round.
    const first = await rounds.submit(openRound, 'rock');
    const retry = await rounds.submit(openRound, 'rock');
    expect(retry.outcome).toBe(first.outcome);
    expect(retry.opponentChoice).toBe(first.opponentChoice);
    expect(retry.score).toEqual(first.score);
  });

  it('refuses a different move for a round already resolved', async () => {
    await expect(rounds.submit(openRound, 'paper')).rejects.toMatchObject({
      code: 'already_submitted',
    });
  });

  it('counted the round once', async () => {
    const { count } = await admin
      .from('rounds')
      .select('*', { count: 'exact', head: true })
      .eq('match_id', matchId)
      .eq('state', 'resolved');
    expect(count).toBe(1);
  });
});

describe('walking out of a match', () => {
  /**
   * The anti-farming property, which has existed only as a comment until now.
   *
   * The award is computed when a match COMPLETES, so quitting a match you are
   * losing must pay nothing — otherwise the optimal strategy is to abandon
   * every match that turns bad and restart, and the currency becomes a function
   * of patience rather than play.
   */
  it('pays nothing for an unfinished match', async () => {
    const before = await admin
      .from('balances')
      .select('xp, chips')
      .eq('user_id', userId)
      .single();

    const matchId = await rounds.openMatch('bo5', 'studio', false);
    const open = await rounds.openRound(matchId);
    await rounds.submit(open, 'rock');
    // …and walk away.

    const { data: match } = await admin
      .from('matches')
      .select('status, result, finalized_at')
      .eq('id', matchId)
      .single();
    expect(match?.status).toBe('in_progress');
    expect(match?.result).toBeNull();
    expect(match?.finalized_at).toBeNull();

    const after = await admin
      .from('balances')
      .select('xp, chips')
      .eq('user_id', userId)
      .single();
    expect(Number(after.data?.xp)).toBe(Number(before.data?.xp));
    expect(Number(after.data?.chips)).toBe(Number(before.data?.chips));

    const { count } = await admin
      .from('ledger')
      .select('*', { count: 'exact', head: true })
      .eq('match_id', matchId);
    expect(count).toBe(0);
  }, 60_000);
});

describe('the integrity log', () => {
  it('recorded nothing for a clean run', async () => {
    // Every FairnessError the client raises is also reported to the server. An
    // empty log here is the corroborating evidence that the rounds above passed
    // for the right reason rather than by not being checked.
    const { data } = await admin
      .from('integrity_events')
      .select('kind, source, detail')
      .eq('user_id', userId);
    expect(data).toEqual([]);
  });
});
