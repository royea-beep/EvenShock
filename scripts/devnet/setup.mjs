/**
 * One-time (and idempotent) setup for the devnet payment suite.
 *
 *   npm run devnet:setup
 *
 * Creates the keypairs, airdrops its own SOL, creates a 6-decimal SPL mint it
 * controls, mints itself a working balance, and points `payment_config` at it.
 *
 * THE MINT IS OURS ON PURPOSE. Testing against Circle's devnet USDC means the
 * suite runs until the faucet balance is gone and then needs a human again,
 * which defeats the point of automating it. Nothing in the verification path
 * depends on WHICH mint it is — only that the transaction's mint matches the
 * one the intent froze — so a mint we can top up exercises identical code.
 *
 * The corollary is that this harness can conjure currency, which is why
 * `chain.mjs` refuses to load a key until the chain has identified itself as
 * devnet, and why the mint is registered in `test_mints` where a database
 * constraint permanently bars it from a mainnet configuration.
 */
import { createClient } from '@supabase/supabase-js';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { assertDevnet, loadKeypair, readState, writeState, formatUnits, sleep } from './chain.mjs';
import { signInWithKeypair } from '../harness/auth.mjs';
import { ensureBrowserWalletFunded } from '../harness/fund-browser-wallet.mjs';
import { SUPABASE_URL, ANON_KEY, SERVICE_ROLE_KEY, RPC_URL, requireServiceRole } from '../harness/env.mjs';

const DECIMALS = 6;
const MINT_TO_PAYER = 10_000n * 10n ** BigInt(DECIMALS); // 10,000 test dollars
const MIN_SOL = 0.3;

requireServiceRole();

const { connection } = await assertDevnet(RPC_URL);
console.log(`\n  devnet confirmed — ${RPC_URL}\n`);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ------------------------------------------------------------------- keys
const payer = loadKeypair('payer');
const decoy = loadKeypair('decoy');
const u1 = loadKeypair('user1');
const u2 = loadKeypair('user2');

console.log(`  payer   ${payer.publicKey.toBase58()}`);
console.log(`  decoy   ${decoy.publicKey.toBase58()}`);
console.log(`  user1   ${u1.publicKey.toBase58()}`);
console.log(`  user2   ${u2.publicKey.toBase58()}\n`);

// ------------------------------------------------------------------- SOL
let sol = (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
if (sol < MIN_SOL) {
  console.log(`  payer has ${sol} SOL, airdropping…`);
  try {
    const sig = await connection.requestAirdrop(payer.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
    sol = (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  } catch (err) {
    // The public faucet rate-limits hard. Say what to do rather than fail
    // with a stack trace — this is the one step that can need a human.
    console.error(
      [
        '',
        `  Airdrop refused: ${err?.message ?? err}`,
        '',
        '  The public devnet faucet rate-limits by address and by IP. Either',
        '  wait and re-run, or top the payer up at https://faucet.solana.com',
        `  using ${payer.publicKey.toBase58()}`,
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}
console.log(`  payer SOL ${sol}\n`);

// ------------------------------------------------------------------- mint
const state = readState();
let mint = state.mint ? new PublicKey(state.mint) : null;

if (mint) {
  console.log(`  reusing mint ${mint.toBase58()}`);
} else {
  mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
  console.log(`  created mint ${mint.toBase58()} (${DECIMALS} decimals, authority = payer)`);
}

const payerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
if (payerAta.amount < MINT_TO_PAYER / 2n) {
  await mintTo(connection, payer, mint, payerAta.address, payer, MINT_TO_PAYER);
  console.log(`  minted ${formatUnits(MINT_TO_PAYER, DECIMALS)} test units to the payer`);
}

// ------------------------------------------------------------- treasury
//
// The treasury is whatever the live devnet config already names. It is only
// ever a recipient, so it needs no key here — and reading it from the database
// rather than a constant means the suite proves the CONFIGURED address receives
// the money, which is the thing that could be wrong.
const { data: cfgRows, error: cfgErr } = await admin
  .from('payment_config')
  .select('*')
  .eq('cluster', 'devnet')
  .eq('active', true)
  .limit(1);
if (cfgErr) throw cfgErr;
if (!cfgRows?.length) throw new Error('no active devnet payment_config row');

const treasury = cfgRows[0].treasury_address;
if (treasury === payer.publicKey.toBase58()) {
  console.error('\n  REFUSING: the treasury is the payer. Every test would be a self-transfer.\n');
  process.exit(1);
}
console.log(`  treasury ${treasury}`);

// Create the treasury's token account for our mint up front, at the payer's
// expense, so the first payment is a plain transfer like every later one.
await getOrCreateAssociatedTokenAccount(connection, payer, mint, new PublicKey(treasury));

// --------------------------------------------------- register and configure
await admin
  .from('test_mints')
  .upsert(
    { mint: mint.toBase58(), cluster: 'devnet', note: 'evenshock devnet harness; authority held by scripts/devnet' },
    { onConflict: 'mint' },
  )
  .throwOnError();

if (cfgRows[0].usdc_mint !== mint.toBase58()) {
  // Rotate rather than edit: the old row stays readable for any intent that
  // quoted it, which is the property the schema was built for.
  await admin
    .from('payment_config')
    .update({ active: false, retired_at: new Date().toISOString() })
    .eq('id', cfgRows[0].id)
    .throwOnError();

  await admin
    .from('payment_config')
    .insert({
      cluster: 'devnet',
      treasury_address: treasury,
      usdc_mint: mint.toBase58(),
      usdc_decimals: DECIMALS,
      chips_per_usdc: cfgRows[0].chips_per_usdc,
      active: true,
    })
    .throwOnError();
  console.log(`  payment_config rotated to the harness mint`);
}

// ------------------------------------------------------------------- users
//
// Signed in through the real Sign-In With Solana path, so the provisioning
// trigger runs and these look exactly like players.
const s1 = await signInWithKeypair(SUPABASE_URL, ANON_KEY, u1, 'user1');
const s2 = await signInWithKeypair(SUPABASE_URL, ANON_KEY, u2, 'user2');
console.log(`  user1 ${s1.userId}`);
console.log(`  user2 ${s2.userId}`);

// `reconcile` is owner-only, so one test user has to be an owner to exercise it.
await admin.from('profiles').update({ is_owner: true }).eq('id', s1.userId).throwOnError();

writeState({
  cluster: 'devnet',
  rpc_url: RPC_URL,
  mint: mint.toBase58(),
  decimals: DECIMALS,
  chips_per_usdc: cfgRows[0].chips_per_usdc,
  treasury,
  payer: payer.publicKey.toBase58(),
  decoy: decoy.publicKey.toBase58(),
  user1: { address: s1.address, id: s1.userId },
  user2: { address: s2.address, id: s2.userId },
});

await sleep(200);

// ---------------------------------------------------------- browser wallet
//
// Fund the deterministic wallet the browser harness signs with, on THIS run's
// mint, using THIS run's payer. Folded in here — not left as a separate step —
// because "did we remember to fund the browser wallet?" is exactly the drift
// that made a passing setup coexist with a failing e2e:browser: the harness
// held tokens from a previous mint while payment_config pointed at a new one,
// and confirm_payment correctly found nothing.
console.log('\n  funding browser harness wallet');
await ensureBrowserWalletFunded({ connection, payer, mint, decimals: DECIMALS });

console.log('\n  setup complete — run: npm run devnet:e2e (or npm run e2e:browser)\n');
