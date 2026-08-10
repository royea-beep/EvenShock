import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSupabase } from '../data/supabaseClient';
import { themePrice } from '../utils/economy';
import {
  EMPTY_ECONOMY,
  createLocalEconomy,
  createServerEconomy,
  type EconomyApi,
  type EconomyState,
} from '../data/economy';

/**
 * Owns XP, chips and owned cosmetics for whichever player is present.
 *
 * Mirrors `useRounds`: one interface, the implementation chosen from auth
 * state, so the guest path exercises the same code the real one does.
 */
export interface EconomyStore {
  state: EconomyState;
  /** False for guests — balances live in this browser only. Drives the labelling. */
  persistent: boolean;
  /** True while the first load is in flight, so the UI can avoid flashing zeros. */
  loading: boolean;
  /** Set when a purchase was refused, for the shop to show in place. */
  buyError: string | null;
  owns(sku: string): boolean;
  buy(sku: string): Promise<boolean>;
  /** Call when a match completes. Server re-reads; guest credits locally. */
  settleMatch(roundsResolved: number, roundsWon: number): void;
  refresh(): void;
}

export function useEconomy(authenticated: boolean, currentTheme: string | null): EconomyStore {
  const client = getSupabase();
  const api: EconomyApi = useMemo(
    () => (authenticated && client ? createServerEconomy(client) : createLocalEconomy()),
    [authenticated, client],
  );

  const [state, setState] = useState<EconomyState>(EMPTY_ECONOMY);
  const [loading, setLoading] = useState(true);
  const [buyError, setBuyError] = useState<string | null>(null);

  // The theme is read at call time rather than being a dependency, so changing
  // look does not re-trigger a load — the grant only needs to happen once per
  // session, and re-running it on every theme tap would be a request per tap.
  const themeRef = useRef(currentTheme);
  themeRef.current = currentTheme;

  const refresh = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .load(themeRef.current)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        // A balance that cannot be read is shown as unknown rather than as
        // zero: telling someone they have nothing is worse than telling them
        // nothing, and a wrong zero next to a shop is actively misleading.
        if (!cancelled) setState(EMPTY_ECONOMY);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Reload whenever the identity changes — connecting a wallet must NOT carry a
  // guest balance across, it must show the account's own (empty) one.
  useEffect(() => refresh(), [refresh]);

  const settleMatch = useCallback(
    (roundsResolved: number, roundsWon: number) => {
      void api
        .recordMatch(roundsResolved, roundsWon)
        .then(setState)
        .catch(() => {
          /* the award is already recorded server-side; the next load shows it */
        });
    },
    [api],
  );

  const buy = useCallback(
    async (sku: string): Promise<boolean> => {
      setBuyError(null);

      // Refuse locally what the server would refuse anyway.
      //
      // The price and the balance are both already here, so sending the request
      // buys nothing but a round trip and a 409 in the player's console that
      // looks like a fault rather than "you cannot afford this yet". This is a
      // convenience check and NOT the enforcement — spend_chips still takes the
      // balance row lock and re-checks, because a client-side guard protects
      // nobody from a client.
      const price = themePrice(sku);
      if (price === null) {
        setBuyError('bad_request');
        return false;
      }
      if (state.chips < price) {
        setBuyError('insufficient_chips');
        return false;
      }

      try {
        const result = await api.buy(sku);
        setState((prev) => ({
          ...prev,
          chips: result.chips,
          owned: prev.owned.includes(sku) ? prev.owned : [...prev.owned, sku],
        }));
        return true;
      } catch (err) {
        setBuyError(err instanceof Error ? err.message : 'buy_failed');
        return false;
      }
    },
    [api, state.chips],
  );

  const owns = useCallback((sku: string) => state.owned.includes(sku), [state.owned]);

  return {
    state,
    persistent: api.persistent,
    loading,
    buyError,
    owns,
    buy,
    settleMatch,
    refresh,
  };
}
