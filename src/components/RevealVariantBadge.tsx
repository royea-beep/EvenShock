import {
  REVEAL_VARIANT,
  REVEAL_VARIANTS,
  REVEAL_VARIANT_EXPLICIT,
  REVEAL_VARIANT_NAMES,
} from '../utils/revealVariant';

/**
 * TEMPORARY dev affordance for comparing reveal choreographies. Delete with
 * `utils/revealVariant.ts` once a variant is chosen.
 *
 * Renders NOTHING unless `?reveal=` is in the URL, so it cannot appear for a
 * normal visitor and cannot be mistaken for a setting. The links are plain
 * anchors that reload the page: the choreography is read once at module load
 * so it can never change under a round already in flight.
 */
export function RevealVariantBadge() {
  if (!REVEAL_VARIANT_EXPLICIT) return null;

  return (
    <div
      className="fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/75 px-2 py-1 text-[0.7rem] font-semibold text-white"
      style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}
    >
      <span className="px-1 opacity-70">reveal</span>
      {REVEAL_VARIANTS.map((v) => (
        <a
          key={v}
          href={`?reveal=${v}`}
          aria-current={v === REVEAL_VARIANT ? 'true' : undefined}
          className={`rounded-full px-2 py-0.5 transition-colors ${
            v === REVEAL_VARIANT ? 'bg-white text-black' : 'hover:bg-white/20'
          }`}
        >
          {v.toUpperCase()}
        </a>
      ))}
      <span className="px-1 opacity-70">{REVEAL_VARIANT_NAMES[REVEAL_VARIANT]}</span>
    </div>
  );
}
