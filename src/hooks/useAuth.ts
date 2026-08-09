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

  // Address is derived from the session, not tracked separately: session is
  // the source of truth, and a mismatch here would be a bug.
  const address =
    session?.user.user_metadata?.address ??
    session?.user.user_metadata?.wallet_address ??
    session?.user.identities?.[0]?.identity_data?.address ??
    session?.user.identities?.[0]?.identity_data?.wallet_address ??
    session?.user.identities?.[0]?.identity_data?.sub ??
    null;

  return { status, session, address, error, connect, disconnect: doDisconnect };
}
