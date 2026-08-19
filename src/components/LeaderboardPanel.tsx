import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { copy } from '../constants/copy';
import type { LeaderRow, Persistence } from '../data/persistence';
import { useLadder } from '../hooks/useLadder';
import { movementOf, standingKind, type LadderSnapshot } from '../data/ladder';

/**
 * TWO BOARDS, AND THE DISTINCTION IS THE POINT.
 *
 * The LADDER is the competitive one: Glicko-2, head-to-head matches only. It
 * leads, because it is the thing a player should see themselves entering and
 * the only ranking here that means anything about skill.
 *
 * The ACTIVITY table below it counts completed matches including solo ones.
 * It is kept, but no longer presented as a ranking of ability — solo results
 * come from a uniformly random bot, and against a uniform opponent every
 * strategy has identical expected value. That is measured, not assumed: the
 * blind branch sits at q=0.4615 with 0.50 inside its interval. Sorting players
 * by solo wins ranks them by luck, so the section says "activity, not skill"
 * in its own subtitle rather than letting the position imply otherwise.
 *
 * Top-players panel, opened from Home. Server-authoritative — every row is
 * produced by the `leaderboard` RPC, which counts only `matches.status =
 * 'complete'` and requires a minimum play threshold (default 5) to appear.
 * Guests cannot open this: the parent gates it behind a signed-in session, and
 * the RPC's grant list would refuse the call anyway.
 *
 * The current player's row, when present, is highlighted so seeing yourself
 * move is one glance rather than a scroll-and-search. When absent, the
 * empty-you state names the reason ("play N more matches to qualify"), which
 * is the piece a first-timer needs and a returning player needs less often.
 *
 * Failures fall through to a text row saying so — the game underneath the
 * panel stays reachable, same discipline as the entry screen.
 */
interface LeaderboardPanelProps {
  persistence: Persistence;
  /** The signed-in caller's user_id, for the highlight + qualification hint. */
  currentUserId?: string;
  /** Matches this caller has completed, used for the "N more to qualify" hint.
   *  Not authoritative — the RPC's `matches_played` is — but this is what the
   *  parent already reads for the balance strip, so we reuse it rather than a
   *  second round trip. */
  currentUserMatches?: number;
  onClose: () => void;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; rows: LeaderRow[] }
  | { kind: 'error'; message: string };

const MIN_MATCHES = 5;

