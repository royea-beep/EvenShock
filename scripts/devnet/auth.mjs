/**
 * Signing in as a wallet, with no wallet and no browser.
 *
 * The harness needs real user JWTs, and the temptation is to mint them with the
 * service role — which would test a path no player ever takes. Instead it signs
 * in the way the game does: Sign-In With Solana, through
 * `supabase.auth.signInWithWeb3`.
 *
 * The trick is that auth-js's non-browser branch takes a `wallet` object rather
 * than reaching for `window.solana`. So a keypair wearing the two methods
 * auth-js calls IS a wallet as far as it is concerned, and the SIWS message is
 * then constructed by auth-js itself — the identical code the browser runs.
 * Hand-assembling that message would have been a second copy of a format that
 * only fails at the far end, in Auth, with an error that says very little.
 *
 * The payoff is that the harness exercises the real thing: the same grant type,
 * the same verification, and the same provisioning trigger that copies the
 * address into `profiles.wallet_address`.
 */
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';

/**
 * The URL that goes in the signed message. Supabase checks the domain against
 * the project's allowed URLs, so this is the live site rather than localhost.
 */
export const SIWS_URL = process.env.EVENSHOCK_SIWS_URL ?? 'https://ftable.co.il/evenshock/';

/** A keypair, presented as the minimal wallet interface auth-js accepts. */
function walletFor(keypair) {
  return {
    publicKey: { toBase58: () => keypair.publicKey.toBase58() },
    signMessage: async (message) => nacl.sign.detached(message, keypair.secretKey),
  };
}

/**
 * Returns an authenticated client plus the ids, or throws with Auth's own
 * message — which is usually about the URL not being allow-listed.
 */
export async function signInWithKeypair(supabaseUrl, anonKey, keypair, label = 'user') {
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.signInWithWeb3({
    chain: 'solana',
    wallet: walletFor(keypair),
    statement: 'Sign in to EvenShock.',
    options: { url: SIWS_URL },
  });

  if (error) {
    throw new Error(
      `sign-in failed for ${label} (${keypair.publicKey.toBase58()}): ${error.message}\n` +
        `  the signed message names ${SIWS_URL}; Supabase Auth rejects a domain that is not in the project's allowed URLs.\n` +
        `  override with EVENSHOCK_SIWS_URL if the project is configured for a different site.`,
    );
  }
  if (!data.session) throw new Error(`sign-in for ${label} returned no session`);

  return {
    client,
    session: data.session,
    userId: data.session.user.id,
    accessToken: data.session.access_token,
    address: keypair.publicKey.toBase58(),
  };
}

/**
 * Calls the `play` Edge Function the way the browser does.
 *
 * Returns status alongside the body rather than throwing, because most of this
 * suite is about refusals — a 409 is frequently the passing result, and an
 * exception would make the expected case the awkward one to write.
 */
export async function callPlay(supabaseUrl, accessToken, body) {
  const res = await fetch(`${supabaseUrl}/functions/v1/play`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = { error: 'unparseable', status: res.status };
  }
  return { status: res.status, body: json };
}
