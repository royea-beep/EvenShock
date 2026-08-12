/**
 * Owner money-anomaly digest — one-shot report, or an alert exit code.
 *
 *   npm run monitor:digest         one-shot report to stdout
 *   npm run monitor:digest -- --alert  exit 1 if any critical threshold trips
 *
 * WHAT THIS IS. A human-readable snapshot of every money-surface signal worth
 * watching: chip conservation, no-double-credit, unexplained credits,
 * integrity events by kind, payment status, geo refusals, rate-limit trips,
 * stuck intents. The underlying tables are always the source of truth;
 * `owner_money_digest` in Postgres is where the actual aggregation lives.
 *
 * WHY A CLI. Two reasons: (1) inspecting production without a browser or a
 * dashboard, and (2) piping into cron for the "reachable when something
 * breaks" story. In --alert mode the exit code is what a cron acts on, and
 * the STDERR emits a one-line summary suitable for feeding a webhook.
 *
 * AUTH. Uses SERVICE_ROLE to call the RPC directly, so this script does not
 * need a signed-in owner session. The same digest is also reachable through
 * the play edge function as `action: 'owner_digest'` — that path uses the
 * caller's JWT and the `is_owner` gate baked into the RPC.
 */
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE_KEY, requirePublic } from './env.mjs';

requirePublic();
if (!SERVICE_ROLE_KEY) {
  console.error('\n  SUPABASE_SERVICE_ROLE_KEY required. Set it in .env.local.\n');
  process.exit(1);
}

const alertMode = process.argv.includes('--alert');
const jsonMode = process.argv.includes('--json');

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// The RPC requires an owner user_id to gate the read. Service role can pass
// any owner id — pick the first one it finds.
const { data: owner } = await admin
  .from('profiles')
  .select('id, wallet_address')
  .eq('is_owner', true)
  .limit(1)
  .maybeSingle();

if (!owner) {
  console.error('  no owner in profiles.is_owner — cannot call owner_money_digest');
  process.exit(1);
}

const { data: digest, error } = await admin.rpc('owner_money_digest', { p_user_id: owner.id });
if (error) {
  console.error(`  rpc error: ${error.message}`);
  process.exit(1);
}
if (digest?.error) {
  console.error(`  digest refused: ${digest.error}`);
  process.exit(1);
}

if (jsonMode) {
  process.stdout.write(JSON.stringify(digest, null, 2) + '\n');
  process.exit(0);
}

// -------------------------------------------------------------------- render

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const okMark = (ok) => (ok ? `${GREEN}ok  ${RESET}` : `${RED}FAIL${RESET}`);
const badge = (level, text) => {
  const c = level === 'red' ? RED : level === 'yellow' ? YELLOW : GREEN;
  return `${c}${text}${RESET}`;
};

// Thresholds. See docs/monitoring-thresholds.md for the reasoning and how to
// tune. Anything red trips --alert mode; yellow is informational.
const T = {
  conservation_drift_red: 0,           // any drift is red
  double_credit_red: 0,                // any discrepancy is red
  unexplained_credits_red: 0,          // any is red
  house_negative_red: true,            // negative house is red
  payments_failed_24h_yellow: 5,       // review
  payments_failed_24h_red: 20,         // alert
  stuck_intents_over_1h_yellow: 3,
  stuck_intents_over_1h_red: 20,
  move_changed_24h_red: 1,             // any cheating attempt is red
  geo_refused_24h_yellow: 10,          // one blocked region cluster
  geo_refused_24h_red: 200,            // spike, worth looking at
};

const alerts = [];
const warnings = [];

function alert(msg) { alerts.push(msg); }
function warn(msg)  { warnings.push(msg); }

console.log(`\nowner-money-digest — ${digest.as_of}\n`);

// Conservation
{
  const c = digest.conservation;
  const line = `${okMark(c.ok)}  conservation: balances=${c.balances_sum} ledger=${c.ledger_sum} drift=${c.drift}`;
  console.log(line);
  if (c.drift !== T.conservation_drift_red) alert(`CHIP CONSERVATION DRIFT ${c.drift}`);
}

// House
{
  const h = digest.house;
  const line = `${okMark(h.ok)}  house_ledger: sum=${h.sum}`;
  console.log(line);
  if (T.house_negative_red && h.sum < 0) alert(`HOUSE LEDGER NEGATIVE (${h.sum})`);
}

// Double-credit
{
  const d = digest.double_credit;
  console.log(`${okMark(d.ok)}  double_credit: payments=${d.payment_rows} distinct_sigs=${d.distinct_sigs}`);
  if (d.payment_rows !== d.distinct_sigs) alert(`DOUBLE-CREDIT: ${d.payment_rows - d.distinct_sigs} extra payment rows`);
}

