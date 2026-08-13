/**
 * Load and abuse harness.
 *
 *   npm run e2e:load
 *
 * WHAT THIS IS. Concurrent floods against the deployed edge functions, on a
 * fixed set of throwaway devnet users. It proves two things the sequential
 * suites cannot:
 *
 *   RATE LIMITS ACTUALLY FIRE.  Every value-moving action has a limit in
 *     `take_rate_token`. Sequential tests never exceed those limits by design;
 *     this one deliberately does, and asserts that the server refuses the
 *     excess. `confirm_payment` is the one that mattered most — a refusal
 *     there would strand a real payment, so its excess must be a soft
 *     `{status:'pending', reason:'rate_limited'}`, never 429.
 *
 *   INVARIANTS HOLD UNDER RACES.  Chip conservation, no double-credit, no
 *     double-spend, single-winner submits, single-seat joins. Every workload
 *     re-reads the DB via service role afterwards and asserts the outcome
 *     matches the arithmetic — because a race that passes 1-at-a-time and
 *     corrupts at 100-at-a-time is exactly the class of bug that only appears
 *     in production.
 *
 * IT WRITES REAL ROWS to the production project. All writes are scoped to a
 * fixed set of 10 harness user_ids (see `LOAD_USERS`), cleaned up between
 * workloads and again at the end. Nothing here moves real money — mainnet is
 * flag-off and this harness never signs an on-chain send. Workload #8 is the
 * only one that touches USDC at all, and reuses whatever the payment suite has
 * already credited.
 *
 * SAFETY CAPS baked in:
 *   - MAX_REQUESTS_PER_RUN — abort if total requests exceed 50_000
 *   - MAX_PARALLEL — no single Promise.all() launches more than 200 requests
 *   - PER_WORKLOAD_TIMEOUT — 60s
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createClient } from '@supabase/supabase-js';
import { Keypair } from '@solana/web3.js';
import { signInWithKeypair, callPlay, callMp } from './auth.mjs';
import { SUPABASE_URL, ANON_KEY, SERVICE_ROLE_KEY, requirePublic } from './env.mjs';

requirePublic();
if (!SERVICE_ROLE_KEY) {
  console.error('\n  SUPABASE_SERVICE_ROLE_KEY is required to read invariants and reset test rows.\n');
  process.exit(1);
}

const N_USERS = 10;
const MAX_REQUESTS_PER_RUN = 50_000;
const MAX_PARALLEL = 200;
const PER_WORKLOAD_TIMEOUT_MS = 60_000;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// -------------------------------------------------------------- test users

/** Deterministic keypair for load user #i. Well-known secret, devnet only. */
function loadKeypair(i) {
  const seed = createHash('sha256').update(`evenshock/load/v1/${i}`).digest();
  return Keypair.fromSeed(new Uint8Array(seed));
}

console.log(`load-abuse — signing in ${N_USERS} deterministic harness users`);
const t0 = performance.now();
const sessions = await Promise.all(
  Array.from({ length: N_USERS }, (_, i) =>
    signInWithKeypair(SUPABASE_URL, ANON_KEY, loadKeypair(i), `load${i}`),
  ),
);
const ids = sessions.map((s) => s.userId);
console.log(`  signed in ${sessions.length} users in ${Math.round(performance.now() - t0)}ms`);

// Every workload writes as a load user; every read for invariant checks reads
// as admin. The two roles never mix in one function, so the same test cannot
// accidentally use elevated privileges to hide a bug.
const asUser = (i) => sessions[i];

// ------------------------------------------------------ runtime request cap

let requestsFired = 0;
function accountFor(n) {
  requestsFired += n;
  if (requestsFired > MAX_REQUESTS_PER_RUN) {
    throw new Error(
      `runtime cap hit: ${requestsFired} > ${MAX_REQUESTS_PER_RUN}. Aborting to keep the bill honest.`,
    );
  }
}

/** Fires N copies of `fn` in parallel, respecting MAX_PARALLEL as a chunk size. */
async function fanOut(n, fn) {
  if (n > MAX_PARALLEL) {
    throw new Error(`fanOut(${n}) exceeds MAX_PARALLEL=${MAX_PARALLEL}`);
  }
  accountFor(n);
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => {
      const t = performance.now();
      return Promise.resolve(fn(i)).then((r) => ({ r, ms: performance.now() - t }));
    }),
  );
  const total = performance.now() - started;
  return { results, totalMs: total };
}

