import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The round-open timing channel, guarded at the source.
 *
 * WHAT THIS IS NOT. It is not the measurement. `npm run e2e:nemesis-timing`
 * is the measurement — mutual information between round-open latency and
 * whether Nemesis actually read that round, with a permutation test — and it
 * needs a machine that can reach the project. This file cannot tell you
 * whether the channel is open. It can only tell you whether the code still
 * has the property that closes it.
 *
 * WHY IT EXISTS ANYWAY. The mitigation is one line away from being undone by
 * somebody being helpful: skipping `nemesis_open` when the coin has already
 * landed blind is the obvious optimisation, it saves a round trip on ~65% of
 * rounds, and it would open a side channel that announces "it is reading you
 * this round". A player who can hear that simply deviates — which is worth
 * strictly more to them than knowing the move, because knowing the move wins
 * one round and knowing the mode wins every round they choose to spend it on.
 *
 * A comment saying "do not do this" does not survive a refactor. This does.
 */

const SOURCE = readFileSync('supabase/functions/play/index.ts', 'utf8');

/** The body of `openRound`, from its signature to the next top-level function. */
function openRoundBody(): string {
  const start = SOURCE.indexOf('async function openRound(');
  expect(start, 'openRound not found — this test is guarding nothing').toBeGreaterThan(-1);
  const after = SOURCE.indexOf('\nasync function ', start + 1);
  return SOURCE.slice(start, after === -1 ? SOURCE.length : after);
}

describe('open_round does the same work whichever branch it takes', () => {
  const body = openRoundBody();

  const at = (needle: string) => body.indexOf(needle);

  it('draws the blind move and the coin before it knows which it will use', () => {
    // Both must exist unconditionally. If either moved inside a branch, the
    // cost of a round would start depending on the answer.
    expect(at('drawMove()')).toBeGreaterThan(-1);
    expect(at('drawUnitInterval()')).toBeGreaterThan(-1);
    expect(at('drawMove()')).toBeLessThan(at('exploited'));
    expect(at('drawUnitInterval()')).toBeLessThan(at('exploited'));
  });

  it('asks for the prediction on every round, not only the ones it will use', () => {
    // THE LOAD-BEARING ASSERTION. `nemesis_open` is the expensive half — a
    // database round trip — so guarding it is what would make read rounds
    // measurably slower than blind ones.
    expect(body.split("'nemesis_open'").length - 1).toBe(1);
    expect(at("'nemesis_open'")).toBeLessThan(at('exploited'));

    // Nothing may branch between entering the function and issuing that call,
    // apart from argument validation on the very first line.
    const beforeRpc = body.slice(at('const blind'), at("'nemesis_open'"));
    expect(beforeRpc).not.toMatch(/\bif\s*\(/);
    expect(beforeRpc).not.toMatch(/\?[^?]/); // no ternary either
  });

  it('selects with a comparison rather than by doing different work', () => {
    // The decision itself must be a pure choice between two values that are
    // already in hand — no second await, no extra call on either side.
    expect(body).toMatch(/const exploited = coin < rate && isChoice\(counter\)/);
    expect(body).toMatch(/const move: Choice = exploited \? \(counter as Choice\) : blind/);
  });

  it('hashes exactly once, whichever move won', () => {
    // A commitment computed per branch would be the same cost twice over, but
    // a commitment computed only on one branch would not be.
    expect(body.split('computeCommitment(').length - 1).toBe(1);
    expect(at('computeCommitment(')).toBeGreaterThan(at('const move: Choice'));
  });

  it('never returns the move or the nonce from open_round', () => {
    // Adjacent guarantee, cheap to assert here: the client checks for these
    // and raises FairnessError, but the server should not be sending them in
    // the first place.
    const returned = body.slice(body.lastIndexOf('return json('));
    expect(returned).toContain('commitment');
    expect(returned).not.toMatch(/\bnonce\b/);
    expect(returned).not.toMatch(/opponent_choice/);
  });
});
