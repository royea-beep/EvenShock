import type { SupabaseClient } from '@supabase/supabase-js';
import type { Choice, MatchFormat } from '../utils/rules';

/**
 * Playing a friend, client side.
 *
 * THE SHAPE OF THE PROTOCOL, and why the client looks passive:
 *
 *   create / join   one player makes a table and reads out an 8-character
 *                   code; the other types it. Stakes are escrowed at JOIN, in
 *                   the same transaction as the seating, so no table ever
 *                   exists half-staked.
 *   commit          the player picks; the server stores (move, nonce) and
 *                   returns only a digest. Neither move exists in plaintext to
 *                   the other side, and the response is identical whether or
 *                   not the opponent has moved.
 *   reveal          once both have committed, both reveal. The FIRST revealer
 *                   is told `waiting_for_opponent` and nothing else — that
 *                   asymmetry is what makes refusing to reveal a losing move
 *                   rather than a free option.
 *   result          after the round resolves, both (move, nonce) pairs and
 *                   both commitments come back, and {@link verifyRound} checks
 *                   them. This is the price of the server holding the nonces.
 *
 * WHAT THE SERVER IS TRUSTED WITH, stated plainly: it knows both moves before
 * either player does. It has to — the alternative is client-held nonces, and a
 * tab crash then costs a real stake. What it CANNOT do without being caught is
 * reveal a different move than the one it committed to, because the digest
 * binds `round_id:seat:move:nonce` and both are checked here on every round.
 */

export type Seat = 'a' | 'b';

/** Every way a round can end. The copy for each is deliberately different —
 *  "you didn't reveal in time" and "that match expired" are not the same
 *  sentence to the person it happened to. */
export type Resolution =
  | 'played'
  | 'commit_timeout'
  | 'reveal_timeout'
  | 'void_no_commits'
  | 'void_no_reveals';

export interface StakeOption {
  stake: number;
  pot: number;
  rake: number;
  payout: number;
}

export interface TableSummary {
  tableId: string;
  inviteCode: string | null;
  format: MatchFormat;
  seat: Seat;
  status: 'open' | 'playing' | 'finished' | 'abandoned';
  stake: number;
  pot: number;
  rake: number;
  payout: number;
}

export interface TableState {
  seat: Seat;
  status: 'open' | 'playing' | 'finished' | 'abandoned';
  format: MatchFormat;
  inviteCode: string | null;
  opponentSeated: boolean;
  score: { a: number; b: number };
  result: Seat | null;
  round: {
    roundId: number;
    roundNumber: number;
    state: 'open' | 'committed' | 'resolved' | 'void';
    youCommitted: boolean;
    bothCommitted: boolean;
    youRevealed: boolean;
    outcome: Seat | 'tie' | null;
    resolution: Resolution | null;
  } | null;
}

export interface RoundResult {
  settled: boolean;
  roundId: number;
  you: Seat;
  outcome: Seat | 'tie' | null;
  resolution: Resolution | null;
  yourMove: Choice | null;
  opponentMove: Choice | null;
  score: { a: number; b: number };
  tableStatus: string;
  tableResult: Seat | null;
  stake: number;
  pot: number;
  rake: number;
  payout: number;
  /** False when the server revealed something other than what it committed
   *  to. Never silently ignored — the UI stops on it. */
  verified: boolean;
}

/** Thrown when the server contradicts its own commitment. Mirrors the solo
 *  path's FairnessError: a mismatch is never swallowed. */
export class MultiplayerFairnessError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = 'MultiplayerFairnessError';
    this.detail = detail;
  }
}

export interface MultiplayerError extends Error {
  code: string;
  status?: number;
}

/**
 * Multiplayer talks to its OWN function, not to `play`.
 *
 * `play` is the function that credits USDC purchases. Adding six cases to its
 * switch would mean every change to a game screen republishes the code that
 * touches money — and that path has already been broken twice by things that
 * had nothing to do with it. Two functions, two blast radii.
 */
async function callMp(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.functions.invoke('mp', { body });
  if (error) {
    const res = (error as { context?: Response }).context;
    if (res && typeof res.status === 'number') {
      let code = 'http_error';
      try {
        const parsed = (await res.json()) as { error?: string };
        code = parsed.error ?? code;
      } catch {
        /* not JSON */
      }
      const wrapped = new Error(code) as MultiplayerError;
      wrapped.code = code;
      wrapped.status = res.status;
      throw wrapped;
    }
    throw error;
  }
  return data as Record<string, unknown>;
}

/**
 * The check that keeps "the server is in the trust base" honest.
 *
 * Recomputes both digests from what came back and compares them to the
 * commitments recorded before either player moved. Runs on every resolved
 * round, for both seats — checking only the opponent's would leave the server
 * free to rewrite the loser's own move.
 */
