import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { copy } from '../constants/copy';
import { TosGate } from './TosGate';
import { getBrowserSolanaWallet } from '../data/purchase';
import type { Purchase } from '../hooks/usePurchase';

interface Props {
  purchase: Purchase;
  /** Only shown to authenticated players. Guests never see this component. */
}

/**
 * The buy button and every modal state around it.
 *
 * The button is intentionally the ONLY entry into the purchase flow, and it is
 * disabled the moment a purchase starts and until it is either credited,
 * refused, or explicitly dismissed. There is no "cancel and retry" affordance
 * anywhere on this component while a payment is in flight — that is the shape
 * of "never invite a retry mid-payment" from the outside.
 */
export function ChipsShop({ purchase }: Props) {
  const wallet = getBrowserSolanaWallet();
  const { state } = purchase;

  return (
    <section
      aria-label="Buy chips"
      // Sits directly under the balance so the price sits next to the number
      // it changes; not tucked into a menu.
      className="mx-auto w-full max-w-md"
    >
      <div
        style={{
          borderRadius: 'var(--radius-themed-lg)',
          borderWidth: 'var(--border-width)',
          borderColor: 'var(--border-color)',
          borderStyle: 'var(--border-style)',
        }}
        className="flex flex-col items-center gap-2 bg-elevated p-4 text-center"
      >
        <div className="space-y-0.5">
          <p className="display-type text-sm font-semibold text-ink">
            {copy.chipsPurchase.buyTitle}
          </p>
          <p className="text-xs text-muted">{copy.chipsPurchase.buyPrice}</p>
        </div>

        <motion.button
          type="button"
          onClick={purchase.buy}
          disabled={purchase.busy || !wallet}
          whileHover={purchase.busy || !wallet ? undefined : { scale: 1.02 }}
          whileTap={purchase.busy || !wallet ? undefined : { scale: 0.97 }}
          style={{
            borderRadius: 'var(--radius-themed-md)',
            borderWidth: 'var(--border-width)',
            borderColor: 'var(--border-color)',
            borderStyle: 'var(--border-style)',
          }}
          className="display-type mt-1 cursor-pointer bg-scissors px-6 py-2.5 text-sm font-bold text-scissors-ink transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current disabled:cursor-not-allowed disabled:opacity-40"
        >
          {purchase.busy ? copy.chipsPurchase.buyButtonBusy : copy.chipsPurchase.buyButton}
        </motion.button>

        {!wallet && (
          <p className="text-xs text-muted">{copy.chipsPurchase.walletMissing}</p>
        )}
      </div>

      <AnimatePresence>
        {state.kind === 'tos' && (
          <TosGate onConfirm={purchase.confirmTos} onCancel={purchase.dismiss} />
        )}
        {state.kind === 'resume' && <ResumeModal purchase={purchase} />}
        {(state.kind === 'wallet' ||
          state.kind === 'sending' ||
          state.kind === 'pending') && <PendingModal purchase={purchase} />}
        {state.kind === 'credited' && <CreditedModal purchase={purchase} />}
        {state.kind === 'failed' && <FailedModal purchase={purchase} />}
      </AnimatePresence>
    </section>
  );
}

// ---------------------------------------------------------------- modals

function Overlay({ children, labelledBy }: { children: React.ReactNode; labelledBy: string }) {
  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
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
        {children}
      </motion.div>
    </motion.div>
  );
}

function ResumeModal({ purchase }: { purchase: Purchase }) {
  return (
    <Overlay labelledBy="resume-title">
      <div className="space-y-2">
        <h2 id="resume-title" className="display-type text-xl font-bold">
          {copy.chipsPurchase.resumeTitle}
        </h2>
        <p className="text-sm leading-relaxed text-muted">{copy.chipsPurchase.resumeBody}</p>
      </div>
      <div className="flex flex-col gap-2">
        <PrimaryButton onClick={() => void purchase.checkExisting()}>
          {copy.chipsPurchase.resumeCheckStatus}
        </PrimaryButton>
        <SecondaryButton onClick={() => void purchase.resumeExisting()}>
          {copy.chipsPurchase.resumePayNow}
        </SecondaryButton>
        <SecondaryButton onClick={() => void purchase.startNew()}>
          {copy.chipsPurchase.resumeStartNew}
        </SecondaryButton>
      </div>
    </Overlay>
  );
}

