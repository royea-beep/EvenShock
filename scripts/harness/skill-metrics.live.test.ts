/**
 * The skill scorers, against the live project.
 *
 *   npm run e2e:skill
 *
 * WHY THIS SUITE IS FENCED LESS THAN THE OTHERS. Every other live suite writes
 * — matches, rounds, ledger rows — so each one refuses to start without
 * EVENSHOCK_LIVE=1. This one calls two pure functions with literal arrays. It
 * reads no table, writes no row, and needs no service role: the anon key is
 * enough, because `skill_predictability` and `skill_read_rate_match` are
 * deliberately left executable by clients while the aggregators that read other
 * people's rounds are revoked. Running it therefore proves two things at once,
 * the maths and that grant split — if a later migration hands the aggregators
 * to `authenticated`, that is a privacy leak, and this suite is the place it
 * shows up.
 *
 * WHY IT RUNS AGAINST THE DATABASE AND NOT A TYPESCRIPT PORT. The scorers have
 * to run inside the finalization transaction, so they are plpgsql/SQL. A
 * TypeScript re-implementation tested here would be a second copy that agrees
 * with the first only until someone edits one of them. The fixtures below are
 * sequences whose answer is known by construction, so testing the real function
 * costs one round trip and tests the thing that actually runs.
 *
 * The numbers are not arbitrary. Both scorers are stated as win rates:
 * predictability is how much better than a coin flip a perfect reader would do
 * against this sequence, rescaled so 0.5 -> 0 and 1.0 -> 1. That is what makes
 * a fixture checkable by hand — see the assertions.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { ANON_KEY, SUPABASE_URL } from './env.mjs';

if (!SUPABASE_URL || !ANON_KEY) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (.env)');
}

let db: SupabaseClient;

beforeAll(() => {
  db = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
});

const ROCK = 'rock';
const PAPER = 'paper';
const SCISSORS = 'scissors';
const CYCLE = [ROCK, PAPER, SCISSORS];

/** n copies of one move. */
const repeat = (move: string, n: number) => Array.from({ length: n }, () => move);
/** n nulls — "this round had no in-match predecessor". */
const noContext = (n: number) => Array.from({ length: n }, () => null);
/** R, P, S, R, P, S, ... */
const cycle = (n: number) => Array.from({ length: n }, (_, i) => CYCLE[i % 3]);
/** The same cycle shifted back one: what the player threw the round before. */
const cyclePrev = (n: number) => Array.from({ length: n }, (_, i) => CYCLE[(i + 2) % 3]);

async function predictability(
  moves: (string | null)[],
  prevMoves: (string | null)[],
  prevOutcomes: (string | null)[],
): Promise<number | null> {
  const { data, error } = await db.rpc('skill_predictability', {
    p_moves: moves,
    p_prev_moves: prevMoves,
    p_prev_outcomes: prevOutcomes,
  });
  if (error) throw new Error(`skill_predictability: ${error.message}`);
  return data === null ? null : Number(data);
}

async function readRate(mine: string[], theirs: string[]): Promise<{ hits: number; opportunities: number }> {
  const { data, error } = await db.rpc('skill_read_rate_match', {
    p_player_moves: mine,
    p_opponent_moves: theirs,
  });
  if (error) throw new Error(`skill_read_rate_match: ${error.message}`);
  return data as { hits: number; opportunities: number };
}

describe('predictability', () => {
  it('scores a pure-rock player at the top of the scale', async () => {
    // A reader who always throws paper wins every round. The only thing keeping
    // this off exactly 1.0 is the Jeffreys smoothing, which never fully commits.
    expect(await predictability(repeat(ROCK, 30), noContext(30), noContext(30))).toBeCloseTo(0.9524, 3);
  });

  it('scores a uniform player at exactly zero', async () => {
    // Ten of each and no usable context: a reader learns nothing, so their
    // expected score is 0.5 — a coin flip — which is the bottom of the scale.
    expect(await predictability(cycle(30), noContext(30), noContext(30))).toBe(0);
  });

  it('catches a strict cycle that the marginal model calls unexploitable', async () => {
    // THIS is why exploitability is the max across models and not the average.
    // R,P,S,R,P,S... has a perfectly uniform marginal — the previous assertion
    // proves the marginal model scores this same sequence 0.0 — but the throw
    // is a function of the last one, so conditioning on it reads the player
    // perfectly. Averaging the models would report ~0.29 for a player who is
    // in fact fully transparent.
    expect(await predictability(cycle(30), cyclePrev(30), noContext(30))).toBeCloseTo(0.8696, 3);
  });

  it('catches a player whose tell is the previous result', async () => {
    // Rock after every win, cycling otherwise: invisible to both the marginal
    // and the previous-throw model, visible to the outcome model.
    const moves = [ROCK, PAPER, ROCK, SCISSORS, ROCK, PAPER, ROCK, SCISSORS, ROCK, PAPER, ROCK, SCISSORS];
    const outcomes = [null, 'win', 'lose', 'win', 'lose', 'win', 'lose', 'win', 'lose', 'win', 'lose', 'win'];
    expect(await predictability(moves, noContext(12), outcomes)).toBeCloseTo(0.5678, 3);
  });

  it('refuses to call one throw a pattern', async () => {
    // The estimator that made the ladder worthless: unsmoothed, a player who
    // has thrown once scores 1.0 and opens on the leaderboard as the most
    // readable player alive. Smoothing puts a single rock at 0.4.
    expect(await predictability([ROCK], [null], [null])).toBeCloseTo(0.4, 6);
  });

  it('returns NULL on no data rather than zero', async () => {
    // Zero would mean "measured, and unexploitable". There is a real difference
    // between an unreadable player and a player nobody has watched yet.
    expect(await predictability([], [], [])).toBeNull();
  });
});

describe('read rate', () => {
  it('credits every readable round against a pure-rock opponent', async () => {
    // Round 1 is never an opportunity — no history existed yet. Rounds 2-5 all
    // are, and paper is the counter to the mode every time.
    expect(await readRate(repeat(PAPER, 5), repeat(ROCK, 5))).toEqual({ hits: 4, opportunities: 4 });
  });

  it('credits none of them to a player who ignores the same opponent', async () => {
    // Same four opportunities, zero taken. Opportunities is the denominator and
    // does not move with the player's choices — that is what makes the rate a
    // rate.
    expect(await readRate(repeat(ROCK, 5), repeat(ROCK, 5))).toEqual({ hits: 0, opportunities: 4 });
  });

  it('does not score rounds where there was nothing to read', async () => {
    // Opponent throws R,P,R,P. Before round 2 the history is {R} and readable.
    // Before round 3 it is {R,P} — a tie, no unique mode, nothing a player
    // could have exploited. Before round 4 it is {R,P,R} and readable again.
    // A miss and an impossibility are not the same thing, so the tied round is
    // dropped from the denominator rather than counted against the player.
    expect(await readRate(repeat(PAPER, 4), [ROCK, PAPER, ROCK, PAPER])).toEqual({
      hits: 2,
      opportunities: 2,
    });
  });

  it('survives a one-round match and an empty one', async () => {
    expect(await readRate([ROCK], [ROCK])).toEqual({ hits: 0, opportunities: 0 });
    expect(await readRate([], [])).toEqual({ hits: 0, opportunities: 0 });
  });
});

describe('grants', () => {
  it('does not let a client recompute anyone from their rounds', async () => {
    // The aggregators read every player's rounds to build one player's metrics.
    // Reachable by a client, that is a way to enumerate other people's throws.
    const { error } = await db.rpc('refresh_player_skill_metrics', {
      p_user_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(error).not.toBeNull();
  });
});
