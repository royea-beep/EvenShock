import { useEffect, useRef } from 'react';
import type { MatchFormat } from '../types/game';
import type { ThemeId } from '../constants/themes';
import { isThemeId } from '../constants/themes';
import { getSupabase } from '../data/supabaseClient';
import type { AuthState } from './useAuth';

/**
 * Prefs migration on first sign-in.
 *
 * The schema comment on `profiles` treats existing per-preference localStorage
 * keys (theme, format, fast) as the migration source: "migrated from
 * localStorage on first sign-in rather than discarded". Those columns are
 * nullable exactly so "never chose" stays distinguishable from "chose the
 * default", which is what tells this migration whether to write the local
 * value up or to pull the profile value down.
 *
 * The rule per column:
 *   - profile has NULL: write the current local value up (migration).
 *   - profile has a value: apply it to app state (sync down).
 *
 * Runs once per session. De-duped on the session's user id — a sign-out and
 * back in as the same user would re-run, which is the right behaviour if
 * profile columns have since been cleared, and the wrong behaviour is
 * essentially unreachable in practice.
 *
 * If profile access fails for any reason (RLS surprise, network hiccup, row
 * doesn't exist yet), the hook logs and stops. It never overwrites local
 * state with a partial or unclear read; the local defaults keep working.
 */

interface Options {
  auth: AuthState;
  theme: ThemeId;
  format: MatchFormat;
  fast: boolean;
  setTheme: (t: ThemeId) => void;
  setFormat: (f: MatchFormat) => void;
  setFast: (b: boolean) => void;
}

const isFormat = (v: unknown): v is MatchFormat => v === 'single' || v === 'bo3' || v === 'bo5';

export function usePrefsMigration({ auth, theme, format, fast, setTheme, setFormat, setFast }: Options): void {
  // Track which user id we've already migrated for, so a re-render or an
  // auth state refresh with the same session doesn't re-run the whole flow.
  const migratedUserRef = useRef<string | null>(null);

  // Capture the current LOCAL values in a ref so the effect can read them
  // without re-firing every time they change — the migration is one-shot per
  // sign-in and depends only on the sign-in transition.
  const currentRef = useRef({ theme, format, fast });
  currentRef.current = { theme, format, fast };

  useEffect(() => {
    if (auth.status !== 'authenticated' || !auth.session) return;
    const userId = auth.session.user.id;
    if (migratedUserRef.current === userId) return;

    const client = getSupabase();
    if (!client) return;

    // Mark BEFORE the async call — if the effect re-runs while the fetch is
    // in flight (React strict mode fires effects twice), the second run must
    // not start a duplicate request.
    migratedUserRef.current = userId;

    void (async () => {
      try {
        // The trigger on auth.identities normally creates the profile row,
        // but there is a race window on the very first sign-in AND some
        // pre-migration accounts have no row. ensure_profile() covers both.
        await client.rpc('ensure_profile');

        const { data, error } = await client
          .from('profiles')
          .select('preferred_theme, preferred_format, fast_mode')
          .eq('id', userId)
          .single();

        if (error || !data) {
          // eslint-disable-next-line no-console
          console.warn('[prefs] migration: profile read failed', error);
          return;
        }

        const current = currentRef.current;
        const patch: Record<string, string | boolean> = {};

        // Theme
        if (data.preferred_theme === null) {
          patch.preferred_theme = current.theme;
        } else if (isThemeId(data.preferred_theme)) {
          if (data.preferred_theme !== current.theme) setTheme(data.preferred_theme);
        }
        // Format
        if (data.preferred_format === null) {
          patch.preferred_format = current.format;
        } else if (isFormat(data.preferred_format)) {
          if (data.preferred_format !== current.format) setFormat(data.preferred_format);
        }
        // Fast mode
        if (data.fast_mode === null) {
          patch.fast_mode = current.fast;
        } else if (typeof data.fast_mode === 'boolean') {
          if (data.fast_mode !== current.fast) setFast(data.fast_mode);
        }

        if (Object.keys(patch).length > 0) {
          const { error: upErr } = await client.from('profiles').update(patch).eq('id', userId);
          if (upErr) {
            // eslint-disable-next-line no-console
            console.warn('[prefs] migration: profile write failed', upErr);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[prefs] migration: unexpected error', err);
      }
    })();
  }, [auth.status, auth.session, setTheme, setFormat, setFast]);
}
