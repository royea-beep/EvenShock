import type { Choice } from '../types/game';

const CHOICES: readonly Choice[] = ['rock', 'paper', 'scissors'];

/**
 * Resolves the opponent's move for a round. Pure random for now.
 *
 * Isolated behind this single export so the multiplayer version (reading a
 * real opponent's move from a Supabase Realtime `matches` row instead of
 * rolling one locally) can replace the implementation — or be swapped in via
 * the `resolveOpponentChoice` param on `useGame` — without any UI changes.
 */
export function getBotChoice(): Choice {
  return CHOICES[Math.floor(Math.random() * CHOICES.length)];
}
