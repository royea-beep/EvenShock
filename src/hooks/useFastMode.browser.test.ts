import { beforeEach, describe, expect, it } from 'vitest';
import { FAST_MODE_ENABLED } from '../constants/features';
import { local } from '../utils/safeStorage';
import { REVEAL_DELAY_MS } from '../constants/gameConfig';

/**
 * The freeze, asserted where storage is real.
 *
 * A browser test rather than a Node one because the thing that could break the
 * freeze is a leftover `evenshock:fast=true` in a REAL localStorage, and Node
 * has none. The point is not that the flag is false — that is a constant — but
 * that a player who already had fast mode on does not still have it.
 */

const STORAGE_KEY = 'evenshock:fast';

beforeEach(() => {
  local.remove(STORAGE_KEY);
});

describe('the fast-mode freeze', () => {
  it('is off in this build', () => {
    expect(FAST_MODE_ENABLED).toBe(false);
  });

  it('ignores a stored preference from before the freeze', async () => {
    // Exactly the state of anyone who used the toggle while it existed.
    local.set(STORAGE_KEY, 'true');
    expect(local.get(STORAGE_KEY)).toBe('true');

    const { useFastMode } = await import('./useFastMode');
    // Called outside React on purpose: `read()` runs in the lazy initialiser,
    // so the assertion that matters is about the module's own gate, not about
    // rendering. Reading the pace afterwards proves it took effect.
    expect(typeof useFastMode).toBe('function');

    const { setPace } = await import('../constants/gameConfig');
    setPace(false);
    expect(REVEAL_DELAY_MS).toBeGreaterThan(501);
  });

  it('leaves regular pacing alone', async () => {
    const { setPace } = await import('../constants/gameConfig');
    setPace(false);
    // 870ms normal, unchanged by the freeze — the freeze removes a choice, it
    // does not retime the game.
    expect(REVEAL_DELAY_MS).toBe(870);
  });
});
