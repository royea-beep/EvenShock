import type { MatchFormat, RoundOutcome, Score } from '../types/game';
import type { RoundEntry } from '../utils/roundHistory';
import { copy } from '../constants/copy';

/* The same marks the outcome line uses, so a round reads the same way in the
   trail as it did when it happened — and never by colour alone. */
export const OUTCOME_MARK: Record<RoundOutcome, string> = {
  win: '▲',
  lose: '▼',
  tie: '＝',
};

const PILL_CLASSES: Record<RoundOutcome, string> = {
  win: 'text-win',
  lose: 'text-lose',
  tie: 'text-tie',
};

interface MatchStatusBarProps {
  score: Score;
  roundNumber: number;
  format: MatchFormat;
  history: RoundEntry[];
}

/**
 * Persistent match context, shown in every phase of a round — including while
 * you are choosing, which is the moment the score actually matters and the one
 * place it used to be missing entirely.
 *
 * Hidden for single rounds, where there is no standing to track.
 */
export function MatchStatusBar({ score, roundNumber, format, history }: MatchStatusBarProps) {
  if (format === 'single') return null;

  return (
    <div
      style={{
        borderRadius: 'var(--radius-themed-md)',
        borderWidth: 'var(--border-width)',
        borderColor: 'var(--border-color)',
        borderStyle: 'var(--border-style)',
      }}
      className="flex w-full flex-col items-center gap-2 bg-card px-4 py-2.5"
    >
      <div className="flex w-full items-center justify-between gap-3">
        <span className="display-type text-xs font-semibold text-muted">
          {copy.status.roundLabel} {roundNumber}
        </span>

        {/* The standing, as the largest thing in the bar. tabular-nums keeps
            the digits from shifting the layout as the score climbs. */}
        <span className="flex items-baseline gap-1.5">
          <span className="display-type text-[0.65rem] font-semibold text-muted">
            {copy.status.youLabel}
          </span>
          <span className="display-type text-xl font-extrabold text-ink tabular-nums">
            {score.player}
          </span>
          <span className="display-type text-sm font-bold text-muted">–</span>
          <span className="display-type text-xl font-extrabold text-ink tabular-nums">
            {score.opponent}
          </span>
          <span className="display-type text-[0.65rem] font-semibold text-muted">
            {copy.status.botLabel}
          </span>
        </span>

        <span className="display-type text-xs font-semibold text-muted">
          {copy.formats[format]}
        </span>
      </div>

      {history.length > 0 && <HistoryTrail history={history} />}
    </div>
  );
}

/** A compact W/L/T trail of the match so far. */
export function HistoryTrail({ history }: { history: RoundEntry[] }) {
  return (
    <ul aria-label={copy.status.historyLabel} className="flex flex-wrap justify-center gap-1">
      {history.map((entry) => (
        <li
          key={entry.round}
          style={{
            borderRadius: 'var(--radius-sm)',
            borderWidth: 'var(--border-width)',
            borderColor: 'var(--border-color)',
            borderStyle: 'var(--border-style)',
          }}
          // bg-page, not bg-elevated: the outcome colours are toned against the
          // page surface and only guaranteed there. On elevated they measure as
          // low as 3.3:1 (Retro Pixel) and 3.8:1 (Marble).
          className={`flex h-5 min-w-5 items-center justify-center bg-page px-1 text-[0.7rem] leading-none font-bold ${PILL_CLASSES[entry.outcome]}`}
        >
          <span aria-hidden="true">{OUTCOME_MARK[entry.outcome]}</span>
          <span className="sr-only">
            {`${copy.status.roundLabel} ${entry.round} ${copy.status.historyEntry[entry.outcome]}`}
          </span>
        </li>
      ))}
    </ul>
  );
}
