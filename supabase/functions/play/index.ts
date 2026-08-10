/**
 * Server-authoritative rounds for EvenShock.
 *
 * The browser used to draw the bot's move, decide the result, and insert the
 * row saying so. This function does all three, and the client's grants were
 * revoked so it cannot write history at all.
 *
 * Rock-paper-scissors is simultaneous, so neither side may see the other's move
 * before committing to its own. Commit-reveal:
 *
 *   open_round  draw a move, store it with a 32-byte nonce, return ONLY
 *               sha256(move || nonce). The move stays in a column the client
 *               has no SELECT grant on.
 *   submit      record the player's move, then reveal ours plus the nonce. The
 *               client re-hashes and checks it against the commitment it was
 *               handed before it moved, so a server that changed its mind after
 *               seeing the player's move is caught.
 *
 * ONE function with an action discriminator rather than three, on purpose:
 * `open_round` for round N+1 runs while the player reads round N's result,
 * which keeps this instance warm for the `submit` that follows.
 *
 * LATENCY IS THE CONSTRAINT. The reveal budget is 870ms normal, 501ms fast, and
 * the animation is the product — it does not get trimmed to fit the network. So
 * both hot actions are exactly one round trip to Postgres, and authentication
 * costs no round trip at all. The first draft made six calls per submit and
 * measured p50 519ms server-side, which was already over the fast budget before
 * a phone had said a word.
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  CHOICES,
  computeCommitment,
  outcomeTable,
  winsNeededTable,
  type Choice,
  type MatchFormat,
} from './rules.ts';
import { PRICED_THEMES, economyRates, themePrice } from './economy.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const fail = (code: string, message: string, status: number) =>
  json({ error: code, message }, status);

/** Errors the RPCs can return, and the status each deserves. */
const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  match_closed: 409,
  round_already_open: 409,
  already_submitted: 409,
  round_expired: 410,
  rate_limited: 429,
  bad_request: 400,
  forbidden: 403,
  insufficient_chips: 409,
};

const isChoice = (v: unknown): v is Choice => CHOICES.includes(v as Choice);
const FORMATS: MatchFormat[] = ['single', 'bo3', 'bo5'];
const isFormat = (v: unknown): v is MatchFormat => FORMATS.includes(v as MatchFormat);

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

// These two are constant for the life of the instance and derived from the
// shared rules file, so they are built once rather than per request.
const OUTCOMES = outcomeTable();
const WINS_NEEDED = winsNeededTable();
const ECONOMY = economyRates();

// -------------------------------------------------------- per-IP circuit breaker
//
// WHAT THIS IS NOT: a way to stop garbage requests costing invocations. By the
// time this code runs the function has already been invoked and already billed;
// nothing inside it can undo that. Only something upstream of the runtime could,
// and that is not ours to configure. Saying so plainly because a limiter here
// looks like it solves the billing problem and does not.
//
// WHAT IT IS: a circuit breaker that stops a flooding address from making us do
// work. An address that keeps failing authentication gets short-circuited BEFORE
// the JWKS lookup, so a burst of forged tokens cannot drag the key fetch or the
// signature check along with it.
//
// Only FAILED authentications count. Legitimate players never accumulate, which
// matters because mobile carriers put thousands of real users behind one address
// — an IP limit that counted successful requests would eventually punish a
// carrier NAT for being popular.
//
// Deliberately in memory: a database write per garbage request would itself be
// the denial of service. Honest limits — per instance, so concurrent instances
// multiply it, it resets on cold start, and a distributed flood walks straight
// past it. It bounds the cheap case, which is the one that actually shows up.
const IP_FAILURE_WINDOW_MS = 60_000;
const IP_FAILURE_BUDGET = 20;
const IP_TABLE_CAP = 5_000;

const authFailures = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for') ?? '';
  return forwarded.split(',')[0].trim() || 'unknown';
}

/** True when this address has already burned its failure budget. */
function ipOverBudget(ip: string): boolean {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  if (Date.now() >= entry.resetAt) {
    authFailures.delete(ip);
    return false;
  }
  return entry.count > IP_FAILURE_BUDGET;
}

function noteAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || now >= entry.resetAt) {
    authFailures.set(ip, { count: 1, resetAt: now + IP_FAILURE_WINDOW_MS });
  } else {
    entry.count += 1;
  }

  // A spray of forged addresses must not grow this without bound.
  if (authFailures.size > IP_TABLE_CAP) {
    for (const [key, value] of authFailures) {
      if (now >= value.resetAt) authFailures.delete(key);
    }
    if (authFailures.size > IP_TABLE_CAP) authFailures.clear();
  }
}

