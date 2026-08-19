import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A licensee configures this product; they do not fork it.
 *
 * That posture is only true while nothing operator-specific is written into
 * source. It held before anyone checked and then quietly stopped holding — the
 * share origin was a literal in `utils/share.ts`, which meant a second
 * operator shipping without editing source would have sent every one of their
 * players' invite links to OUR domain.
 *
 * These tests fail on the next such literal rather than on the next due
 * diligence.
 */

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles('src');
const read = (f: string) => readFileSync(f, 'utf8');

/** brand.ts is where operator-specific values are ALLOWED to appear. */
const BRAND_FILE = 'src/constants/brand.ts';

describe('nothing operator-specific is hard-coded outside brand.ts', () => {
  it('has no deployment domain anywhere else in src', () => {
    const offenders = FILES.filter(
      (f) => f !== BRAND_FILE && /ftable\.co\.il/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('has no brand name literal anywhere else in src', () => {
    // Comments are allowed to name the reference deployment; user-facing
    // strings are not. Strip line comments and block comments before looking.
    const offenders = FILES.filter((f) => {
      if (f === BRAND_FILE) return false;
      const code = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      return /EvenShock/.test(code);
    });
    expect(offenders).toEqual([]);
  });
});

describe('every operator setting is documented', () => {
  const example = readFileSync('.env.example', 'utf8');

  it('lists every VITE_ variable the code actually reads', () => {
    // A setting the code reads but the example does not mention is a setting a
    // licensee cannot know exists — they discover it as a bug in production.
    const used = new Set<string>();
    for (const f of FILES) {
      for (const m of read(f).matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) {
        used.add(m[1]);
      }
    }
    const undocumented = [...used].filter((v) => !example.includes(v)).sort();
    expect(undocumented).toEqual([]);
  });

  it('ships the operator settings unset, so a fallback is never mistaken for a choice', () => {
    for (const key of ['VITE_BRAND_NAME', 'VITE_SHARE_ORIGIN', 'VITE_SUPPORT_CONTACT']) {
      expect(example).toMatch(new RegExp(`^${key}=\\s*$`, 'm'));
    }
  });
});
