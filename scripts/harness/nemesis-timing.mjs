/**
 * The round-open timing channel, measured.
 *
 *   npm run e2e:nemesis-timing
 *
 * Sample size and bucket count are overridable, cross-shell:
 *   npx cross-env EVENSHOCK_LIVE=1 ROUNDS=400 node scripts/harness/nemesis-timing.mjs
 *
 * WHY THIS EXISTS. Nemesis picks its move at round OPEN, which is new server
 * work on the request that happens BEFORE the player throws. If that work took
 * measurably longer on the rounds where it decided to read the player, then
 * round-open latency would announce "it is reading you this round" — and a
 * player who can hear that simply deviates. That is worth strictly more to them
 * than knowing the move, because knowing the move only wins one round while
 * knowing the mode wins every round they choose to spend it on.
 *
 * The mitigation is in `openRound`: the blind move is drawn, the coin is
 * flipped and the prediction is computed on EVERY round, before anything looks
 * at which branch will be used. This script is the check that the mitigation
 * actually holds in the deployed function rather than only in the source.
 *
 * DOES THE PACING CONTAMINATE THE MEASUREMENT? No — and the direction of the
 * risk is worth being precise about, because it is the good direction.
 *
 * The test asks whether latency L carries information about the branch E. The
 * pacing inserts a delay D before each request. D is a function of the clock
 * and of previous requests; it CANNOT depend on E, because E is decided by a
 * CSPRNG coin inside the Edge Function after the request arrives, and the
 * client is never told E — `nemesis_rounds` has no client grants, which is why
 * this script has to read ground truth as an operator at the end. So D ⊥ E,
 * and noise independent of E cannot create dependence between L and E. Pacing
 * can only DILUTE a real signal, never manufacture one. False negatives are
 * possible here; false positives are not.
 *
 * Two ways it could have contaminated, both closed deliberately:
 *
 *   RETRIES. A request that was 429'd and retried has a latency dominated by
 *   the backoff. Those samples are discarded rather than kept — not because
 *   they would fake a correlation, but because a few multi-second outliers
 *   would swallow entire equal-frequency buckets and destroy the resolution.
 *
 *   CONNECTION REUSE. At ~1s spacing the socket stays inside undici's
 *   keep-alive idle timeout, so every sample reuses one connection, exactly as
 *   the back-to-back version did. Had the interval been long enough to close
 *   sockets, every sample would pay a fresh handshake — still uniform across
 *   both branches, just noisier.
 *
 * WHAT THE RESULT IS WORTH, which is a separate question from whether it is
 * valid. This reports the minimum detectable effect alongside MI and p,
 * because "p = 0.4" on its own says nothing: a null with a 25ms MDE has ruled
 * out a large leak and said nothing about a small one. The leak being guarded
 * against — skipping the `nemesis_open` round trip — is one same-region
 * Postgres query, plausibly 3-15ms, so read the MDE before believing a PASS.
 *
 * METHOD, deliberately the same as scripts/leak-independence.mjs so the two
 * numbers are comparable: bucket each round-open latency, compute the mutual
 * information between the latency bucket and whether that round was exploited,
 * then run a permutation test. Under the null (latency independent of branch)
 * the observed MI sits inside the permuted distribution and p is unremarkable.
 *
 * WHY IT NEEDS THE SERVICE ROLE. Whether a round was read is deliberately not
 * client-readable — `nemesis_rounds` has no grants at all, precisely because
 * knowing it mid-match is the advantage this script is testing for. The
 * measurement therefore has to be taken from outside the game: the harness
 * times the calls as a player, then reads the ground truth as an operator.
 */
import { createClient } from '@supabase/supabase-js';
import { Keypair } from '@solana/web3.js';
import { signInWithKeypair } from './auth.mjs';
import { ANON_KEY, SERVICE_ROLE_KEY, SUPABASE_URL, requireServiceRole } from './env.mjs';
import { SEED_ROUNDS } from './wallets.mjs';

if (process.env.EVENSHOCK_LIVE !== '1') {
  console.error('\n  refusing to run: this plays real rounds against the live project. Set EVENSHOCK_LIVE=1.\n');
  process.exit(1);
}
/** Enough rounds that a real effect would show; few enough to stay polite. */
const ROUNDS = Number(process.env.ROUNDS ?? 240);
/** Latency buckets. Coarse on purpose — over-fine bins manufacture MI from noise. */
const BUCKETS = Number(process.env.BUCKETS ?? 4);

