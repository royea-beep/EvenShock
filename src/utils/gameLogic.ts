/**
 * The game's rule surface, unchanged for callers.
 *
 * The rules themselves moved to `rules.ts` so the `play` Edge Function can run
 * the identical code — the server decides outcomes now, and two hand-written
 * implementations would eventually disagree. This file stays as the import path
 * every screen and hook already uses.
 */
export {
  getRoundOutcome,
  getWinsNeeded,
  isMatchComplete,
  getMatchWinner,
  getMatchResult,
  TIES_COUNT_TOWARD_SCORE,
  CHOICES,
} from './rules';
