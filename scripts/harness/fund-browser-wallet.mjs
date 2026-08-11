/**
 * Funds the browser-latency harness wallet on devnet.
 *
 *   node scripts/harness/fund-browser-wallet.mjs   # standalone CLI form
 *
 * Also exports `ensureBrowserWalletFunded` so `scripts/devnet/setup.mjs` can
 * call it as its last step — that way there is no separate "did you remember
 * to fund the browser wallet after the last setup?" step to forget, and the
 * mint the harness pays with cannot drift from the mint payment_config points
 * at.
 *
 * The browser harness signs with a deterministic keypair whose seed lives in
 * `./browser-wallet-key.mjs`; the same file is imported by browser-latency.mjs
 * so the signer and the funded address cannot diverge.
 *
 * Idempotent. Skips the parts that are already funded.
 */
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, mintTo, getAccount } from '@solana/spl-token';
import { assertDevnet, loadKeypair, readState, formatUnits } from '../devnet/chain.mjs';
import { RPC_URL } from './env.mjs';
import { BROWSER_WALLET } from './browser-wallet-key.mjs';

// Enough SOL for a handful of shop transactions plus ATA rent. Small on
// purpose — the wallet is public knowledge; a bigger balance is just a bigger
// beacon for anyone who reads the source.
const SOL_TOP_UP_TARGET = 0.05;
// A comfortable inventory for repeated harness runs. Each buy is 1.00.
const USDC_TOP_UP_TARGET_UNITS = 10n; // whole units, multiplied by 10^decimals below

/**
 * Bring the browser wallet up to a working balance on the given connection.
 *
 * Assumes the caller has already asserted the connection is devnet — the CLI
 * entry point does that here; setup.mjs does it at its top.
 *
 * All parameters are required so the caller cannot accidentally rely on
 * globals that might not be initialized in the right order.
 */
export async function ensureBrowserWalletFunded({ connection, payer, mint, decimals }) {
  const usdcTarget = USDC_TOP_UP_TARGET_UNITS * 10n ** BigInt(decimals);

  console.log(`\n  browser wallet  ${BROWSER_WALLET.publicKey.toBase58()}`);
  console.log(`  payer           ${payer.publicKey.toBase58()}`);
  console.log(`  mint            ${mint.toBase58()}\n`);

  // ----------------------------------------------------------------- SOL
  const currentLamports = await connection.getBalance(BROWSER_WALLET.publicKey);
  const currentSol = currentLamports / LAMPORTS_PER_SOL;
  console.log(`  browser SOL: ${currentSol}`);

  if (currentSol < SOL_TOP_UP_TARGET) {
    const need = SOL_TOP_UP_TARGET - currentSol;
    const lamports = Math.ceil(need * LAMPORTS_PER_SOL);
    const payerLamports = await connection.getBalance(payer.publicKey);
    if (payerLamports < lamports + 5_000) {
      throw new Error(
        `payer has ${payerLamports / LAMPORTS_PER_SOL} SOL — not enough to top up ${need} SOL. ` +
          `Top the payer up first, or reduce SOL_TOP_UP_TARGET.`,
      );
    }
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: BROWSER_WALLET.publicKey,
        lamports,
      }),
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: 'confirmed',
    });
    console.log(`  topped up ${lamports / LAMPORTS_PER_SOL} SOL — ${sig}`);
  } else {
    console.log('  SOL already sufficient — skipping');
  }

  // ---------------------------------------------------------------- USDC
  //
  // The ATA is created and paid for by the payer, so the browser wallet does
  // not need to fund its own account rent. That is the point of doing this
  // here. Crucially, this creates the ATA on the CURRENT mint — the one the
  // active payment_config points at — so a mint rotation during setup can't
  // leave the harness holding tokens the server won't recognise.
  const browserAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    BROWSER_WALLET.publicKey,
  );

  let currentAmount = 0n;
  try {
    const acct = await getAccount(connection, browserAta.address);
    currentAmount = acct.amount;
  } catch {
    /* ATA was just created above; amount is 0 */
  }
  console.log(`  browser USDC (test): ${formatUnits(currentAmount, decimals)}`);

  if (currentAmount < usdcTarget) {
    const need = usdcTarget - currentAmount;
    const sig = await mintTo(connection, payer, mint, browserAta.address, payer, need);
    console.log(`  minted ${formatUnits(need, decimals)} test-USDC to browser wallet — ${sig}`);
  } else {
    console.log('  USDC already sufficient — skipping');
  }
}

// -------------------------------------------------------------- CLI form
//
// Only runs when this file is invoked directly. Import from another module and
// it exports `ensureBrowserWalletFunded` without side effects.

const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') ?? '');

if (isCli) {
  const { connection } = await assertDevnet(RPC_URL);
  const state = readState();
  if (!state.mint) {
    console.error('\n  .devnet/state.json has no mint — run: npm run devnet:setup\n');
    process.exit(1);
  }
  const payer = loadKeypair('payer');
  const mint = new PublicKey(state.mint);
  const decimals = state.decimals ?? 6;
  await ensureBrowserWalletFunded({ connection, payer, mint, decimals });
  console.log(`\n  browser wallet funded — run: npm run e2e:browser\n`);
}
