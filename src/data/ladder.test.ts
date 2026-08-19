import { describe, expect, it } from 'vitest';
import { asSnapshot, movementOf, standingKind } from './ladder';

describe('the ladder snapshot', () => {
  it('keeps an empty board distinguishable from a failed load', () => {
    // The panel shows very different things for these two, and the whole
    // reason the server sends empty_reason is so the client never has to
    // guess which one it is looking at.
    const s = asSnapshot({ total_players: 0, board: [], empty_reason: 'no rated players yet' });
    expect(s.board).toEqual([]);
    expect(s.emptyReason).toBe('no rated players yet');
  });

  it('carries the caller even when they are not on the board', () => {
    const s = asSnapshot({ total_players: 3, board: [], you: { on_board: false, rank: null } });
    expect(s.you.onBoard).toBe(false);
    expect(s.you.rank).toBeNull();
  });

  it('marks which row is the caller so the board can highlight it', () => {
    const s = asSnapshot({
      board: [
        { rank: 1, user_id: 'a', name: 'Ada', rating: 1662, matches: 4, is_you: false },
        { rank: 2, user_id: 'b', name: 'Bo', rating: 1337, matches: 4, is_you: true },
      ],
    });
    expect(s.board.map((r) => r.isYou)).toEqual([false, true]);
    expect(s.board[0].rating).toBe(1662);
  });

  it('reads a real derived movement rather than a stored counter', () => {
    const s = asSnapshot({
      you: { last_change: { delta: 162, rating: 1662, outcome: 'win', at: '2026-08-13T16:00:55Z' } },
    });
    expect(s.you.lastChange).toEqual({
      delta: 162, rating: 1662, outcome: 'win', at: '2026-08-13T16:00:55Z',
    });
  });

  it('has no movement for a player who has never been rated', () => {
    expect(asSnapshot({ you: {} }).you.lastChange).toBeNull();
  });
});

describe('what the standing block shows', () => {
  const you = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over });
  function base() {
    return {
      onBoard: false, rank: null as number | null, rating: null as number | null,
      ratedMatches: null as number | null,
      lastChange: null as null | { delta: number; rating: number; outcome: 'win'; at: string },
      rateable: true,
    };
  }

  it('says unrated for a player who has never been rated', () => {
    expect(standingKind(you())).toBe('unrated');
  });

  it('shows the ranked block once there is a rank', () => {
    expect(standingKind(you({ onBoard: true, rank: 3, rating: 1520 }))).toBe('ranked');
  });

  it('still says unrated when history exists but nothing it moved does', () => {
    // An account with rating_history but no current rating — excluded from the
    // ladder after the fact. Rendering "+162 from your last match" with no rank
    // and no rating beside it reads as a bug, not as information.
    expect(standingKind(you({
      lastChange: { delta: 162, rating: 1662, outcome: 'win', at: '' },
    }))).toBe('unrated');
  });

  it('shows the block for a rated player who is below the visible board', () => {
    expect(standingKind(you({ onBoard: false, rating: 1480 }))).toBe('ranked');
  });
});

describe('how a change is rendered', () => {
  const c = (delta: number) => ({ delta, rating: 1500, outcome: 'draw' as const, at: '' });

  it('reports direction from the sign', () => {
    expect(movementOf(c(12))).toBe('up');
    expect(movementOf(c(-8))).toBe('down');
  });

  it('calls a zero delta flat rather than dressing it as movement', () => {
    // A draw between closely matched players genuinely moves nothing. "+0"
    // would be the same dishonesty as claiming an unmeasurable improvement.
    expect(movementOf(c(0))).toBe('flat');
  });

  it('says nothing at all when there is no change to describe', () => {
    expect(movementOf(null)).toBeNull();
  });
});