export function LeaderboardPanel({
  persistence,
  currentUserId,
  currentUserMatches,
  onClose,
}: LeaderboardPanelProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const ladder = useLadder(currentUserId, Boolean(currentUserId));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await persistence.loadLeaderboard(100);
        if (!cancelled) setPhase({ kind: 'ready', rows });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setPhase({ kind: 'error', message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persistence]);

  const meRow = useMemo(() => {
    if (phase.kind !== 'ready' || !currentUserId) return null;
    return phase.rows.find((r) => r.user_id === currentUserId) ?? null;
  }, [phase, currentUserId]);

  const qualifiesHint = useMemo(() => {
    if (currentUserMatches === undefined) return null;
    if (currentUserMatches >= MIN_MATCHES) return null;
    return copy.leaderboard.qualifyHint(MIN_MATCHES - currentUserMatches);
  }, [currentUserMatches]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="leaderboard-title"
      className="fixed inset-0 z-40 overflow-y-auto bg-[rgba(10,10,14,0.9)] p-4 backdrop-blur-sm sm:p-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          borderRadius: 'var(--radius-themed-md)',
          borderWidth: 'var(--border-width)',
          borderColor: 'var(--border-color)',
          borderStyle: 'var(--border-style)',
          boxShadow: 'var(--shadow-card)',
        }}
        className="mx-auto flex min-h-full max-w-2xl flex-col gap-4 bg-elevated p-4 text-ink sm:min-h-0 sm:gap-6 sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2
              id="leaderboard-title"
              className="display-type text-xl font-extrabold sm:text-2xl"
            >
              {copy.leaderboard.title}
            </h2>
            <p className="text-xs text-muted sm:text-sm">{copy.leaderboard.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-muted underline decoration-dotted hover:text-ink"
          >
            {copy.leaderboard.close}
          </button>
        </div>

        {phase.kind === 'loading' && (
          <p className="py-6 text-center text-sm text-muted">{copy.leaderboard.loading}</p>
        )}

        {phase.kind === 'error' && (
          <p role="alert" className="py-6 text-center text-sm text-muted">
            {copy.leaderboard.error(phase.message)}
          </p>
        )}

        {/* ---------------------------------------------------------- ladder */}
        {currentUserId && <YourStanding snapshot={ladder.snapshot} failed={ladder.failed} />}
        {currentUserId && <Ladder snapshot={ladder.snapshot} />}

        {/* --------------------------------------------------------- activity */}
        <div className="space-y-1 border-t border-current/10 pt-4">
          <h3 className="display-type text-sm font-bold text-ink">
            {copy.leaderboard.activityTitle}
          </h3>
          <p className="text-xs text-muted">{copy.leaderboard.activitySubtitle}</p>
        </div>

        {phase.kind === 'ready' && phase.rows.length === 0 && (
          <p className="py-6 text-center text-sm text-muted">{copy.leaderboard.emptyBoard(MIN_MATCHES)}</p>
        )}

        {phase.kind === 'ready' && phase.rows.length > 0 && (
          <>
            {qualifiesHint && (
              <p className="rounded-sm bg-page px-3 py-2 text-xs text-muted">{qualifiesHint}</p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-current/10">
                    <th className="py-2 pr-2 text-left font-semibold">{copy.leaderboard.headers.rank}</th>
                    <th className="py-2 pr-2 text-left font-semibold">{copy.leaderboard.headers.player}</th>
                    <th className="py-2 pr-2 text-right font-semibold">{copy.leaderboard.headers.wins}</th>
                    <th className="py-2 pr-2 text-right font-semibold">{copy.leaderboard.headers.played}</th>
                    <th className="py-2 text-right font-semibold">{copy.leaderboard.headers.winRate}</th>
                  </tr>
                </thead>
                <tbody>
                  {phase.rows.map((row) => {
                    const isMe = row.user_id === currentUserId;
                    return (
                      <tr
                        key={row.user_id}
                        className={
                          isMe
                            ? 'bg-scissors/20 font-semibold'
                            : 'border-b border-current/5'
                        }
                      >
                        <td className="py-1.5 pr-2 tabular-nums">{row.rank}</td>
                        <td className="py-1.5 pr-2 break-all">
                          {row.display_name}
                          {isMe && (
                            <span className="ml-2 text-xs text-muted">{copy.leaderboard.youTag}</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{row.wins}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-muted">{row.matches_played}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {row.win_rate === null ? '—' : `${row.win_rate}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {meRow === null && !qualifiesHint && currentUserId && (
              <p className="text-center text-xs text-muted">{copy.leaderboard.notOnBoard}</p>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}

/**
 * Where the caller stands, and what the last rated match did to it.
 *
 * Movement is the reason a board is worth reopening, so it is the largest
 * thing here after the rank itself. It is derived server-side from
 * rating_history's before/after, never from a stored counter, so it cannot
 * disagree with the rating printed beside it.
 */
function YourStanding({
  snapshot,
  failed,
}: {
  snapshot: LadderSnapshot | null;
  failed: boolean;
}) {
  // A fault is not an empty ladder; saying nothing beats saying something false.
  if (failed || !snapshot) return null;
  const you = snapshot.you;
  const move = movementOf(you.lastChange);

  return (
    <section className="space-y-2">
      <h3 className="display-type text-sm font-bold text-ink">
        {copy.leaderboard.yourStanding}
      </h3>

      {standingKind(you) === 'unrated' ? (
        <p className="text-sm text-muted">{copy.leaderboard.unrated}</p>
      ) : (
        <div
          style={{
            borderRadius: 'var(--radius-themed-md)',
            borderWidth: 'var(--border-width)',
            borderColor: 'var(--border-color)',
            borderStyle: 'var(--border-style)',
          }}
          className="flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-page px-3 py-2"
        >
          {you.rank !== null && (
            <span className="display-type text-lg font-bold text-ink tabular-nums">
              {copy.leaderboard.rankOf(you.rank, snapshot.totalPlayers)}
            </span>
          )}
          {you.rating !== null && (
            <span className="text-sm text-muted tabular-nums">
              {copy.leaderboard.ratingLabel} {you.rating}
            </span>
          )}
          {move && you.lastChange && (
            <span
              className={`text-sm font-semibold tabular-nums ${
                move === 'up' ? 'text-win' : move === 'down' ? 'text-lose' : 'text-muted'
              }`}
            >
              {move === 'flat'
                ? copy.leaderboard.movement.flat
                : copy.leaderboard.movement[move](you.lastChange.delta)}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/** The rated board. Explains its own emptiness rather than showing a blank. */
function Ladder({ snapshot }: { snapshot: LadderSnapshot | null }) {
  if (!snapshot) return null;

  return (
    <section className="space-y-2">
      <div className="space-y-1">
        <h3 className="display-type text-sm font-bold text-ink">
          {copy.leaderboard.ladderTitle}
        </h3>
        <p className="text-xs text-muted">{copy.leaderboard.ladderSubtitle}</p>
      </div>

      {snapshot.board.length === 0 ? (
        <p className="py-2 text-sm text-muted">{snapshot.emptyReason}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-current/10">
                <th className="py-2 pr-2 text-left font-semibold">
                  {copy.leaderboard.headers.rank}
                </th>
                <th className="py-2 pr-2 text-left font-semibold">
                  {copy.leaderboard.headers.player}
                </th>
                <th className="py-2 pr-2 text-right font-semibold">
                  {copy.leaderboard.ratingLabel}
                </th>
                <th className="py-2 text-right font-semibold">
                  {copy.leaderboard.headers.played}
                </th>
              </tr>
            </thead>
            <tbody>
              {snapshot.board.map((row) => (
                <tr
                  key={row.userId}
                  className={row.isYou ? 'bg-scissors/20 font-semibold' : 'border-b border-current/5'}
                >
                  <td className="py-1.5 pr-2 tabular-nums">{row.rank}</td>
                  <td className="py-1.5 pr-2 break-all">
                    {row.name}
                    {row.isYou && (
                      <span className="ml-2 text-xs text-muted">{copy.leaderboard.youTag}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{row.rating}</td>
                  <td className="py-1.5 text-right tabular-nums text-muted">{row.matches}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
