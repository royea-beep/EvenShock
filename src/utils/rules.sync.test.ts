import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getRoundOutcome, type Choice, type RoundOutcome } from './rules';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Every file that runs in both the browser and the Edge Function. Mirrors
 * SHARED_FILES in scripts/sync-rules.mjs — if that list grows, this one must
 * too, or the new file drifts unwatched.
 */
const SHARED = [
  ['src/utils/rules.ts', 'supabase/functions/play/rules.ts'],
  ['src/utils/economy.ts', 'supabase/functions/play/economy.ts'],
] as const;

describe('shared modules are copied, not duplicated', () => {
  it.each(SHARED)('%s is byte-identical to its deployed copy', (canonical, deployed) => {
    const a = readFileSync(join(root, canonical), 'utf8');
    const b = readFileSync(join(root, deployed), 'utf8');

    // If this fails, someone edited one and not the other. Run `npm run sync:rules`.
    // Never fix it by editing the generated copy — it is overwritten.
    expect(b).toBe(a);
  });

  it.each(SHARED)('%s has no imports, so Deno can run it verbatim', (canonical) => {
    const source = readFileSync(join(root, canonical), 'utf8');
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import[\s{*]/.test(line) || /^\s*export\s+.*\bfrom\b/.test(line));
    expect(importLines).toEqual([]);
  });
});

/**
 * An independently written truth table. The point is NOT to re-derive the
 * result from BEATS — that would just restate the implementation and pass no
 * matter how wrong it was. These nine lines are the rules as a person states
 * them, so a bad edit to the canonical file fails here even though the byte
 * comparison above still passes.
 */
describe('all nine move pairs', () => {
  const EXPECTED: Array<[Choice, Choice, RoundOutcome]> = [
    ['rock', 'rock', 'tie'],
    ['rock', 'paper', 'lose'],
    ['rock', 'scissors', 'win'],
    ['paper', 'rock', 'win'],
    ['paper', 'paper', 'tie'],
    ['paper', 'scissors', 'lose'],
    ['scissors', 'rock', 'lose'],
    ['scissors', 'paper', 'win'],
    ['scissors', 'scissors', 'tie'],
  ];

  it.each(EXPECTED)('%s vs %s is a %s for the player', (player, opponent, expected) => {
    expect(getRoundOutcome(player, opponent)).toBe(expected);
  });

  it('covers every pair exactly once', () => {
    expect(EXPECTED).toHaveLength(9);
    expect(new Set(EXPECTED.map(([p, o]) => `${p}|${o}`)).size).toBe(9);
  });
});
