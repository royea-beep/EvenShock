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
 * Which solo opponent a match is against.
 *
 * `random` draws uniformly every round; `nemesis` reads the player's bias and
 * plays the counter some of the time. It lives here rather than in the Nemesis
 * data seam because it is a property of the MATCH — `matches.opponent` on the
 * server, and the mode-selection telemetry with it — not of the debrief.
 */
export type Opponent = 'random' | 'nemesis';

/**
 * Screen the SPA is currently showing. Drives which component App renders.
 * A round's picking / revealing / result states are all one screen, so the
 * hands stay mounted through the reveal snap instead of being swapped out.
 */
export type Screen = 'home' | 'round' | 'matchEnd';
