export type Choice = 'rock' | 'paper' | 'scissors';

export type MatchFormat = 'single' | 'bo3' | 'bo5';

/** Outcome from the local player's point of view. */
export type RoundOutcome = 'win' | 'lose' | 'tie';

export type MatchStatus = 'idle' | 'playing' | 'complete';

/** Screen the SPA is currently showing. Drives which component App renders. */
export type Screen = 'home' | 'game' | 'roundResult' | 'matchEnd';

export interface Score {
  player: number;
  opponent: number;
}
