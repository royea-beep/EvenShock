import type { SupabaseClient, Session } from '@supabase/supabase-js';

/**
 * The wallet client wraps `supabase.auth.signInWithWeb3()`.
 *
 * That method already handles the whole flow: it constructs the Sign-In With
 * X message, asks the wallet extension to sign it, submits the signature to
 * Supabase Auth, and returns a session. So this file is thin — it detects
 * which wallet the browser exposes, hands the SDK the corresponding chain,
 * and surfaces the errors that matter as typed values instead of thrown
 * exceptions.
 *
 * The wallet address becomes trusted only AFTER the signature is verified
 * server-side; on success, the trigger in migrations copies it out of
 * auth.identities into profiles.wallet_address. Nothing this file returns
 * should be treated as authoritative — always read the address off the
 * session that Supabase returned.
 */

/** Detected wallet types. Order matters — Solana is preferred when both are
 *  present because signInWithWeb3 for Solana is the more mature path in the
 *  installed SDK version. */
export type WalletChain = 'solana' | 'ethereum';

export type WalletDetectResult =
  | { kind: 'available'; chain: WalletChain }
  | { kind: 'none' };

export function detectWallet(): WalletDetectResult {
  if (typeof window === 'undefined') return { kind: 'none' };
  const w = window as unknown as { solana?: unknown; ethereum?: unknown };
  if (w.solana) return { kind: 'available', chain: 'solana' };
  if (w.ethereum) return { kind: 'available', chain: 'ethereum' };
  return { kind: 'none' };
}

export type ConnectResult =
  | { kind: 'ok'; session: Session }
  | { kind: 'no-wallet' }
  | { kind: 'rejected' } // user dismissed the wallet prompt
  | { kind: 'error'; message: string };

/**
 * Connect + authenticate in one step. Both are always paired: an unsigned
 * connect leaves the client claiming an address the server has not verified,
 * which is exactly what the schema is built to reject.
 *
 * The optional `statement` is included in the Sign-In With Solana message —
 * Phantom (the dominant Solana wallet) requires one; other wallets tolerate
 * it. Ethereum uses the SIWE format under the hood and takes the same field.
 */
export async function connectAndSignIn(
  client: SupabaseClient,
  { statement = 'Sign in to EvenShock.' }: { statement?: string } = {},
): Promise<ConnectResult> {
  const detected = detectWallet();
  if (detected.kind === 'none') return { kind: 'no-wallet' };

  try {
    const result =
      detected.chain === 'solana'
        ? await client.auth.signInWithWeb3({ chain: 'solana', statement })
        : await client.auth.signInWithWeb3({ chain: 'ethereum', statement });

    if (result.error) {
      // Wallet rejections come through as errors — the message shape varies by
      // wallet, so match loosely rather than pin an exact string.
      const msg = result.error.message.toLowerCase();
      if (msg.includes('rejected') || msg.includes('denied') || msg.includes('user') && msg.includes('cancel')) {
        return { kind: 'rejected' };
      }
      return { kind: 'error', message: result.error.message };
    }
    if (!result.data.session) {
      return { kind: 'error', message: 'sign-in returned no session' };
    }
    return { kind: 'ok', session: result.data.session };
  } catch (err) {
    // signInWithWeb3 mostly returns typed errors; a throw usually means the
    // wallet extension itself failed. Treat as a rejection unless the
    // message clearly indicates otherwise.
    const message = err instanceof Error ? err.message : String(err);
    if (/reject|denied|cancel/i.test(message)) return { kind: 'rejected' };
    return { kind: 'error', message };
  }
}

export async function disconnect(client: SupabaseClient): Promise<void> {
  await client.auth.signOut();
}

/** Shortens 0x1234abcd… / 3xY9…f2 addresses for display. Never used as identity. */
export function shortenAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
