/**
 * Every account key a confirmed transaction touched, whatever the encoding
 * and whatever the transaction version.
 *
 * Static keys live in `transaction.message.accountKeys`; a versioned
 * transaction may load more via address lookup tables, which some encodings
 * surface only in `meta.loadedAddresses`. The reference check must see both:
 * our own reference is always appended as a static key, but `reconcile`
 * verifies arbitrary third-party transactions that mention a reference, and a
 * key that travelled through a lookup table is still a binding.
 *
 * Pure and dependency-free so the Node unit suite can drive it with fixtures
 * — the Edge Function itself is Deno-only.
 */
export function collectAccountKeys(tx: {
  transaction?: { message?: { accountKeys?: Array<string | { pubkey: string }> } };
  meta?: { loadedAddresses?: { writable?: string[]; readonly?: string[] } };
}): string[] {
  const keys: string[] = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
    typeof k === 'string' ? k : k.pubkey,
  );
  for (const k of tx.meta?.loadedAddresses?.writable ?? []) keys.push(k);
  for (const k of tx.meta?.loadedAddresses?.readonly ?? []) keys.push(k);
  return keys;
}
