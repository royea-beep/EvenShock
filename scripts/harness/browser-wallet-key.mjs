/**
 * The one place the browser-harness wallet exists.
 *
 * The browser harness signs with a deterministic keypair so its address is a
 * fact of the source, not something drifting around config files. Three
 * scripts need to agree on that address:
 *
 *   - scripts/harness/browser-latency.mjs   (signs)
 *   - scripts/harness/fund-browser-wallet.mjs (funds by hand)
 *   - scripts/devnet/setup.mjs              (funds as part of a full setup)
 *
 * When those three agreed by copy-paste, they drifted, and a passing setup
 * quietly left the harness paying from an empty address. Nothing to notice
 * during setup, nothing to notice during the run — only "payment could not be
 * verified" at the end, which reads like a server bug. One file, one seed,
 * one derived keypair — imported by all three, redefined by none.
 *
 * SAFETY: this is a well-known key. Only ever use it against devnet. Anyone
 * reading this repo can sign as it — that is fine on devnet where funds are
 * fake, and unacceptable on mainnet. The devnet guard is `assertDevnet`;
 * do not weaken it.
 */
import { Keypair } from '@solana/web3.js';

/** The 32-byte seed. Do not change without also invalidating funded state. */
export const BROWSER_SEED = new Uint8Array(32).fill(9);

/** The derived keypair the browser harness signs with. */
export const BROWSER_WALLET = Keypair.fromSeed(BROWSER_SEED);
