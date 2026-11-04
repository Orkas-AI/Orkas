// Fixed Windows tolerances approved on 2026-10-29; other platforms retain their budgets.
export const LATENCY_TARGET_MS = process.platform === 'win32' ? 500 : 300;
// Platform-specific response budget approved for lower-spec Windows hosts.
export const LATENCY_LIMIT_MS = process.platform === 'win32' ? 1000 : 500;
// First-request setup has a separate, approved budget on lower-spec Windows hosts.
export const FIRST_REQUEST_LATENCY_LIMIT_MS = process.platform === 'win32' ? 1000 : LATENCY_LIMIT_MS;

// Readiness is a functional-test watchdog, separate from response latency.
export const LIBRARY_READY_TIMEOUT_MS = process.platform === 'win32' ? 3000 : 1000;
export const INTERACTIVE_MAIN_GAP_LIMIT_MS = process.platform === 'win32' ? 300 : 150;
export const BULK_MAIN_GAP_LIMIT_MS = process.platform === 'win32' ? 500 : 300;
export const COMPOSER_EDIT_LIMIT_MS = process.platform === 'win32'
  ? { multiline: 300, paragraph: 500 }
  : { multiline: 150, paragraph: 300 };

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
    // Keep severity in the shared structured log protocol. stdout avoids
    // Playwright adding a non-structured stderr case header to this warning.
    process.stdout.write('[00:00:00.000] [warn] [(latency-budget)] latency target exceeded ' + JSON.stringify({
      metric, elapsed_ms: elapsedMs, target_ms: LATENCY_TARGET_MS,
      limit_ms: limitMs, phases,
    }) + '\n');
  }
  if (elapsedMs > limitMs) {
    throw new Error(`${metric} took ${elapsedMs.toFixed(1)} ms (budget ${limitMs} ms)`);
  }
}
