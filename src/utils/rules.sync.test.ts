import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getRoundOutcome, type Choice, type RoundOutcome } from './rules';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('rules are shared with the Edge Function, not duplicated', () => {
  it('the deployed copy is byte-identical to the canonical file', () => {
    const canonical = readFileSync(join(root, 'src/utils/rules.ts'), 'utf8');
    const deployed = readFileSync(join(root, 'supabase/functions/play/rules.ts'), 'utf8');

    // If this fails, someone edited one and not the other. Run `npm run sync:rules`.
    // Never fix it by editing supabase/functions/play/rules.ts — that file is generated.
    expect(deployed).toBe(canonical);
  });

  it('the shared file has no imports, so Deno can run it verbatim', () => {
    const canonical = readFileSync(join(root, 'src/utils/rules.ts'), 'utf8');
    const importLines = canonical
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
