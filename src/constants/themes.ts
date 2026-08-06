/**
 * Themes are data. Adding a sixth theme is exactly two edits:
 *   1. a new `[data-theme="..."]` block in src/styles/themes.css
 *   2. a new entry in this array
 * Nothing else in the app needs to change.
 */
export const THEMES = [
  { id: 'neon', name: 'Neon Arcade', blurb: 'Hot pink and cyan, glowing in the dark' },
  { id: 'paper', name: 'Paper & Ink', blurb: 'Off-white stock, black linework' },
  { id: 'pixel', name: 'Retro Pixel', blurb: '8-bit, hard edges, no curves' },
  { id: 'candy', name: 'Candy Pop', blurb: 'Pastel, puffy and bouncy' },
  { id: 'cyber', name: 'Cyber Terminal', blurb: 'Phosphor green on a CRT' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME: ThemeId = THEMES[0].id;

export const THEME_STORAGE_KEY = 'evenshock:theme';

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some((t) => t.id === value);
}
