import { describe, expect, it } from 'vitest';
import { verifyRound } from './multiplayer';

/**
 * The check that keeps "the server is in the trust base" from being a promise.
 *
 * The server holds both (move, nonce) pairs — it has to, or a tab crash costs a
 * player their stake. What stops that from being blind trust is that every
 * resolved round comes back with the commitments recorded BEFORE either player
 * moved, and this recomputes them. A server that swapped a move after seeing
 * the other one produces a digest that no longer matches, and the UI stops.
 */

async function digest(roundId: number, seat: string, move: string, nonce: string) {
  const bytes = new TextEncoder().encode(`${roundId}:${seat}:${move}:${nonce}`);
  const out = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(out)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function payload(over: Record<string, unknown> = {}) {
  return {
    round_id: 7,
    a_move: 'rock',
    a_nonce: 'aaaa',
    a_commitment: await digest(7, 'a', 'rock', 'aaaa'),
    b_move: 'scissors',
    b_nonce: 'bbbb',
    b_commitment: await digest(7, 'b', 'scissors', 'bbbb'),
    ...over,
  };
}

describe('round verification', () => {
  it('accepts a round the server told the truth about', async () => {
    expect(await verifyRound(await payload())).toBe(true);
  });

  it('rejects a swapped move — the whole point', async () => {
    // The server committed to rock and revealed paper. This is the only
    // failure that would make every other guarantee here worthless.
    expect(await verifyRound(await payload({ a_move: 'paper' }))).toBe(false);
  });

  it('rejects a swapped nonce', async () => {
    expect(await verifyRound(await payload({ b_nonce: 'cccc' }))).toBe(false);
  });

  it('checks BOTH seats, not just the opponent', async () => {
    // Checking only the opponent's hand would leave the server free to rewrite
    // the player's own move and call it a loss.
    expect(await verifyRound(await payload({ b_move: 'paper' }))).toBe(false);
  });

  it('is bound to the round, so a commitment cannot be replayed from another', async () => {
    const p = await payload();
    expect(await verifyRound({ ...p, round_id: 8 })).toBe(false);
  });

  it('is bound to the seat, so the two players cannot share a digest', async () => {
    const p = await payload();
    // Seat a's commitment presented as seat b's.
    expect(await verifyRound({ ...p, b_commitment: p.a_commitment })).toBe(false);
  });

  it('accepts a seat that never committed — a timeout is not a mismatch', async () => {
    const p = await payload({ b_move: null, b_nonce: null, b_commitment: null });
    expect(await verifyRound(p)).toBe(true);
  });

  it('rejects a half-present seat rather than skipping it', async () => {
    // A move with no nonce cannot be checked, and "cannot be checked" must
    // never quietly pass.
    const p = await payload({ b_nonce: null });
    expect(await verifyRound(p)).toBe(false);
  });
});
