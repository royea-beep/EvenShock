import type { SupabaseClient } from '@supabase/supabase-js';
import type { Buffer } from 'buffer';

/**
 * Chip purchases. USDC on-chain, credited server-side.
 *
 * Nothing here decides money — the client's role in this file is (a) show the
 * player what they are about to pay, (b) ask their wallet to sign a transfer
 * that names the intent by reference, and (c) hand the resulting signature to
 * the server so it can verify what actually landed. Every check that costs
 * chips runs on the server: the RPC verifies the on-chain transfer against the
 * intent's frozen recipient, mint, decimals, and reference, and the server is
 * what credits.
 *
 * The heavy Solana libraries are dynamically imported by `sendUsdc`, so a
 * player who never opens the shop never pays for the ~350 KB of web3.js.
 */

export const TOS_VERSION = 'v1';

export interface PurchaseIntent {
  intent_id: string;
  cluster: 'devnet' | 'mainnet-beta';
  treasury_address: string;
  usdc_mint: string;
  usdc_decimals: number;
  chips_per_usdc: number;
  expected_usdc: number;
  reference: string;
  quote_expires_at: string;
  /** Set once a swap quote has been recorded on this intent; null/absent on
   *  USDC-direct intents. Presentation + audit only — never verification. */
  input_mint?: string | null;
}

/** A token the player may PAY WITH (the treasury always receives USDC).
 *  Server-curated allow-list; the client's copy renders a picker and proves
 *  nothing — the server re-validates the mint on every quote. */
export interface AcceptedToken {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}

export async function listAcceptedTokens(client: SupabaseClient): Promise<AcceptedToken[]> {
  const { data, error } = await client
    .from('accepted_input_tokens')
    .select('mint, symbol, name, decimals')
    .order('symbol');
  if (error || !data) return [];
  return data.map((t) => ({
    mint: String(t.mint),
    symbol: String(t.symbol),
    name: String(t.name),
    decimals: Number(t.decimals),
  }));
}

interface CallPlayError extends Error {
  code: string;
  status?: number;
}

/**
 * Invokes an action on the `play` Edge Function and normalises error shape.
 *
 * The `code` on thrown errors is the server's tagged reason
 * (`insufficient_chips`, `tos_required`, `payment_mismatch`, …) — the UI keys
 * off it, so it must not be re-wrapped or humanised here.
 */
async function callPlay(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.functions.invoke('play', { body });
  if (error) {
    const res = (error as { context?: Response }).context;
    if (res && typeof res.status === 'number') {
      let code = 'http_error';
      try {
        const parsed = (await res.json()) as { error?: string; message?: string };
        code = parsed.error ?? code;
      } catch {
        /* not JSON */
      }
      const wrapped = new Error(code) as CallPlayError;
      wrapped.code = code;
      wrapped.status = res.status;
      throw wrapped;
    }
    throw error;
  }
  return data as Record<string, unknown>;
}

/** True when the current user already accepted the given ToS version. RLS
 *  scopes the row to the caller, so no user filter is passed. */
export async function hasAcceptedTos(client: SupabaseClient, version: string): Promise<boolean> {
  const { data, error } = await client
    .from('tos_acceptances')
    .select('version')
    .eq('version', version)
    .maybeSingle();
  if (error) return false;
  return Boolean(data);
}

export async function acceptTos(client: SupabaseClient, version: string): Promise<void> {
  await callPlay(client, { action: 'accept_tos', version });
}

/**
 * Returns the newest unpaid intent still inside its quote window, if any.
 *
 * The schema deliberately allows overlapping open intents (see the migration
 * comment), so this is presentation-side "do we already have one in flight" —
 * not an exclusion rule. Callers use the answer to offer resume-or-start-new
 * rather than to block.
 */
export async function findOpenIntent(client: SupabaseClient): Promise<PurchaseIntent | null> {
  const { data, error } = await client
    .from('payment_intents')
    .select(
      'id, quote_expires_at, cluster, treasury_address, usdc_mint, usdc_decimals, chips_per_usdc, expected_usdc, reference, status, input_mint',
    )
    .eq('status', 'pending')
    .gt('quote_expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    intent_id: String(data.id),
    cluster: data.cluster as 'devnet' | 'mainnet-beta',
    treasury_address: String(data.treasury_address),
    usdc_mint: String(data.usdc_mint),
    usdc_decimals: Number(data.usdc_decimals),
    chips_per_usdc: Number(data.chips_per_usdc),
    expected_usdc: Number(data.expected_usdc),
    reference: String(data.reference),
    quote_expires_at: String(data.quote_expires_at),
    input_mint: data.input_mint == null ? null : String(data.input_mint),
  };
}

