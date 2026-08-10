import type { SupabaseClient } from '@supabase/supabase-js';
import { PRICED_THEMES, matchAward, themePrice } from '../utils/economy';

/**
 * XP and chips, client side. Virtual only — nothing here converts to money.
 *
 * Same shape as `data/rounds.ts` and for the same reason: one interface, two
 * implementations, so guest mode exercises the real state machine instead of
 * being a simpler parallel game that quietly rots.
 *
 * The two differ in one way that matters and is deliberately visible in the
 * type. For a signed-in player the SERVER credits the match — inside the
 * transaction that finalises it — and `recordMatch` merely re-reads what the
 * server decided. For a guest the browser computes it, because there is nothing
 * else. `persistent` is how the UI knows which it is, and it must stay wired to
 * anything that would imply a guest balance is an account balance.
 */

export interface EconomyState {
  xp: number;
  chips: number;
  owned: string[];
}

export interface BuyResult {
  ok: boolean;
  chips: number;
  alreadyOwned: boolean;
}

export const EMPTY_ECONOMY: EconomyState = { xp: 0, chips: 0, owned: [] };

export interface EconomyApi {
  /**
   * True when balances live on the server and survive this browser.
   *
   * False for guests, and everything user-facing that could be mistaken for an
   * account balance must check it. A guest who plays two hundred rounds and
   * clears their browser has to have known that would happen from the first
   * screen, not discovered it afterwards.
   */
  readonly persistent: boolean;

  /**
   * Current balances and owned cosmetics.
   *
   * `currentTheme` is passed so a priced theme the player is already using can
   * be granted rather than taken away.
   */
  load(currentTheme: string | null): Promise<EconomyState>;

  /**
   * Called when a match completes.
   *
   * The server implementation does NOT send the counts — it re-reads what the
   * server already credited from its own record of the match. A client that
   * could report its own rounds could report its own earnings.
   */
  recordMatch(roundsResolved: number, roundsWon: number): Promise<EconomyState>;

  buy(sku: string): Promise<BuyResult>;
}

// ------------------------------------------------------------------ server

async function callPlay(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.functions.invoke('play', { body });
  if (error) {
    const res = (error as { context?: Response }).context;
    if (res && typeof res.status === 'number') {
      let code = 'http_error';
      try {
        code = ((await res.json()) as { error?: string }).error ?? code;
      } catch {
        /* not JSON */
      }
      throw new Error(code);
    }
    throw error;
  }
  return data as Record<string, unknown>;
}

function toState(data: Record<string, unknown>): EconomyState {
  return {
    xp: Number(data.xp ?? 0),
    chips: Number(data.chips ?? 0),
    owned: Array.isArray(data.owned) ? (data.owned as string[]) : [],
  };
}

export function createServerEconomy(client: SupabaseClient): EconomyApi {
  const read = async (currentTheme: string | null): Promise<EconomyState> =>
    toState(await callPlay(client, { action: 'economy_state', current_theme: currentTheme }));

  return {
    persistent: true,
    load: read,

    async recordMatch() {
      // Deliberately ignores its arguments. The award already happened inside
      // the transaction that finalised the match; this is a read of the result,
      // not a request for payment.
      return read(null);
    },

    async buy(sku) {
      const data = await callPlay(client, { action: 'buy', sku });
      return {
        ok: data.ok === true,
        chips: Number(data.chips ?? 0),
        alreadyOwned: data.already_owned === true,
      };
    },
  };
}

// ------------------------------------------------------------------- guest

const GUEST_KEY = 'evenshock:guest-economy';

function readGuest(): EconomyState {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    if (!raw) return { ...EMPTY_ECONOMY };
    const parsed = JSON.parse(raw) as Partial<EconomyState>;
    return {
      xp: Math.max(0, Math.floor(Number(parsed.xp ?? 0))),
      chips: Math.max(0, Math.floor(Number(parsed.chips ?? 0))),
      owned: Array.isArray(parsed.owned) ? parsed.owned.filter((s) => typeof s === 'string') : [],
    };
  } catch {
    return { ...EMPTY_ECONOMY };
  }
}

function writeGuest(state: EconomyState): EconomyState {
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify(state));
  } catch {
    /* private mode — the balance still works for this session */
  }
  return state;
}

/**
 * A guest's balances, in this browser and nowhere else.
 *
 * This is the demo of the loop, and it earns at exactly the same rates as the
 * real thing because it runs the same `matchAward`. Different numbers would
 * make the demo a lie about the thing it exists to demonstrate.
 *
 * It is NOT an account. Nothing here is migrated when a wallet connects —
 * migrating it would be a free-tokens exploit: clear the browser, replay, claim
 * again. The UI says so before connecting rather than after.
 */
export function createLocalEconomy(): EconomyApi {
  return {
    persistent: false,

    async load(currentTheme) {
      const state = readGuest();
      // Same "never lock what you are already using" rule as the server.
      if (currentTheme && PRICED_THEMES.includes(currentTheme) && !state.owned.includes(currentTheme)) {
        return writeGuest({ ...state, owned: [...state.owned, currentTheme] });
      }
      return state;
    },

    async recordMatch(roundsResolved, roundsWon) {
      const state = readGuest();
      const award = matchAward(roundsResolved, roundsWon);
      return writeGuest({
        ...state,
        xp: state.xp + award.xp,
        chips: state.chips + award.chips,
      });
    },

    async buy(sku) {
      const state = readGuest();
      if (state.owned.includes(sku)) {
        return { ok: true, chips: state.chips, alreadyOwned: true };
      }
      // Price comes from the shared module, exactly as it does on the server.
      const price = themePrice(sku);
      if (price === null) throw new Error('bad_request');
      if (state.chips < price) throw new Error('insufficient_chips');

      const next = writeGuest({
        ...state,
        chips: state.chips - price,
        owned: [...state.owned, sku],
      });
      return { ok: true, chips: next.chips, alreadyOwned: false };
    },
  };
}