function pctile(nums, p) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100));
  return Math.round(sorted[idx]);
}

// ------------------------------------------------------------ scoped reset
//
// Every workload starts from a known state. The two payment tables have
// signature keys and the intents linger, so purging them is necessary if a
// prior workload created rows.
async function resetLoadUsers() {
  const tables = [
    'integrity_events', 'rate_buckets',
    'rounds', 'matches',
    'inventory', 'balances', 'ledger',
    'payment_intents', 'payments',
    'mp_rounds',
    'tos_acceptances', 'geo_verdicts',
  ];
  for (const t of tables) {
    // Some tables may not exist in this version; treat 'relation does not
    // exist' as a no-op so this harness runs across schema evolutions.
    const { error } = await admin.from(t).delete().in('user_id', ids);
    if (error && !/does not exist|Could not find|column .* does not exist/i.test(error.message)) {
      console.warn(`  reset ${t}: ${error.message}`);
    }
  }
  // mp_tables uses seat_a/seat_b uuid columns rather than a user_id column,
  // so it needs the OR filter rather than IN.
  const orFilter = ids.map((id) => `seat_a.eq.${id},seat_b.eq.${id}`).join(',');
  const { error: mpErr } = await admin.from('mp_tables').delete().or(orFilter);
  if (mpErr && !/does not exist|Could not find/i.test(mpErr.message)) {
    console.warn(`  reset mp_tables: ${mpErr.message}`);
  }
}

// Every workload needs the money-gate preconditions satisfied, or it will get
// refused for the wrong reason. Seed non-blocked geo + ToS acceptance up front.
async function primeMoneyGates() {
  for (const id of ids) {
    await admin.rpc('geo_record_verdict', {
      p_user_id: id, p_country: 'DE', p_source: 'load-harness', p_is_datacenter: false,
    });
    // PK on tos_acceptances is (user_id, version). Context is a checked-value
    // column, not part of the key.
    const { error: tosErr } = await admin.from('tos_acceptances').upsert(
      { user_id: id, version: 'v1', context: 'purchase' },
      { onConflict: 'user_id,version' },
    );
    if (tosErr) console.warn(`  prime tos ${id}: ${tosErr.message}`);
    // A balances row so buy() doesn't refuse for a missing row (only for
    // insufficient chips, which is what we're actually testing).
    await admin.from('balances').upsert({ user_id: id, xp: 0, chips: 0 });
  }
}

// -------------------------------------------------------------- reporting

const workloadResults = [];
function report(name, { latencies = [], pass, notes = {} }) {
  workloadResults.push({ name, count: latencies.length, pass, notes });
  const lat = latencies.length
    ? { p50: pctile(latencies, 50), p95: pctile(latencies, 95), p99: pctile(latencies, 99), max: Math.round(Math.max(...latencies)) }
    : { p50: 0, p95: 0, p99: 0, max: 0 };
  const flag = pass ? 'ok  ' : 'FAIL';
  console.log(`  ${flag}  ${name}  (n=${latencies.length}, p50=${lat.p50}ms, p95=${lat.p95}ms, p99=${lat.p99}ms)`);
  for (const [k, v] of Object.entries(notes)) console.log(`         ${k}: ${JSON.stringify(v)}`);
}

async function runWorkload(name, fn) {
  console.log(`\n${name}`);
  await resetLoadUsers();
  await primeMoneyGates();
  const deadline = Date.now() + PER_WORKLOAD_TIMEOUT_MS;
  const timeout = new Promise((_, rej) => {
    setTimeout(() => rej(new Error(`workload ${name} exceeded ${PER_WORKLOAD_TIMEOUT_MS}ms`)), PER_WORKLOAD_TIMEOUT_MS);
  });
  try {
    await Promise.race([fn(), timeout]);
  } catch (err) {
    console.error(`  workload ${name} threw: ${err.message}`);
    workloadResults.push({ name, pass: false, notes: { error: err.message } });
  } finally {
    if (Date.now() > deadline) console.warn(`  (past workload deadline)`);
  }
}

