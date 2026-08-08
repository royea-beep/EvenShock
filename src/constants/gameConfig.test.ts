import { afterEach, describe, expect, it } from 'vitest';
import {
  IMPACT_HOLD_MS,
  REVEAL_DELAY_MS,
  SHAKE_BEATS,
  SHAKE_BEAT_MS,
  setPace,
} from './gameConfig';

afterEach(() => setPace(false));

/**
 * The sequence budget, asserted as numbers rather than left to drift.
 *
 * The peak is deliberately reserved for the round that ends the match: a
 * slow-motion beat and a screen flash on EVERY round is the element most likely
 * to grate by the twentieth view.
 */
describe('sequence budget', () => {
  const total = (hold: number) => REVEAL_DELAY_MS + hold;

  it('runs a routine round at about 940ms', () => {
    setPace(false);
    expect(total(IMPACT_HOLD_MS.routine)).toBe(940);
  });

  it('runs a match-deciding round at about 1140ms, under the ~1150 agreed peak', () => {
    setPace(false);
    expect(total(IMPACT_HOLD_MS.deciding)).toBe(1140);
    expect(total(IMPACT_HOLD_MS.deciding)).toBeLessThanOrEqual(1150);
  });

  it('runs a fast round at about 700ms', () => {
    setPace(true);
    expect(total(IMPACT_HOLD_MS.fast)).toBe(701);
  });

  it('makes fast mode genuinely faster than the pre-Phase-B sequence, not equal to it', () => {
    // 849ms was the old figure. A mode whose only job is to undo the thing we
    // just built would be a signal we built too much, so Fast has to beat it.
    setPace(true);
    expect(total(IMPACT_HOLD_MS.fast)).toBeLessThan(849);
  });

  it('keeps the deciding peak under the routine round plus 250ms of slow motion', () => {
    setPace(false);
    expect(IMPACT_HOLD_MS.deciding - IMPACT_HOLD_MS.routine).toBeLessThanOrEqual(250);
  });
});

describe('pace', () => {
  it('shortens the build-up without changing the beat count', () => {
    setPace(false);
    const normal = REVEAL_DELAY_MS;
    setPace(true);
    expect(REVEAL_DELAY_MS).toBeLessThan(normal);
    expect(REVEAL_DELAY_MS).toBe(SHAKE_BEATS * SHAKE_BEAT_MS);
  });

  it('restores the full pace when switched back', () => {
    setPace(true);
    setPace(false);
    expect(REVEAL_DELAY_MS).toBe(660);
    expect(SHAKE_BEAT_MS).toBe(220);
  });
});
