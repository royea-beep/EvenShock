import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabase } from '../data/supabaseClient';
import { createLadder, type LadderSnapshot } from '../data/ladder';

/**
 * The rated ladder, fetched when the panel opens and on demand after a match.
 *
 * FAILURE IS NOT EMPTINESS. `snapshot` stays null on error and `failed` goes
 * true, because "nobody has qualified yet" and "we could not ask" must render
 * differently — the first is the true state of a new deployment and the second
 * is a fault. Collapsing them would have the panel calmly tell a player the
 * ladder is empty every time the network hiccuped.
 */
export interface LadderState {
  snapshot: LadderSnapshot | null;
  loading: boolean;
  failed: boolean;
  reload: () => void;
}

export function useLadder(userId: string | undefined, enabled: boolean): LadderState {
  const client = getSupabase();
  const api = useMemo(
    () => (enabled && client ? createLadder(client) : null),
    [enabled, client],
  );

  const [snapshot, setSnapshot] = useState<LadderSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!api || !userId) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    api
      .snapshot(userId)
      .then((s) => {
        if (cancelled) return;
        // A null answer here is a refusal or a transport failure, not an empty
        // board — the RPC returns a populated shape with total_players 0 when
        // the ladder is genuinely empty.
        if (s === null) setFailed(true);
        else setSnapshot(s);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, userId, nonce]);

  return { snapshot, loading, failed, reload };
}
