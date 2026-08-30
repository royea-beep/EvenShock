import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { copy } from '../constants/copy';
import { TosGate } from './TosGate';
import { getSupabase } from '../data/supabaseClient';
import { getBrowserSolanaWallet, listAcceptedTokens, type AcceptedToken } from '../data/purchase';
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
  const reduceMotion = useReducedMotion();
  const { state } = purchase;

  // The tokens a player may pay WITH (the treasury always receives USDC).
  // Rendering data only: the server re-validates the mint on every quote, so
  // a tampered copy of this list buys nothing.
  const [tokens, setTokens] = useState<AcceptedToken[]>([]);
  // '' is USDC-direct — deliberately not a row of the accepted list, because
  // it is not a swap: it routes through the untouched existing path.
  const [selectedMint, setSelectedMint] = useState<string>('');

  useEffect(() => {
    const client = getSupabase();
    if (!client) return;
    let cancelled = false;
    void listAcceptedTokens(client).then((rows) => {
      if (!cancelled) setTokens(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const disabled = purchase.busy || !wallet;

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
          <p className="text-xs text-muted">{copy.chipsPurchase.mintNote}</p>
        </div>

        {tokens.length > 0 && (
          <div
            role="radiogroup"
            aria-label={copy.chipsPurchase.tokenPickerLabel}
            className="mt-1 flex flex-wrap items-center justify-center gap-1.5"
          >
            <span className="text-xs text-muted">{copy.chipsPurchase.tokenPickerLabel}</span>
            <TokenChip
              label={copy.chipsPurchase.tokenUsdcLabel}
              checked={selectedMint === ''}
              disabled={disabled}
              onSelect={() => setSelectedMint('')}
            />
            {tokens.map((t) => (
              <TokenChip
                key={t.mint}
                label={t.symbol}
                checked={selectedMint === t.mint}
                disabled={disabled || purchase.swapDown}
                onSelect={() => setSelectedMint(t.mint)}
              />
            ))}
          </div>
        )}
        {purchase.swapDown && tokens.length > 0 && (
          <p className="text-xs text-muted">{copy.chipsPurchase.swapUnavailableNote}</p>
        )}

        <motion.button
          type="button"
          onClick={() => purchase.buy(selectedMint || undefined)}
          disabled={disabled}
          whileHover={disabled || reduceMotion ? undefined : { scale: 1.02 }}
          whileTap={disabled || reduceMotion ? undefined : { scale: 0.97 }}
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
        {(state.kind === 'quoting' ||
          state.kind === 'quote' ||
          state.kind === 'quote_expired') && <QuoteModal purchase={purchase} />}
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
  // Opacity fades are tolerable under prefers-reduced-motion; the translate
  // and scale are not, so they collapse to a plain fade.
  const reduceMotion = useReducedMotion();
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
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
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

/**
 * The swap quote, its countdown, and its expiry — one modal for all three so
 * the transition from "here is the price" to "that price lapsed" happens in
 * place rather than by swapping dialogs under the player's cursor.
 *
 * The countdown is honest UX, not enforcement: the machine re-checks
 * freshness when Pay is pressed, and the chain's minimum-out is the real
 * bound. When it reaches zero this modal shows the expired copy itself.
 */
function QuoteModal({ purchase }: { purchase: Purchase }) {
  const { state } = purchase;
  const quote = state.kind === 'quote' ? state.quote : null;
  const secondsLeft = useQuoteCountdown(quote?.swap_quote_expires_at ?? null);
  if (state.kind !== 'quoting' && state.kind !== 'quote' && state.kind !== 'quote_expired') {
    return null;
  }

  if (state.kind === 'quoting') {
    return (
      <Overlay labelledBy="quote-title">
        <div className="flex items-center gap-3">
          <Spinner />
          <h2 id="quote-title" className="display-type text-lg font-bold">
            {copy.chipsPurchase.quoting}
          </h2>
        </div>
      </Overlay>
    );
  }

  const expired = state.kind === 'quote_expired' || (quote !== null && secondsLeft <= 0);
  if (expired) {
    return (
      <Overlay labelledBy="quote-title">
        <div className="space-y-2">
          <h2 id="quote-title" className="display-type text-xl font-bold">
            {copy.chipsPurchase.quoteExpiredTitle}
          </h2>
          <p className="text-sm leading-relaxed text-muted">
            {copy.chipsPurchase.quoteExpiredBody}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={purchase.dismiss}>
            {copy.chipsPurchase.failedClose}
          </SecondaryButton>
          <PrimaryButton onClick={() => void purchase.requote()}>
            {copy.chipsPurchase.quoteRefresh}
          </PrimaryButton>
        </div>
      </Overlay>
    );
  }

  const q = quote!;
  const chips = Math.floor(q.min_usdc_out * q.chips_per_usdc);
  const line =
    q.swap_mode === 'ExactOut'
      ? copy.chipsPurchase.quoteLineExactOut(String(q.quoted_input_amount), q.input_symbol, chips)
      : copy.chipsPurchase.quoteLineExactIn(String(q.quoted_input_amount), q.input_symbol, chips);

  return (
    <Overlay labelledBy="quote-title">
      <div className="space-y-2">
        <h2 id="quote-title" className="display-type text-xl font-bold">
          {copy.chipsPurchase.quoteTitle(q.input_symbol)}
        </h2>
        <p className="text-sm font-semibold text-ink">{line}</p>
        <p className="text-sm leading-relaxed text-muted">{copy.chipsPurchase.quoteExplainer}</p>
        <p className="text-xs text-muted" aria-live="polite">
          {copy.chipsPurchase.quoteCountdown(secondsLeft)}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <SecondaryButton onClick={purchase.dismiss}>
          {copy.chipsPurchase.tosCancel}
        </SecondaryButton>
        <PrimaryButton onClick={() => void purchase.payQuoted()}>
          {copy.chipsPurchase.quotePay}
        </PrimaryButton>
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
  // The aggregator being down is not the player's failure and not a payment
  // failure: nothing was signed, and USDC-direct still works. Its own copy,
  // because "payment not started" would leave them wondering what to change.
  const swapDown = state.code === 'swap_unavailable';
  // A wallet that holds none of the expected mint — the Circle-faucet trap —
  // detected before the wallet opened. Its own copy for the same reason as
  // the treasury case: "try again" would send them round the same loop.
  const mintAbsent = state.code === 'expected_mint_absent';
  const mintShort = state.code === 'expected_mint_insufficient';
  const title = treasury
    ? copy.chipsPurchase.walletIsTreasuryTitle
    : swapDown
      ? copy.chipsPurchase.swapUnavailableTitle
      : mintAbsent
        ? copy.chipsPurchase.wrongMintTitle
        : mintShort
          ? copy.chipsPurchase.shortMintTitle
          : state.signed
            ? copy.chipsPurchase.failedTitle
            : copy.chipsPurchase.failedTitleUnspent;
  const body = treasury
    ? copy.chipsPurchase.walletIsTreasuryBody
    : swapDown
      ? copy.chipsPurchase.swapUnavailableBody
      : mintAbsent
        ? copy.chipsPurchase.wrongMintBody(state.mint ?? 'unknown')
        : mintShort
          ? copy.chipsPurchase.shortMintBody(state.mint ?? 'unknown')
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

function TokenChip({
  label,
  checked,
  disabled,
  onSelect,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  // Selection is shown by the filled background AND aria-checked, never color
  // alone; the palette pairs (bg-scissors/text-scissors-ink, bg-elevated/
  // text-muted) come from the theme tokens, which carry the AA guarantee.
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      style={{
        borderRadius: 'var(--radius-themed-md)',
        borderWidth: 'var(--border-width)',
        borderColor: 'var(--border-color)',
        borderStyle: 'var(--border-style)',
      }}
      className={`display-type cursor-pointer px-2.5 py-1 text-xs font-semibold transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? 'bg-scissors text-scissors-ink' : 'bg-elevated text-muted hover:text-ink'
      }`}
    >
      {label}
    </button>
  );
}

/** Whole seconds until the quote expiry, ticking once a second. */
function useQuoteCountdown(expiresAt: string | null): number {
  const compute = () =>
    expiresAt === null
      ? 0
      : Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const [secs, setSecs] = useState(compute);
  useEffect(() => {
    setSecs(compute());
    if (expiresAt === null) return;
    const t = setInterval(() => setSecs(compute()), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);
  return secs;
}

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
