import { describe, expect, it } from 'vitest';
import { SHARE_ORIGIN, buildInviteUrl, buildShareLine, readInviteCodeFromUrl } from './share';

describe('buildInviteUrl', () => {
  it('appends the invite code as an upper-cased query param', () => {
    const url = buildInviteUrl('abcd1234');
    expect(url).toBe(`${SHARE_ORIGIN}?invite=ABCD1234`);
  });

  it('returns the bare origin for an empty code', () => {
    expect(buildInviteUrl('')).toBe(SHARE_ORIGIN);
    expect(buildInviteUrl('   ')).toBe(SHARE_ORIGIN);
  });
});

describe('readInviteCodeFromUrl', () => {
  it('reads a valid code and upper-cases it', () => {
    expect(readInviteCodeFromUrl({ search: '?invite=abc123' })).toBe('ABC123');
  });

  it('returns null when the param is absent', () => {
    expect(readInviteCodeFromUrl({ search: '' })).toBeNull();
    expect(readInviteCodeFromUrl({ search: '?theme=frost' })).toBeNull();
  });

  it('rejects codes outside the alphanumeric 4-16 range', () => {
    expect(readInviteCodeFromUrl({ search: '?invite=abc' })).toBeNull();
    expect(readInviteCodeFromUrl({ search: '?invite=abc!def' })).toBeNull();
    expect(readInviteCodeFromUrl({ search: '?invite=a'.padEnd(30, 'x') })).toBeNull();
  });
});

describe('buildShareLine', () => {
  it('produces four lines and always ends with the share origin', () => {
    const text = buildShareLine({
      headline: 'I won',
      scoreLine: '2–1',
      trail: '✅✅❌',
      formatLabel: 'Best of 3',
    });
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('EvenShock — Best of 3');
    expect(lines[1]).toBe('I won 2–1');
    expect(lines[2]).toBe('✅✅❌');
    expect(lines[3]).toBe(SHARE_ORIGIN);
  });

  it('omits an empty trail rather than leaving a blank line', () => {
    const text = buildShareLine({
      headline: 'We drew',
      scoreLine: '1–1',
      formatLabel: 'Single Round',
    });
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(['EvenShock — Single Round', 'We drew 1–1', SHARE_ORIGIN]);
  });
});
