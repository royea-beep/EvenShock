/**
 * Restore drill — proves the daily physical backup actually restores.
 *
 *   npm run monitor:restore-drill -- --scratch=<project_ref>
 *
 * WHAT IT DOES. Reads the invariant snapshot from production, reads the same
 * snapshot from a scratch project that was restored from a recent backup, and
 * asserts they match on every money-relevant total.
 *
 * WHY THIS EXISTS. "Supabase probably backs up" is not a recovery plan. A
 * backup nobody has restored is a hope. Running this end-to-end proves:
 *   1. The physical backup file is readable
 *   2. The restore pipeline produces a usable Postgres
 *   3. Chip conservation survives the round trip
 *   4. Payment PK uniqueness survives the round trip
 *   5. house_ledger sum survives the round trip
 *
 * PREREQUISITE. Someone has to have restored a scratch project from a
 * Supabase backup first — that path is Studio-only, not exposed to the CLI.
 * See docs/mainnet-activation-checklist.md for the step-by-step. Once the
 * scratch project ref is in hand, this script does the rest.
 *
 * The comparison uses the SAME SQL query against both projects (via the
 * service role), so a schema drift between production and scratch surfaces
 * as an error, not as a false PASS.
 */
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE_KEY, requirePublic } from './env.mjs';

requirePublic();
if (!SERVICE_ROLE_KEY) {
  console.error('\n  SUPABASE_SERVICE_ROLE_KEY required for the production side.\n');
  process.exit(1);
}

const scratchArg = process.argv.find((a) => a.startsWith('--scratch='));
if (!scratchArg) {
  console.error('\n  Usage: npm run monitor:restore-drill -- --scratch=<project_ref>');
  console.error('  Also required in env: SUPABASE_SCRATCH_URL and SUPABASE_SCRATCH_SERVICE_ROLE_KEY.\n');
  process.exit(1);
}
const scratchRef = scratchArg.split('=')[1];
const scratchUrl = process.env.SUPABASE_SCRATCH_URL;
const scratchKey = process.env.SUPABASE_SCRATCH_SERVICE_ROLE_KEY;
if (!scratchUrl || !scratchKey) {
  console.error(`\n  SUPABASE_SCRATCH_URL and SUPABASE_SCRATCH_SERVICE_ROLE_KEY must be set for scratch ref ${scratchRef}.`);
  console.error('  Get them from the scratch project dashboard, add to .env.local, do NOT commit.\n');
  process.exit(1);
}

const production = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const scratch = createClient(scratchUrl, scratchKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * The invariants we compare. Each entry is a name and a function that runs a
 * pair of counts/sums against a client and returns a single number or string.
 * The comparison is exact — any drift fails the drill.
 */
async function snapshot(client, label) {
  console.log(`snapshot: ${label}`);
  const q = async (fn, args = {}) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`${label}/${fn}: ${error.message}`);
    return data;
  };
  // Prefer table selects with head:true + count for exactness.
  const rows = {};
  const scalar = async (query) => {
    // Uses PostgREST count. For sums we go via the query builder.
    return null; // placeholder; explicit sums below
  };
  const bal = await client.from('balances').select('chips,xp');
  if (bal.error) throw new Error(`${label}/balances: ${bal.error.message}`);
  rows.balances_sum_chips = bal.data.reduce((n, r) => n + Number(r.chips ?? 0), 0);
  rows.balances_sum_xp    = bal.data.reduce((n, r) => n + Number(r.xp ?? 0), 0);

  const led = await client.from('ledger').select('delta,currency,idem_key');
  if (led.error) throw new Error(`${label}/ledger: ${led.error.message}`);
  rows.ledger_sum_chips     = led.data.filter((r) => r.currency === 'chips').reduce((n, r) => n + Number(r.delta ?? 0), 0);
  rows.ledger_sum_xp        = led.data.filter((r) => r.currency === 'xp').reduce((n, r) => n + Number(r.delta ?? 0), 0);
  rows.ledger_row_count     = led.data.length;
  rows.ledger_distinct_idem = new Set(led.data.map((r) => r.idem_key).filter(Boolean)).size;

  const pay = await client.from('payments').select('signature,usdc_amount');
  if (pay.error) throw new Error(`${label}/payments: ${pay.error.message}`);
  rows.payments_row_count    = pay.data.length;
  rows.payments_distinct_sig = new Set(pay.data.map((r) => r.signature)).size;
  rows.payments_usdc_sum     = pay.data.reduce((n, r) => n + Number(r.usdc_amount ?? 0), 0);

  const house = await client.from('house_ledger').select('delta');
  if (house.error) throw new Error(`${label}/house_ledger: ${house.error.message}`);
  rows.house_ledger_sum  = house.data.reduce((n, r) => n + Number(r.delta ?? 0), 0);
  rows.house_ledger_rows = house.data.length;

  for (const [t, k] of [
    ['inventory', 'inventory_rows'],
    ['profiles', 'profiles_rows'],
    ['integrity_events', 'integrity_events_rows'],
    ['matches', 'matches_rows'],
    ['rounds', 'rounds_rows'],
    ['geo_verdicts', 'geo_verdicts_rows'],
  ]) {
    const res = await client.from(t).select('*', { count: 'exact', head: true });
    if (res.error) throw new Error(`${label}/${t}: ${res.error.message}`);
    rows[k] = res.count ?? 0;
  }

  return rows;
}

const prod = await snapshot(production, 'production');
const rest = await snapshot(scratch,    `scratch ${scratchRef}`);

// ---------------------------------------------------------------------- diff

const keys = new Set([...Object.keys(prod), ...Object.keys(rest)]);
const drifts = [];
for (const k of [...keys].sort()) {
  const p = prod[k];
  const r = rest[k];
  const same = String(p) === String(r);
  console.log(`  ${same ? 'ok  ' : 'DIFF'}  ${k.padEnd(28)}  prod=${p}  scratch=${r}`);
  if (!same) drifts.push({ k, prod: p, scratch: r });
}

// The core money invariants get an explicit re-check on the SCRATCH side, so a
// scratch that agrees with prod but is internally inconsistent still fails.
console.log('\ncross-checks against the restored scratch:');
const scratchInternal = [
  ['scratch chip conservation', rest.balances_sum_chips === rest.ledger_sum_chips],
  ['scratch xp conservation',    rest.balances_sum_xp === rest.ledger_sum_xp],
  ['scratch payments PK holds',  rest.payments_row_count === rest.payments_distinct_sig],
  ['scratch ledger idem holds',  rest.ledger_row_count === rest.ledger_distinct_idem],
];
for (const [label, ok] of scratchInternal) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) drifts.push({ k: label, prod: 'invariant', scratch: 'broken' });
}

console.log('');
if (drifts.length === 0) {
  console.log('\x1b[32mRESTORE DRILL PASSED\x1b[0m — every invariant survives the round trip.');
  process.exit(0);
}
console.log(`\x1b[31mRESTORE DRILL FAILED\x1b[0m — ${drifts.length} discrepancy(ies):`);
for (const d of drifts) console.log(`  ${d.k}  prod=${d.prod}  scratch=${d.scratch}`);
process.exit(1);