// Unexplained credits
{
  const u = digest.unexplained_credits;
  console.log(`${okMark(u.ok)}  unexplained_credited_payments: ${u.count}`);
  if (u.count > T.unexplained_credits_red) alert(`UNEXPLAINED CREDIT: ${u.count} payments without matching ledger row`);
}

// Payments
{
  const p = digest.payments;
  const line = `      payments_24h: credited=${p.credited_24h} pending=${p.pending_24h} abandoned=${p.abandoned_24h} usdc=${p.usdc_credited_24h}  (7d credited=${p.credited_7d})`;
  console.log(line);
  const failed = Number(p.abandoned_24h ?? 0);
  if (failed >= T.payments_failed_24h_red) alert(`PAYMENTS ABANDONED 24H = ${failed}`);
  else if (failed >= T.payments_failed_24h_yellow) warn(`payments abandoned 24h = ${failed}`);
}

// Stuck
{
  const s = digest.stuck;
  console.log(`      stuck: pending_intents_over_1h=${s.pending_intents_over_1h} matches_in_progress_over_2h=${s.matches_in_progress_over_2h}`);
  const stuck = Number(s.pending_intents_over_1h ?? 0);
  if (stuck >= T.stuck_intents_over_1h_red) alert(`STUCK PENDING INTENTS = ${stuck}`);
  else if (stuck >= T.stuck_intents_over_1h_yellow) warn(`stuck pending intents = ${stuck}`);
}

// Integrity events
{
  const ev = digest.integrity_events ?? {};
  const kinds = Object.keys(ev);
  if (kinds.length === 0) {
    console.log('      integrity_events: (none)');
  } else {
    console.log('      integrity_events:');
    for (const k of kinds) {
      const c = ev[k];
      const marker = k === 'move_changed_after_resolution' && c['24h'] >= T.move_changed_24h_red
        ? badge('red', ' CHEATING ')
        : '';
      console.log(`         ${DIM}${k.padEnd(36)}${RESET}  24h=${String(c['24h']).padStart(4)}  7d=${String(c['7d']).padStart(4)}  all=${String(c.all).padStart(4)}  ${marker}`);
      if (k === 'move_changed_after_resolution' && c['24h'] >= T.move_changed_24h_red) {
        alert(`MOVE_CHANGED_AFTER_RESOLUTION x${c['24h']} in 24h`);
      }
    }
  }
}

// Geo
{
  const geo = digest.geo_refusals ?? {};
  const reasons = Object.keys(geo);
  if (reasons.length === 0) {
    console.log('      geo_refusals: (none)');
  } else {
    console.log('      geo_refusals:');
    let total24 = 0;
    for (const r of reasons) {
      const c = geo[r];
      total24 += Number(c['24h'] ?? 0);
      console.log(`         ${DIM}${r.padEnd(36)}${RESET}  24h=${String(c['24h']).padStart(4)}  7d=${String(c['7d']).padStart(4)}`);
    }
    if (total24 >= T.geo_refused_24h_red) alert(`GEO REFUSALS 24H = ${total24}`);
    else if (total24 >= T.geo_refused_24h_yellow) warn(`geo refusals 24h = ${total24}`);
  }
}

// Rate limits by action
{
  const rl = digest.rate_limits_by_action ?? {};
  const actions = Object.keys(rl);
  if (actions.length === 0) {
    console.log('      rate_limits_by_action: (none)');
  } else {
    console.log('      rate_limits_by_action:');
    for (const a of actions) {
      const c = rl[a];
      console.log(`         ${DIM}${a.padEnd(36)}${RESET}  24h=${String(c['24h']).padStart(4)}  7d=${String(c['7d']).padStart(4)}`);
    }
  }
}

console.log('');

if (warnings.length > 0) {
  console.log(`${YELLOW}warnings:${RESET}`);
  for (const w of warnings) console.log(`  ${YELLOW}!${RESET} ${w}`);
}
if (alerts.length > 0) {
  console.log(`${RED}alerts:${RESET}`);
  for (const a of alerts) console.log(`  ${RED}✖${RESET} ${a}`);
  console.error(`ALERT ${new Date(digest.as_of).toISOString()} ${alerts.join(' | ')}`);
  process.exit(alertMode ? 1 : 0);
}
if (warnings.length === 0 && alerts.length === 0) {
  console.log(`${GREEN}all clear${RESET}`);
}
process.exit(0);
