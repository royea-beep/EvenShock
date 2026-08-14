import { motion } from 'framer-motion';
import { copy } from '../constants/copy';
import {
  asPercent,
  dominantMove,
  hasDebrief,
  parseContext,
  predictabilityTrend,
  type NemesisBest,
  type NemesisReport,
} from '../data/nemesis';

/**
 * What Nemesis saw, shown after the match and never during it.
 *
 * THE WHOLE POINT IS THAT THE PLAYER CAN CHECK IT. Every number here is a
 * count out of the player's own throws — "after losing a round you came back
 * with rock 7 times out of 11" — so a player who disagrees can go and count.
 * Nothing on this panel is advice, a rating, or a generated observation that
 * happens to sound personal.
 *
 * IT RENDERS ONLY FOR A NEMESIS MATCH. `report` is null for a random-opponent
 * match, for a match that isn't this player's, and for one still in progress —
 * so there is no state where this panel appears next to a match it isn't
 * describing.
 */
export function NemesisDebrief({
  report,
  best,
}: {
  report: NemesisReport | null;
  best: NemesisBest | null;
}) {
  if (!report || !hasDebrief(report)) return null;

  const tell = report.tell;
  const lean = tell ? dominantMove(tell) : null;
  const situation = tell ? parseContext(tell) : null;
  const trend = predictabilityTrend(report.predictability);
  const after = report.predictability.after;

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
      style={{
        borderRadius: 'var(--radius-themed-md)',
        borderWidth: 'var(--border-width)',
        borderColor: 'var(--border-color)',
        borderStyle: 'var(--border-style)',
      }}
      className="w-full space-y-3 bg-card px-4 py-4 text-left"
    >
      <h3 className="display-type text-sm font-semibold text-muted">{copy.nemesis.title}</h3>

      {/* Cold start, said out loud. A player meeting a blind opponent should be
          told it is blind, not left to decide for themselves whether the game
          is easy or they are good. */}
      {report.calibrating && (
        <p className="text-sm text-ink">{copy.nemesis.calibrating(report.roundsUntilRead)}</p>
      )}

      {!report.calibrating && (
        <>
          <p className="text-sm text-ink">
            {copy.nemesis.splitLine(report.read.rounds, report.blind.rounds)}
          </p>

          <dl className="flex flex-wrap gap-2">
            <Split
              label={copy.nemesis.readLabel}
              rounds={report.read.rounds}
              won={report.read.youWon}
            />
            <Split
              label={copy.nemesis.blindLabel}
              rounds={report.blind.rounds}
              won={report.blind.youWon}
            />
          </dl>

          {/* The line that replaces staging losses. Worth its space: it is the
              difference between "it let me win one" and "I won one". */}
          <p className="text-xs text-muted">{copy.nemesis.blindNote}</p>
        </>
      )}

      <div className="space-y-1">
        <h4 className="display-type text-xs font-semibold text-muted">{copy.nemesis.tellTitle}</h4>
        {lean && situation ? (
          <p className="text-sm text-ink">
            {/* The marginal lens is not conditional on anything, so it gets its
                own sentence rather than an opener that implies a trigger. */}
            {situation.prevOutcome == null && situation.prevMove == null
              ? copy.nemesis.tellOverall(copy.choices[lean.move], lean.count, lean.total)
              : copy.nemesis.tellSentence(
                  copy.nemesis.situation(
                    situation.prevOutcome,
                    situation.prevMove && copy.choices[situation.prevMove],
                  ),
                  copy.choices[lean.move],
                  lean.count,
                  lean.total,
                )}
          </p>
        ) : (
          <p className="text-sm text-muted">{copy.nemesis.noTell}</p>
        )}
      </div>

      <div className="space-y-1">
        <h4 className="display-type text-xs font-semibold text-muted">
          {copy.nemesis.predictabilityTitle}
        </h4>
        {after == null ? (
          <p className="text-sm text-muted">{copy.nemesis.predictabilityPending}</p>
        ) : (
          <>
            <p className="display-type text-2xl font-bold text-ink tabular-nums">
              {copy.nemesis.predictabilityValue(asPercent(after))}
            </p>
            {trend && report.predictability.before != null && (
              <p className="text-xs text-muted">
                {trend === 'flat'
                  ? copy.nemesis.trend.flat(asPercent(after))
                  : copy.nemesis.trend[trend](
                      asPercent(report.predictability.before),
                      asPercent(after),
                    )}
              </p>
            )}
          </>
        )}
      </div>

      {/* The trophy, and the caveat it has to carry. A player using an external
          randomiser genuinely is unreadable and Nemesis genuinely cannot beat
          them — that is the theorem working, not an exploit, and it is not
          defended against. But it does mean a perfect score measures "did you
          use a dice" as much as skill, so the copy says so rather than letting
          the number imply something it has not earned. */}
      {best?.lowest != null && (
        <div className="space-y-1">
          <h4 className="display-type text-xs font-semibold text-muted">
            {copy.nemesis.trophyTitle}
          </h4>
          <p className="display-type text-base font-bold text-ink tabular-nums">
            {copy.nemesis.predictabilityValue(asPercent(best.lowest))}
          </p>
          <p className="text-xs text-muted">{copy.nemesis.trophyCaveat}</p>
        </div>
      )}
    </motion.section>
  );
}

function Split({ label, rounds, won }: { label: string; rounds: number; won: number }) {
  return (
    <div
      style={{
        borderRadius: 'var(--radius-themed-md)',
        borderWidth: 'var(--border-width)',
        borderColor: 'var(--border-color)',
        borderStyle: 'var(--border-style)',
      }}
      className="flex min-w-32 flex-1 flex-col gap-0.5 bg-elevated px-3 py-2"
    >
      <dt className="display-type text-[0.65rem] font-semibold text-muted">{label}</dt>
      <dd className="display-type text-base font-bold text-ink tabular-nums">
        {rounds}
        <span className="ml-1 text-xs font-semibold text-muted tabular-nums">
          {copy.nemesis.wonOf(won, rounds)}
        </span>
      </dd>
    </div>
  );
}
