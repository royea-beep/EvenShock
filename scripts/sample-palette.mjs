import sharp from 'sharp';
import { readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'assets-src/rps');

const slugs = process.argv.slice(2);
if (!slugs.length) {
  console.error('usage: node sample-palette.mjs <slug> [slug...]');
  process.exit(1);
}

function toHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

async function analyzeSlug(slug) {
  console.log(`\n=== ${slug} ===`);
  for (const move of ['rock', 'paper', 'scissors']) {
    const src = resolve(SRC, slug, `${move}.png`);
    // Downsample to 32x32 to sample palette efficiently.
    const { data } = await sharp(src)
      .resize(64, 64, { fit: 'cover' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Collect pixels.
    const pixels = [];
    for (let i = 0; i < data.length; i += 3) {
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }

    // Sort by luminance and pick percentile buckets.
    pixels.sort((a, b) => luminance(a) - luminance(b));
    const n = pixels.length;
    const pick = (p) => pixels[Math.floor(n * p)];

    // Also find "most saturated" pixel (peak chroma).
    let maxChroma = -1;
    let peakColor = pixels[0];
    for (const p of pixels) {
      const chroma = Math.max(...p) - Math.min(...p);
      if (chroma > maxChroma) {
        maxChroma = chroma;
        peakColor = p;
      }
    }

    console.log(
      `${move.padEnd(9)} darkest ${toHex(pick(0.02))}  shadow ${toHex(pick(0.15))}  ` +
      `mid ${toHex(pick(0.5))}  highlight ${toHex(pick(0.9))}  peak-chroma ${toHex(peakColor)}`,
    );
  }
}

for (const slug of slugs) await analyzeSlug(slug);
