import type { Choice } from '../types/game';

/** Fixed cycle order. Never reordered, never seeded, never shuffled. */
export const SHUFFLE_ORDER: Choice[] = ['rock', 'paper', 'scissors'];

/** How long each decoy move holds during the bot's shuffle. */
export const SHUFFLE_STEP_MS = 90;

/**
 * Which decoy move the bot's slot shows `elapsed` ms into the build-up.
 *
 * This is the whole safety argument for the shuffle, so it is written as a
 * function of ONE argument on purpose:
 *
 *  - It is a pure function of elapsed time. It cannot depend on the bot's
 *    actual choice because it is never given it.
 *  - It is deterministic — no Math.random(). `getBotChoice` remains the only
 *    source of randomness in the app, which is what makes the multiplayer seam
 *    a single swap.
 *  - The sequence, its timing, and the assets it touches are therefore
 *    byte-identical on every round, whatever the bot went on to pick.
 *
 * The structural guarantee sits underneath it: `useGame` does not resolve the
 * opponent's choice until the reveal timer fires, so during the build-up the
 * component rendering this shuffle holds `botChoice === null`. It cannot leak
 * what it has not been given.
 */
export function shuffleMoveAt(elapsedMs: number): Choice {
  const step = Math.max(0, Math.floor(elapsedMs / SHUFFLE_STEP_MS));
  return SHUFFLE_ORDER[step % SHUFFLE_ORDER.length];
}
