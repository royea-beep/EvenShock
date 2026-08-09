import { useMemo } from 'react';
import { getSupabase } from '../data/supabaseClient';
import {
  createGuestPersistence,
  createSupabasePersistence,
  type Persistence,
} from '../data/persistence';

/**
 * Returns the persistence backend for the current auth state.
 *
 * Guests get the no-op backend regardless of whether Supabase is configured
 * — a signed-out user must not be silently persisting to the previous
 * account, and there is no session to attribute writes to anyway.
 *
 * The instance is memoised on `authenticated` so hooks depending on it don't
 * see a fresh reference every render.
 */
export function usePersistence(authenticated: boolean): Persistence {
  return useMemo(() => {
    const client = getSupabase();
    if (!authenticated || !client) return createGuestPersistence();
    return createSupabasePersistence(client);
  }, [authenticated]);
}
