/**
 * Copies the canonical rules into the Edge Function, byte for byte.
 *
 * The server decides round outcomes and the client cross-checks them, so the
 * two must run identical logic. Rather than trust that two hand-maintained
 * copies stay in step, there is one file and a copy of it, and
 * `rules.sync.test.ts` fails the build if the copy is stale.
 *
 * Run after editing src/utils/rules.ts:  npm run sync:rules
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'src/utils/rules.ts');
const TARGET = join(root, 'supabase/functions/play/rules.ts');

mkdirSync(dirname(TARGET), { recursive: true });

const before = (() => {
  try {
    return readFileSync(TARGET, 'utf8');
  } catch {
    return null;
  }
})();

copyFileSync(SOURCE, TARGET);

const after = readFileSync(TARGET, 'utf8');
console.log(
  before === after
    ? 'rules.ts already in sync — no change'
    : `rules.ts synced -> supabase/functions/play/rules.ts (${after.length} bytes)`,
);
