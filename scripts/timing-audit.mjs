/**
 * Timing audit — measures the transitions that are NOT set by explicit constants
 * in the code (framer-motion default springs on the AnimatePresence screen swaps,
 * plus click/hover response), and — with `?impact=<v>` — the four impact
 * variants' impact duration, pick-to-outcome time, and horizontal-overflow
 * behaviour across six viewport widths.
 *
 * Method: instrument the page, drive it through one round, timestamp each
 * visible transition via a rAF sampler running inside the page. Sequential —
 * one measurement completes before the next starts — because interleaving click
 * dispatch with measurement setup dropped events on the first attempt.
 *
 * Usage:
 *   npm run build && npx vite preview --port 4193 --strictPort
 *   node scripts/timing-audit.mjs                 # baseline (impact=a implied)
 *   node scripts/timing-audit.mjs --variants      # measures all four variants
 *   node scripts/timing-audit.mjs --overflow      # sweeps 6 widths for D
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.URL ?? 'http://localhost:4193/evenshock/';
const ARGS = new Set(process.argv.slice(2));

async function runAudit({ browser, variant, viewport }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const url = variant ? `${BASE_URL}?impact=${variant}` : BASE_URL;
  await page.goto(url, { waitUntil: 'networkidle' });

  // Best of 3 so the between-rounds gap is measurable, then Start.
  // For per-variant impact measurement, Single Round is enough — see comment
  // in the switcher: Single Round already gives every round the deciding
  // treatment, which is where variants show their full intensity.
  const format = variant ? 'Single Round' : 'Best of 3';
  await page.locator('button[role="radio"]', { hasText: format }).click();
  await page.waitForTimeout(150);

  // ------------------------------------------------------------ home → round
  const startBtn = page.locator('button', { hasText: 'Start game' });
  await startBtn.waitFor({ state: 'visible' });
  const t0 = await page.evaluate(() => performance.now());
  await startBtn.click();
  const roundVisibleMs = await timeToText(page, 'Make your move', t0);
  const homeToRoundSettleMs = await timeToSettle(page, 'main > div > div', t0);
  await page.waitForTimeout(300);

  // ------------------------------------------------------- hover on a choice
  const ROCK_SEL = 'button:has(img[alt="Rock"])';
  const rockLoc = page.locator(ROCK_SEL).first();
  await rockLoc.waitFor({ state: 'visible' });
  await page.mouse.move(10, 10);
  await page.waitForTimeout(200);
  const hoverStart = await page.evaluate(() => performance.now());
  await rockLoc.hover();
  const hoverVisibleMs = await timeToScale(page, ROCK_SEL, hoverStart, (s) => s > 1.02);

  // ------------------------------------------------------- click and measure
  await page.mouse.move(10, 10);
  await page.waitForTimeout(300);
  const box = await rockLoc.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(50);
  const clickStart = await page.evaluate(() => performance.now());

  // Optionally sample scroll overflow every frame from click through impact.
  // The audit runs a background loop in the page; we tear it down after the
  // outcome settles and read the recorded max delta.
  const willSampleOverflow = ARGS.has('--overflow') || variant === 'd';
  if (willSampleOverflow) {
    await page.evaluate(() => {
      window.__overflowMax = 0;
      window.__overflowSamples = 0;
      const scroller = document.scrollingElement || document.documentElement;
      const tick = () => {
        const delta = scroller.scrollWidth - scroller.clientWidth;
        if (delta > window.__overflowMax) window.__overflowMax = delta;
        window.__overflowSamples += 1;
        window.__overflowRaf = requestAnimationFrame(tick);
      };
      window.__overflowRaf = requestAnimationFrame(tick);
    });
  }

  await page.mouse.down();
  const clickVisibleMs = await timeToScale(page, ROCK_SEL, clickStart, (s) => s < 0.99);
  await page.mouse.up();

  // ----------------------------------------------------- outcome text
  const outcome = await page.evaluate(async () => {
    const start = performance.now();
    return await new Promise((resolve) => {
      const tick = () => {
        const el = document.querySelector('[aria-live="polite"]');
        if (el && el.textContent && el.textContent.trim().length > 0) {
          resolve({ appearedAt: performance.now() - start, text: el.textContent.trim() });
          return;
        }
        if (performance.now() - start > 5000) {
          resolve({ appearedAt: -1, text: '' });
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
  });

  const outcomeSettleMs = await page.evaluate(async () => {
    const start = performance.now();
    return await new Promise((resolve) => {
      const isSettled = (el) => {
        const cs = getComputedStyle(el);
        if (Number(cs.opacity) < 0.98) return false;
        const t = cs.transform;
        if (!t || t === 'none') return true;
        const nums = t.match(/-?\d+(?:\.\d+)?/g);
        if (!nums) return true;
        const scale = Number(nums[0]);
        return Math.abs(scale - 1) < 0.01;
      };
      const tick = () => {
        const el = document.querySelector('[aria-live="polite"]')?.parentElement;
        if (el && isSettled(el)) {
          resolve(performance.now() - start);
          return;
        }
        if (performance.now() - start > 3000) {
          resolve(-1);
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
  });

  // --------------------------------------- impact duration (variant-specific)
  // Impact "done" is when the hand animation settles — the loser reaches its
  // final position and stops. Watch the player-side hand for the win case, the
  // bot-side hand for the loss case, or either for tie.
  const impactDurationMs = await page.evaluate(async () => {
    const start = performance.now();
    return await new Promise((resolve) => {
      const isSettled = (el) => {
        const cs = getComputedStyle(el);
        const t = cs.transform;
        if (!t || t === 'none') return true;
        // Watch for two consecutive stable frames.
        const key = t;
        el.__lastTransform = el.__lastTransform || '';
        const stable = el.__lastTransform === key;
        el.__lastTransform = key;
        return stable;
      };
      const tick = () => {
        const hands = document.querySelectorAll(
          'main img[alt="Rock"], main img[alt="Paper"], main img[alt="Scissors"]',
        );
        // Look at the outermost animated hand containers (grandparent of img).
        const containers = Array.from(hands)
          .map((img) => img.closest('[style*="width"]'))
          .filter(Boolean);
        if (containers.length && containers.every(isSettled)) {
          resolve(performance.now() - start);
          return;
        }
        if (performance.now() - start > 3000) {
          resolve(-1);
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
  });

  let overflowMax = null;
  let overflowSamples = null;
  if (willSampleOverflow) {
    await page.waitForTimeout(400);
    const stats = await page.evaluate(() => {
      cancelAnimationFrame(window.__overflowRaf);
      return { max: window.__overflowMax, samples: window.__overflowSamples };
    });
    overflowMax = stats.max;
    overflowSamples = stats.samples;
  }

  await context.close();

  return {
    variant: variant || 'a (implicit)',
    viewport,
    homeToRound: { firstPaintMs: round(roundVisibleMs), settledMs: round(homeToRoundSettleMs) },
    hoverToVisibleMs: round(hoverVisibleMs),
    clickToVisibleMs: round(clickVisibleMs),
    outcome: { firstPaintMs: round(outcome.appearedAt), settledMs: round(outcomeSettleMs), text: outcome.text },
    impactDurationMs: round(impactDurationMs),
    pickToOutcomeMs: round(outcome.appearedAt),
    overflow: willSampleOverflow ? { maxPx: round(overflowMax), samples: overflowSamples } : null,
  };
}

async function timeToText(page, needle, startAt) {
  return await page.evaluate(
    async ({ needle, startAt }) => {
      return await new Promise((resolve) => {
        const tick = () => {
          if (document.body.textContent.includes(needle)) {
            resolve(performance.now() - startAt);
            return;
          }
          if (performance.now() - startAt > 6000) {
            resolve(-1);
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
      });
    },
    { needle, startAt },
  );
}

async function timeToSettle(page, selector, startAt) {
  return await page.evaluate(
    async ({ selector, startAt }) => {
      const isSettled = (el) => {
        const cs = getComputedStyle(el);
        if (Number(cs.opacity) < 0.98) return false;
        const t = cs.transform;
        if (!t || t === 'none') return true;
        const nums = t.match(/-?\d+(?:\.\d+)?/g);
        if (!nums) return true;
        const arr = nums.map(Number);
        const ty = arr.length === 16 ? arr[13] : arr[5] ?? 0;
        return Math.abs(ty) < 0.5;
      };
      return await new Promise((resolve) => {
        const tick = () => {
          const el = document.querySelector(selector);
          if (el && isSettled(el)) {
            resolve(performance.now() - startAt);
            return;
          }
          if (performance.now() - startAt > 6000) {
            resolve(-1);
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
      });
    },
    { selector, startAt },
  );
}

async function timeToScale(page, selector, startAt, predicate) {
  return await page.evaluate(
    async ({ selector, startAt, predicateSrc }) => {
      // eslint-disable-next-line no-new-func
      const predicate = new Function('scale', `return (${predicateSrc})(scale)`);
      const el = document.querySelector(selector);
      if (!el) return -1;
      return await new Promise((resolve) => {
        const tick = () => {
          const t = getComputedStyle(el).transform;
          if (t && t !== 'none') {
            const nums = t.match(/-?\d+(?:\.\d+)?/g);
            if (nums) {
              const scale = Number(nums[0]);
              if (predicate(scale)) {
                resolve(performance.now() - startAt);
                return;
              }
            }
          }
          if (performance.now() - startAt > 3000) {
            resolve(-1);
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
      });
    },
    { selector, startAt, predicateSrc: predicate.toString() },
  );
}

const round = (n) => (n === null || n === undefined ? null : Math.round(n));

// ---------------------------------------------------------------- entry point

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

const results = [];

if (ARGS.has('--variants')) {
  for (const v of ['a', 'b', 'c', 'd']) {
    results.push(await runAudit({ browser, variant: v, viewport: { width: 1280, height: 900 } }));
  }
} else {
  results.push(await runAudit({ browser, variant: null, viewport: { width: 1280, height: 900 } }));
}

if (ARGS.has('--overflow')) {
  // Sweep D — the throw-off-screen variant — at the six standard widths.
  for (const width of [320, 375, 768, 1024, 1440, 1920]) {
    results.push(await runAudit({ browser, variant: 'd', viewport: { width, height: 800 } }));
  }
}

await browser.close();

console.log('\nRESULTS:');
for (const r of results) {
  console.log(JSON.stringify(r, null, 2));
}