// ============================================================== workload 1
// Rate limit: confirm_payment must refuse excess AS 'pending', never 429.
await runWorkload('W1 — confirm_payment flood: 2× limit in parallel, must return pending on excess (never 429)', async () => {
  const u = asUser(0);
  const create = await callPlay(SUPABASE_URL, u.accessToken, { action: 'create_intent', usdc: 1 });
  if (!create.body?.intent_id) throw new Error(`create_intent failed: ${JSON.stringify(create)}`);
  // A signature that IS the right shape but will fail chain lookup — the point
  // is to exercise the rate limit path, not the chain path.
  const fakeSig = '1'.repeat(88);
  const { results } = await fanOut(120, () =>
    callPlay(SUPABASE_URL, u.accessToken, { action: 'confirm_payment', intent_id: create.body.intent_id, signature: fakeSig }),
  );
  const statuses = results.map((x) => x.r.status);
  const rl = results.filter((x) => x.r.body?.reason === 'rate_limited').length;
  const has429 = statuses.some((s) => s === 429);
  const nonRlSuccess = results.filter((x) => x.r.body?.status === 'pending' && x.r.body?.reason !== 'rate_limited').length;
  const anyCredited = results.some((x) => x.r.body?.status === 'credited');
  const pass = rl > 0 && !has429 && !anyCredited;
  report('W1 confirm_payment excess-as-pending', {
    latencies: results.map((x) => x.ms), pass,
    notes: { rate_limited_count: rl, http_429_count: statuses.filter((s) => s === 429).length, non_rl_pending: nonRlSuccess, credited: anyCredited },
  });
});

// ============================================================== workload 2
// Rate limit: open_match at 2× limit; expect ~30 succeed, rest rate_limited.
await runWorkload('W2 — open_match flood: 60 parallel calls, limit 30/min, expect enforcement', async () => {
  const u = asUser(1);
  const { results } = await fanOut(60, () =>
    callPlay(SUPABASE_URL, u.accessToken, { action: 'open_match', format: 'single' }),
  );
  const rl = results.filter((x) => x.r.body?.error === 'rate_limited').length;
  const ok = results.filter((x) => x.r.body?.match_id).length;
  const { data: matches } = await admin.from('matches').select('id').eq('user_id', u.userId);
  const dbMatches = matches?.length ?? 0;
  const pass = rl > 0 && ok > 0 && ok === dbMatches;
  report('W2 open_match rate limit + DB matches accepted', {
    latencies: results.map((x) => x.ms), pass,
    notes: { succeeded: ok, rate_limited: rl, matches_in_db: dbMatches, invariant: 'succeeded == matches_in_db' },
  });
});

// ============================================================== workload 3
// Rate limit: create_intent at 3× limit (30 fires for 10/min limit).
await runWorkload('W3 — create_intent flood: 30 parallel calls, limit 10/min, expect enforcement', async () => {
  const u = asUser(2);
  const { results } = await fanOut(30, () =>
    callPlay(SUPABASE_URL, u.accessToken, { action: 'create_intent', usdc: 1 }),
  );
  const rl = results.filter((x) => x.r.body?.error === 'rate_limited').length;
  const ok = results.filter((x) => x.r.body?.intent_id).length;
  const { data: intents } = await admin.from('payment_intents').select('id').eq('user_id', u.userId);
  const dbIntents = intents?.length ?? 0;
  const pass = rl > 0 && ok > 0 && ok === dbIntents;
  report('W3 create_intent rate limit + DB intents accepted', {
    latencies: results.map((x) => x.ms), pass,
    notes: { succeeded: ok, rate_limited: rl, intents_in_db: dbIntents, invariant: 'succeeded == intents_in_db' },
  });
});

