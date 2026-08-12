import { local } from '../utils/safeStorage';

/**
 * Which door the visitor came through, remembered so they are asked once.
 *
 * Deliberately NOT a source of truth for anything. Whether a player is a guest
 * or signed in is decided by `useAuth` reading the Supabase session; this only
 * records that a choice was MADE, so the entry screen can stop asking. If this
 * value and the session ever disagree, the session wins and this is corrected —
 * see useEntryChoice.
 *
 * Stored through safeStorage because browser storage throws rather than
 * refusing politely (see utils/safeStorage.ts). Absent is a perfectly good
 * answer here: the cost of forgetting is being asked once more, which is the
 * cheapest failure in the app.
 */

export type EntryChoice = 'guest' | 'wallet';

const KEY = 'evenshock.entry.v1';

/** Anything that is not one of the two known values is treated as absent,
 *  including a value written by a future version of this file. */
export function parseEntryChoice(raw: string | null): EntryChoice | null {
  return raw === 'guest' || raw === 'wallet' ? raw : null;
}

export function readEntryChoice(): EntryChoice | null {
  return parseEntryChoice(local.get(KEY));
}

export function writeEntryChoice(choice: EntryChoice): void {
  local.set(KEY, choice);
}

// Same shape as the choice flag, and for the same reason: the intro is a
// once-per-browser piece of chrome, and forgetting is cheap (a returning
// visitor sees three sentences again, not a broken app). Kept next to the
// entry choice because it lives on the same screen and shares its failure
// mode.
const INTRO_KEY = 'evenshock.entryIntro.v1';

export function readIntroSeen(): boolean {
  return local.get(INTRO_KEY) === 'seen';
}

export function markIntroSeen(): void {
  local.set(INTRO_KEY, 'seen');
}

/**
 * Whether the door is on screen. A pure function, extracted from the hook so
 * every case can be asserted without a renderer — the rules are the feature,
 * and "ask exactly once" is the kind of thing that breaks quietly.
 *
 *   - `unconfigured` has no wallet path to offer, so there is no choice to
 *     make and the door never appears.
 *   - a live session outranks storage: a signed-in visitor is never asked.
 *   - reopening shows it again even with a choice stored.
 */
export function shouldShowEntry(input: {
  status: string;
  choice: EntryChoice | null;
  reopened: boolean;
}): boolean {
  if (input.status === 'unconfigured') return false;
  if (input.reopened) return true;
  if (input.status === 'authenticated') return false;
  return input.choice === null;
}
