/**
 * The end-to-end payment suite.
 *
 *   npm run devnet:e2e
 *
 * Every case signs and sends its own transaction. Nobody approves anything in a
 * wallet, and the failure branches — the ones that matter most and are the most
 * tedious to produce by hand — are just more rows in the table.
 *
 * Two properties this suite exists to hold:
 *
 *   A transaction credits exactly once. Enforced by `payments.signature` being a
 *   primary key, so the replay case is checking a constraint rather than a code
 *   path that someone could later reorder.
 *
 *   A transaction credits the RIGHT person. Enforced by the intent's reference
 *   appearing in the transaction's account keys. This is the one the schema
 *   alone does not give you: without it, whoever reports an incoming transfer
 *   first takes it, and the primary key happily allows that — once.
 *
 * Assertions are recorded rather than thrown, so a failure in the middle does
 * not hide the eight cases after it.
 */
import { createClient } from '@supabase/supabase-js';
import { assertDevnet, loadKeypair, readState, writeReport, formatUnits, parseUnits, sleep } from './chain.mjs';
import { signInWithKeypair, callPlay } from '../harness/auth.mjs';
import { sendUsdc, tokenBalance } from './pay.mjs';
import { SUPABASE_URL, ANON_KEY, SERVICE_ROLE_KEY, RPC_URL, requireServiceRole } from '../harness/env.mjs';

requireServiceRole();

const state = readState();
if (!state.mint || !state.user1) {
  console.error('\n  No .devnet/state.json — run `npm run devnet:setup` first.\n');
  process.exit(1);
}

const { connection } = await assertDevnet(state.rpc_url ?? RPC_URL);
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const payer = loadKeypair('payer');
const decoy = loadKeypair('decoy');
const D = state.decimals;
const RATE = state.chips_per_usdc;

// ----------------------------------------------------------------- results

const results = [];
let failures = 0;

function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  if (!pass) failures += 1;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!pass) console.log(`        ${JSON.stringify(detail)}`);
}

const chipsFor = (usdc) => Math.floor(Number(usdc) * RATE);

// ------------------------------------------------------------------- reset
//
// This used to be bare table deletes, and one of them destroyed a settled
// stake match's ledger rows (the 0dca3e39 incident, 2026-08-12): "everything
// this user ever did" included half of an OPPONENT's financial history. The
// database now refuses bare deletes on money tables outright, and this goes
// through harness_reset_user() — the one sanctioned door. It refuses any user
// not marked is_harness, and any user whose history is entangled with another
// player's (stake rows, multiplayer seats). Its deletes are audited.
//
// When it refuses, the answer is a NEW identity, never a forced wipe: delete
// .devnet/keys/<name>.json and the next run generates a fresh keypair. The old
// account's books stay whole — that is the entire point.

const ids = [state.user1.id, state.user2.id];
await admin.from('profiles').update({ is_harness: true }).in('id', ids).throwOnError();
for (const [name, id] of [['user1', state.user1.id], ['user2', state.user2.id]]) {
  const { error } = await admin.rpc('harness_reset_user', { p_user_id: id });
  if (error) {
    console.error(`\n  harness_reset_user(${name}) refused: ${error.message}`);
    console.error(`  This account's history is entangled with another player's and will not be`);
    console.error(`  wiped. Rotate the identity instead: rm .devnet/keys/${name}.json && re-run.\n`);
    process.exit(1);
  }
}
console.log('\n  reset the two harness users\n');

// ------------------------------------------------------------------- users

const u1 = await signInWithKeypair(SUPABASE_URL, ANON_KEY, loadKeypair('user1'), 'user1');
const u2 = await signInWithKeypair(SUPABASE_URL, ANON_KEY, loadKeypair('user2'), 'user2');
const play1 = (body) => callPlay(SUPABASE_URL, u1.accessToken, body);
const play2 = (body) => callPlay(SUPABASE_URL, u2.accessToken, body);

// The reset above deletes balances rows, and a user who never earns and never
// pays would not get one back — which is exactly what happened to user2 and
// showed up in QA as "3 profiles, 2 balances", reading like a provisioning bug.
// It was not: balances are seeded lazily, by economy_state and credit_ledger,
// and never by ensure_profile. Calling it here is what a real player's first
// page load does, so the harness stops leaving a shape that invites the wrong
// diagnosis.
await play1({ action: 'economy_state' });
await play2({ action: 'economy_state' });

const treasuryBefore = await tokenBalance(connection, state.mint, state.treasury);

