/** Low-volume local browser diagnostics, never page/URL or raw exception text. */
import type { WebContents } from 'electron';
import { createLogger } from '../logger';

const log = createLogger('web-assist');
const COOLDOWN_MS = 5 * 60_000;
const WINDOW_MS = 60 * 60_000;
const MAX_REPORTS = 12;
const FAILURES = {
  page_load_failed: { stage: 'load', error_type: 'network', error_message: 'Browser main-frame navigation failed' },
  page_unresponsive: { stage: 'renderer', error_type: 'runtime', error_message: 'Browser page became unresponsive' },
  renderer_gone: { stage: 'renderer', error_type: 'runtime', error_message: 'Browser renderer exited unexpectedly' },
  view_unavailable: { stage: 'create', error_type: 'runtime', error_message: 'Browser view could not be created' },
} as const;
type Failure = keyof typeof FAILURES;

interface RendererExitDetails {
  reason: unknown;
  exitCode: unknown;
}
const RENDERER_EXIT_REASONS = new Set([
  'clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom',
  'launch-failed', 'integrity-failure', 'memory-eviction',
]);

export function createWebAssistDiagnostics() {
  const last = new Map<Failure, number>();
  const suppressed = new Map<Failure, number>();
  let emitted: number[] = [];
  return (sender: Pick<WebContents, 'isDestroyed'>, failure: Failure, netCode?: unknown,
    _context?: unknown, exitDetails?: RendererExitDetails): void => {
    if (!Object.hasOwn(FAILURES, failure) || sender.isDestroyed()) return;
    const now = Date.now();
    emitted = emitted.filter(time => now - time < WINDOW_MS);
    const previous = last.get(failure);
    if ((previous !== undefined && now - previous < COOLDOWN_MS) || emitted.length >= MAX_REPORTS) {
      suppressed.set(failure, Math.min(9999, (suppressed.get(failure) || 0) + 1));
      return;
    }
    last.set(failure, now);
    emitted.push(now);
    const payload = {
      ...FAILURES[failure], error_code: failure,
      suppressed_count: suppressed.get(failure) || 0,
      ...(failure === 'page_load_failed' && typeof netCode === 'number'
        && Number.isInteger(netCode) && netCode < 0 && netCode >= -999
        ? { net_error_code: netCode } : {}),
    };
    suppressed.delete(failure);
    // Native exit facts stay in the sampled local warning. No page, URL or exception data is retained.
    let localExitDiagnostic = {};
    if (failure === 'renderer_gone') {
      let reason = 'unknown';
      let code: number | 'unknown' = 'unknown';
      try {
        if (typeof exitDetails?.reason === 'string' && RENDERER_EXIT_REASONS.has(exitDetails.reason)) reason = exitDetails.reason;
        if (typeof exitDetails?.exitCode === 'number' && Number.isSafeInteger(exitDetails.exitCode)) code = exitDetails.exitCode;
      } catch { /* unavailable details do not affect the incident */ }
      localExitDiagnostic = { renderer_exit_reason: reason, renderer_exit_code: code };
    }
    // Best effort only: diagnostics must never change navigation or recovery.
    try { log.warn('browser failure', { ...payload, ...localExitDiagnostic }); } catch { /* no recursive logging */ }

  };
}

// Shared across tabs, tasks, accounts and windows for this main-process lifetime.
export const logWebAssistFailure = createWebAssistDiagnostics();
