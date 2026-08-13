/**
 * Sharing helpers — match result lines and friend-invite URLs.
 *
 * SHARE_ORIGIN is the URL a recipient lands on. Deliberately a static string
 * rather than `window.location.origin`: someone who saw the game on a preview
 * host or a local dev port should not accidentally invite friends there.
 *
 * The invite URL is a query-string form (`?invite=CODE`) rather than a path
 * one (`/invite/CODE`) so the site works with plain static hosting and no
 * rewrites — the router doesn't have to know about a new segment, and
 * copy-paste into a plain-text channel is not mangled by trailing punctuation.
 */

export const SHARE_ORIGIN = 'https://ftable.co.il/evenshock/';

const INVITE_PARAM = 'invite';

export function buildInviteUrl(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return SHARE_ORIGIN;
  const url = new URL(SHARE_ORIGIN);
  url.searchParams.set(INVITE_PARAM, trimmed.toUpperCase());
  return url.toString();
}

/**
 * Reads an invite code from `?invite=CODE` in the current URL, if present.
 * Absent, malformed and empty all return null; the caller treats any non-null
 * value as "prefill the join field". Deliberately does NOT auto-join — a
 * signed-out or partially-connected visitor tapping a shared link should see
 * the join screen with the code filled, not a race between wallet-connect and
 * seat-take.
 */
export function readInviteCodeFromUrl(location: { search: string } = window.location): string | null {
  if (typeof URLSearchParams === 'undefined') return null;
  const params = new URLSearchParams(location.search);
  const raw = params.get(INVITE_PARAM);
  if (!raw) return null;
  const cleaned = raw.trim().toUpperCase();
  // Invite codes are 8-character alphanumerics on the server; be lax here so a
  // future length change doesn't quietly stop reading them.
  if (!/^[A-Z0-9]{4,16}$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Match result text, ready for pasting anywhere. Appends the site URL so a
 * recipient who taps it lands on the game — the ONE step every viral share
 * has to do, and the one the previous text was missing. Plain text, no
 * markdown, no emoji beyond the outcome marks the app already uses in its
 * history trail. Every element is optional-friendly: a missing history still
 * produces a coherent line.
 */
export function buildShareLine(input: {
  headline: string;
  scoreLine: string;
  trail?: string;
  formatLabel: string;
}): string {
  return [
    `EvenShock — ${input.formatLabel}`,
    `${input.headline} ${input.scoreLine}`,
    input.trail ?? '',
    SHARE_ORIGIN,
  ]
    .filter(Boolean)
    .join('\n');
}
