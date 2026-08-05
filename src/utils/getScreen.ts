import type { Screen } from '../types/game';
import type { UseGameReturn } from '../hooks/useGame';

/** Derives which screen to render from useGame's state — no duplicated screen state to keep in sync. */
export function getScreen(game: UseGameReturn): Screen {
  if (game.matchStatus === 'idle') return 'home';
  if (game.showMatchEnd) return 'matchEnd';
  if (game.botChoice === null) return 'game';
  return 'roundResult';
}
