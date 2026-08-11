import { useCallback, useEffect, useState } from 'react';
import type { AuthStatus } from './useAuth';
import {
  readEntryChoice,
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

  const chooseGuest = useCallback(() => {
    writeEntryChoice('guest');
    setChoice('guest');
    setReopened(false);
  }, []);

  const chooseWallet = useCallback(() => {
    writeEntryChoice('wallet');
    setChoice('wallet');
  }, []);

  const reopen = useCallback(() => setReopened(true), []);
  const dismiss = useCallback(() => setReopened(false), []);

  return {
    showEntry: shouldShowEntry({ status, choice, reopened }),
    choice,
    chooseGuest,
    chooseWallet,
    reopen,
    dismiss,
  };
}
