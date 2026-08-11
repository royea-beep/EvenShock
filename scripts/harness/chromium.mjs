import { existsSync } from 'node:fs';

/**
 * Which Chromium to drive.
 *
 * Three environments, one answer each, and getting this wrong fails in the
 * confusing way — Playwright's "run npx playwright install" banner, which is
 * the wrong advice when a browser is present but at another path.
 *
 *   CHROMIUM_PATH set        use it, no questions
 *   the dev image's build    /opt/pw-browsers/chromium, already there
 *   anywhere else (CI)       undefined, so Playwright resolves its own
 *
 * Returning `undefined` rather than a guess is the important part: a wrong
 * explicit path is an error, while no path at all is Playwright doing what it
 * already knows how to do.
 */
const IMAGE_CHROMIUM = '/opt/pw-browsers/chromium';

export function chromiumExecutablePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync(IMAGE_CHROMIUM)) return IMAGE_CHROMIUM;
  return undefined;
}

/** Launch options, with the key omitted entirely when there is nothing to say. */
export function chromiumLaunchOptions(extra = {}) {
  const executablePath = chromiumExecutablePath();
  return executablePath ? { executablePath, ...extra } : { ...extra };
}
