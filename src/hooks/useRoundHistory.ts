import { useEffect, useState } from 'react';
import {
  EMPTY_HISTORY,
  reduceHistory,
  type HistorySnapshot,
  type HistoryState,
} from '../utils/roundHistory';

/**
 * Round history, derived in the UI layer by watching useGame's state.
 *
 * It is deliberately NOT game state. useGame owns the match, and adding a
 * history array to it would widen the surface that a future multiplayer
 * implementation has to reproduce. Everything needed is already observable:
 * each roundNumber resolves exactly once, so watching for a completed round is
 * enough to reconstruct the trail.
 */
export function useRoundHistory(snapshot: HistorySnapshot): HistoryState['entries'] {
  const [state, setState] = useState<HistoryState>(EMPTY_HISTORY);

  const { roundNumber, roundResult, playerChoice, botChoice } = snapshot;

  useEffect(() => {
    setState((prev) => reduceHistory(prev, { roundNumber, roundResult, playerChoice, botChoice }));
  }, [roundNumber, roundResult, playerChoice, botChoice]);

  return state.entries;
}
