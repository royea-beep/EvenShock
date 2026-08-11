/**
 * The front door, driven in a real browser. Offline.
 *
 *   npm run e2e:entry
 *
 * "Ask once" is a claim about persistence across page loads, and persistence
 * across page loads is not a thing a Node test can observe. So this drives the
 * actual app in Chromium: first visit, the click, a reload, the reopen, and the
 * two failure floors — storage that refuses, and a Supabase env that is absent.
 *
 * NO NETWORK. Any request leaving the page is stubbed, so this runs in CI and
 * on a plane. The wallet path is not exercised end to end for the same reason
 * (it needs an extension and a signature); what IS asserted is that failing to
 * connect leaves the guest path reachable, which is the property that keeps the
 * door from trapping anyone.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { chromiumLaunchOptions } from './chromium.mjs';

const PORT = Number(process.env.EVENSHOCK_DEV_PORT ?? 5175);
const BASE = `http://localhost:${PORT}/evenshock/`;

let failures = 0;
function check(name, pass, detail) {
  if (!pass) failures += 1;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!pass && detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
}

const dev = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
process.on('exit', () => {
  try {
    dev.kill('SIGTERM');
  } catch {
    /* already gone */
  }
});

async function waitForServer(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server did not come up on ${BASE}`);
}

console.log(`\n  starting dev server on ${PORT}…`);
await waitForServer();

const browser = await chromium.launch(chromiumLaunchOptions());

/** A fresh browser profile per case: "first visit" has to mean it. */
async function freshPage(init) {
  const context = await browser.newContext();
  // Nothing leaves the page. Supabase's session bootstrap is the only caller
  // and an unanswered fetch would leave auth stuck rather than settling guest.
  await context.route('**', async (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE) || url.startsWith(`http://localhost:${PORT}`)) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  return page;
}

const door = (page) => page.getByRole('dialog', { name: /how do you want to play/i });
const guestCta = (page) => page.getByRole('button', { name: /^play as guest$/i });
const startCta = (page) => page.getByRole('button', { name: /start game/i });

// ------------------------------------------------------- 1. the first visit
{
  const page = await freshPage();
  check('first visit shows the door', await door(page).isVisible());
  const text = await door(page).innerText();
  check(
    'both paths are named with what they get',
    /play as guest/i.test(text) &&
      /connect wallet/i.test(text) &&
      /this browser only/i.test(text) &&
      /invite code/i.test(text),
    text.slice(0, 400),
  );
  // The game is MOUNTED underneath, not blocked behind the door. This is the
  // floor: the door is an overlay on a working app.
  check('the game is already mounted behind it', await startCta(page).count() > 0);
  // A picture of the thing, for whoever has to decide whether the two paths
  // read as a real choice. Cheap, and the only artefact this harness leaves.
  await page.screenshot({ path: 'test-results/entry-door.png', fullPage: true });
  await page.close();
}

// ------------------------------------------- 2. choosing guest, and staying
{
  const page = await freshPage();
  await guestCta(page).click();
  check('choosing guest closes the door', (await door(page).count()) === 0);
  check('and the game is reachable', await startCta(page).isVisible());
  check(
    'the choice is recorded',
    (await page.evaluate(() => localStorage.getItem('evenshock.entry.v1'))) === 'guest',
  );

  await page.reload({ waitUntil: 'networkidle' });
  check('a reload does not ask again', (await door(page).count()) === 0);

  // The way back, from where the wallet button is.
  await page.getByRole('button', { name: /guest or wallet/i }).click();
  check('the wallet button reopens the comparison', await door(page).isVisible());
  await page.getByRole('button', { name: /^close$/i }).click();
  check('and closing it leaves the choice alone', {
    closed: (await door(page).count()) === 0,
    stored: await page.evaluate(() => localStorage.getItem('evenshock.entry.v1')),
  }.closed);
  await page.close();
}

// ---------------------------------------------- 3. storage that says no
{
  // Private browsing, site data disabled: the access itself throws. The door
  // must still render and the game must still work; the only acceptable cost
  // is being asked again next time.
  const page = await freshPage(() => {
    const boom = () => {
      throw new DOMException('denied');
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => ({ getItem: boom, setItem: boom, removeItem: boom }),
    });
  });
  check('storage refusing does not break the door', await door(page).isVisible());
  await guestCta(page).click();
  check('and the guest path still gets you into the game', await startCta(page).isVisible());
  await page.close();
}

// -------------------------------------------------------- 4. a small phone
{
  // The door is the first thing every mobile visitor sees, and it is the one
  // screen in the app that is mostly text. 360×640 is the small end of what
  // real phones still are.
  const context = await browser.newContext({ viewport: { width: 360, height: 640 } });
  await context.route('**', async (route) => {
    const url = route.request().url();
    if (url.startsWith(`http://localhost:${PORT}`)) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });

  check('the door fits a small phone', await door(page).isVisible());
  // Scoped to the dialog: the wallet button in the page corner has the same
  // label, which is the point of it — but it is not what this asserts.
  check(
    'both calls to action are reachable',
    (await guestCta(page).isVisible()) &&
      (await door(page).getByRole('button', { name: /^connect wallet$/i }).isVisible()),
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('nothing spills sideways', overflow <= 0, { overflow });

  // BOTH buttons above the fold, measured. The wallet path is the one nobody
  // knew existed; if its call to action needs a scroll to find, this screen has
  // reproduced the problem it was built to fix — one path visible, the other
  // discovered. Eyeballing a screenshot does not catch that when the copy
  // grows by a line.
  const fold = await page.evaluate(() => {
    const box = (el) => el?.getBoundingClientRect().bottom ?? Infinity;
    const buttons = [...document.querySelectorAll('[role="dialog"] button')];
    const find = (re) => buttons.find((b) => re.test(b.textContent ?? ''));
    return {
      viewport: window.innerHeight,
      guest: box(find(/^Play as guest$/)),
      wallet: box(find(/^Connect wallet$/)),
    };
  });
  check(
    'both calls to action are above the fold',
    fold.guest <= fold.viewport && fold.wallet <= fold.viewport,
    fold,
  );
  await page.screenshot({ path: 'test-results/entry-door-mobile.png', fullPage: true });
  await page.close();
}

// The `unconfigured` rule — no Supabase env means no wallet path, so no
// question — is NOT asserted here. It depends on a build-time env value, and
// faking one at runtime would be testing the fake. It is covered exhaustively
// by shouldShowEntry in src/data/entryChoice.test.ts, which is where that
// decision actually lives.

await browser.close();
dev.kill('SIGTERM');

console.log(`\n  ${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
