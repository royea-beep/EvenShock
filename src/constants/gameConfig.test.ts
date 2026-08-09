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

  it('runs a routine round at about 1150ms', () => {
    setPace(false);
    expect(total(IMPACT_HOLD_MS.routine)).toBe(1150);
  });

  it('runs a match-deciding round at about 1350ms', () => {
    // This exceeds the ~1150ms ceiling agreed in Phase B, and does so on
    // purpose: the wind-up was chosen over the alternatives and then asked to
    // hold its coil longer, which can only be bought with time. 1350ms is the
    // stated cap now — Fast mode, unchanged at 701ms, is the answer for anyone
    // who wants the old brevity.
    setPace(false);
    expect(total(IMPACT_HOLD_MS.deciding)).toBe(1350);
    expect(total(IMPACT_HOLD_MS.deciding)).toBeLessThanOrEqual(1350);
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
    expect(REVEAL_DELAY_MS).toBe(870);
    expect(SHAKE_BEAT_MS).toBe(290);
  });

  it('leaves Fast mode at the brisk beat rather than scaling it with the wind-up', () => {
    // Fast is the escape hatch. If it grew with the normal pace it would stop
    // being one, and the "are most players on Fast?" signal would stop meaning
    // anything.
    setPace(true);
    expect(SHAKE_BEAT_MS).toBe(167);
    expect(REVEAL_DELAY_MS).toBe(501);
  });
});
