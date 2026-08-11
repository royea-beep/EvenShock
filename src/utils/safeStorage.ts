/**
 * The only place in this codebase allowed to touch browser storage directly.
 *
 * `sessionStorage` and `localStorage` THROW — in private-browsing modes, with
 * site data disabled, and when a quota is exceeded. Not "return null": throw,
 * on the property access itself. That produced a production bug where an
 * unguarded `sessionStorage.removeItem` sat on the success path of a round
 * submit; the throw landed in the catch that handles network failures, so a
 * round which had genuinely resolved was retried three times and then shown as
 * failed. Every round, for every player whose browser refuses storage, while
 * the server had done everything right.
 *
 * WHY A MODULE AND NOT A CONVENTION. The obvious fix is "wrap it in try/catch",
 * and the obvious enforcement is a lint rule looking for a nearby `try`. That
 * rule would have PASSED the bug: the call was inside a try block — just the
 * wrong one, belonging to an error handler that could not tell a storage
 * failure from a dropped request. Proximity to a `try` is not the property that
 * matters; catching the RIGHT error is, and no syntactic check sees that.
 *
 * So the invariant is stronger and mechanically checkable instead:
 * `runtimeAssumptions.test.ts` fails if a raw storage access appears in any
 * file but this one. There is no way to write the bug again without deleting a
 * test that explains why it exists.
 *
 * Failing silently is correct here rather than a compromise. Everything stored
 * through this module — theme, mute, fast mode, guest balances, a resume hint —
 * is either a preference or a convenience with a durable source of truth
 * elsewhere. Absent is always an acceptable answer.
 */

function reader(store: () => Storage) {
  return {
    get(key: string): string | null {
      try {
        return store().getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        store().setItem(key, value);
      } catch {
        /* unavailable or full; the caller's fallback is the stored-nothing case */
      }
    },
    remove(key: string): void {
      try {
        store().removeItem(key);
      } catch {
        /* unavailable; there was nothing stored to remove */
      }
    },
  };
}

// Lazily read, never captured: `globalThis.sessionStorage` can throw on the
// property access, so holding a reference at module scope would move the throw
// to import time, where nothing is catching it and the whole app fails to boot.
export const session = reader(() => globalThis.sessionStorage);
export const local = reader(() => globalThis.localStorage);
