import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CHOICES,
  commitmentMatches,
  computeCommitment,
  getRoundOutcome,
  type Choice,
  type MatchFormat,
  type RoundOutcome,
} from '../utils/rules';
import { getBotChoice } from '../utils/getBotChoice';

/**
 * The round protocol, client side.
 *
 * Two calls per round, and WHEN they happen is the design:
 *
 *   openRound  runs before the player picks — at match start for round 1, and
 *              while the player reads the previous result for the rest. It
 *              returns a commitment and no move. Being off the critical path is
 *              why a cold Edge Function instance (~1.2s) delays starting a
 *              match rather than stalling a reveal.
 *   submit     runs on the tap, and is the only call the ~870ms build-up has to
 *              hide. It reveals the server's move plus the nonce.
 *
 * Verification is not optional and not advisory. If the revealed move does not
 * hash to the commitment we were handed BEFORE we moved, or if the server's
 * outcome disagrees with our own reading of the same rules, this throws
 * `FairnessError` and the caller halts the match. A silent mismatch is the one
 * failure that would make everything else here worthless.
 */

export interface OpenRound {
  roundId: number;
  roundNumber: number;
  commitment: string;
}

export interface Reveal {
  opponentChoice: Choice;
  outcome: RoundOutcome;
  score: { player: number; opponent: number };
  matchComplete: boolean;
}

/** Thrown when the server contradicts itself. Never caught and swallowed. */
export class FairnessError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = 'FairnessError';
    this.detail = detail;
  }
}

/** A refusal the server issued deliberately, with its code. */
export class RoundError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'RoundError';
    this.code = code;
    this.status = status;
  }
}

const isChoice = (v: unknown): v is Choice => CHOICES.includes(v as Choice);

async function callPlay(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.functions.invoke('play', { body });

  if (error) {
    // A deliberate refusal arrives as a non-2xx with a code in the body; a
    // dropped connection arrives with no response at all. The caller retries
    // the second kind and never the first, so they must not look alike.
    const res = (error as { context?: Response }).context;
    if (res && typeof res.status === 'number') {
      let code = 'http_error';
      try {
        code = ((await res.json()) as { error?: string }).error ?? code;
      } catch {
        /* body was not JSON; keep the generic code */
      }
      throw new RoundError(code, res.status);
    }
    throw error;
  }
  return data as Record<string, unknown>;
}

export interface RoundsApi {
  /** True only when a third party could check the result. Guest mode is false. */
  readonly verifiable: boolean;
  openMatch(format: MatchFormat, theme: string | null, fastMode: boolean): Promise<string>;
  openRound(matchId: string): Promise<OpenRound>;
  submit(round: OpenRound, playerChoice: Choice): Promise<Reveal>;
}

// ------------------------------------------------------------------ server

export function createServerRounds(client: SupabaseClient): RoundsApi {
  return {
    verifiable: true,

    async openMatch(format, theme, fastMode) {
      const data = await callPlay(client, {
        action: 'open_match',
        format,
        theme,
        fast_mode: fastMode,
      });
      if (typeof data.match_id !== 'string') throw new Error('open_match: no match id');
      return data.match_id;
    },

    async openRound(matchId) {
      const data = await callPlay(client, { action: 'open_round', match_id: matchId });
      const commitment = data.commitment;
      if (typeof commitment !== 'string' || commitment.length !== 64) {
        throw new Error('open_round: malformed commitment');
      }
      // If either of these ever appears here, the server is handing out the
      // answer before the player has moved.
      if ('opponent_choice' in data || 'nonce' in data) {
        throw new FairnessError(
          'The server revealed its move before you played.',
          'open_round response contained opponent_choice or nonce',
        );
      }
      return {
        roundId: Number(data.round_id),
        roundNumber: Number(data.round_number),
        commitment,
      };
    },

    async submit(round, playerChoice) {
      const data = await callPlay(client, {
        action: 'submit',
        round_id: round.roundId,
        player_choice: playerChoice,
      });

      const opponentChoice = data.opponent_choice;
      const nonce = data.nonce;
      if (!isChoice(opponentChoice) || typeof nonce !== 'string') {
        throw new FairnessError('The reveal was malformed.', `payload: ${JSON.stringify(data)}`);
      }

      // 1. Did the server play the move it committed to before it saw ours?
      const recomputed = await computeCommitment(opponentChoice, nonce);
      if (!commitmentMatches(recomputed, round.commitment)) {
        throw new FairnessError(
          'The result could not be verified.',
          `round ${round.roundNumber}: committed ${round.commitment}, ` +
            `revealed ${opponentChoice} + nonce hashes to ${recomputed}`,
        );
      }

      // 2. Does the server's outcome match our own reading of the same rules?
      // Both sides run src/utils/rules.ts, so this can only fail if one of them
      // is not running what we think it is. The nine-pair drift test exists to
      // stop that; this is the runtime backstop for when it slips through.
      const ours = getRoundOutcome(playerChoice, opponentChoice);
      if (data.outcome !== ours) {
        throw new FairnessError(
          'The server and this app disagree about who won.',
          `round ${round.roundNumber}: ${playerChoice} vs ${opponentChoice} — ` +
            `server said ${String(data.outcome)}, this app says ${ours}`,
        );
      }

      const score = data.score as { player?: unknown; opponent?: unknown } | null;
      return {
        opponentChoice,
        outcome: ours,
        score: {
          player: Number(score?.player ?? 0),
          opponent: Number(score?.opponent ?? 0),
        },
        matchComplete: data.match_complete === true,
      };
    },
  };
}

// ------------------------------------------------------------------- guest

/**
 * Guest rounds: the same interface, the same async shape, the same commitment
 * step — and NO fairness guarantee whatsoever, because this process generates
 * both halves of it.
 *
 * `verifiable` is false and must stay wired to anything that would claim
 * provable fairness in the UI. A guest checking a commitment their own browser
 * produced is worse than no check at all: it manufactures confidence that
 * nothing earned.
 *
 * It exists so guest play exercises the identical state machine — async
 * resolution, verification, the failure branches — rather than a second,
 * simpler game that quietly rots while only signed-in players use the real one.
 */
export function createLocalRounds(): RoundsApi {
  let nextRoundId = 1;
  const secrets = new Map<number, { move: Choice; nonce: string }>();

  return {
    verifiable: false,

    async openMatch() {
      secrets.clear();
      nextRoundId = 1;
      return 'local';
    },

    async openRound() {
      const move = getBotChoice();
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const nonce = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      const roundId = nextRoundId++;
      secrets.set(roundId, { move, nonce });
      return {
        roundId,
        roundNumber: roundId,
        commitment: await computeCommitment(move, nonce),
      };
    },

    async submit(round, playerChoice) {
      const secret = secrets.get(round.roundId);
      if (!secret) throw new RoundError('not_found', 404);
      if (secrets.delete(round.roundId) === false) throw new RoundError('already_submitted', 409);
      return {
        opponentChoice: secret.move,
        outcome: getRoundOutcome(playerChoice, secret.move),
        // Guest matches are never recorded, so the score the caller already
        // tracks is the only one that exists.
        score: { player: 0, opponent: 0 },
        matchComplete: false,
      };
    },
  };
}
