import { describe, expect, it } from 'vitest';
import {
  SHUFFLE_ORDER,
  SHUFFLE_STEPS,
  setShuffleDuration,
  shuffleStateAt,
  stepIndexAt,
} from './shuffle';

const D = 660;
setShuffleDuration(D);

/**
 * These tests protect one property: the bot's decoy shuffle carries no
 * information about the bot's real choice. `scripts/leak-independence.mjs`
 * measures that statistically end-to-end; this file pins the structural reasons
 * it holds, so a regression fails here first and cheaply.
 */
describe('bot shuffle', () => {
  it('takes elapsed time as its only input', () => {
    // A second parameter is how a leak would most plausibly arrive — someone
    // "improving" the fake-out by aiming the near-miss at the real answer.
    expect(shuffleStateAt.length).toBe(1);
  });

  it('is deterministic: the same elapsed time always gives the same state', () => {
    for (const t of [0, 45, 90, 271, 500, 659]) {
      const first = JSON.stringify(shuffleStateAt(t));
      for (let i = 0; i < 30; i += 1) expect(JSON.stringify(shuffleStateAt(t))).toBe(first);
    }
  });

  it('produces an identical sequence on every round', () => {
    const sample = () => {
      const out: string[] = [];
      for (let t = 0; t < D; t += 5) out.push(shuffleStateAt(t).move);
      return out.join(',');
    };
    const reference = sample();
    for (let round = 0; round < 200; round += 1) expect(sample()).toBe(reference);
  });

  it('does not use Math.random, keeping getBotChoice the only randomness', () => {
    expect(shuffleStateAt.toString()).not.toContain('random');
    expect(stepIndexAt.toString()).not.toContain('random');
  });

  it('visits all three moves during a single build-up', () => {
    const seen = new Set<string>();
    for (let t = 0; t < D; t += 5) seen.add(shuffleStateAt(t).move);
    expect([...seen].sort()).toEqual([...SHUFFLE_ORDER].sort());
  });
});

describe('deceleration', () => {
  /** Duration of each step, derived from where the index changes. */
  function stepDurations(): number[] {
    const bounds: number[] = [];
    let current = stepIndexAt(0);
    for (let t = 0; t <= D; t += 1) {
      const idx = stepIndexAt(t);
      if (idx !== current) {
        bounds.push(t);
        current = idx;
      }
    }
    const edges = [0, ...bounds, D];
    return edges.slice(1).map((x, i) => x - edges[i]);
  }

  it('slows monotonically — every step is longer than the one before', () => {
    const steps = stepDurations();
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i], `step ${i} (${steps[i]}ms) is not longer than ${steps[i - 1]}ms`)
        .toBeGreaterThan(steps[i - 1]);
    }
  });

  it('ends on a near-miss long enough to read as a settle', () => {
    const steps = stepDurations();
    // Short enough not to feel like the answer already landed, long enough that
    // the flip registers as a flip.
    expect(steps[steps.length - 1]).toBeGreaterThan(110);
    expect(steps[steps.length - 1]).toBeLessThan(200);
  });

  it('starts fast enough to read as a blur, not a slideshow', () => {
    expect(stepDurations()[0]).toBeLessThan(45);
  });

  it('marks only the final step as settling', () => {
    expect(shuffleStateAt(D - 1).settling).toBe(true);
    expect(shuffleStateAt(D * 0.5).settling).toBe(false);
    expect(shuffleStateAt(0).settling).toBe(false);
  });

  it('never clears the blur during the build-up', () => {
    // The blur is what separates "still cycling" from "settled". If it ever
    // reached zero before the snap, the near-miss could read as the answer.
    for (let t = 0; t < D; t += 5) {
      expect(shuffleStateAt(t).blurPx, `blur cleared at ${t}ms`).toBeGreaterThan(0);
    }
  });

  it('reduces the blur as it slows, so the settle is felt as well as seen', () => {
    expect(shuffleStateAt(D - 1).blurPx).toBeLessThan(shuffleStateAt(0).blurPx);
  });

  it('compresses rather than reshapes at a faster pace', () => {
    setShuffleDuration(501);
    const fastEnd = stepIndexAt(500);
    setShuffleDuration(D);
    // Same number of steps at either pace: Fast mode shortens the build-up, it
    // does not skip decoys or change the shape of the deceleration.
    expect(fastEnd).toBe(SHUFFLE_STEPS - 1);
    expect(stepIndexAt(D - 1)).toBe(SHUFFLE_STEPS - 1);
  });
});
