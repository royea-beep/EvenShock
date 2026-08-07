import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { Choice, RoundOutcome } from '../types/game';
import type { ImageSet } from '../assets/themes';
import { copy } from '../constants/copy';
import { SHAKE_BEATS, SHAKE_BEAT_MS, REVEAL_DELAY_MS } from '../constants/gameConfig';
import { SHUFFLE_STEP_MS, shuffleMoveAt } from '../utils/shuffle';
import { readThemeMotion } from '../utils/themeTokens';
import { MoveArt } from './MoveArt';

const HAND_CLASSES: Record<Choice, string> = {
  rock: 'bg-rock text-rock-ink',
  paper: 'bg-paper text-paper-ink',
  scissors: 'bg-scissors text-scissors-ink',
};

/**
 * Hand size, viewport-relative so the reveal fills whatever screen it is on.
 * The upper bound keeps a 1900px desktop from turning them into billboards;
 * the 40vw middle term is set by the narrowest phone we support — two hands
 * plus the VS gutter has to fit 320px without the approach ever pushing a
 * scrollbar.
 */
const HAND_SIZE = 'clamp(6rem, 40vw, 24rem)';

/** Resting offsets, as a share of each hand's own width. */
const REST_X = 7;
/** Where each hand starts: comfortably past its own edge of the screen. */
const ENTER_X = 190;

type Phase = 'revealing' | 'result';

interface HandsFaceOffProps {
  playerChoice: Choice;
  /** null while the build-up runs — the bot's pick does not exist yet. */
  botChoice: Choice | null;
  phase: Phase;
  roundResult: RoundOutcome | null;
  roundKey: number;
  imageSet: ImageSet | null;
}

export function HandsFaceOff({
  playerChoice,
  botChoice,
  phase,
  roundResult,
  roundKey,
  imageSet,
}: HandsFaceOffProps) {
  return (
    // overflow-x is clipped HERE and nowhere wider, so the hands can start off
    // screen without ever creating a scrollbar — and a genuine overflow bug
    // anywhere else on the page still shows up in document.scrollWidth.
    <div className="relative z-10 flex w-full items-center justify-center overflow-x-clip py-2">
      <Hand
        side="player"
        choice={playerChoice}
        label={copy.game.youLabel}
        phase={phase}
        roundKey={roundKey}
        outcome={roundResult}
        imageSet={imageSet}
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
}

function Hand({ side, choice, label, phase, roundKey, outcome, imageSet }: HandProps) {
  const reducedMotion = useReducedMotion();
  const { ease, scale: motionScale } = readThemeMotion();

  // The decoy cycle. Only the bot shuffles, only during the build-up, and never
  // under reduced motion — where the whole point is that nothing churns.
  const shuffling = side === 'bot' && phase === 'revealing' && !reducedMotion;
  const decoy = useShuffleMove(shuffling, roundKey);

  // What this slot actually renders. For the bot during the build-up this is a
  // decoy chosen purely by elapsed time; `choice` is still null at that point.
  const shown = side === 'bot' && phase === 'revealing' ? decoy : choice;

  const direction = side === 'player' ? -1 : 1;
  const animation = handAnimation({
    side,
    phase,
    outcome,
    reducedMotion,
    direction,
    ease,
    motionScale,
  });

  return (
    // gap-3, not gap-2: the winner scales to 1.1, and a transform does not
    // affect layout, so the hand grows over its own caption unless the gap
    // clears the overshoot.
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
        className={`flex items-center justify-center overflow-hidden ${
          shown ? HAND_CLASSES[shown] : 'bg-elevated text-ink'
        }`}
      >
        {shown ? (
          <MoveArt
            choice={shown}
            imageSet={imageSet}
            size="full"
            // The decoy is scenery, not information: it must not be announced,
            // or a screen reader would hear three moves that never happened.
            decorative={side === 'bot' && phase === 'revealing'}
            iconClassName="h-1/2 w-1/2"
          />
        ) : (
          // Reduced motion, or the instant before the first decoy paints.
          <span className="display-type text-4xl font-black sm:text-6xl" aria-hidden="true">
            ?
          </span>
        )}
      </motion.div>

      {/* `relative` is load-bearing: z-index is ignored on statically
          positioned elements, so without it the scaled hand paints over this. */}
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
  /** Cubic-bezier control points; must stay a 4-tuple for Framer Motion. */
  ease: [number, number, number, number];
  motionScale: number;
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
}: AnimationArgs) {
  const rest = REST_X * direction;

  if (reducedMotion) {
    // No approach, no pump, no recoil — just a clean fade into place. The
    // outcome stays fully readable because it never depended on the motion.
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
        // The approach IS the build-up: it runs across the same three beats
        // rather than being staged before them, so nothing is added to the
        // clock. The hands arrive exactly as "Shoot!" lands.
        x: `${rest}%`,
        y: [0, -22, 0],
        rotate: [0, direction * -7, 0],
      },
      transition: {
        x: { duration: REVEAL_DELAY_MS / 1000, ease: [0.22, 0.61, 0.36, 1] as const },
        y: { duration: beatSeconds, repeat: SHAKE_BEATS - 1, ease: 'easeInOut' as const },
        rotate: { duration: beatSeconds, repeat: SHAKE_BEATS - 1, ease: 'easeInOut' as const },
      },
    };
  }

  // Impact, then the outcome read spatially. The winner presses in toward the
  // loser; the loser gives ground and shrinks. A tie pulls both back the same
  // distance, so "neither" is legible as its own shape.
  const won = outcome === (side === 'player' ? 'win' : 'lose');
  const lost = outcome === (side === 'player' ? 'lose' : 'win');

  const settle =
    outcome === 'tie' ? rest * 2.4
    : won ? rest * 0.1
    : lost ? rest * 2.8
    : rest;

  const endScale = won ? 1.1 : lost ? 0.88 : 0.95;

  return {
    // Arrive compressed, then settle: the squash reads as contact rather than
    // as a bounce, which would make the meeting feel loose.
    initial: { x: `${rest}%`, y: 0, rotate: 0, scale: 1 },
    animate: {
      x: [`${rest}%`, `${rest}%`, `${settle}%`],
      scale: [1, 0.93, endScale],
      y: 0,
      rotate: 0,
    },
    transition: {
      duration: 0.42 * motionScale,
      times: [0, 0.28, 1],
      ease,
    },
  };
}

/**
 * Drives the bot's decoy cycle from elapsed time alone.
 *
 * `shuffleMoveAt` is never given the bot's real choice — it cannot be, because
 * `useGame` has not resolved one yet while this is running. The sequence and
 * its timing are therefore identical on every round regardless of outcome, and
 * all three images are already warm from `useThemeImages`, so no move's frame
 * costs a fetch or a decode that the others don't.
 */
function useShuffleMove(active: boolean, roundKey: number): Choice | null {
  const [move, setMove] = useState<Choice | null>(null);

  useEffect(() => {
    if (!active) {
      setMove(null);
      return;
    }

    const started = performance.now();
    setMove(shuffleMoveAt(0));

    const id = window.setInterval(() => {
      setMove(shuffleMoveAt(performance.now() - started));
    }, SHUFFLE_STEP_MS);

    return () => window.clearInterval(id);
  }, [active, roundKey]);

  return move;
}
