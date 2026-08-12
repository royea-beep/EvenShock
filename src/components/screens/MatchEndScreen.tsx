import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { MatchFormat, Score } from '../../types/game';
import { copy } from '../../constants/copy';
import { BalanceStrip } from '../BalanceStrip';
import { Confetti } from '../Confetti';
import { HistoryTrail, OUTCOME_MARK } from '../MatchStatusBar';
import { play } from '../../utils/sound';
import { getMatchStats, type RoundEntry } from '../../utils/roundHistory';
import { buildShareLine } from '../../utils/share';

interface MatchEndScreenProps {
  /** What this match paid. Same curve on both paths — see utils/economy.ts. */
  earned: { xp: number; chips: number };
  economy: { xp: number; chips: number; persistent: boolean; loading: boolean };
  score: Score;
  matchWinner: 'player' | 'opponent' | null;
  format: MatchFormat;
  history: RoundEntry[];
  /** Straight into another match, same theme and format. */
  onPlayAgain: () => void;
  /** Back to Home, where the look and format can be changed. */
  onChangeLook: () => void;
}

export function MatchEndScreen({
  earned,
  economy,
  score,
  matchWinner,
  format,
  history,
  onPlayAgain,
  onChangeLook,
}: MatchEndScreenProps) {
  const reducedMotion = useReducedMotion();
  const playerWon = matchWinner === 'player';
  const stats = getMatchStats(history);

  const soundPlayed = useRef(false);
  useEffect(() => {
    if (playerWon && !soundPlayed.current) {
      soundPlayed.current = true;
      play('matchWin');
    }
  }, [playerWon]);

  const bannerText = matchWinner ? copy.matchEnd.winnerBanner[matchWinner] : '';

  return (
    <>
      <Confetti active={playerWon} />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        // Shares the explicit tween with HomeScreen and RoundScreen so all three
        // AnimatePresence swaps have the same shape and duration. See the
        // HomeScreen comment for why. The winner banner keeps its own spring
        // below — that's punctuation on top of the base fade-in, not the fade
        // itself.
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        // Losing reads as subdued, never harsh: the panel desaturates slightly
        // rather than turning aggressive. The recap and stats stay fully legible
        // either way — a loss should still be readable, not punished.
        className={`flex flex-col items-center gap-6 text-center ${
          playerWon ? '' : 'saturate-75'
        }`}
      >
        <motion.h2
          initial={reducedMotion ? { scale: 1 } : { scale: 0.8 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 12 }}
          className={`display-type text-4xl font-extrabold ${playerWon ? 'text-win' : 'text-muted'}`}
        >
          {bannerText}
        </motion.h2>

        <div className="space-y-1">
          <p className="display-type text-sm font-semibold text-muted">
            {copy.matchEnd.finalScoreLabel}
          </p>
          <p className="display-type text-3xl font-bold text-ink tabular-nums">
            {score.player} – {score.opponent}
          </p>
        </div>

        {/* What this match paid, next to the balance it paid into — the two
            numbers only mean something together. Shown before the recap
            because it is the thing that changed. */}
        <section className="w-full space-y-2">
          <p className="display-type text-sm font-semibold text-muted">
            {copy.economy.earned}
          </p>
          <p className="display-type text-lg font-bold text-ink tabular-nums">
            +{earned.xp} {copy.economy.xpLabel}
            {earned.chips > 0 && <> · +{earned.chips} {copy.economy.chipsLabel}</>}
          </p>
          <BalanceStrip
            xp={economy.xp}
            chips={economy.chips}
            persistent={economy.persistent}
            loading={economy.loading}
          />
        </section>

        {history.length > 0 && (
          <section className="w-full space-y-2">
            <p className="display-type text-sm font-semibold text-muted">
              {copy.matchEnd.recapLabel}
            </p>
            <HistoryTrail history={history} />
          </section>
        )}

        <Stats stats={stats} />

        <ShareResult score={score} format={format} history={history} winner={matchWinner} />

        <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
          <ExitButton onClick={onPlayAgain} emphasis={playerWon}>
            {copy.matchEnd.playAgainButton}
          </ExitButton>
          <ExitButton onClick={onChangeLook} emphasis={false}>
            {copy.matchEnd.changeLookButton}
          </ExitButton>
        </div>
      </motion.div>
    </>
  );
}

