/**
 * Theme distinguishability and contrast audit.
 *
 * Answers two questions that a theme batch can fail silently:
 *
 *  1. SEPARATION — can a player tell two picker tiles apart? Reported as CIE
 *     Lab dE2000, twice, because the two numbers fail differently:
 *
 *       - PALETTE dE: over the CSS token signature (page, card, elevated, the
 *         three choice fills). This is what the *chrome* around the artwork
 *         looks like, and what the round screen is painted in.
 *       - ARTWORK dE: over the actual rendered thumbnail pixels, downsampled
 *         to a small grid and averaged. This is the honest answer to "are two
 *         tiles indistinguishable", because the tiles are photographs — two
 *         themes can have well-separated tokens and near-identical art.
 *
 *     A batch sharing one colour story (a red/gold/black run, say) will pass
 *     the first and can still fail the second badly. Both are printed; the
 *     smaller one is the one that decides whether a pair is worth keeping.
 *
 *     WHAT THIS NUMBER IS NOT: the artwork dE compares TONE, not technique.
 *     Two sets shot the same way in the same palette score low and genuinely
 *     are confusable; two sets in the same palette rendered differently (a
 *     photograph and a woodcut, say) also score low and are not. So a low
 *     score is a prompt to look at the two tiles, not a verdict on its own.
 *     It is well matched to a single-palette batch, where the collision risk
 *     really is tonal, and it under-reports separation everywhere else.
 *
 *  2. CONTRAST — every text-on-surface pair in every theme against WCAG AA
 *     (4.5:1 for body text). Computed from the browser's own resolved values,
 *     not from the hex in the stylesheet, so `@theme inline` indirection and
 *     any alpha compositing are included.
 *
 * Both are measured in a real browser against the BUILT bundle, for the same
 * reason the leak test is: the tokens only exist after Tailwind resolves them.
 *
 * Usage (Playwright is deliberately not a project dependency):
 *   npm run build && npx vite preview --port 4193
 *   npm i --no-save playwright && node scripts/theme-separation.mjs
 *
 * Env: URL, CHROMIUM_PATH, MIN_DE (default 12), MIN_CONTRAST (default 4.5).
 */
import { chromium } from 'playwright';

const URL = process.env.URL ?? 'http://localhost:4193/evenshock/';
/**
 * Below this dE2000 two themes are not reliably distinguishable at tile size.
 * ~12 is a deliberately forgiving floor: 2.3 is the classic "just noticeable"
 * threshold for adjacent flat patches, but picker tiles are small, textured,
 * separated by gutters and never seen side by side at full size, so the
 * practical threshold is far higher than the textbook one.
 */
const MIN_DE = Number(process.env.MIN_DE ?? 12);
const MIN_CONTRAST = Number(process.env.MIN_CONTRAST ?? 4.5);

/** The tokens that make up a theme's visual signature, in weight order. */
const SIGNATURE = [
  '--surface-page',
  '--surface-card',
  '--surface-elevated',
  '--choice-rock',
  '--choice-paper',
  '--choice-scissors',
];

/** Text-on-surface pairs that must clear AA. Mirrors the header in themes.css. */
const CONTRAST_PAIRS = [
  ['--text-primary', '--surface-page'],
  ['--text-muted', '--surface-page'],
  ['--text-primary', '--surface-card'],
  ['--text-muted', '--surface-card'],
  ['--outcome-win', '--surface-page'],
  ['--outcome-lose', '--surface-page'],
  ['--outcome-tie', '--surface-page'],
  ['--choice-rock-ink', '--choice-rock'],
  ['--choice-paper-ink', '--choice-paper'],
  ['--choice-scissors-ink', '--choice-scissors'],
];

// ---------------------------------------------------------------- colour math

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function rgbToLab([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map((v) => srgbToLinear(v / 255));
  // sRGB -> XYZ (D65)
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27) * t / 116 + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000. Worth the arithmetic: CIE76 badly overstates separation in the
 *  saturated reds this batch of themes lives in. */
function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hp = (b, ap) => {
    if (b === 0 && ap === 0) return 0;
    const h = Math.atan2(b, ap) / rad;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hp(b1, ap1);
  const hp2 = hp(b2, ap2);

  const dLp = L2 - L1;
  const dCp = Cp2 - Cp1;
  let dhp = 0;
  if (Cp1 * Cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dhp * rad) / 2);

  const Lbp = (L1 + L2) / 2;
  const Cbp = (Cp1 + Cp2) / 2;
  let hbp;
  if (Cp1 * Cp2 === 0) hbp = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) hbp = (hp1 + hp2) / 2;
  else hbp = hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * rad) +
    0.24 * Math.cos(2 * hbp * rad) +
    0.32 * Math.cos((3 * hbp + 6) * rad) -
    0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;

  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

const relativeLuminance = ([r, g, b]) => {
  const [lr, lg, lb] = [r, g, b].map((v) => srgbToLinear(v / 255));
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};

const contrastRatio = (fg, bg) => {
  const [a, b] = [relativeLuminance(fg), relativeLuminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

/** Mean of the signature's per-token dE, not the dE of the mean colour: an
 *  average colour hides the case where two themes differ on one loud token and
 *  agree on everything else. */
const signatureDistance = (a, b) =>
  SIGNATURE.reduce((sum, t) => sum + deltaE2000(rgbToLab(a[t]), rgbToLab(b[t])), 0) /
  SIGNATURE.length;

// ------------------------------------------------------------------ in-browser

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });

/**
 * Enumerated from the picker rather than imported from themes.ts on purpose:
 * this measures what actually renders, so a theme present in the data but
 * missing from the grid — or vice versa — shows up as a discrepancy instead of
 * being papered over.
 */