export async function createIntent(
  client: SupabaseClient,
  usdc: number,
): Promise<PurchaseIntent> {
  const data = await callPlay(client, {
    action: 'create_intent',
    usdc,
    tos_version: TOS_VERSION,
  });
  return {
    intent_id: String(data.intent_id),
    cluster: data.cluster as 'devnet' | 'mainnet-beta',
    treasury_address: String(data.treasury_address),
    usdc_mint: String(data.usdc_mint),
    usdc_decimals: Number(data.usdc_decimals),
    chips_per_usdc: Number(data.chips_per_usdc),
    expected_usdc: Number(data.expected_usdc),
    reference: String(data.reference),
    quote_expires_at: String(data.quote_expires_at),
  };
}

export type ConfirmResult =
  | { kind: 'credited'; chips_credited: number; chips: number }
  | { kind: 'pending' }
  | { kind: 'failed'; code: string };

export async function confirmPayment(
  client: SupabaseClient,
  intentId: string,
  signature: string,
): Promise<ConfirmResult> {
  try {
    const data = await callPlay(client, {
      action: 'confirm_payment',
      intent_id: intentId,
      signature,
    });
    if (data.status === 'pending') return { kind: 'pending' };
    // 'credited' is the success case — either freshly credited or a replay
    // of a previous credit. Either way the balance is real.
    if (data.status === 'credited') {
      return {
        kind: 'credited',
        chips_credited: Number(data.chips_credited ?? 0),
        chips: Number(data.chips ?? 0),
      };
    }
    return { kind: 'failed', code: 'unexpected_response' };
  } catch (err) {
    const code = (err as CallPlayError).code ?? 'confirm_failed';
    // rpc_unavailable is transient — the caller should retry, not surface as
    // a failure. Everything else really is a failure verdict.
    if (code === 'rpc_unavailable') return { kind: 'pending' };
    return { kind: 'failed', code };
  }
}

// ------------------------------------------------------------- swap quotes

/** One Jupiter instruction as the Edge Function relays it. */
interface RelayedInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string; // base64
}

export interface SwapQuote {
  provider: 'devnet_harness' | 'jupiter';
  input_mint: string;
  input_symbol: string;
  input_decimals: number;
  swap_mode: 'ExactIn' | 'ExactOut';
  quoted_input_amount: number;
  /** Exact base units — what the transaction is built from. The decimal
   *  fields above are display; these strings are the money. */
  quoted_input_raw: string;
  quoted_usdc_out: number;
  usdc_out_raw: string;
  min_usdc_out: number;
  min_chips: number;
  chips_per_usdc: number;
  slippage_bps: number;
  swap_quote_expires_at: string;
  /** devnet_harness only */
  liquidity_wallet?: string;
  /** jupiter only */
  instructions?: {
    compute_budget: RelayedInstruction[];
    setup: RelayedInstruction[];
    swap: RelayedInstruction;
    cleanup: RelayedInstruction | null;
  };
  address_lookup_table_addresses?: string[];
}

export type QuoteResult =
  | { kind: 'ok'; quote: SwapQuote }
  /** The aggregator (or devnet provider) can't quote right now. Not an error
   *  the player did anything to cause: the UI degrades to USDC-direct. */
  | { kind: 'unavailable' }
  | { kind: 'failed'; code: string };

export async function quoteSwap(
  client: SupabaseClient,
  intentId: string,
  inputMint: string,
  payer: string | null,
): Promise<QuoteResult> {
  try {
    const data = await callPlay(client, {
      action: 'quote_swap',
      intent_id: intentId,
      input_mint: inputMint,
      payer,
    });
    return { kind: 'ok', quote: data as unknown as SwapQuote };
  } catch (err) {
    const code = (err as CallPlayError).code ?? 'quote_failed';
    if (code === 'swap_unavailable') return { kind: 'unavailable' };
    return { kind: 'failed', code };
  }
}

/** True while the quote is still fresh enough to sign against. Purely a
 *  client-side gate: the server never refuses to credit a late-landing swap. */
export function quoteIsFresh(quote: SwapQuote, nowMs = Date.now()): boolean {
  return nowMs < new Date(quote.swap_quote_expires_at).getTime();
}

// ---------------------------------------------------------- on-chain send

/** RPC to use in the browser for a given cluster. Devnet is public. Mainnet
 *  would need a dedicated endpoint; we're not there yet, so refuse loudly. */
