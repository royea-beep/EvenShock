/**
 * The round-open timing channel, measured.
 *
 *   EVENSHOCK_LIVE=1 node scripts/harness/nemesis-timing.mjs
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
requireServiceRole();

/** Enough rounds that a real effect would show; few enough to stay polite. */
const ROUNDS = Number(process.env.ROUNDS ?? 240);
/** Latency buckets. Coarse on purpose — over-fine bins manufacture MI from noise. */
const BUCKETS = Number(process.env.BUCKETS ?? 4);

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

console.log(`nemesis-timing — ${ROUNDS} rounds against Nemesis, timing every open_round`);

const samples = [];
let matchId = null;
let roundsThisMatch = 0;

for (let i = 0; i < ROUNDS; i += 1) {
  // A fresh bo5 whenever the last one finished. Nemesis reads LIFETIME history,
  // so match boundaries do not reset what it knows — only the in-match context.
  if (!matchId) {
    const opened = await callPlay({ action: 'open_match', format: 'bo5', opponent: 'nemesis' });
    if (opened.status !== 200) {
      console.error('  open_match failed:', opened.status, opened.body);
      process.exit(1);
    }
    matchId = opened.body.match_id;
    roundsThisMatch = 0;
  }

  // THE MEASUREMENT. Wall clock around the one call that does the new work.
  const t0 = performance.now();
  const round = await callPlay({ action: 'open_round', match_id: matchId });
  const elapsed = performance.now() - t0;

  if (round.status !== 200) {
    // A closed match is the normal end of a bo5, not a failure.
    if (round.body?.error === 'match_closed') { matchId = null; continue; }
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
  if (submitted.status !== 200) {
    console.error('  submit failed:', submitted.status, submitted.body);
    process.exit(1);
  }

  samples.push({ roundId: round.body.round_id, elapsed });
  roundsThisMatch += 1;
  if (submitted.body?.match_complete || roundsThisMatch > 12) matchId = null;
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

const readRounds = paired.filter((p) => p.exploited);
const blindRounds = paired.filter((p) => !p.exploited);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

console.log('');
console.log('  samples          :', paired.length);
console.log('  read rounds      :', readRounds.length, `(mean ${mean(readRounds.map((r) => r.elapsed)).toFixed(1)}ms)`);
console.log('  blind rounds     :', blindRounds.length, `(mean ${mean(blindRounds.map((r) => r.elapsed)).toFixed(1)}ms)`);
console.log('  observed MI      :', observed.toFixed(5), 'bits');
console.log('  permutation p    :', pValue.toFixed(3));
console.log('');
console.log(
  pValue < 0.01
    ? '  FAIL — round-open latency carries information about whether Nemesis read you.'
    : '  PASS — latency is independent of the branch, within this sample.',
);
process.exit(pValue < 0.01 ? 1 : 0);
