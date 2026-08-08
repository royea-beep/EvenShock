import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { Choice, RoundOutcome } from '../types/game';
import type { ImageSet } from '../assets/themes';
import { copy } from '../constants/copy';
import { SHAKE_BEATS, SHAKE_BEAT_MS, REVEAL_DELAY_MS, type ImpactLevel } from '../constants/gameConfig';
import { shuffleStateAt, type ShuffleState } from '../utils/shuffle';
import { readThemeMotion } from '../utils/themeTokens';
import { MoveArt } from './MoveArt';

const HAND_CLASSES: Record<Choice, string> = {
  rock: 'bg-rock text-rock-ink',
  paper: 'bg-paper text-paper-ink',
  scissors: 'bg-scissors text-scissors-ink',
};

const HAND_SIZE = 'clamp(6rem, 40vw, 24rem)';

/** Resting offsets, as a share of each hand's own width. */
const REST_X = 7;
/** Where each hand starts: comfortably past its own edge of the screen. */
const ENTER_X = 190;
/** Extra convergence during the build-up — the hands close the distance. */
const DRIFT_X = 3;

type Phase = 'revealing' | 'result';

interface HandsFaceOffProps {
  playerChoice: Choice;
  botChoice: Choice | null;
  phase: Phase;
  roundResult: RoundOutcome | null;
  roundKey: number;
  imageSet: ImageSet | null;
  level: ImpactLevel;
}

export function HandsFaceOff({
  playerChoice,
  botChoice,
  phase,
  roundResult,
  roundKey,
  imageSet,
  level,
}: HandsFaceOffProps) {
  return (
    <div className="relative z-10 flex w-full items-center justify-center overflow-x-clip py-2">
      <Hand
        side="player"
        choice={playerChoice}
        label={copy.game.youLabel}
        phase={phase}
        roundKey={roundKey}
        outcome={roundResult}
        imageSet={imageSet}
        level={level}
      />

      <span className="display-type z-10 px-1 text-lg font-black text-muted sm:px-3 sm:text-2xl">
        VS
      </span>

      <Hand
        side="bot"
        choice={botChoice}
        label={copy.game.opponentLabel}
        phase={phase}
        roundKey={roundKey}
        outcome={roundResult}
        imageSet={imageSet}
        level={level}
      />
    </div>
  );
}

interface HandProps {
  side: 'player' | 'bot';
  choice: Choice | null;
  label: string;
  phase: Phase;
  roundKey: number;
  outcome: RoundOutcome | null;
  imageSet: ImageSet | null;
  level: ImpactLevel;
}

function Hand({ side, choice, label, phase, roundKey, outcome, imageSet, level }: HandProps) {
  const reducedMotion = useReducedMotion();
  const { ease, scale: motionScale } = readThemeMotion();

  const shuffling = side === 'bot' && phase === 'revealing' && !reducedMotion;
  const shuffle = useShuffle(shuffling, roundKey);

  const shown = side === 'bot' && phase === 'revealing' ? (shuffle?.move ?? null) : choice;
  const unsettled = shuffling && shuffle !== null;

  const direction = side === 'player' ? -1 : 1;
  const animation = handAnimation({ side, phase, outcome, reducedMotion, direction, ease, motionScale, level });

  return (
    <div className="relative flex flex-col items-center gap-3">
      <motion.div
        key={`${roundKey}-${phase}`}
        initial={animation.initial}
        animate={animation.animate}
        transition={animation.transition}
        style={{
          width: HAND_SIZE,
          height: HAND_SIZE,
          borderRadius: 'var(--radius-choice)',
          boxShadow: 'var(--shadow-choice), var(--glow-choice)',
          borderWidth: 'var(--border-width)',
          borderColor: 'var(--border-color)',
          borderStyle: 'var(--border-style)',
          willChange: 'transform',
        }}
        className={`relative flex items-center justify-center overflow-hidden ${
          shown ? HAND_CLASSES[shown] : 'bg-elevated text-ink'
        }`}
      >
        {shown ? (
          <>
            <div
              // The blur is the "still cycling" signal and is never 0 during the
              // build-up. A settled hand is crisp; a shuffling one never is, so
              // the near-miss cannot be mistaken for the answer having landed.
              style={{
                filter: unsettled ? `blur(${shuffle.blurPx}px)` : undefined,
                opacity: unsettled ? 0.88 : 1,
                willChange: unsettled ? 'filter' : undefined,
              }}
              className="h-full w-full"
            >
              <MoveArt
                choice={shown}
                imageSet={imageSet}
                size="full"
                decorative={side === 'bot' && phase === 'revealing'}
                iconClassName="h-1/2 w-1/2"
              />
            </div>

            {/* A standing "unknown" chip for the whole build-up. Together with
                the blur it makes "still shuffling" and "settled" two visibly
                different states, so a player reading the near-miss as final
                would have to ignore both. */}
            {unsettled && (
              <span
                aria-hidden="true"
                style={{ borderRadius: 'var(--radius-sm)' }}
                className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center bg-elevated/90 text-base font-black text-ink"
              >
                ?
              </span>
            )}
          </>
        ) : (
          <span className="display-type text-4xl font-black sm:text-6xl" aria-hidden="true">
            ?
          </span>
        )}
      </motion.div>

      <span className="display-type relative z-20 text-xs font-semibold text-muted sm:text-sm">
        {label}
      </span>
    </div>
  );
}

