import { describe, expect, it } from 'vitest';
import {
  fetchJupiterQuote,
  fetchJupiterSwapInstructions,
  quoteAmounts,
  summarizeRoute,
} from './jupiter.ts';

/**
 * THE HONEST CEILING, stated where the tests live: Jupiter's API serves
 * mainnet only, mainnet is fail-closed off, and devnet is the only cluster
 * this project can reach — so the Jupiter HTTP integration cannot be
 * exercised live. These are contract tests against recorded response shapes
 * (captured from Jupiter's v1 swap API documentation examples): they pin our
 * request construction, mode fallback, amount semantics and failure mapping.
 * Every invariant we OWN — verification, reference binding, quote lifecycle,
 * replay, reconciliation, conservation — is exercised live on devnet by the
 * harness provider instead (scripts/devnet/e2e.mjs).
 */

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';

// Recorded shape of a /quote ExactOut response: 1 USDC out for ~0.005 SOL in,
// otherAmountThreshold = max input after slippage.
const EXACT_OUT_QUOTE = {
  inputMint: WSOL,
  outputMint: USDC,
  inAmount: '5000000',
  outAmount: '1000000',
  otherAmountThreshold: '5050000',
  swapMode: 'ExactOut',
  slippageBps: 100,
  priceImpactPct: '0.01',
  contextSlot: 299000001,
  routePlan: [{ swapInfo: { label: 'Whirlpool', ammKey: 'amm111' }, percent: 100 }],
};

// Recorded shape of /quote ExactIn: input exact, otherAmountThreshold = min out.
const EXACT_IN_QUOTE = (inAmount: string, outAmount: string, minOut: string) => ({
  inputMint: WSOL,
  outputMint: USDC,
  inAmount,
  outAmount,
  otherAmountThreshold: minOut,
  swapMode: 'ExactIn',
  slippageBps: 100,
  priceImpactPct: '0.02',
  contextSlot: 299000002,
  routePlan: [
    { swapInfo: { label: 'Raydium CLMM', ammKey: 'amm222' }, percent: 60 },
    { swapInfo: { label: 'Orca', ammKey: 'amm333' }, percent: 40 },
  ],
});

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function recordingFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { impl, calls };
}

const BASE = 'https://lite-api.jup.ag/swap/v1';
const PARAMS = {
  inputMint: WSOL,
  outputMint: USDC,
  usdcOutRaw: 1_000_000n,
  inputDecimals: 9,
  slippageBps: 100,
  timeoutMs: 8000,
};

describe('fetchJupiterQuote', () => {
  it('tries ExactOut first and returns it when a route exists', async () => {
    const { impl, calls } = recordingFetch(() => okJson(EXACT_OUT_QUOTE));
    const outcome = await fetchJupiterQuote(impl, BASE, PARAMS);

    expect(outcome.swapMode).toBe('ExactOut');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('swapMode=ExactOut');
    // The amount requested is the USDC the treasury must receive, raw.
    expect(calls[0].url).toContain('amount=1000000');
    expect(calls[0].url).toContain(`inputMint=${WSOL}`);
    expect(calls[0].url).toContain(`outputMint=${USDC}`);
    expect(calls[0].url).toContain('slippageBps=100');
  });

  it('falls back to ExactIn via a one-token probe when ExactOut has no route', async () => {
    const { impl, calls } = recordingFetch((url) => {
      if (url.includes('swapMode=ExactOut')) {
        return okJson({ error: 'COULD_NOT_FIND_ANY_ROUTE' });
      }
      // Probe: 1 SOL (1e9 raw) buys 200 USDC.
      if (url.includes('amount=1000000000')) {
        return okJson(EXACT_IN_QUOTE('1000000000', '200000000', '198000000'));
      }
      // Sized quote: ~0.005 SOL for the 1 USDC target.
      return okJson(EXACT_IN_QUOTE('5025000', '1004000', '994000'));
    });
    const outcome = await fetchJupiterQuote(impl, BASE, PARAMS);

    expect(outcome.swapMode).toBe('ExactIn');
    expect(calls).toHaveLength(3); // ExactOut attempt, probe, sized quote
    // The sized input covers the target with the 0.5% cushion:
    // ceil(1e6 * 1e9 / 2e8) = 5_000_000, ×1.005 → 5_025_000.
    expect(calls[2].url).toContain('amount=5025000');
    expect(calls[2].url).toContain('swapMode=ExactIn');
  });

  it('throws when no route exists in either mode', async () => {
    const { impl } = recordingFetch(() => okJson({ error: 'COULD_NOT_FIND_ANY_ROUTE' }));
    await expect(fetchJupiterQuote(impl, BASE, PARAMS)).rejects.toThrow();
  });

  it('throws on an aggregator 5xx so the caller maps it to swap_unavailable', async () => {
    const { impl } = recordingFetch(() => new Response('oops', { status: 503 }));
    await expect(fetchJupiterQuote(impl, BASE, PARAMS)).rejects.toThrow('jupiter 503');
  });
});

