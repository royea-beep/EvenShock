import { useCallback, useEffect, useState } from 'react';
import { REVEAL_DELAY_MS, setPace } from '../constants/gameConfig';
import { setShuffleDuration } from '../utils/shuffle';

const STORAGE_KEY = 'evenshock:fast';

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    // Private-mode Safari and blocked storage both throw here. Defaulting to
    // the full sequence is the right failure: it is what a first-time player
    // should see, and Fast mode is opt-in.
    return false;
  }
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

  const toggleFast = useCallback(() => {
    setFast((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Preference is lost on reload; the session still honours it.
      }
      return next;
    });
  }, []);

  return { fast, toggleFast };
}
