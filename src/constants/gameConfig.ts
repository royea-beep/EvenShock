/** Number of pumps before the reveal snap. Beat 4 is the snap itself ("Shoot!"). */
export const SHAKE_BEATS = 3;

const BEAT_NORMAL_MS = 220;
const BEAT_FAST_MS = 167;

/**
 * Duration of one "Rock... / Paper... / Scissors..." pump, and the build-up it
 * adds up to.
 *
 * These are `let`, not `const`, because Fast mode has to shorten the build-up
 * and `useGame` reads REVEAL_DELAY_MS directly — it is a protected file and
 * cannot grow an option for this. ES modules export live bindings, so
 * reassigning here is seen by every importer at read time. `setPace` is called
 * once from the Fast-mode hook; nothing else may write these.
 *
 * A pace change never disturbs a round already in flight: useGame captures the
 * value when it schedules its timer.
 */
export let SHAKE_BEAT_MS: number = BEAT_NORMAL_MS;

/**
 * How long the build-up runs before the opponent's choice and the round outcome
 * are resolved. Derived from the beat timing so the visual snap lands exactly
 * when the data arrives — never before it, so the bot's choice can't be read
 * early.
 */
export let REVEAL_DELAY_MS: number = SHAKE_BEATS * BEAT_NORMAL_MS;

export function setPace(fast: boolean): void {
  SHAKE_BEAT_MS = fast ? BEAT_FAST_MS : BEAT_NORMAL_MS;
  REVEAL_DELAY_MS = SHAKE_BEATS * SHAKE_BEAT_MS;
}

/** How long "Shoot!" holds on the snap before the outcome takes over. */
export const SHOOT_HOLD_MS = 180;

/**
 * How long the impact plays before the outcome line replaces it. This is the
 * only place the sequence budget is spent, and it is spent unevenly on purpose.
 *
 *   fast      501 + 200 =  701ms
 *   routine   660 + 280 =  940ms
 *   deciding  660 + 480 = 1140ms
 *
 * The peak is reserved for the round that ends the match. A slow-motion beat
 * and a screen flash on every single round is the thing most likely to grate by
 * the twentieth view; roughly one round in three keeps the peaks as peaks.
 */
export const IMPACT_HOLD_MS = {
  fast: 200,
  routine: 280,
  deciding: 480,
} as const;

export type ImpactLevel = keyof typeof IMPACT_HOLD_MS;

/**
 * How long the advance button fades in, and stays inert, after the outcome
 * appears, so a fast second tap can't dismiss a result before it is read.
 */
export const ADVANCE_FADE_MS = 250;