export async function verifyRound(payload: Record<string, unknown>): Promise<boolean> {
  const roundId = Number(payload.round_id);
  const pairs: Array<[Seat, unknown, unknown, unknown]> = [
    ['a', payload.a_move, payload.a_nonce, payload.a_commitment],
    ['b', payload.b_move, payload.b_nonce, payload.b_commitment],
  ];
  for (const [seat, move, nonce, commitment] of pairs) {
    // A timed-out player never committed, so there is nothing to check and
    // nothing to be suspicious about.
    if (move == null && nonce == null && commitment == null) continue;
    if (typeof move !== 'string' || typeof nonce !== 'string' || typeof commitment !== 'string') {
      return false;
    }
    const bytes = new TextEncoder().encode(`${roundId}:${seat}:${move}:${nonce}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== commitment) return false;
  }
  return true;
}

function asSeat(v: unknown): Seat {
  return v === 'b' ? 'b' : 'a';
}

function asChoice(v: unknown): Choice | null {
  return v === 'rock' || v === 'paper' || v === 'scissors' ? v : null;
}

export interface MultiplayerApi {
  createTable: (format: MatchFormat, stake: number) => Promise<TableSummary>;
  joinTable: (code: string) => Promise<TableSummary>;
  state: (tableId: string) => Promise<TableState>;
  openRound: (tableId: string) => Promise<number>;
  commit: (tableId: string, roundId: number, move: Choice) => Promise<void>;
  reveal: (roundId: number) => Promise<void>;
  result: (roundId: number) => Promise<RoundResult>;
}

export function createMultiplayer(client: SupabaseClient): MultiplayerApi {
  return {
    async createTable(format, stake) {
      const d = await callMp(client, { action: 'mp_create', format, stake });
      return {
        tableId: String(d.table_id),
        inviteCode: typeof d.invite_code === 'string' ? d.invite_code : null,
        format,
        seat: 'a',
        status: 'open',
        stake: Number(d.stake ?? 0),
        pot: Number(d.pot ?? 0),
        rake: Number(d.rake ?? 0),
        payout: Number(d.payout ?? 0),
      };
    },

    async joinTable(code) {
      const d = await callMp(client, { action: 'mp_join', code });
      return {
        tableId: String(d.table_id),
        inviteCode: null,
        format: (d.format as MatchFormat) ?? 'single',
        seat: asSeat(d.seat),
        status: (d.status as TableSummary['status']) ?? 'playing',
        stake: Number(d.stake ?? 0),
        pot: Number(d.pot ?? 0),
        rake: Number(d.rake ?? 0),
        payout: Number(d.payout ?? 0),
      };
    },

    async state(tableId) {
      const d = await callMp(client, { action: 'mp_state', table_id: tableId });
      const r = d.round as Record<string, unknown> | null;
      return {
        seat: asSeat(d.seat),
        status: d.status as TableState['status'],
        format: (d.format as MatchFormat) ?? 'single',
        inviteCode: typeof d.invite_code === 'string' ? d.invite_code : null,
        opponentSeated: Boolean(d.opponent_seated),
        score: {
          a: Number((d.score as Record<string, unknown> | null)?.a ?? 0),
          b: Number((d.score as Record<string, unknown> | null)?.b ?? 0),
        },
        result: d.result === 'a' || d.result === 'b' ? d.result : null,
        round: r
          ? {
              roundId: Number(r.round_id),
              roundNumber: Number(r.round_number),
              state: r.state as 'open' | 'committed' | 'resolved' | 'void',
              youCommitted: Boolean(r.you_committed),
              bothCommitted: Boolean(r.both_committed),
              youRevealed: Boolean(r.you_revealed),
              outcome: (r.outcome as Seat | 'tie' | null) ?? null,
              resolution: (r.resolution as Resolution | null) ?? null,
            }
          : null,
      };
    },

    async openRound(tableId) {
      const d = await callMp(client, { action: 'mp_open_round', table_id: tableId });
      return Number(d.round_id);
    },

    async commit(tableId, roundId, move) {
      await callMp(client, { action: 'mp_commit', table_id: tableId, round_id: roundId, move });
    },

    async reveal(roundId) {
      await callMp(client, { action: 'mp_reveal', round_id: roundId });
    },

    async result(roundId) {
      const d = await callMp(client, { action: 'mp_result', round_id: roundId });
      if (!d.settled) {
        return {
          settled: false,
          roundId,
          you: 'a',
          outcome: null,
          resolution: null,
          yourMove: null,
          opponentMove: null,
          score: { a: 0, b: 0 },
          tableStatus: 'playing',
          tableResult: null,
          stake: 0,
          pot: 0,
          rake: 0,
          payout: 0,
          verified: true,
        };
      }

      const verified = await verifyRound(d);
      if (!verified) {
        throw new MultiplayerFairnessError(
          'That result could not be verified.',
          `round ${roundId}: a revealed move did not hash to the commitment recorded before the round`,
        );
      }

      const you = asSeat(d.you);
      return {
        settled: true,
        roundId,
        you,
        outcome: (d.outcome as Seat | 'tie' | null) ?? null,
        resolution: (d.resolution as Resolution | null) ?? null,
        yourMove: asChoice(you === 'a' ? d.a_move : d.b_move),
        opponentMove: asChoice(you === 'a' ? d.b_move : d.a_move),
        score: {
          a: Number((d.score as Record<string, unknown> | null)?.a ?? 0),
          b: Number((d.score as Record<string, unknown> | null)?.b ?? 0),
        },
        tableStatus: String(d.table_status ?? 'playing'),
        tableResult: d.table_result === 'a' || d.table_result === 'b' ? d.table_result : null,
        stake: Number(d.stake ?? 0),
        pot: Number(d.pot ?? 0),
        rake: Number(d.rake ?? 0),
        payout: Number(d.payout ?? 0),
        verified,
      };
    },
  };
}

/** The stake menu, read straight from the table the constraint guards. RLS
 *  exposes only active rows, and the arithmetic is recomputed here from
 *  `rake_bps` rather than trusted from anywhere else. */
export async function loadStakeOptions(client: SupabaseClient): Promise<StakeOption[]> {
  const { data, error } = await client
    .from('mp_stake_options')
    .select('stake_chips, rake_bps')
    .order('stake_chips');
  if (error || !data) return [{ stake: 0, pot: 0, rake: 0, payout: 0 }];
  return data.map((row) => {
    const stake = Number(row.stake_chips);
    const pot = stake * 2;
    const rake = Math.floor((pot * Number(row.rake_bps)) / 10000);
    return { stake, pot, rake, payout: pot - rake };
  });
}
