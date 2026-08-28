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
import {
  fetchJupiterQuote,
  fetchJupiterSwapInstructions,
  quoteAmounts,
  summarizeRoute,
} from './jupiter.ts';
import { collectAccountKeys } from './txkeys.ts';

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
  tos_required: 403,
  payments_unconfigured: 503,
  cluster_mismatch: 409,
  payment_mismatch: 409,
  payment_failed: 409,
  // A mint whose authority the devnet harness holds, named by a mainnet config.
  // 403 rather than 409: no retry of this request turns into a success.
  test_mint_on_mainnet: 403,
  // The connected wallet IS the treasury, so any transfer it signs is a
  // self-transfer the chain records as a zero delta. 409: the request is
  // coherent, the wallet is the thing that cannot work.
  wallet_is_treasury: 409,
  // Swap quotes. 503 for the aggregator being unreachable — the USDC-direct
  // path is unaffected and the client is expected to degrade to it.
  swap_unavailable: 503,
  unsupported_input_mint: 400,
  intent_not_open: 409,
  quote_too_small: 400,
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

/**
 * A uniform number in [0, 1), from `crypto.getRandomValues`. This is the coin
 * that decides whether Nemesis plays its read or throws blind, so it gets the
 * same grade of randomness as the move itself — a predictable coin would let a
 * player know which rounds to deviate on, which is worth more than knowing the
 * move.
 */
function drawUnitInterval(): number {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0) / 4294967296;
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
    case 'nemesis_report':
      return await nemesisReport(db, userId, body);
    case 'economy_state':
      return await economyState(db, userId, body);
    case 'buy':
      return await buy(db, userId, body);
    case 'health':
      return await health(db, userId);
    case 'accept_tos':
      return await acceptTos(db, userId, body);
    case 'create_intent':
      return CHAIN ? await createIntent(CHAIN, db, userId, body) : CHAIN_UNCONFIGURED();
    case 'confirm_payment':
      return CHAIN ? await confirmPayment(CHAIN, db, userId, body) : CHAIN_UNCONFIGURED();
    case 'quote_swap':
      return CHAIN ? await quoteSwap(CHAIN, db, userId, body) : CHAIN_UNCONFIGURED();
    case 'reconcile':
      return CHAIN ? await reconcile(CHAIN, db, userId) : CHAIN_UNCONFIGURED();
    case 'geo':
      return await geo(req, db, userId);
    case 'owner_digest':
      return await ownerDigest(db, userId);
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
  // Which opponent. Anything unrecognised falls back to the uniform bot rather
  // than erroring: an unknown value must not become a harder game by accident.
  const opponent = body.opponent === 'nemesis' ? 'nemesis' : 'random';

  const { data, error } = await db.rpc('open_match', {
    p_user_id: userId,
    p_format: body.format,
    p_theme: typeof body.theme === 'string' ? body.theme : null,
    p_fast_mode: body.fast_mode === true,
    p_opponent: opponent,
  });
  if (error) return fail('db_error', error.message, 500);

  const refused = rpcError(data);
  if (refused) return refused;

  return json({ match_id: data.match_id, opponent: data.opponent });
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

// ------------------------------------------------------------ nemesis_report

/**
 * What Nemesis saw, handed back after the match and never during it.
 *
 * This is the ONLY route to `nemesis_match_report`, which is revoked from
 * `anon` and `authenticated` — the browser has no grant to call it with. The
 * user id comes from the verified token, so a player can only ask about their
 * own match, and the RPC itself refuses while the match is still in progress:
 * the breakdown names which rounds were read, and knowing that mid-match is a
 * live advantage rather than a debrief.
 */
async function nemesisReport(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  if (typeof body.match_id !== 'string') return fail('bad_request', 'match_id required', 400);

  const { data, error } = await db.rpc('nemesis_match_report', {
    p_match_id: body.match_id,
    p_user_id: userId,
  });
  if (error) return fail('db_error', error.message, 500);

  const refused = rpcError(data as Record<string, unknown> | null);
  if (refused) return refused;

  return json(data as Record<string, unknown>);
}