// ---------------------------------------------------------------- pacing
//
// THE LIMIT IS CORRECT AND IS NOT BEING RELAXED FOR A MEASUREMENT. The first
// run fired 240 rounds back to back and was refused by our own guard, which is
// the guard doing its job — a harness that needs the ceiling lifted to run is
// a harness measuring a system nobody else is playing.
//
// From take_rate_token, which is the source of truth (limits live in the
// function body, not a config table, so these are copied — if a 429 arrives
// despite pacing, the numbers below have drifted and the script says so):
//
//   open_round   60/minute   600/hour
//   submit       60/minute   600/hour
//   open_match   30/minute   200/hour
//
// A round spends one open_round and one submit, in separate buckets, so the
// per-minute ceiling is 60 rounds/minute. The buckets are FIXED windows
// (date_trunc('minute')), not sliding, so pacing slightly over one second
// leaves at most 58 in any calendar minute whatever the alignment.
const OPEN_ROUND_PER_MINUTE = 60;
const OPEN_ROUND_PER_HOUR = 600;
const MIN_INTERVAL_MS = Math.ceil(60_000 / (OPEN_ROUND_PER_MINUTE - 2));

// The HOUR cap is what actually bounds this measurement, and it bounds it
// harder than the minute cap: 600 open_round calls per hour is the ceiling on
// sample size per run, whatever the pacing. Refuse rather than march into a
// wall of 429s two thirds of the way through a five-minute run.
const HOUR_BUDGET = OPEN_ROUND_PER_HOUR - 50; // headroom for retries and match opens
if (ROUNDS > HOUR_BUDGET) {
  console.error(
    `\n  refusing to run ${ROUNDS} rounds: open_round is capped at ${OPEN_ROUND_PER_HOUR}/hour,\n` +
    `  so a single run cannot exceed about ${HOUR_BUDGET} samples. Split across hours\n` +
    `  and pool the results, or lower ROUNDS.\n`,
  );
  process.exit(1);
}


// Credentials are only worth asking for once the request itself is possible.
requireServiceRole();

/**
 * Rounds discarded before the first sample is kept.
 *
 * The first request of a run pays a cold Edge Function instance (~1.2s) and a
 * fresh TLS handshake. Keeping those would put a handful of enormous values in
 * whichever bucket they landed in, for a reason that has nothing to do with
 * the branch being tested.
 */