interface AnimationArgs {
  side: 'player' | 'bot';
  phase: Phase;
  outcome: RoundOutcome | null;
  reducedMotion: boolean | null;
  direction: number;
  ease: [number, number, number, number];
  motionScale: number;
  level: ImpactLevel;
}

/**
 * Every value below is a transform or an opacity, so the whole sequence stays
 * on the compositor: two large photographs are being moved every frame.
 */
function handAnimation({
  side,
  phase,
  outcome,
  reducedMotion,
  direction,
  ease,
  motionScale,
  level,
}: AnimationArgs) {
  const rest = REST_X * direction;

  if (reducedMotion) {
    return {
      initial: { opacity: 0, x: `${rest}%` },
      animate: { opacity: 1, x: `${rest}%` },
      transition: { duration: 0.25 },
    };
  }

  if (phase === 'revealing') {
    const beatSeconds = (SHAKE_BEAT_MS / 1000) * motionScale;
    return {
      initial: { x: `${ENTER_X * direction}%`, y: 0, rotate: 0, scale: 1 },
      animate: {
        // The approach runs across the same beats as the pump, so it costs
        // nothing on the clock, and closes an extra DRIFT_X at the end — the
        // hands are still moving toward each other when the snap lands.
        x: [`${ENTER_X * direction}%`, `${rest}%`, `${(REST_X - DRIFT_X) * direction}%`],
        y: [0, -22, 0],
        rotate: [0, direction * -7, 0],
      },
      transition: {
        x: {
          duration: REVEAL_DELAY_MS / 1000,
          times: [0, 0.72, 1],
          ease: [0.22, 0.61, 0.36, 1] as const,
        },
        y: { duration: beatSeconds, repeat: SHAKE_BEATS - 1, ease: 'easeInOut' as const },
        rotate: { duration: beatSeconds, repeat: SHAKE_BEATS - 1, ease: 'easeInOut' as const },
      },
    };
  }

  const won = outcome === (side === 'player' ? 'win' : 'lose');
  const lost = outcome === (side === 'player' ? 'lose' : 'win');
  const contact = (REST_X - DRIFT_X) * direction;

  // A tie is neither: both bounce off the same distance, so "no winner" has its
  // own shape rather than being a weak version of one.
  const settle =
    outcome === 'tie' ? rest * 2.4
    : won ? contact * 0.05
    : lost ? contact * 3.4
    : rest;

  const endScale = won ? 1.12 : lost ? 0.84 : 0.95;
  // The loser is knocked off-axis; the winner stays square to the camera.
  const endRotate = lost ? direction * 9 : 0;
  const endOpacity = lost ? 0.72 : 1;

  // Slow motion lives here: the same impact, played longer. Deciding rounds
  // stretch it; fast mode compresses it.
  const impactSeconds =
    (level === 'deciding' ? 0.62 : level === 'fast' ? 0.26 : 0.42) * motionScale;

  return {
    initial: { x: `${contact}%`, y: 0, rotate: 0, scale: 1, opacity: 1 },
    animate: {
      x: [`${contact}%`, `${contact}%`, `${settle}%`],
      scale: [1, 0.9, endScale],
      rotate: [0, 0, endRotate],
      opacity: [1, 1, endOpacity],
      y: 0,
    },
    transition: {
      duration: impactSeconds,
      times: [0, level === 'deciding' ? 0.34 : 0.28, 1],
      ease,
    },
  };
}

/**
 * Drives the bot's decoy cycle from elapsed time alone.
 *
 * `shuffleStateAt` is never given the bot's real choice — it cannot be, because
 * `useGame` has not resolved one yet while this is running. The cycle, its
 * deceleration and its blur are therefore identical on every round regardless
 * of outcome, and all three images are already warm from `useThemeImages`, so
 * no move's frame costs a fetch or a decode that the others don't.
 *
 * Sampled on every animation frame rather than on an interval: the steps are no
 * longer evenly spaced, so a fixed interval would quantise the deceleration
 * back out of existence.
 */
function useShuffle(active: boolean, roundKey: number): ShuffleState | null {
  const [state, setState] = useState<ShuffleState | null>(null);

  useEffect(() => {
    if (!active) {
      setState(null);
      return;
    }

    const started = performance.now();
    let raf = 0;
    let lastStepMove: Choice | null = null;

    const frame = (now: number) => {
      const next = shuffleStateAt(now - started);
      // Re-render only when the move changes; the blur rides the same update,
      // which keeps this to ~7 renders across the whole build-up.
      if (next.move !== lastStepMove) {
        lastStepMove = next.move;
        setState(next);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => cancelAnimationFrame(raf);
  }, [active, roundKey]);

  return state;
}
