/**
 * TEMPORARY: a dev switcher for comparing three reveal choreographies live.
 *
 * ============================ REMOVING THIS ============================
 * This is not a user-facing setting and must not become one. To settle on a
 * variant, delete this file, delete `choreography.ts`'s other two branches,
 * delete `RevealVariantBadge.tsx`, and drop the `variant` prop threaded through
 * HandsFaceOff. Nothing else references it.
 * ======================================================================
 *
 * Selected with `?reveal=a|b|c`. With no query param the app behaves exactly as
 * it does today — default variant, no badge, nothing rendered — so a normal
 * visitor cannot land on a half-chosen experiment.
 */
export type RevealVariant = 'a' | 'b' | 'c';

export const REVEAL_VARIANTS: RevealVariant[] = ['a', 'b', 'c'];

export const REVEAL_VARIANT_NAMES: Record<RevealVariant, string> = {
  a: 'Standoff',
  b: 'Wind-up',
  c: 'Lock-in',
};

export const DEFAULT_REVEAL_VARIANT: RevealVariant = 'a';

function isVariant(value: string | null): value is RevealVariant {
  return value === 'a' || value === 'b' || value === 'c';
}

/**
 * Read once at module load rather than per render: the choreography must not
 * change underneath a round already in flight.
 */
function readVariant(): { variant: RevealVariant; explicit: boolean } {
  try {
    const raw = new URLSearchParams(window.location.search).get('reveal');
    const value = raw === null ? null : raw.toLowerCase();
    if (isVariant(value)) return { variant: value, explicit: true };
  } catch {
    // No window (SSR/test) or a malformed URL: fall through to the default.
  }
  return { variant: DEFAULT_REVEAL_VARIANT, explicit: false };
}

const selection = readVariant();

export const REVEAL_VARIANT = selection.variant;
/** True only when ?reveal= was supplied, which is what gates the dev badge. */
export const REVEAL_VARIANT_EXPLICIT = selection.explicit;
