import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '../data/supabaseClient';
import {
  TOS_VERSION,
  acceptTos,
  confirmPayment,
  createIntent,
  findOpenIntent,
  getBrowserSolanaWallet,
  hasAcceptedTos,
  quoteIsFresh,
  quoteSwap,
  sendSwap,
  sendUsdc,
  type ConfirmResult,
  type PurchaseIntent,
  type SwapQuote,
} from '../data/purchase';

/**
 * The chip-purchase state machine.
 *
 * Owns one purchase at a time and refuses to start another while the previous
 * one is anywhere between "creating intent" and "credited or failed" —
 * inviting a retry mid-flight is how a player pays twice for the same chips.
 *
 * The states aren't just for the UI, they're the enforcement: `busy` closes
 * the buy button; the resume prompt is a state you can only leave by
 * committing to one side or the other.
 */

export type PurchaseState =
  | { kind: 'idle' }
  | { kind: 'checking' } // looking up open intent / ToS state on click
  | { kind: 'tos'; intent: null }
  | { kind: 'resume'; intent: PurchaseIntent }
  | { kind: 'creating' } // between the click and the intent row
  /** Swap path only: fetching a quote for the chosen token. */
  | { kind: 'quoting'; intent: PurchaseIntent }
  /** Swap path only: quote in hand, waiting for the player to accept it
   *  before it expires. The countdown is display; the real bound is on-chain. */
  | { kind: 'quote'; intent: PurchaseIntent; quote: SwapQuote }
  /**
   * Swap path only: the 60-second quote lapsed before the player signed.
   * Nothing was signed and nothing was charged — the only exits are a fresh
   * quote on the SAME intent (same reference, so reconciliation stays exact)
   * or dismissing. Deliberately not a `failed` state: failure copy talks
   * about money, and no money moved.
   */
  | { kind: 'quote_expired'; intent: PurchaseIntent; inputMint: string }
  | { kind: 'wallet'; intent: PurchaseIntent }
  | { kind: 'sending'; intent: PurchaseIntent }
  | { kind: 'pending'; intent: PurchaseIntent; signature: string; startedAt: number }
  | { kind: 'credited'; chipsCredited: number; chipsTotal: number }
  /**
   * `signed` splits the two failures that feel identical and are not.
   *
   * Before the wallet signs, nothing has left the player's wallet and there is
   * nothing to reconcile — the honest thing to say is "try again". After it
   * signs, the money is gone and irreversible, and the honest thing to say is
   * "we will find it". Telling someone their money is safe when they never
   * spent any is confusing at best; saying "try again" after they have paid
   * would invite a second payment, which is worse.
   */
  | {
      kind: 'failed';
      code: string;
      humanCause?: string;
      signed: boolean;
      /** For the wrong-mint refusals: which mint the wallet was missing, so
       *  the modal can name it. The intent legitimately told us. */
      mint?: string;
    };

const CONFIRM_POLL_MS = 3_000;
const CONFIRM_TIMEOUT_MS = 180_000;

/** Everything the button and the modals need. Ordered so a caller can read
 *  it as "state + the actions valid FROM that state". */
export interface Purchase {
  state: PurchaseState;
  /** True while the flow owns the button. UI mirrors this in the disabled state. */
  busy: boolean;
  /**
   * Kicks off the entire flow. Safe to call any time — it no-ops when busy.
   * No argument (or the USDC mint's absence) is the direct path, unchanged;
   * a token mint routes through quote-then-swap.
   */
  buy: (tokenMint?: string) => void;
  /** From the quote modal: sign and send the swap the quote describes. */
  payQuoted: () => Promise<void>;
  /** From the quote or quote-expired modal: fetch a fresh quote on the same
   *  intent. */
  requote: () => Promise<void>;
  /** True once a quote attempt came back "aggregator unreachable" — the
   *  picker disables non-USDC tokens until the next successful quote. */
  swapDown: boolean;
  /** Called from the ToS gate after the checkbox is confirmed. */
  confirmTos: () => Promise<void>;
  /** Called from either modal to back out. Does not "cancel" any payment
   *  already on chain; that is by design. */
  dismiss: () => void;
  /** Chosen from the resume modal — proceed with the existing intent. */
  resumeExisting: () => Promise<void>;
  /** Chosen from the resume modal — abandon this attempt and start clean. */
  startNew: () => Promise<void>;
  /** Chosen from the resume modal when the user says they already sent the
   *  money. Enters the pending-poll flow without asking the wallet again. */
  checkExisting: () => Promise<void>;
  /** After success, called by the credited modal to close. Also fires
   *  onCredited so the outer economy can re-read the balance. */
  acknowledge: () => void;
}

interface UsePurchaseArgs {
  authenticated: boolean;
  /** Fired when a purchase actually credits — the outer economy hook re-loads
   *  after this so the header balance updates. */
  onCredited: () => void;
}

const USDC_AMOUNT = 1; // Single SKU: 100 chips for $1.

