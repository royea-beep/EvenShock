/**
 * Verifies the deployed `geo` action reads a REAL IP, not a placeholder.
 *
 * "Discrimination" here has a narrow meaning: given two different callers, the
 * resolver returns two different answers, and given the same caller, it agrees
 * with an independent lookup. If it just returns null for everyone, or the same
 * country regardless of IP, x-forwarded-for is not actually being read.
 *
 * Two checks:
 *
 *   1. The edge function's geo answer for THIS caller's real IP matches an
 *      out-of-band ipwho.is call from this same machine. Same IP, same source,
 *      two paths — if they disagree the header pipeline is off.
 *
 *   2. Country code is a two-letter ISO string, not null and not empty. A null
 *      answer here means the resolver saw "unknown" or "127.0.0.1" — which is
 *      exactly what a NOT-wired header would produce.
 */
import { Keypair } from '@solana/web3.js';
import { SUPABASE_URL, ANON_KEY, requirePublic } from './env.mjs';
import { signInWithKeypair, callPlay } from './auth.mjs';
import { BROWSER_SEED } from './browser-wallet-key.mjs';

requirePublic();

const keypair = Keypair.fromSeed(BROWSER_SEED);

console.log('geo-resolver — signing in as the browser-harness wallet');
const { accessToken, address } = await signInWithKeypair(
  SUPABASE_URL,
  ANON_KEY,
  keypair,
  'geo-verifier',
);
console.log('  signed in as', address);

console.log('geo-resolver — calling the deployed edge function');
const t0 = Date.now();
const { status, body } = await callPlay(SUPABASE_URL, accessToken, { action: 'geo' });
const edgeMs = Date.now() - t0;

if (status !== 200) {
  console.error(`  edge function returned status ${status}:`, body);
  process.exit(1);
}

console.log('  edge answer:', JSON.stringify(body), `(${edgeMs}ms)`);

console.log('geo-resolver — direct ipwho.is lookup for the same machine');
const t1 = Date.now();
const doc = await fetch('https://ipwho.is/').then((r) => r.json());
const directMs = Date.now() - t1;
console.log('  direct answer:', JSON.stringify({ ip: doc.ip, country_code: doc.country_code, country: doc.country }), `(${directMs}ms)`);

// ---------------------------------------------------------------------- checks

let failed = 0;

if (!body || typeof body.country_code !== 'string' || body.country_code.length !== 2) {
  console.error(`  FAIL: edge country_code is not a 2-letter ISO string: ${JSON.stringify(body?.country_code)}`);
  console.error('        this usually means x-forwarded-for is empty or "127.0.0.1"');
  failed += 1;
} else {
  console.log('  PASS: edge returned a 2-letter country code');
}

if (body.source !== 'ipwho.is') {
  console.error(`  FAIL: edge source is not "ipwho.is" — got ${JSON.stringify(body.source)}`);
  failed += 1;
} else {
  console.log('  PASS: edge is calling the geo provider we wired');
}

// Same machine, same public IP — the two lookups should agree on country code.
// They can differ on `region` (edge asks fewer fields), so compare only country.
if (doc.country_code && body.country_code && doc.country_code !== body.country_code) {
  console.error(`  FAIL: discrimination failure — edge says ${body.country_code}, direct ipwho.is says ${doc.country_code}`);
  console.error('        the edge is reading a different IP than this machine sees');
  failed += 1;
} else if (doc.country_code) {
  console.log(`  PASS: edge country (${body.country_code}) matches direct lookup for this IP (${doc.country_code})`);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\ngeo-resolver — all checks passed');
