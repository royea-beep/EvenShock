/**
 * CORS, JWT verification and the per-IP failure budget.
 *
 * WHY THIS IS A MODULE HERE AND NOT SHARED WITH `mp` OR `play`. Those two
 * duplicate this boilerplate on purpose — see the header of mp/index.ts: two
 * functions, two blast radii, so a game change cannot republish the code that
 * credits USDC purchases. That argument is about DEPLOYMENT coupling, and it
 * still holds. It was never an argument for copying a JWT verifier a third
 * time into one more file: an auth bug fixed in two places out of three is the
 * predictable end of that. So the third copy lives in its own module inside
 * this function's own directory, deployed only with this function. Same blast
 * radius, one file to read.
 */

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

export const fail = (code: string, message: string, status: number) =>
  json({ error: code, message }, status);

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

// ------------------------------------------------- per-IP circuit breaker
const IP_FAILURE_WINDOW_MS = 60_000;
const IP_FAILURE_BUDGET = 20;
const IP_TABLE_CAP = 5_000;

const authFailures = new Map<string, { count: number; resetAt: number }>();

export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for') ?? '';
  return forwarded.split(',')[0].trim() || 'unknown';
}

export function ipOverBudget(ip: string): boolean {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  if (Date.now() >= entry.resetAt) {
    authFailures.delete(ip);
    return false;
  }
  return entry.count > IP_FAILURE_BUDGET;
}

export function noteAuthFailure(ip: string): void {
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
    // Back off after a failure, so a flood of forged tokens does not become a
    // flood of OUTBOUND key fetches we inflict on ourselves.
    if (Date.now() < jwksRetryAfter) return Promise.resolve([]);
    jwksCache = fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
      .then((r) => r.json())
      .then((doc) => (Array.isArray(doc?.keys) ? (doc.keys as Jwk[]) : []))
      .catch((e) => {
        jwksCache = null;
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
export async function verifiedUserId(authHeader: string): Promise<string | null> {
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
  // stops a token signed with a symmetric key being verified against a public
  // one.
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