// ============================================================== workload 4
// Race: submit — exactly one winner, rest already_submitted.
await runWorkload('W4 — submit race: idempotent outcome + no double-reward + refusal on move mismatch', async () => {
  const u = asUser(3);
  const m = await callPlay(SUPABASE_URL, u.accessToken, { action: 'open_match', format: 'single' });
  if (!m.body?.match_id) throw new Error(`open_match failed: ${JSON.stringify(m)}`);
  const r = await callPlay(SUPABASE_URL, u.accessToken, { action: 'open_round', match_id: m.body.match_id });
  if (!r.body?.round_id) throw new Error(`open_round failed: ${JSON.stringify(r)}`);
  // 20 parallel submits of the SAME move. resolve_round is idempotent by
  // design (same round_id + same player_choice → same outcome). What we
  // actually want to prove:
  //   - every response returns the same outcome (no race producing two
  //     different verdicts)
  //   - the round is resolved exactly once in the DB
  //   - the match_reward ledger row appears at most once per currency (the
  //     idem_key inside credit_ledger enforces this — this asserts it holds
  //     under 20-way concurrent claim of the winning update)
  const { results } = await fanOut(20, () =>
    callPlay(SUPABASE_URL, u.accessToken, { action: 'submit', round_id: r.body.round_id, player_choice: 'rock' }),
  );
  const outcomes = new Set(results.map((x) => x.r.body?.outcome).filter(Boolean));
  const rl = results.filter((x) => x.r.body?.error === 'rate_limited').length;
  const { data: rounds } = await admin.from('rounds').select('*').eq('match_id', m.body.match_id);
  const dbResolved = (rounds ?? []).filter((x) => x.state === 'resolved').length;
  const { data: rewards } = await admin.from('ledger').select('id,currency,delta').eq('user_id', u.userId).eq('reason', 'match_reward').eq('match_id', m.body.match_id);
  const rewardRows = rewards ?? [];
  // Cross-move refusal check: after resolution, a different-move submit MUST
  // return already_submitted AND log an integrity event.
  const mismatch = await callPlay(SUPABASE_URL, u.accessToken, { action: 'submit', round_id: r.body.round_id, player_choice: 'paper' });
  const { data: ev } = await admin.from('integrity_events').select('kind').eq('user_id', u.userId).eq('kind', 'move_changed_after_resolution');
  const pass = outcomes.size === 1 && dbResolved === 1 && rewardRows.length <= 2 && mismatch.body?.error === 'already_submitted' && (ev?.length ?? 0) >= 1;
  report('W4 submit idempotent + no-double-reward + mismatch refused', {
    latencies: results.map((x) => x.ms), pass,
    notes: {
      distinct_outcomes: [...outcomes],
      resolved_rounds_in_db: dbResolved,
      match_reward_rows: rewardRows.length,
      rate_limited: rl,
      mismatch_response: mismatch.body?.error,
      move_changed_integrity_events: ev?.length ?? 0,
    },
  });
});

// ============================================================== workload 5
// Race: mp_join — one seat, N parallel joins, only one seats.
await runWorkload('W5 — mp_join race: 5 parallel joins on 1 free seat', async () => {
  const creator = asUser(4);
  const create = await callMp(SUPABASE_URL, creator.accessToken, { action: 'mp_create', format: 'single', stake: 0 });
  const tableId = create.body?.table_id ?? create.body?.tableId;
  const code = create.body?.invite_code ?? create.body?.inviteCode;
  if (!code) {
    report('W5 mp_join race SKIPPED — could not create table', {
      pass: false, notes: { create_response: create.body },
    });
    return;
  }
  // Five other users all try to grab the one remaining seat.
  const joiners = [5, 6, 7, 8, 9].map(asUser);
  const { results } = await fanOut(joiners.length, (i) =>
    callMp(SUPABASE_URL, joiners[i].accessToken, { action: 'mp_join', code }),
  );
  const seated = results.filter((x) => x.r.status === 200 && !x.r.body?.error).length;
  const full = results.filter((x) => x.r.body?.error === 'table_full' || x.r.body?.error === 'seat_taken').length;
  // Seats live inline on mp_tables (seat_a/seat_b uuids), not a separate table.
  const { data: table } = await admin.from('mp_tables').select('seat_a,seat_b').eq('id', tableId).maybeSingle();
  const seatCount = (table?.seat_a ? 1 : 0) + (table?.seat_b ? 1 : 0);
  const pass = seated === 1 && seatCount === 2;
  report('W5 mp_join single-seat race', {
    latencies: results.map((x) => x.ms), pass,
    notes: { seated_ok: seated, table_full_refusals: full, seats_filled_in_db: seatCount, expected_seats: 2, sample_refusal: results.find((x) => x.r.body?.error)?.r.body },
  });
});

