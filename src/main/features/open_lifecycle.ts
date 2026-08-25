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
  emit?: (record: OpenLifecycleRecord) => void | Promise<void>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  blurSettleMs?: number;
}

export interface OpenLifecycleTracking {
  stop: () => void;
  flushQuit: () => Promise<void>;
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

export async function reportOpenLifecycle(uid: string, record: OpenLifecycleRecord): Promise<void> {
  if (!safeId(uid) || uid.length > 50) {
    warnTransport('lifecycle event skipped because the active uid is invalid', { reason: 'invalid_uid' });
    return;
  }
  try {
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
  } catch (error) {
    warnTransport('lifecycle event delivery failed', { error: logErrorRef(error) });
  }
}

export class OpenLifecycleState {
  private started = false;
  private foreground = false;
  private quitReported = false;

  constructor(private readonly emit: (
    record: OpenLifecycleRecord,
  ) => void | Promise<void>) {}

  start(): void | Promise<void> {
    if (this.started) return;
    this.started = true;
    this.foreground = true;
    return this.emit({ event: 'enter', trigger: 'cold_start' });
  }

  enterForeground(): void | Promise<void> {
    if (!this.started || this.foreground || this.quitReported) return;
    this.foreground = true;
    return this.emit({ event: 'enter', trigger: 'foreground' });
  }

  leaveForeground(trigger: 'background' | 'quit'): void | Promise<void> {
    if (!this.started || this.quitReported) return;
    if (trigger === 'quit') {
      // A process exit is a terminal application event, not another focus
      // transition. macOS commonly blurs the last window before before-quit;
      // suppressing quit in that state made real exits disappear entirely.
      this.quitReported = true;
      this.foreground = false;
      return this.emit({ event: 'leave', trigger });
    }
    if (!this.foreground) return;
    this.foreground = false;
    return this.emit({ event: 'leave', trigger });
  }
}

export function startOpenLifecycleTracking(options: StartOptions): OpenLifecycleTracking {
  if (options.enabled === false) {
    return {
      stop: () => {},
      flushQuit: async () => {},
    };
  }
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const deliver = (record: OpenLifecycleRecord): Promise<void> => {
    try {
      return Promise.resolve(
        options.emit
          ? options.emit(record)
          : reportOpenLifecycle(options.getActiveUserId(), record),
      ).catch((error) => {
        warnTransport('lifecycle event delivery failed', { error: logErrorRef(error) });
      });
    } catch (error) {
      warnTransport('lifecycle event preparation failed', { error: logErrorRef(error) });
      return Promise.resolve();
    }
  };
  const state = new OpenLifecycleState(deliver);
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  let quitDelivery: Promise<void> | null = null;

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
  const flushQuit = (): Promise<void> => {
    cancelBlurTimer();
    if (!quitDelivery) {
      quitDelivery = Promise.resolve(state.leaveForeground('quit'));
    }
    return quitDelivery;
  };
  const onBeforeQuit = () => {
    // The main shutdown barrier awaits the same promise. Starting it here
    // keeps this module correct for callers with their own quit sequence too.
    void flushQuit();
  };

  options.app.on('browser-window-focus', onFocus);
  options.app.on('browser-window-blur', onBlur);
  options.app.on('before-quit', onBeforeQuit);
  void state.start();

  const stop = () => {
    cancelBlurTimer();
    options.app.off('browser-window-focus', onFocus);
    options.app.off('browser-window-blur', onBlur);
    options.app.off('before-quit', onBeforeQuit);
  };

  return { stop, flushQuit };
}
