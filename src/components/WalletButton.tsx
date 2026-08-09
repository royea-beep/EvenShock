import { useState } from 'react';
import type { AuthState } from '../hooks/useAuth';
import { shortenAddress } from '../data/wallet';

/**
 * Wallet connect / signed-in status. Fixed to the top-right corner as a small
 * pill; it never blocks gameplay and never opens a modal — the wallet's own
 * extension provides the sign-in UI.
 *
 * Renders NOTHING when Supabase is unconfigured (auth.status ===
 * 'unconfigured'), so a local checkout without .env behaves like the shipped
 * no-auth app.
 *
 * The two states worth distinguishing visually:
 *   - guest / connecting: primary CTA colour, "Connect wallet"
 *   - authenticated: neutral, showing the shortened address + a click-through
 *     to disconnect
 */
export function WalletButton({ auth }: { auth: AuthState }) {
  const [feedback, setFeedback] = useState<string | null>(null);

  if (auth.status === 'unconfigured') return null;

  const onConnect = async () => {
    setFeedback(null);
    const r = await auth.connect();
    if (r.kind === 'no-wallet') setFeedback('No wallet extension detected');
    else if (r.kind === 'rejected') setFeedback('Sign-in cancelled');
    else if (r.kind === 'error') setFeedback(r.message);
  };

  if (auth.status === 'authenticated' && auth.address) {
    return (
      <div className="fixed right-4 top-[7.5rem] z-40 flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => void auth.disconnect()}
          title="Disconnect wallet"
          style={{
            borderRadius: 'var(--radius-themed-md)',
            borderWidth: 'var(--border-width)',
            borderColor: 'var(--border-color)',
            borderStyle: 'var(--border-style)',
          }}
          className="display-type cursor-pointer bg-elevated px-3 py-1.5 text-xs font-semibold text-ink hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          {shortenAddress(auth.address)}
        </button>
      </div>
    );
  }

  const label =
    auth.status === 'connecting'
      ? 'Connecting…'
      : auth.status === 'error'
        ? 'Retry connect'
        : 'Connect wallet';

  return (
    <div className="fixed right-4 top-[7.5rem] z-40 flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onConnect}
        disabled={auth.status === 'connecting'}
        style={{
          borderRadius: 'var(--radius-themed-md)',
          borderWidth: 'var(--border-width)',
          borderColor: 'var(--border-color)',
          borderStyle: 'var(--border-style)',
        }}
        className="display-type cursor-pointer bg-scissors px-3 py-1.5 text-xs font-semibold text-scissors-ink hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current disabled:cursor-wait"
      >
        {label}
      </button>
      {feedback && (
        <p
          role="status"
          className="max-w-[10rem] rounded bg-black/70 px-2 py-1 text-right text-[0.65rem] text-white"
        >
          {feedback}
        </p>
      )}
    </div>
  );
}