const WARMUP = Number(process.env.WARMUP ?? 5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHOICES = ['rock', 'paper', 'scissors'];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const player = await signInWithKeypair(SUPABASE_URL, ANON_KEY, Keypair.fromSeed(SEED_ROUNDS), 'nemesis-timing');

async function callPlay(body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/play`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${player.accessToken}`,
      'Content-Type': 'application/json',
      apikey: ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const estMinutes = ((ROUNDS * MIN_INTERVAL_MS) / 60_000).toFixed(1);
console.log(`nemesis-timing — ${ROUNDS} rounds against Nemesis, timing every open_round`);
console.log(`  paced at ${MIN_INTERVAL_MS}ms between round opens to stay under ${OPEN_ROUND_PER_MINUTE}/min`);
console.log(`  discarding the first ${WARMUP} rounds as warm-up`);
console.log(`  expect roughly ${estMinutes} minutes\n`);

const samples = [];
let matchId = null;
let roundsThisMatch = 0;
let rateLimited = 0;
let excluded = 0;
// Waiting out a MINUTE window works; waiting out an exhausted HOUR budget does
// not, and `i -= 1` would retry forever. Bail with the real reason instead.
let consecutiveLimited = 0;
const MAX_CONSECUTIVE_LIMITED = 3;

function noteRateLimit(where) {
  rateLimited += 1;
  consecutiveLimited += 1;
  if (consecutiveLimited > MAX_CONSECUTIVE_LIMITED) {
    console.error(
      `\n  giving up: ${where} has been rate limited ${consecutiveLimited} windows in a row.\n` +
      `  That is the HOURLY cap (${OPEN_ROUND_PER_HOUR}/hour), which waiting for the next minute\n` +
      '  cannot clear. Wait for the hour bucket to roll over, or lower ROUNDS.\n',
    );
    process.exit(1);
  }
}
let nextOpenAt = 0;
const startedAt = Date.now();

/** Wait until the schedule allows the next round open. */
async function pace() {
  const wait = nextOpenAt - performance.now();
  if (wait > 0) await sleep(wait);
  nextOpenAt = performance.now() + MIN_INTERVAL_MS;
}

for (let i = 0; i < ROUNDS; i += 1) {
  if (!matchId) {
    const opened = await callPlay({ action: 'open_match', format: 'bo5', opponent: 'nemesis' });
    if (opened.status === 429) {
      // Fixed windows: the bucket resets on the next calendar minute.
      noteRateLimit('open_match');
      await sleep(61_000 - (Date.now() % 60_000));
      i -= 1;
      continue;
    }
    if (opened.status !== 200) {
      console.error('  open_match failed:', opened.status, opened.body);
      process.exit(1);
    }
    matchId = opened.body.match_id;
    roundsThisMatch = 0;
  }

  await pace();

  // THE MEASUREMENT. Wall clock around the one call that does the new work.
  const t0 = performance.now();
  const round = await callPlay({ action: 'open_round', match_id: matchId });
  const elapsed = performance.now() - t0;

  if (round.status === 429) {
    // BACK OFF AND RETRY, BUT THROW THE SAMPLE AWAY. A retried request's timing
    // is a measurement of the backoff, not of the branch — and a handful of
    // multi-second outliers would swallow whole equal-frequency buckets. The
    // round is replayed; only its latency is discarded.
    noteRateLimit('open_round');
    console.error(
      `  429 at round ${i + 1} despite pacing — the limits in take_rate_token may have moved.` +
      ' Waiting for the next window.',
    );
    await sleep(61_000 - (Date.now() % 60_000));
    i -= 1;
    continue;
  }

  if (round.status !== 200) {
    // A closed match is the normal end of a bo5, not a failure.
    if (round.body?.error === 'match_closed') { matchId = null; i -= 1; continue; }
    console.error('  open_round failed:', round.status, round.body);
    process.exit(1);
  }

  // Deliberately BIASED play. An unreadable player would make Nemesis exploit
  // at the rate but gain nothing, and — more importantly here — a predictable
  // player is what makes the exploit branch fire often enough to measure.
  const move = Math.random() < 0.7 ? 'rock' : CHOICES[Math.floor(Math.random() * 3)];
  const submitted = await callPlay({
    action: 'submit',
    round_id: round.body.round_id,
    player_choice: move,
  });
  if (submitted.status === 429) {
    noteRateLimit('submit');
    excluded += 1;
    await sleep(61_000 - (Date.now() % 60_000));
    // The round is already open and committed; resubmitting the same move is
    // idempotent, so retry it rather than abandoning an open round.
    const again = await callPlay({
      action: 'submit', round_id: round.body.round_id, player_choice: move,
    });
    if (again.status !== 200) {
      console.error('  submit failed after backoff:', again.status, again.body);
      process.exit(1);
    }
    if (again.body?.match_complete) matchId = null;
    roundsThisMatch += 1;
    continue; // sample discarded: this round's open was followed by a stall
  }
  if (submitted.status !== 200) {
    console.error('  submit failed:', submitted.status, submitted.body);
    process.exit(1);
  }

  consecutiveLimited = 0; // a clean round means the window is healthy again

  if (i >= WARMUP) samples.push({ roundId: round.body.round_id, elapsed });
  else excluded += 1;

  roundsThisMatch += 1;
  if (submitted.body?.match_complete || roundsThisMatch > 12) matchId = null;

  if ((i + 1) % 30 === 0) {
    const mins = ((Date.now() - startedAt) / 60_000).toFixed(1);
    console.log(`  ${i + 1}/${ROUNDS} rounds — ${samples.length} samples kept, ${mins} min elapsed`);
  }
}

// Ground truth, read as an operator because a player cannot see it.
const { data: truth, error } = await admin
  .from('nemesis_rounds')
  .select('round_id, exploited')
  .in('round_id', samples.map((s) => s.roundId));
if (error) {
  console.error('  could not read nemesis_rounds:', error.message);
  process.exit(1);
}

const exploitedBy = new Map(truth.map((r) => [r.round_id, r.exploited]));
const paired = samples
  .filter((s) => exploitedBy.has(s.roundId))
  .map((s) => ({ elapsed: s.elapsed, exploited: exploitedBy.get(s.roundId) === true }));

if (paired.length < 40) {
  console.error(`  only ${paired.length} usable samples — too few to say anything.`);
  process.exit(1);
}

// Equal-frequency buckets, so the bucketing itself carries no information.
const sorted = [...paired].map((p) => p.elapsed).sort((a, b) => a - b);
const edges = Array.from({ length: BUCKETS - 1 }, (_, i) =>
  sorted[Math.floor(((i + 1) * sorted.length) / BUCKETS)]);
const bucketOf = (ms) => edges.filter((e) => ms >= e).length;

const labels = paired.map((p) => [bucketOf(p.elapsed), p.exploited ? 1 : 0]);

/** Mutual information in bits between two discrete labels. */
function mutualInformation(rows) {
  const n = rows.length;
  const joint = new Map();
  const px = new Map();
  const py = new Map();
  for (const [x, y] of rows) {
    joint.set(`${x}|${y}`, (joint.get(`${x}|${y}`) ?? 0) + 1);
    px.set(x, (px.get(x) ?? 0) + 1);
    py.set(y, (py.get(y) ?? 0) + 1);
  }
  let mi = 0;
  for (const [key, count] of joint) {
    const [x, y] = key.split('|');
    const pxy = count / n;
    const p1 = px.get(Number(x)) / n;
    const p2 = py.get(Number(y)) / n;
    mi += pxy * Math.log2(pxy / (p1 * p2));
  }
  return mi;
}

const observed = mutualInformation(labels);

// Permutation test: shuffle the exploited flags against the latency buckets. If
// latency really carries no signal, the real pairing is unremarkable among
// random ones.
const PERMUTATIONS = 2000;
const nullDist = [];
for (let i = 0; i < PERMUTATIONS; i += 1) {
  const ys = labels.map((l) => l[1]);
  for (let j = ys.length - 1; j > 0; j -= 1) {
    const k = Math.floor(Math.random() * (j + 1));
    [ys[j], ys[k]] = [ys[k], ys[j]];
  }
  nullDist.push(mutualInformation(labels.map((l, idx) => [l[0], ys[idx]])));
}
const pValue = (nullDist.filter((v) => v >= observed).length + 1) / (PERMUTATIONS + 1);

const readRounds = paired.filter((p) => p.exploited).map((p) => p.elapsed);
const blindRounds = paired.filter((p) => !p.exploited).map((p) => p.elapsed);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const variance = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
};

// EFFECT SIZE, not just significance. The difference in mean round-open latency
// between read and blind rounds is the thing a player could actually hear.
const diff = mean(readRounds) - mean(blindRounds);
const se = Math.sqrt(
  variance(readRounds) / Math.max(readRounds.length, 1) +
  variance(blindRounds) / Math.max(blindRounds.length, 1),
);
// The smallest difference this run could have detected with ~80% power at
// alpha 0.05. A PASS means "no leak bigger than this", never "no leak".
const mde = 2.8 * se;

console.log('');
console.log('  samples          :', paired.length, `(${excluded} discarded, ${rateLimited} rate-limit waits)`);
console.log('  read rounds      :', readRounds.length, `(mean ${mean(readRounds).toFixed(1)}ms)`);
console.log('  blind rounds     :', blindRounds.length, `(mean ${mean(blindRounds).toFixed(1)}ms)`);
console.log('  difference       :', `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}ms`,
            `(95% CI ${(diff - 1.96 * se).toFixed(1)} to ${(diff + 1.96 * se).toFixed(1)}ms)`);
console.log('  observed MI      :', observed.toFixed(5), 'bits');
console.log('  permutation p    :', pValue.toFixed(3));
console.log('  detectable effect:', `${mde.toFixed(1)}ms`, '(80% power, alpha 0.05)');
console.log('');

if (pValue < 0.01) {
  console.log('  FAIL — round-open latency carries information about whether Nemesis read you.');
} else {
  console.log(`  PASS — latency is independent of the branch, for any leak larger than ${mde.toFixed(0)}ms.`);
  console.log('  This does NOT rule out a leak smaller than that. Skipping the nemesis_open');
  console.log('  round trip would plausibly show as 3-15ms, so if the figure above is larger');
  console.log('  than that, the run is a bound rather than a clean bill of health — and the');
  console.log(`  600/hour cap on open_round means one run cannot exceed ~${HOUR_BUDGET} samples.`);
  console.log('  Pool several runs across hours to tighten it.');
}
process.exit(pValue < 0.01 ? 1 : 0);
