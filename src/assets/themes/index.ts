import type { Choice } from '../../types/game';

/**
 * Registry of the generated art sets.
 *
 * Assets are discovered with `import.meta.glob` rather than listed by hand, so
 * dropping a new `<slug>/` folder in here is all it takes to register one — no
 * edit to this file. Going through Vite also means the URLs are content-hashed
 * and respect the configured `base` (`/evenshock/`), which hardcoded paths
 * would not.
 *
 * Produced by `node scripts/build-theme-assets.mjs` from `assets-src/rps/`.
 */
const files = import.meta.glob('./*/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export interface MoveImage {
  /** 640px — the choice buttons and the reveal hands. */
  full: string;
  /** 160px — the theme-picker previews. */
  thumb: string;
}

export type ImageSet = Record<Choice, MoveImage>;

const registry: Record<string, Partial<Record<Choice, Partial<MoveImage>>>> = {};

for (const [path, url] of Object.entries(files)) {
  // './set05_xray/scissors-thumb.webp' -> slug 'set05_xray', move 'scissors'
  const match = path.match(/^\.\/([^/]+)\/(rock|paper|scissors)(-thumb)?\.webp$/);
  if (!match) continue;
  const [, slug, move, isThumb] = match;
  const entry = (registry[slug] ??= {});
  const moveEntry = (entry[move as Choice] ??= {});
  moveEntry[isThumb ? 'thumb' : 'full'] = url;
}

const MOVES: Choice[] = ['rock', 'paper', 'scissors'];

/** Complete sets only — a half-populated folder is treated as absent. */
export const IMAGE_SETS: Record<string, ImageSet> = Object.fromEntries(
  Object.entries(registry).filter(([, set]) =>
    MOVES.every((m) => set[m]?.full && set[m]?.thumb),
  ) as [string, ImageSet][],
);

export function getImageSet(slug: string | null | undefined): ImageSet | null {
  if (!slug) return null;
  return IMAGE_SETS[slug] ?? null;
}