// ------------------------------------------------------------------- auth
//
// The JWT is verified HERE, in full, rather than by calling auth.getUser().
// getUser() is a network round trip on every request, and at ~70ms it was pure
// waste inside a 501ms budget.
//
// This is not "trust the platform's verify_jwt flag and decode the payload" —
// that would make authentication depend on a deploy setting, and a future
// redeploy with verify_jwt off would silently turn it into "anyone may claim
// any user id". The signature is checked against the project's published JWKS.
// The keys are fetched once per instance and cached, so the cost is one request
// per cold start and zero thereafter.

interface Jwk {
  kid: string;
  kty: string;
  crv?: string;
  [k: string]: unknown;
}

let jwksCache: Promise<Jwk[]> | null = null;
let jwksRetryAfter = 0;

function fetchJwks(): Promise<Jwk[]> {
  if (!jwksCache) {
    // Back off after a failure. Without this, clearing the cache on error turns
    // a flood of well-formed-but-forged tokens into a flood of OUTBOUND key
    // fetches — one per request — which is a worse problem than the one being
    // defended against, and one we would be inflicting on ourselves.
    if (Date.now() < jwksRetryAfter) return Promise.resolve([]);

    jwksCache = fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
      .then((r) => r.json())
      .then((doc) => (Array.isArray(doc?.keys) ? (doc.keys as Jwk[]) : []))
      .catch((e) => {
        jwksCache = null; // a failed fetch must not poison the instance
        jwksRetryAfter = Date.now() + 5_000;
        throw e;
      });
  }
  return jwksCache;
}

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

/** Returns the verified subject, or null if the token is not trustworthy. */
async function verifiedUserId(authHeader: string): Promise<string | null> {
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [rawHeader, rawPayload, rawSig] = parts;
  let header: { kid?: string; alg?: string };
  let payload: { sub?: string; exp?: number; iss?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawHeader)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawPayload)));
  } catch {
    return null;
  }

  // Only ES256. Pinning the algorithm is what stops an "alg: none" token, and
  // stops a token signed with a symmetric key from being verified against a
  // public one.
  if (header.alg !== 'ES256' || !header.kid) return null;
  if (typeof payload.sub !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  if (payload.iss !== `${SUPABASE_URL}/auth/v1`) return null;

  const jwks = await fetchJwks();
  const jwk = jwks.find((k) => k.kid === header.kid && k.kty === 'EC');
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );

  return ok ? payload.sub : null;
}

// ------------------------------------------------------------------ random

/** 32 random bytes, hex. `crypto.getRandomValues`, never `Math.random`. */
function newNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A uniform move. Rejection sampling rather than `% 3`: 256 is not a multiple
 * of 3, so the modulo of a random byte favours rock and paper by ~0.4% each.
 * Small, but it is a bias in the one number that is supposed to be fair, and
 * discarding the 255th value costs nothing.
 */
function drawMove(): Choice {
  const byte = new Uint8Array(1);
  do {
    crypto.getRandomValues(byte);
  } while (byte[0] >= 255);
  return CHOICES[byte[0] % 3];
}

