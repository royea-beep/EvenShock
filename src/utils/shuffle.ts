import type { Choice } from '../types/game';

/** Fixed cycle order. Never reordered, never seeded, never shuffled. */
export const SHUFFLE_ORDER: Choice[] = ['rock', 'paper', 'scissors'];

/** How many decoys the build-up shows before the snap. */
export const SHUFFLE_STEPS = 7;

/**
 * Deceleration exponent. Step boundaries are `duration * (i / STEPS) ** EASE`,
 * so with EASE > 1 the early steps are short and the late ones long: the cycle
 * visibly slows and appears to settle, instead of running flat into the snap.
 *
 * At a 660ms build-up that gives steps of roughly
 * 29 / 60 / 81 / 100 / 115 / 131 / 144 ms.
 */
const EASE = 1.6;

/**
 * Blur on the bot's slot, in px, quantised to three levels rather than ramped
 * continuously — three filter changes across the build-up instead of seven.
 *
 * A note on why, because the obvious inference is wrong: this was first changed
 * on the theory that `filter: blur()` was causing the long frames measured
 * during the build-up. It is not. An A/B over ten rounds at 4x CPU throttle,
 * with the filter neutralised by injected CSS, came out statistically
 * identical — 11 long frames with, 10 without; max 114ms with, 118ms without.
 * The tail is the large-image compositing at the snap and the headless
 * environment, not this.
 *
 * The quantised form is kept anyway because it is cheaper for free and 2.6px
 * says "not settled" as clearly as 5px did at this size. It is NOT a
 * performance fix, and removing it will not buy back frames.
 */
const BLUR_LEVELS = [2.6, 1.5, 0.7];

export interface ShuffleState {
  /** The decoy to show. NEVER the bot's real choice — see below. */
  move: Choice;
  /**
   * Motion blur, in px. Deliberately never reaches 0 during the build-up: it
   * is the signal that the slot is still cycling. Only the snap clears it.
   */
  blurPx: number;
  /** True on the final, longest step — the near-miss the flip lands against. */
  settling: boolean;
}

/**
 * Where the cycle stands `elapsed` ms into the build-up.
 *
 * This is the whole safety argument for the shuffle, so it is written as a
 * function of ONE argument on purpose:
 *
 *  - It is a pure function of elapsed time. It cannot depend on the bot's
 *    actual choice because it is never given it.
 *  - It is deterministic — no Math.random(). `getBotChoice` remains the only
 *    source of randomness in the app, which is what makes the multiplayer seam
 *    a single swap.
 *  - The sequence, its timing, its blur curve and the assets it touches are
 *    therefore byte-identical on every round, whatever the bot went on to pick.
 *
 * The structural guarantee sits underneath it: `useGame` does not resolve the
 * opponent's choice until the reveal timer fires, so during the build-up the
 * component rendering this holds `botChoice === null`. It cannot leak what it
 * has not been given.
 *
 * A CONSEQUENCE WORTH KNOWING: with one argument the near-miss is the same move
 * every round (step 7 of a 3-move cycle — always `rock`). Varying it would mean
 * admitting a second input to the one function whose entire safety argument is
 * that it has exactly one, so it stays fixed. It carries zero information by
 * construction, and the flip animation plays identically whether or not the
 * image actually changes — so "no visible change" never signals a rock either.
 */
export function shuffleStateAt(elapsedMs: number): ShuffleState {
  const step = stepIndexAt(elapsedMs);
  const progress = Math.min(1, Math.max(0, step / (SHUFFLE_STEPS - 1)));

  const level = Math.min(BLUR_LEVELS.length - 1, Math.floor(progress * BLUR_LEVELS.length));

  return {
    move: SHUFFLE_ORDER[step % SHUFFLE_ORDER.length],
    blurPx: BLUR_LEVELS[level],
    settling: step >= SHUFFLE_STEPS - 1,
  };
}

/** Which step the cycle is on. Exported for the boundary tests. */
export function stepIndexAt(elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  // Invert `t = D * (i / N) ** EASE`. Expressed against a normalised build-up
  // so the curve is identical at any pace — Fast mode compresses it, it does
  // not reshape it.
  const fraction = Math.min(1, elapsedMs / normalisedDuration());
  const step = Math.floor(SHUFFLE_STEPS * Math.pow(fraction, 1 / EASE));
  return Math.min(step, SHUFFLE_STEPS - 1);
}

/**
 * The build-up length the curve is expressed against. Read lazily from
 * gameConfig so Fast mode's shorter build-up compresses the same curve.
 */
let durationOverride: number | null = null;
export function setShuffleDuration(ms: number): void {
  durationOverride = ms;
}
function normalisedDuration(): number {
  return durationOverride ?? 660;
}
