import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Lazy singleton Supabase client, or null when the env is not configured.
 *
 * Guest mode is the default the moment either env var is missing — no client
 * is constructed, no wallet button renders, no code path calls out. That means
 * a checkout without .env behaves exactly like the shipped no-auth app and can
 * still be dev-run and built.
 *
 * The env vars ARE static: Vite inlines them at build time. So checking once
 * at module load is sufficient; there is no case where they change at runtime.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (client) return client;
  if (!url || !key) return null;
  client = createClient(url, key, {
    auth: {
      // Persist the session in localStorage so the wallet connection survives
      // a page reload without asking for another signature.
      persistSession: true,
      // The wallet-flow returns a session directly; there is no OAuth redirect
      // to detect, so this is off for a small perf win at boot.
      detectSessionInUrl: false,
      autoRefreshToken: true,
    },
  });
  return client;
}

/** True when the env is configured. Convenient guard for conditional UI. */
export function isSupabaseConfigured(): boolean {
  return Boolean(url && key);
}
