/**
 * Playing a friend: tables, commit-reveal between two humans, and settlement.
 *
 * SEPARATE FROM `play`, DELIBERATELY. Everything here could have been six more
 * cases in that function's switch — and then shipping a game feature would
 * redeploy the code that credits USDC purchases. The payment path has been
 * through enough (a Buffer that only existed in Node, an overloaded
 * credit_ledger, a self-transfer that could never credit); it does not need to
 * be republished every time a button moves. Two functions, two blast radii.
 *
 * The cost is the plumbing below — CORS, JWT verification, the failure
 * budget — existing twice. That is a real cost and worth it: the duplication
 * is boilerplate that has not changed in weeks, while what it protects is the
 * only code in the project that touches money.
 *
 * THE PROTOCOL. Two humans, one round:
 *
 *   mp_commit   the player picks; the server stores (move, nonce) and returns
 *               a digest. Neither move exists in plaintext to the other side,
 *               and the response is byte-identical whether or not the opponent
 *               has already moved.
 *   mp_reveal   once both have committed. The FIRST revealer is told
 *               `waiting_for_opponent` and nothing else — that asymmetry is
 *               what makes refusing to reveal a certain loss rather than a
 *               free option.
 *   mp_result   after the round resolves: both (move, nonce) pairs and both
 *               commitments, so the client can prove the server revealed what
 *               it committed to.
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { CHOICES, outcomeTable, winsNeededTable, type Choice, type MatchFormat } from './rules.ts';

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

/**
 * Every refusal the mp_* RPCs can return, mapped to a status.
 *
 * An unmapped code falls through to 400, which is how a refusal the server
 * understood perfectly becomes an unexplained "bad request" in someone's
 * network tab. `table_unavailable` is deliberately ONE code for four
 * situations — bad code, already full, expired, your own table — because a
 * guesser who could tell them apart could enumerate live invite codes.
 */
const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  bad_request: 400,
  forbidden: 403,
  rate_limited: 429,
  round_expired: 410,
  insufficient_chips: 409,
  wallet_is_treasury: 409,
  table_unavailable: 404,
  bad_stake: 400,
  table_closed: 409,
  round_closed: 409,
  already_committed: 409,
  not_committed: 409,
  no_opponent: 409,
};

const isChoice = (v: unknown): v is Choice => CHOICES.includes(v as Choice);
const FORMATS: MatchFormat[] = ['single', 'bo3', 'bo5'];
const isFormat = (v: unknown): v is MatchFormat => FORMATS.includes(v as MatchFormat);

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const OUTCOMES = outcomeTable();
const WINS_NEEDED = winsNeededTable();

// ------------------------------------------- per-IP circuit breaker (as `play`)
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

/** 32 random bytes, hex. `crypto.getRandomValues`, never `Math.random`. */
function newNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}


