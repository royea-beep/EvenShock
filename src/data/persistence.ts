import type { SupabaseClient } from '@supabase/supabase-js';
import type { MatchFormat, RoundOutcome } from '../types/game';

/**
 * The client's READ seam for history.
 *
 * It used to write too. It cannot any more, and not because this file stopped
 * calling insert: `authenticated` holds no INSERT grant on `matches` or
 * `rounds`, and no policy would help if it did. Matches are written by the
 * `play` Edge Function, which is also the only thing that decides outcomes.
 * Adding a write back here would fail at the database, which is the point.
 *
 * Guest mode returns empty arrays so callers don't branch on auth state.
 *
 * Column names mirror the schema in supabase/migrations/ exactly, so the row
 * shape flowing through this file is the row shape the database stores.
 */

export interface MatchRecord {
  id: string;
  created_at: string;
  format: MatchFormat;
  player_score: number;
  opponent_score: number;
  /** Null while a match is still in progress; the server fills it on finalize. */
  result: RoundOutcome | null;
  status: 'in_progress' | 'complete' | 'abandoned';
  theme: string | null;
  fast_mode: boolean;
}

export interface LeaderRow {
  rank: number;
  user_id: string;
  display_name: string;
  matches_played: number;
  wins: number;
  losses: number;
  ties: number;
  win_rate: number | null;
}

export interface Persistence {
  /** Whether this backend reads anything real. Guest returns false. */
  readonly persists: boolean;
  loadRecentMatches(limit?: number): Promise<MatchRecord[]>;
  loadLeaderboard(limit?: number): Promise<LeaderRow[]>;
}

// -------------------------------------------------------------------- guest

/**
 * No-op persistence for the guest player. Reads return empty; writes are
 * silent successes so a caller that doesn't check `persists` still works.
 *
 * Not backed by localStorage on purpose: guest state is one session's data,
 * and the schema comment on `profiles` treats existing per-preference
 * localStorage keys (theme, mute, fast) as the migration source. Adding a
 * match-history key here would create a parallel path we don't want to keep
 * migrating later.
 */
export function createGuestPersistence(): Persistence {
  return {
    persists: false,
    async loadRecentMatches() {
      return [];
    },
    async loadLeaderboard() {
      return [];
    },
  };
}

// ------------------------------------------------------------------ supabase

/**
 * Supabase-backed reads. RLS scopes every row to the caller
 * (supabase/migrations/20260809113400_rls_and_column_grants.sql), so no query
 * here filters by user id — the database does it, and a missing filter cannot
 * turn into a leak.
 *
 * There is no `rounds` read: the client has no SELECT grant on that table,
 * because it holds the server's drawn move and the nonce for any round still
 * open. A per-round history panel needs a SECURITY DEFINER function returning
 * resolved rounds only, not a restored grant.
 */
export function createSupabasePersistence(client: SupabaseClient): Persistence {
  return {
    persists: true,

    async loadRecentMatches(limit = 20) {
      const { data, error } = await client
        .from('matches')
        .select(
          'id, created_at, format, player_score, opponent_score, result, status, theme, fast_mode',
        )
        // Unfinished matches are not history — they are a match someone walked
        // out of, and the leaderboard ignores them too.
        .eq('status', 'complete')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error || !data) return [];
      return data as MatchRecord[];
    },

    async loadLeaderboard(limit = 100) {
      const { data, error } = await client.rpc('leaderboard', { p_limit: limit });
      if (error || !data) return [];
      return data as LeaderRow[];
    },
  };
}