function browserRpc(cluster: 'devnet' | 'mainnet-beta'): string {
  if (cluster === 'devnet') return 'https://api.devnet.solana.com';
  throw new Error(`no browser RPC configured for cluster ${cluster}`);
}

interface WalletLike {
  publicKey: { toBase58(): string } | null;
  signAndSendTransaction: (tx: unknown) => Promise<{ signature: string }>;
}

/**
 * Sends the USDC transfer that pays this intent.
 *
 * The reference key is appended to the transfer instruction as a read-only,
 * non-signer account — the Solana Pay convention that makes the transaction
 * findable via `getSignaturesForAddress(reference)` and, more importantly,
 * binds the on-chain movement to THIS intent. Without it, anyone watching the
 * treasury could try to attribute the incoming transfer to their own intent.
 *
 * Same intent, same reference: if the wallet or the network fails partway,
 * calling this again with the same intent is a fresh signature that still
 * names the same intent, so it credits the right player and never double-mints.
 */
export async function sendUsdc(
  intent: PurchaseIntent,
  wallet: WalletLike,
): Promise<{ signature: string }> {
  if (!wallet.publicKey) throw new Error('wallet_disconnected');

  // FIRST, and deliberately not inside the Promise.all below. The Solana
  // libraries reach for Node's `Buffer`, which no browser has; without this the
  // whole path dies at `new PublicKey(...)` with "Buffer is not defined" and
  // nothing is ever signed. Sequential because a module can touch Buffer while
  // it evaluates, not only when it is called — racing the shim against the
  // import would make the fix depend on load order.
  await import('../utils/bufferShim');

  const [{ Connection, PublicKey, Transaction, ComputeBudgetProgram }, spl] = await Promise.all([
    import('@solana/web3.js'),
    import('@solana/spl-token'),
  ]);

  const connection = new Connection(browserRpc(intent.cluster), 'confirmed');
  const payer = new PublicKey(wallet.publicKey.toBase58());
  const mint = new PublicKey(intent.usdc_mint);
  const treasuryOwner = new PublicKey(intent.treasury_address);
  const reference = new PublicKey(intent.reference);

  const [fromAta, toAta] = await Promise.all([
    spl.getAssociatedTokenAddress(mint, payer),
    spl.getAssociatedTokenAddress(mint, treasuryOwner),
  ]);

  // BigInt scaling to avoid floating-point drift for small amounts. 1 USDC on
  // devnet has 6 decimals, so the scale factor is 1e6; a naive multiply of
  // 0.37 * 1e6 lands at 369999.99999999994.
  const scale = BigInt(10) ** BigInt(intent.usdc_decimals);
  // Route through a fixed-precision string so 1.005 * 1e6 doesn't lose the 5.
  const [whole, fraction = ''] = intent.expected_usdc.toFixed(intent.usdc_decimals).split('.');
  const amountRaw =
    BigInt(whole) * scale + BigInt(fraction.padEnd(intent.usdc_decimals, '0') || '0');

  const ix = spl.createTransferCheckedInstruction(
    fromAta,
    mint,
    toAta,
    payer,
    amountRaw,
    intent.usdc_decimals,
  );
  ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false });

  const tx = new Transaction();
  // A tiny priority fee makes devnet congestion far less likely to strand a
  // signature — matches what the harness does. Costs fractions of a cent.
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
  tx.add(ix);
  tx.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  const { signature } = await wallet.signAndSendTransaction(tx);
  return { signature };
}

/**
 * Sends the ONE transaction that swaps the player's chosen token and delivers
 * USDC to the treasury. One signature, no intermediate state: the swap leg and
 * the treasury delivery either both land or neither does, which is what closes
 * "the swap happened but the payment didn't" — the worst state a two-step
 * design would have.
 *
 * The intent's reference rides on a 0-lamport self-transfer appended as the
 * last instruction — the Solana Pay convention, and some wallets flag it in
 * simulation; that is expected. Do NOT "fix" it by appending the reference to
 * Jupiter's route instruction (its remaining-accounts list is owned by the
 * router and extra keys can change its meaning) and never via SPL Memo (Memo
 * requires every appended account to be a SIGNER, which a reference cannot
 * be). As a static key the reference lands in `message.accountKeys`, so the
 * server's binding check works identically to the USDC-direct path.
 */
