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
  return ['VITE_ENABLE_MULTIPLAYER', 'VITE_ENABLE_FAST_MODE'].map((k) => [
    k.replace('VITE_ENABLE_', ''),
    read(k) === 'true' ? 'ON' : 'off',
  ]);
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

console.log(`\n${bar}\n`);
