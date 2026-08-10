/**
 * The earning curve. Virtual currency only — nothing here converts to money.
 *
 * SHARED, and for a sharper reason than the rules are. A guest sees XP and chips
 * accumulate locally as the demo of the loop; if the guest numbers differed from
 * the real ones by even a little, the demo would be a lie about the thing it is
 * demonstrating. So both sides compute from this file:
 *
 *   canonical  src/utils/economy.ts        <- edit here, only here
 *   generated  supabase/functions/play/economy.ts
 *
 * `npm run sync:rules` copies it byte-for-byte and `rules.sync.test.ts` fails if
 * the copy is stale.
 *
 * CONSTRAINT: no imports, ever — consumed verbatim by Deno. Same rule as
 * rules.ts, same reason.
 *
 * NOTE ON THE ONE DUPLICATION: the *award* itself is also computed in SQL, by
 * `resolve_round`, because it has to land in the same transaction that finalises
 * the match — a match that is complete but unpaid, even for a moment, is exactly
 * the failure that becomes unacceptable once chips cost money. The rates below
 * are passed into that function as arguments, so SQL holds no policy, but the
 * multiplication happens in both places. A grid check over
 * (rounds × wins × format) verifies the two agree.
 */

export type Currency = 'xp' | 'chips';

/**
 * XP per resolved round, including ties.
 *
 * A tie is a round played — the hands still met — so it earns. Ties never
 * advance the score, which means a run of them is time spent with nothing to
 * show for it otherwise.
 */
export const XP_PER_ROUND = 10;

/** Chips per round WON. Losing and tied rounds earn XP but no chips. */
export const CHIPS_PER_ROUND_WON = 5;

export interface MatchAward {
  xp: number;
  chips: number;
}

/**
 * What a completed match pays.
 *
 * Awarded ONLY on completion, and that single fact is the anti-farming
 * property: an abandoned match pays nothing, so playing out a match you are
 * losing always beats quitting and restarting it. There is no score at which
 * walking away is the better move.
 *
 * THERE IS DELIBERATELY NO COMPLETION BONUS. A flat per-match bonus would make
 * `single` the most efficient format and reward match-spam; a bonus scaled by
 * format is just the per-round rate wearing a hat. Both rates below are
 * per-round and format-independent, which makes "no format is worth farming" a
 * property of the arithmetic rather than a number someone tuned. A "you won the
 * match!" bonus is the obvious thing to want here; it is absent on purpose.
 */
export function matchAward(roundsResolved: number, roundsWon: number): MatchAward {
  const rounds = Math.max(0, Math.floor(roundsResolved));
  const won = Math.min(Math.max(0, Math.floor(roundsWon)), rounds);
  return {
    xp: XP_PER_ROUND * rounds,
    chips: CHIPS_PER_ROUND_WON * won,
  };
}

/** The rates, as the shape `resolve_round` takes them. Generated, not retyped. */
export function economyRates(): Record<string, number> {
  return {
    xp_per_round: XP_PER_ROUND,
    chips_per_round_won: CHIPS_PER_ROUND_WON,
  };
}

// ------------------------------------------------------------------- levels
//
// XP is progression and is never spent, so a level is a pure function of it
// rather than a stored counter that could drift from the ledger.

/** Rising cost per level: level N needs 100·N·(N−1)/2 XP in total. */
export function levelForXp(xp: number): number {
  let level = 1;
  let needed = 100;
  let remaining = Math.max(0, Math.floor(xp));
  while (remaining >= needed) {
    remaining -= needed;
    level += 1;
    needed += 100;
  }
  return level;
}

/** XP into the current level, and what the next one costs. For a progress bar. */
export function levelProgress(xp: number): { level: number; into: number; span: number } {
  const level = levelForXp(xp);
  let consumed = 0;
  for (let l = 1; l < level; l += 1) consumed += 100 * l;
  return { level, into: Math.max(0, Math.floor(xp)) - consumed, span: 100 * level };
}

// -------------------------------------------------------------------- shop
//
// Cosmetics only. Nothing here affects play, and nothing converts outward.

/**
 * Themes that cost chips. The four original looks stay free so the game is
 * whole without spending, and the four added later are the inventory.
 *
 * 60 chips ≈ six match wins at 5 chips per won round — enough that the first
 * unlock is earned rather than handed over, short enough to be reachable in a
 * sitting.
 *
 * A theme someone is ALREADY USING is never taken away: it is granted on first
 * load instead. Taking something away is worse than never having offered it.
 */
export const THEME_PRICE = 60;

export const PRICED_THEMES: readonly string[] = ['frost', 'highroller', 'jade', 'origami'];

export function themePrice(themeId: string): number | null {
  return PRICED_THEMES.includes(themeId) ? THEME_PRICE : null;
}

/** True when a theme must be owned to be selectable. */
export function isPricedTheme(themeId: string): boolean {
  return PRICED_THEMES.includes(themeId);
}
