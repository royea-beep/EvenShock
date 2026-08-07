import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEMES } from '../constants/themes';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, 'themes.css'), 'utf8');

/**
 * The canonical token list. Every theme must define every one of these — a
 * theme missing a token resolves to an undefined variable and breaks silently
 * at runtime, which is exactly what this test exists to prevent.
 */
const REQUIRED_TOKENS = [
  // Surfaces
  '--surface-page',
  '--surface-page-image',
  '--surface-card',
  '--surface-elevated',
  // Text
  '--text-primary',
  '--text-muted',
  '--text-inverse',
  // Choices
  '--choice-rock',
  '--choice-rock-ink',
  '--choice-paper',
  '--choice-paper-ink',
  '--choice-scissors',
  '--choice-scissors-ink',
  // Outcomes
  '--outcome-win',
  '--outcome-lose',
  '--outcome-tie',
  // Shape
  '--radius-sm',
  '--radius-md',
  '--radius-choice',
  '--border-width',
  '--border-color',
  '--border-style',
  // Type
  '--font-display',
  '--font-body',
  '--display-transform',
  '--display-tracking',
  // Depth
  '--shadow-card',
  '--shadow-choice',
  '--glow-choice',
  // Motion
  '--motion-ease',
  '--motion-scale',
  // Audio
  '--audio-wave',
  '--audio-base-freq',
  '--audio-detune',
] as const;

/** Extracts the body of a `[data-theme='id'] { ... }` block. */
function themeBlock(id: string): string {
  const start = css.indexOf(`[data-theme='${id}']`);
  if (start === -1) return '';
  const open = css.indexOf('{', start);
  if (open === -1) return '';

  // Brace-count so nested parens/braces in gradients don't end the block early.
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

const ASSET_ROOT = resolve(here, '../assets/themes');
const MOVES = ['rock', 'paper', 'scissors'] as const;

describe('theme picker grid', () => {
  /**
   * The picker lays out 2 columns on mobile and 4 from `sm` up. A theme count
   * that isn't a multiple of 4 leaves a short final row centred under a full
   * one, which reads as a layout bug rather than a decision — that is exactly
   * what nine or seven themes would do here.
   */
  it('has a theme count that fills both the 2-column and 4-column grid', () => {
    expect(THEMES.length % 4, `${THEMES.length} themes leaves an orphaned row`).toBe(0);
  });
});

describe('theme art sets', () => {
  const withArt = THEMES.filter((t) => t.imageSlug);

  it('has at least one theme with no art set, keeping the SVG fallback path shipped', () => {
    expect(THEMES.some((t) => t.imageSlug === null)).toBe(true);
  });

  it.each(withArt.map((t) => [t.id, t.imageSlug] as const))(
    'theme "%s" has all three moves at both sizes in %s',
    (_id, slug) => {
      const missing: string[] = [];
      for (const move of MOVES) {
        for (const file of [`${move}.webp`, `${move}-thumb.webp`]) {
          const path = resolve(ASSET_ROOT, slug!, file);
          if (!existsSync(path) || statSync(path).size === 0) missing.push(`${slug}/${file}`);
        }
      }
      expect(missing, `missing or empty: ${missing.join(', ')}`).toEqual([]);
    },
  );

  it('ships no art folder that no theme references', () => {
    const referenced = new Set(withArt.map((t) => t.imageSlug));
    const onDisk = existsSync(ASSET_ROOT)
      ? readdirSync(ASSET_ROOT).filter((d) => statSync(resolve(ASSET_ROOT, d)).isDirectory())
      : [];
    expect(onDisk.filter((d) => !referenced.has(d))).toEqual([]);
  });
});

describe('theme token parity', () => {
  it('defines a CSS block for every theme in the THEMES array', () => {
    for (const theme of THEMES) {
      expect(themeBlock(theme.id), `missing [data-theme='${theme.id}'] block`).not.toBe('');
    }
  });

  it.each(THEMES.map((t) => t.id))('theme "%s" defines every canonical token', (id) => {
    const block = themeBlock(id);
    const missing = REQUIRED_TOKENS.filter(
      (token) => !new RegExp(`(^|[;{\\s])${token}\\s*:`).test(block),
    );
    expect(missing, `theme "${id}" is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it.each(THEMES.map((t) => t.id))('theme "%s" declares a valid audio waveform', (id) => {
    const block = themeBlock(id);
    const match = block.match(/--audio-wave:\s*([a-z]+)\s*;/);
    expect(match?.[1]).toBeDefined();
    expect(['sine', 'square', 'sawtooth', 'triangle']).toContain(match?.[1]);
  });

  it.each(THEMES.map((t) => t.id))('theme "%s" declares 4 bezier points for motion', (id) => {
    const block = themeBlock(id);
    const match = block.match(/--motion-ease:\s*([^;]+);/);
    const points = match?.[1].split(',').map((n) => Number.parseFloat(n.trim())) ?? [];
    expect(points).toHaveLength(4);
    expect(points.every((n) => Number.isFinite(n))).toBe(true);
  });

  it('defines no tokens in one theme that are absent from another', () => {
    const tokensOf = (id: string) =>
      new Set(
        [...themeBlock(id).matchAll(/(^|[;{\s])(--[a-z0-9-]+)\s*:/g)].map((m) => m[2]),
      );
    const baseline = tokensOf(THEMES[0].id);
    for (const theme of THEMES.slice(1)) {
      expect([...tokensOf(theme.id)].sort(), `"${theme.id}" token set differs`).toEqual(
        [...baseline].sort(),
      );
    }
  });
});
