import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The invariant behind two production bugs, enforced at the source level.
 *
 * Both bugs were the same mistake wearing different clothes: browser code
 * making an assumption that only fails in a browser, in a codebase whose 143
 * tests all run in Node. Testing the two instances would have been treating
 * symptoms — this tests the CLASS, and it is why it lives in the fast Node
 * suite rather than the browser one. It reads files; it needs no runtime at
 * all, and it fails on the pull request that introduces the third instance
 * rather than in someone's private browsing window.
 *
 *   1. `Buffer is not defined` — Node's Buffer used by a library in browser
 *      code. Vite polyfills no Node globals.
 *   2. `sessionStorage.removeItem` on the success path of a submit, unguarded.
 *      Storage access THROWS in private-browsing modes, the throw landed in
 *      the catch for network failures, and a round that had resolved was
 *      retried three times and then shown as failed.
 *
 * Neither would be caught by jsdom, which is a Node process wearing DOM-shaped
 * globals: it has `Buffer`, and its storage never refuses.
 */

const SRC = new URL('../', import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return ['.ts', '.tsx'].includes(extname(full)) ? [full] : [];
  });
}

/** Source files, minus tests — a test may say whatever it needs to. */
const sourceFiles = walk(SRC).filter((f) => !/\.(test|browser\.test)\.tsx?$/.test(f));

/** Strips comments and string literals so prose about a global is not a use. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function findHits(pattern: RegExp, allow: (file: string) => boolean): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles) {
    if (allow(file)) continue;
    const lines = code(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((text, i) => {
      if (pattern.test(text)) hits.push({ file: relative(SRC, file), line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

describe('browser code must not assume Node', () => {
  it('never reaches for a Node global outside the one sanctioned shim', () => {
    // `Buffer` is legitimate in bufferShim.ts, which exists precisely to supply
    // it. Anywhere else it is the bug that stopped every chip purchase.
    const hits = findHits(
      /(^|[^.\w])(Buffer|process|__dirname|__filename)\s*[.[(]/,
      (f) => f.endsWith('utils/bufferShim.ts'),
    );
    expect(hits, formatFailure('Node globals in browser code', hits)).toEqual([]);
  });

  it('never imports a Node built-in', () => {
    const hits = findHits(/from\s+''|require\s*\(/, () => false).filter((h) =>
      /node:|['"](fs|path|crypto|os|child_process)['"]/.test(h.text),
    );
    expect(hits, formatFailure('Node built-in imports', hits)).toEqual([]);
  });
});

describe('browser storage must be treated as able to refuse', () => {
  /**
   * ONE module may touch storage; everything else goes through it.
   *
   * The weaker rule — "a try/catch near every call" — was written first and
   * then tested against the real bug, which it PASSED. The unguarded
   * `sessionStorage.removeItem` was inside a try block; just the wrong one,
   * belonging to a handler that could not tell a storage failure from a dropped
   * request. Proximity to a `try` is not the property that matters. Catching
   * the right error is, and nothing syntactic can see that.
   *
   * So the rule is location, which a scanner CAN see: raw storage access is
   * legal in safeStorage.ts and nowhere else. Reintroducing the bug means
   * writing a raw call in useRounds.ts, and this fails on it.
   */
  const STORAGE_MODULE = 'utils/safeStorage.ts';

  it('is reached only through safeStorage', () => {
    const hits = findHits(/(^|[^.\w])(session|local)Storage\s*\./, (f) =>
      f.endsWith(STORAGE_MODULE),
    );
    expect(hits, formatFailure('raw browser-storage access', hits)).toEqual([]);
  });

  it('and safeStorage itself catches on every one of its own calls', () => {
    const file = sourceFiles.find((f) => f.endsWith(STORAGE_MODULE));
    expect(file, `${STORAGE_MODULE} is missing`).toBeDefined();
    const text = code(readFileSync(file!, 'utf8'));
    const calls = (text.match(/(session|local)Storage\b/g) ?? []).length;
    const guards = (text.match(/catch\s*\{/g) ?? []).length;
    // Every accessor is get/set/remove over two stores, each with its own catch.
    expect(guards, `${STORAGE_MODULE}: ${calls} storage references, ${guards} catch blocks`)
      .toBeGreaterThanOrEqual(3);
  });
});

function formatFailure(what: string, hits: Hit[]): string {
  if (!hits.length) return '';
  return [
    ``,
    `${hits.length} ${what}:`,
    ...hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`),
    ``,
    `This has caused two production bugs. Browser code cannot assume Node's`,
    `globals exist, and cannot assume storage will answer. Wrap the call, or`,
    `route it through a helper that does.`,
    ``,
  ].join('\n');
}
