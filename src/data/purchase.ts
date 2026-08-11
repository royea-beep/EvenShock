import type { SupabaseClient } from '@supabase/supabase-js';

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
      'id, quote_expires_at, cluster, treasury_address, usdc_mint, usdc_decimals, chips_per_usdc, expected_usdc, reference, status',
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

/** Reads the connected Solana wallet from the browser. Null means no wallet.
 *  Not held in state: the wallet extension owns it; we only borrow it. */
export function getBrowserSolanaWallet(): WalletLike | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { solana?: WalletLike };
  if (!w.solana || typeof w.solana.signAndSendTransaction !== 'function') return null;
  return w.solana;
}