// ---------------------------------------------------------------- open_round

async function openRound(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  if (typeof body.match_id !== 'string') return fail('bad_request', 'match_id required', 400);

  // BOTH BRANCHES, EVERY ROUND, WHATEVER THE MODE.
  //
  // The blind move is drawn, the coin is flipped and the read is computed on
  // every single round — before anything looks at whether the read will be
  // used. Skipping the prediction when the coin is going to land blind would
  // be the obvious optimisation and it would open a side channel: round-open
  // latency would announce "Nemesis is reading you this round", and a player
  // who can hear that simply deviates. That is worth more to them than knowing
  // the move itself, so the work is kept constant instead.
  //
  // NEMESIS CANNOT SEE THIS ROUND'S THROW. `nemesis_open` runs before the round
  // row exists, reads only rounds in state 'resolved', and the move it informs
  // is committed to below — with the digest handed to the client — before the
  // player moves. A peek would break that commitment at reveal, which
  // verifyRound checks on every resolved round.
  const blind = drawMove();
  const coin = drawUnitInterval();

  const { data: read, error: readError } = await db.rpc('nemesis_open', {
    p_user_id: userId,
    p_match_id: body.match_id,
  });
  if (readError) return fail('db_error', readError.message, 500);

  const readRow = (read ?? {}) as Record<string, unknown>;
  const rate = Number(readRow.exploit_rate ?? 0);
  const counter = readRow.counter;
  const exploited = coin < rate && isChoice(counter);
  const move: Choice = exploited ? (counter as Choice) : blind;

  const nonce = newNonce();
  const commitment = await computeCommitment(move, nonce);

  // Recorded with the round, in one transaction, so the post-match breakdown
  // can never describe a round differently from how it was played.
  const nemesis = readRow.reason === 'nemesis' ? { ...readRow, exploited } : null;

  const { data, error } = await db.rpc('open_round', {
    p_match_id: body.match_id,
    p_user_id: userId,
    p_move: move,
    p_nonce: nonce,
    p_commitment: commitment,
    p_nemesis: nemesis,
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
// ------------------------------------------------------------------- geo
//
// The caller's country, resolved from the REAL request IP — read from the
// x-forwarded-for header the platform sets, not from anything the client could
// forge in the request body. Same source `clientIp` uses for the failure
// limiter, so the two agree by construction.
//
// PERSISTS the verdict to `geo_verdicts` via `geo_record_verdict`, because the
// money gate `geo_allows_money` (called inside `create_payment_intent`) reads
// from that table. A client that hits `create_intent` without ever having
// resolved geo would get `geo_unknown` — so the client is expected to call
// this action once on entry, before any money action.
//
// ipwho.is is free and unauthenticated; a bad answer here is "unknown", never
// a crash — but the persisted verdict for an unknown lookup is NOT written, so
// the money gate stays fail-closed rather than accidentally allowing everyone.
async function geo(req: Request, db: SupabaseClient, userId: string): Promise<Response> {
  const ip = clientIp(req);
  if (ip === 'unknown' || ip === '127.0.0.1' || ip.startsWith('::')) {
    return json({ ip, country_code: null, country: null, source: 'local' });
  }
  let doc: any = null;
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,country_code,region,city,connection`);
    doc = await res.json();
  } catch (err) {
    return json({ ip, country_code: null, country: null, source: 'ipwho.is', error: err instanceof Error ? err.message : 'lookup_error' });
  }
  if (!doc?.success) {
    return json({ ip, country_code: null, country: null, source: 'ipwho.is', error: doc?.message ?? 'lookup_failed' });
  }
  const country_code = typeof doc.country_code === 'string' ? doc.country_code : null;
  // ipwho.is exposes `connection.type` — 'hosting' means a datacenter IP,
  // which is the signal `geo_allows_money` uses to refuse money from VPN exit
  // nodes and cloud providers.
  const is_datacenter = doc?.connection?.type === 'hosting';

  if (country_code) {
    // Best-effort persist. A failure here must not break the caller — the next
    // money action will refuse with `geo_unknown` and the client will retry.
    await db.rpc('geo_record_verdict', {
      p_user_id: userId,
      p_country: country_code,
      p_source: 'ipwho.is',
      p_is_datacenter: is_datacenter,
    });
  }

  return json({
    ip,
    country_code,
    country: typeof doc.country === 'string' ? doc.country : null,
    region: typeof doc.region === 'string' ? doc.region : null,
    city: typeof doc.city === 'string' ? doc.city : null,
    is_datacenter,
    source: 'ipwho.is',
  });
}

async function health(db: SupabaseClient, userId: string) {
  const { data, error } = await db.rpc('health_digest', { p_user_id: userId });
  if (error) return fail('db_error', error.message, 500);

  const refused = rpcError(data);
  if (refused) return refused;

  return json(data);
}

/**
 * Owner-only money-anomaly snapshot. Delegates to `owner_money_digest`, which
 * is where the actual gating and the anomaly rollup live — this handler is
 * just the HTTPS wrapper. Any non-owner caller receives `{"error":"forbidden"}`
 * from the RPC itself, so the check is not duplicated at this layer.
 */
async function ownerDigest(db: SupabaseClient, userId: string) {
  const { data, error } = await db.rpc('owner_money_digest', { p_user_id: userId });
  if (error) return fail('db_error', error.message, 500);
  const refused = rpcError(data);
  if (refused) return refused;
  return json(data);
}

// ===================================================================== chain
//
// USDC purchases. The one rule: we never trust the client's claim that it paid.
// The client reports a signature and nothing more; everything that decides
// whether chips are credited is read from the chain here.

// One named config, not four scattered env reads. A deploy that sets three of
// the four — a common way to accidentally point a mainnet-scoped server at a
// devnet RPC — collapses `CHAIN` to null, and every payment endpoint refuses
// at the door. The type is only handed to functions that need it, so
// "forgot the gate" is a TypeScript error rather than a production incident.
//
// Treasury and mint are pinned in env AS WELL as frozen on the intent. The DB
// supplies values to new intents; the env cross-check catches the case where a
// leaked service-role key rewrites payment_config to a treasury the attacker
// controls — the edge function would still refuse to credit a payment that
// went to any address other than the one this deploy was built with.
interface ChainConfig {
  readonly rpcUrl: string;
  readonly cluster: 'devnet' | 'mainnet-beta';
  readonly treasury: string;
  readonly usdcMint: string;
  // The treasury's USDC token account, pinned in env like the treasury itself,
  // because Jupiter's `destinationTokenAccount` must name the token account,
  // not the owner. OPTIONAL rather than all-or-nothing: only the mainnet swap
  // route needs it, and its absence fails only that route closed
  // (swap_unavailable) — a devnet deploy without it loses nothing.
  readonly treasuryUsdcAta: string | null;
}

function readChainConfig(): ChainConfig | null {
  const rpcUrl = Deno.env.get('SOLANA_RPC_URL') ?? '';
  const cluster = Deno.env.get('SOLANA_CLUSTER') ?? '';
  const treasury = Deno.env.get('SOLANA_TREASURY') ?? '';
  const usdcMint = Deno.env.get('SOLANA_USDC_MINT') ?? '';
  if (!rpcUrl || !cluster || !treasury || !usdcMint) return null;
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') return null;
  const treasuryUsdcAta = Deno.env.get('TREASURY_USDC_ATA') || null;
  return { rpcUrl, cluster, treasury, usdcMint, treasuryUsdcAta };
}

const CHAIN: ChainConfig | null = readChainConfig();
const TOS_VERSION = 'v1';

const CHAIN_UNCONFIGURED = () =>
  fail('payments_unconfigured', 'Chain config missing or partial', 503);

async function rpc(chain: ChainConfig, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(chain.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const doc = await res.json();
  if (doc.error) throw new Error(doc.error?.message ?? 'rpc_error');
  return doc.result;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58, for generating a reference that looks like a pubkey to wallets. */
function base58(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte === 0) out += '1';
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]];
  return out;
}

/** Raw base units to an exact decimal string. Never floats — this is money. */
function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const s = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals > 0 ? s.slice(s.length - decimals) : '';
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Decimal string to raw base units. Refuses excess precision — this is money. */
function parseUnits(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new Error(`not a decimal amount: ${value}`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimals: ${value}`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

interface IntentRow {
  id: string;
  user_id: string;
  cluster: string;
  reference: string;
  treasury_address: string;
  usdc_mint: string;
  usdc_decimals: number;
  // Present when loaded via loadIntent; reconcile builds rows without them.
  status?: string;
  expected_usdc?: number;
  chips_per_usdc?: number;
}

type ChainResult =
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'not_ours'; why: string }
  | { kind: 'ok'; amount: string; commitment: string };

/**
 * Reads a transaction and decides whether it pays THIS intent.
 *
 * Two checks carry the weight:
 *
 *   THE REFERENCE. Every intent carries a unique reference pubkey, and the
 *   transaction must contain it. Without this, any USDC transfer into the
 *   treasury could be claimed by whoever reports its signature first — someone
 *   watching the treasury on-chain simply takes another player's payment. The
 *   signature primary key stops it being credited TWICE; only this stops it
 *   being credited to the WRONG PERSON once.
 *
 *   THE AMOUNT comes from the treasury's token-balance delta, not from the
 *   intent and not from the client. Diffing pre/post balances rather than
 *   parsing instructions handles transfer, transferChecked and any wrapper
 *   identically, and it is measured in raw base units as BigInt so no float
 *   ever touches a monetary value.
 */
async function verifyOnChain(chain: ChainConfig, intent: IntentRow, signature: string): Promise<ChainResult> {
  const tx = await rpc(chain, 'getTransaction', [
    signature,
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
  ]);

  // Not visible yet. Solana finality is not instant, so this is the normal
  // answer for a few seconds and means "keep waiting", never "it failed".
  if (!tx) return { kind: 'pending' };
  if (tx.meta?.err) return { kind: 'failed' };

  // Static keys plus lookup-table-loaded keys (see txkeys.ts): a versioned
  // transaction can carry a binding through an address lookup table, and the
  // check must be independent of how the key travelled.
  const keys = collectAccountKeys(tx);
  if (!keys.includes(intent.reference)) {
    return { kind: 'not_ours', why: 'reference_absent' };
  }

  const post = (tx.meta?.postTokenBalances ?? []) as any[];
  const pre = (tx.meta?.preTokenBalances ?? []) as any[];
  const postB = post.find(
    (b) => b.owner === intent.treasury_address && b.mint === intent.usdc_mint,
  );
  if (!postB) return { kind: 'not_ours', why: 'no_treasury_balance_for_mint' };

  const preB = pre.find((b) => b.accountIndex === postB.accountIndex);
  const deltaRaw =
    BigInt(postB.uiTokenAmount?.amount ?? '0') - BigInt(preB?.uiTokenAmount?.amount ?? '0');
  if (deltaRaw <= 0n) return { kind: 'not_ours', why: 'no_incoming_transfer' };

  return {
    kind: 'ok',
    amount: formatUnits(deltaRaw, intent.usdc_decimals),
    commitment: 'confirmed',
  };
}

/** Loads an intent the caller owns, and refuses a cluster mismatch outright. */
async function loadIntent(
  chain: ChainConfig,
  db: SupabaseClient,
  userId: string,
  intentId: unknown,
): Promise<{ intent?: IntentRow; refusal?: Response }> {
  if (typeof intentId !== 'string') {
    return { refusal: fail('bad_request', 'intent_id required', 400) };
  }
  const { data, error } = await db
    .from('payment_intents')
    .select(
      'id, user_id, cluster, reference, treasury_address, usdc_mint, usdc_decimals, status, expected_usdc, chips_per_usdc',
    )
    .eq('id', intentId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) return { refusal: fail('db_error', error.message, 500) };
  if (!data) return { refusal: fail('not_found', 'No such payment', 404) };

  // Fail closed. Verifying a mainnet intent against a devnet RPC — or the
  // reverse — is the worst mistake available here, so it is refused rather
  // than noticed later on a dashboard.
  if (data.cluster !== chain.cluster) {
    return {
      refusal: fail('cluster_mismatch', `Intent is ${data.cluster}, server is ${chain.cluster}`, 409),
    };
  }
  // Env-pinned treasury/mint cross-check. If the DB was rewritten to point at
  // an attacker treasury, the intent that quotes it will still be refused here.
  if (data.treasury_address !== chain.treasury) {
    return {
      refusal: fail('payment_mismatch', 'intent_treasury_not_pinned', 409),
    };
  }
  if (data.usdc_mint !== chain.usdcMint) {
    return {
      refusal: fail('payment_mismatch', 'intent_mint_not_pinned', 409),
    };
  }
  return { intent: data as IntentRow };
}

// ------------------------------------------------------------------ actions

async function acceptTos(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const version = typeof body.version === 'string' ? body.version : TOS_VERSION;
  const { data, error } = await db.rpc('record_tos_acceptance', {
    p_user_id: userId,
    p_version: version,
  });
  if (error) return fail('db_error', error.message, 500);
  const refused = rpcError(data);
  return refused ?? json(data);
}

async function createIntent(chain: ChainConfig, db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  // The reference is generated HERE, never accepted from the client: a client
  // that chose its own could reuse one and bind someone else's payment.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  const { data, error } = await db.rpc('create_payment_intent', {
    p_user_id: userId,
    p_cluster: chain.cluster,
    p_reference: base58(bytes),
    p_expected_usdc: typeof body.usdc === 'number' && body.usdc > 0 ? body.usdc : 1,
    p_tos_version: typeof body.tos_version === 'string' ? body.tos_version : TOS_VERSION,
  });
  if (error) return fail('db_error', error.message, 500);
  const refused = rpcError(data);
  return refused ?? json(data);
}

async function confirmPayment(chain: ChainConfig, db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  // Rate limit BEFORE loadIntent + verifyOnChain, so a wallet retry loop
  // cannot hammer the Solana RPC. Placement is deliberate: on limit exceeded
  // we answer 'pending', NOT 429. The money may already be on chain, and the
  // intent's reference lets `reconcile` credit it without the client ever
  // succeeding here — so refusing loudly would risk stranding a paid intent.
  // The client polls, the next window opens, and the very next attempt reads
  // the same transaction that was already confirmed.
  const { data: allowed, error: rlErr } = await db.rpc('take_rate_token', {
    p_user_id: userId,
    p_action: 'confirm_payment',
  });
  if (rlErr) return fail('db_error', rlErr.message, 500);
  if (allowed === false) return json({ status: 'pending', reason: 'rate_limited' });

  const { intent, refusal } = await loadIntent(chain, db, userId, body.intent_id);
  if (refusal) return refusal;

  const signature = body.signature;
  if (typeof signature !== 'string' || signature.length < 32) {
    return fail('bad_request', 'signature required', 400);
  }

  let result: ChainResult;
  try {
    result = await verifyOnChain(chain, intent!, signature);
  } catch (err) {
    // An RPC that is down must not look like a rejected payment. The money may
    // well be on chain; this is our failure to read it, and reconciliation will
    // pick it up.
    return fail('rpc_unavailable', err instanceof Error ? err.message : 'rpc error', 503);
  }

  if (result.kind === 'pending') return json({ status: 'pending' });
  if (result.kind === 'failed') return fail('payment_failed', 'Transaction failed on chain', 409);
  if (result.kind === 'not_ours') return fail('payment_mismatch', result.why, 409);

  const { data, error } = await db.rpc('credit_purchase', {
    p_signature: signature,
    p_cluster: intent!.cluster,
    p_user_id: userId,
    p_intent_id: intent!.id,
    p_treasury: intent!.treasury_address,
    p_mint: intent!.usdc_mint,
    p_usdc_amount: result.amount,
    p_commitment: result.commitment,
  });
  if (error) return fail('db_error', error.message, 500);
  const refused = rpcError(data);
  if (refused) return refused;

  return json({ status: 'credited', ...data });
}

// ---------------------------------------------------------------- quote_swap
//
// The player's side of a swap-routed purchase: "what does 100 chips cost in
// the token I actually hold?" The treasury side never changes — it receives
// the intent's frozen USDC mint, verified by the same treasury-delta check,
// which is why confirm_payment, credit_purchase and reconcile need no
// knowledge that a swap happened at all.
//
// The quote is PROXIED here rather than fetched by the client so that it can
// be rate-limited (a new outbound dependency on a money path), recorded on the
// intent for disputes, and validated against the server-side token allow-list
// — and so the browser's CSP never needs a new host.

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const JUPITER_BASE = 'https://lite-api.jup.ag/swap/v1';
const JUPITER_TIMEOUT_MS = 8_000;
const SWAP_SLIPPAGE_BPS = 100;

interface AcceptedToken {
  mint: string;
  cluster: string;
  symbol: string;
  decimals: number;
  harness_rate_usdc: number | null;
  liquidity_wallet: string | null;
}

async function quoteSwap(chain: ChainConfig, db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  // Hard 429 is fine at quote time, unlike confirm_payment's soft answer: no
  // money is in flight yet, so refusing loudly strands nothing.
  const { data: allowed, error: rlErr } = await db.rpc('take_rate_token', {
    p_user_id: userId,
    p_action: 'quote_swap',
  });
  if (rlErr) return fail('db_error', rlErr.message, 500);
  if (allowed === false) return fail('rate_limited', 'Too many quote requests', 429);

  const { intent, refusal } = await loadIntent(chain, db, userId, body.intent_id);
  if (refusal) return refusal;
  if (intent!.status !== 'pending') return fail('intent_not_open', 'Intent is not open', 409);

  // Shape-check BEFORE the mint string touches a lookup or a URL.
  const inputMint = body.input_mint;
  if (typeof inputMint !== 'string' || !BASE58_RE.test(inputMint)) {
    return fail('bad_request', 'input_mint required', 400);
  }
  if (inputMint === intent!.usdc_mint) {
    // "Swap USDC to USDC" is the direct path wearing a costume.
    return fail('unsupported_input_mint', 'Pay USDC directly instead', 400);
  }

  // The allow-list is the authority, re-checked here on every quote — the
  // client's copy of this table is for rendering a picker, nothing more.
  const { data: tok, error: tokErr } = await db
    .from('accepted_input_tokens')
    .select('mint, cluster, symbol, decimals, harness_rate_usdc, liquidity_wallet')
    .eq('mint', inputMint)
    .eq('cluster', intent!.cluster)
    .eq('active', true)
    .maybeSingle<AcceptedToken>();
  if (tokErr) return fail('db_error', tokErr.message, 500);
  if (!tok) return fail('unsupported_input_mint', 'Token not accepted', 400);

  const usdcOut = (intent!.expected_usdc ?? 1).toFixed(intent!.usdc_decimals);
  const usdcOutRaw = parseUnits(usdcOut, intent!.usdc_decimals);

  if (chain.cluster === 'devnet') {
    return await devnetHarnessQuote(db, userId, intent!, tok, usdcOut, usdcOutRaw);
  }
  return await jupiterQuote(chain, db, userId, intent!, tok, body, usdcOutRaw);
}

/**
 * Devnet swap provider. Jupiter does not exist on devnet — its API serves
 * mainnet only — and devnet is the only cluster this deploy can reach. So the
 * devnet provider is the harness itself: a fixed rate from the allow-list row
 * and a liquidity wallet that receives the input leg. The client builds a real
 * atomic multi-instruction transaction from this quote, which exercises every
 * invariant WE own — multi-instruction verification, reference binding, quote
 * lifecycle, replay, reconciliation, conservation — live on devnet. The
 * Jupiter HTTP integration below is what fixtures cover instead.
 */
async function devnetHarnessQuote(
  db: SupabaseClient,
  userId: string,
  intent: IntentRow,
  tok: AcceptedToken,
  usdcOut: string,
  usdcOutRaw: bigint,
) {
  // A devnet row without a rate or a liquidity wallet is a provider that
  // cannot quote — the same degraded answer an unreachable Jupiter gives, and
  // the USDC-direct path is expected to carry on.
  if (tok.harness_rate_usdc == null || tok.harness_rate_usdc <= 0 || !tok.liquidity_wallet) {
    return fail('swap_unavailable', 'Devnet swap provider not configured for this token', 503);
  }

  // input = usdcOut / rate, in integer math, rounded UP so the treasury never
  // receives less than the quoted USDC because of our own rounding.
  const rateRaw = parseUnits(tok.harness_rate_usdc.toFixed(6), 6);
  const scale = 10n ** BigInt(tok.decimals);
  const inputRaw = (usdcOutRaw * scale + rateRaw - 1n) / rateRaw;
  const quotedInput = formatUnits(inputRaw, tok.decimals);

  const { data, error } = await db.rpc('record_swap_quote', {
    p_user_id: userId,
    p_intent_id: intent.id,
    p_input_mint: tok.mint,
    p_swap_mode: 'ExactOut',
    p_quoted_input: quotedInput,
    p_quoted_usdc_out: usdcOut,
    p_min_usdc_out: usdcOut,
    p_slippage_bps: 0,
    p_route: {
      provider: 'devnet_harness',
      rate_usdc: tok.harness_rate_usdc,
      liquidity_wallet: tok.liquidity_wallet,
    },
  });
  if (error) return fail('db_error', error.message, 500);
  const refused = rpcError(data);
  if (refused) return refused;

  return json({
    provider: 'devnet_harness',
    ...data,
    quoted_input_raw: inputRaw.toString(),
    usdc_out_raw: usdcOutRaw.toString(),
    liquidity_wallet: tok.liquidity_wallet,
  });
}

/**
 * Mainnet swap provider: Jupiter, proxied. DEAD CODE TODAY, deliberately —
 * mainnet ChainConfig is fail-closed off, so this branch cannot run in any
 * current deploy. It ships now so the mainnet activation checklist flips a
 * config, not a development project, and it is exercised by contract tests
 * against recorded API fixtures (see jupiter.test.ts) because that is
 * the honest ceiling: there is no Jupiter on the only reachable cluster.
 *
 * ExactOut is tried first (the treasury receives exactly the quoted USDC, so
 * the displayed chip amount is exact and slippage is bounded on the input
 * side). ExactOut route coverage is narrow, so ExactIn at 100 bps is the
 * well-worn path: the on-chain minimum-out means under-delivery below the
 * quoted floor reverts the whole transaction — the player pays nothing but
 * the network fee, and is never credited less than the number they were shown.
 */
async function jupiterQuote(
  chain: ChainConfig,
  db: SupabaseClient,
  userId: string,
  intent: IntentRow,
  tok: AcceptedToken,
  body: Record<string, unknown>,
  usdcOutRaw: bigint,
) {
  // Jupiter does not create the destination token account; without the pinned
  // treasury USDC ATA the route cannot settle to the treasury, so the swap
  // path — and only the swap path — fails closed.
  if (!chain.treasuryUsdcAta) {
    return fail('swap_unavailable', 'TREASURY_USDC_ATA not configured', 503);
  }
  const payer = body.payer;
  if (typeof payer !== 'string' || !BASE58_RE.test(payer)) {
    return fail('bad_request', 'payer required', 400);
  }

  try {
    const outcome = await fetchJupiterQuote(fetch, JUPITER_BASE, {
      inputMint: tok.mint,
      outputMint: intent.usdc_mint,
      usdcOutRaw,
      inputDecimals: tok.decimals,
      slippageBps: SWAP_SLIPPAGE_BPS,
      timeoutMs: JUPITER_TIMEOUT_MS,
    });
    const ix = await fetchJupiterSwapInstructions(fetch, JUPITER_BASE, {
      quote: outcome.quote,
      payer,
      destinationTokenAccount: chain.treasuryUsdcAta,
      timeoutMs: JUPITER_TIMEOUT_MS,
    });

    const { quotedInputRaw, quotedUsdcRaw, minUsdcRaw } = quoteAmounts(outcome);

    const { data, error } = await db.rpc('record_swap_quote', {
      p_user_id: userId,
      p_intent_id: intent.id,
      p_input_mint: tok.mint,
      p_swap_mode: outcome.swapMode,
      p_quoted_input: formatUnits(quotedInputRaw, tok.decimals),
      p_quoted_usdc_out: formatUnits(quotedUsdcRaw, intent.usdc_decimals),
      p_min_usdc_out: formatUnits(minUsdcRaw, intent.usdc_decimals),
      p_slippage_bps: SWAP_SLIPPAGE_BPS,
      p_route: summarizeRoute(outcome.quote),
    });
    if (error) return fail('db_error', error.message, 500);
    const refused = rpcError(data);
    if (refused) return refused;

    return json({
      provider: 'jupiter',
      ...data,
      quoted_input_raw: quotedInputRaw.toString(),
      usdc_out_raw: quotedUsdcRaw.toString(),
      instructions: {
        compute_budget: ix.computeBudgetInstructions ?? [],
        setup: ix.setupInstructions ?? [],
        swap: ix.swapInstruction,
        cleanup: ix.cleanupInstruction ?? null,
      },
      address_lookup_table_addresses: ix.addressLookupTableAddresses ?? [],
    });
  } catch (err) {
    // The aggregator being down is not a payment verdict and must not strand
    // the player: the client degrades to the USDC-direct path, which shares
    // nothing with this code.
    return fail('swap_unavailable', err instanceof Error ? err.message : 'aggregator unreachable', 503);
  }
}

/**
 * Finds payments nobody told us about.
 *
 * A player who pays and closes the tab has still paid, and the money is
 * irreversible, so it cannot depend on the client coming back to report a
 * signature. Every intent carries a reference, and a reference is an account in
 * the transaction — so the chain can be asked "what paid this intent" directly.
 *
 * Owner-triggered rather than scheduled, because nothing here is scheduled yet
 * and a cron that silently stops is worse than a button someone presses.
 */
async function reconcile(chain: ChainConfig, db: SupabaseClient, userId: string) {
  const { data: owner } = await db
    .from('profiles')
    .select('is_owner')
    .eq('id', userId)
    .maybeSingle();
  if (!owner?.is_owner) return fail('forbidden', 'Owner only', 403);

  const { data: intents, error } = await db.rpc('open_intents_for_reconcile', {
    p_max_age: '7 days',
  });
  if (error) return fail('db_error', error.message, 500);

  const scanned: unknown[] = [];
  for (const row of (intents ?? []) as any[]) {
    if (row.cluster !== chain.cluster) continue;
    // Same env-pinned cross-check as loadIntent: refuse to reconcile against a
    // treasury/mint that does not match this deploy's pinned values.
    if (row.treasury_address !== chain.treasury) continue;
    if (row.usdc_mint !== chain.usdcMint) continue;

    let sigs: any[] = [];
    try {
      sigs = (await rpc(chain, 'getSignaturesForAddress', [row.reference, { limit: 10 }])) ?? [];
    } catch {
      continue; // a failed read is not a verdict; the next run tries again
    }
    if (sigs.length === 0) continue;

    const intent: IntentRow = {
      id: row.id,
      user_id: row.user_id,
      cluster: row.cluster,
      reference: row.reference,
      treasury_address: row.treasury_address,
      usdc_mint: row.usdc_mint,
      // From the intent's frozen copy, not a literal. This scales the amount,
      // so guessing it wrong credits a player a thousand times what they paid.
      usdc_decimals: row.usdc_decimals,
    };

    for (const s of sigs) {
      const verdict = await verifyOnChain(chain, intent, s.signature);
      if (verdict.kind !== 'ok') continue;
      const { data: credited } = await db.rpc('credit_purchase', {
        p_signature: s.signature,
        p_cluster: intent.cluster,
        p_user_id: intent.user_id,
        p_intent_id: intent.id,
        p_treasury: intent.treasury_address,
        p_mint: intent.usdc_mint,
        p_usdc_amount: verdict.amount,
        p_commitment: verdict.commitment,
      });
      scanned.push({ intent_id: intent.id, signature: s.signature, result: credited });
    }
  }

  return json({ ok: true, cluster: chain.cluster, credited: scanned });
}
