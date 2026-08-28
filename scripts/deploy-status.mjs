/**
 * What a player can actually touch, versus what merely exists.
 *
 *   npm run status
 *
 * THIS EXISTS BECAUSE A REPORT WAS TRUE AND MISLEADING AT THE SAME TIME.
 * "Phase 1 is live" and "stake tables are live" were true of the DATABASE —
 * the tables, the escrow, the rake and the commit-reveal protocol were all
 * deployed and proven. No screen called any of it, and none of the client work
 * had left the branch. Three rounds of debugging went into a missing UI that
 * was never there, chasing a cache and then a feature flag.
 *
 * The trap is structural, not a lapse of attention: MIGRATIONS AND APP CODE
 * REACH PRODUCTION BY DIFFERENT ROUTES. A migration applied over MCP is live
 * the moment it returns — no branch, no pull request, no CI. App code only
 * ships by merging to main, where CI builds it and FTPs dist/ to the host. So
 * the database can be five migrations ahead of an app that has not moved in
 * days, and every local check will pass while production has neither half.
 *
 * "Live" means a player can touch it. This prints the two columns separately
 * and refuses to blur them.
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE_KEY } from './harness/env.mjs';

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const quiet = (cmd, fallback = '') => {
  try {
    return sh(cmd);
  } catch {
    return fallback;
  }
};

quiet('git fetch origin --quiet');

const branch = sh('git rev-parse --abbrev-ref HEAD');
const mainRef = quiet('git rev-parse --verify origin/main', '');
const head = sh('git rev-parse HEAD');

const ahead = mainRef ? quiet(`git rev-list --count origin/main..${head}`, '?') : '?';
const merged = mainRef ? quiet(`git branch --contains ${head} -r`, '').includes('origin/main') : false;

const files = (range) =>
  mainRef ? quiet(`git diff --name-only ${range}`, '').split('\n').filter(Boolean) : [];
const unmerged = files(`origin/main...${head}`);
const appCode = unmerged.filter((f) => f.startsWith('src/') || f === 'index.html');
const migrations = unmerged.filter((f) => f.startsWith('supabase/migrations/'));
const functions = unmerged.filter((f) => f.startsWith('supabase/functions/'));

/** Build flags as the DEPLOYED build would see them: committed .env, plus any
 *  CI environment, since that is what compiles the bundle players download. */
function flags() {
  let env = '';
  try {
    env = readFileSync('.env', 'utf8');
  } catch {
    /* no committed env */
  }
  const read = (key) => {
    const fromProcess = process.env[key];
    if (fromProcess !== undefined) return fromProcess;
    return env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  };
  // STAKE_TABLES belongs here more than either of the others: it is the flag
  // whose state a reader most needs to be sure of, and it was missing from
  // this report for exactly as long as it existed.
  return ['VITE_ENABLE_MULTIPLAYER', 'VITE_ENABLE_STAKE_TABLES', 'VITE_ENABLE_FAST_MODE'].map((k) => [
    k.replace('VITE_ENABLE_', ''),
    read(k) === 'true' ? 'ON' : 'off',
  ]);
}

/**
 * Server-side flags, read from the LIVE database — never from this checkout
 * and never from memory. This section exists because a completion report once
 * hand-wrote "geo_blocking on" while the database said `enabled = false`: the
 * system was right and the report was wrong, about a compliance control on the
 * mainnet checklist. A status line that misreports a flag is exactly how
 * something ships in the wrong state.
 *
 * The values come from the database's OWN decision functions —
 * `geo_blocking_enabled()` (missing row = ON) and `flag_enabled()` (missing
 * row = off) — not from re-reading `feature_flags` here, because duplicating
 * their fail-open/fail-closed semantics in JS is how the report and the
 * server drift apart again.
 *
 * When the flags cannot be read (no service key, no network), that is what
 * gets printed. An unreadable compliance flag is a visible problem; a guessed
 * one is a hidden one.
 */
async function serverFlags() {
  const FLAGS = [
    ['geo_blocking', 'geo_blocking_enabled', {}],
    ['stake_tables', 'flag_enabled', { p_key: 'stake_tables' }],
  ];
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return FLAGS.map(([name]) => [name, 'unreadable — set SUPABASE_SERVICE_ROLE_KEY (.env.local)']);
  }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // One 5s budget shared by both reads: a status report that hangs is a
  // status report nobody runs.
  const deadline = new Promise((resolve) => {
    const t = setTimeout(() => resolve({ error: { message: 'timeout' } }), 5_000);
    t.unref?.();
  });
  return await Promise.all(
    FLAGS.map(async ([name, fn, args]) => {
      const { data, error } = await Promise.race([admin.rpc(fn, args), deadline]);
      if (error) return [name, `unreadable — db unreachable (${error.message})`];
      return [name, data === true ? 'ON' : 'off'];
    }),
  );
}

const migrationCount = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).length;

const bar = '─'.repeat(64);
console.log(`\n${bar}`);
console.log('  DEPLOY STATUS — "live" means a player can touch it');
console.log(bar);

console.log('\n  ON MAIN, AND THEREFORE DEPLOYED');
console.log(`    main            ${quiet('git log -1 --format="%h  %s" origin/main', 'unknown')}`);
console.log('    route           merge to main -> CI builds -> FTP to ftable.co.il/evenshock/');

console.log('\n  ON A BRANCH, AND THEREFORE NOT');
if (merged || (ahead === '0' && unmerged.length === 0)) {
  console.log('    nothing — this branch is contained in main');
} else {
  console.log(`    branch          ${branch}  (${ahead} commit${ahead === '1' ? '' : 's'} ahead)`);
  console.log(`    app code        ${appCode.length} file${appCode.length === 1 ? '' : 's'}${appCode.length ? ' — INVISIBLE to players until merged' : ''}`);
  console.log(`    edge functions  ${functions.length}${functions.length ? ' — deployed separately, check they match' : ''}`);
}

console.log('\n  IN THE DATABASE ALREADY, WHATEVER THIS BRANCH SAYS');
console.log(`    migration files ${migrationCount} in the repo`);
if (migrations.length) {
  console.log(`    unmerged ones   ${migrations.length} — applied over MCP, so LIVE regardless of this branch:`);
  for (const m of migrations) console.log(`                      ${m.replace('supabase/migrations/', '')}`);
}
console.log('    caution         a migration bypasses the branch and CI entirely.');
console.log('                    Server capability is not the same as player reach.');

console.log('\n  FLAGS IN THE DEPLOYED BUILD');
for (const [name, value] of flags()) console.log(`    ${name.padEnd(14)}${value}`);

console.log('\n  SERVER FLAGS — read from the live database, not from this checkout');
for (const [name, value] of await serverFlags()) console.log(`    ${name.padEnd(14)}${value}`);

console.log(`\n${bar}\n`);
