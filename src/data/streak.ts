import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The daily streak, client side.
 *
 * READ-ONLY HERE, AND THAT IS THE POINT. The award is made by a database
 * trigger when a match completes — `touch_daily_streak`, fired from `matches`
 * and `mp_tables` — so the browser has no way to ask for chips and no way to
 * ask twice. This seam only reads back what already happened, through the
 * table's own-row policy.
 *
 * ANTI-FARMING, restated because it is the property that matters: the bonus
 * depends only on consecutive days, never on how much is played. Fifty matches
 * today pay exactly what one pays. That is the same discipline as the match
 * rewards, which are per-round with no completion bonus so no format is worth
 * farming.
 */

export interface Streak {
  currentDays: number;
  bestDays: number;
  /** UTC date of the last award, or null for a player who has never had one. */
  lastAwardDay: string | null;
}

/** The cap, mirrored from touch_daily_streak so the UI can say where it stops. */
export const STREAK_CAP = 7;

/** What today's return is worth, given the streak it would extend. */
export function bonusForDay(dayNumber: number): number {
  return Math.max(0, Math.min(dayNumber, STREAK_CAP));
}

/**
 * Whether the streak is still alive as of `today`, and what tomorrow pays.
 *
 * A streak is alive if it was awarded today (already banked) or yesterday
 * (still extendable). Anything older is broken and the next award restarts at
 * day 1 — stated here rather than only in SQL, because the UI must not promise
 * a continuation the server will refuse.
 */
export function streakStatus(
  streak: Streak | null,
  today: string,
): { alive: boolean; awardedToday: boolean; nextBonus: number } {
  if (!streak || !streak.lastAwardDay) {
    return { alive: false, awardedToday: false, nextBonus: bonusForDay(1) };
  }
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yday = yesterday.toISOString().slice(0, 10);

  const awardedToday = streak.lastAwardDay === today;
  const alive = awardedToday || streak.lastAwardDay === yday;
  return {
    alive,
    awardedToday,
    nextBonus: bonusForDay(alive ? streak.currentDays + (awardedToday ? 1 : 0) : 1),
  };
}

/** Today in UTC, as the server counts days. Not local time — a player in UTC+13
 *  and one in UTC-8 must agree on when a day turned over. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function createStreaks(client: SupabaseClient) {
  return {
    async read(): Promise<Streak | null> {
      // No .eq() on user_id: the own-row policy already restricts this, and
      // filtering here as well would imply the grant is wider than it is.
      const { data, error } = await client
        .from('player_streaks')
        .select('current_days, best_days, last_award_day')
        .maybeSingle();
      if (error || !data) return null;
      const row = data as Record<string, unknown>;
      return {
        currentDays: Number(row.current_days ?? 0),
        bestDays: Number(row.best_days ?? 0),
        lastAwardDay: typeof row.last_award_day === 'string' ? row.last_award_day : null,
      };
    },
  };
}
