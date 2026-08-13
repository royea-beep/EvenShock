/**
 * Tournaments: the only way a browser reaches the bracket.
 *
 * WHY A FUNCTION AT ALL, when the leaderboard is just a definer RPC the client
 * calls directly. Because these RPCs move chips. `tournament_register` debits
 * an entry fee and credits the house; `tournament_open_match` seats a player.
 * Every one of them is revoked from `anon` and `authenticated`, so there is no
 * grant a browser could use even if it knew the name — and that is the point.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: every RPC below takes a user id,
 * and that id comes from a VERIFIED SIGNATURE, never from the request body.
 * The service-role client used here bypasses RLS completely, so a
 * `user_id` read out of JSON would let anyone enter a tournament as anyone —
 * or, worse, spend their chips. `body` is used for tournament and slot
 * identifiers only.
 *
 * WHAT IS DELIBERATELY ABSENT: create, start, settle and cancel. Those are
 * operator actions and there is no case for them here. Starting and settling
 * happen on their own — filling the last seat draws the bracket, and reporting
 * the final settles the pool — so the player-facing surface never needs to ask
 * for either, and an endpoint that could settle a tournament early would be a
 * way to take the pool at the wrong moment.
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { CORS, clientIp, fail, ipOverBudget, json, noteAuthFailure, verifiedUserId } from './http.ts';

/**
 * Refusals, mapped onto status codes. An unmapped code becomes a bare 400,
 * which is how a refusal the server understood perfectly turns into an
 * unexplained "bad request" in someone's network tab.
 *
 * `forbidden` covers two different situations on purpose — not your slot, and
 * not your tournament — because telling them apart would let an entrant probe
 * the bracket for who is in which slot before the draw is public.
 */
const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  bad_request: 400,
  forbidden: 403,
  rate_limited: 429,
  unrateable_player: 403,
  already_entered: 409,
  already_reported: 409,
  full: 409,
  not_registering: 409,
  not_running: 409,
  not_enough_players: 409,
  insufficient_chips: 409,
  no_such_slot: 404,
  slot_not_ready: 409,
  bracket_incomplete: 409,
  final_not_played: 409,
  conservation_breach: 500,
  stakes_unavailable: 409,
  table_unavailable: 404,
  wallet_is_treasury: 409,
  bad_stake: 400,
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

const asUuid = (v: unknown): string | null =>
  typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null;

const asPositiveInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : null;
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('method_not_allowed', 'POST only', 405);

  const ip = clientIp(req);
  if (ipOverBudget(ip)) {
    return fail('rate_limited', 'Too many failed authentications from this address', 429);
  }

  const userId = await verifiedUserId(req.headers.get('Authorization') ?? '');
  if (!userId) {
    noteAuthFailure(ip);
    return fail('unauthenticated', 'Invalid or missing session', 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail('bad_request', 'Body must be JSON', 400);
  }

  // Service role: bypasses RLS, which is exactly why `userId` above came from a
  // signature check and never from `body`.
  const db: SupabaseClient = createClient(
    SUPABASE_URL,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  switch (body.action) {
    case 'list':
      return await list(db, userId);
    case 'bracket':
      return await bracket(db, userId, body);
    case 'register':
      return await register(db, userId, body);
    case 'open_match':
      return await openMatch(db, userId, body);
    case 'result':
      return await result(db, userId, body);
    default:
      return fail('bad_request', `Unknown action: ${String(body.action)}`, 400);
  }
});

/** RPCs signal refusals in the payload; map them onto HTTP. */
function rpcError(data: Record<string, unknown> | null): Response | null {
  const code = data && typeof data.error === 'string' ? data.error : null;
  if (!code) return null;
  return fail(code, code.replace(/_/g, ' '), ERROR_STATUS[code] ?? 400);
}

/** A thrown Postgres error is ours, not the caller's. Never echo its text. */
function dbError(error: { message: string } | null, where: string): Response | null {
  if (!error) return null;
  console.error(`${where}: ${error.message}`);
  return fail('server_error', 'Something went wrong', 500);
}

// ================================================================== actions

async function list(db: SupabaseClient, userId: string): Promise<Response> {
  const { data, error } = await db.rpc('tournament_list', { p_user_id: userId });
  const failed = dbError(error, 'tournament_list');
  if (failed) return failed;
  return json({ tournaments: data ?? [] });
}

async function bracket(
  db: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = asUuid(body.tournament_id);
  if (!id) return fail('bad_request', 'tournament_id must be a uuid', 400);

  // The bracket and the money summary arrive together: a screen that shows the
  // draw without the pool would have to make a second round trip to say what
  // anyone is playing for.
  const [b, r] = await Promise.all([
    db.rpc('tournament_bracket', { p_tournament_id: id, p_user_id: userId }),
    db.rpc('tournament_result', { p_tournament_id: id, p_user_id: userId }),
  ]);
  const failed = dbError(b.error, 'tournament_bracket') ?? dbError(r.error, 'tournament_result');
  if (failed) return failed;
  if (!r.data) return fail('not_found', 'No such tournament', 404);

  return json({ bracket: b.data ?? [], summary: r.data });
}

async function register(
  db: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = asUuid(body.tournament_id);
  if (!id) return fail('bad_request', 'tournament_id must be a uuid', 400);

  const { data, error } = await db.rpc('tournament_register', {
    p_tournament_id: id,
    p_user_id: userId,
  });
  const failed = dbError(error, 'tournament_register');
  if (failed) return failed;
  const refused = rpcError(data as Record<string, unknown>);
  if (refused) return refused;
  return json(data);
}

async function openMatch(
  db: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = asUuid(body.tournament_id);
  const round = asPositiveInt(body.round_no);
  const slot = asPositiveInt(body.slot);
  if (!id || !round || !slot) {
    return fail('bad_request', 'tournament_id, round_no and slot are required', 400);
  }

  const { data, error } = await db.rpc('tournament_open_match', {
    p_tournament_id: id,
    p_round_no: round,
    p_slot: slot,
    p_user_id: userId,
  });
  const failed = dbError(error, 'tournament_open_match');
  if (failed) return failed;
  const refused = rpcError(data as Record<string, unknown>);
  if (refused) return refused;
  return json(data);
}

async function result(
  db: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = asUuid(body.tournament_id);
  if (!id) return fail('bad_request', 'tournament_id must be a uuid', 400);

  const { data, error } = await db.rpc('tournament_result', {
    p_tournament_id: id,
    p_user_id: userId,
  });
  const failed = dbError(error, 'tournament_result');
  if (failed) return failed;
  if (!data) return fail('not_found', 'No such tournament', 404);
  return json(data);
}