function Stats({ stats }: { stats: ReturnType<typeof getMatchStats> }) {
  const winRate =
    stats.winRate === null
      ? copy.matchEnd.winRateAllTies
      : `${Math.round(stats.winRate * 100)}%`;

  return (
    <dl className="flex w-full flex-wrap justify-center gap-2">
      <Stat label={copy.matchEnd.statsWinRate} value={winRate} />
      <Stat label={copy.matchEnd.statsRounds} value={String(stats.played)} />
      <Stat
        label={copy.matchEnd.statsTopMove}
        value={stats.topMove ? `${copy.choices[stats.topMove.choice]} ×${stats.topMove.count}` : '—'}
      />
    </dl>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        borderRadius: 'var(--radius-themed-md)',
        borderWidth: 'var(--border-width)',
        borderColor: 'var(--border-color)',
        borderStyle: 'var(--border-style)',
      }}
      className="flex min-w-24 flex-1 flex-col items-center gap-0.5 bg-card px-3 py-2"
    >
      <dt className="display-type text-[0.65rem] font-semibold text-muted">{label}</dt>
      <dd className="display-type text-base font-bold text-ink tabular-nums">{value}</dd>
    </div>
  );
}

function ExitButton({
  onClick,
  emphasis,
  children,
}: {
  onClick: () => void;
  emphasis: boolean;
  children: React.ReactNode;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.96 }}
      style={{
        borderRadius: 'var(--radius-themed-md)',
        boxShadow: 'var(--shadow-card)',
        borderWidth: 'var(--border-width)',
        borderColor: 'var(--border-color)',
        borderStyle: 'var(--border-style)',
      }}
      className={`display-type flex-1 cursor-pointer px-8 py-3.5 text-base font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current ${
        emphasis ? 'bg-scissors text-scissors-ink' : 'bg-elevated text-ink'
      }`}
    >
      {children}
    </motion.button>
  );
}

/** Builds the plain-text result line, ending in the share URL so a recipient
 *  who taps it lands on the game. Exported for testing. */
export function buildShareText(
  score: Score,
  format: MatchFormat,
  history: RoundEntry[],
  winner: 'player' | 'opponent' | null,
): string {
  const trail = history.map((e) => OUTCOME_MARK[e.outcome]).join('');
  const headline = winner === 'player' ? 'I won' : winner === 'opponent' ? 'I lost' : 'We drew';
  return buildShareLine({
    formatLabel: copy.formats[format],
    headline,
    scoreLine: `${score.player}–${score.opponent}`,
    trail: trail || undefined,
  });
}

function ShareResult({
  score,
  format,
  history,
  winner,
}: {
  score: Score;
  format: MatchFormat;
  history: RoundEntry[];
  winner: 'player' | 'opponent' | null;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const text = buildShareText(score, format, history, winner);

  const copyText = async () => {
    // navigator.clipboard is unavailable on insecure origins and in some
    // in-app browsers, so failure is expected rather than exceptional: fall
    // back to exposing the text pre-selected for a manual copy.
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard api');
      await navigator.clipboard.writeText(text);
      setState('copied');
      window.setTimeout(() => setState('idle'), 1800);
    } catch {
      setState('manual');
      window.setTimeout(() => {
        fallbackRef.current?.focus();
        fallbackRef.current?.select();
      }, 0);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-2">
      <button
        type="button"
        onClick={copyText}
        style={{
          borderRadius: 'var(--radius-themed-md)',
          borderWidth: 'var(--border-width)',
          borderColor: 'var(--border-color)',
          borderStyle: 'var(--border-style)',
        }}
        className="display-type cursor-pointer bg-card px-5 py-2 text-sm font-semibold text-ink hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
      >
        {state === 'copied' ? copy.matchEnd.shareCopied : copy.matchEnd.shareButton}
      </button>

      {/* Announced politely so the outcome of pressing the button is not
          visual-only for screen reader users. */}
      <span aria-live="polite" className="sr-only">
        {state === 'copied' ? copy.matchEnd.shareCopied : ''}
      </span>

      {state === 'manual' && (
        <textarea
          ref={fallbackRef}
          readOnly
          rows={3}
          value={text}
          aria-label={copy.matchEnd.shareFailed}
          style={{
            borderRadius: 'var(--radius-sm)',
            borderWidth: 'var(--border-width)',
            borderColor: 'var(--border-color)',
            borderStyle: 'var(--border-style)',
          }}
          className="w-full resize-none bg-card p-2 text-center text-xs text-ink"
        />
      )}
    </div>
  );
}
