/**
 * Every wallet the harnesses can sign as, derived in one place.
 *
 * WHY THIS FILE EXISTS. Harness accounts were being created by signing in with
 * a keypair and then, sometimes, remembered about later. Thirteen synthetic
 * accounts reached production untagged that way, and two of them became the
 * first and only entries on the ladder — a ranking whose top two players did
 * not exist. Tagging them afterwards fixes those two. It does not fix the next
 * seed somebody adds.
 *
 * So the marker is no longer something anyone applies. A wallet listed here is
 * registered in `harness_wallets`, and the provisioning trigger stamps
 * `is_harness = true` on the profile AT CREATION — before the account can play
 * a round, enter a tournament or be rated. Born with it, not tagged into it.
 *
 * THREE THINGS KEEP THIS HONEST, and it takes all three:
 *
 *   1. this module    the only place a harness seed may be defined
 *   2. the migration  seeds `harness_wallets` from exactly this list, and a
 *                     drift test (wallets.sync.test.ts) fails the build if the
 *                     two disagree
 *   3. signInWithKeypair  refuses to return a session whose profile is not
 *                     flagged, so a seed that skipped 1 and 2 dies on its first
 *                     run instead of quietly polluting the ladder
 *
 * Rule 3 is the one that actually holds the line. The first two can be
 * forgotten by someone in a hurry; the third cannot, because nothing works
 * until it passes.
 *
 * RETIRED SEEDS STAY LISTED. `fill(9)` is the browser harness's original seed,
 * replaced after it collided with an SPL Mint on devnet. Its account is the one
 * that threw 378 consecutive rocks, and it is still in production — dropping a
 * seed from this list because nothing signs with it any more is how its account
 * quietly becomes a player again.
 *
 * SAFETY: every key here is derivable by anyone reading the repo. That is fine
 * for accounts whose whole purpose is to be disposable test rigs, and it is
 * exactly why they must never be able to rank, win a prize pool, or hold chips
 * that mean anything.
 */
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

const seedFromFill = (n) => new Uint8Array(32).fill(n);
const seedFromLabel = (label) => new Uint8Array(createHash('sha256').update(label).digest());

// The seeds themselves. Every harness imports its keypair material from here;
// nothing else in the repo may call Keypair.fromSeed with a literal.
export const SEED_ROUNDS = seedFromFill(7);
export const SEED_STAKE_A = seedFromFill(11);
export const SEED_STAKE_B = seedFromFill(12);
/** A hash, not a repeated byte — see the SEED CHOICE note in browser-wallet-key.mjs. */
export const BROWSER_SEED = seedFromLabel('evenshock/browser/v1');
/** The browser harness's ORIGINAL seed. Nothing signs with it; its account lives. */
export const SEED_BROWSER_RETIRED = seedFromFill(9);

/** Byte-fill seeds, with what each one drives. */
const FILL_SEEDS = [
  [SEED_ROUNDS, 'rounds.live.test — the solo round-trip player'],
  [SEED_BROWSER_RETIRED, 'browser harness (RETIRED seed, account still live)'],
  [SEED_STAKE_A, 'stake-match + tournament, seat A'],
  [SEED_STAKE_B, 'stake-match + tournament, seat B'],
];

/** Labelled-hash seeds. */
const LABEL_SEEDS = [[BROWSER_SEED, 'browser harness (current)']];

/**
 * How many load-abuse users are registered. The script signs in 10; this is
 * deliberately larger so raising N_USERS a little does not silently create
 * unregistered accounts — and `assertLoadUsersRegistered` below turns raising
 * it past the cap into an error rather than a surprise.
 */
export const LOAD_USER_CAP = 64;

/** The load harness's per-user seed. The one definition; load-abuse imports it. */
export const loadSeed = (i) => seedFromLabel(`evenshock/load/v1/${i}`);

/** Every registered harness wallet: { address, label }. */
export const HARNESS_WALLETS = [
  ...[...FILL_SEEDS, ...LABEL_SEEDS].map(([seed, label]) => ({
    address: Keypair.fromSeed(seed).publicKey.toBase58(),
    label,
  })),
  ...Array.from({ length: LOAD_USER_CAP }, (_, i) => ({
    address: Keypair.fromSeed(loadSeed(i)).publicKey.toBase58(),
    label: `load-abuse user #${i}`,
  })),
];

export const HARNESS_ADDRESSES = new Set(HARNESS_WALLETS.map((w) => w.address));

/** Throws if a load run would create accounts this registry does not cover. */
export function assertLoadUsersRegistered(nUsers) {
  if (nUsers > LOAD_USER_CAP) {
    throw new Error(
      `load-abuse asked for ${nUsers} users but only ${LOAD_USER_CAP} are registered as harness wallets.\n` +
        `  Raise LOAD_USER_CAP in scripts/harness/wallets.mjs AND re-seed harness_wallets, or the\n` +
        `  extra accounts would be created as ordinary players and could reach the ladder.`,
    );
  }
}
