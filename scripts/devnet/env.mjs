/**
 * Environment for the harness. `.env` then `.env.local`, later wins.
 *
 * The service role key is required for setup and NOT for the suite. That split
 * is deliberate: writing `payment_config` and `test_mints` is an operator
 * action, and both tables are correctly revoked from `anon` and `authenticated`
 * — if the harness could reach them with a player's token, that would be the
 * bug. Everything the suite does afterwards goes through ordinary user JWTs,
 * because a test that runs with more privilege than a player is not testing
 * what a player can do.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parse(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const fileEnv = { ...parse(join(ROOT, '.env')), ...parse(join(ROOT, '.env.local')) };
const get = (key) => process.env[key] ?? fileEnv[key];

export const SUPABASE_URL = get('VITE_SUPABASE_URL');
export const ANON_KEY = get('VITE_SUPABASE_ANON_KEY');
export const SERVICE_ROLE_KEY = get('SUPABASE_SERVICE_ROLE_KEY');
export const RPC_URL = get('SOLANA_RPC_URL') ?? 'https://api.devnet.solana.com';

export function requirePublic() {
  if (!SUPABASE_URL || !ANON_KEY) {
    console.error('\n  VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (.env).\n');
    process.exit(1);
  }
}

export function requireServiceRole() {
  requirePublic();
  if (!SERVICE_ROLE_KEY) {
    console.error(
      [
        '',
        '  SUPABASE_SERVICE_ROLE_KEY is not set.',
        '',
        '  Setup writes payment_config and test_mints, which are revoked from',
        '  anon and authenticated on purpose. Put the key in .env.local',
        '  (gitignored) — Supabase dashboard, Project Settings, API keys:',
        '',
        '    SUPABASE_SERVICE_ROLE_KEY=eyJ...',
        '',
        '  The test suite itself does not need it.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}
