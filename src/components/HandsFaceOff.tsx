import { motion, useReducedMotion } from 'framer-motion';
import type { Choice, RoundOutcome } from '../types/game';
import type { ImageSet } from '../assets/themes';
import { copy } from '../constants/copy';
import { SHAKE_BEATS, SHAKE_BEAT_MS } from '../constants/gameConfig';
import { readThemeMotion } from '../utils/themeTokens';
import { MoveArt } from './MoveArt';

const HAND_CLASSES: Record<Choice, string> = {
  rock: 'bg-rock text-rock-ink',
  paper: 'bg-paper text-paper-ink',
  scissors: 'bg-scissors text-scissors-ink',
};

type Phase = 'revealing' | 'result';

interface HandsFaceOffProps {
  playerChoice: Choice;
  /** null while the build-up is still running — the bot's pick doesn't exist yet. */
  botChoice: Choice | null;
  phase: Phase;
  roundResult: RoundOutcome | null;
  /** Bumped each round so the snap animation re-fires on every reveal. */
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
    <div className="flex items-center justify-center gap-4 sm:gap-16">
      <Hand
        choice={playerChoice}
        label={copy.game.youLabel}
        phase={phase}
        roundKey={roundKey}
        won={roundResult === 'win'}
        mirrored={false}
        imageSet={imageSet}
      />
      <span className="display-type text-2xl font-black text-muted">VS</span>
      <Hand
        choice={botChoice}
        label={copy.game.opponentLabel}
        phase={phase}
        roundKey={roundKey}
        won={roundResult === 'lose'}
        mirrored
        imageSet={imageSet}
      />
    </div>
  );
}

interface HandProps {
  choice: Choice | null;
  label: string;
  phase: Phase;
  roundKey: number;
  won: boolean;
  mirrored: boolean;
  imageSet: ImageSet | null;
}

function Hand({ choice, label, phase, roundKey, won, mirrored, imageSet }: HandProps) {
  const reducedMotion = useReducedMotion();

  // Easing and pacing are part of each theme's identity.
  const { ease, scale: motionScale } = readThemeMotion();
  const beatSeconds = (SHAKE_BEAT_MS / 1000) * motionScale;

  // Every animated property below is transform or opacity only, so the whole
  // reveal stays on the compositor even though the hands are now bitmaps.
  const animation = reducedMotion
    ? { animate: { opacity: 1 }, transition: { duration: 0.25 } }
    : phase === 'revealing'
      ? {
          animate: { y: [0, -18, 0], rotate: [0, mirrored ? 6 : -6, 0] },
          transition: {
            duration: beatSeconds,
            repeat: SHAKE_BEATS - 1,
            ease: 'easeInOut' as const,
          },
        }
      : {
          animate: { y: 0, rotate: 0, scale: won ? [1, 1.35, 1.12] : [1, 1.28, 1] },
          transition: { duration: 0.34 * motionScale, ease, times: [0, 0.45, 1] },
        };

  return (
    <div className="flex flex-col items-center gap-3">
      <motion.div
        key={`${roundKey}-${phase}`}
        initial={reducedMotion ? { opacity: 0 } : false}
        {...animation}
        style={{
          borderRadius: 'var(--radius-choice)',
          boxShadow: 'var(--shadow-choice), var(--glow-choice)',
          borderWidth: 'var(--border-width)',
          borderColor: 'var(--border-color)',
          borderStyle: 'var(--border-style)',
          willChange: 'transform',
        }}
        className={`flex h-24 w-24 items-center justify-center overflow-hidden sm:h-28 sm:w-28 ${
          choice ? HAND_CLASSES[choice] : 'bg-elevated text-ink'
        }`}
      >
        {choice ? (
          <MoveArt
            choice={choice}
            imageSet={imageSet}
            size="full"
            iconClassName="h-12 w-12 sm:h-14 sm:w-14"
          />
        ) : (
          // The bot's pick does not exist client-side yet, so there is nothing
          // here that could reveal it — no image element, no request.
          <span className="display-type text-3xl font-black" aria-hidden="true">
            ?
          </span>
        )}
      </motion.div>
      <span className="display-type text-sm font-semibold text-muted">{label}</span>
    </div>
  );
}
