/**
 * Funds the browser-latency harness wallet on devnet.
 *
 *   node scripts/harness/fund-browser-wallet.mjs
 *
 * The browser harness signs with a deterministic keypair — Keypair.fromSeed
 * with a 32-byte 9-fill — so its address is a fact of the source code, not
 * something to fish out of a config file. That wallet needs a little SOL for
 * transaction fees and a little of the harness's test-USDC to buy chips.
 *
 * Both come from the payer under .devnet/, which holds SOL from earlier
 * airdrops and the mint authority for the harness's test currency. Talking to
 * the public faucet is deliberately avoided: it rate-limits by IP and stalls
 * this exact "kick off a run" step exactly when you want it not to.
 *
 * Idempotent. Skips the parts that are already funded.
 */
import { LAMPORTS_PER_SOL, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, mintTo, getAccount } from '@solana/spl-token';
import { assertDevnet, loadKeypair, readState, formatUnits } from '../devnet/chain.mjs';
import { RPC_URL } from './env.mjs';

// The browser harness derives its keypair the same way; both must agree, so
// this line is the entire coupling between the two files.
const BROWSER_SEED = new Uint8Array(32).fill(9);
const BROWSER_WALLET = Keypair.fromSeed(BROWSER_SEED);

// Enough SOL for a handful of shop transactions plus ATA rent. Small on
// purpose — the wallet is public knowledge; a bigger balance is just a bigger
// beacon for anyone who reads the source.
const SOL_TOP_UP_TARGET = 0.05;
// A comfortable inventory for repeated harness runs. Each buy is 1.00.
const USDC_TOP_UP_TARGET_UNITS = 10n; // whole units, multiplied by 10^decimals below

const { connection } = await assertDevnet(RPC_URL);
const state = readState();
if (!state.mint) {
  console.error('\n  .devnet/state.json has no mint — run: npm run devnet:setup\n');
  process.exit(1);
}

const payer = loadKeypair('payer');
const mint = new PublicKey(state.mint);
const decimals = state.decimals ?? 6;
const usdcTarget = USDC_TOP_UP_TARGET_UNITS * 10n ** BigInt(decimals);

console.log(`\n  browser wallet  ${BROWSER_WALLET.publicKey.toBase58()}`);
console.log(`  payer           ${payer.publicKey.toBase58()}`);
console.log(`  mint            ${mint.toBase58()}\n`);

// ------------------------------------------------------------------- SOL
const currentLamports = await connection.getBalance(BROWSER_WALLET.publicKey);
const currentSol = currentLamports / LAMPORTS_PER_SOL;
console.log(`  browser SOL: ${currentSol}`);

if (currentSol < SOL_TOP_UP_TARGET) {
  const need = SOL_TOP_UP_TARGET - currentSol;
  const lamports = Math.ceil(need * LAMPORTS_PER_SOL);
  const payerLamports = await connection.getBalance(payer.publicKey);
  if (payerLamports < lamports + 5_000) {
    console.error(
      `\n  payer has ${payerLamports / LAMPORTS_PER_SOL} SOL — not enough to top up ${need} SOL.\n` +
        `  top the payer up first, or reduce SOL_TOP_UP_TARGET.\n`,
    );
    process.exit(1);
  }
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: BROWSER_WALLET.publicKey,
      lamports,
    }),
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
  console.log(`  topped up ${lamports / LAMPORTS_PER_SOL} SOL — ${sig}`);
} else {
  console.log('  SOL already sufficient — skipping');
}

// ---------------------------------------------------------------- USDC
//
// The ATA is created and paid for by the payer, so the browser wallet does not
// need to fund its own account rent. That is the point of doing this here.
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

console.log(`\n  browser wallet funded — run: npm run e2e:browser\n`);
