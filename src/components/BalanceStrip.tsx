import { copy } from '../constants/copy';
import { levelProgress } from '../utils/economy';

/**
 * XP, level and chips — and, for a guest, an unmissable statement of where they
 * live.
 *
 * The guest line is not a footnote and not a tooltip. Someone who plays two
 * hundred rounds and then clears their browser has to have known from the first
 * screen that this would happen; discovering it afterwards is the version that
 * feels like theft. So it sits directly under the numbers it qualifies, in the
 * same visual weight as everything else on the screen.
 */
interface Props {
  xp: number;
  chips: number;
  /** False for guests. Drives the labelling and nothing else. */
  persistent: boolean;
  /** Suppresses the flash of zeros before the first read lands. */
  loading?: boolean;
}

export function BalanceStrip({ xp, chips, persistent, loading = false }: Props) {
  const { level, into, span } = levelProgress(xp);

  return (
    <section
      aria-label={`${copy.economy.xpLabel} and ${copy.economy.chipsLabel}`}
      className="w-full space-y-2"
    >
      <div className="flex items-center justify-center gap-5 text-sm">
        <span className="flex items-baseline gap-1.5">
          <span className="display-type font-bold text-[var(--text-primary)]">
            {copy.economy.levelLabel} {loading ? '—' : level}
          </span>
          <span className="text-[var(--text-muted)]">
            {loading ? '' : `${into}/${span} ${copy.economy.xpLabel}`}
          </span>
        </span>

        <span className="flex items-baseline gap-1.5">
          <span className="display-type font-bold text-[var(--text-primary)]">
            {loading ? '—' : chips}
          </span>
          <span className="text-[var(--text-muted)]">{copy.economy.chipsLabel}</span>
        </span>
      </div>

      {/* A level bar rather than a raw number: XP is progression, and progress
          is easier to feel than to read. Width is clamped so a fresh player
          still sees a sliver rather than an empty track. */}
      <div
        aria-hidden="true"
        className="mx-auto h-1 w-full max-w-xs overflow-hidden rounded-full bg-[var(--surface-elevated)]"
      >
        <div
          className="h-full rounded-full bg-[var(--choice-scissors)] transition-[width] duration-500"
          style={{ width: loading ? '0%' : `${Math.max(2, Math.round((into / span) * 100))}%` }}
        />
      </div>

      {!persistent && (
        <p className="text-center text-xs leading-snug text-[var(--text-muted)]">
          <span className="font-semibold">{copy.economy.guestTitle}.</span>{' '}
          {copy.economy.guestBody}
        </p>
      )}
    </section>
  );
}