// ------------------------------------------------------------------ serve

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

  // Service role, which bypasses RLS — which is exactly why the user id above
  // comes from a verified signature and never from the request body. Every
  // mp_* RPC takes that id as its first argument and decides seating from it.
  const db: SupabaseClient = createClient(
    SUPABASE_URL,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  switch (body.action) {
    case 'mp_create':
      return await mpCreate(db, userId, body);
    case 'mp_join':
      return await mpJoin(db, userId, body);
    case 'mp_state':
      return await mpState(db, userId, body);
    case 'mp_open_round':
      return await mpOpenRound(db, userId, body);
    case 'mp_commit':
      return await mpCommit(db, userId, body);
    case 'mp_reveal':
      return await mpReveal(db, userId, body);
    case 'mp_result':
      return await mpResult(db, userId, body);
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

// ============================================================== multiplayer
//
// Two humans, commit-reveal, the server holding both (move, nonce) pairs.
//
// WHY THE SERVER HOLDS THEM. The obvious design has each client keep its own
// nonce and reveal it later, which needs no trust in us — and turns every tab
// crash into a forfeit with real chips on it. sessionStorage has already
// burned this codebase once in private browsing; tying a stake to it would be
// the same bug with money attached. So the server holds the pairs, and the
// price of that trust is that it must be checkable: `mp_result` hands back
// both commitments alongside both (move, nonce) pairs once a round is over,
// and the client recomputes the digest. See verifyRound in
// src/data/multiplayer.ts.
//
// THE DIGEST BINDS THE SEAT, not the account: sha256(round_id:seat:move:nonce).
// It defeats commitment-copying exactly as a user id would — a and b can never
// share a digest — and unlike a user id it is verifiable by a client that has
// never been told who its opponent is.

async function mpDigest(roundId: number | string, seat: string, move: string, nonce: string) {
  const bytes = new TextEncoder().encode(`${roundId}:${seat}:${move}:${nonce}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function mpCreate(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  if (!isFormat(body.format)) return fail('bad_request', 'Unknown format', 400);
  const stake = typeof body.stake === 'number' ? Math.trunc(body.stake) : 0;
  if (stake < 0) return fail('bad_request', 'stake must not be negative', 400);

  const { data, error } = await db.rpc('mp_create_table', {
    p_user_id: userId,
    p_format: body.format,
    p_stake: stake,
  });
  if (error) return fail('db_error', error.message, 500);
  const refused = rpcError(data);
  if (refused) return refused;
  return json(data);
}

async function mpJoin(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  if (typeof body.code !== 'string' || body.code.trim().length === 0) {
    return fail('bad_request', 'code required', 400);
  }
  const { data, error } = await db.rpc('mp_join_table', {
    p_user_id: userId,
    p_code: body.code.trim().toUpperCase(),
  });
  if (error) return fail('db_error', error.message, 500);
  const refused = rpcError(data);
  if (refused) return refused;
  return json(data);
}

async function mpState(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  if (typeof body.table_id !== 'string') return fail('bad_request', 'table_id required', 400);
  const { data, error } = await db.rpc('mp_state', {
    p_user_id: userId,
    p_table_id: body.table_id,
    p_wins_needed: WINS_NEEDED,
  });
  if (error) return fail('db_error', error.message, 500);
  const refused = rpcError(data);
  if (refused) return refused;
  return json(data);
}

async function mpOpenRound(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  if (typeof body.table_id !== 'string') return fail('bad_request', 'table_id required', 400);
  const { data, error } = await db.rpc('mp_open_round', {
    p_user_id: userId,
    p_table_id: body.table_id,
  });
  if (error) return fail('db_error', error.message, 500);
  const refused = rpcError(data);
  if (refused) return refused;
  return json(data);
}

async function mpCommit(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const roundId = body.round_id;
  if (typeof roundId !== 'number' && typeof roundId !== 'string') {
    return fail('bad_request', 'round_id required', 400);
  }
  if (!isChoice(body.move)) return fail('bad_request', 'Unknown move', 400);

  // The seat has to be known before the digest can bind to it, and the only
  // authority on which seat this player holds is the table.
  const { data: state, error: stateErr } = await db.rpc('mp_state', {
    p_user_id: userId,
    p_table_id: body.table_id,
    p_wins_needed: WINS_NEEDED,
  });
  if (stateErr) return fail('db_error', stateErr.message, 500);
  const stateRefused = rpcError(state);
  if (stateRefused) return stateRefused;
  const seat = String((state as Record<string, unknown>).seat ?? '');
  if (seat !== 'a' && seat !== 'b') return fail('not_found', 'not seated', 404);

  const nonce = newNonce();
  const commitment = await mpDigest(Number(roundId), seat, body.move, nonce);

  const { data, error } = await db.rpc('mp_commit', {
    p_user_id: userId,
    p_round_id: Number(roundId),
    p_move: body.move,
    p_nonce: nonce,
    p_commitment: commitment,
  });
  if (error) return fail('db_error', error.message, 500);
  const refused = rpcError(data);
  if (refused) return refused;

  // The nonce is NOT returned. It is the server's half of the promise, and it
  // travels only in mp_result, after the round is over.
  return json(data);
}

async function mpReveal(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const roundId = body.round_id;
  if (typeof roundId !== 'number' && typeof roundId !== 'string') {
    return fail('bad_request', 'round_id required', 400);
  }
  const { data, error } = await db.rpc('mp_reveal', {
    p_user_id: userId,
    p_round_id: Number(roundId),
    p_outcomes: OUTCOMES,
    p_wins_needed: WINS_NEEDED,
  });
  if (error) return fail('db_error', error.message, 500);
  const refused = rpcError(data);
  if (refused) return refused;

  // Whatever mp_reveal decided to say. When this player revealed first it is
  // `{waiting_for_opponent: true}` and carries nothing about the opponent —
  // that asymmetry is the entire reason non-reveal is a losing strategy.
  return json(data);
}

async function mpResult(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const roundId = body.round_id;
  if (typeof roundId !== 'number' && typeof roundId !== 'string') {
    return fail('bad_request', 'round_id required', 400);
  }
  const { data, error } = await db.rpc('mp_round_result', {
    p_user_id: userId,
    p_round_id: Number(roundId),
  });
  if (error) return fail('db_error', error.message, 500);
  const refused = rpcError(data);
  if (refused) return refused;
  return json(data);
}
