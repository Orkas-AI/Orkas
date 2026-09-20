export const LATENCY_TARGET_MS = 300;
export const LATENCY_LIMIT_MS = 500;
// First-request setup has a separate, approved budget on lower-spec Windows hosts.
export const FIRST_REQUEST_LATENCY_LIMIT_MS = process.platform === 'win32' ? 700 : LATENCY_LIMIT_MS;

export interface LatencySample {
  elapsedMs: number;
  phases?: Array<{ phase: string; ms: number }>;
}

/** Shared by main-process integration and Electron interaction tests. Only
 * bounded metric/phase names and durations belong here, never request data. */
export function checkLatencyBudget(metric: string, sample: LatencySample, limitMs = LATENCY_LIMIT_MS): void {
  const { elapsedMs, phases = [] } = sample;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error('Invalid latency measurement');
  }
  if (elapsedMs > LATENCY_TARGET_MS) {
    console.warn('[latency-warning]', JSON.stringify({
      metric, elapsed_ms: elapsedMs, target_ms: LATENCY_TARGET_MS,
      limit_ms: limitMs, phases,
    }));
  }
  if (elapsedMs > limitMs) {
    throw new Error(`${metric} took ${elapsedMs.toFixed(1)} ms (budget ${limitMs} ms)`);
  }
}
