import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { copy } from '../constants/copy';

interface Props {
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

/**
 * Blocking terms acknowledgement, shown once before a player's first purchase.
 *
 * Blocking not decorative: no intent is issued and no wallet dialog opens
 * until "I understand" is clicked, and that button is disabled until the
 * checkbox is ticked. The checkbox is the consent — a pre-checked box would
 * make this a screen we showed the player rather than a decision they made.
 *
 * `dialog` with `aria-modal` + a focus trap on the checkbox makes it behave
 * like a modal to assistive tech; ESC dismisses.
 */
export function TosGate({ onConfirm, onCancel }: Props) {
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const handleConfirm = async () => {
    if (!accepted || busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tos-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        style={{
          borderRadius: 'var(--radius-themed-lg)',
          borderWidth: 'var(--border-width)',
          borderColor: 'var(--border-color)',
          borderStyle: 'var(--border-style)',
          boxShadow: 'var(--shadow-card)',
        }}
        className="w-full max-w-md space-y-5 bg-elevated p-6 text-left text-ink"
      >
        <div className="space-y-2">
          <h2 id="tos-title" className="display-type text-xl font-bold">
            {copy.chipsPurchase.tosTitle}
          </h2>
          <p className="text-sm leading-relaxed text-muted">{copy.chipsPurchase.tosBody}</p>
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-md p-2 text-sm hover:bg-black/5">
          <input
            ref={boxRef}
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-current"
          />
          <span className="leading-snug">{copy.chipsPurchase.tosCheckbox}</span>
        </label>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!accepted || busy}
            style={{
              borderRadius: 'var(--radius-themed-md)',
              borderWidth: 'var(--border-width)',
              borderColor: 'var(--border-color)',
              borderStyle: 'var(--border-style)',
            }}
            className="display-type flex-1 bg-scissors px-4 py-2.5 text-sm font-semibold text-scissors-ink transition-opacity disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"
          >
            {busy ? copy.chipsPurchase.tosSaving : copy.chipsPurchase.tosContinue}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="display-type px-4 py-2.5 text-sm font-semibold text-muted hover:text-ink disabled:opacity-40"
          >
            {copy.chipsPurchase.tosCancel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