function PendingModal({ purchase }: { purchase: Purchase }) {
  const { state } = purchase;
  const showsSlowCopy = useSlowPendingFlip(
    state.kind === 'pending' ? state.startedAt : null,
  );

  const label =
    state.kind === 'wallet'
      ? copy.chipsPurchase.walletBusy
      : state.kind === 'sending'
        ? copy.chipsPurchase.sending
        : copy.chipsPurchase.pendingTitle;

  const body =
    state.kind === 'pending'
      ? showsSlowCopy
        ? copy.chipsPurchase.pendingSlowBody
        : copy.chipsPurchase.pendingBody
      : null;

  return (
    <Overlay labelledBy="pending-title">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Spinner />
          <h2 id="pending-title" className="display-type text-lg font-bold">
            {label}
          </h2>
        </div>
        {body && <p className="text-sm leading-relaxed text-muted">{body}</p>}
      </div>
      {/* No cancel button. This is the whole point — a payment in flight has
          no retry affordance. `dismiss` is only available at the failure or
          credited end-states below. */}
    </Overlay>
  );
}

function CreditedModal({ purchase }: { purchase: Purchase }) {
  const { state } = purchase;
  if (state.kind !== 'credited') return null;
  return (
    <Overlay labelledBy="credited-title">
      <div className="space-y-2">
        <h2 id="credited-title" className="display-type text-xl font-bold">
          {copy.chipsPurchase.credited(state.chipsCredited)}
        </h2>
      </div>
      <div className="flex justify-end">
        <PrimaryButton onClick={purchase.acknowledge}>
          {copy.chipsPurchase.creditedClose}
        </PrimaryButton>
      </div>
    </Overlay>
  );
}

function FailedModal({ purchase }: { purchase: Purchase }) {
  const { state } = purchase;
  if (state.kind !== 'failed') return null;
  // The whole point of `signed`: a failure before the wallet signed cost the
  // player nothing, and telling them their money is safe would be reassuring
  // them about something that never happened.
  // Three failures, not two. `wallet_is_treasury` is refused before an intent
  // exists, so it is not merely "unspent" — it is a wallet that can never
  // work, and saying "try again" would send them round the same loop.
  const treasury = state.code === 'wallet_is_treasury';
  const title = treasury
    ? copy.chipsPurchase.walletIsTreasuryTitle
    : state.signed
      ? copy.chipsPurchase.failedTitle
      : copy.chipsPurchase.failedTitleUnspent;
  const body = treasury
    ? copy.chipsPurchase.walletIsTreasuryBody
    : state.signed
      ? copy.chipsPurchase.failedBody
      : copy.chipsPurchase.failedBodyUnspent;
  return (
    <Overlay labelledBy="failed-title">
      <div className="space-y-2">
        <h2 id="failed-title" className="display-type text-xl font-bold">
          {title}
        </h2>
        <p className="text-sm leading-relaxed text-muted">{body}</p>
        <p className="text-xs text-muted">
          <span className="font-mono">{state.code}</span>
          {state.humanCause ? ` — ${state.humanCause}` : ''}
        </p>
      </div>
      <div className="flex justify-end">
        <PrimaryButton onClick={purchase.acknowledge}>
          {copy.chipsPurchase.failedClose}
        </PrimaryButton>
      </div>
    </Overlay>
  );
}

// ------------------------------------------------------------ small parts

function PrimaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        borderRadius: 'var(--radius-themed-md)',
        borderWidth: 'var(--border-width)',
        borderColor: 'var(--border-color)',
        borderStyle: 'var(--border-style)',
      }}
      className="display-type cursor-pointer bg-scissors px-4 py-2.5 text-sm font-semibold text-scissors-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
    >
      {children}
    </button>
  );
}

function SecondaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="display-type cursor-pointer px-4 py-2.5 text-sm font-semibold text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
    >
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

/**
 * Returns true once the pending state has been up for the past-60s window.
 *
 * Isolated in a hook so the message change is a pure re-render on a timer,
 * not a state transition on the purchase machine — the payment is still
 * "pending" from the machine's perspective; only the copy softens.
 */
function useSlowPendingFlip(startedAt: number | null): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (startedAt === null) return;
    const remaining = 60_000 - (Date.now() - startedAt);
    if (remaining <= 0) {
      setSlow(true);
      return;
    }
    const t = setTimeout(() => setSlow(true), remaining);
    return () => clearTimeout(t);
  }, [startedAt]);
  return slow;
}
