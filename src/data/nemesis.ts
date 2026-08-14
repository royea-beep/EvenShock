import type { SupabaseClient } from '@supabase/supabase-js';
import { CHOICES, type Choice } from '../utils/rules';

/**
 * Nemesis, client side.
 *
 * Nemesis is the second solo opponent: it reads the player's bias and plays the
 * counter, some of the time. Nothing in this file decides anything about a
 * round — the prediction, the coin flip and the move all happen inside the
 * `play` Edge Function at round OPEN, and the commitment over that move is
 * handed to the browser before the player throws. This is the DEBRIEF seam
 * only: what Nemesis was looking at, after the match is over.
 *
 * WHY THE REPORT GOES THROUGH THE EDGE FUNCTION. `nemesis_match_report` is
 * revoked from `anon` and `authenticated`, and so is `nemesis_rounds` itself.
 * Knowing that Nemesis is reading you THIS round is worth more than knowing its
 * move — you would simply throw something else — so the ground truth has no
 * client grant at all, and the one route to it verifies a token and refuses
 * while the match is still in progress.
 */

/** The four lenses the predictor can pick. Mirrors skill_context_stats. */
export type NemesisModel = 'marginal' | 'prev_move' | 'prev_outcome' | 'prev_outcome_move';

export interface NemesisTell {
  model: NemesisModel;
  /** What the lens was looking at: '' , a choice, an outcome, or 'win|rock'. */
  context: string;
  rock: number;
  paper: number;
  scissors: number;
  total: number;
}

export interface NemesisReport {
  matchId: string;
  rounds: number;
  /** Rounds Nemesis played its prediction, and how many of those you still won. */
  read: { rounds: number; youWon: number };
  /** Rounds it threw blind. Genuinely blind — no losses are staged. */
  blind: { rounds: number; youWon: number };
  /** The lens it leaned on most, in the player's own lifetime counts. */
  tell: NemesisTell | null;
  /** Predictability without and with this match, on the same metric. */
  predictability: { before: number | null; after: number | null };
  /** True while Nemesis is still below the ramp and never exploits. */
  calibrating: boolean;
  roundsUntilRead: number;
}

/**
 * The trophy: the lowest predictability this player has reached at or above
 * the confidence floor.
 *
 * `lowest` is null until they have played enough rounds for the number to mean
 * anything — below the floor a low score is small-sample noise, and a trophy
 * awarded for noise cannot be beaten by actually improving.
 */
export interface NemesisBest {
  lowest: number | null;
  current: number | null;
  calibrating: boolean;
}

export interface NemesisApi {
  /**
   * The debrief for a finished Nemesis match, or null when there isn't one.
   *
   * Null rather than throwing for every refusal the server can legitimately
   * issue — a random-opponent match, a match that isn't yours, a match still
   * running. None of those are errors a player should be shown; they mean
   * "there is nothing to debrief", and the panel simply doesn't render.
   */
  report: (matchId: string) => Promise<NemesisReport | null>;
  /**
   * The personal best, read STRAIGHT FROM THE TABLE rather than through the
   * Edge Function — `player_skill_metrics` carries an own-row policy and a
   * select grant, so the browser can already see this and only this. No
   * privileged route is needed for a fact about the reader, and adding one
   * would mean a second thing to keep in step with the row.
   */
  best: () => Promise<NemesisBest | null>;
}

const QUIET_REFUSALS = new Set(['not_found', 'not_nemesis', 'match_in_progress']);

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

const isModel = (v: unknown): v is NemesisModel =>
  v === 'marginal' || v === 'prev_move' || v === 'prev_outcome' || v === 'prev_outcome_move';

function asTell(raw: unknown): NemesisTell | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (!isModel(t.model)) return null;
  return {
    model: t.model,
    context: typeof t.context === 'string' ? t.context : '',
    rock: num(t.rock),
    paper: num(t.paper),
    scissors: num(t.scissors),
    total: num(t.total),
  };
}

/** Parses the RPC's payload. Exported so the shape is tested without a network. */
export function asReport(raw: Record<string, unknown>): NemesisReport {
  const read = (raw.read ?? {}) as Record<string, unknown>;
  const blind = (raw.blind ?? {}) as Record<string, unknown>;
  const pred = (raw.predictability ?? {}) as Record<string, unknown>;
  return {
    matchId: String(raw.match_id ?? ''),
    rounds: num(raw.rounds),
    read: { rounds: num(read.rounds), youWon: num(read.you_won) },
    blind: { rounds: num(blind.rounds), youWon: num(blind.you_won) },
    tell: asTell(raw.tell),
    predictability: {
      before: pred.before == null ? null : num(pred.before),
      after: pred.after == null ? null : num(pred.after),
    },
    calibrating: raw.calibrating === true,
    roundsUntilRead: num(raw.rounds_until_read),
  };
}

