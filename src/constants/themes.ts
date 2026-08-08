/**
 * Themes are data. Adding a theme is three cheap edits:
 *   1. drop the art folder at src/assets/themes/<slug>/ (see scripts/build-theme-assets.mjs)
 *   2. add a `[data-theme="..."]` block in src/styles/themes.css
 *   3. add an entry here
 * Nothing else in the app changes. Removing one is the same three deletions.
 *
 * Keep the count a MULTIPLE OF FOUR. The picker lays out 2 columns on mobile
 * and 4 from `sm` up; anything else leaves a short row centred under a full
 * one, which reads as a bug. `themes.test.ts` asserts it.
 *
 * The four are deliberately spread rather than four variations on a mood: two
 * light grounds and two dark, two photoreal and two stylised. That spread is
 * what keeps them distinguishable at tile size.
 *
 * `imageSlug` may be null for a theme with no art set, which renders the
 * built-in SVG icons. No theme ships that way: the SVG path is the image-load
 * FALLBACK, and it is covered by tests — including the "image failed to load"
 * branch that a shipped SVG theme never exercised — rather than by spending a
 * picker slot on it.
 */
export const THEMES = [
  {
    id: 'studio',
    name: 'Studio Photography',
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
    id: 'ink',
    name: 'Ink Brush',
    blurb: 'Brushed in ink on warm paper',
    imageSlug: 'set17_ink',
  },
  {
    id: 'molten',
    name: 'Molten Lava',
    blurb: 'Cracked crust over glowing heat',
    imageSlug: 'set12_molten',
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
