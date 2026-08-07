/**
 * Statistical leak test for the bot's decoy shuffle.
 *
 * The shuffle puts real move artwork in the bot's slot during the build-up, so
 * "no image is showing" is no longer a sufficient guarantee. This measures the
 * mutual information between WHAT THE SHUFFLE SHOWED and WHAT THE BOT ACTUALLY
 * PICKED, then runs a permutation test against it.
 *
 * Two things this harness gets right, both learned the hard way:
 *  - Every sample is a fresh page load and always round 1. Sampling successive
 *    rounds of a single match correlates the outcome with match progress (the
 *    history trail grows, frame timing shifts), which surfaced as a spurious
 *    p = 0.014 before the harness was corrected.
 *  - Sampling stops before the snap. Frames after the snap legitimately show
 *    the real answer; including them would measure the intended reveal.
 *
 * Usage (Playwright is deliberately not a project dependency):
 *   npm run build && npx vite preview --port 4193
 *   npm i --no-save playwright && node scripts/leak-independence.mjs
 *
 * The structural guarantees are unit-tested in src/utils/shuffle.test.ts. This
 * is the end-to-end check that they survive into the rendered DOM.
 */
import { chromium } from 'playwright';

const URL = process.env.URL ?? 'http://localhost:4193/evenshock/';
const ROUNDS = Number(process.env.ROUNDS ?? 140);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
const page = await context.newPage();
const samples = [];

for (let round = 0; round < ROUNDS; round += 1) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  if (round === 0) {
    await page.evaluate(() => localStorage.setItem('evenshock:theme', 'studio'));
    await page.reload({ waitUntil: 'networkidle' });
  }
  await page.getByText('Start game', { exact: true }).click();
  await page.waitForTimeout(220);

  await page.evaluate(() => {
    window.__trace = [];
    window.__t0 = null;
    document.addEventListener(
      'pointerdown',
      () => {
        if (window.__t0 !== null) return;
        window.__t0 = performance.now();
        const tick = () => {
          const elapsed = performance.now() - window.__t0;
          if (elapsed >= 620) return; // stop before the snap
          const slot = [...document.querySelectorAll('span')]
            .filter((s) => s.textContent === 'Bot')[0]?.parentElement;
          const img = slot?.querySelector('img');
          window.__trace.push({
            t: Math.round(elapsed),
            src: img ? img.getAttribute('src').split('/').pop().split('-')[0] : 'NONE',
          });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { capture: true, once: true },
    );
  });

  await page.getByRole('button', { name: 'Rock', exact: true }).first().click();
  await page.waitForTimeout(1200);

  samples.push(
    await page.evaluate(() => {
      const slot = [...document.querySelectorAll('span')]
        .filter((s) => s.textContent === 'Bot')[0]?.parentElement;
      const img = slot?.querySelector('img');
      return {
        real: img ? img.getAttribute('src').split('/').pop().split('-')[0] : '?',
        trace: window.__trace,
      };
    }),
  );
}
await browser.close();

const valid = samples.filter((s) => s.real !== '?' && s.trace.length > 3);
const count = (arr) => arr.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());

function mutualInformation(labels) {
  const pairs = [];
  valid.forEach((s, i) => s.trace.forEach((pt) => pairs.push(`${pt.src}|${labels[i]}`)));
  const n = pairs.length;
  const joint = count(pairs);
  const px = count(pairs.map((p) => p.split('|')[0]));
  const py = count(pairs.map((p) => p.split('|')[1]));
  let mi = 0;
  for (const [key, v] of joint) {
    const [a, b] = key.split('|');
    mi += (v / n) * Math.log2((v / n) / ((px.get(a) / n) * (py.get(b) / n)));
  }
  return mi;
}

const real = valid.map((s) => s.real);
const observed = mutualInformation(real);

const nullDist = [];
for (let i = 0; i < 4000; i += 1) {
  const permuted = real.slice();
  for (let j = permuted.length - 1; j > 0; j -= 1) {
    const k = Math.floor(Math.random() * (j + 1));
    [permuted[j], permuted[k]] = [permuted[k], permuted[j]];
  }
  nullDist.push(mutualInformation(permuted));
}
nullDist.sort((a, b) => a - b);

const atOrAbove = nullDist.filter((v) => v >= observed).length;
const pValue = (atOrAbove + 1) / (nullDist.length + 1);
const FULL_DISCLOSURE = Math.log2(3);

console.log('samples          :', valid.length, 'fresh round-1 reveals');
console.log('bot choice spread:', JSON.stringify(Object.fromEntries(count(real))));
console.log(
  'observed MI      :',
  observed.toFixed(7),
  `bits (${((100 * observed) / FULL_DISCLOSURE).toFixed(4)}% of a full disclosure)`,
);
console.log('null 95th pct    :', nullDist[Math.floor(0.95 * nullDist.length)].toFixed(7), 'bits');
console.log('permutation p    :', pValue.toFixed(3));
console.log(
  pValue > 0.05
    ? '\nPASS - the shuffle is indistinguishable from a random pairing.'
    : '\nFAIL - the shuffle carries signal about the outcome. Do not ship.',
);
process.exit(pValue > 0.05 ? 0 : 1);
