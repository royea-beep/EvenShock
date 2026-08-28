/**
 * Building and sending the transfers, including the malformed ones.
 *
 * The one detail that matters more than the rest: the intent's `reference` is
 * appended as a read-only, non-signer account key. It participates in nothing —
 * no lamports, no data, the account need not even exist — but it makes the
 * transaction findable by `getSignaturesForAddress(reference)` and, crucially,
 * it is what BINDS the transfer to the intent that quoted it.
 *
 * Without that binding the signature primary key stops a payment being credited
 * twice but not being credited to the wrong person: anyone watching the treasury
 * could report someone else's incoming transfer against their own intent and be
 * first. So `sendUsdc` takes `reference` as an ordinary argument rather than
 * hiding it — the wrong-recipient and no-reference cases are built by passing
 * different values, and the theft test depends on it being absent.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

/** The token account for an owner, creating it if this is their first receipt. */
async function ensureAta(connection, payer, mint, owner) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  try {
    await getAccount(connection, ata);
    return { ata, createIx: null };
  } catch {
    return {
      ata,
      createIx: createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint),
    };
  }
}

/**
 * Sends `amountRaw` base units of `mint` from the payer to `toOwner`.
 *
 * `reference` may be null — that is the no-reference case, which must be
 * refused by the server, so it has to be expressible here.
 *
 * `confirm: false` returns as soon as the transaction is submitted, before it is
 * confirmed. That is how the "still pending" branch gets exercised: the client
 * reporting a signature the chain has not settled yet must be told to keep
 * waiting, never that the payment failed.
 */
export async function sendUsdc(
  connection,
  { payer, mint, toOwner, amountRaw, decimals, reference = null, confirm = true },
) {
  const mintKey = new PublicKey(mint);
  const ownerKey = new PublicKey(toOwner);

  const from = getAssociatedTokenAddressSync(mintKey, payer.publicKey, true);
  const { ata: to, createIx } = await ensureAta(connection, payer, mintKey, ownerKey);

  const transferIx = createTransferCheckedInstruction(
    from,
    mintKey,
    to,
    payer.publicKey,
    amountRaw,
    decimals,
  );

  // Solana Pay's convention. Read-only and non-signer: it is an index entry,
  // not a participant.
  if (reference) {
    transferIx.keys.push({
      pubkey: new PublicKey(reference),
      isSigner: false,
      isWritable: false,
    });
  }

  const tx = new Transaction();
  // Devnet's default fee market is trivial, but a priority fee keeps the suite
  // from stalling behind congestion and costs fake lamports.
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
  if (createIx) tx.add(createIx);
  tx.add(transferIx);

  if (confirm) {
    return await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: 'confirmed',
    });
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  return await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
}

/**
 * The simulated swap-and-pay: ONE atomic transaction carrying the input leg
 * (tSOL → liquidity wallet), the settlement leg (USDC → treasury), and a
 * 0-lamport self-transfer whose only job is to carry the intent's reference as
 * a static account key. This is the same shape the browser's `sendSwap` builds
 * from a devnet quote, and the same shape — minus Jupiter's own route
 * instruction — that a mainnet routed swap settles into.
 *
 * `usdcAmountRaw` is a parameter rather than derived from the quote so the
 * suite can UNDER-deliver on purpose: devnet has no on-chain minimum-out (that
 * guard is Jupiter's program), so the property provable here is the safe
 * degradation — the server credits floor(actual × rate), never the quote.
 */
export async function sendSwapSim(
  connection,
  {
    payer,
    inputMint,
    inputAmountRaw,
    inputDecimals,
    liquidityOwner,
    usdcMint,
    usdcAmountRaw,
    usdcDecimals,
    toOwner,
    reference = null,
    confirm = true,
  },
) {
  const inputKey = new PublicKey(inputMint);
  const usdcKey = new PublicKey(usdcMint);

  const fromInput = getAssociatedTokenAddressSync(inputKey, payer.publicKey, true);
  const fromUsdc = getAssociatedTokenAddressSync(usdcKey, payer.publicKey, true);
  const { ata: toInput, createIx: createInputIx } = await ensureAta(
    connection,
    payer,
    inputKey,
    new PublicKey(liquidityOwner),
  );
  const { ata: toUsdc, createIx: createUsdcIx } = await ensureAta(
    connection,
    payer,
    usdcKey,
    new PublicKey(toOwner),
  );

  const inputIx = createTransferCheckedInstruction(
    fromInput,
    inputKey,
    toInput,
    payer.publicKey,
    inputAmountRaw,
    inputDecimals,
  );
  const usdcIx = createTransferCheckedInstruction(
    fromUsdc,
    usdcKey,
    toUsdc,
    payer.publicKey,
    usdcAmountRaw,
    usdcDecimals,
  );

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
  if (createInputIx) tx.add(createInputIx);
  if (createUsdcIx) tx.add(createUsdcIx);
  tx.add(inputIx);
  tx.add(usdcIx);

  if (reference) {
    const refIx = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 0,
    });
    refIx.keys.push({ pubkey: new PublicKey(reference), isSigner: false, isWritable: false });
    tx.add(refIx);
  }

  if (confirm) {
    return await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: 'confirmed',
    });
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  return await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
}

/** Treasury balance, for proving receipt by delta rather than by assertion. */
export async function tokenBalance(connection, mint, owner) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true);
  try {
    const account = await getAccount(connection, ata);
    return account.amount;
  } catch {
    return 0n;
  }
}
