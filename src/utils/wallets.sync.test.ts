import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain JS harness module, allowJs without checkJs.
import { HARNESS_WALLETS, LOAD_USER_CAP } from '../../scripts/harness/wallets.mjs';

/**
 * The harness-wallet registry cannot drift from the seeds it describes.
 *
 * WHY THIS RUNS IN `npm test` AND NOT IN THE LIVE SUITE. The failure it guards
 * is a synthetic account being created as an ordinary player — and by the time
 * a live suite could notice, the account exists in production and is already on
 * the ladder. This has to fail before the migration is merged, which means
 * offline, in CI, on the pull request. Same reasoning as rules.sync.test.ts:
 * the drift is cheap to catch statically and expensive to catch at runtime.
 *
 * The migration file is GENERATED from wallets.mjs. This asserts the generator
 * was actually re-run — a seed added to the module but not to the migration
 * means the provisioning trigger will not flag it, and the account is born a
 * player.
 */
const MIGRATION = join(
  import.meta.dirname,
  '../../supabase/migrations/20260813250000_harness_wallets_born_flagged.sql',
);

interface Wallet {
  address: string;
  label: string;
}

describe('harness wallet registry', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const wallets = HARNESS_WALLETS as Wallet[];

  it('registers every wallet the harnesses can derive', () => {
    const missing = wallets.filter((w) => !sql.includes(`('${w.address}'`));
    expect(
      missing.map((w) => `${w.address} (${w.label})`),
      'seeds in wallets.mjs with no row in the migration — regenerate it',
    ).toEqual([]);
  });

  it('registers nothing the module cannot derive', () => {
    // The other direction matters too: a stale address left behind after a seed
    // is rotated would keep flagging a wallet nobody can sign as, which is
    // harmless, and would hide the fact that the generator was not re-run,
    // which is not.
    const inSql = [...sql.matchAll(/\('([1-9A-HJ-NP-Za-km-z]{32,44})',/g)].map((m) => m[1]);
    const derivable = new Set(wallets.map((w) => w.address));
    expect(inSql.filter((a) => !derivable.has(a))).toEqual([]);
  });

  it('covers the full load-user cap, not just the count the script uses today', () => {
    // load-abuse signs in 10 users; the registry covers LOAD_USER_CAP so that
    // nudging that number up does not silently create unregistered accounts.
    // assertLoadUsersRegistered turns going past the cap into an error.
    expect(wallets.filter((w) => w.label.startsWith('load-abuse'))).toHaveLength(LOAD_USER_CAP);
  });

  it('keeps retired seeds registered', () => {
    // fill(9) is the browser harness's original seed. Nothing signs with it any
    // more and its account is still live with 378 rocks on it. Dropping it from
    // the registry is how that account quietly becomes a player again.
    expect(wallets.some((w) => w.label.includes('RETIRED'))).toBe(true);
  });
});
