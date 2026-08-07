import type { Choice, RoundOutcome } from '../types/game';

export interface RoundEntry {
  /** useGame's roundNumber, which counts ties as their own round. */
  round: number;
  outcome: RoundOutcome;
  player: Choice;
  opponent: Choice;
}

/** The slice of useGame's state that the history is derived from. */
export interface HistorySnapshot {
  roundNumber: number;
  roundResult: RoundOutcome | null;
  playerChoice: Choice | null;
  botChoice: Choice | null;
}

export interface HistoryState {
  entries: RoundEntry[];
  /** The last roundNumber written, so a re-render can't double-record it. */
  recorded: number | null;
}

export const EMPTY_HISTORY: HistoryState = { entries: [], recorded: null };

/**
 * True when the game is sitting at the very start of a match.
 *
 * This is the reset signal, and it is exact rather than heuristic: round 1 with
 * no pick and no result is reachable only from startMatch() or playAgain(). It
 * cannot recur mid-match, because a round that has been played either still
 * shows its result or has already advanced the round number — including ties,
 * which increment roundNumber like any other round.
 */
export function isFreshMatch(s: HistorySnapshot): boolean {
  return s.roundNumber === 1 && s.roundResult === null && s.playerChoice === null;
}

/**
 * Folds one observation of game state into the history. Pure, so the reset
 * behaviour is testable without rendering anything.
 */
export function reduceHistory(prev: HistoryState, s: HistorySnapshot): HistoryState {
  if (isFreshMatch(s)) return EMPTY_HISTORY;

  const complete = s.roundResult !== null && s.playerChoice !== null && s.botChoice !== null;
  if (!complete || prev.recorded === s.roundNumber) return prev;

  return {
    recorded: s.roundNumber,
    entries: [
      ...prev.entries,
      {
        round: s.roundNumber,
        outcome: s.roundResult as RoundOutcome,
        player: s.playerChoice as Choice,
        opponent: s.botChoice as Choice,
      },
    ],
  };
}

export interface MatchStats {
  played: number;
  wins: number;
  losses: number;
  ties: number;
  /** Wins as a share of DECIDED rounds; null when every round was a tie. */
  winRate: number | null;
  /** Most-played move, and how often. null on an empty history. */
  topMove: { choice: Choice; count: number } | null;
}

const MOVE_ORDER: Choice[] = ['rock', 'paper', 'scissors'];

export function getMatchStats(entries: RoundEntry[]): MatchStats {
  const wins = entries.filter((e) => e.outcome === 'win').length;
  const losses = entries.filter((e) => e.outcome === 'lose').length;
  const ties = entries.filter((e) => e.outcome === 'tie').length;
  const decided = wins + losses;

  const counts = new Map<Choice, number>();
  for (const e of entries) counts.set(e.player, (counts.get(e.player) ?? 0) + 1);

  // Ties on count resolve by rock/paper/scissors order so the result is stable
  // rather than dependent on which move happened to be seen first.
  let topMove: MatchStats['topMove'] = null;
  for (const choice of MOVE_ORDER) {
    const count = counts.get(choice) ?? 0;
    if (count > 0 && (topMove === null || count > topMove.count)) topMove = { choice, count };
  }

  return {
    played: entries.length,
    wins,
    losses,
    ties,
    winRate: decided === 0 ? null : wins / decided,
    topMove,
  };
}
