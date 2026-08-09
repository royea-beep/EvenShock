/** Number of pumps before the reveal snap. Beat 4 is the snap itself ("Shoot!"). */
export const SHAKE_BEATS = 3;

/**
 * 290ms, up from 220ms. The wind-up needs the room: at 660ms the hand reached
 * its coil and was thrown almost immediately, so the retreat read as travel
 * rather than as loading. 870ms splits into ~400ms of pull-back and ~470ms
 * coiled, which is where the tension actually lives.
 *
 * Fast mode is deliberately NOT scaled with it. It stays at the old brisk beat
 * and is now the larger saving — which is the point: it is the escape hatch for
 * players who don't want the ceremony, and if most of them take it, the normal
 * pace is too long and this number should come back down.
 */
const BEAT_NORMAL_MS = 290;
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
 *   routine   870 + 280 = 1150ms
 *   deciding  870 + 480 = 1350ms
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
 *
 * Trimmed from 250 to 200 because the "outcome → advance clickable" gap ran
 * ~30ms past the 500-700ms target on deciding rounds and ~30ms past on routine
 * (830ms and 730ms respectively). 200ms keeps the double-tap guard intact — a
 * genuine second tap on the same intended target on a phone lands ~180-220ms
 * after the first — while pulling both the routine (480ms) and deciding
 * (680ms) cases inside the target range.
 */
export const ADVANCE_FADE_MS = 200;