export async function sendSwap(
  intent: PurchaseIntent,
  quote: SwapQuote,
  wallet: WalletLike,
): Promise<{ signature: string }> {
  if (!wallet.publicKey) throw new Error('wallet_disconnected');
  if (!quoteIsFresh(quote)) throw new Error('quote_expired');

  // Same ordering rule as sendUsdc: the shim first, sequentially.
  await import('../utils/bufferShim');

  const [web3, spl] = await Promise.all([import('@solana/web3.js'), import('@solana/spl-token')]);
  const { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } = web3;

  const connection = new Connection(browserRpc(intent.cluster), 'confirmed');
  const payer = new PublicKey(wallet.publicKey.toBase58());
  const reference = new PublicKey(intent.reference);

  // The reference instruction: moves nothing, binds everything.
  const referenceIx = SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 0 });
  referenceIx.keys.push({ pubkey: reference, isSigner: false, isWritable: false });

  if (quote.provider === 'devnet_harness') {
    // Jupiter has no devnet, so the devnet "route" is the harness's fixed-rate
    // provider: the input leg goes to the provider's liquidity wallet and the
    // USDC leg goes to the treasury, in one atomic transaction. Same shape,
    // same verification, same failure modes as the routed mainnet transaction
    // — minus the on-chain minimum-out, which is Jupiter's program, not ours.
    if (!quote.liquidity_wallet) throw new Error('quote_missing_liquidity_wallet');

    const inputMint = new PublicKey(quote.input_mint);
    const usdcMint = new PublicKey(intent.usdc_mint);
    const treasuryOwner = new PublicKey(intent.treasury_address);
    const liquidityOwner = new PublicKey(quote.liquidity_wallet);

    // Recipients allow off-curve owners (a treasury or liquidity account could
    // be a PDA); the payer is the connected wallet and must be a real key.
    const [fromInputAta, toInputAta, fromUsdcAta, toUsdcAta] = await Promise.all([
      spl.getAssociatedTokenAddress(inputMint, payer),
      spl.getAssociatedTokenAddress(inputMint, liquidityOwner, true),
      spl.getAssociatedTokenAddress(usdcMint, payer),
      spl.getAssociatedTokenAddress(usdcMint, treasuryOwner, true),
    ]);

    const inputIx = spl.createTransferCheckedInstruction(
      fromInputAta,
      inputMint,
      toInputAta,
      payer,
      BigInt(quote.quoted_input_raw),
      quote.input_decimals,
    );
    const usdcIx = spl.createTransferCheckedInstruction(
      fromUsdcAta,
      usdcMint,
      toUsdcAta,
      payer,
      BigInt(quote.usdc_out_raw),
      intent.usdc_decimals,
    );

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
    tx.add(inputIx);
    tx.add(usdcIx);
    tx.add(referenceIx);
    tx.feePayer = payer;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    const { signature } = await wallet.signAndSendTransaction(tx);
    return { signature };
  }

  // Jupiter: rebuild the relayed instructions into a v0 transaction. Routes
  // carry accounts via address lookup tables, which a legacy Transaction
  // cannot express. Dead code on devnet today (the quote endpoint only issues
  // jupiter quotes on mainnet, and browserRpc refuses mainnet) — exercised by
  // unit tests until mainnet activation configures a browser RPC.
  const { TransactionMessage, VersionedTransaction } = web3;
  if (!quote.instructions) throw new Error('quote_missing_instructions');

  // base64 → bytes with the browser's own atob, NOT Node's Buffer — the same
  // assumption that once broke every chip purchase (see bufferShim.ts and the
  // runtimeAssumptions test that now forbids it). The cast is safe: web3.js
  // only ever reads instruction data as bytes.
  const base64ToBytes = (b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
  const rebuild = (ix: RelayedInstruction) =>
    new web3.TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map((a) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      data: base64ToBytes(ix.data) as unknown as Buffer,
    });

  const instructions = [
    ...quote.instructions.compute_budget.map(rebuild),
    ...quote.instructions.setup.map(rebuild),
    rebuild(quote.instructions.swap),
    ...(quote.instructions.cleanup ? [rebuild(quote.instructions.cleanup)] : []),
    referenceIx,
  ];

  const tables = (
    await Promise.all(
      (quote.address_lookup_table_addresses ?? []).map((addr) =>
        connection.getAddressLookupTable(new PublicKey(addr)),
      ),
    )
  )
    .map((r) => r.value)
    .filter((v): v is NonNullable<typeof v> => v != null);

  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(tables);
  const tx = new VersionedTransaction(message);

  const { signature } = await wallet.signAndSendTransaction(tx);
  return { signature };
}

/** Reads the connected Solana wallet from the browser. Null means no wallet.
 *  Not held in state: the wallet extension owns it; we only borrow it. */
export function getBrowserSolanaWallet(): WalletLike | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { solana?: WalletLike };
  if (!w.solana || typeof w.solana.signAndSendTransaction !== 'function') return null;
  return w.solana;
}
