import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Choice, MatchFormat } from '../types/game';
import { getSupabase } from '../data/supabaseClient';
import {
  createLocalRounds,
  createServerRounds,
  FairnessError,
  RoundError,
  type OpenRound,
  type RoundsApi,
} from '../data/rounds';

/**
 * Owns the round lifecycle around `useGame`, which stores nothing and knows
 * only how to ask for the opponent's move.
 *
 * The seam it returns is deliberately a promise that can stay PENDING. The
 * round screen derives its phase from state — it holds the wind-up until
 * `botChoice` arrives rather than snapping on a timer — so an unresolved
 * promise reads as a held coil, not a broken animation. Every failure path here
 * either eventually resolves it or leaves it pending with something on screen
 * explaining why. It is never rejected: a rejection inside useGame's reveal
 * timer would be an unhandled error with no owner.
 */

export type RoundTrouble =
  | { kind: 'none' }
  /** Auto-retrying a dropped request. The player's move is already committed. */
  | { kind: 'retrying'; attempt: number }
  /** Auto-retry gave up. Manual retry still works — the round is durable. */
  | { kind: 'offline' }
  /** The server refused for a reason retrying cannot fix. */
  | { kind: 'refused'; code: string }
  /** The server contradicted itself. Halt; do not continue the match. */
  | { kind: 'fairness'; detail: string };

const MAX_AUTO_RETRIES = 3;
const BACKOFF_MS = [400, 1200, 2500];
const COMMITTED_KEY = 'evenshock:committed-round';

interface Committed {
  matchId: string;
  round: OpenRound;
  choice: Choice;
}

export interface RoundsState {
  /** Pass to useGame as `resolveOpponentChoice`. */
  resolveOpponentChoice: (choice: Choice) => Promise<Choice>;
  trouble: RoundTrouble;
  /** True only when a result could be checked by someone else. Guests: false. */
  verifiable: boolean;
  beginMatch: (format: MatchFormat, theme: string | null, fast: boolean) => void;
  /** Prefetch the next round's commitment. Safe to call repeatedly. */
  prefetch: () => void;
  retry: () => void;
  reset: () => void;
}

