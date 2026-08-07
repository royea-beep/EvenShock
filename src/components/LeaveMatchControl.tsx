import { useEffect, useRef, useState } from 'react';
import { copy } from '../constants/copy';

interface LeaveMatchControlProps {
  /** Returns to Home. Wired to useGame's playAgain, which resets to `idle`. */
  onLeave: () => void;
  /**
   * When true, leaving forfeits a score in progress and asks first. False on
   * the match-end screen, where the match is already over and there is nothing
   * to lose by going back.
   */
  confirmFirst: boolean;
}

/**
 * The only way back to Home from a match. Deliberately pinned to the opposite
 * top corner from the mute toggle and far above the three move buttons, which
 * sit centred and low — a mis-tap during a round should be impossible.
 */
export function LeaveMatchControl({ onLeave, confirmFirst }: LeaveMatchControlProps) {
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const label = confirmFirst ? copy.nav.leaveMatch : copy.nav.backToHome;

  const handleClick = () => {
    if (confirmFirst) setConfirming(true);
    else onLeave();
  };

  const cancel = () => {
    setConfirming(false);
    triggerRef.current?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleClick}
        aria-label={label}
        aria-haspopup={confirmFirst ? 'dialog' : undefined}
        title={label}
        style={{
          borderRadius: 'var(--radius-themed-md)',
          borderWidth: 'var(--border-width)',
          borderColor: 'var(--border-color)',
          borderStyle: 'var(--border-style)',
          boxShadow: 'var(--shadow-card)',
        }}
        className="fixed left-4 top-4 z-40 flex h-11 w-11 cursor-pointer items-center justify-center bg-elevated text-ink transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
      >
        <BackIcon />
      </button>

      {confirming && <ConfirmLeave onConfirm={onLeave} onCancel={cancel} />}
    </>
  );
}

function ConfirmLeave({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Open focused on the safe choice, and keep Tab inside the dialog while open.
  useEffect(() => {
    cancelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;

      const focusable = panelRef.current.querySelectorAll<HTMLElement>('button');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      // Scrim is a fixed translucent black rather than a theme token: it has to
      // separate the dialog from eight different page treatments identically.
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-match-title"
        aria-describedby="leave-match-body"
        onClick={(event) => event.stopPropagation()}
        style={{
          borderRadius: 'var(--radius-themed-md)',
          borderWidth: 'var(--border-width)',
          borderColor: 'var(--border-color)',
          borderStyle: 'var(--border-style)',
          boxShadow: 'var(--shadow-card)',
        }}
        className="flex w-full max-w-sm flex-col gap-5 bg-elevated p-6 text-center"
      >
        <div className="space-y-2">
          <h2 id="leave-match-title" className="display-type text-xl font-extrabold text-ink">
            {copy.nav.confirmTitle}
          </h2>
          {/* Primary ink, not muted: muted is toned for the page and card
              surfaces, and lands at 3.3:1 on Retro Pixel's bright elevated
              blue. Measured, not assumed — see themes.css. */}
          <p id="leave-match-body" className="text-sm text-ink">
            {copy.nav.confirmBody}
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            style={{
              borderRadius: 'var(--radius-themed-md)',
              borderWidth: 'var(--border-width)',
              borderColor: 'var(--border-color)',
              borderStyle: 'var(--border-style)',
            }}
            className="display-type flex-1 cursor-pointer bg-scissors px-5 py-3 text-sm font-bold text-scissors-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          >
            {copy.nav.confirmStay}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              borderRadius: 'var(--radius-themed-md)',
              borderWidth: 'var(--border-width)',
              borderColor: 'var(--border-color)',
              borderStyle: 'var(--border-style)',
            }}
            className="display-type flex-1 cursor-pointer bg-elevated px-5 py-3 text-sm font-bold text-ink hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          >
            {copy.nav.confirmLeave}
          </button>
        </div>
      </div>
    </div>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
      <path
        d="M15 5l-7 7 7 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
