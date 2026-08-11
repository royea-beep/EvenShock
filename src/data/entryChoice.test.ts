import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseEntryChoice,
  readEntryChoice,
  shouldShowEntry,
  writeEntryChoice,
} from './entryChoice';

/**
 * The front door has one job it must not get wrong: ask once, then stop. That
 * depends entirely on this module, and on it staying silent when storage
 * refuses — a browser that throws on localStorage must produce "ask again",
 * never a crash on the path to the game.
 */

function useStore(impl: Partial<Storage>) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: impl,
    configurable: true,
  });
}

function fakeStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  } as unknown as Storage;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
  vi.restoreAllMocks();
});

describe('entry choice', () => {
  it('round-trips a recorded choice', () => {
    useStore(fakeStore());
    expect(readEntryChoice()).toBeNull();
    writeEntryChoice('guest');
    expect(readEntryChoice()).toBe('guest');
    writeEntryChoice('wallet');
    expect(readEntryChoice()).toBe('wallet');
  });

  it('treats an unrecognised stored value as no choice', () => {
    // A value from a future version, or a key someone set by hand. Asking the
    // visitor again is always safe; acting on a value we do not understand is
    // not.
    expect(parseEntryChoice('spectator')).toBeNull();
    expect(parseEntryChoice('')).toBeNull();
    expect(parseEntryChoice(null)).toBeNull();
  });

  it('returns "no choice" when storage throws rather than propagating', () => {
    // Private browsing and site-data-disabled both throw on the ACCESS, which
    // is the failure that already cost this codebase a production bug. The
    // worst acceptable outcome here is being asked the question twice.
    useStore({
      get getItem(): never {
        throw new DOMException('denied');
      },
    } as unknown as Storage);
    expect(() => readEntryChoice()).not.toThrow();
    expect(readEntryChoice()).toBeNull();
  });

  it('is shown to a first-time visitor and nobody else', () => {
    const show = (status: string, choice: 'guest' | 'wallet' | null, reopened = false) =>
      shouldShowEntry({ status, choice, reopened });

    // The visitor this screen is for.
    expect(show('guest', null)).toBe(true);

    // Asked once. Both answers close it, including guest — someone who chose
    // guest deliberately must not be nagged on every load.
    expect(show('guest', 'guest')).toBe(false);
    expect(show('guest', 'wallet')).toBe(false);

    // A session outranks storage: signed in is never asked, even with nothing
    // recorded (everyone who connected before this screen existed).
    expect(show('authenticated', null)).toBe(false);
    expect(show('authenticated', 'guest')).toBe(false);

    // No Supabase env means no wallet path at all. Offering a choice that
    // cannot work would be worse than not asking.
    expect(show('unconfigured', null)).toBe(false);

    // Reopened from the wallet button — the "switch later" route, which works
    // whatever was chosen before.
    expect(show('guest', 'guest', true)).toBe(true);
    expect(show('guest', 'wallet', true)).toBe(true);
    // …but still never where there is nothing to switch to.
    expect(show('unconfigured', null, true)).toBe(false);
  });

  it('does not throw when a write is refused', () => {
    useStore({
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota');
      },
    } as unknown as Storage);
    expect(() => writeEntryChoice('guest')).not.toThrow();
  });
});
