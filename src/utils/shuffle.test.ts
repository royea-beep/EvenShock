import { describe, expect, it } from 'vitest';
import { SHUFFLE_ORDER, SHUFFLE_STEP_MS, shuffleMoveAt } from './shuffle';
import { REVEAL_DELAY_MS } from '../constants/gameConfig';

/**
 * These tests exist to protect one property: the bot's decoy shuffle carries no
 * information about the bot's real choice. The Playwright suite measures that
 * statistically end-to-end; this file pins the structural reasons it holds, so
 * a regression fails here first and cheaply.
 */
describe('bot shuffle', () => {
  it('takes elapsed time as its only input', () => {
    // A second parameter is how a leak would most plausibly arrive — someone
    // "improving" the shuffle by landing it near the real answer.
    expect(shuffleMoveAt.length).toBe(1);
  });

  it('is deterministic: the same elapsed time always gives the same move', () => {
    for (const t of [0, 45, 90, 271, 500, 659]) {
      const first = shuffleMoveAt(t);
      for (let i = 0; i < 50; i += 1) expect(shuffleMoveAt(t)).toBe(first);
    }
  });

  it('advances one step per interval, in fixed order', () => {
    for (let step = 0; step < 12; step += 1) {
      const move = shuffleMoveAt(step * SHUFFLE_STEP_MS);
      expect(move).toBe(SHUFFLE_ORDER[step % SHUFFLE_ORDER.length]);
    }
  });

  it('visits all three moves during a single build-up', () => {
    const seen = new Set<string>();
    for (let t = 0; t < REVEAL_DELAY_MS; t += 10) seen.add(shuffleMoveAt(t));
    // A cycle that never showed a move would make that move's later appearance
    // at the snap informative on its own.
    expect([...seen].sort()).toEqual([...SHUFFLE_ORDER].sort());
  });

  it('produces an identical sequence on every round', () => {
    const sample = () => {
      const out: string[] = [];
      for (let t = 0; t < REVEAL_DELAY_MS; t += 15) out.push(shuffleMoveAt(t));
      return out.join(',');
    };
    const reference = sample();
    for (let round = 0; round < 200; round += 1) expect(sample()).toBe(reference);
  });

  it('holds each decoy long enough to read but short enough to churn', () => {
    // Fast enough to look like a shuffle, slow enough not to strobe.
    expect(SHUFFLE_STEP_MS).toBeGreaterThanOrEqual(60);
    expect(SHUFFLE_STEP_MS).toBeLessThanOrEqual(120);
  });

  it('does not use Math.random, keeping getBotChoice the only randomness', () => {
    expect(shuffleMoveAt.toString()).not.toContain('random');
  });
});
