import { useEffect, useRef } from 'react';
import type { MatchFormat, MatchStatus, RoundOutcome, Score } from '../types/game';
import type { RoundEntry } from '../utils/roundHistory';
import type { Persistence } from '../data/persistence';
import type { ThemeId } from '../constants/themes';

/**
 * Records a match to persistence exactly once when it completes.
 *
 * useGame is a protected file and stores nothing on its own — history is
 * derived in the UI layer, deliberately. This hook watches that derived state
 * from the outside and calls the persistence backend when the match transitions
 * to `complete`. Nothing here mutates game state; the game itself is unaware
 * persistence exists.
 *
 * De-dupes on a match key that only changes when a new match starts. React
 * strict mode fires effects twice and a re-render caused by any nearby state
 * change would otherwise trigger a duplicate insert.
 */
interface Snapshot {
  matchStatus: MatchStatus;
  matchWinner: 'player' | 'opponent' | null;
  format: MatchFormat;
  score: Score;
  history: RoundEntry[];
  theme: ThemeId;
  fast: boolean;
}

export function useMatchPersistence(persistence: Persistence, snap: Snapshot): void {
  // A stable identity for "this specific match". Any new match resets to
  // roundNumber 1 with an empty history, so the tuple (start-time proxy)
  // suffices. We use the reference to the history ARRAY plus the completion
  // flag — a new match gets a new array, so the ref moves.
  const recordedRef = useRef<RoundEntry[] | null>(null);

  useEffect(() => {
    if (!persistence.persists) return;
    if (snap.matchStatus !== 'complete') return;
    if (snap.history.length === 0) return; // nothing to record — nothing happened
    if (recordedRef.current === snap.history) return; // already recorded THIS match

    recordedRef.current = snap.history;

    const result: RoundOutcome =
      snap.matchWinner === 'player' ? 'win' : snap.matchWinner === 'opponent' ? 'lose' : 'tie';

    void persistence.recordMatch(
      {
        format: snap.format,
        player_score: snap.score.player,
        opponent_score: snap.score.opponent,
        result,
        theme: snap.theme,
        fast_mode: snap.fast,
      },
      snap.history.map((e) => ({
        round_number: e.round,
        player_choice: e.player,
        opponent_choice: e.opponent,
        outcome: e.outcome,
      })),
    );
  }, [persistence, snap.matchStatus, snap.history, snap.matchWinner, snap.format, snap.score.player, snap.score.opponent, snap.theme, snap.fast]);
}
