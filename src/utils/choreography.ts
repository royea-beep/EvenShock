import type { TargetAndTransition, Transition } from 'framer-motion';

/** Resting offset, as a share of each hand's own width. */
export const REST_X = 7;

export interface ChoreographyArgs {
  /** -1 for the left (player) hand, +1 for the right (bot) hand. */
  direction: number;
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
 * Share of the build-up spent retreating. Everything after it is the hold.
 * At the current 870ms build-up that is ~400ms of pull-back and ~470ms coiled.
 */
const COIL_AT = 0.46;

/** How much further the hand creeps while held, as a multiple of the coil. */
const COIL_CREEP = 1.08;

/**
 * Wind-up: the hands begin close, then pull BACK and coil against the beats,
 * compressing and holding until the snap throws them forward. Tension is stored
 * energy — the longer they stay loaded, the harder the release reads.
 *
 * THE ONE THING THAT MATTERS HERE: this function never receives the bot's
 * choice, and cannot. It is given a direction and a clock. The bot's slot is
 * driven entirely by `shuffleStateAt(elapsed)`, and its landing is pinned to the
 * end of the build-up regardless of outcome, so nothing about how the hands move
 * — or when they stop moving — is a function of what either hand is holding.
 *
 * Chosen over two alternatives that were built and measured side by side
 * (Standoff, where the gap closes across the beats; Lock-in, where the player's
 * hand settles early and the bot's keeps cycling). All three were leak-clean;
 * this one carried the tension best.
 */
export function buildUpChoreography({
  direction,
  revealMs,
  beatSeconds,
  beats,
}: ChoreographyArgs): Choreography {
  const near = 14 * direction;
  // 40%, not the 74% this started at: at 74% both hands were almost entirely
  // off screen at the coil peak, which hides the bot's shuffle — the thing
  // actually carrying the tension — for most of the build-up. The retreat has
  // to be legible as a retreat while the hands stay on stage.
  const coil = 40 * direction;

  return {
    initial: { x: `${near}%`, y: 0, rotate: 0, scale: 1 },
    animate: {
      // Out to the coil, then a slow creep further while it is held — the hand
      // is still loading right up to the release, so the hold never reads as a
      // stall or as the sequence having finished early.
      x: [`${near}%`, `${coil}%`, `${coil * COIL_CREEP}%`],
      scale: [1, 0.88, 0.84],
      rotate: [0, direction * 11, direction * 16],
      y: [0, -12, 0],
    },
    transition: {
      // COIL_AT, not the 0.68 this shipped at: the retreat now completes inside
      // the first beat and a half, leaving the rest of the build-up as held
      // tension rather than as continuous travel. The compression and rotation
      // ride the same timing so the whole hand keeps loading through the hold.
      x: { duration: revealMs / 1000, times: [0, COIL_AT, 1], ease: [0.34, 0.02, 0.3, 1] as const },
      scale: { duration: revealMs / 1000, times: [0, COIL_AT, 1], ease: 'easeOut' as const },
      rotate: { duration: revealMs / 1000, times: [0, COIL_AT, 1], ease: 'easeOut' as const },
      // The bob stays keyed to the beat, so it re-syncs on its own whenever the
      // beat length changes (Fast mode, or a pace retune).
      y: { duration: beatSeconds, repeat: beats - 1, ease: 'easeInOut' as const },
    },
  };
}

/**
 * Where each hand sits at the instant of contact, which is where the impact
 * animation has to start from or it will jump. Still fully coiled: the impact
 * is the throw, not a compression of an already-arrived hand.
 */
export function contactOffset(direction: number): number {
  return 40 * COIL_CREEP * direction;
}

/** Scale at contact, so the impact continues the build-up rather than resetting it. */
export const CONTACT_SCALE = 0.84;
