import { describe, expect, it } from 'vitest';
import { resumeDecision } from './useRounds';

/**
 * Crash-resume exists for exactly one player: signed in, reloaded between
 * committing a move and seeing the answer. That was the one case it never
 * handled.
 *
 * `authenticated` is false during the auth bootstrap AND false for a guest, so
 * the effect ran on first render, took the committed round out of
 * sessionStorage, and handed it to the LOCAL api — which has no memory of a
 * server round and threw `not_found` into a swallowing catch. When auth
 * settled and the effect re-ran with the server api, the key was gone.
 *
 * The property that fixes it is that WAITING and DROPPING are different
 * answers. Consuming the key before we know who the player is destroys the
 * evidence, and no amount of care further down can get it back.
 */
describe('crash-resume decision', () => {
  const d = (authResolved: boolean, authenticated: boolean, hasCommitted = true) =>
    resumeDecision({ authResolved, authenticated, hasCommitted });

  it('waits while auth is still resolving, and does not consume the key', () => {
    // The bug, stated as a test: during the bootstrap a signed-in player looks
    // exactly like a guest, so the only safe answer is to do nothing yet.
    expect(d(false, false)).toBe('wait');
    expect(d(false, true)).toBe('wait');
  });

  it('submits once auth resolves to a signed-in player', () => {
    expect(d(true, true)).toBe('submit');
  });

  it('drops the key for a settled guest', () => {
    // A guest's rounds lived in memory and died with the page. Nothing can
    // resume them, and leaving the key would confuse a later sign-in on this
    // browser.
    expect(d(true, false)).toBe('drop');
  });

  it('does nothing when there is nothing stored, whatever auth says', () => {
    expect(d(true, true, false)).toBe('wait');
    expect(d(false, false, false)).toBe('wait');
    expect(d(true, false, false)).toBe('wait');
  });
});
