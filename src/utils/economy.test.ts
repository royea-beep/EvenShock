import { describe, expect, it } from 'vitest';
import {
  CHIPS_PER_ROUND_WON,
  XP_PER_ROUND,
  isPricedTheme,
  levelForXp,
  levelProgress,
  matchAward,
  themePrice,
} from './economy';

describe('match award', () => {
  it('pays XP for every resolved round and chips only for rounds won', () => {
    expect(matchAward(5, 3)).toEqual({ xp: 50, chips: 15 });
  });

  it('pays a tie-heavy match in XP but not chips', () => {
    // Four ties then two wins: six rounds played, two of them won.
    expect(matchAward(6, 2)).toEqual({ xp: 60, chips: 10 });
  });

  it('pays a match with no rounds nothing', () => {
    expect(matchAward(0, 0)).toEqual({ xp: 0, chips: 0 });
  });

  it('cannot pay chips for more wins than rounds played', () => {
    // Defensive: a caller passing nonsense must not mint currency.
    expect(matchAward(2, 99)).toEqual({ xp: 20, chips: 10 });
  });

  it('ignores negative and fractional inputs rather than paying for them', () => {
    expect(matchAward(-5, -5)).toEqual({ xp: 0, chips: 0 });
    expect(matchAward(3.9, 1.9)).toEqual({ xp: 30, chips: 5 });
  });
});

/**
 * The anti-farming properties, stated as properties rather than examples.
 *
 * The headline rule — an abandoned match pays nothing — lives in the caller:
 * the award is only computed when a match completes, and `resolve_round` never
 * credits an unfinished one. What can be asserted here is the shape that makes
 * that rule safe: playing further never pays less, and no format is worth
 * preferring.
 */
describe('anti-farming', () => {
  it('playing more rounds never pays less than stopping earlier', () => {
    for (let rounds = 1; rounds <= 9; rounds += 1) {
      for (let won = 0; won <= rounds; won += 1) {
        const stopped = matchAward(rounds, won);
        const played = matchAward(rounds + 1, won); // one more round, still not won
        expect(played.xp).toBeGreaterThanOrEqual(stopped.xp);
        expect(played.chips).toBeGreaterThanOrEqual(stopped.chips);
      }
    }
  });

  it('quitting a losing match cannot beat playing it out', () => {
    // Down 0-2 in a bo5 after three rounds. Quitting pays zero — the award is
    // never computed for an unfinished match. Playing on pays at minimum the
    // rounds already played.
    const quitting = { xp: 0, chips: 0 };
    const playingOut = matchAward(5, 2);
    expect(playingOut.xp).toBeGreaterThan(quitting.xp);
    expect(playingOut.chips).toBeGreaterThan(quitting.chips);
  });

  it('pays the same per round regardless of format', () => {
    // The award takes no format argument, so a short match cannot be farmed for
    // a better rate. This asserts the consequence rather than the signature.
    const rates = [1, 3, 5, 9].map((rounds) => matchAward(rounds, rounds).xp / rounds);
    expect(new Set(rates)).toEqual(new Set([XP_PER_ROUND]));

    const chipRates = [1, 3, 5, 9].map((rounds) => matchAward(rounds, rounds).chips / rounds);
    expect(new Set(chipRates)).toEqual(new Set([CHIPS_PER_ROUND_WON]));
  });
});

describe('levels', () => {
  it('starts everyone at level 1', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(99)).toBe(1);
  });

  it('rises at the documented thresholds', () => {
    expect(levelForXp(100)).toBe(2); // 100
    expect(levelForXp(299)).toBe(2);
    expect(levelForXp(300)).toBe(3); // 100 + 200
    expect(levelForXp(600)).toBe(4); // 100 + 200 + 300
  });

  it('never goes backwards as XP grows', () => {
    let previous = 0;
    for (let xp = 0; xp <= 3000; xp += 37) {
      const level = levelForXp(xp);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });

  it('reports progress that stays inside the current level', () => {
    for (let xp = 0; xp <= 2000; xp += 13) {
      const { level, into, span } = levelProgress(xp);
      expect(level).toBe(levelForXp(xp));
      expect(into).toBeGreaterThanOrEqual(0);
      expect(into).toBeLessThan(span);
    }
  });
});

describe('shop', () => {
  it('leaves the four original looks free', () => {
    for (const free of ['studio', 'marble', 'ink', 'molten']) {
      expect(isPricedTheme(free)).toBe(false);
      expect(themePrice(free)).toBeNull();
    }
  });

  it('prices the four added later', () => {
    for (const paid of ['frost', 'highroller', 'jade', 'origami']) {
      expect(isPricedTheme(paid)).toBe(true);
      expect(themePrice(paid)).toBe(60);
    }
  });

  it('prices nothing it does not recognise', () => {
    expect(themePrice('not-a-theme')).toBeNull();
  });
});
