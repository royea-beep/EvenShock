import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { Choice, MatchFormat, MatchStatus, RoundOutcome, Score } from '../../types/game';
import { copy } from '../../constants/copy';
import { ADVANCE_FADE_MS, SHAKE_BEATS, SHAKE_BEAT_MS } from '../../constants/gameConfig';
import { ChoiceButton } from '../ChoiceButton';
import { HandsFaceOff } from '../HandsFaceOff';
import { MatchStatusBar, OUTCOME_MARK } from '../MatchStatusBar';
import { play } from '../../utils/sound';
import type { RoundEntry } from '../../utils/roundHistory';
import type { ImageSet } from '../../assets/themes';

const CHOICES: Choice[] = ['rock', 'paper', 'scissors'];

/** How long "Shoot!" holds on the snap before the outcome takes over. */
const SHOOT_HOLD_MS = 180;

const FLASH_CLASSES: Record<RoundOutcome, string> = {
  win: 'bg-win',
  lose: 'bg-lose',
  tie: 'bg-tie',
};

const OUTCOME_TEXT_CLASSES: Record<RoundOutcome, string> = {
  win: 'text-win',
  lose: 'text-lose',
  tie: 'text-tie',
};

const OUTCOME_SOUND: Record<RoundOutcome, 'roundWin' | 'roundLose' | 'roundTie'> = {
  win: 'roundWin',
  lose: 'roundLose',
  tie: 'roundTie',
};

interface RoundScreenProps {
  playerChoice: Choice | null;
  botChoice: Choice | null;
  roundResult: RoundOutcome | null;
  score: Score;
  matchStatus: MatchStatus;
  roundNumber: number;
  format: MatchFormat;
  history: RoundEntry[];
  imageSet: ImageSet | null;
  onPick: (choice: Choice) => void;
  onContinue: () => void;
}