// ============================================================== workload 6
// Race: buy — exactly enough chips for one theme, N parallel buys.
await runWorkload('W6 — buy race: 5 parallel buys with exact-affording balance', async () => {
  const u = asUser(1);
  // Seed exactly one theme's worth of chips (THEME_PRICE = 60). buy() is
  // idempotent per-sku (returns {already_owned: true} on duplicate), so the
  // invariant to test is NOT "one HTTP 200"; it is "exactly ONE debit lands"
  // — enforced by the ledger's idem_key uniqueness. Reason is `theme_unlock`
  // in the current migration.
  await admin.from('ledger').insert({
    user_id: u.userId, currency: 'chips', delta: 60, reason: 'test_grant',
    balance_after: 60, idem_key: `load-w6-${Date.now()}`,
  });
  await admin.from('balances').upsert({ user_id: u.userId, xp: 0, chips: 60 });
  const { results } = await fanOut(5, () =>
    callPlay(SUPABASE_URL, u.accessToken, { action: 'buy', sku: 'frost' }),
  );
  const ok200 = results.filter((x) => x.r.status === 200 && !x.r.body?.error).length;
  const insuff = results.filter((x) => x.r.body?.error === 'insufficient_chips').length;
  const rl = results.filter((x) => x.r.body?.error === 'rate_limited').length;
  const { data: inv } = await admin.from('inventory').select('*').eq('user_id', u.userId).eq('sku', 'frost');
  const { data: bal } = await admin.from('balances').select('chips').eq('user_id', u.userId).maybeSingle();
  const debits = await admin.from('ledger').select('delta,reason,idem_key').eq('user_id', u.userId).eq('reason', 'theme_unlock');
  const nDebits = (debits.data ?? []).length;
  // Exactly one debit and one inventory row proves the race is safe. Multiple
  // HTTP 200s are fine — they are idempotent already_owned responses.
  const pass = nDebits === 1 && (inv?.length ?? 0) === 1 && (bal?.chips ?? -1) === 0;
  report('W6 buy last-chip race — one debit only', {
    latencies: results.map((x) => x.ms), pass,
    notes: { http_200s: ok200, insufficient_chips: insuff, rate_limited: rl, inventory_rows: inv?.length, ledger_debits_theme_unlock: nDebits, remaining_chips: bal?.chips },
  });
});

// ============================================================== workload 7
// Invariant: chip conservation under mixed load.
// Every user plays 6 matches back-to-back (open_match, open_round, submit x
// three, resolve). Chips per user must equal ledger sum per user at the end.
await runWorkload('W7 — chip conservation under mixed concurrent load', async () => {
  const runPerUser = async (i) => {
    const u = asUser(i);
    const latencies = [];
    for (let m = 0; m < 3; m += 1) {
      const t0 = performance.now();
      const match = await callPlay(SUPABASE_URL, u.accessToken, { action: 'open_match', format: 'single' });
      latencies.push(performance.now() - t0);
      accountFor(1);
      if (match.body?.error) continue; // rate_limited or other — no chips move
      const round = await callPlay(SUPABASE_URL, u.accessToken, { action: 'open_round', match_id: match.body.match_id });
      accountFor(1);
      if (round.body?.error) continue;
      const t2 = performance.now();
      await callPlay(SUPABASE_URL, u.accessToken, { action: 'submit', round_id: round.body.round_id, player_choice: 'rock' });
      latencies.push(performance.now() - t2);
      accountFor(1);
    }
    return latencies;
  };
  const perUser = await Promise.all(Array.from({ length: N_USERS }, (_, i) => runPerUser(i)));
  const latencies = perUser.flat();

  // Read back: sum(ledger.delta for chips) per user should equal balances.chips.
  const rows = await Promise.all(ids.map(async (id) => {
    const { data: bal } = await admin.from('balances').select('chips').eq('user_id', id).maybeSingle();
    const { data: led } = await admin.from('ledger').select('delta').eq('user_id', id).eq('currency', 'chips');
    const ledSum = (led ?? []).reduce((n, r) => n + Number(r.delta), 0);
    return { id, balance: Number(bal?.chips ?? 0), ledger: ledSum, ok: Number(bal?.chips ?? 0) === ledSum };
  }));
  const bad = rows.filter((r) => !r.ok);
  report('W7 chip conservation', {
    latencies, pass: bad.length === 0,
    notes: { users: rows.length, matches_conserved: rows.length - bad.length, drift_rows: bad.slice(0, 3) },
  });
});

