/** Duration of one "Rock... / Paper... / Scissors..." pump of the hands. */
export const SHAKE_BEAT_MS = 220;

/** Number of pumps before the reveal snap. Beat 4 is the snap itself ("Shoot!"). */
export const SHAKE_BEATS = 3;

/**
 * How long the shake/reveal build-up runs before the opponent's choice and the
 * round outcome are resolved. Derived from the beat timing so the visual snap
 * lands exactly when the data arrives — never before it, so the bot's choice
 * can't be read early.
 */
export const REVEAL_DELAY_MS = SHAKE_BEATS * SHAKE_BEAT_MS;

/**
 * How long the advance button fades in, and stays inert, after the outcome
 * appears. Measured: outcome and button previously landed in the same frame,
 * so a fast second tap could dismiss a result before it had been read. Short
 * enough not to slow anyone down — the player still sets the pace, since
 * nothing auto-advances.
 */
export const ADVANCE_FADE_MS = 250;
