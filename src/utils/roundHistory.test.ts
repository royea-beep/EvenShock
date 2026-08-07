import { describe, expect, it } from 'vitest';
import {
  EMPTY_HISTORY,
  getMatchStats,
  isFreshMatch,
  reduceHistory,
  type HistorySnapshot,
  type HistoryState,
} from './roundHistory';

/** Convenience: the state useGame is in at the start of any match. */
const FRESH: HistorySnapshot = {
  roundNumber: 1,
  roundResult: null,
  playerChoice: null,
  botChoice: null,
};

/** Feeds a sequence of snapshots through the reducer, as the hook does. */
function run(snapshots: HistorySnapshot[], from: HistoryState = EMPTY_HISTORY): HistoryState {
  return snapshots.reduce(reduceHistory, from);
}

/** A completed round, then the picking state of the round after it. */
function playRound(round: number, outcome: 'win' | 'lose' | 'tie'): HistorySnapshot[] {
  return [
    { roundNumber: round, roundResult: null, playerChoice: 'rock', botChoice: null },
    { roundNumber: round, roundResult: outcome, playerChoice: 'rock', botChoice: 'scissors' },
  ];
}

describe('isFreshMatch', () => {
  it('is true only at the start of a match', () => {
    expect(isFreshMatch(FRESH)).toBe(true);
  });

  it('is false once a round has resolved', () => {
    expect(isFreshMatch({ ...FRESH, roundResult: 'win', playerChoice: 'rock', botChoice: 'scissors' }))
      .toBe(false);
  });

  it('is false while picking any round after the first', () => {
    expect(isFreshMatch({ ...FRESH, roundNumber: 2 })).toBe(false);
  });
});

describe('reduceHistory', () => {
  it('records one entry per completed round', () => {
    const state = run([FRESH, ...playRound(1, 'win'), ...playRound(2, 'lose')]);
    expect(state.entries.map((e) => e.outcome)).toEqual(['win', 'lose']);
  });

  it('does not double-record a round across re-renders', () => {
    const resolved: HistorySnapshot = {
      roundNumber: 1, roundResult: 'win', playerChoice: 'rock', botChoice: 'scissors',
    };
    const state = run([FRESH, resolved, resolved, resolved]);
    expect(state.entries).toHaveLength(1);
  });

  it('records ties, which do not move the score but are still rounds', () => {
    const state = run([FRESH, ...playRound(1, 'tie'), ...playRound(2, 'win')]);
    expect(state.entries.map((e) => e.outcome)).toEqual(['tie', 'win']);
  });

  it('keeps the moves that were played', () => {
    const state = run([FRESH, ...playRound(1, 'win')]);
    expect(state.entries[0]).toMatchObject({ player: 'rock', opponent: 'scissors', round: 1 });
  });

  /**
   * The reset guarantee: whichever way a new match begins — "Play again" from
   * the match-end screen (startMatch) or going Home and starting again
   * (playAgain, then startMatch) — both land on the same fresh state, and the
   * previous match's trail must not survive into it.
   */
  it('starts a fresh match empty after "Play again"', () => {
    const finished = run([FRESH, ...playRound(1, 'win'), ...playRound(2, 'win')]);
    expect(finished.entries).toHaveLength(2);

    const afterReset = reduceHistory(finished, FRESH);
    expect(afterReset.entries).toEqual([]);
    expect(afterReset.recorded).toBeNull();
  });

  it('does not leak the previous match into the next one', () => {
    const finished = run([FRESH, ...playRound(1, 'win'), ...playRound(2, 'lose')]);
    const next = run([FRESH, ...playRound(1, 'tie')], finished);
    expect(next.entries.map((e) => e.outcome)).toEqual(['tie']);
  });

  it('re-records round 1 of the new match rather than suppressing it as a duplicate', () => {
    // Round 1 was already recorded last match, so a naive "seen this round
    // number" guard would silently drop the new match's opening round.
    const finished = run([FRESH, ...playRound(1, 'win')]);
    const next = run([FRESH, ...playRound(1, 'lose')], finished);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0].outcome).toBe('lose');
  });
});

describe('getMatchStats', () => {
  const entries = run([
    FRESH, ...playRound(1, 'win'), ...playRound(2, 'lose'), ...playRound(3, 'tie'),
    ...playRound(4, 'win'),
  ]).entries;

  it('counts each outcome', () => {
    const s = getMatchStats(entries);
    expect([s.played, s.wins, s.losses, s.ties]).toEqual([4, 2, 1, 1]);
  });

  it('excludes ties from win rate', () => {
    // 2 wins from 3 decided rounds, not 4 played.
    expect(getMatchStats(entries).winRate).toBeCloseTo(2 / 3);
  });

  it('reports no win rate when every round was a tie', () => {
    const allTies = run([FRESH, ...playRound(1, 'tie')]).entries;
    expect(getMatchStats(allTies).winRate).toBeNull();
  });

  it('reports the most-played move', () => {
    expect(getMatchStats(entries).topMove).toEqual({ choice: 'rock', count: 4 });
  });

  it('handles an empty history', () => {
    const s = getMatchStats([]);
    expect(s.played).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.topMove).toBeNull();
  });
});
