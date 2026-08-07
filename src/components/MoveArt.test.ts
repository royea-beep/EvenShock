import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getImageSet } from '../assets/themes';
import { THEMES } from '../constants/themes';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'MoveArt.tsx'), 'utf8');

/**
 * MoveArt has two fallback branches, and only one of them used to be covered:
 *
 *   1. `imageSet` is null      — the theme has no art set
 *   2. `onError` fires         — the image failed to load at runtime
 *
 * Shipping Retro Pixel exercised (1) and never (2), which is backwards: (2) is
 * the one that happens in production, on a flaky network, a blocked request or
 * a corrupt file. Now that no theme ships without art, (1) is unreachable in
 * the app — so both are pinned here, and the rendered behaviour of (2) is
 * checked end-to-end in the browser suite by blocking every .webp request.
 */
describe('MoveArt fallback', () => {
  it('resolves no image set for a null slug', () => {
    expect(getImageSet(null)).toBeNull();
    expect(getImageSet(undefined)).toBeNull();
    expect(getImageSet('set99_does_not_exist')).toBeNull();
  });

  it('resolves a complete image set for every shipped theme', () => {
    for (const theme of THEMES) {
      const set = getImageSet(theme.imageSlug);
      expect(set, `${theme.id} has no resolvable art`).not.toBeNull();
      for (const move of ['rock', 'paper', 'scissors'] as const) {
        expect(set![move].full, `${theme.id}/${move} full`).toBeTruthy();
        expect(set![move].thumb, `${theme.id}/${move} thumb`).toBeTruthy();
      }
    }
  });

  it('still wires onError to the fallback, now that no theme ships without art', () => {
    // With every theme carrying art, this handler is the ONLY way the SVG path
    // is ever reached in production. Deleting it as "dead code" would remove
    // the fallback entirely and leave a broken image box in its place.
    expect(source).toMatch(/onError=\{\(\)\s*=>\s*setFailed\(true\)\}/);
    expect(source).toMatch(/const src = failed \? null : imageSet\?\.\[choice\]\?\.\[size\]/);
  });

  it('keeps the accessible name on both branches', () => {
    // The image branch names itself via alt; the icon branch needs the
    // visually-hidden label, or the move loses its name exactly when the
    // artwork is missing and the name matters most.
    expect(source).toMatch(/alt=\{decorative \? '' : label\}/);
    expect(source).toMatch(/<span className="sr-only">\{label\}<\/span>/);
  });
});
