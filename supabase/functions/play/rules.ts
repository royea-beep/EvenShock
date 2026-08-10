/**
 * The rules of rock-paper-scissors, and nothing else.
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR OUTCOMES, and it runs in two
 * places: the browser, and the `play` Edge Function on Deno. Since the server
 * decides outcomes and the client cross-checks them, a disagreement between the
 * two would surface to a player as the game calling a win a loss. So there is
 * exactly one copy of the logic:
 *
 *   canonical  src/utils/rules.ts        <- edit here, only here
 *   generated  supabase/functions/play/rules.ts
 *
 * `npm run sync:rules` copies this file to the second path byte-for-byte, and
 * `rules.sync.test.ts` fails if they differ, so the copy cannot drift.
 *
 * CONSTRAINT: no imports, ever. Not even `import type`. This file is consumed
 * verbatim by Deno, where a bare specifier or an extensionless relative path
 * would not resolve. Everything it needs is defined here, and the app's own
 * types re-export from this file rather than the other way round.
 */

export type Choice = 'rock' | 'paper' | 'scissors';

/** Outcome from the local player's point of view. */
export type RoundOutcome = 'win' | 'lose' | 'tie';

export type MatchFormat = 'single' | 'bo3' | 'bo5';

export interface Score {
  player: number;
  opponent: number;
}

/** Every legal move, in a fixed order. The server draws uniformly from this. */
export const CHOICES: readonly Choice[] = ['rock', 'paper', 'scissors'];

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

/** The match-level result row value, from the player's point of view. */
export function getMatchResult(score: Score): RoundOutcome {
  const winner = getMatchWinner(score);
  return winner === 'player' ? 'win' : winner === 'opponent' ? 'lose' : 'tie';
}

// ------------------------------------------------------------ rule tables
//
// The database resolves a round in one round trip, which means the lookup has
// to happen in SQL. These tables are how it happens WITHOUT a second copy of
// the rules growing there: they are generated from the functions above and
// passed in as arguments, so `resolve_round` looks the answer up and never
// knows what beats what.

/** Every (player, opponent) pair mapped to its outcome. Keys are "player:opponent". */
export function outcomeTable(): Record<string, RoundOutcome> {
  const table: Record<string, RoundOutcome> = {};
  for (const player of CHOICES) {
    for (const opponent of CHOICES) {
      table[`${player}:${opponent}`] = getRoundOutcome(player, opponent);
    }
  }
  return table;
}

/** Wins required per format, generated from getWinsNeeded. */
export function winsNeededTable(): Record<MatchFormat, number> {
  return {
    single: getWinsNeeded('single'),
    bo3: getWinsNeeded('bo3'),
    bo5: getWinsNeeded('bo5'),
  };
}

// --------------------------------------------------------------- commitment
//
// Shared for the same reason the rules are: the server computes the commitment
// and the client re-computes it to verify. If the two ever built the hash input
// differently, every round would look tampered with. One function, both sides.
//
// Uses only globals (`crypto.subtle`, `TextEncoder`) that exist in browsers and
// in Deno, so this stays import-free.

/**
 * The exact bytes that get hashed. Separator included so ('rock', 'ab') and
 * ('rocka', 'b') cannot collide.
 */
function commitmentInput(move: Choice, nonce: string): string {
  return `${move}:${nonce}`;
}

/**
 * sha256(move || nonce), hex.
 *
 * The nonce is what makes this binding rather than decorative: there are only
 * three possible moves, so a hash of the bare move is a three-entry lookup
 * table. With 32 random bytes in the input there is nothing to enumerate, and
 * the server cannot swap its move after seeing the player's without producing a
 * hash that no longer matches the one it already sent.
 */
export async function computeCommitment(move: Choice, nonce: string): Promise<string> {
  const bytes = new TextEncoder().encode(commitmentInput(move, nonce));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish equality for hex digests. Not security-critical here —
 *  the client is checking the server, not guarding a secret — but cheap. */
export function commitmentMatches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
