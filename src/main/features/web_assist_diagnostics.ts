/** Low-volume browser incident samples, never page/URL or exception telemetry. */
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

export function createWebAssistDiagnostics() {
  const last = new Map<Failure, number>();
  const suppressed = new Map<Failure, number>();
  let emitted: number[] = [];
  return (sender: Pick<WebContents, 'isDestroyed' | 'send'>, failure: Failure, netCode?: unknown): void => {
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
    // Best effort only: diagnostics must never change navigation or recovery.
    try { log.warn('browser failure', payload); } catch { /* no recursive logging */ }
    try { sender.send('web-assist:failure', payload); } catch { /* no queue/retry */ }
  };
}

// Shared across tabs, tasks, accounts and windows for this main-process lifetime.
export const reportWebAssistFailure = createWebAssistDiagnostics();
