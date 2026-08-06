export type Choice = 'rock' | 'paper' | 'scissors';

export type MatchFormat = 'single' | 'bo3' | 'bo5';

/** Outcome from the local player's point of view. */
export type RoundOutcome = 'win' | 'lose' | 'tie';

export type MatchStatus = 'idle' | 'playing' | 'complete';

/**
 * Screen the SPA is currently showing. Drives which component App renders.
 * A round's picking / revealing / result states are all one screen, so the
 * hands stay mounted through the reveal snap instead of being swapped out.
 */
export type Screen = 'home' | 'round' | 'matchEnd';

export interface Score {
  player: number;
  opponent: number;
}
