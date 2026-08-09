import type { SupabaseClient } from '@supabase/supabase-js';
import type { Choice, MatchFormat, RoundOutcome } from '../types/game';

/**
 * The client's storage seam. useGame is a protected file and stores nothing;
 * writing history is a separate concern that lives here. useMatchPersistence
 * calls into this interface when a match completes.
 *
 * The interface is deliberately narrow: recording is fire-and-forget from the
 * caller's point of view (errors are logged, not surfaced — a failed write
 * cannot block the next round), and reads are for surfaces that don't exist
 * yet (a personal history panel and the leaderboard). Guest mode returns
 * empty arrays for reads and no-ops for writes so callers don't need to
 * branch on auth state to render.
 *
 * Column names mirror the schema in supabase/migrations/ exactly, so the row
 * shape flowing through this file is the row shape the database stores.
 */

export interface MatchRecordInput {
  format: MatchFormat;
  player_score: number;
  opponent_score: number;
  result: RoundOutcome; // 'win' | 'lose' | 'tie'
  theme: string | null;
  fast_mode: boolean;
}

export interface RoundRecordInput {
  round_number: number;
  player_choice: Choice;
  opponent_choice: Choice;
  outcome: RoundOutcome;
}

export interface MatchRecord extends MatchRecordInput {
  id: string;
  created_at: string;
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
  /** Whether this backend actually persists anything. Guest returns false. */
  readonly persists: boolean;
  recordMatch(match: MatchRecordInput, rounds: RoundRecordInput[]): Promise<void>;
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
    async recordMatch() {
      /* no-op */
    },
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
 * Supabase-backed persistence. Everything here relies on the RLS policies in
 * supabase/migrations/20260809113400_rls_and_column_grants.sql — user_id and
 * created_at are server-defaulted, so the client cannot backdate a match or
 * attribute it to another account even if this code got it wrong.
 */
export function createSupabasePersistence(client: SupabaseClient): Persistence {
  return {
    persists: true,

    async recordMatch(match, rounds) {
      // Insert the match first so rounds can reference its id. Grants scope
      // this insert to (format, player_score, opponent_score, result, theme,
      // fast_mode) — user_id is defaulted by the server.
      const { data: inserted, error: matchErr } = await client
        .from('matches')
        .insert(match)
        .select('id')
        .single();
      if (matchErr || !inserted) {
        // Deliberately swallow: a failed write must not disrupt gameplay.
        // The audit story lives in Supabase logs, not client-side toasts.
        // eslint-disable-next-line no-console
        console.warn('[persistence] recordMatch: match insert failed', matchErr);
        return;
      }

      if (rounds.length === 0) return;
      const rows = rounds.map((r) => ({ ...r, match_id: inserted.id }));
      const { error: roundsErr } = await client.from('rounds').insert(rows);
      if (roundsErr) {
        // eslint-disable-next-line no-console
        console.warn('[persistence] recordMatch: rounds insert failed', roundsErr);
      }
    },

    async loadRecentMatches(limit = 20) {
      const { data, error } = await client
        .from('matches')
        .select('id, created_at, format, player_score, opponent_score, result, theme, fast_mode')
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
