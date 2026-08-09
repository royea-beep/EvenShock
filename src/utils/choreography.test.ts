import { describe, expect, it } from 'vitest';
import { buildUpChoreography, contactOffset, CONTACT_SCALE, REST_X } from './choreography';

const args = (direction: number) => ({
  direction,
  revealMs: 870,
  beatSeconds: 0.29,
  beats: 3,
});

const nums = (v: unknown) => (v as string[]).map((s) => parseFloat(s));

describe('wind-up build-up', () => {
  it('coils away from the centre, not toward it', () => {
    // The bot's hand sits to the right (direction +1), so a retreat is a larger
    // positive offset. A sign flip here would turn the wind-up into a charge.
    const [near, coil, held] = nums(buildUpChoreography(args(1)).animate.x);
    expect(coil).toBeGreaterThan(near);
    expect(held).toBeGreaterThan(coil);

    const mirrored = nums(buildUpChoreography(args(-1)).animate.x);
    expect(mirrored).toEqual([-near, -coil, -held]);
  });

  it('keeps the coil at 40% so the shuffling hand stays on stage', () => {
    // At 74% both hands were almost entirely off screen at the coil peak, which
    // hid the bot's shuffle — the thing actually carrying the tension. This is
    // the number that fix produced; it is not free to drift.
    const [, coil] = nums(buildUpChoreography(args(1)).animate.x);
    expect(coil).toBe(40);
  });

  it('spends more of the build-up held than retreating', () => {
    // The whole point of the retune: the coil is reached early and held. If the
    // pull-back ever occupies the majority again, the tension is back to being
    // travel rather than stored energy.
    const t = buildUpChoreography(args(1)).transition as {
      x: { times: number[]; duration: number };
    };
    const [, coilAt] = t.x.times;
    expect(coilAt).toBeLessThan(0.5);
    expect(870 * (1 - coilAt)).toBeGreaterThan(400);
  });

  it('runs the coil over the whole build-up and the bob over the beats', () => {
    const t = buildUpChoreography(args(1)).transition as {
      x: { duration: number };
      y: { duration: number; repeat: number };
    };
    expect(t.x.duration).toBe(0.87);
    // 3 beats of 290ms == the 870ms build-up, so the bob neither truncates nor
    // outlives the retreat when the pace changes.
    expect(t.y.duration * (t.y.repeat + 1)).toBeCloseTo(t.x.duration, 5);
  });

  it('keeps loading through the hold rather than freezing', () => {
    // A hand that stops dead reads as the sequence having already finished.
    // Every channel keeps moving into the third keyframe.
    const a = buildUpChoreography(args(1)).animate;
    const scale = a.scale as number[];
    const rotate = a.rotate as number[];
    expect(scale[2]).toBeLessThan(scale[1]);
    expect(Math.abs(rotate[2])).toBeGreaterThan(Math.abs(rotate[1]));
  });
});

describe('hand-off to the impact', () => {
  it('starts the impact exactly where the build-up left the hand', () => {
    // Any mismatch is a visible jump on the single most-watched frame.
    const { animate } = buildUpChoreography(args(1));
    const held = nums(animate.x).at(-1);
    expect(contactOffset(1)).toBeCloseTo(held!, 5);
    expect(CONTACT_SCALE).toBe((animate.scale as number[]).at(-1));
  });

  it('leaves the hand well behind its resting position at contact', () => {
    // Which is what makes the throw a throw: the impact has real distance to
    // cover rather than nudging an already-arrived hand.
    expect(contactOffset(1)).toBeGreaterThan(REST_X * 4);
  });
});
