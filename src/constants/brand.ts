/**
 * Everything a second operator has to change to run this game as their own.
 *
 * WHY THIS FILE EXISTS. The B2B posture is that a licensee configures the
 * product; they do not fork it. Anything an operator must edit in source is a
 * defect in that posture, because it means their deployment diverges from ours
 * on day one and every later fix has to be merged by hand.
 *
 * Three things were hard-coded before this file and are now config:
 *
 *   THE SHARE ORIGIN, which is the worse of the three by a distance. Invite
 *   links are built from it, so a licensee shipping without changing it would
 *   send every one of their players' invitations to OUR domain — their
 *   acquisition, landing on someone else's game.
 *
 *   THE BRAND NAME, which also appears in the wallet's sign-in prompt. A
 *   player approving "Sign in to EvenShock" in a wallet popup on an operator's
 *   own-branded site is a trust failure at the exact moment trust matters.
 *
 *   THE SUPPORT CONTACT, which a regulator expects a player-facing product to
 *   carry and which cannot be ours on a licensee's deployment.
 *
 * Read from `import.meta.env` so Vite inlines them at build time — same
 * mechanism as the feature flags. Each falls back to the reference
 * deployment's value, so an unconfigured build still runs; the fallback is a
 * default, never a requirement.
 */

/** Display name, used in copy, the share line and the wallet sign-in prompt. */
export const BRAND_NAME: string = import.meta.env.VITE_BRAND_NAME || 'EvenShock';

/**
 * Where a shared or invited player lands. MUST be the operator's own origin.
 *
 * Deliberately not `window.location.origin`: someone playing on a preview host
 * or a local dev port would otherwise invite their friends there. An explicit
 * value is the only one that is right in every environment.
 */
export const SHARE_ORIGIN: string =
  import.meta.env.VITE_SHARE_ORIGIN || 'https://ftable.co.il/evenshock/';

/** Where a player takes a problem. Empty hides the line rather than showing a
 *  dead address — a support contact that does not answer is worse than none. */
export const SUPPORT_CONTACT: string = import.meta.env.VITE_SUPPORT_CONTACT || '';

/** The sign-in message a wallet shows before it signs. Carries the brand and
 *  the origin so the popup names the site the player is actually on. */
export function signInStatement(): string {
  return `Sign in to ${BRAND_NAME}.`;
}
