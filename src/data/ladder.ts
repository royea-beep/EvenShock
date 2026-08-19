import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The ladder, client side.
 *
 * WHY A SNAPSHOT RPC RATHER THAN READING THE VIEW: the caller's own rank has
 * to come from the same ordering the board uses, and their last rating change
 * has to come from `rating_history`. Doing that in two client queries invites
 * the two halves to disagree — a player shown "rank 4" next to a movement
 * computed from a different read is worse than showing neither.
 *
 * MOVEMENT IS DERIVED, NOT STORED. `last_change.delta` is
 * `rating_after - rating_before` from the history row that caused it, so it
 * cannot drift from the rating it describes.
 */

export interface LadderRow {
  rank: number;
  userId: string;
  name: string | null;
  rating: number;
  matches: number;
  isYou: boolean;
}

export interface RatingChange {
  delta: number;
  rating: number;
  outcome: 'win' | 'loss' | 'draw';
  at: string;
}

export interface LadderSnapshot {
  totalPlayers: number;
  board: LadderRow[];
  you: {
    onBoard: boolean;
    rank: number | null;
    rating: number | null;
    ratedMatches: number | null;
    lastChange: RatingChange | null;
    /** False for harness, owner and treasury accounts — they never rank. */
    rateable: boolean;
  };
  /** Present only when the board is genuinely empty. Distinguishes "nobody has
   *  qualified yet" from "the request failed", which look identical otherwise. */
  emptyReason: string | null;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

export function asSnapshot(raw: Record<string, unknown>): LadderSnapshot {
  const you = (raw.you ?? {}) as Record<string, unknown>;
  const lc = you.last_change as Record<string, unknown> | null | undefined;
  return {
    totalPlayers: num(raw.total_players),
    board: Array.isArray(raw.board)
      ? (raw.board as Record<string, unknown>[]).map((r) => ({
          rank: num(r.rank),
          userId: String(r.user_id),
          name: typeof r.name === 'string' ? r.name : null,
          rating: num(r.rating),
          matches: num(r.matches),
          isYou: r.is_you === true,
        }))
      : [],
    you: {
      onBoard: you.on_board === true,
      rank: you.rank == null ? null : num(you.rank),
      rating: you.rating == null ? null : num(you.rating),
      ratedMatches: you.rated_matches == null ? null : num(you.rated_matches),
      lastChange: lc
        ? {
            delta: num(lc.delta),
            rating: num(lc.rating),
            outcome: lc.outcome === 'win' ? 'win' : lc.outcome === 'loss' ? 'loss' : 'draw',
            at: String(lc.at),
          }
        : null,
      rateable: you.rateable === true,
    },
    emptyReason: typeof raw.empty_reason === 'string' ? raw.empty_reason : null,
  };
}

/**
 * How to render a rating change: the sign is the whole message.
 *
 * A zero delta is reported as 'flat' rather than '+0' — a draw against a
 * closely matched opponent genuinely moves nothing, and dressing that up as
 * movement would be the same dishonesty as the predictability trend claiming
 * progress too small to see.
 */
export function movementOf(change: RatingChange | null): 'up' | 'down' | 'flat' | null {
  if (!change) return null;
  if (change.delta > 0) return 'up';
  if (change.delta < 0) return 'down';
  return 'flat';
}

/**
 * What the standing block should render.
 *
 * `unrated` covers the honest cold start AND a subtler case worth naming: a
 * player can carry rating history while having no current rating or rank — for
 * example an account excluded from the ladder after the fact. Rendering the
 * box for them would float a "+162 from your last match" with no rank and no
 * rating beside it, which reads as a bug. A movement is only meaningful next
 * to the thing it moved.
 */
export function standingKind(you: LadderSnapshot['you']): 'unrated' | 'ranked' {
  return you.rank === null && you.rating === null ? 'unrated' : 'ranked';
}

export function createLadder(client: SupabaseClient) {
  return {
    async snapshot(userId: string, limit = 20): Promise<LadderSnapshot | null> {
      const { data, error } = await client.rpc('ladder_snapshot', {
        p_user_id: userId,
        p_limit: limit,
      });
      if (error || !data) return null;
      return asSnapshot(data as Record<string, unknown>);
    },
  };
}
