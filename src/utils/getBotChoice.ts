import type { Choice } from '../types/game';

const CHOICES: readonly Choice[] = ['rock', 'paper', 'scissors'];

/**
 * The GUEST opponent's move.
 *
 * This is no longer how a signed-in player's rounds are decided. Those are
 * drawn server-side with `crypto.getRandomValues` and committed to before the
 * player moves — see supabase/functions/play. `Math.random()` in the client was
 * exactly the thing that made results forgeable.
 *
 * It survives as the local draw behind `createLocalRounds`, which is guest mode
 * only: nothing a guest plays is recorded or ranked, so there is nothing here
 * worth tampering with. Both paths go through the same `resolveOpponentChoice`
 * seam so guest play exercises the identical state machine.
 */
export function getBotChoice(): Choice {
  return CHOICES[Math.floor(Math.random() * CHOICES.length)];
}
