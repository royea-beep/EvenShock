import {
  IMPACT_VARIANT,
  IMPACT_VARIANTS,
  IMPACT_VARIANT_EXPLICIT,
  IMPACT_VARIANT_NAMES,
} from '../utils/impactVariant';

/**
 * TEMPORARY dev affordance for comparing impact treatments. Delete with
 * `utils/impactVariant.ts` once a variant is chosen.
 *
 * Renders NOTHING unless `?impact=` is in the URL, so it cannot appear for a
 * normal visitor and cannot be mistaken for a setting. The links are plain
 * anchors that reload the page: the variant is read once at module load so it
 * can never change under a round already in flight.
 *
 * Positioned above the mute/fast toggles rather than at the bottom-centre where
 * the reveal-variant badge sat, because the impact needs the bottom band clear
 * for the outcome text and the advance button.
 */
export function ImpactVariantBadge() {
  if (!IMPACT_VARIANT_EXPLICIT) return null;

  return (
    <div
      className="fixed left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/75 px-2 py-1 text-[0.7rem] font-semibold text-white"
      style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}
    >
      <span className="px-1 opacity-70">impact</span>
      {IMPACT_VARIANTS.map((v) => (
        <a
          key={v}
          href={`?impact=${v}`}
          aria-current={v === IMPACT_VARIANT ? 'true' : undefined}
          className={`rounded-full px-2 py-0.5 transition-colors ${
            v === IMPACT_VARIANT ? 'bg-white text-black' : 'hover:bg-white/20'
          }`}
        >
          {v.toUpperCase()}
        </a>
      ))}
      <span className="px-1 opacity-70">{IMPACT_VARIANT_NAMES[IMPACT_VARIANT]}</span>
    </div>
  );
}