// ------------------------------------------------------------------ serve

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('method_not_allowed', 'POST only', 405);

  // Checked before verification so a flooding address cannot drag the key
  // lookup and signature check along with it. Only failures accumulate here.
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

  // Service role: it bypasses RLS, which is exactly why the user id above comes
  // from a verified signature and never from the request body.
  const db: SupabaseClient = createClient(
    SUPABASE_URL,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  switch (body.action) {
    case 'open_match':
      return await openMatch(db, userId, body);
    case 'open_round':
      return await openRound(db, userId, body);
    case 'submit':
      return await submit(db, userId, body);
    case 'report_integrity':
      return await reportIntegrity(db, userId, body);
    case 'economy_state':
      return await economyState(db, userId, body);
    case 'buy':
      return await buy(db, userId, body);
    case 'health':
      return await health(db, userId);
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

// ---------------------------------------------------------------- open_match

async function openMatch(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  if (!isFormat(body.format)) return fail('bad_request', 'Unknown format', 400);

  // An RPC rather than a direct insert, so the rate check happens in the same
  // transaction as the write. A limit enforced in a separate call is a limit
  // with a gap in it.
  //
  // The match is written at the start, when the result is genuinely unknown.
  // status stays 'in_progress' until the server finalizes it, and the
  // leaderboard counts only finalized matches — so walking out of a losing
  // match records nothing rather than recording a win.
  const { data, error } = await db.rpc('open_match', {
    p_user_id: userId,
    p_format: body.format,
    p_theme: typeof body.theme === 'string' ? body.theme : null,
    p_fast_mode: body.fast_mode === true,
  });
  if (error) return fail('db_error', error.message, 500);

  const refused = rpcError(data);
  if (refused) return refused;

  return json({ match_id: data.match_id });
}

// ----------------------------------------------------------- report_integrity

/**
 * The client telling us the server contradicted itself.
 *
 * A commitment mismatch is detected in the browser, which means without this
 * channel the one signal that something is deeply wrong lands in a console
 * nobody will ever read. Recorded as source='client' and never as fact — the
 * caller controls the payload — but a burst of these across unrelated accounts
 * is worth more than anything the server could notice on its own.
 */
async function reportIntegrity(
  db: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
) {
  if (typeof body.kind !== 'string') return fail('bad_request', 'kind required', 400);

  const { data, error } = await db.rpc('report_integrity', {
    p_user_id: userId,
    p_kind: body.kind,
    p_detail: (body.detail ?? {}) as Record<string, unknown>,
  });
  if (error) return fail('db_error', error.message, 500);

  const refused = rpcError(data);
  if (refused) return refused;

  return json({ ok: true });
}

// ---------------------------------------------------------------- open_round

async function openRound(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  if (typeof body.match_id !== 'string') return fail('bad_request', 'match_id required', 400);

  const move = drawMove();
  const nonce = newNonce();
  const commitment = await computeCommitment(move, nonce);

  const { data, error } = await db.rpc('open_round', {
    p_match_id: body.match_id,
    p_user_id: userId,
    p_move: move,
    p_nonce: nonce,
    p_commitment: commitment,
  });
  if (error) return fail('db_error', error.message, 500);

  const refused = rpcError(data);
  if (refused) return refused;

  // The move and the nonce are deliberately NOT in this response.
  return json({ round_id: data.round_id, round_number: data.round_number, commitment });
}

// -------------------------------------------------------------------- submit

async function submit(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const roundId = body.round_id;
  if (typeof roundId !== 'number' && typeof roundId !== 'string') {
    return fail('bad_request', 'round_id required', 400);
  }
  if (!isChoice(body.player_choice)) return fail('bad_request', 'Unknown move', 400);

  // One round trip. Claiming the round, recounting the score and finalizing the
  // match all happen inside a single transaction, so a duplicate request cannot
  // interleave halfway through — and the round that ends a match costs exactly
  // as many queries as any other round, so response time carries no signal
  // about whether it was decisive.
  const { data, error } = await db.rpc('resolve_round', {
    p_round_id: Number(roundId),
    p_user_id: userId,
    p_player_move: body.player_choice,
    p_outcomes: OUTCOMES,
    p_wins_needed: WINS_NEEDED,
    // Rates, not amounts. The multiplication happens inside the transaction
    // that finalises the match, so a match is never complete-but-unpaid.
    p_economy: ECONOMY,
  });
  if (error) return fail('db_error', error.message, 500);

  const refused = rpcError(data);
  if (refused) return refused;

  // Fixed field set, every field always present, always 200. No byte padding —
  // once this response lands the client holds the answer regardless, and the
  // player's move is already committed, so uniform length buys nothing.
  return json(data);
}

// -------------------------------------------------------------- economy_state

/**
 * Balances and owned cosmetics.
 *
 * Also the one place the "never lock what someone is already using" rule is
 * applied: the caller passes its current theme, and if that theme is priced but
 * unowned it is granted rather than taken away. The price list travels from the
 * shared module so the server decides what is priced — a client that could name
 * its own priced set could grant itself anything.
 */
async function economyState(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const current = typeof body.current_theme === 'string' ? body.current_theme : null;

  const { data, error } = await db.rpc('economy_state', {
    p_user_id: userId,
    p_current_theme: current,
    p_priced: PRICED_THEMES,
  });
  if (error) return fail('db_error', error.message, 500);

  const refused = rpcError(data);
  if (refused) return refused;

  return json(data);
}

// ----------------------------------------------------------------------- buy

/**
 * Spends chips on a cosmetic.
 *
 * The PRICE IS NOT TAKEN FROM THE REQUEST. It comes from the shared module by
 * sku, because a client that names its own price can buy anything for one chip.
 * Obvious, and exactly the kind of thing that is obvious right up until someone
 * ships it.
 */
async function buy(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const sku = body.sku;
  if (typeof sku !== 'string') return fail('bad_request', 'sku required', 400);

  const price = themePrice(sku);
  if (price === null) return fail('bad_request', 'Not for sale', 400);

  const { data, error } = await db.rpc('spend_chips', {
    p_user_id: userId,
    p_sku: sku,
    p_price: price,
  });
  if (error) return fail('db_error', error.message, 500);

  const refused = rpcError(data);
  if (refused) return refused;

  return json(data);
}

// -------------------------------------------------------------------- health

/**
 * The integrity digest. Owner only — the RPC checks `profiles.is_owner` and
 * returns `forbidden` otherwise, so this endpoint tells an ordinary player
 * nothing at all about how the system is doing.
 */
async function health(db: SupabaseClient, userId: string) {
  const { data, error } = await db.rpc('health_digest', { p_user_id: userId });
  if (error) return fail('db_error', error.message, 500);

  const refused = rpcError(data);
  if (refused) return refused;

  return json(data);
}
