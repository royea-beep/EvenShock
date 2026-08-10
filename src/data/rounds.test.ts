import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { computeCommitment, type Choice } from '../utils/rules';
import {
  createLocalRounds,
  createServerRounds,
  FairnessError,
  RoundError,
  type OpenRound,
} from './rounds';

/** A Supabase client stubbed down to the one method the round protocol uses. */
function fakeClient(handler: (body: Record<string, unknown>) => unknown): SupabaseClient {
  return {
    functions: {
      invoke: async (_fn: string, opts: { body: Record<string, unknown> }) => {
        const data = await handler(opts.body);
        return { data, error: null };
      },
    },
  } as unknown as SupabaseClient;
}

/** A client whose invoke fails the way a non-2xx from the function does. */
function refusingClient(code: string, status: number): SupabaseClient {
  return {
    functions: {
      invoke: async () => ({
        data: null,
        error: Object.assign(new Error('http'), {
          context: { status, json: async () => ({ error: code }) },
        }),
      }),
    },
  } as unknown as SupabaseClient;
}

const round = (commitment: string): OpenRound => ({
  roundId: 1,
  roundNumber: 1,
  commitment,
});

describe('commitment verification', () => {
  it('accepts a reveal that hashes to the commitment', async () => {
    const move: Choice = 'scissors';
    const nonce = 'a'.repeat(64);
    const commitment = await computeCommitment(move, nonce);

    const api = createServerRounds(
      fakeClient(() => ({
        opponent_choice: move,
        nonce,
        outcome: 'win', // rock beats scissors
        score: { player: 1, opponent: 0 },
        match_complete: false,
      })),
    );

    const reveal = await api.submit(round(commitment), 'rock');
    expect(reveal.opponentChoice).toBe('scissors');
    expect(reveal.outcome).toBe('win');
  });

  it('rejects a move swapped after the commitment was issued', async () => {
    // The server committed to scissors (which would lose to rock) and then
    // revealed paper (which beats it). This is the attack the nonce exists for.
    const committed = await computeCommitment('scissors', 'b'.repeat(64));

    const api = createServerRounds(
      fakeClient(() => ({
        opponent_choice: 'paper',
        nonce: 'b'.repeat(64),
        outcome: 'lose',
        score: { player: 0, opponent: 1 },
        match_complete: false,
      })),
    );

    await expect(api.submit(round(committed), 'rock')).rejects.toBeInstanceOf(FairnessError);
  });

  it('rejects a reveal whose nonce has been altered', async () => {
    const commitment = await computeCommitment('rock', 'c'.repeat(64));

    const api = createServerRounds(
      fakeClient(() => ({
        opponent_choice: 'rock',
        nonce: 'd'.repeat(64), // right move, wrong nonce
        outcome: 'tie',
        score: { player: 0, opponent: 0 },
        match_complete: false,
      })),
    );

    await expect(api.submit(round(commitment), 'rock')).rejects.toBeInstanceOf(FairnessError);
  });

  it('rejects an outcome the shared rules disagree with', async () => {
    // Commitment is honest; the verdict is not. rock vs scissors is a win, and
    // the server calling it a loss must not be rendered as one. This is the
    // runtime backstop for the two implementations drifting apart.
    const nonce = 'e'.repeat(64);
    const commitment = await computeCommitment('scissors', nonce);

    const api = createServerRounds(
      fakeClient(() => ({
        opponent_choice: 'scissors',
        nonce,
        outcome: 'lose',
        score: { player: 0, opponent: 1 },
        match_complete: false,
      })),
    );

    await expect(api.submit(round(commitment), 'rock')).rejects.toThrow(/disagree/i);
  });

  it('rejects an open_round that leaks the move or the nonce', async () => {
    const api = createServerRounds(
      fakeClient(() => ({
        round_id: 1,
        round_number: 1,
        commitment: 'f'.repeat(64),
        opponent_choice: 'rock', // must never appear before the player moves
      })),
    );

    await expect(api.openRound('match')).rejects.toBeInstanceOf(FairnessError);
  });
});

describe('deliberate refusals are distinguishable from transport failures', () => {
  it('surfaces a double-submit as a RoundError with its code', async () => {
    const api = createServerRounds(refusingClient('already_submitted', 409));
    await expect(api.submit(round('x'.repeat(64)), 'rock')).rejects.toMatchObject({
      name: 'RoundError',
      code: 'already_submitted',
      status: 409,
    });
  });

  it('surfaces an expired round as a RoundError', async () => {
    const api = createServerRounds(refusingClient('round_expired', 410));
    await expect(api.submit(round('x'.repeat(64)), 'rock')).rejects.toBeInstanceOf(RoundError);
  });
});

describe('guest rounds', () => {
  it('never claim to be verifiable', () => {
    expect(createLocalRounds().verifiable).toBe(false);
  });

  it('server rounds do', () => {
    expect(createServerRounds(fakeClient(() => ({}))).verifiable).toBe(true);
  });

  it('produce a commitment that verifies, and run the same code path', async () => {
    // The guarantee is worthless — this process made both halves — but the
    // state machine must be identical, so the verification step has to pass.
    const api = createLocalRounds();
    await api.openMatch('bo3', null, false);
    const opened = await api.openRound('local');
    expect(opened.commitment).toHaveLength(64);

    const reveal = await api.submit(opened, 'rock');
    expect(await computeCommitment(reveal.opponentChoice, '')).not.toBe(opened.commitment);
    expect(['rock', 'paper', 'scissors']).toContain(reveal.opponentChoice);
  });

  it('refuse a second submit for the same round', async () => {
    const api = createLocalRounds();
    await api.openMatch('single', null, false);
    const opened = await api.openRound('local');
    await api.submit(opened, 'rock');
    await expect(api.submit(opened, 'rock')).rejects.toBeInstanceOf(RoundError);
  });
});
