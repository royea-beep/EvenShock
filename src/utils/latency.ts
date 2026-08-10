/**
 * Submit round-trip timing, printed to the console on every round.
 *
 * This is permanent instrumentation, not a probe someone reads once. The number
 * that decides whether fast mode's 501ms budget holds is the one a real phone
 * on real mobile data pays, and that number cannot be measured from a
 * datacentre or a laptop on wifi. So it prints wherever the game is played, and
 * it prints a running summary alongside each sample so nobody has to collect
 * lines and do arithmetic to answer "is it fast enough".
 *
 * What is measured is the network round trip only — `functions.invoke` in,
 * response out. Commitment verification is a SHA-256 over ~70 bytes and does
 * not register; excluding it keeps this comparable to the 294ms p50 measured
 * server-side, so the difference between the two numbers is the player's
 * network and nothing else.
 */

const samples: number[] = [];

/** Keep the window short enough to reflect current conditions on a moving phone. */
const WINDOW = 50;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index];
}

export interface LatencySummary {
  n: number;
  last: number;
  p50: number;
  p95: number;
  worst: number;
}

export function submitLatencySummary(): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: samples.length,
    last: samples[samples.length - 1] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    worst: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * Records one submit round trip and prints it.
 *
 * The reveal budget is included in the line because the raw number means
 * nothing without it: 380ms is comfortable at normal pace and over budget in
 * fast mode, and whoever is holding the phone should be able to see which.
 */
export function recordSubmitLatency(ms: number, revealBudgetMs: number): void {
  samples.push(ms);
  if (samples.length > WINDOW) samples.shift();

  // Node (tests, scripts) has no business printing this.
  if (typeof window === 'undefined') return;

  const s = submitLatencySummary();
  const verdict = ms <= revealBudgetMs ? 'within' : 'OVER';
  // eslint-disable-next-line no-console
  console.info(
    `[evenshock] submit ${Math.round(ms)}ms (${verdict} the ${revealBudgetMs}ms reveal) — ` +
      `n=${s.n} p50=${Math.round(s.p50)}ms p95=${Math.round(s.p95)}ms worst=${Math.round(s.worst)}ms`,
  );
}

/** Exposed on `window` so a tester can read the summary without scrolling. */
export function installLatencyProbe(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).evenshockLatency = submitLatencySummary;
}
