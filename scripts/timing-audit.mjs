/**
 * Timing audit — measures the transitions that are NOT set by explicit constants
 * in the code (framer-motion default springs on the AnimatePresence screen swaps,
 * plus click/hover response). The rest are read from source in the report below;
 * a mismatch there is a code bug, not a measurement question.
 *
 * Method: instrument the page, drive it through one full round, timestamp each
 * visible transition via a rAF sampler running inside the page. Sequential —
 * one measurement completes before the next starts — because interleaving click
 * dispatch with measurement setup dropped events on the first attempt.
 *
 * Usage:
 *   npm run build && npx vite preview --port 4193 --strictPort
 *   node scripts/timing-audit.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL ?? 'http://localhost:4193/evenshock/';
mkdirSync('picker-shots', { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });

/** Poll body text until it contains `needle`. Return ms from `startAt`. */
async function timeToText(needle, startAt) {
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

/** Wait until element opacity>=0.98 and translateY≈0. Return ms from `startAt`. */
async function timeToSettle(selector, startAt) {
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

/** Wait until element's transform scale crosses `predicate(scale)`. */
async function timeToScale(selector, startAt, predicate) {
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

// ---------------------------------------------------------------- home → round
// Best of 3 so there IS a between-rounds gap to measure. Single Round jumps
// straight to the match-end screen after one pick and there's nothing between.
await page.locator('button[role="radio"]', { hasText: 'Best of 3' }).click();
await page.waitForTimeout(150);

const startBtn = page.locator('button', { hasText: 'Start game' });
await startBtn.waitFor({ state: 'visible' });
const t0 = await page.evaluate(() => performance.now());
await startBtn.click();
const roundVisibleMs = await timeToText('Make your move', t0);
// The picking motion.div has initial y=12, animate y=0. Wait for the choice
// buttons' parent flex row to be settled.
const homeToRoundSettleMs = await timeToSettle(
  'main > div > div',
  t0,
);

// Give React a beat to finalize.
await page.waitForTimeout(300);

// ------------------------------------------------------------ hover on choice
const ROCK_SEL = 'button:has(img[alt="Rock"])';
const rockLoc = page.locator(ROCK_SEL).first();
await rockLoc.waitFor({ state: 'visible' });

// Move somewhere neutral first so the hover is a real state change.
await page.mouse.move(10, 10);
await page.waitForTimeout(200);

const hoverStart = await page.evaluate(() => performance.now());
await rockLoc.hover();
// whileHover={{ scale: 1.08 }} — wait for scale > 1.02 (comfortably clear noise).
const hoverVisibleMs = await timeToScale(ROCK_SEL, hoverStart, (s) => s > 1.02);

// ----------------------------------------------------------- click on choice
// Move away so click isn't a same-target from hover state.
await page.mouse.move(10, 10);
await page.waitForTimeout(300);

// Dispatch mousedown WITHOUT immediately awaiting up/click so we can measure the
// scale-down (whileTap={{ scale: 0.94 }}) before the reveal takes over the DOM.
const box = await rockLoc.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.waitForTimeout(50);
const clickStart = await page.evaluate(() => performance.now());
await page.mouse.down();
const clickVisibleMs = await timeToScale(ROCK_SEL, clickStart, (s) => s < 0.99);
await page.mouse.up();

// ----------------------------------------------------- outcome text appearance
// Reveal takes ~870ms of countdown + ~180ms shoot-hold before outcome text.
// The outcome uses aria-live="polite" and starts at opacity 0 → 1 over 0.25s.
const outcomeMountMs = await page.evaluate(async () => {
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

// Outcome settle: watch the outcome motion.div (opacity + scale).
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
      // The outcome motion.div is the parent of the aria-live paragraph.
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

// ---------------------------------------------- between-rounds gap
// Wait for the "Next round" button to become enabled.
const advanceLoc = page
  .locator('button', { hasText: /Next round|See (match )?results/ })
  .first();
try {
  await advanceLoc.waitFor({ state: 'visible', timeout: 5000 });
  // Small extra wait for advanceReady (holdMs + ADVANCE_FADE_MS after outcome).
  await page.waitForTimeout(700);
} catch {
  await page.screenshot({ path: 'picker-shots/_audit-failure.png' });
  throw new Error('advance button never appeared; see picker-shots/_audit-failure.png');
}

const advanceStart = await page.evaluate(() => performance.now());
await advanceLoc.click();
// Round → picking: wait for the rock choice button to be back and settled.
const pickingBackMs = await timeToText('Make your move', advanceStart);
const pickingSettleMs = await timeToSettle('main > div > div', advanceStart);

await browser.close();

console.log('\nMEASURED (browser, one match sample):');
console.log(JSON.stringify(
  {
    'home → round': {
      firstPaintMs: roundVisibleMs,
      settledMs: homeToRoundSettleMs,
    },
    'hover → visible': { ms: hoverVisibleMs },
    'click → visible': { ms: clickVisibleMs },
    outcome: {
      firstPaintMs: outcomeMountMs.appearedAt,
      settledMs: outcomeSettleMs,
      text: outcomeMountMs.text,
    },
    'between rounds (click Next → picking usable)': {
      firstPaintMs: pickingBackMs,
      settledMs: pickingSettleMs,
    },
  },
  null,
  2,
));
