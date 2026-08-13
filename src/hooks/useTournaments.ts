import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSupabase } from '../data/supabaseClient';
import {
  createTournaments,
  type BracketSlot,
  type TournamentMoney,
  type TournamentSummary,
  type TournamentsApi,
} from '../data/tournaments';

/**
 * The tournament surface, as a small state machine over a polled server.
 *
 * POLLING, FOR THE SAME REASON AS THE FRIEND MATCH. A bracket changes when
 * OTHER people finish their matches, so it cannot be driven by this client's
 * own actions alone. Realtime would need private channels with verified RLS on
 * `realtime.messages`; until that is done end to end, a channel is a thing a
 * hostile client subscribes to. Polling is slower and completely honest about
 * what it exposes.
 *
 * IT ONLY POLLS A BRACKET THAT CAN STILL MOVE. A complete or cancelled
 * tournament is final, so the timer stops — a finished bracket that keeps
 * asking is just a battery drain on a screen nobody is waiting on.
 */

const BRACKET_POLL_MS = 4_000;

export type TournamentPhase =
  | { kind: 'closed' }
  | { kind: 'list' }
  /** Reading the entry fee before committing to it. */
  | { kind: 'confirm'; tournament: TournamentSummary }
  | { kind: 'bracket'; id: string };

export interface TournamentsState {
  phase: TournamentPhase;
  tournaments: TournamentSummary[];
  /** Null until the first list lands — the lobby waits rather than showing an
   *  empty state it has not confirmed. */
  listLoaded: boolean;
  slots: BracketSlot[];
  money: TournamentMoney | null;
  busy: boolean;
  error: string | null;
  open: () => void;
  close: () => void;
  askJoin: (t: TournamentSummary) => void;
  confirmJoin: () => void;
  cancelJoin: () => void;
  view: (id: string) => void;
  backToList: () => void;
  /** Opens (or rejoins) the mp table for a bracket slot. Resolves with the
   *  invite code, which the caller hands to the friend-match flow. */
  playSlot: (roundNo: number, slot: number) => Promise<string | null>;
}

export function useTournaments(authenticated: boolean): TournamentsState {
  const client = getSupabase();
  const api: TournamentsApi | null = useMemo(
    () => (authenticated && client ? createTournaments(client) : null),
    [authenticated, client],
  );

  const [phase, setPhase] = useState<TournamentPhase>({ kind: 'closed' });
  const [tournaments, setTournaments] = useState<TournamentSummary[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [slots, setSlots] = useState<BracketSlot[]>([]);
  const [money, setMoney] = useState<TournamentMoney | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }, []);
  useEffect(() => stopPoll, [stopPoll]);

  const refreshList = useCallback(async () => {
    if (!api) return;
    try {
      setTournaments(await api.list());
      setListLoaded(true);
      setError(null);
    } catch (e) {
      setError(errCode(e));
    }
  }, [api]);

  const open = useCallback(() => {
    setPhase({ kind: 'list' });
    setError(null);
    void refreshList();
  }, [refreshList]);

  const close = useCallback(() => {
    stopPoll();
    setPhase({ kind: 'closed' });
    setError(null);
  }, [stopPoll]);

  const askJoin = useCallback((t: TournamentSummary) => {
    setError(null);
    setPhase({ kind: 'confirm', tournament: t });
  }, []);

  const cancelJoin = useCallback(() => {
    setError(null);
    setPhase({ kind: 'list' });
  }, []);

  const view = useCallback((id: string) => {
    setError(null);
    setSlots([]);
    setMoney(null);
    setPhase({ kind: 'bracket', id });
  }, []);

  const backToList = useCallback(() => {
    stopPoll();
    setPhase({ kind: 'list' });
    void refreshList();
  }, [stopPoll, refreshList]);

  const confirmJoin = useCallback(() => {
    if (!api || phase.kind !== 'confirm') return;
    const id = phase.tournament.id;
    setBusy(true);
    setError(null);
    void api
      .register(id)
      // Straight into the bracket on success: entering and then being dropped
      // back on a list would make the player hunt for the thing they just paid
      // to join.
      .then(() => view(id))
      .catch((e: unknown) => setError(errCode(e)))
      .finally(() => setBusy(false));
  }, [api, phase, view]);

  // The bracket poll. Re-reads the draw and the money together, because the
  // pool grows while registration is open and the payout appears the moment
  // the final lands.
  useEffect(() => {
    if (!api || phase.kind !== 'bracket') return;
    let cancelled = false;
    const id = phase.id;

    const tick = async () => {
      try {
        const { slots: rows, money: m } = await api.bracket(id);
        if (cancelled) return;
        setSlots(rows);
        setMoney(m);
        setError(null);
        // A finished tournament cannot change again.
        if (m.status === 'complete' || m.status === 'cancelled') return;
      } catch (e) {
        if (cancelled) return;
        setError(errCode(e));
      }
      if (!cancelled) pollRef.current = setTimeout(() => void tick(), BRACKET_POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      stopPoll();
    };
  }, [api, phase, stopPoll]);

  const playSlot = useCallback(
    async (roundNo: number, slot: number): Promise<string | null> => {
      if (!api || phase.kind !== 'bracket') return null;
      setBusy(true);
      setError(null);
      try {
        const opened = await api.openMatch(phase.id, roundNo, slot);
        return opened.inviteCode;
      } catch (e) {
        setError(errCode(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api, phase],
  );

  return {
    phase,
    tournaments,
    listLoaded,
    slots,
    money,
    busy,
    error,
    open,
    close,
    askJoin,
    confirmJoin,
    cancelJoin,
    view,
    backToList,
    playSlot,
  };
}

function errCode(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return e instanceof Error ? e.message : String(e);
}
