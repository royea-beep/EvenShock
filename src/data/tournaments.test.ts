import { describe, expect, it } from 'vitest';
import {
  groupByRound,
  isBye,
  nextPlayableSlot,
  roundLabel,
  type BracketSlot,
} from './tournaments';

const slot = (over: Partial<BracketSlot> = {}): BracketSlot => ({
  roundNo: 1,
  slot: 1,
  status: 'pending',
  a: { id: 'a', name: 'Ada', seed: 1 },
  b: { id: 'b', name: 'Bea', seed: 2 },
  winner: null,
  mpTableId: null,
  yourTurn: false,
  ...over,
});

describe('roundLabel', () => {
  it('names rounds backwards from the final, not forwards', () => {
    // The bug this prevents: "Round 2" means the final in a 4-player draw and
    // the quarter-final in a 16-player one. Counting from the end makes the
    // last round "Final" at every bracket size.
    expect(roundLabel(2, 2)).toBe('Final');
    expect(roundLabel(1, 2)).toBe('Semi-final');

    expect(roundLabel(3, 3)).toBe('Final');
    expect(roundLabel(2, 3)).toBe('Semi-final');
    expect(roundLabel(1, 3)).toBe('Quarter-final');
  });

  it('falls back to a size for rounds deeper than the quarter-final', () => {
    // 16-player draw: round 1 has 8 matches, so it is the round of 16.
    expect(roundLabel(1, 4)).toBe('Round of 16');
    expect(roundLabel(1, 5)).toBe('Round of 32');
  });

  it('calls the only round of a two-player draw the final', () => {
    expect(roundLabel(1, 1)).toBe('Final');
  });
});

describe('groupByRound', () => {
  it('orders rounds and slots regardless of input order', () => {
    const grouped = groupByRound([
      slot({ roundNo: 2, slot: 1 }),
      slot({ roundNo: 1, slot: 3 }),
      slot({ roundNo: 1, slot: 1 }),
      slot({ roundNo: 1, slot: 2 }),
    ]);
    expect(grouped.map((g) => g.roundNo)).toEqual([1, 2]);
    expect(grouped[0].slots.map((s) => s.slot)).toEqual([1, 2, 3]);
  });

  it('returns nothing for an undrawn bracket', () => {
    expect(groupByRound([])).toEqual([]);
  });
});

describe('nextPlayableSlot', () => {
  it('picks the earliest round the player can act in', () => {
    const found = nextPlayableSlot([
      slot({ roundNo: 2, slot: 1, yourTurn: true }),
      slot({ roundNo: 1, slot: 2, yourTurn: true }),
      slot({ roundNo: 1, slot: 1, yourTurn: false }),
    ]);
    expect(found?.roundNo).toBe(1);
    expect(found?.slot).toBe(2);
  });

  it('returns null when the player is waiting on somebody else', () => {
    expect(nextPlayableSlot([slot({ yourTurn: false })])).toBeNull();
    expect(nextPlayableSlot([])).toBeNull();
  });
});

describe('isBye', () => {
  it('treats a one-sided slot as a bye even if the status has not caught up', () => {
    // The server marks these 'bye', but a slot whose opponent has not been
    // decided yet also has a null side, and neither is a match somebody won.
    expect(isBye(slot({ status: 'bye', b: { id: null, name: null, seed: null } }))).toBe(true);
    expect(isBye(slot({ status: 'pending', b: { id: null, name: null, seed: null } }))).toBe(true);
  });

  it('does not call a real pairing a bye', () => {
    expect(isBye(slot())).toBe(false);
    expect(isBye(slot({ status: 'complete', winner: 'a' }))).toBe(false);
  });
});
