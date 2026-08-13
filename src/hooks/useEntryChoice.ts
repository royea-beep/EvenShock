import { useCallback, useEffect, useState } from 'react';
import type { AuthStatus } from './useAuth';
import {
  markIntroSeen,
  readEntryChoice,
  readIntroSeen,
  shouldShowEntry,
  writeEntryChoice,
  type EntryChoice,
} from '../data/entryChoice';

/**
 * Decides whether the front door is shown, and remembers the answer.
 *
 * Three rules, in priority order:
 *
 *   1. A signed-in visitor is never asked. Signing in IS the wallet choice, so
 *      it is recorded as one — including for the players who connected before
 *      this screen existed and have nothing stored. That self-heals on their
 *      first load and they see the door at most once.
 *
 *   2. With no Supabase env there is no wallet path at all, so offering one
 *      would be a lie. `unconfigured` never shows the door; guest is not a
 *      choice there, it is the only thing that exists.
 *
 *   3. Otherwise: ask once, then never again — unless the visitor reopens it
 *      themselves from the wallet button, which is the "switch later" route.
 *
 * The initial read is synchronous (useState initialiser, not an effect) so a
 * returning visitor never sees the door flash before it is dismissed.
 */
export interface EntryChoiceState {
  /** True when the entry screen should be on top of everything. */
  showEntry: boolean;
  /** True the very first time this browser sees the entry screen. The intro
   *  block above the two path cards renders on this flag. Suppressed forever
   *  after either path is chosen — a returning visitor already knows what
   *  the game is, and re-showing the pitch every reopen would be nagging. */
  showIntro: boolean;
  choice: EntryChoice | null;
  /** Take the guest path and close the door. */
  chooseGuest: () => void;
  /** Record the wallet path. Does NOT connect — the caller owns the wallet
   *  flow, because connecting can fail and the door has to stay open when it
   *  does. */
  chooseWallet: () => void;
  /** Reopen from the wallet button. Does not clear the stored choice: looking
   *  at the comparison again is not the same as un-choosing. */
  reopen: () => void;
  /** Close without recording anything — the reopened case. */
  dismiss: () => void;
}

export function useEntryChoice(status: AuthStatus): EntryChoiceState {
  const [choice, setChoice] = useState<EntryChoice | null>(() => readEntryChoice());
  const [reopened, setReopened] = useState(false);
  // Sync init, same pattern as `choice`, so a returning visitor never sees
  // the intro flash before it is suppressed.
  const [introSeen, setIntroSeen] = useState<boolean>(() => readIntroSeen());

  // Rule 1. A session outranks whatever is (or isn't) in storage.
  useEffect(() => {
    if (status !== 'authenticated') return;
    setChoice((prev) => {
      if (prev === 'wallet') return prev;
      writeEntryChoice('wallet');
      return 'wallet';
    });
    setReopened(false);
  }, [status]);

  const noteIntroSeen = useCallback(() => {
    if (introSeen) return;
    markIntroSeen();
    setIntroSeen(true);
  }, [introSeen]);

  const chooseGuest = useCallback(() => {
    writeEntryChoice('guest');
    setChoice('guest');
    setReopened(false);
    noteIntroSeen();
  }, [noteIntroSeen]);

  const chooseWallet = useCallback(() => {
    writeEntryChoice('wallet');
    setChoice('wallet');
    noteIntroSeen();
  }, [noteIntroSeen]);

  const reopen = useCallback(() => setReopened(true), []);
  const dismiss = useCallback(() => setReopened(false), []);

  const showEntry = shouldShowEntry({ status, choice, reopened });
  // Intro is only for FIRST-TIME visitors who are actually seeing the door.
  // A reopen from the wallet button ("Guest or wallet?") is not a first-time
  // visit, and neither is landing signed-in.
  const showIntro = showEntry && !reopened && !introSeen;

  return {
    showEntry,
    showIntro,
    choice,
    chooseGuest,
    chooseWallet,
    reopen,
    dismiss,
  };
}