// ============================================================== workload 8
// Invariant: no double-credit for a real credited signature.
// This requires a REAL confirmed on-chain payment. Rather than spend USDC
// here, we look for a previously-credited payment in this project (from the
// devnet:e2e suite) and replay its signature 50× in parallel. The primary
// key on payments.signature is what enforces the invariant; this proves it
// under concurrent replay, not just serial.
await runWorkload('W8 — no double-credit: 50 parallel confirm_payment on 1 signed intent', async () => {
  const { data: existingPayment } = await admin
    .from('payments')
    .select('signature, user_id, intent_id')
    .order('observed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!existingPayment) {
    report('W8 no-double-credit SKIPPED — no credited payment in DB (run devnet:e2e first)', {
      pass: false, notes: { hint: 'run devnet:e2e to produce one, then rerun this workload' },
    });
    return;
  }
  const { signature, user_id, intent_id } = existingPayment;
  // Sign in as the intent's OWNER. Usually the payment-suite user1 keypair
  // in .devnet/user1.json (produced by `npm run devnet:setup`). Load it if we
  // don't already have a session for that id.
  let targetSession = sessions.find((s) => s.userId === user_id);
  if (!targetSession) {
    try {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const here = dirname(fileURLToPath(import.meta.url));
      const root = join(here, '..', '..');
      for (const name of ['user1', 'user2']) {
        const keyPath = join(root, '.devnet', `${name}.json`);
        try {
          const raw = readFileSync(keyPath, 'utf8');
          const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
          const s = await signInWithKeypair(SUPABASE_URL, ANON_KEY, kp, name);
          if (s.userId === user_id) { targetSession = s; break; }
        } catch { /* keypair not present */ }
      }
    } catch { /* fs import fell through */ }
  }
  if (!targetSession) {
    report('W8 no-double-credit SKIPPED — could not sign in as the intent owner (payment-suite keys not present)', {
      pass: false, notes: { intent_owner_id: user_id, hint: 'run `npm run devnet:setup` then `npm run devnet:e2e` to populate .devnet/ with user1/user2 keypairs' },
    });
    return;
  }
  const before = await admin.from('payments').select('signature').eq('signature', signature);
  const { results } = await fanOut(50, () =>
    callPlay(SUPABASE_URL, targetSession.accessToken, { action: 'confirm_payment', intent_id, signature }),
  );
  const after = await admin.from('payments').select('signature').eq('signature', signature);
  const ledgerRows = await admin.from('ledger').select('id').eq('user_id', user_id).eq('reason', 'chip_purchase');
  const credited = results.filter((x) => x.r.body?.status === 'credited').length;
  const pending = results.filter((x) => x.r.body?.status === 'pending').length;
  const pass = (after.data?.length ?? 0) === 1 && (before.data?.length ?? 0) === 1 && (ledgerRows.data?.length ?? 0) >= 1;
  report('W8 no double-credit under 50-way replay', {
    latencies: results.map((x) => x.ms), pass,
    notes: {
      credited_before: before.data?.length,
      credited_after: after.data?.length,
      responses_credited: credited,
      responses_pending: pending,
      ledger_purchase_rows: ledgerRows.data?.length,
    },
  });
});

// ------------------------------------------------------------ final report

console.log('\n=================================================================');
console.log('load-abuse — summary');
const failed = workloadResults.filter((w) => !w.pass).length;
console.log(`  ${workloadResults.length - failed}/${workloadResults.length} passed`);
console.log(`  total requests fired: ${requestsFired}`);
for (const w of workloadResults) {
  console.log(`    ${w.pass ? 'ok  ' : 'FAIL'}  ${w.name}`);
  if (!w.pass) console.log(`           ${JSON.stringify(w.notes)}`);
}

// Final cleanup — even if some workloads failed, don't leave rows behind.
await resetLoadUsers();
console.log('  cleaned up test rows for the load users');

process.exit(failed === 0 ? 0 : 1);