export function RoundScreen({
  playerChoice,
  botChoice,
  roundResult,
  score,
  matchStatus,
  roundNumber,
  format,
  history,
  imageSet,
  onPick,
  onContinue,
}: RoundScreenProps) {
  const reducedMotion = useReducedMotion();

  const phase: 'picking' | 'revealing' | 'result' = !playerChoice
    ? 'picking'
    : botChoice && roundResult
      ? 'result'
      : 'revealing';

  const beatIndex = useShakeBeats(phase === 'revealing', roundNumber);

  // The 4th beat: "Shoot!" lands with the snap, then gives way to the outcome.
  //
  // useLayoutEffect, not useEffect: the frame in which `phase` first becomes
  // 'result' renders with showShoot still false, so a passive effect let the
  // outcome line paint for one frame BEFORE "Shoot!" — the result spoiling
  // itself a beat early. A layout effect flips it before paint, so that frame
  // never reaches the screen.
  const [showShoot, setShowShoot] = useState(false);
  useLayoutEffect(() => {
    if (phase !== 'result') {
      setShowShoot(false);
      return;
    }
    setShowShoot(true);
    const id = window.setTimeout(() => setShowShoot(false), SHOOT_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [phase, roundNumber]);

  // The advance button fades in and stays inert for a beat after the outcome.
  // Both landed in the same frame before, so a quick second tap could dismiss
  // a result before it had been read.
  const [advanceReady, setAdvanceReady] = useState(false);
  useEffect(() => {
    if (phase !== 'result') {
      setAdvanceReady(false);
      return;
    }
    const id = window.setTimeout(() => setAdvanceReady(true), SHOOT_HOLD_MS + ADVANCE_FADE_MS);
    return () => window.clearTimeout(id);
  }, [phase, roundNumber]);

  // Impact + outcome sounds, once per reveal.
  const soundedRound = useRef<number | null>(null);
  useEffect(() => {
    if (phase !== 'result' || !roundResult) return;
    if (soundedRound.current === roundNumber) return;
    soundedRound.current = roundNumber;
    play('reveal');
    window.setTimeout(() => play(OUTCOME_SOUND[roundResult]), 160);
  }, [phase, roundResult, roundNumber]);

  if (phase === 'picking') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        className="flex flex-col items-center gap-6 text-center"
      >
        {/* The standing belongs here most of all: this is the moment the player
            is deciding, and it used to show nothing but the three buttons. */}
        <div className="w-full max-w-xl">
          <MatchStatusBar
            score={score}
            roundNumber={roundNumber}
            format={format}
            history={history}
          />
        </div>

        <p className="display-type text-lg font-semibold text-muted">{copy.game.prompt}</p>
        {/* gap-3 on mobile is load-bearing: three 112px buttons plus gap-6 came
            to 384px against 382px of usable width on a 430px phone, wrapping
            scissors onto its own row. The moves must read as one row. */}
        <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-10">
          {CHOICES.map((choice) => (
            <div key={choice} className="flex flex-col items-center gap-3">
              <ChoiceButton choice={choice} imageSet={imageSet} onSelect={onPick} />
              <span className="display-type text-sm font-semibold text-muted">
                {copy.choices[choice]}
              </span>
            </div>
          ))}
        </div>
      </motion.div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="w-full max-w-xl">
        <MatchStatusBar score={score} roundNumber={roundNumber} format={format} history={history} />
      </div>

      {/* The hands live here across BOTH revealing and result, so the reveal is
          a snap of the same elements rather than a swap between screens. */}
      <div className="relative w-full py-2">
        {/* The countdown gets its own band ABOVE the hands rather than sitting
            behind them. Behind was the first attempt and it failed on contact:
            hands this large cover the middle of the word, so "Scissors..." read
            as "Sc...o...". Its own band keeps it legible, keeps its backdrop
            the page surface (which every theme already clears AA against, so no
            scrim is needed), and still lets it dominate the pump. The height is
            reserved so nothing shifts when it swaps or disappears. */}
        <div
          style={{ height: 'clamp(2.6rem, 10vw, 7.5rem)' }}
          className="flex w-full items-center justify-center overflow-x-clip"
        >
          {(phase === 'revealing' || showShoot) && !reducedMotion && (
            <motion.p
              key={`giant-${phase === 'revealing' ? beatIndex : 'shoot'}-${roundNumber}`}
              aria-hidden="true"
              initial={{ opacity: 0, scale: 0.88 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
              style={{ fontSize: 'clamp(1.6rem, 7.6vw, 6.5rem)', lineHeight: 1 }}
              className="display-type pointer-events-none whitespace-nowrap font-black text-ink select-none"
            >
              {phase === 'revealing'
                ? copy.game.countdown[beatIndex]
                : copy.game.countdown[SHAKE_BEATS]}
            </motion.p>
          )}
        </div>

        {phase === 'result' && roundResult && !reducedMotion && (
          <motion.div
            key={`flash-${roundNumber}`}
            aria-hidden="true"
            style={{ borderRadius: 'var(--radius-themed-md)' }}
            className={`pointer-events-none absolute inset-0 ${FLASH_CLASSES[roundResult]}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.35, 0] }}
            transition={{ duration: 0.6, times: [0, 0.18, 1], ease: 'easeOut' }}
          />
        )}

        <HandsFaceOff
          playerChoice={playerChoice as Choice}
          botChoice={botChoice}
          phase={phase}
          roundResult={roundResult}
          roundKey={roundNumber}
          imageSet={imageSet}
        />
      </div>

      <div className="min-h-[4.5rem] w-full">
        {/* Reduced motion keeps a plain text beat, since the giant countdown
            behind the hands is suppressed along with the rest of the motion. */}
        {phase === 'revealing' ? (
            reducedMotion ? (
              <p className="display-type text-2xl font-extrabold text-ink">
                {copy.game.countdown[beatIndex]}
              </p>
            ) : null
          ) : showShoot ? (
            reducedMotion ? (
              <p className="display-type text-3xl font-black text-ink">
                {copy.game.countdown[SHAKE_BEATS]}
              </p>
            ) : null
          ) : (
            <motion.div
              key="outcome"
              initial={{ opacity: 0, scale: reducedMotion ? 1 : 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="flex flex-col items-center gap-2"
            >
              {/* Outcome is announced as text, so it never depends on color alone. */}
              <p
                aria-live="polite"
                className={`display-type text-3xl font-extrabold ${roundResult ? OUTCOME_TEXT_CLASSES[roundResult] : ''}`}
              >
                {roundResult ? `${OUTCOME_MARK[roundResult]} ${copy.roundResult.outcome[roundResult]}` : ''}
              </p>
              <div className="flex items-center gap-2 text-muted">
                <span className="display-type text-sm font-semibold">
                  {copy.roundResult.scoreLabel}
                </span>
                <span className="display-type text-lg font-bold text-ink">
                  {score.player} – {score.opponent}
                </span>
              </div>
            </motion.div>
        )}
      </div>

      {phase === 'result' && !showShoot && (
        <motion.button
          type="button"
          onClick={onContinue}
          disabled={!advanceReady}
          initial={{ opacity: 0 }}
          animate={{ opacity: advanceReady ? 1 : 0.35 }}
          transition={{ duration: ADVANCE_FADE_MS / 1000, ease: 'easeOut' }}
          whileHover={advanceReady ? { scale: 1.05 } : undefined}
          whileTap={advanceReady ? { scale: 0.95 } : undefined}
          style={{
            borderRadius: 'var(--radius-themed-md)',
            boxShadow: 'var(--shadow-card)',
            borderWidth: 'var(--border-width)',
            borderColor: 'var(--border-color)',
            borderStyle: 'var(--border-style)',
          }}
          className="display-type cursor-pointer bg-elevated px-8 py-3 text-base font-bold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          {matchStatus === 'complete'
            ? copy.roundResult.seeResultsButton
            : copy.roundResult.nextRoundButton}
        </motion.button>
      )}
    </div>
  );
}

/**
 * Drives the "Rock... / Paper... / Scissors..." caption and plays one soft tick
 * per beat. Resets to 0 whenever the build-up isn't running, so the first frame
 * of a reveal can never render a stale beat from the previous phase.
 */
function useShakeBeats(running: boolean, roundNumber: number): number {
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    setBeat(0);
    if (!running) return;

    play('tick');

    let index = 0;
    const id = window.setInterval(() => {
      index += 1;
      if (index >= SHAKE_BEATS) {
        window.clearInterval(id);
        return;
      }
      setBeat(index);
      play('tick');
    }, SHAKE_BEAT_MS);

    return () => window.clearInterval(id);
  }, [running, roundNumber]);

  return Math.min(beat, SHAKE_BEATS - 1);
}
