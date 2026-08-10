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
  sendUsdc,
  type ConfirmResult,
  type PurchaseIntent,
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
  | { kind: 'wallet'; intent: PurchaseIntent }
  | { kind: 'sending'; intent: PurchaseIntent }
  | { kind: 'pending'; intent: PurchaseIntent; signature: string; startedAt: number }
  | { kind: 'credited'; chipsCredited: number; chipsTotal: number }
  | { kind: 'failed'; code: string; humanCause?: string };

const CONFIRM_POLL_MS = 3_000;
const CONFIRM_TIMEOUT_MS = 180_000;

/** Everything the button and the modals need. Ordered so a caller can read
 *  it as "state + the actions valid FROM that state". */
export interface Purchase {
  state: PurchaseState;
  /** True while the flow owns the button. UI mirrors this in the disabled state. */
  busy: boolean;
  /** Kicks off the entire flow. Safe to call any time — it no-ops when busy. */
  buy: () => void;
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
   *  fresh-buy path and the "resume with a pay-now" path. */
  const payAndPoll = useCallback(
    async (intent: PurchaseIntent) => {
      if (!client) return setState({ kind: 'failed', code: 'client_missing' });
      const wallet = getBrowserSolanaWallet();
      if (!wallet) return setState({ kind: 'failed', code: 'wallet_missing' });

      setState({ kind: 'wallet', intent });
      let signature: string;
      try {
        const sent = await sendUsdc(intent, wallet);
        signature = sent.signature;
      } catch (err) {
        const message = err instanceof Error ? err.message.toLowerCase() : String(err);
        if (/reject|denied|cancel/i.test(message)) {
          setState({ kind: 'idle' });
          return;
        }
        setState({
          kind: 'failed',
          code: 'wallet_error',
          humanCause: err instanceof Error ? err.message : 'wallet failure',
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
          setState({ kind: 'failed', code: result.code });
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

  const startFresh = useCallback(async () => {
    if (!client) return setState({ kind: 'failed', code: 'client_missing' });
    setState({ kind: 'creating' });
    try {
      const intent = await createIntent(client, USDC_AMOUNT);
      await payAndPoll(intent);
    } catch (err) {
      const code = err instanceof Error ? err.message : 'create_failed';
      setState({ kind: 'failed', code });
    }
  }, [client, payAndPoll]);

  const buy = useCallback(() => {
    if (busy || !authenticated || !client) return;
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
        setState({ kind: 'failed', code });
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
      setState({ kind: 'failed', code });
    }
  }, [client, startFresh]);

  const resumeExisting = useCallback(async () => {
    if (state.kind !== 'resume') return;
    await payAndPoll(state.intent);
  }, [payAndPoll, state]);

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
    // Payments already in flight are not cancelled by dismissing the UI —
    // pending/sending states drop back to idle here, but any on-chain money
    // is still credited by the background reconciler.
    setState({ kind: 'idle' });
  }, []);

  const acknowledge = useCallback(() => {
    setState({ kind: 'idle' });
  }, []);

  return {
    state,
    busy,
    buy,
    confirmTos,
    dismiss,
    resumeExisting,
    checkExisting,
    startNew,
    acknowledge,
  };
}