describe('quoteAmounts', () => {
  it('ExactOut: input is bounded by otherAmountThreshold, USDC floor is the output itself', () => {
    const { quotedInputRaw, quotedUsdcRaw, minUsdcRaw } = quoteAmounts({
      quote: EXACT_OUT_QUOTE,
      swapMode: 'ExactOut',
    });
    expect(quotedInputRaw).toBe(5_050_000n); // max input, what the player is told "up to"
    expect(quotedUsdcRaw).toBe(1_000_000n);
    expect(minUsdcRaw).toBe(1_000_000n); // exact delivery — quoted chips are exact
  });

  it('ExactIn: input is exact, USDC floor is otherAmountThreshold', () => {
    const { quotedInputRaw, quotedUsdcRaw, minUsdcRaw } = quoteAmounts({
      quote: EXACT_IN_QUOTE('5025000', '1004000', '994000'),
      swapMode: 'ExactIn',
    });
    expect(quotedInputRaw).toBe(5_025_000n);
    expect(quotedUsdcRaw).toBe(1_004_000n);
    // The number the player is promised chips against — the on-chain min-out.
    expect(minUsdcRaw).toBe(994_000n);
  });
});

describe('fetchJupiterSwapInstructions', () => {
  const IX_RESPONSE = {
    computeBudgetInstructions: [{ programId: 'CB', accounts: [], data: 'AA==' }],
    setupInstructions: [],
    swapInstruction: { programId: 'JUP6', accounts: [], data: 'BB==' },
    cleanupInstruction: null,
    addressLookupTableAddresses: ['alt111'],
  };

  it('posts the quote with the pinned destination token account', async () => {
    const { impl, calls } = recordingFetch(() => okJson(IX_RESPONSE));
    const ix = await fetchJupiterSwapInstructions(impl, BASE, {
      quote: EXACT_OUT_QUOTE,
      payer: 'payer111',
      destinationTokenAccount: 'treasuryAta111',
      timeoutMs: 8000,
    });

    expect(calls[0].url).toBe(`${BASE}/swap-instructions`);
    const body = JSON.parse(String(calls[0].init?.body));
    // The swap output lands at the TREASURY's USDC account, never the payer's
    // wallet — this is what removes the "swap landed, transfer didn't" state.
    expect(body.destinationTokenAccount).toBe('treasuryAta111');
    expect(body.userPublicKey).toBe('payer111');
    expect(body.quoteResponse).toEqual(EXACT_OUT_QUOTE);
    expect(ix.addressLookupTableAddresses).toEqual(['alt111']);
  });

  it('throws on a 5xx and on an error payload', async () => {
    const bad = recordingFetch(() => new Response('down', { status: 502 }));
    await expect(
      fetchJupiterSwapInstructions(bad.impl, BASE, {
        quote: EXACT_OUT_QUOTE,
        payer: 'p',
        destinationTokenAccount: 't',
        timeoutMs: 8000,
      }),
    ).rejects.toThrow('jupiter 502');

    const err = recordingFetch(() => okJson({ error: 'invalid quote' }));
    await expect(
      fetchJupiterSwapInstructions(err.impl, BASE, {
        quote: EXACT_OUT_QUOTE,
        payer: 'p',
        destinationTokenAccount: 't',
        timeoutMs: 8000,
      }),
    ).rejects.toThrow('invalid quote');
  });
});

describe('summarizeRoute', () => {
  it('keeps labels, venue keys and impact — not the raw response', () => {
    const summary = summarizeRoute(EXACT_IN_QUOTE('1', '2', '3'));
    expect(summary).toEqual({
      provider: 'jupiter',
      labels: ['Raydium CLMM', 'Orca'],
      amm_keys: ['amm222', 'amm333'],
      price_impact_pct: '0.02',
      context_slot: 299000002,
    });
  });
});
