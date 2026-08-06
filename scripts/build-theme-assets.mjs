/**
 * Converts the raw generated art sets in assets-src/rps/ into the WebP assets
 * the app ships, at src/assets/themes/<slug>/.
 *
 * Run:  node scripts/build-theme-assets.mjs
 *
 * Two sizes per move:
 *   <move>.webp        FULL  — 640px, covers a ~320px render on a 2x display
 *   <move>-thumb.webp  THUMB — 160px, for the theme-picker previews
 *
 * Quality is per-set. Most photography survives q78 with no visible loss, but
 * smooth gradients and blown speculars band badly at that level — the x-ray
 * glow and the chrome highlights each get a higher setting, paid for out of the
 * overall budget. Raise a set's number here if a future set looks muddy.
 */
import sharp from 'sharp';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'assets-src/rps');
const OUT = resolve(ROOT, 'src/assets/themes');

const FULL_PX = 640;
const THUMB_PX = 160;
const DEFAULT_QUALITY = 78;

/** Sets whose look depends on smooth gradient or specular detail. */
const QUALITY = {
  set05_xray: 90, // cyan glow falloff bands at low q
  set04_chrome: 86, // specular highlights posterise at low q
  set08_zerog: 84, // starfield + soft vignette
};

const MOVES = ['rock', 'paper', 'scissors'];

function kb(bytes) {
  return (bytes / 1024).toFixed(1).padStart(7) + ' KB';
}

const slugs = readdirSync(SRC).filter((d) => statSync(resolve(SRC, d)).isDirectory()).sort();

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let srcTotal = 0;
let outTotal = 0;
const rows = [];

for (const slug of slugs) {
  const quality = QUALITY[slug] ?? DEFAULT_QUALITY;
  mkdirSync(resolve(OUT, slug), { recursive: true });
  let setSrc = 0;
  let setOut = 0;

  for (const move of MOVES) {
    const src = resolve(SRC, slug, `${move}.png`);
    setSrc += statSync(src).size;

    const full = resolve(OUT, slug, `${move}.webp`);
    await sharp(src).resize(FULL_PX, FULL_PX, { fit: 'cover' }).webp({ quality, effort: 6 }).toFile(full);
    setOut += statSync(full).size;

    const thumb = resolve(OUT, slug, `${move}-thumb.webp`);
    await sharp(src).resize(THUMB_PX, THUMB_PX, { fit: 'cover' }).webp({ quality: 72, effort: 6 }).toFile(thumb);
    setOut += statSync(thumb).size;
  }

  srcTotal += setSrc;
  outTotal += setOut;
  rows.push({ slug, quality, setSrc, setOut });
}

console.log('set                     q      source        shipped   ratio');
for (const r of rows) {
  console.log(
    `${r.slug.padEnd(20)} ${String(r.quality).padStart(3)} ${kb(r.setSrc)} -> ${kb(r.setOut)}   ${(r.setOut / r.setSrc * 100).toFixed(1)}%`,
  );
}
console.log('-'.repeat(66));
console.log(`${'TOTAL'.padEnd(24)} ${kb(srcTotal)} -> ${kb(outTotal)}   ${(outTotal / srcTotal * 100).toFixed(1)}%`);
console.log(`\n${slugs.length} sets, ${slugs.length * MOVES.length * 2} files shipped.`);
