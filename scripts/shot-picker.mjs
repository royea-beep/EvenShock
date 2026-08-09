import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL ?? 'http://localhost:4193/evenshock/';
mkdirSync('picker-shots', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  for (const el of document.querySelectorAll('[role="radio"][data-theme] img')) el.loading = 'eager';
});
await page.waitForTimeout(1500);

const ids = await page.evaluate(() =>
  [...document.querySelectorAll('[role="radio"][data-theme]')].map((el) => el.getAttribute('data-theme')),
);

for (const id of ids) {
  const loc = page.locator(`[role="radio"][data-theme="${id}"]`);
  await loc.screenshot({ path: `picker-shots/${id}.png` });
  console.log(`saved picker-shots/${id}.png`);
}

// Also whole picker view
await page.screenshot({ path: 'picker-shots/_all.png', fullPage: true });
console.log('saved picker-shots/_all.png');

await browser.close();
