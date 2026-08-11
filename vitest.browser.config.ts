import { playwright } from '@vitest/browser-playwright'
import { chromiumLaunchOptions } from './scripts/harness/chromium.mjs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Tests that run in a real browser, because jsdom would have caught neither of
 * the bugs that prompted this.
 *
 * Measured, not assumed — a probe under jsdom reports:
 *
 *   Buffer under jsdom:        function      <- the Buffer bug survives
 *   sessionStorage throws:     false         <- the storage bug survives
 *
 * jsdom is a Node process wearing DOM-shaped globals. Every Node global is
 * still there, and its storage never refuses. Adopting it would have felt like
 * closing the gap while leaving both real failure modes wide open, which is
 * exactly the false confidence that let 18/18 green tests coexist with a
 * purchase flow that could not build a transaction.
 *
 * So: real Chromium. `*.browser.test.ts` files, run by `npm run test:browser`.
 * Slower than Node — a few seconds of startup — which is why it is a separate
 * project rather than the default. The rule for which suite a test belongs in:
 *
 *   src/**\/*.test.ts           pure logic, no globals beyond the language
 *   src/**\/*.browser.test.ts   anything that touches a browser API, or any
 *                               library that assumes a runtime
 *
 * The browser binary is the one already in the image; CI installs its own.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.browser.test.{ts,tsx}'],
    browser: {
      enabled: true,
      provider: playwright({
        // `launchOptions`, not a per-instance `launch` key. And an explicit
        // executable: with `headless: true` Playwright otherwise reaches for a
        // separate `chrome-headless-shell` build that this image does not
        // carry, and fails with a "run npx playwright install" banner that is
        // the wrong advice here — the browser is present, just not that one.
        launchOptions: chromiumLaunchOptions(),
      }),
      headless: true,
      instances: [
        { browser: 'chromium' },
      ],
    },
  },
})
