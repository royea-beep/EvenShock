/**
 * The Jupiter aggregator client, kept PURE on purpose: no Deno globals, no
 * Supabase, fetch passed in. The Edge Function is Deno and the unit suite is
 * Node, and this file is the part both can load — which matters because
 * Jupiter serves mainnet only, mainnet is fail-closed off, and so recorded
 * API fixtures driven through these functions are the honest ceiling of what
 * can be tested before mainnet activation.
 *
 * ExactOut is tried first: the treasury receives exactly the quoted USDC, the
 * displayed chip amount is exact, and slippage is bounded on the input side.
 * ExactOut route coverage is narrow, so ExactIn at `slippageBps` is the
 * well-worn path — its on-chain minimum-out (`otherAmountThreshold`) means
 * under-delivery below the quoted floor reverts the whole transaction.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface JupiterQuoteOutcome {
  quote: Record<string, any>;
  swapMode: 'ExactIn' | 'ExactOut';
}

interface QuoteParams {
  inputMint: string;
  outputMint: string;
  /** The USDC the treasury should receive, in raw base units. */
  usdcOutRaw: bigint;
  inputDecimals: number;
  slippageBps: number;
  timeoutMs: number;
}

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<any> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`jupiter ${res.status}`);
  return await res.json();
}

export async function fetchJupiterQuote(
  fetchImpl: FetchLike,
  base: string,
  { inputMint, outputMint, usdcOutRaw, inputDecimals, slippageBps, timeoutMs }: QuoteParams,
): Promise<JupiterQuoteOutcome> {
  const pair = `inputMint=${inputMint}&outputMint=${outputMint}`;

  let quote: any = null;
  try {
    quote = await getJson(
      fetchImpl,
      `${base}/quote?${pair}&amount=${usdcOutRaw}&swapMode=ExactOut&slippageBps=${slippageBps}`,
      timeoutMs,
    );
  } catch {
    quote = null; // ExactOut has no route for many pairs; fall through.
  }
  if (quote && !quote.error) return { quote, swapMode: 'ExactOut' };

  // ExactIn needs an input amount, which needs a price: probe with one whole
  // input token, size the input to cover the USDC target with a 0.5% cushion,
  // and let minimum-out guarantee the floor.
  const probeRaw = 10n ** BigInt(inputDecimals);
  const probe = await getJson(
    fetchImpl,
    `${base}/quote?${pair}&amount=${probeRaw}&swapMode=ExactIn&slippageBps=${slippageBps}`,
    timeoutMs,
  );
  if (probe.error) throw new Error(String(probe.error));
  const probeOut = BigInt(probe.outAmount);
  if (probeOut <= 0n) throw new Error('no route');

  const inputRaw = (((usdcOutRaw * probeRaw + probeOut - 1n) / probeOut) * 10_050n) / 10_000n;
  quote = await getJson(
    fetchImpl,
    `${base}/quote?${pair}&amount=${inputRaw}&swapMode=ExactIn&slippageBps=${slippageBps}`,
    timeoutMs,
  );
  if (quote.error) throw new Error(String(quote.error));
  return { quote, swapMode: 'ExactIn' };
}

export async function fetchJupiterSwapInstructions(
  fetchImpl: FetchLike,
  base: string,
  args: {
    quote: Record<string, any>;
    payer: string;
    destinationTokenAccount: string;
    timeoutMs: number;
  },
): Promise<any> {
  const res = await fetchImpl(`${base}/swap-instructions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(args.timeoutMs),
    body: JSON.stringify({
      quoteResponse: args.quote,
      userPublicKey: args.payer,
      // Jupiter does NOT create this account — it must exist (the treasury's
      // USDC ATA, pinned in env; a mainnet-activation checklist item).
      destinationTokenAccount: args.destinationTokenAccount,
      wrapAndUnwrapSol: true,
    }),
  });
  if (!res.ok) throw new Error(`jupiter ${res.status}`);
  const ix = await res.json();
  if (ix.error) throw new Error(String(ix.error));
  return ix;
}

/** Raw amounts implied by a quote, per mode. `otherAmountThreshold` is the
 *  on-chain bound: minimum output for ExactIn, maximum input for ExactOut. */
export function quoteAmounts({ quote, swapMode }: JupiterQuoteOutcome): {
  quotedInputRaw: bigint;
  quotedUsdcRaw: bigint;
  minUsdcRaw: bigint;
} {
  const quotedInputRaw = BigInt(
    swapMode === 'ExactOut' ? quote.otherAmountThreshold : quote.inAmount,
  );
  const quotedUsdcRaw = BigInt(quote.outAmount);
  const minUsdcRaw = swapMode === 'ExactOut' ? quotedUsdcRaw : BigInt(quote.otherAmountThreshold);
  return { quotedInputRaw, quotedUsdcRaw, minUsdcRaw };
}

/** Route fingerprint for the intent's audit column — labels, venue keys and
 *  amounts, never the raw response (rows would bloat). */
export function summarizeRoute(quote: Record<string, any>): Record<string, unknown> {
  return {
    provider: 'jupiter',
    labels: (quote.routePlan ?? []).map((r: any) => r?.swapInfo?.label ?? 'unknown'),
    amm_keys: (quote.routePlan ?? []).map((r: any) => r?.swapInfo?.ammKey ?? null),
    price_impact_pct: quote.priceImpactPct ?? null,
    context_slot: quote.contextSlot ?? null,
  };
}
