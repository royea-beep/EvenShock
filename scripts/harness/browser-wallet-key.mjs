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
 * SEED CHOICE: hash of a labeled string, not a repeated byte. The previous
 * seed — `new Uint8Array(32).fill(9)` — happened to derive a public key that
 * some prior experiment on devnet had already used to create a Mint account.
 * Once an account has an owner on chain, that assignment is permanent, so the
 * seed(9) address was permanently owned by the SPL Token program and could
 * never be a fee payer again: sendTransaction returned a signature, validators
 * silently dropped the tx, the harness saw "Signature has expired." A hash of
 * a labeled string makes accidental collision with someone else's throwaway
 * experiment vanishingly unlikely.
 *
 * SAFETY: this is a well-known key. Only ever use it against devnet. Anyone
 * reading this repo can sign as it — that is fine on devnet where funds are
 * fake, and unacceptable on mainnet. The devnet guard is `assertDevnet`;
 * do not weaken it.
 */
import { Keypair } from '@solana/web3.js';
import { BROWSER_SEED } from './wallets.mjs';

// The seed moved to wallets.mjs, which is also what registers this address as a
// harness wallet. Defining it here as well would let the two drift, and a
// harness whose address is not registered is created as an ORDINARY PLAYER —
// which is how thirteen synthetic accounts reached production untagged.
export { BROWSER_SEED };

/** The derived keypair the browser harness signs with. */
export const BROWSER_WALLET = Keypair.fromSeed(BROWSER_SEED);