const TILE = '[role="radio"][data-theme]';
const ids = await page.evaluate(
  (sel) => [...document.querySelectorAll(sel)].map((el) => el.getAttribute('data-theme')),
  TILE,
);

if (!ids.length) {
  console.error(`Could not find any theme tiles matching ${TILE} on ${URL}.`);
  await browser.close();
  process.exit(2);
}

// The tiles below the fold are lazy; force every one to load before sampling.
await page.evaluate((sel) => {
  for (const el of document.querySelectorAll(`${sel} img`)) el.loading = 'eager';
}, TILE);
await page.waitForTimeout(1200);

const palettes = {};
for (const id of ids) {
  palettes[id] = await page.evaluate(
    ({ id, tokens }) => {
      const probe = document.createElement('div');
      probe.setAttribute('data-theme', id);
      document.body.appendChild(probe);
      const out = {};
      for (const t of tokens) {
        // Read the token back through a real colour property rather than via
        // getPropertyValue: custom properties hold their literal text ('#efedea'),
        // but `color` is resolved by the browser to rgb() whatever the source
        // notation was — hex, hsl, oklch or a var() chain.
        probe.style.color = `var(${t})`;
        const m = getComputedStyle(probe).color.match(/-?[\d.]+/g);
        out[t] = m ? m.slice(0, 3).map(Number) : null;
      }
      probe.remove();
      return out;
    },
    { id, tokens: [...new Set([...SIGNATURE, ...CONTRAST_PAIRS.flat()])] },
  );
}

/**
 * The tile's own rendered thumbnail, averaged down to an 8x8 grid — 64 Lab
 * samples as the tile's fingerprint. Deliberately the picture the PICKER shows
 * (one representative move), because "two tiles are indistinguishable" is a
 * question about that image and no other.
 *
 * Downsampled rather than compared pixel-for-pixel: at 8x8 the comparison is
 * about tone and layout, which is what survives at 188px on a phone. Fine
 * detail that only resolves at full size is not what makes tiles confusable.
 */
const artwork = {};
for (const id of ids) {
  artwork[id] = await page.evaluate(
    async ({ id, sel }) => {
      const grid = 8;
      const img = document.querySelector(`${sel}[data-theme="${id}"] img`);
      if (!img) return [];
      await img.decode().catch(() => {});
      if (!img.naturalWidth) return [];
      const c = document.createElement('canvas');
      c.width = grid;
      c.height = grid;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, grid, grid);
      const { data } = ctx.getImageData(0, 0, grid, grid);
      const cells = [];
      for (let i = 0; i < data.length; i += 4) cells.push([data[i], data[i + 1], data[i + 2]]);
      return cells;
    },
    { id, sel: TILE },
  );
}

await browser.close();

// ---------------------------------------------------------------------- report

const pad = (s, n) => String(s).padEnd(n);
let failures = 0;

console.log(`\nTHEMES (${ids.length}): ${ids.join(', ')}`);
console.log(
  ids.length % 4 === 0
    ? 'grid invariant : OK (multiple of four)'
    : `grid invariant : FAIL (${ids.length} is not a multiple of four)`,
);
if (ids.length % 4 !== 0) failures += 1;

console.log('\n=== SEPARATION (CIE dE2000, higher is more distinguishable) ===');
console.log(`${pad('pair', 26)}${pad('palette dE', 13)}${pad('artwork dE', 13)}verdict`);

const pairs = [];
for (let i = 0; i < ids.length; i += 1) {
  for (let j = i + 1; j < ids.length; j += 1) {
    const [a, b] = [ids[i], ids[j]];
    const pal = signatureDistance(palettes[a], palettes[b]);
    let art = null;
    if (artwork[a]?.length && artwork[a].length === artwork[b]?.length) {
      const labA = artwork[a].map(rgbToLab);
      const labB = artwork[b].map(rgbToLab);
      art = labA.reduce((s, l, k) => s + deltaE2000(l, labB[k]), 0) / labA.length;
    }
    pairs.push({ a, b, pal, art, worst: Math.min(pal, art ?? Infinity) });
  }
}

for (const p of pairs.sort((x, y) => x.worst - y.worst)) {
  const bad = p.worst < MIN_DE;
  if (bad) failures += 1;
  console.log(
    pad(`${p.a} / ${p.b}`, 26) +
      pad(p.pal.toFixed(1), 13) +
      pad(p.art === null ? 'n/a' : p.art.toFixed(1), 13) +
      (bad ? `TOO CLOSE (< ${MIN_DE})` : 'ok'),
  );
}

console.log(`\n=== CONTRAST (WCAG AA, ${MIN_CONTRAST}:1) ===`);
for (const id of ids) {
  const rows = CONTRAST_PAIRS.map(([fg, bg]) => ({
    fg,
    bg,
    ratio: contrastRatio(palettes[id][fg], palettes[id][bg]),
  })).filter((r) => Number.isFinite(r.ratio));
  const bad = rows.filter((r) => r.ratio < MIN_CONTRAST);
  failures += bad.length;
  const min = rows.reduce((m, r) => (r.ratio < m.ratio ? r : m), rows[0]);
  console.log(
    `${pad(id, 16)}${bad.length ? `${bad.length} FAIL` : 'all pass'}  (tightest: ` +
      `${min.fg} on ${min.bg} = ${min.ratio.toFixed(2)}:1)`,
  );
  for (const r of bad) {
    console.log(`    FAIL ${pad(`${r.fg} on ${r.bg}`, 44)}${r.ratio.toFixed(2)}:1`);
  }
}

console.log(
  failures === 0
    ? '\nPASS - every pair is separable and every text pair clears AA.'
    : `\nFAIL - ${failures} problem(s) above.`,
);
process.exit(failures === 0 ? 0 : 1);
