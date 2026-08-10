/**
 * Copies the shared modules into the Edge Function, byte for byte.
 *
 * Two files travel this path, for the same reason each time — the server and the
 * browser must agree, and two hand-maintained copies eventually will not:
 *
 *   rules.ts    the server decides round outcomes, the client cross-checks them
 *   economy.ts  the server credits balances, the guest demo shows the same
 *               numbers locally; different numbers would make the demo a lie
 *               about the loop it exists to demonstrate
 *
 * `rules.sync.test.ts` fails the build if either copy is stale.
 *
 * Run after editing either canonical file:  npm run sync:rules
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Canonical source -> generated copy. Add a pair here to share another file. */
export const SHARED_FILES = [
  ['src/utils/rules.ts', 'supabase/functions/play/rules.ts'],
  ['src/utils/economy.ts', 'supabase/functions/play/economy.ts'],
];

for (const [from, to] of SHARED_FILES) {
  const source = join(root, from);
  const target = join(root, to);
  mkdirSync(dirname(target), { recursive: true });

  const before = (() => {
    try {
      return readFileSync(target, 'utf8');
    } catch {
      return null;
    }
  })();

  copyFileSync(source, target);
  const after = readFileSync(target, 'utf8');

  console.log(
    before === after
      ? `${from} already in sync — no change`
      : `${from} synced -> ${to} (${after.length} bytes)`,
  );
}
