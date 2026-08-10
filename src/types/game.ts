/**
 * `Choice`, `RoundOutcome`, `MatchFormat` and `Score` are re-exported from
 * `utils/rules.ts` rather than declared here. That file is the one the Edge
 * Function also runs, so the move vocabulary the server validates against and
 * the one the UI renders are the same declaration, not two that happen to
 * match today.
 */
export type { Choice, RoundOutcome, MatchFormat, Score } from '../utils/rules';

export type MatchStatus = 'idle' | 'playing' | 'complete';

/**
 * Screen the SPA is currently showing. Drives which component App renders.
 * A round's picking / revealing / result states are all one screen, so the
 * hands stay mounted through the reveal snap instead of being swapped out.
 */
export type Screen = 'home' | 'round' | 'matchEnd';