export function createNemesis(client: SupabaseClient): NemesisApi {
  return {
    async report(matchId) {
      const { data, error } = await client.functions.invoke('play', {
        body: { action: 'nemesis_report', match_id: matchId },
      });

      if (error) {
        const res = (error as { context?: Response }).context;
        if (res && typeof res.status === 'number') {
          let code = 'http_error';
          try {
            code = ((await res.json()) as { error?: string }).error ?? code;
          } catch {
            /* not JSON; keep the generic code */
          }
          if (QUIET_REFUSALS.has(code)) return null;
        }
        // A dropped connection is not a refusal. The caller shows nothing
        // either way, but it must not be recorded as "no debrief exists".
        throw error;
      }

      return asReport((data ?? {}) as Record<string, unknown>);
    },

    async best() {
      // No .eq() on user_id: the row-level policy already restricts this to the
      // caller's own row, and filtering here as well would imply the grant is
      // wider than it is. maybeSingle() because a player who has never had
      // metrics computed simply has no row.
      const { data, error } = await client
        .from('player_skill_metrics')
        .select('lowest_predictability, predictability_score, confidence')
        .maybeSingle();
      if (error || !data) return null;
      const row = data as Record<string, unknown>;
      return {
        lowest: row.lowest_predictability == null ? null : num(row.lowest_predictability),
        current: row.predictability_score == null ? null : num(row.predictability_score),
        calibrating: row.confidence === 'calibrating',
      };
    },
  };
}

// ============================================================ pure helpers

/**
 * The move the tell actually names, and how strongly.
 *
 * Returns null on an empty context rather than an arbitrary winner: a "tell"
 * derived from zero observations would be a sentence the player can't check,
 * and every number in this panel has to be countable by hand.
 */
export function dominantMove(
  tell: NemesisTell,
): { move: Choice; count: number; total: number } | null {
  if (tell.total < 1) return null;
  const counts: Record<Choice, number> = {
    rock: tell.rock,
    paper: tell.paper,
    scissors: tell.scissors,
  };
  let best: Choice = 'rock';
  for (const c of CHOICES) {
    // Ties resolve to the earlier choice in CHOICES order, deliberately: a
    // stable answer beats one that moves between renders of the same match.
    if (counts[c] > counts[best]) best = c;
  }
  if (counts[best] < 1) return null;
  return { move: best, count: counts[best], total: tell.total };
}

export type PrevOutcome = 'win' | 'lose' | 'tie';

export interface TellContext {
  prevOutcome: PrevOutcome | null;
  prevMove: Choice | null;
}

const isPrevOutcome = (v: string): v is PrevOutcome =>
  v === 'win' || v === 'lose' || v === 'tie';
const isChoice = (v: string): v is Choice => (CHOICES as readonly string[]).includes(v);

/**
 * The situation the lens was watching, unpacked from the stored context string.
 *
 * The encoding is the predictor's, not this file's: '' for the marginal lens, a
 * bare choice or outcome for the single-signal lenses, and 'outcome|move' for
 * the joint one. Anything that doesn't parse comes back as nulls, which the
 * copy renders as "across every round" — a vaguer sentence is the right failure
 * here, because a mis-parsed context would put a confident sentence about the
 * player's behaviour in front of them that is simply wrong.
 */
export function parseContext(tell: NemesisTell): TellContext {
  const parts = tell.context.split('|');
  switch (tell.model) {
    case 'prev_move':
      return { prevOutcome: null, prevMove: isChoice(parts[0]) ? parts[0] : null };
    case 'prev_outcome':
      return { prevOutcome: isPrevOutcome(parts[0]) ? parts[0] : null, prevMove: null };
    case 'prev_outcome_move':
      return {
        prevOutcome: isPrevOutcome(parts[0]) ? parts[0] : null,
        prevMove: parts.length > 1 && isChoice(parts[1]) ? parts[1] : null,
      };
    default:
      return { prevOutcome: null, prevMove: null };
  }
}

/**
 * Which way predictability moved across this match.
 *
 * The threshold is half a displayed point (the panel shows whole percent), so
 * a change too small to render is reported as flat rather than as an
 * improvement the player cannot see. Claiming progress that isn't visible is
 * the fastest way to make the whole number untrustworthy.
 */
export const PREDICTABILITY_EPSILON = 0.005;

export function predictabilityTrend(
  p: NemesisReport['predictability'],
): 'down' | 'up' | 'flat' | null {
  if (p.before == null || p.after == null) return null;
  const delta = p.after - p.before;
  if (Math.abs(delta) < PREDICTABILITY_EPSILON) return 'flat';
  return delta < 0 ? 'down' : 'up';
}

/** 0.617 → 62. Whole percent, because the third decimal is noise to a player. */
export function asPercent(score: number): number {
  return Math.round(score * 100);
}

/**
 * Whether there is anything worth showing at all.
 *
 * A match with no resolved rounds and no tell has nothing to say, and an empty
 * panel with a heading on it is worse than no panel.
 */
export function hasDebrief(report: NemesisReport): boolean {
  return report.rounds > 0;
}
