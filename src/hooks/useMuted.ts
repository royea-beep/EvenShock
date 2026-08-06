import { useCallback, useState } from 'react';
import { isMuted, play, setMuted } from '../utils/sound';

/** Mute state, persisted to localStorage and shared with the sound engine. */
export function useMuted() {
  const [muted, setMutedState] = useState<boolean>(() => isMuted());

  const toggleMuted = useCallback(() => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    // Unmuting happens on a click, so this doubles as an audio-unlock gesture
    // and confirms audio is actually working.
    if (!next) play('select');
  }, [muted]);

  return { muted, toggleMuted };
}
