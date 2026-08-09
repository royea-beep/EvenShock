/**
 * TEMPORARY: a dev switcher for comparing four impact treatments live.
 *
 * ============================ REMOVING THIS ============================
 * This is not a user-facing setting and must not become one. To settle on a
 * variant, delete this file, delete the B/C/D branches in:
 *   - src/components/impact/ImpactEffects.tsx  (or delete the whole module)
 *   - src/components/HandsFaceOff.tsx  (impact-animation branch on variant)
 *   - src/App.tsx  (shake branch on variant + badge import)
 *   - src/components/screens/RoundScreen.tsx  (pass-through of the variant)
 * then delete `ImpactVariantBadge.tsx`. Nothing else references it.
 * ======================================================================
 *
 * Selected with `?impact=a|b|c|d`. With no query param the app behaves exactly
 * as it does today — default variant A, no badge, nothing extra rendered — so
 * a normal visitor cannot land on a half-chosen experiment.
 *
 * The four:
 *   a — Current: white flash + shockwave ring + winner scale/glow + loser
 *       knockback + desaturate. What ships today, unchanged.
 *   b — Hit-stop: hard freeze at contact for ~120ms, then release into
 *       compressed knockback. Short flash, no ring, no shake.
 *   c — Cinematic: letterbox bars, slow knockback (~1000ms), slow winner
 *       push-in. No flash/ring/shake — a film beat, not a game beat.
 *   d — Crush: heavy multi-axis screen shake, loser thrown off-screen with
 *       rotation and fade, speed lines from contact point.
 */
export type ImpactVariant = 'a' | 'b' | 'c' | 'd';

export const IMPACT_VARIANTS: ImpactVariant[] = ['a', 'b', 'c', 'd'];

export const IMPACT_VARIANT_NAMES: Record<ImpactVariant, string> = {
  a: 'Current',
  b: 'Hit-stop',
  c: 'Cinematic',
  d: 'Crush',
};

export const DEFAULT_IMPACT_VARIANT: ImpactVariant = 'a';

function isVariant(value: string | null): value is ImpactVariant {
  return value === 'a' || value === 'b' || value === 'c' || value === 'd';
}

/**
 * Read once at module load rather than per render: the impact treatment must
 * not change underneath a round already in flight, and the choice needs to be
 * the same for every consumer (HandsFaceOff, RoundScreen, App shake).
 */
function readVariant(): { variant: ImpactVariant; explicit: boolean } {
  try {
    const raw = new URLSearchParams(window.location.search).get('impact');
    const value = raw === null ? null : raw.toLowerCase();
    if (isVariant(value)) return { variant: value, explicit: true };
  } catch {
    // No window (SSR/test) or a malformed URL: fall through to the default.
  }
  return { variant: DEFAULT_IMPACT_VARIANT, explicit: false };
}

const selection = readVariant();

export const IMPACT_VARIANT = selection.variant;
/** True only when ?impact= was supplied, which is what gates the dev badge. */
export const IMPACT_VARIANT_EXPLICIT = selection.explicit;
