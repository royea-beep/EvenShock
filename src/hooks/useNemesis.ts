import { useCallback, useMemo, useRef, useState } from 'react';
import { getSupabase } from '../data/supabaseClient';
import {
  createNemesis,
  type NemesisApi,
  type NemesisBest,
  type NemesisReport,
} from '../data/nemesis';

/**
 * The Nemesis debrief, fetched once per finished match.
 *
 * DELIBERATELY QUIET ON FAILURE. If the report does not load, `report` stays
 * null and the panel does not render — no banner, no retry button. The match
 * itself already resolved, the chips are already paid, and every number in the
 * debrief is derived from rows that are not going anywhere. Putting an error on
 * the match-end screen would make a missing footnote look like a lost result.
 *
 * ONE FETCH PER MATCH. The de-dupe is on the match id rather than a boolean,
 * because React strict mode fires the caller's effect twice and the two runs
 * carry the same id — while a genuinely new match carries a different one.
 */

export interface NemesisState {
  report: NemesisReport | null;
  /** The trophy. Read alongside the report, and null until it means anything. */
  best: NemesisBest | null;
  loading: boolean;
  /** Ask for the debrief for a finished match. Safe to call repeatedly. */
  load: (matchId: string) => void;
  /** Drop it — called when the next match starts. */
  clear: () => void;
}

export function useNemesis(enabled: boolean): NemesisState {
  const client = getSupabase();
  const api: NemesisApi | null = useMemo(
    () => (enabled && client ? createNemesis(client) : null),
    [enabled, client],
  );

  const [report, setReport] = useState<NemesisReport | null>(null);
  const [best, setBest] = useState<NemesisBest | null>(null);
  const [loading, setLoading] = useState(false);
  const asked = useRef<string | null>(null);

  const load = useCallback(
    (matchId: string) => {
      if (!api || !matchId) return;
      if (asked.current === matchId) return;
      asked.current = matchId;
      setLoading(true);
      // The trophy is a separate read and a separate failure: it comes from the
      // metrics row rather than from the match, and one of them being
      // unavailable is no reason to hide the other.
      void api
        .best()
        .then((b) => {
          if (asked.current === matchId) setBest(b);
        })
        .catch(() => {
          /* no trophy line; the debrief is unaffected */
        });
      api
        .report(matchId)
        .then((r) => {
          // Guard against a late answer for a match the player has already
          // left: without this, starting a new match and then having the old
          // request land would show the previous match's debrief over it.
          if (asked.current === matchId) setReport(r);
        })
        .catch(() => {
          /* see the note above: a missing debrief is not an error to show */
        })
        .finally(() => {
          if (asked.current === matchId) setLoading(false);
        });
    },
    [api],
  );

  const clear = useCallback(() => {
    asked.current = null;
    setReport(null);
    setBest(null);
    setLoading(false);
  }, []);

  return { report, best, loading, load, clear };
}
