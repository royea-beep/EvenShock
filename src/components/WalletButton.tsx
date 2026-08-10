import { useEffect, useState } from 'react';
import type { AuthState } from '../hooks/useAuth';
import { detectWallet, shortenAddress } from '../data/wallet';
import { isSupabaseConfigured, getSupabase } from '../data/supabaseClient';
import { copy } from '../constants/copy';

/**
 * Wallet connect UI and — crucially — the surface where every failure mode
 * becomes visible. The last iteration hid its failure feedback in a 10px
 * pill that a real first-time visitor missed; every state now surfaces
 * loudly, and nothing about a click ever produces "no visible change".
 *
 * States rendered:
 *   - unconfigured (Supabase env missing): renders nothing.
 *   - guest, wallet detected: primary CTA "Connect wallet".
 *   - guest, NO wallet detected: CTA still visible, with a permanent hint
 *     under the button telling the visitor to install one, plus a popover
 *     with direct install links on click.
 *   - connecting: CTA disabled with "Connecting…" and a spinner-style dot.
 *   - error: prominent red banner with the actual error text and a retry.
 *   - authenticated: shortened address, click to disconnect.
 *
 * Diagnostic panel (visible when the button is present) shows env config,
 * client init, and wallet detection — so a visitor who doesn't understand
 * why nothing is happening can at least see WHAT is happening.
 */
export function WalletButton({
  auth,
  guestHasProgress = false,
}: {
  auth: AuthState;
  /**
   * True when this browser holds guest XP or chips that connecting will NOT
   * carry across. Drives the notice below.
   */
  guestHasProgress?: boolean;
}) {
  const [popover, setPopover] = useState<PopoverState>(null);
  const [detected] = useState(() => detectWallet());
  const [showDiag, setShowDiag] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Auto-dismiss the popover after a beat so the corner doesn't stay occupied
  // once the user has read it. Long enough to read (Phantom install link
  // needs a click too), short enough to disappear if ignored.
  useEffect(() => {
    if (!popover) return;
    const id = window.setTimeout(() => setPopover(null), 15000);
    return () => window.clearTimeout(id);
  }, [popover]);

  if (auth.status === 'unconfigured') return null;

  /**
   * Connecting starts a fresh account and does NOT bring guest progress with
   * it. Migrating it would be a free-tokens exploit — clear the browser,
   * replay, claim again — so the balance stays where it was earned.
   *
   * That has to be said BEFORE the wallet dialog opens, because afterwards it
   * reads as an excuse. Only asked when there is actually something to lose;
   * a player with nothing earned gets no friction.
   */
  const onConnectPressed = () => {
    if (guestHasProgress) {
      setConfirming(true);
      return;
    }
    void onConnect();
  };

  const onConnect = async () => {
    setConfirming(false);
    setPopover(null);
    // Client-side pre-check: if we already know there's no wallet, skip the
    // signInWithWeb3 call and go straight to the install popover.
    if (detected.kind === 'none') {
      setPopover({ kind: 'no-wallet' });
      return;
    }
    const r = await auth.connect();
    if (r.kind === 'no-wallet') setPopover({ kind: 'no-wallet' });
    else if (r.kind === 'rejected') setPopover({ kind: 'rejected' });
    else if (r.kind === 'error') setPopover({ kind: 'error', message: r.message });
  };

  // -------------------------------------------------- authenticated view
  if (auth.status === 'authenticated' && auth.address) {
    return (
      <div className="fixed right-4 top-[7.5rem] z-40 flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => void auth.disconnect()}
          title="Disconnect wallet"
          style={pillStyle}
          className="display-type cursor-pointer bg-elevated px-3 py-1.5 text-xs font-semibold text-ink hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          {shortenAddress(auth.address)}
        </button>
      </div>
    );
  }

  // ------------------------------------------------- guest / error view
  const label =
    auth.status === 'connecting'
      ? 'Connecting…'
      : auth.status === 'error'
        ? 'Retry connect'
        : 'Connect wallet';

  return (
    <div className="fixed right-4 top-[7.5rem] z-40 flex max-w-[16rem] flex-col items-end gap-2">
      {/* Said before the wallet dialog, never after. */}
      {confirming && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="guest-notice-title"
          style={pillStyle}
          className="w-64 bg-elevated p-3 text-left"
        >
          <p id="guest-notice-title" className="display-type text-sm font-bold text-ink">
            {copy.economy.connectNoticeTitle}
          </p>
          <p className="mt-1 text-xs leading-snug text-muted">
            {copy.economy.connectNoticeBody}
          </p>
          <div className="mt-3 flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => void onConnect()}
              style={pillStyle}
              className="display-type min-h-9 cursor-pointer bg-scissors px-3 text-xs font-bold text-scissors-ink"
            >
              {copy.economy.connectNoticeConfirm}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              style={pillStyle}
              className="display-type min-h-9 cursor-pointer px-3 text-xs font-semibold text-ink"
            >
              {copy.economy.connectNoticeCancel}
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onConnectPressed}
        disabled={auth.status === 'connecting'}
        style={pillStyle}
        className="display-type cursor-pointer bg-scissors px-3 py-1.5 text-xs font-semibold text-scissors-ink hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current disabled:cursor-wait"
      >
        {label}
      </button>

      {/* Permanent wallet-detection hint: visible without any click, so a
          visitor with no wallet installed knows immediately WHY the CTA
          won't do anything useful. Yellow instead of red because "you need
          to install this" is not an error, it's a next step. */}
      {detected.kind === 'none' && auth.status === 'guest' && !popover && (
        <div className="rounded-md bg-amber-100 px-2 py-1.5 text-right text-xs font-medium text-amber-900 shadow">
          No wallet extension. Install one to connect.
        </div>
      )}

      {/* Popovers — one per failure kind. All larger than the previous pill
          (text-xs / text-sm, not text-[0.65rem]) and colored. */}
      {popover?.kind === 'no-wallet' && (
        <NoWalletPopover onDismiss={() => setPopover(null)} />
      )}
      {popover?.kind === 'rejected' && (
        <SimplePopover onDismiss={() => setPopover(null)} tone="neutral">
          Sign-in was cancelled.
        </SimplePopover>
      )}
      {popover?.kind === 'error' && (
        <SimplePopover onDismiss={() => setPopover(null)} tone="error">
          <p className="font-semibold">Sign-in failed</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{popover.message}</p>
        </SimplePopover>
      )}

      {/* Persistent auth-error banner from useAuth (separate from the
          click-driven popover — this catches errors from anywhere in the
          flow, e.g. the initial session bootstrap). */}
      {auth.error && !popover && (
        <SimplePopover onDismiss={() => setShowDiag((s) => !s)} tone="error">
          <p className="font-semibold">Auth error</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{auth.error}</p>
        </SimplePopover>
      )}

      {/* Diagnostic toggle: visible once expanded, shows env/client/wallet
          state so a visitor confused about "nothing happened" has a
          truthful account of what the app can see. */}
      <button
        type="button"
        onClick={() => setShowDiag((s) => !s)}
        className="cursor-pointer text-[0.65rem] text-muted underline decoration-dotted hover:text-ink"
      >
        {showDiag ? 'hide' : 'why?'}
      </button>
      {showDiag && <DiagnosticPanel detected={detected} status={auth.status} />}
    </div>
  );
}