export function usePurchase({ authenticated, onCredited }: UsePurchaseArgs): Purchase {
  const client = getSupabase();
  const [state, setState] = useState<PurchaseState>({ kind: 'idle' });
  const [swapDown, setSwapDown] = useState(false);

  // The token the player picked for THIS purchase. A ref, not state: it must
  // survive the ToS and resume detours without re-rendering anything, and it
  // is cleared when the flow returns to idle. Null means USDC-direct.
  const selectedMintRef = useRef<string | null>(null);

  // A ref for the current intent when we're mid-poll — the confirm loop
  // reads this rather than closing over stale state.
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    },
    [],
  );

  const busy = state.kind !== 'idle' && state.kind !== 'credited' && state.kind !== 'failed';

  /** Sign the intent through the wallet, then poll for credit. Shared by the
   *  fresh-buy path, the "resume with a pay-now" path, and — when a quote is
   *  passed — the swap path, which differs only in what gets signed. */
  const payAndPoll = useCallback(
    async (intent: PurchaseIntent, quote?: SwapQuote) => {
      if (!client) return setState({ kind: 'failed', code: 'client_missing', signed: false });
      const wallet = getBrowserSolanaWallet();
      if (!wallet) return setState({ kind: 'failed', code: 'wallet_missing', signed: false });

      // The client-side expiry gate: a stale quote is refused BEFORE the
      // wallet ever opens, and the player is offered a fresh quote on the
      // same intent. (The server never refuses to credit a late-landing swap
      // — this gate is about not showing a price that is no longer true.)
      if (quote && !quoteIsFresh(quote)) {
        setState({ kind: 'quote_expired', intent, inputMint: quote.input_mint });
        return;
      }

      setState({ kind: 'wallet', intent });
      let signature: string;
      try {
        const sent = quote ? await sendSwap(intent, quote, wallet) : await sendUsdc(intent, wallet);
        signature = sent.signature;
      } catch (err) {
        const message = err instanceof Error ? err.message.toLowerCase() : String(err);
        if (/reject|denied|cancel/i.test(message)) {
          setState({ kind: 'idle' });
          return;
        }
        if (quote && message === 'quote_expired') {
          // sendSwap re-checks freshness at the moment of signing; a lapse in
          // the window between the modal and the wallet lands here. Nothing
          // was signed.
          setState({ kind: 'quote_expired', intent, inputMint: quote.input_mint });
          return;
        }
        if (message === 'expected_mint_absent' || message === 'expected_mint_insufficient') {
          // The knowable, common failure: the wallet holds none (or not
          // enough) of the mint this purchase needs — on devnet, usually a
          // wallet funded from Circle's faucet, which is a DIFFERENT mint
          // than the one payment_config accepts. Refused before the wallet
          // opened, so nothing was signed and nothing left the wallet.
          setState({
            kind: 'failed',
            code: message,
            signed: false,
            mint: (err as { mint?: string }).mint ?? intent.usdc_mint,
          });
          return;
        }
        setState({
          kind: 'failed',
          code: 'wallet_error',
          humanCause: err instanceof Error ? err.message : 'wallet failure',
          // The throw came from sendUsdc/sendSwap, which return only once the
          // wallet has signed AND sent. Reaching here means it never got that
          // far, so nothing left the player's wallet.
          signed: false,
        });
        return;
      }
      setState({ kind: 'sending', intent });

      const startedAt = Date.now();
      const poll = async () => {
        const result: ConfirmResult = await confirmPayment(client, intent.intent_id, signature);
        if (result.kind === 'credited') {
          setState({
            kind: 'credited',
            chipsCredited: result.chips_credited,
            chipsTotal: result.chips,
          });
          onCredited();
          return;
        }
        if (result.kind === 'failed') {
          // A signature exists, so the transfer is on chain and irreversible
          // whatever the server made of it. Reconciliation is the promise here.
          setState({ kind: 'failed', code: result.code, signed: true });
          return;
        }
        // pending — schedule another poll unless we've been at this too long.
        if (Date.now() - startedAt > CONFIRM_TIMEOUT_MS) {
          // Still valid, just slow: leave it in the pending screen so the
          // "you can close this page" copy stays visible. Do NOT flip to
          // failure — the payment is real and the reconciler will pick it up.
          return;
        }
        pollTimer.current = setTimeout(() => {
          void poll();
        }, CONFIRM_POLL_MS);
      };

      setState({ kind: 'pending', intent, signature, startedAt });
      void poll();
    },
    [client, onCredited],
  );

  /** Fetch (or re-fetch) a swap quote on an intent, and land in the quote
   *  modal. Every path into the swap flow funnels through here, so "stale
   *  quotes are never resumed" holds by construction. */
  const startQuote = useCallback(
    async (intent: PurchaseIntent, inputMint: string) => {
      if (!client) return setState({ kind: 'failed', code: 'client_missing', signed: false });
      setState({ kind: 'quoting', intent });
      const payer = getBrowserSolanaWallet()?.publicKey?.toBase58() ?? null;
      const result = await quoteSwap(client, intent.intent_id, inputMint, payer);
      if (result.kind === 'ok') {
        setSwapDown(false);
        setState({ kind: 'quote', intent, quote: result.quote });
        return;
      }
      if (result.kind === 'unavailable') {
        // The aggregator is down, not the purchase path: the picker greys out
        // the other tokens and USDC-direct carries on untouched.
        setSwapDown(true);
        selectedMintRef.current = null;
        setState({ kind: 'failed', code: 'swap_unavailable', signed: false });
        return;
      }
      setState({ kind: 'failed', code: result.code, signed: false });
    },
    [client],
  );

  const startFresh = useCallback(async () => {
    if (!client) return setState({ kind: 'failed', code: 'client_missing', signed: false });
    setState({ kind: 'creating' });
    try {
      const intent = await createIntent(client, USDC_AMOUNT);
      const mint = selectedMintRef.current;
      if (mint) await startQuote(intent, mint);
      else await payAndPoll(intent);
    } catch (err) {
      const code = err instanceof Error ? err.message : 'create_failed';
      setState({ kind: 'failed', code, signed: false });
    }
  }, [client, payAndPoll, startQuote]);

  const buy = useCallback((tokenMint?: string) => {
    if (busy || !authenticated || !client) return;
    selectedMintRef.current = tokenMint ?? null;
    setState({ kind: 'checking' });
    void (async () => {
      try {
        const open = await findOpenIntent(client);
        if (open) {
          setState({ kind: 'resume', intent: open });
          return;
        }
        const accepted = await hasAcceptedTos(client, TOS_VERSION);
        if (!accepted) {
          setState({ kind: 'tos', intent: null });
          return;
        }
        await startFresh();
      } catch (err) {
        const code = err instanceof Error ? err.message : 'precheck_failed';
        setState({ kind: 'failed', code, signed: false });
      }
    })();
  }, [authenticated, busy, client, startFresh]);

  const confirmTos = useCallback(async () => {
    if (!client) return;
    try {
      await acceptTos(client, TOS_VERSION);
      await startFresh();
    } catch (err) {
      const code = err instanceof Error ? err.message : 'tos_failed';
      setState({ kind: 'failed', code, signed: false });
    }
  }, [client, startFresh]);

  const resumeExisting = useCallback(async () => {
    if (state.kind !== 'resume') return;
    // A swap-flavoured resume (the player picked a token now, or the open
    // intent already carries one) ALWAYS re-quotes: a 60-second quote is
    // stale by the time a resume modal exists, and the price shown must be
    // one that is still true. Same intent, same reference.
    const mint = selectedMintRef.current ?? state.intent.input_mint ?? null;
    if (mint) await startQuote(state.intent, mint);
    else await payAndPoll(state.intent);
  }, [payAndPoll, startQuote, state]);

  const payQuoted = useCallback(async () => {
    if (state.kind !== 'quote') return;
    await payAndPoll(state.intent, state.quote);
  }, [payAndPoll, state]);

  const requote = useCallback(async () => {
    if (state.kind === 'quote') return startQuote(state.intent, state.quote.input_mint);
    if (state.kind === 'quote_expired') return startQuote(state.intent, state.inputMint);
  }, [startQuote, state]);

  const checkExisting = useCallback(async () => {
    if (state.kind !== 'resume' || !client) return;
    // The user says they already paid — we have no signature, so ask the
    // server to reconcile by reference. Since /reconcile is owner-only right
    // now, we fall back to the pending screen with the intent visible and let
    // the background reconciler credit when the reference is next scanned.
    // The pending copy already tells them it's safe to close.
    setState({
      kind: 'pending',
      intent: state.intent,
      signature: '',
      startedAt: Date.now(),
    });
  }, [client, state]);

  const startNew = useCallback(async () => {
    if (state.kind !== 'resume') return;
    // The stale intent stays pending server-side and expires on its own; the
    // schema explicitly allows overlapping open intents so this is safe.
    const accepted = client ? await hasAcceptedTos(client, TOS_VERSION) : true;
    if (!accepted) {
      setState({ kind: 'tos', intent: null });
      return;
    }
    await startFresh();
  }, [client, startFresh, state]);

  const dismiss = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    selectedMintRef.current = null;
    // Payments already in flight are not cancelled by dismissing the UI —
    // pending/sending states drop back to idle here, but any on-chain money
    // is still credited by the background reconciler.
    setState({ kind: 'idle' });
  }, []);

  const acknowledge = useCallback(() => {
    selectedMintRef.current = null;
    setState({ kind: 'idle' });
  }, []);

  return {
    state,
    busy,
    buy,
    payQuoted,
    requote,
    swapDown,
    confirmTos,
    dismiss,
    resumeExisting,
    checkExisting,
    startNew,
    acknowledge,
  };
}
