import type { TargetAndTransition, Transition } from 'framer-motion';
import type { RoundOutcome } from '../types/game';
import type { ImpactLevel } from '../constants/gameConfig';
import type { RevealVariant } from './revealVariant';

/** Resting offset, as a share of each hand's own width. */
export const REST_X = 7;

export interface ChoreographyArgs {
  side: 'player' | 'bot';
  /** -1 for the left (player) hand, +1 for the right (bot) hand. */
  direction: number;
  outcome: RoundOutcome | null;
  ease: [number, number, number, number];
  motionScale: number;
  level: ImpactLevel;
  /** Build-up length in ms, which Fast mode shortens. */
  revealMs: number;
  beatSeconds: number;
  beats: number;
}

export interface Choreography {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  transition: Transition;
}

/**
 * THE ONE THING THAT MATTERS HERE: none of these functions receive the bot's
 * choice, and none of them can. They are given a side, a direction and a clock,
 * and every variant drives the bot's slot from the SAME `shuffleStateAt` — the
 * choreography changes how the hands move, never what the bot's slot shows or
 * when it shows it. So there is one leak-critical path across all three
 * variants, not three of them.
 *
 * The bot's landing is pinned to the end of the build-up in every variant. A
 * variant that made the bot arrive earlier or later depending on anything would
 * be a timing signal; none of them vary it at all.
 */
export function buildUpChoreography(
  variant: RevealVariant,
  args: ChoreographyArgs,
): Choreography {
  switch (variant) {
    case 'b':
      return windUp(args);
    case 'c':
      return lockIn(args);
    default:
      return standoff(args);
  }
}

/**
 * A — Standoff. The hands start well off screen and close the distance across
 * the beats. Tension is proximity: the gap is the clock.
 */
function standoff({ direction, revealMs, beatSeconds, beats }: ChoreographyArgs): Choreography {
  const rest = REST_X * direction;
  const enter = 190 * direction;
  const drift = (REST_X - 3) * direction;

  return {
    initial: { x: `${enter}%`, y: 0, rotate: 0, scale: 1 },
    animate: {
      x: [`${enter}%`, `${rest}%`, `${drift}%`],
      y: [0, -22, 0],
      rotate: [0, direction * -7, 0],
    },
    transition: {
      x: { duration: revealMs / 1000, times: [0, 0.72, 1], ease: [0.22, 0.61, 0.36, 1] as const },
      y: { duration: beatSeconds, repeat: beats - 1, ease: 'easeInOut' as const },
      rotate: { duration: beatSeconds, repeat: beats - 1, ease: 'easeInOut' as const },
    },
  };
}

/**
 * B — Wind-up. The hands begin close, then pull BACK and coil against the
 * beats, compressing until the snap throws them forward. Tension is stored
 * energy: the further they retreat, the harder the release reads.
 */
function windUp({ direction, revealMs, beatSeconds, beats }: ChoreographyArgs): Choreography {
  const near = 14 * direction;
  // 40%, not the 74% this started at: at 74% both hands were almost entirely
  // off screen at the coil peak, which hides the bot's shuffle — the thing
  // actually carrying the tension — for most of the build-up. The retreat has
  // to be legible as a retreat while the hands stay on stage.
  const coil = 40 * direction;

  return {
    initial: { x: `${near}%`, y: 0, rotate: 0, scale: 1 },
    animate: {
      // Out to the coil, then a fraction further on the last beat — the hand is
      // still loading when the release comes, so nothing reads as a pause.
      x: [`${near}%`, `${coil}%`, `${coil * 1.08}%`],
      scale: [1, 0.88, 0.85],
      rotate: [0, direction * 11, direction * 15],
      y: [0, -12, 0],
    },
    transition: {
      x: { duration: revealMs / 1000, times: [0, 0.68, 1], ease: [0.34, 0.02, 0.3, 1] as const },
      scale: { duration: revealMs / 1000, times: [0, 0.68, 1], ease: 'easeOut' as const },
      rotate: { duration: revealMs / 1000, times: [0, 0.68, 1], ease: 'easeOut' as const },
      y: { duration: beatSeconds, repeat: beats - 1, ease: 'easeInOut' as const },
    },
  };
}

/**
 * C — Lock-in. The player's hand arrives and stops early; the bot's keeps
 * cycling and only lands at the snap. Tension is asymmetry: you are already
 * committed and can do nothing but watch the wheel slow.
 *
 * This is the variant most worth scrutinising for leaks, and it survives
 * scrutiny for a specific reason: the hand that settles early is the PLAYER's,
 * whose choice the player already made and already knows. Nothing about the
 * bot's timing changes — its slot runs the same shuffle over the same build-up
 * and lands at the same instant as in A and B.
 */
function lockIn({ side, direction, revealMs, beatSeconds, beats }: ChoreographyArgs): Choreography {
  const rest = REST_X * direction;
  const enter = 190 * direction;

  if (side === 'player') {
    // Arrives at 42% of the build-up and holds — the commitment is visibly
    // made and then irrevocable.
    return {
      initial: { x: `${enter}%`, y: 0, rotate: 0, scale: 1 },
      animate: {
        x: [`${enter}%`, `${rest}%`, `${rest}%`],
        y: [0, -18, 0, 0],
        rotate: [0, direction * -6, 0, 0],
        scale: [1, 1, 1.03, 1.03],
      },
      transition: {
        x: { duration: revealMs / 1000, times: [0, 0.42, 1], ease: [0.16, 0.8, 0.3, 1] as const },
        y: { duration: revealMs / 1000, times: [0, 0.2, 0.42, 1], ease: 'easeOut' as const },
        rotate: { duration: revealMs / 1000, times: [0, 0.2, 0.42, 1], ease: 'easeOut' as const },
        scale: { duration: revealMs / 1000, times: [0, 0.38, 0.5, 1], ease: 'easeOut' as const },
      },
    };
  }

  // The bot keeps working the whole build-up: it arrives late and is still
  // pumping when the snap lands.
  return {
    initial: { x: `${enter}%`, y: 0, rotate: 0, scale: 1 },
    animate: {
      x: [`${enter}%`, `${rest * 2.2}%`, `${rest}%`],
      y: [0, -24, 0],
      rotate: [0, direction * -9, 0],
    },
    transition: {
      x: { duration: revealMs / 1000, times: [0, 0.5, 1], ease: [0.3, 0.5, 0.2, 1] as const },
      y: { duration: beatSeconds, repeat: beats - 1, ease: 'easeInOut' as const },
      rotate: { duration: beatSeconds, repeat: beats - 1, ease: 'easeInOut' as const },
    },
  };
}

/**
 * Where each hand sits at the instant of contact, which is where the impact
 * animation has to start from or it will jump.
 */
export function contactOffset(variant: RevealVariant, direction: number): number {
  switch (variant) {
    case 'b':
      return 40 * 1.08 * direction; // still coiled; the impact throws it in
    case 'c':
      return REST_X * direction;
    default:
      return (REST_X - 3) * direction;
  }
}

/** Scale at contact, so the impact continues the build-up rather than resetting it. */
export function contactScale(variant: RevealVariant): number {
  return variant === 'b' ? 0.85 : 1;
}
