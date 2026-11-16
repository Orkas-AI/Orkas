import { getBootDeviceProfile, type BootDeviceTier } from '../../src/main/util/boot-device-profile';

/** Hardware counts are a coarse default, not a speed benchmark. Pin a tier on
 * known older hosts/CI; never derive an allowance from the measured operation. */
export function resolvePerformanceTier(requested: string | undefined, detected: BootDeviceTier): BootDeviceTier {
  if (requested === undefined || requested === 'auto') return detected;
  if (requested === 'standard' || requested === 'low') return requested;
  throw new Error('Invalid ORKAS_TEST_PERFORMANCE_TIER; use auto, standard or low');
}
export const PERFORMANCE_TIER = resolvePerformanceTier(
  process.env.ORKAS_TEST_PERFORMANCE_TIER, getBootDeviceProfile().tier,
);
// Fixed engineering tolerances revised for slower devices on 2026-11-06.
// These test ceilings are not production timeouts or measured device SLAs.
const low = PERFORMANCE_TIER === 'low';
export const LATENCY_LIMIT_MS = low ? 2000 : 1000;
export const LATENCY_TARGET_MS = LATENCY_LIMIT_MS / 2;
export const FIRST_REQUEST_LATENCY_LIMIT_MS = low ? 3000 : 2000;
export const INTERACTIVE_MAIN_GAP_LIMIT_MS = low ? 500 : 300;
export const BULK_MAIN_GAP_LIMIT_MS = low ? 750 : 500;
export const INDEXED_SEARCH_LATENCY_LIMIT_MS = low ? 500 : 300;
export const LARGE_REPOSITORY_SEARCH_LIMIT_MS = low ? 4000 : 2000;
export const COMPOSER_EDIT_LIMIT_MS = low
  ? { multiline: 500, paragraph: 750 }
  : { multiline: 300, paragraph: 500 };
// Functional readiness watchdog, outside the interaction-latency gate.
export const LIBRARY_READY_TIMEOUT_MS = low ? 10000 : 5000;

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
  if (!Number.isFinite(limitMs) || limitMs <= 0) {
    throw new Error('Invalid latency budget');
  }
  // Warn halfway to the selected ceiling, including first-use and loop metrics.
  const targetMs = limitMs / 2;
  if (elapsedMs > targetMs) {
    // Keep severity in the shared structured log protocol. stdout avoids
    // Playwright adding a non-structured stderr case header to this warning.
    process.stdout.write('[00:00:00.000] [warn] [(latency-budget)] latency target exceeded ' + JSON.stringify({
      metric, elapsed_ms: elapsedMs, target_ms: targetMs,
      limit_ms: limitMs, tier: PERFORMANCE_TIER, phases,
    }) + '\n');
  }
  if (elapsedMs > limitMs) {
    throw new Error(`${metric} took ${elapsedMs.toFixed(1)} ms (budget ${limitMs} ms)`);
  }
}