// Money gate needs a resolved, non-blocked geo verdict on file. The real
// client calls `geo`, which resolves the caller's public IP via ipwho.is and
// persists — but the machine running this harness is in a jurisdiction the
// pre-launch blocklist covers, so calling `geo` here would leave a verdict
// that `geo_allows_money` correctly refuses. Seed with an allowed country via
// service role instead: the suite is testing PAYMENT, not the geo gate.
for (const id of ids) {
  await admin.rpc('geo_record_verdict', {
    p_user_id: id,
    p_country: 'DE',
    p_source: 'harness',
    p_is_datacenter: false,
  }).throwOnError();
}

// --------------------------------------------------------------------- ToS

{
  const before = await play1({ action: 'create_intent', usdc: 1 });
  check('an intent is refused before the terms are accepted', before.body?.error === 'tos_required', before);
}

await play1({ action: 'accept_tos', version: 'v1' });
await play2({ action: 'accept_tos', version: 'v1' });

/** Creates an intent and fails loudly if the server refused. */
async function intent(play, usdc, label) {
  const res = await play({ action: 'create_intent', usdc });
  if (!res.body?.intent_id) throw new Error(`create_intent(${label}) refused: ${JSON.stringify(res)}`);
  return res.body;
}

// --------------------------------------------------------- A: the happy path

const A = await intent(play1, 1, 'A');
const sigA = await sendUsdc(connection, {
  payer,
  mint: state.mint,
  toOwner: state.treasury,
  amountRaw: parseUnits('1', D),
  decimals: D,
  reference: A.reference,
  confirm: false,
});

// Reported before the chain has settled it. "Not visible yet" must mean keep
// waiting — telling a player their payment failed when it is merely young is
// the worst answer available, because the money is already gone.
const early = await play1({ action: 'confirm_payment', intent_id: A.intent_id, signature: sigA });
check(
  'a signature reported before confirmation is pending, not rejected',
  early.body?.status === 'pending' || early.body?.status === 'credited',
  { observed: early, note: early.body?.status === 'credited' ? 'confirmed faster than we could ask' : undefined },
);

await connection.confirmTransaction(sigA, 'confirmed');
const creditedA = await play1({ action: 'confirm_payment', intent_id: A.intent_id, signature: sigA });
// A fast RPC may confirm the tx before the early call returned "pending", in
// which case the early call itself did the crediting and this second call
// returns already_credited. Both paths prove "1 USDC gets 100 chips" — accept
// either one, then require that 100 chips were credited by one of them.
check(
  '1.000000 credits 100 chips',
  creditedA.body?.chips_credited === chipsFor(1) ||
    (creditedA.body?.already_credited === true && early.body?.chips_credited === chipsFor(1)),
  { creditedA: creditedA.body, early: early.body },
);

// --------------------------------------------------------------- A: replays

for (let i = 1; i <= 3; i += 1) {
  const again = await play1({ action: 'confirm_payment', intent_id: A.intent_id, signature: sigA });
  check(`replay ${i} credits nothing`, again.body?.already_credited === true, again.body);
}

// ------------------------------------------------------- A: the theft cases

const A2 = await intent(play2, 1, 'A2');
const theft = await play2({ action: 'confirm_payment', intent_id: A2.intent_id, signature: sigA });
check(
  "another player cannot claim someone else's payment",
  theft.status === 409 && theft.body?.message === 'reference_absent',
  theft,
);

const cross = await play2({ action: 'confirm_payment', intent_id: A.intent_id, signature: sigA });
check('an intent belonging to someone else is not found', cross.status === 404, cross);

// ------------------------------------------------- amount comes from the chain

/** Pays an intent and confirms it, returning the server's answer. */
async function payAndConfirm(usdc, { toOwner = state.treasury, reference = true, label } = {}) {
  const it = await intent(play1, 1, label);
  const sig = await sendUsdc(connection, {
    payer,
    mint: state.mint,
    toOwner,
    amountRaw: parseUnits(usdc, D),
    decimals: D,
    reference: reference ? it.reference : null,
  });
  const res = await play1({ action: 'confirm_payment', intent_id: it.intent_id, signature: sig });
  return { intent: it, signature: sig, res };
}

const under = await payAndConfirm('0.5', { label: 'underpay' });
check('underpaying a $1 quote credits 50 — rate, not SKU', under.res.body?.chips_credited === chipsFor(0.5), under.res.body);

const over = await payAndConfirm('1.5', { label: 'overpay' });
check('overpaying a $1 quote credits 150 at the same rate', over.res.body?.chips_credited === chipsFor(1.5), over.res.body);

