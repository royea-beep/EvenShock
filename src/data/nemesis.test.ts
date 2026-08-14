import { describe, expect, it } from 'vitest';
import {
  asPercent,
  asReport,
  dominantMove,
  hasDebrief,
  parseContext,
  predictabilityTrend,
  PREDICTABILITY_EPSILON,
  type NemesisTell,
} from './nemesis';
import { copy } from '../constants/copy';

/**
 * The debrief is the whole point of this opponent — a player is supposed to
 * finish a match knowing something about themselves they could go and count.
 * So what is tested here is not that the panel renders: it is that the numbers
 * on it mean what the sentence around them says they mean.
 */

const tell = (over: Partial<NemesisTell> = {}): NemesisTell => ({
  model: 'marginal',
  context: '',
  rock: 0,
  paper: 0,
  scissors: 0,
  total: 0,
  ...over,
});

describe('parsing the report', () => {
  it('maps the RPC payload, including the read/blind split', () => {
    const r = asReport({
      match_id: 'm1',
      rounds: 5,
      read: { rounds: 2, you_won: 1 },
      blind: { rounds: 3, you_won: 2 },
      tell: { model: 'prev_move', context: 'rock', rock: 7, paper: 2, scissors: 2, total: 11 },
      predictability: { before: 0.62, after: 0.58 },
      calibrating: false,
      rounds_until_read: 0,
    });

    expect(r.matchId).toBe('m1');
    expect(r.read).toEqual({ rounds: 2, youWon: 1 });
    expect(r.blind).toEqual({ rounds: 3, youWon: 2 });
    expect(r.tell?.model).toBe('prev_move');
    expect(r.predictability).toEqual({ before: 0.62, after: 0.58 });
    expect(r.calibrating).toBe(false);
  });

  it('keeps a null tell null rather than inventing one', () => {
    // The server sends null when Nemesis never exploited — there was no lens it
    // leaned on. A default-shaped tell here would put a sentence about the
    // player's behaviour in front of them that nothing observed.
    expect(asReport({ rounds: 3, tell: null }).tell).toBeNull();
    expect(asReport({ rounds: 3, tell: { model: 'nonsense' } }).tell).toBeNull();
  });

  it('distinguishes "no score yet" from a score of zero', () => {
    // 0 is the best possible predictability — completely unreadable — so
    // collapsing null to 0 would award a perfect result to a player who has
    // simply not played enough rounds to be measured.
    const none = asReport({ predictability: { before: null, after: null } });
    expect(none.predictability.after).toBeNull();

    const perfect = asReport({ predictability: { before: 0.4, after: 0 } });
    expect(perfect.predictability.after).toBe(0);
  });

  it('has nothing to show for a match with no resolved rounds', () => {
    expect(hasDebrief(asReport({ rounds: 0 }))).toBe(false);
    expect(hasDebrief(asReport({ rounds: 1 }))).toBe(true);
  });
});

