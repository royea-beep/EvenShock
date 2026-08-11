import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSupabase } from '../data/supabaseClient';
import {
  createMultiplayer,
  loadStakeOptions,
  MultiplayerFairnessError,
  type MultiplayerApi,
  type RoundResult,
  type StakeOption,
  type TableState,
  type TableSummary,
} from '../data/multiplayer';
import type { Choice, MatchFormat } from '../utils/rules';

/**
 * The friend match, as a state machine over a polled server.
 *
 * POLLING, NOT REALTIME, AND THAT IS A DECISION. Realtime would need private
 * channels with RLS on `realtime.messages` plus "Allow public access" turned
 * off in the dashboard — and until that is verified end to end, a channel is
 * a thing a hostile client subscribes to. Polling `mp_state` is slower and
 * completely honest about what it exposes: the server decides, every time,
 * what this player is allowed to know. The rate limit for mp_state is 240/min,
 * and this asks about once a second only while something is actually pending.
 *
 * WHAT THE POLL MAY NEVER LEARN. `mp_state` answers "have I committed?" and
 * "have both of us committed?" — never "has my opponent moved?". The screen is
 * built on exactly those two facts, so no future refactor can quietly start
 * rendering an asymmetry the server never sent.
 */

export type Phase =
  | { kind: 'lobby' }
  | { kind: 'creating' }
  | { kind: 'joining' }
  /** Table made, code on screen, nobody else has sat down yet. */
  | { kind: 'waiting'; table: TableSummary }
  /** Both seated. `committed` is this player's own move being in. */
  | { kind: 'playing'; table: TableSummary; state: TableState; committed: boolean }
  /** Both committed; we have revealed and are waiting on the other side. */
  | { kind: 'revealing'; table: TableSummary; state: TableState }
  | { kind: 'result'; table: TableSummary; result: RoundResult }
  | { kind: 'error'; code: string };

export interface MultiplayerState {
  phase: Phase;
  stakes: StakeOption[];
  /** Null until the first stake list lands; the picker waits rather than
   *  guessing prices. */
  stakesLoaded: boolean;
  open: () => void;
  close: () => void;
  create: (format: MatchFormat, stake: number) => void;
  join: (code: string) => void;
  choose: (move: Choice) => void;
  /** After a resolved round: start the next one, or leave a finished match. */
  next: () => void;
  active: boolean;
}

const POLL_MS = 1200;

function errCode(e: unknown): string {
  if (e instanceof MultiplayerFairnessError) return 'unverified';
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'network';
}

export function useMultiplayer(authenticated: boolean): MultiplayerState {
  const client = getSupabase();
  const api: MultiplayerApi | null = useMemo(
    () => (authenticated && client ? createMultiplayer(client) : null),
    [authenticated, client],
  );

  const [phase, setPhase] = useState<Phase>({ kind: 'lobby' });
  const [active, setActive] = useState(false);
  const [stakes, setStakes] = useState<StakeOption[]>([]);
  const [stakesLoaded, setStakesLoaded] = useState(false);
  const tableRef = useRef<TableSummary | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards the reveal: it must fire once per round, and the poll that notices
  // `bothCommitted` can easily fire twice before the state updates.
  const revealedRef = useRef<number | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }, []);

  useEffect(() => stopPoll, [stopPoll]);

  // The stake menu is read once per session, on opening — prices belong to the
  // server and the picker must not invent them.
  useEffect(() => {
    if (!active || !client || stakesLoaded) return;
    let cancelled = false;
    void loadStakeOptions(client).then((opts) => {
      if (cancelled) return;
      setStakes(opts);
      setStakesLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [active, client, stakesLoaded]);

  /** One poll tick: read state, and drive whatever it implies. */
  const tick = useCallback(async () => {
    const table = tableRef.current;
    if (!api || !table) return;
    try {
      const state = await api.state(table.tableId);

      if (state.status === 'abandoned') {
        setPhase({ kind: 'error', code: 'table_unavailable' });
        return;
      }

      // Nobody has sat down yet: keep showing the code.
      if (!state.opponentSeated) {
        setPhase({ kind: 'waiting', table });
        schedule();
        return;
      }

      const round = state.round;
      if (!round) {
        // Seated, no round yet. Either client may open it; the RPC is
        // idempotent and returns the same round to both.
        await api.openRound(table.tableId);
        schedule();
        return;
      }

      if (round.state === 'resolved' || round.state === 'void') {
        const result = await api.result(round.roundId);
        revealedRef.current = null;
        setPhase({ kind: 'result', table, result });
        return;
      }

      if (round.bothCommitted && !round.youRevealed && revealedRef.current !== round.roundId) {
        // Both are in. Revealing is unconditionally correct here: the server
        // holds both moves already, and refusing only forfeits.
        revealedRef.current = round.roundId;
        await api.reveal(round.roundId);
        schedule();
        return;
      }

      if (round.youRevealed && !round.outcome) {
        setPhase({ kind: 'revealing', table, state });
        schedule();
        return;
      }

      setPhase({ kind: 'playing', table, state, committed: round.youCommitted });
      schedule();
    } catch (e) {
      setPhase({ kind: 'error', code: errCode(e) });
    }
    // `schedule` is defined below and is stable; the dependency list would be
    // circular if it were included.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const schedule = useCallback(() => {
    stopPoll();
    pollRef.current = setTimeout(() => void tick(), POLL_MS);
  }, [stopPoll, tick]);

  const open = useCallback(() => {
    setActive(true);
    setPhase({ kind: 'lobby' });
  }, []);

  const close = useCallback(() => {
    stopPoll();
    tableRef.current = null;
    revealedRef.current = null;
    setActive(false);
    setPhase({ kind: 'lobby' });
  }, [stopPoll]);

  const create = useCallback(
    (format: MatchFormat, stake: number) => {
      if (!api) return;
      setPhase({ kind: 'creating' });
      void api
        .createTable(format, stake)
        .then((table) => {
          tableRef.current = table;
          setPhase({ kind: 'waiting', table });
          void tick();
        })
        .catch((e: unknown) => setPhase({ kind: 'error', code: errCode(e) }));
    },
    [api, tick],
  );

  const join = useCallback(
    (code: string) => {
      if (!api) return;
      setPhase({ kind: 'joining' });
      void api
        .joinTable(code)
        .then((table) => {
          tableRef.current = table;
          void tick();
        })
        .catch((e: unknown) => setPhase({ kind: 'error', code: errCode(e) }));
    },
    [api, tick],
  );

  const choose = useCallback(
    (move: Choice) => {
      const table = tableRef.current;
      if (!api || !table || phase.kind !== 'playing' || !phase.state.round) return;
      const roundId = phase.state.round.roundId;
      // Optimistic: the button must not stay live while the request is in
      // flight, or a double tap becomes `already_committed`.
      setPhase({ ...phase, committed: true });
      void api
        .commit(table.tableId, roundId, move)
        .then(() => void tick())
        .catch((e: unknown) => setPhase({ kind: 'error', code: errCode(e) }));
    },
    [api, phase, tick],
  );

  const next = useCallback(() => {
    const table = tableRef.current;
    if (!api || !table) return;
    if (phase.kind === 'result' && phase.result.tableStatus === 'finished') {
      close();
      return;
    }
    void api
      .openRound(table.tableId)
      .then(() => void tick())
      .catch((e: unknown) => setPhase({ kind: 'error', code: errCode(e) }));
  }, [api, phase, tick, close]);

  return { phase, stakes, stakesLoaded, open, close, create, join, choose, next, active };
}
