import type { Choice, MatchFormat, RoundOutcome, Score } from '../types/game';

/** What beats what. Rock > Scissors > Paper > Rock. */
const BEATS: Record<Choice, Choice> = {
  rock: 'scissors',
  scissors: 'paper',
  paper: 'rock',
};

export function getRoundOutcome(playerChoice: Choice, opponentChoice: Choice): RoundOutcome {
  if (playerChoice === opponentChoice) return 'tie';
  return BEATS[playerChoice] === opponentChoice ? 'win' : 'lose';
}

/**
 * Explicit rule: a tie does not advance the score, and both players pick
 * again immediately. Flip this to `true` if ties should ever count as a
 * played round (e.g. towards a "best of" round cap) instead of being replayed.
 */
export const TIES_COUNT_TOWARD_SCORE = false;

export function getWinsNeeded(format: MatchFormat): number {
  switch (format) {
    case 'single':
      return 1;
    case 'bo3':
      return 2;
    case 'bo5':
      return 3;
  }
}

export function isMatchComplete(score: Score, format: MatchFormat): boolean {
  const winsNeeded = getWinsNeeded(format);
  return score.player >= winsNeeded || score.opponent >= winsNeeded;
}

export function getMatchWinner(score: Score): 'player' | 'opponent' | null {
  if (score.player === score.opponent) return null;
  return score.player > score.opponent ? 'player' : 'opponent';
}