export function useRounds(authenticated: boolean): RoundsState {
  const client = getSupabase();
  const api: RoundsApi = useMemo(
    () => (authenticated && client ? createServerRounds(client) : createLocalRounds()),
    [authenticated, client],
  );

  const [trouble, setTrouble] = useState<RoundTrouble>({ kind: 'none' });

  const matchIdRef = useRef<string | null>(null);
  const matchInFlight = useRef<Promise<string> | null>(null);
  const openRoundRef = useRef<OpenRound | null>(null);
  const openInFlight = useRef<Promise<OpenRound> | null>(null);
  const matchOpts = useRef<{ format: MatchFormat; theme: string | null; fast: boolean }>({
    format: 'single',
    theme: null,
    fast: false,
  });
  /** The submit currently waiting on an answer, and how to hand it back. */
  const pending = useRef<{ committed: Committed; resolve: (c: Choice) => void } | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  const ensureMatch = useCallback(async (): Promise<string> => {
    if (matchIdRef.current) return matchIdRef.current;
    if (!matchInFlight.current) {
      const { format, theme, fast } = matchOpts.current;
      matchInFlight.current = api
        .openMatch(format, theme, fast)
        .then((id) => {
          matchIdRef.current = id;
          return id;
        })
        .finally(() => {
          matchInFlight.current = null;
        });
    }
    return matchInFlight.current;
  }, [api]);

  const ensureRound = useCallback(async (): Promise<OpenRound> => {
    if (openRoundRef.current) return openRoundRef.current;
    if (!openInFlight.current) {
      openInFlight.current = (async () => {
        const matchId = await ensureMatch();
        const round = await api.openRound(matchId);
        openRoundRef.current = round;
        return round;
      })().finally(() => {
        openInFlight.current = null;
      });
    }
    return openInFlight.current;
  }, [api, ensureMatch]);

  /**
   * One submit attempt. Retryable failures come back around; deliberate
   * refusals and fairness failures stop here and surface.
   */
  const attempt = useCallback(
    async (committed: Committed, attemptNo: number): Promise<void> => {
      try {
        const reveal = await api.submit(committed.round, committed.choice);
        sessionStorage.removeItem(COMMITTED_KEY);
        openRoundRef.current = null;
        setTrouble({ kind: 'none' });
        const p = pending.current;
        pending.current = null;
        p?.resolve(reveal.opponentChoice);
      } catch (err) {
        if (err instanceof FairnessError) {
          // Loud in two directions. The console line is for whoever is holding
          // the device; the report is the half that reaches us, because a
          // console in a stranger's browser is the one place we can never look.
          // eslint-disable-next-line no-console
          console.error('[evenshock] FAIRNESS CHECK FAILED —', err.message, '\n', err.detail);
          void api.reportIntegrity(err.kind, {
            match_id: committed.matchId,
            round_id: committed.round.roundId,
            round_number: committed.round.roundNumber,
            commitment: committed.round.commitment,
            player_choice: committed.choice,
            detail: err.detail,
          });
          setTrouble({ kind: 'fairness', detail: err.detail });
          return; // seam stays pending: the match must not continue
        }

        if (err instanceof RoundError) {
          if (err.code === 'already_submitted') {
            // A different move is recorded for this round. Not recoverable by
            // retrying, and worth showing rather than papering over.
            setTrouble({ kind: 'refused', code: err.code });
            return;
          }
          setTrouble({ kind: 'refused', code: err.code });
          return;
        }

        // Anything else is a transport failure: the request may or may not have
        // reached the server. Retrying is safe because submit is idempotent on
        // (round_id, move) — the same move replays the same reveal.
        if (attemptNo < MAX_AUTO_RETRIES) {
          setTrouble({ kind: 'retrying', attempt: attemptNo + 1 });
          retryTimer.current = setTimeout(
            () => void attempt(committed, attemptNo + 1),
            BACKOFF_MS[Math.min(attemptNo, BACKOFF_MS.length - 1)],
          );
          return;
        }
        setTrouble({ kind: 'offline' });
      }
    },
    [api],
  );

  const resolveOpponentChoice = useCallback(
    (choice: Choice): Promise<Choice> =>
      new Promise<Choice>((resolve) => {
        void (async () => {
          try {
            const round = await ensureRound();
            const committed: Committed = {
              matchId: matchIdRef.current ?? 'local',
              round,
              choice,
            };
            // Written BEFORE the request goes out. If the tab reloads between
            // here and the answer, the move is not lost — see the resume effect.
            try {
              sessionStorage.setItem(COMMITTED_KEY, JSON.stringify(committed));
            } catch {
              /* private mode; the round is still durable server-side */
            }
            pending.current = { committed, resolve };
            await attempt(committed, 0);
          } catch (err) {
            // Failure to even open a round. The player has committed in the UI,
            // so hold rather than resolving with a made-up move.
            if (err instanceof FairnessError) {
              // eslint-disable-next-line no-console
              console.error('[evenshock] FAIRNESS CHECK FAILED —', err.message, '\n', err.detail);
              setTrouble({ kind: 'fairness', detail: err.detail });
              return;
            }
            setTrouble({ kind: 'offline' });
          }
        })();
      }),
    [attempt, ensureRound],
  );

  const retry = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    setTrouble({ kind: 'retrying', attempt: 1 });
    void attempt(p.committed, 0);
  }, [attempt]);

  const reset = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    matchIdRef.current = null;
    openRoundRef.current = null;
    pending.current = null;
    setTrouble({ kind: 'none' });
    try {
      sessionStorage.removeItem(COMMITTED_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const beginMatch = useCallback(
    (format: MatchFormat, theme: string | null, fast: boolean) => {
      reset();
      matchOpts.current = { format, theme, fast };
      // Round 1's commitment is fetched now, during the Home→round transition,
      // so the first tap does not wait for it — and so a cold start lands here
      // rather than inside a reveal.
      void ensureRound().catch(() => setTrouble({ kind: 'offline' }));
    },
    [ensureRound, reset],
  );

  const prefetch = useCallback(() => {
    void ensureRound().catch(() => {
      /* the tap path will surface it; a failed prefetch is not yet a problem */
    });
  }, [ensureRound]);

  /**
   * Resume after a reload that happened between committing a move and seeing
   * the answer.
   *
   * What this does: resolves the round server-side with the SAME move, so the
   * player's committed move is honoured and no round is left dangling.
   *
   * What it does NOT do: put the player back in the match. Restoring score,
   * round number and history means rehydrating `useGame`, which would change
   * the shape we agreed to keep. So the round is settled and the record is
   * correct, but the player lands on Home. Worth revisiting if it happens
   * often enough to notice.
   */
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(COMMITTED_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      sessionStorage.removeItem(COMMITTED_KEY);
    } catch {
      /* ignore */
    }
    let committed: Committed;
    try {
      committed = JSON.parse(raw) as Committed;
    } catch {
      return;
    }
    if (!committed?.round?.roundId) return;
    // Idempotent: the same move returns the same reveal it would have then.
    void api.submit(committed.round, committed.choice).catch(() => {
      /* nothing more to do — the round expires on its own */
    });
  }, [api]);

  return {
    resolveOpponentChoice,
    trouble,
    verifiable: api.verifiable,
    beginMatch,
    prefetch,
    retry,
    reset,
  };
}