// ---------------------------------------------------------------- popovers

type PopoverState =
  | { kind: 'no-wallet' }
  | { kind: 'rejected' }
  | { kind: 'error'; message: string }
  | null;

const pillStyle = {
  borderRadius: 'var(--radius-themed-md)',
  borderWidth: 'var(--border-width)',
  borderColor: 'var(--border-color)',
  borderStyle: 'var(--border-style)',
};

function NoWalletPopover({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="rounded-md bg-amber-100 p-3 text-right text-xs text-amber-900 shadow-lg">
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-sm">No wallet detected</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-amber-900 hover:text-black"
        >
          ×
        </button>
      </div>
      <p className="mt-1.5">
        Install a wallet extension to connect. EvenShock supports both:
      </p>
      <ul className="mt-2 space-y-1.5 text-left">
        <li>
          <a
            href="https://phantom.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline hover:text-black"
          >
            Phantom
          </a>{' '}
          <span className="text-amber-800">(Solana)</span>
        </li>
        <li>
          <a
            href="https://metamask.io/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline hover:text-black"
          >
            MetaMask
          </a>{' '}
          <span className="text-amber-800">(Ethereum)</span>
        </li>
      </ul>
      <p className="mt-2 text-[0.65rem] text-amber-800">
        Reload the page after installing.
      </p>
    </div>
  );
}

function SimplePopover({
  children,
  onDismiss,
  tone,
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  tone: 'error' | 'neutral';
}) {
  const cls =
    tone === 'error'
      ? 'bg-red-100 text-red-900'
      : 'bg-slate-100 text-slate-900';
  return (
    <div className={`rounded-md p-3 text-right text-xs shadow-lg ${cls}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 text-left">{children}</div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="hover:text-black"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function DiagnosticPanel({
  detected,
  status,
}: {
  detected: ReturnType<typeof detectWallet>;
  status: AuthState['status'];
}) {
  const client = getSupabase();
  const rows: Array<[string, string, boolean]> = [
    ['env configured', isSupabaseConfigured() ? 'yes' : 'no', isSupabaseConfigured()],
    ['client initialised', client ? 'yes' : 'no', Boolean(client)],
    [
      'wallet detected',
      detected.kind === 'available' ? detected.chain : 'no extension',
      detected.kind === 'available',
    ],
    ['auth status', status, status !== 'error' && status !== 'unconfigured'],
  ];
  return (
    <div className="rounded-md bg-slate-900/95 p-2.5 text-left text-[0.7rem] text-white shadow-lg" style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>
      <p className="mb-1.5 font-semibold text-slate-300">wallet diagnostics</p>
      <table className="w-full">
        <tbody>
          {rows.map(([label, value, ok]) => (
            <tr key={label}>
              <td className="pr-2 text-slate-400">{label}</td>
              <td className={ok ? 'text-emerald-300' : 'text-amber-300'}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
