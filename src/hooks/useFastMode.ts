import { useCallback, useEffect, useState } from 'react';
import { REVEAL_DELAY_MS, setPace } from '../constants/gameConfig';
import { setShuffleDuration } from '../utils/shuffle';
import { local } from '../utils/safeStorage';
import { FAST_MODE_ENABLED } from '../constants/features';

const STORAGE_KEY = 'evenshock:fast';

function read(): boolean {
  // The freeze is enforced HERE rather than only at the toggle, because the
  // toggle is not the only way in. A player who turned fast mode on before the
  // freeze still has `evenshock:fast=true` in storage, and a signed-in player
  // carries `profiles.fast_mode` through usePrefsMigration. Hiding the control
  // while honouring those would leave exactly those players in the mode we
  // decided nobody should be in, with nothing on screen to change it.
  if (!FAST_MODE_ENABLED) return false;

  // Storage refusing reads as "not fast", which is the right default: the full
  // sequence is what a first-time player should see, and Fast mode is opt-in.
  return local.get(STORAGE_KEY) === 'true';
}

/** Pushes the pace into the modules that own the timings, then reports it. */
function apply(fast: boolean): void {
  setPace(fast);
  setShuffleDuration(REVEAL_DELAY_MS);
}

/**
 * Fast mode: an explicit, persisted preference that shortens the whole
 * sequence to roughly 700ms.
 *
 * It is deliberately NOT an auto-switch after N rounds. The moment an
 * auto-switch flips is the moment the game feels broken rather than faster, and
 * a player who never asked for it has no way to understand what changed.
 *
 * It is also deliberately faster than the pre-Phase-B pacing rather than equal
 * to it. A mode whose only job is to undo the thing we just built would be a
 * signal we built too much — if most players end up here, the sequence itself
 * is too long and should be cut, not toggled around.
 */
export function useFastMode() {
  const [fast, setFast] = useState<boolean>(() => {
    const initial = read();
    apply(initial);
    return initial;
  });

  // Keep the timing modules in step with React state, including on mount where
  // the lazy initialiser above already ran once.
  useEffect(() => {
    apply(fast);
  }, [fast]);

  // Both setters are inert while frozen, so nothing — not the toggle, not the
  // profile migration — can turn it on, and no new `true` is written to
  // storage that would surprise whoever unfreezes it later.
  const writeAndSet = useCallback((next: boolean) => {
    if (!FAST_MODE_ENABLED) return;
    setFast(next);
    // If storage refuses, the preference is lost on reload; the session still
    // honours it.
    local.set(STORAGE_KEY, String(next));
  }, []);

  const toggleFast = useCallback(() => {
    if (!FAST_MODE_ENABLED) return;
    setFast((previous) => {
      const next = !previous;
      local.set(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  // Direct setter for the prefs-migration hook: when a signed-in profile
  // carries a fast_mode value, it needs to be applied without needing to know
  // the current state to decide whether to toggle.
  return { fast, toggleFast, setFast: writeAndSet };
}
