import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured } from '../data/supabaseClient';
import { connectAndSignIn, disconnect, type ConnectResult } from '../data/wallet';

/**
 * The single source of truth for whether we are guest or authenticated.
 *
 * Subscribes to Supabase's `onAuthStateChange` so a session picked up from
 * localStorage on boot, or a sign-out from another tab, propagates without a
 * reload. The `status` is a discriminated union rather than a pair of booleans
 * so a caller can't render "connected but no address" or "connecting with a
 * session already present".
 */
export type AuthStatus =
  | 'unconfigured' // env is missing — guest is the only option
  | 'guest'
  | 'connecting'
  | 'authenticated'
  | 'error';

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  address: string | null;
  error: string | null;
  /** Kicks off the wallet connect + Supabase sign-in. Returns the result so
   *  the caller can render feedback (rejection, no-wallet, etc.). */
  connect: () => Promise<ConnectResult>;
  disconnect: () => Promise<void>;
}

export function useAuth(): AuthState {
  const client = getSupabase();
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>(
    isSupabaseConfigured() ? 'guest' : 'unconfigured',
  );
  const [error, setError] = useState<string | null>(null);
  const [profileAddress, setProfileAddress] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;

    // Prime with whatever session was persisted to localStorage on the last
    // visit — otherwise the first render flashes "guest" before the auth
    // subscription catches up.
    let cancelled = false;
    void client.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setStatus(data.session ? 'authenticated' : 'guest');
    });

    const { data: sub } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setStatus(next ? 'authenticated' : 'guest');
      // Any subsequent change clears a stale error banner.
      setError(null);
      if (!next) setProfileAddress(null);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [client]);

  const connect = useCallback(async (): Promise<ConnectResult> => {
    if (!client) {
      const r: ConnectResult = { kind: 'error', message: 'Supabase not configured' };
      setError(r.message);
      setStatus('error');
      return r;
    }
    setStatus('connecting');
    setError(null);
    const result = await connectAndSignIn(client);
    if (result.kind === 'ok') {
      setSession(result.session);
      setStatus('authenticated');
    } else if (result.kind === 'rejected' || result.kind === 'no-wallet') {
      // User-initiated back-out or no wallet installed — return to guest, no
      // error banner (a rejection isn't an error, it's a choice).
      setStatus('guest');
    } else {
      setError(result.message);
      setStatus('error');
    }
    return result;
  }, [client]);

  const doDisconnect = useCallback(async () => {
    if (!client) return;
    await disconnect(client);
    setSession(null);
    setStatus('guest');
  }, [client]);

  /**
   * The wallet address comes from `profiles.wallet_address`, not from the
   * session.
   *
   * Supabase's Web3 provider namespaces the identity as
   * `web3:solana:<address>`, and the session carries that verbatim — which is
   * why the button read `web3…BSRF` instead of `D9bz…BSRF`. The normalised
   * address already exists: the provisioning trigger strips the namespace and
   * stores the bare value, and there is a backfill for the rows written before
   * that. So this reads the value the server settled on rather than re-deriving
   * it, and there is no prefix-stripping in the UI to drift from the trigger.
   *
   * RLS scopes the row to the caller, so no user filter is needed here.
   */
  useEffect(() => {
    if (!client || !session) return;
    let cancelled = false;
    void client
      .from('profiles')
      .select('wallet_address')
      .single()
      .then(({ data }) => {
        if (!cancelled && data?.wallet_address) setProfileAddress(data.wallet_address);
      });
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  // Deliberately NOT falling back to the session's namespaced identity: showing
  // a wrong-but-present address is worse than showing none for the moment
  // between signing in and the profile arriving.
  const address = profileAddress;

  return { status, session, address, error, connect, disconnect: doDisconnect };
}