const dust = await payAndConfirm('0.005', { label: 'dust' });
check(
  'dust below one chip credits nothing and is flagged, not eaten',
  dust.res.body?.chips_credited === 0 && dust.res.body?.note === 'below_one_chip',
  dust.res.body,
);

// ------------------------------------------------------------- wrong recipient

const wrong = await payAndConfirm('0.1', { toOwner: decoy.publicKey.toBase58(), label: 'wrong-recipient' });
check(
  'a transfer to another wallet credits nothing even carrying our reference',
  wrong.res.status === 409 && wrong.res.body?.message === 'no_treasury_balance_for_mint',
  wrong.res,
);

// ---------------------------------------------------------------- no reference

const bare = await payAndConfirm('0.2', { reference: false, label: 'no-reference' });
check(
  'a transfer with no reference is refused',
  bare.res.status === 409 && bare.res.body?.message === 'reference_absent',
  bare.res,
);

// ------------------------------------------- B: the payment nobody reported
//
// The player who pays and closes the tab. The signature is never sent to us, so
// the only way this becomes chips is by scanning the reference on chain.

const B = await intent(play1, 0.37, 'B');
const sigB = await sendUsdc(connection, {
  payer,
  mint: state.mint,
  toOwner: state.treasury,
  amountRaw: parseUnits('0.37', D),
  decimals: D,
  reference: B.reference,
});

// Signature indexing lags confirmation. On a slow RPC (Helius devnet under
// load) it can take 20s+, so poll until it lands or we give up.
let rec;
let found;
const started = Date.now();
while (Date.now() - started < 30_000) {
  await sleep(2500);
  rec = await play1({ action: 'reconcile' });
  found = (rec.body?.credited ?? []).find((c) => c.intent_id === B.intent_id);
  if (found) break;
}
check(
  'reconciliation finds a payment the client never reported',
  found?.result?.chips_credited === chipsFor(0.37),
  { reconcile: rec?.body, sigB, waited_ms: Date.now() - started },
);

// ------------------------------------------------------------------ totals

const expectedChips = chipsFor(1) + chipsFor(0.5) + chipsFor(1.5) + chipsFor(0.37);
const { data: bal } = await admin.from('balances').select('*').in('user_id', ids);
const u1Chips = bal?.find((b) => b.user_id === u1.userId)?.chips ?? 0;
const u2Chips = bal?.find((b) => b.user_id === u2.userId)?.chips ?? 0;

check(`player 1 holds exactly ${expectedChips} chips`, Number(u1Chips) === expectedChips, { u1Chips, expectedChips });
check('player 2, who paid nothing, holds nothing', Number(u2Chips) === 0, { u2Chips });

const { data: ledger } = await admin.from('ledger').select('user_id, currency, delta').in('user_id', ids);
const ledgerChips = (ledger ?? [])
  .filter((r) => r.user_id === u1.userId && r.currency === 'chips')
  .reduce((sum, r) => sum + Number(r.delta), 0);
check('the ledger sums to the balance', ledgerChips === Number(u1Chips), { ledgerChips, u1Chips });

// Receipt proven by the treasury's own balance, not by our belief about it.
// 0.1 went to the decoy and is correctly absent; 0.2 arrived with no reference
// and is correctly uncredited but DID land — which is the honest reason this
// figure is larger than the chips issued.
const treasuryAfter = await tokenBalance(connection, state.mint, state.treasury);
const delta = treasuryAfter - treasuryBefore;
const expectedDelta = parseUnits('3.575', D);
check('the treasury received exactly what was sent to it', delta === expectedDelta, {
  delta: formatUnits(delta, D),
  expected: formatUnits(expectedDelta, D),
});

const { data: flagged } = await admin.rpc('flagged_payments');

writeReport({
  ran_at: new Date().toISOString(),
  cluster: 'devnet',
  mint: state.mint,
  treasury: state.treasury,
  users: { user1: u1.userId, user2: u2.userId },
  signatures: { A: sigA, B: sigB, underpay: under.signature, overpay: over.signature, dust: dust.signature, wrong_recipient: wrong.signature, no_reference: bare.signature },
  treasury_delta: formatUnits(delta, D),
  chips: { user1: Number(u1Chips), user2: Number(u2Chips) },
  flagged,
  results,
  failures,
});

console.log(`\n  ${results.length - failures}/${results.length} passed`);
console.log(`  report written to .devnet/report.json`);
console.log(
  `\n  note: the 0.2 sent without a reference is in the treasury and uncreditable by design —\n` +
    `  a transfer that names no intent cannot be attributed to anyone.\n`,
);
process.exit(failures === 0 ? 0 : 1);
