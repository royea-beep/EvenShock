import type { SupabaseClient } from '@supabase/supabase-js';
import type { MatchFormat } from '../utils/rules';

/**
 * Tournaments, client side.
 *
 * EVERYTHING GOES THROUGH THE `tournaments` EDGE FUNCTION. Not one call here
 * is a direct `.rpc()`, and that is not a style choice: every tournament_*
 * function is revoked from `anon` and `authenticated`, because registering
 * debits an entry fee and settling pays a pool. The browser has no grant to
 * call them with. The function verifies a JWT signature and passes the SUBJECT
 * as the user id, so the entrant is whoever the token says, never whoever the
 * body claims.
 *
 * WHAT A TOURNAMENT MATCH ACTUALLY IS: an ordinary mp table. `openMatch`
 * returns a table id and invite code from `mp_create_table` / `mp_join_table`,
 * and from that point the existing versus screen plays it — same commit,
 * same reveal, same verification. The bracket slot only remembers which table
 * it was, and `mp_settle` reports the winner back into it. There is no second
 * game loop to keep in sync with the first.
 */

export type TournamentStatus = 'upcoming' | 'registering' | 'running' | 'complete' | 'cancelled';
export type SlotStatus = 'pending' | 'complete' | 'bye';

/**
 * Why a player cannot join, as a code rather than a disabled button. A greyed
 * control with no reason is the same to a player as a broken one.
 */
export type JoinBlock =
  | 'already_entered'
  | 'not_registering'
  | 'full'
  | 'unrateable_player'
  | 'insufficient_chips';

export interface TournamentSummary {
  id: string;
  name: string;
  status: TournamentStatus;
  format: MatchFormat;
  entryFee: number;
  prizePool: number;
  maxPlayers: number;
  entrants: number;
  startsAt: string | null;
  youEntered: boolean;
  joinBlock: JoinBlock | null;
}

export interface BracketPlayer {
  id: string | null;
  name: string | null;
  seed: number | null;
}

export interface BracketSlot {
  roundNo: number;
  slot: number;
  status: SlotStatus;
  a: BracketPlayer;
  b: BracketPlayer;
  winner: string | null;
  mpTableId: string | null;
  yourTurn: boolean;
}

export interface PodiumRow {
  position: number;
  name: string;
  prize: number;
}

/** The money, as the payout panel states it. `houseCut` is always 0 and is
 *  carried explicitly rather than omitted — see copy.tournaments.poolLine. */
export interface TournamentMoney {
  tournamentId: string;
  name: string;
  status: TournamentStatus;
  entryFee: number;
  pool: number;
  houseCut: number;
  entrants: number;
  you: { seed: number | null; position: number | null; prize: number; paid: number; net: number } | null;
  podium: PodiumRow[];
}

export interface OpenedMatch {
  tableId: string;
  inviteCode: string | null;
  format: MatchFormat;
  seat: 'a' | 'b';
}

export interface TournamentError extends Error {
  code: string;
  status?: number;
}

async function callTournaments(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.functions.invoke('tournaments', { body });
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
      const wrapped = new Error(code) as TournamentError;
      wrapped.code = code;
      wrapped.status = res.status;
      throw wrapped;
    }
    throw error;
  }
  return data as Record<string, unknown>;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function asSummary(row: Record<string, unknown>): TournamentSummary {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    status: (row.status as TournamentStatus) ?? 'upcoming',
    format: (row.format as MatchFormat) ?? 'bo5',
    entryFee: num(row.entry_fee_chips),
    prizePool: num(row.prize_pool_chips),
    maxPlayers: num(row.max_players),
    entrants: num(row.entrants),
    startsAt: str(row.starts_at),
    youEntered: row.you_entered === true,
    joinBlock: (str(row.join_block) as JoinBlock | null) ?? null,
  };
}

function asSlot(row: Record<string, unknown>): BracketSlot {
  return {
    roundNo: num(row.round_no),
    slot: num(row.slot),
    status: (row.status as SlotStatus) ?? 'pending',
    a: { id: str(row.player_a), name: str(row.player_a_name), seed: row.player_a_seed == null ? null : num(row.player_a_seed) },
    b: { id: str(row.player_b), name: str(row.player_b_name), seed: row.player_b_seed == null ? null : num(row.player_b_seed) },
    winner: str(row.winner),
    mpTableId: str(row.mp_table_id),
    yourTurn: row.your_turn === true,
  };
}

