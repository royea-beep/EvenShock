import { AnimatePresence, motion } from 'framer-motion';
import { copy } from '../constants/copy';
import type { RoundTrouble as Trouble } from '../hooks/useRounds';

/**
 * What the player sees when a round will not settle.
 *
 * The wind-up keeps running underneath: the round screen holds its coil until
 * the answer arrives, so this is an overlay on a live animation, not a
 * replacement for it. Below the retry threshold nothing renders at all — a
 * round that is 200ms late is not an event worth narrating.
 *
 * The fairness case is styled apart from the network cases on purpose. "We
 * cannot reach the server" is weather. "The server did not play what it
 * committed to" is an accusation, and it should not look like weather.
 */
interface Props {
  trouble: Trouble;
  onRetry: () => void;
  onLeave: () => void;
}

export function RoundTrouble({ trouble, onRetry, onLeave }: Props) {
  const visible = trouble.kind !== 'none' && trouble.kind !== 'retrying';
  const fairness = trouble.kind === 'fairness';

  return (
    <>
      {/* A quiet line while auto-retry is still working. No buttons: there is
          nothing useful for the player to do yet, and offering a choice would
          imply the move might be lost. */}
      <AnimatePresence>
        {trouble.kind === 'retrying' && (
          <motion.p
            key="retrying"
            role="status"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-x-0 bottom-6 z-40 text-center text-sm text-[var(--text-muted)]"
          >
            {copy.trouble.retryingBody}
          </motion.p>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {visible && (
          <motion.div
            key="trouble"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="trouble-title"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          >
            <motion.div
              initial={{ y: 12, scale: 0.98 }}
              animate={{ y: 0, scale: 1 }}
              className={`w-full max-w-sm rounded-2xl border p-6 text-center ${
                fairness
                  ? 'border-[var(--outcome-lose)] bg-[var(--surface-elevated)]'
                  : 'border-[var(--surface-elevated)] bg-[var(--surface-card)]'
              }`}
            >
              <h2
                id="trouble-title"
                className={`text-lg font-semibold ${
                  fairness ? 'text-[var(--outcome-lose)]' : 'text-[var(--text-primary)]'
                }`}
              >
                {fairness
                  ? copy.trouble.fairnessTitle
                  : trouble.kind === 'refused'
                    ? trouble.code === 'rate_limited'
                      ? copy.trouble.rateLimitedTitle
                      : copy.trouble.refusedTitle
                    : copy.trouble.offlineTitle}
              </h2>

              <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">
                {fairness
                  ? copy.trouble.fairnessBody
                  : trouble.kind === 'refused'
                    ? trouble.code === 'rate_limited'
                      ? copy.trouble.rateLimitedBody
                      : copy.trouble.refusedBody
                    : copy.trouble.offlineBody}
              </p>

              {/* The detail is for a bug report, not for reading. Selectable,
                  small, and only present when there is something to report. */}
              {fairness && (
                <p className="mt-3 break-all rounded-lg bg-[var(--surface-page)] p-2 text-left font-mono text-[10px] leading-tight text-[var(--text-muted)]">
                  {trouble.detail}
                </p>
              )}

              <div className="mt-5 flex flex-col gap-2">
                {/* Retry only where retrying can help. After a fairness failure
                    or a closed round it would just fail again, more slowly. */}
                {trouble.kind === 'offline' && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="min-h-11 rounded-xl bg-[var(--choice-rock)] px-4 font-semibold text-[var(--choice-rock-ink)]"
                  >
                    {copy.trouble.offlineRetry}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onLeave}
                  className="min-h-11 rounded-xl border border-[var(--surface-elevated)] px-4 text-[var(--text-primary)]"
                >
                  {copy.trouble.leaveMatch}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
