/**
 * Diagnose the wallet button on the LIVE deployed site. Captures:
 *   - whether the client initialised
 *   - whether import.meta.env survived to runtime
 *   - which wallet extensions are present in the headless browser
 *   - any console errors or unhandled promise rejections during click
 *   - the network responses for the auth endpoints
 *
 * Usage:  URL=https://ftable.co.il/evenshock/ node scripts/wallet-diag.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.URL ?? 'https://ftable.co.il/evenshock/';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const consoleAll = [];
const failures = [];
const requests = [];
page.on('console', (m) => consoleAll.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => failures.push(`reqfailed: ${r.method()} ${r.url()} — ${r.failure()?.errorText}`));
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('qgnxppzchqwpwerajhlu') || u.includes('supabase')) {
    requests.push(`${r.status()} ${r.request().method()} ${u}`);
  }
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Probe: what does the runtime page see?
const runtime = await page.evaluate(() => {
  const w = window;
  return {
    solana: typeof w.solana,
    solanaKeys: w.solana ? Object.keys(w.solana).slice(0, 20) : null,
    ethereum: typeof w.ethereum,
    // Vite inlines env; if the value is literally undefined here, the build
    // didn't have it. If it's a string, it made it.
    // We can't read import.meta from the console; instead look for the key
    // string appearing anywhere in the loaded JS bundles.
  };
});

// Grab a fresh JS bundle URL from the page and fetch it to inspect.
const bundleUrl = await page.evaluate(() => {
  const s = document.querySelector('script[type="module"][src*="index-"]');
  return s ? s.src : null;
});
let bundleHasRef = null;
let bundleHasKey = null;
if (bundleUrl) {
  const r = await page.request.get(bundleUrl);
  const text = await r.text();
  bundleHasRef = text.includes('qgnxppzchqwpwerajhlu.supabase.co');
  bundleHasKey = text.includes('sb_publishable_AQAtj2_LeFBzgTcGX7ibkQ_AbRxrUJt');
}

// Click the wallet button. Take screenshots before and after.
const btn = page.locator('button', { hasText: /Connect wallet|Retry connect|Connecting/ });
const btnVisible = await btn.isVisible().catch(() => false);
await page.screenshot({ path: 'picker-shots/wallet-before.png' });

let clickError = null;
if (btnVisible) {
  try {
    await btn.click({ timeout: 3000 });
  } catch (err) {
    clickError = err instanceof Error ? err.message : String(err);
  }
  // Give the click handler time to run, populate state, and render.
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'picker-shots/wallet-after.png' });
}

// Read whatever text is visible near the wallet button (feedback pill).
const feedback = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button')];
  const wallet = buttons.find((b) => /Connect wallet|Retry connect|Connecting/.test(b.textContent || ''));
  if (!wallet) return null;
  const container = wallet.closest('div');
  return container ? container.textContent : wallet.textContent;
});

await browser.close();

console.log('\nWALLET DIAG:');
console.log(JSON.stringify(
  {
    liveURL: URL,
    runtime,
    bundleUrl,
    bundleHasRef,
    bundleHasKey,
    btnVisible,
    clickError,
    feedback,
    supabaseRequests: requests,
    failures,
    consoleAll,
  },
  null,
  2,
));