function asMoney(row: Record<string, unknown>): TournamentMoney {
  const you = row.you as Record<string, unknown> | null;
  return {
    tournamentId: String(row.tournament_id),
    name: String(row.name ?? ''),
    status: (row.status as TournamentStatus) ?? 'upcoming',
    entryFee: num(row.entry_fee),
    pool: num(row.pool),
    houseCut: num(row.house_cut),
    entrants: num(row.entrants),
    you: you
      ? {
          seed: you.seed == null ? null : num(you.seed),
          position: you.position == null ? null : num(you.position),
          prize: num(you.prize),
          paid: num(you.paid),
          net: num(you.net),
        }
      : null,
    podium: Array.isArray(row.podium)
      ? (row.podium as Record<string, unknown>[]).map((p) => ({
          position: num(p.position),
          name: String(p.name ?? ''),
          prize: num(p.prize),
        }))
      : [],
  };
}

export interface TournamentsApi {
  list: () => Promise<TournamentSummary[]>;
  bracket: (id: string) => Promise<{ slots: BracketSlot[]; money: TournamentMoney }>;
  register: (id: string) => Promise<void>;
  openMatch: (id: string, roundNo: number, slot: number) => Promise<OpenedMatch>;
  result: (id: string) => Promise<TournamentMoney>;
}

export function createTournaments(client: SupabaseClient): TournamentsApi {
  return {
    async list() {
      const d = await callTournaments(client, { action: 'list' });
      const rows = Array.isArray(d.tournaments) ? (d.tournaments as Record<string, unknown>[]) : [];
      return rows.map(asSummary);
    },

    async bracket(id) {
      const d = await callTournaments(client, { action: 'bracket', tournament_id: id });
      const rows = Array.isArray(d.bracket) ? (d.bracket as Record<string, unknown>[]) : [];
      return {
        slots: rows.map(asSlot),
        money: asMoney((d.summary ?? {}) as Record<string, unknown>),
      };
    },

    async register(id) {
      await callTournaments(client, { action: 'register', tournament_id: id });
    },

    async openMatch(id, roundNo, slot) {
      const d = await callTournaments(client, {
        action: 'open_match',
        tournament_id: id,
        round_no: roundNo,
        slot,
      });
      return {
        tableId: String(d.table_id),
        inviteCode: str(d.invite_code),
        format: (d.format as MatchFormat) ?? 'bo5',
        seat: d.seat === 'b' ? 'b' : 'a',
      };
    },

    async result(id) {
      const d = await callTournaments(client, { action: 'result', tournament_id: id });
      return asMoney(d);
    },
  };
}

// ============================================================ pure helpers
//
// Layout maths, kept out of the components so it can be tested without
// rendering anything.

/**
 * What to call a round, counting BACKWARDS from the final.
 *
 * Counting forwards ("Round 1, Round 2, Round 3") is what the data says and
 * the wrong thing to show: in a 4-player draw round 2 is the final, and in a
 * 16-player draw round 2 is nowhere near it. Naming from the end means the
 * last round is always "Final" whatever the bracket size, which is the only
 * version a player can read at a glance.
 */
export function roundLabel(roundNo: number, totalRounds: number): string {
  const fromEnd = totalRounds - roundNo;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semi-final';
  if (fromEnd === 2) return 'Quarter-final';
  return `Round of ${2 ** (fromEnd + 1)}`;
}

/** Slots grouped into rounds, in play order, for column-per-round rendering. */
export function groupByRound(slots: BracketSlot[]): { roundNo: number; slots: BracketSlot[] }[] {
  const byRound = new Map<number, BracketSlot[]>();
  for (const s of slots) {
    const list = byRound.get(s.roundNo);
    if (list) list.push(s);
    else byRound.set(s.roundNo, [s]);
  }
  return [...byRound.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([roundNo, rows]) => ({ roundNo, slots: [...rows].sort((x, y) => x.slot - y.slot) }));
}

/**
 * The one slot this player should act on, if any.
 *
 * Earliest round first: a bracket can only ever offer one playable slot per
 * player, but taking the earliest is what makes the rule obvious rather than
 * dependent on row order.
 */
export function nextPlayableSlot(slots: BracketSlot[]): BracketSlot | null {
  return (
    [...slots]
      .filter((s) => s.yourTurn)
      .sort((x, y) => x.roundNo - y.roundNo || x.slot - y.slot)[0] ?? null
  );
}

/**
 * How a bye renders. A slot with one player is not a match anybody played, and
 * showing it as a win would credit somebody with beating nobody.
 */
export function isBye(slot: BracketSlot): boolean {
  return slot.status === 'bye' || slot.a.id == null || slot.b.id == null;
}
