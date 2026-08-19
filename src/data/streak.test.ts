import { describe, expect, it } from 'vitest';
import { bonusForDay, STREAK_CAP, streakStatus, utcToday } from './streak';

/**
 * The streak's only real risk is that it rewards volume. These assert the
 * opposite property from the client's side; the server enforces it in
 * touch_daily_streak, where the award is gated on last_award_day and again on
 * the ledger idem_key.
 */

describe('the daily bonus', () => {
  it('depends only on consecutive days, never on how much was played', () => {
    // There is no input for matches played, which is the point — the shape of
    // the function is the anti-farming argument.
    expect(bonusForDay(1)).toBe(1);
    expect(bonusForDay(4)).toBe(4);
  });

  it('caps, so a long streak never becomes precious enough to punish a day off', () => {
    expect(bonusForDay(STREAK_CAP)).toBe(STREAK_CAP);
    expect(bonusForDay(STREAK_CAP + 50)).toBe(STREAK_CAP);
  });

  it('never pays for a day that was not returned', () => {
    expect(bonusForDay(0)).toBe(0);
    expect(bonusForDay(-3)).toBe(0);
  });
});

describe('whether the streak is alive', () => {
  const today = '2026-08-19';

  it('treats a player with no history as starting tomorrow at day one', () => {
    expect(streakStatus(null, today)).toEqual({
      alive: false, awardedToday: false, nextBonus: 1,
    });
  });

  it('is alive and banked when today has already paid', () => {
    const s = streakStatus({ currentDays: 3, bestDays: 5, lastAwardDay: today }, today);
    expect(s.alive).toBe(true);
    expect(s.awardedToday).toBe(true);
  });

  it('is alive but unbanked the day after', () => {
    const s = streakStatus({ currentDays: 3, bestDays: 5, lastAwardDay: '2026-08-18' }, today);
    expect(s).toEqual({ alive: true, awardedToday: false, nextBonus: 3 });
  });

  it('is broken after a missed day, and does not promise a continuation', () => {
    // The server restarts at 1 in this case; the UI must say the same thing
    // rather than dangling the old number in front of the player.
    const s = streakStatus({ currentDays: 9, bestDays: 9, lastAwardDay: '2026-08-17' }, today);
    expect(s).toEqual({ alive: false, awardedToday: false, nextBonus: 1 });
  });

  it('crosses a month boundary without breaking', () => {
    const s = streakStatus({ currentDays: 2, bestDays: 2, lastAwardDay: '2026-07-31' }, '2026-08-01');
    expect(s.alive).toBe(true);
  });
});

describe('day boundaries', () => {
  it('counts days in UTC, so players in different zones agree', () => {
    // 22:00 in UTC-8 is already the next day in UTC. The server uses UTC, so
    // the client must too or the streak appears to break for one of them.
    expect(utcToday(new Date('2026-08-19T23:30:00Z'))).toBe('2026-08-19');
    expect(utcToday(new Date('2026-08-20T00:30:00Z'))).toBe('2026-08-20');
  });
});
