/**
 * Mints the CURRENT test currency to any wallet.
 *
 *   npm run devnet:fund -- <address> [amount]     # amount in whole units, default 25
 *
 * WHY THIS EXISTS: Circle's devnet faucet hands out mint 4zMMC9sr… — a mint
 * this system deliberately stopped accepting when the harness started minting
 * its own currency (see setup.mjs: a faucet dependency is a suite that stops
 * working when the faucet does). So a wallet funded from the public faucet
 * holds real devnet USDC that payment_config no longer recognises, and the
 * purchase path correctly refuses it. This script is the sanctioned top-up:
 * it mints on the mint the ACTIVE config points at (kept in lockstep with
 * .devnet/state.json by setup), from the payer that holds the authority.
 *
 * It runs only where the keys live — the operator's machine — and only
 * against devnet: `assertDevnet` proves the genesis hash before `loadKeypair`
 * will hand out anything, same as every other harness script.
 *
 * The final balance is READ BACK FROM THE CHAIN and printed, so "funded" is
 * an observation, not an assertion.
 */
import { PublicKey } from '@solana/web3.js';
import { getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { assertDevnet, loadKeypair, readState, formatUnits, parseUnits } from './chain.mjs';
import { RPC_URL } from '../harness/env.mjs';

const [address, amountArg] = process.argv.slice(2);
if (!address) {
  console.error('\n  usage: npm run devnet:fund -- <address> [amount]\n');
  process.exit(1);
}

const state = readState();
if (!state.mint) {
  console.error('\n  No .devnet/state.json — run `npm run devnet:setup` first.\n');
  process.exit(1);
}

// Refuse the treasury by identity. Tokens "held" by the treasury are
// indistinguishable from revenue in every balance check the suite makes, and
// a treasury paying itself is the self-transfer trap the server already
// refuses at intent time (wallet_is_treasury).
if (address === state.treasury) {
  console.error('\n  REFUSING: that is the treasury address. Fund a player wallet.\n');
  process.exit(1);
}

const amount = parseUnits(amountArg ?? '25', state.decimals);
if (amount <= 0n) {
  console.error('\n  amount must be positive\n');
  process.exit(1);
}

const { connection } = await assertDevnet(state.rpc_url ?? RPC_URL);
const payer = loadKeypair('payer');
const mint = new PublicKey(state.mint);
const owner = new PublicKey(address);

console.log(`\n  mint     ${state.mint}  (the ACTIVE payment_config mint)`);
console.log(`  to       ${address}`);
console.log(`  amount   ${formatUnits(amount, state.decimals)}\n`);

// ATA rent is the payer's problem, not the recipient's — same choice as
// ensureBrowserWalletFunded, and for the same reason: a wallet should not
// need SOL just to be able to RECEIVE the test currency.
const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner);
const sig = await mintTo(connection, payer, mint, ata.address, payer, amount);
console.log(`  minted — ${sig}`);

const after = await getAccount(connection, ata.address);
console.log(`  on-chain balance now: ${formatUnits(after.amount, state.decimals)}\n`);
