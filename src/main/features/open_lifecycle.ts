/** Open-source-build application lifecycle reporting through the guarded Server API. */

import { createLogger } from '../logger';
import { logErrorRef } from '../util/log-redact';
import { fetchWithRetry } from '../util/retry';
import { safeId } from '../storage';
import { withCommonHeaders } from './api_common';
import { apiBase } from './marketplace';


export type OpenLifecycleEvent = 'enter' | 'leave';
export type OpenLifecycleTrigger = 'cold_start' | 'foreground' | 'background' | 'quit';

export interface OpenLifecycleRecord {
  event: OpenLifecycleEvent;
  trigger: OpenLifecycleTrigger;
}

interface AppEventSource {
  on(event: 'browser-window-focus' | 'browser-window-blur' | 'before-quit', listener: () => void): unknown;
  off(event: 'browser-window-focus' | 'browser-window-blur' | 'before-quit', listener: () => void): unknown;
}

interface StartOptions {
  app: AppEventSource;
  getActiveUserId: () => string;
  hasFocusedWindow: () => boolean;
  enabled?: boolean;
  emit?: (record: OpenLifecycleRecord) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  blurSettleMs?: number;
}

const log = createLogger('open-lifecycle');
const REQUEST_TIMEOUT_MS = 5_000;
const BLUR_SETTLE_MS = 200;
const WARNING_INTERVAL_MS = 60_000;
let lastWarningAt = 0;

function warnTransport(message: string, detail: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastWarningAt < WARNING_INTERVAL_MS) return;
  lastWarningAt = now;
  log.warn(message, detail);
}

export function openLifecycleRequestBody(
  uid: string,
  record: OpenLifecycleRecord,
): { uid: string; event: OpenLifecycleEvent; trigger: OpenLifecycleTrigger } {
  return { uid, event: record.event, trigger: record.trigger };
}

export function reportOpenLifecycle(uid: string, record: OpenLifecycleRecord): void {
  if (!safeId(uid) || uid.length > 50) {
    warnTransport('lifecycle event skipped because the active uid is invalid', { reason: 'invalid_uid' });
    return;
  }
  void (async () => {
    const response = await fetchWithRetry(
      'open-lifecycle',
      `${apiBase()}/analytics/open-app-lifecycle`,
      {
        method: 'POST',
        headers: withCommonHeaders({
          'Content-Type': 'application/json',
          Accept: 'application/json',
        }),
        body: JSON.stringify(openLifecycleRequestBody(uid, record)),
      },
      {
        retries: 0,
        timeoutMs: REQUEST_TIMEOUT_MS,
        timeoutMessage: 'open lifecycle request timed out',
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      warnTransport('lifecycle event rejected', { status_code: response.status });
      return;
    }
    await response.body?.cancel().catch(() => {});
  })().catch((error) => {
    warnTransport('lifecycle event delivery failed', { error: logErrorRef(error) });
  });
}

export class OpenLifecycleState {
  private started = false;
  private foreground = false;

  constructor(private readonly emit: (record: OpenLifecycleRecord) => void) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.foreground = true;
    this.emit({ event: 'enter', trigger: 'cold_start' });
  }

  enterForeground(): void {
    if (!this.started || this.foreground) return;
    this.foreground = true;
    this.emit({ event: 'enter', trigger: 'foreground' });
  }

  leaveForeground(trigger: 'background' | 'quit'): void {
    if (!this.started || !this.foreground) return;
    this.foreground = false;
    this.emit({ event: 'leave', trigger });
  }
}

export function startOpenLifecycleTracking(options: StartOptions): () => void {
  if (options.enabled === false) return () => {};
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const state = new OpenLifecycleState(options.emit || ((record) => {
    try {
      reportOpenLifecycle(options.getActiveUserId(), record);
    } catch (error) {
      warnTransport('lifecycle event preparation failed', { error: logErrorRef(error) });
    }
  }));
  let blurTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelBlurTimer = () => {
    if (blurTimer === null) return;
    clearTimer(blurTimer);
    blurTimer = null;
  };
  const onFocus = () => {
    cancelBlurTimer();
    state.enterForeground();
  };
  const onBlur = () => {
    cancelBlurTimer();
    blurTimer = setTimer(() => {
      blurTimer = null;
      if (!options.hasFocusedWindow()) state.leaveForeground('background');
    }, options.blurSettleMs ?? BLUR_SETTLE_MS);
  };
  const onBeforeQuit = () => {
    cancelBlurTimer();
    state.leaveForeground('quit');
  };

  options.app.on('browser-window-focus', onFocus);
  options.app.on('browser-window-blur', onBlur);
  options.app.on('before-quit', onBeforeQuit);
  state.start();

  return () => {
    cancelBlurTimer();
    options.app.off('browser-window-focus', onFocus);
    options.app.off('browser-window-blur', onBlur);
    options.app.off('before-quit', onBeforeQuit);
  };
}
