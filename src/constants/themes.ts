/**
 * Themes are data. Adding a theme is three cheap edits:
 *   1. drop the art folder at src/assets/themes/<slug>/ (see scripts/build-theme-assets.mjs)
 *   2. add a `[data-theme="..."]` block in src/styles/themes.css
 *   3. add an entry here
 * Nothing else in the app changes. Removing one is the same three deletions.
 *
 * `imageSlug` points at the art set. A theme with `null` renders the built-in
 * SVG icons instead — which is also the fallback path when an image fails to
 * load, so keeping at least one such theme shipped keeps that path exercised.
 */
export const THEMES = [
  {
    id: 'studio',
    name: 'Studio',
    blurb: 'Real hands, white sweep, editorial lighting',
    imageSlug: 'set01_studio_hands',
  },
  {
    id: 'marble',
    name: 'Classical Marble',
    blurb: 'Carved hands against gallery grey',
    imageSlug: 'set03_marble',
  },
  {
    id: 'chrome',
    name: 'Liquid Chrome',
    blurb: 'Mirror-polished metal in the dark',
    imageSlug: 'set04_chrome',
  },
  {
    id: 'xray',
    name: 'X-Ray',
    blurb: 'Anatomical scan, phosphor glow',
    imageSlug: 'set05_xray',
  },
  {
    id: 'nature',
    name: 'Macro Nature',
    blurb: 'Real stone, paper and steel in the wild',
    imageSlug: 'set06_macro_nature',
  },
  {
    id: 'product',
    name: 'Product Catalogue',
    blurb: 'Clean studio objects, cool and clinical',
    imageSlug: 'set07_product',
  },
  {
    id: 'zerog',
    name: 'Zero Gravity',
    blurb: 'Floating in deep space',
    imageSlug: 'set08_zerog',
  },
  {
    id: 'pixel',
    name: 'Retro Pixel',
    blurb: '8-bit icons, hard edges, no curves',
    imageSlug: null,
  },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME: ThemeId = THEMES[0].id;

export const THEME_STORAGE_KEY = 'evenshock:theme';

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some((t) => t.id === value);
}

export function themeImageSlug(id: ThemeId): string | null {
  return THEMES.find((t) => t.id === id)?.imageSlug ?? null;
}
