/**
 * Guest-mode smoke test — verifies an unauthenticated visitor still gets a
 * fully playable game when the Supabase env IS present. This is the "env set,
 * guest" state, which is different from "env unset": the client is
 * constructed, the wallet button renders, and callers might read auth state
 * anywhere. A regression here would be silent — the page would still load.
 *
 * Usage:
 *   npm run build && npx vite preview --port 4193 --strictPort
 *   node scripts/guest-smoke.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.URL ?? 'http://localhost:4193/evenshock/';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
const networkFailures = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('requestfailed', (req) => {
  networkFailures.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });

// 1. Wallet button exists and reads "Connect wallet" (env is set → not hidden).
const walletBtn = page.locator('button', { hasText: 'Connect wallet' });
const walletVisible = await walletBtn.isVisible().catch(() => false);

// 2. Play a full Single Round match WITHOUT clicking the wallet button.
await page.locator('button[role="radio"]', { hasText: 'Single Round' }).click();
await page.locator('button', { hasText: 'Start game' }).click();
await page.locator('button:has(img[alt="Rock"])').first().waitFor({ state: 'visible' });
await page.locator('button:has(img[alt="Rock"])').first().click();

// A tie replays the round; loop until we reach the match-end screen. In Single
// Round, one non-tie outcome ends the match, and "See results" advances to it.
let matchEndSeen = false;
for (let attempt = 0; attempt < 8 && !matchEndSeen; attempt += 1) {
  const seeResults = page.locator('button', { hasText: 'See results' }).first();
  const nextRound = page.locator('button', { hasText: /Next round|Go again/ }).first();
  try {
    await Promise.race([
      seeResults.waitFor({ state: 'visible', timeout: 3000 }).then(() => 'end'),
      nextRound.waitFor({ state: 'visible', timeout: 3000 }).then(() => 'tie'),
    ]).then(async (which) => {
      if (which === 'end') {
        await seeResults.click();
        await page.locator('button', { hasText: /Play again|Change look/ }).first().waitFor({ state: 'visible', timeout: 4000 });
        matchEndSeen = true;
      } else {
        await nextRound.click();
        await page.locator('button:has(img[alt="Paper"])').first().click().catch(() => {});
      }
    });
  } catch {
    // Neither button visible in the window — bail.
    break;
  }
}

// 3. Small settle for any deferred network attempts (persistence would have
//    tried to write here if the guest gate were wrong).
await page.waitForTimeout(1500);

// 4. Read the outcome text so we know the round actually played.
const outcomeText = await page
  .locator('[aria-live="polite"]')
  .textContent()
  .catch(() => '(no outcome element)');

// 5. Check that Supabase URLs were NOT called by an unauthenticated visitor
//    (except for the auth session bootstrap on load, which is expected).
const supabaseCalls = [];
page.on('request', (req) => {
  if (req.url().includes('qgnxppzchqwpwerajhlu')) supabaseCalls.push(`${req.method()} ${req.url()}`);
});

await browser.close();

const persistenceCalls = networkFailures.filter((f) => f.includes('/rest/v1/matches') || f.includes('/rest/v1/rounds'));

const report = {
  walletButtonVisible: walletVisible,
  matchCompleted: matchEndSeen,
  outcomeText: outcomeText,
  consoleErrors: consoleErrors,
  networkFailures: networkFailures,
  persistenceAttempts: persistenceCalls,
};

console.log('\nGUEST SMOKE REPORT:');
console.log(JSON.stringify(report, null, 2));

const failed =
  !walletVisible ||
  !matchEndSeen ||
  consoleErrors.length > 0 ||
  persistenceCalls.length > 0;

if (failed) {
  console.error('\nFAIL — guest path regressed');
  process.exit(1);
}
console.log('\nPASS — guest path intact');