describe('the tell', () => {
  it('names the move the counts actually point at', () => {
    expect(dominantMove(tell({ rock: 7, paper: 2, scissors: 2, total: 11 }))).toEqual({
      move: 'rock',
      count: 7,
      total: 11,
    });
  });

  it('refuses to name one from an empty context', () => {
    expect(dominantMove(tell({ total: 0 }))).toBeNull();
    expect(dominantMove(tell({ total: 4 }))).toBeNull();
  });

  it('breaks a tie the same way every time', () => {
    const t = tell({ rock: 3, paper: 3, scissors: 0, total: 6 });
    expect(dominantMove(t)?.move).toBe('rock');
    expect(dominantMove(t)?.move).toBe(dominantMove(t)?.move);
  });

  it('unpacks the situation each lens was watching', () => {
    expect(parseContext(tell({ model: 'marginal', context: '' }))).toEqual({
      prevOutcome: null,
      prevMove: null,
    });
    expect(parseContext(tell({ model: 'prev_move', context: 'paper' }))).toEqual({
      prevOutcome: null,
      prevMove: 'paper',
    });
    expect(parseContext(tell({ model: 'prev_outcome', context: 'lose' }))).toEqual({
      prevOutcome: 'lose',
      prevMove: null,
    });
    expect(parseContext(tell({ model: 'prev_outcome_move', context: 'win|scissors' }))).toEqual({
      prevOutcome: 'win',
      prevMove: 'scissors',
    });
  });

  it('degrades to the vague sentence rather than a confident wrong one', () => {
    // A context that does not parse must not produce "after you threw undefined".
    expect(parseContext(tell({ model: 'prev_move', context: 'banana' }))).toEqual({
      prevOutcome: null,
      prevMove: null,
    });
    expect(parseContext(tell({ model: 'prev_outcome_move', context: 'win' }))).toEqual({
      prevOutcome: 'win',
      prevMove: null,
    });
    expect(copy.nemesis.tellOverall('Rock', 40, 92)).toBe(
      'Across every round, you threw Rock 40 times out of 92.',
    );
  });

  it('reads back as a countable sentence', () => {
    const t = tell({ model: 'prev_outcome_move', context: 'lose|rock', rock: 7, total: 11 });
    const c = parseContext(t);
    const lean = dominantMove(t)!;
    expect(
      copy.nemesis.tellSentence(
        copy.nemesis.situation(c.prevOutcome, c.prevMove && copy.choices[c.prevMove]),
        copy.choices[lean.move],
        lean.count,
        lean.total,
      ),
    ).toBe('After losing a round having thrown Rock, you followed with Rock 7 times out of 11.');
  });
});

describe('predictability', () => {
  it('reports the direction the player moved', () => {
    expect(predictabilityTrend({ before: 0.62, after: 0.58 })).toBe('down');
    expect(predictabilityTrend({ before: 0.58, after: 0.62 })).toBe('up');
  });

  it('calls a change too small to render flat, rather than progress', () => {
    // Claiming an improvement the player cannot see on the panel is the fastest
    // way to make every other number here untrustworthy.
    const justUnder = { before: 0.6, after: 0.6 - PREDICTABILITY_EPSILON / 2 };
    expect(predictabilityTrend(justUnder)).toBe('flat');
    expect(asPercent(justUnder.before)).toBe(asPercent(justUnder.after));

    const justOver = { before: 0.6, after: 0.6 - PREDICTABILITY_EPSILON * 2 };
    expect(predictabilityTrend(justOver)).toBe('down');
  });

  it('says nothing at all when there is no score', () => {
    expect(predictabilityTrend({ before: null, after: 0.5 })).toBeNull();
    expect(predictabilityTrend({ before: 0.5, after: null })).toBeNull();
  });

  it('shows whole percent', () => {
    expect(asPercent(0.617)).toBe(62);
    expect(asPercent(0)).toBe(0);
    expect(asPercent(1)).toBe(100);
  });
});

describe('the two things the panel must say out loud', () => {
  it('states the cold start with the number of rounds left', () => {
    // "It felt easy" has two explanations — the player is good, or the opponent
    // was blind. Only one of them is true during the ramp, and the player is
    // told which.
    expect(copy.nemesis.calibrating(7)).toContain('7 more rounds');
    expect(copy.nemesis.calibrating(1)).toContain('1 more round');
    expect(copy.nemesis.calibrating(3)).toContain('still learning you');
  });

  it('says what a perfect predictability score does and does not measure', () => {
    // A player using an external randomiser genuinely is unreadable — that is
    // the theorem working, not an exploit, and it is not defended against. The
    // copy has to make a perfect score read as what it is.
    expect(copy.nemesis.trophyCaveat).toContain('dice');
    expect(copy.nemesis.trophyCaveat).toContain('0%');
  });

  it('does not claim the blind rounds were charity', () => {
    expect(copy.nemesis.blindNote).toContain('you won it');
  });
});
