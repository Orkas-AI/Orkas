/**
 * Scoped logger with bounded, sanitized snapshots on the calling thread.
 * A worker owns file creation, daily/size rotation, retention and console I/O.
 * The mailbox reserves capacity for warnings/errors; saturation never waits
 * for diagnostic I/O. Renderer records arrive through the existing log IPC.
 */

const { sweepLogDirectory } = require('./util/log-retention');

import log from 'electron-log/main';
import type { LogMessage } from 'electron-log';

import { LOGS_DIR } from './paths';
import { createLogDelivery } from './util/log-delivery';
import { maskLogId, sanitizeLogTextForUpload } from './util/log-sanitize';

// ── Tunables ─────────────────────────────────────────────────────────────

const RETAIN_DAYS     = 7;
const FILE_MAX_BYTES  = 10 * 1024 * 1024;   // 10 MB per file
const TOTAL_MAX_BYTES = 100 * 1024 * 1024;  // 100 MB across the logs dir

type ConsoleWrite = (...args: any[]) => void;

export function isBrokenPipeError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EPIPE';
}

/**
 * Console output is diagnostic-only and must never take down the Electron
 * main process after its launcher/terminal closes the inherited pipe.
 */
export function writeConsoleSafely(
  write: ConsoleWrite,
  args: any[],
  onBrokenPipe?: () => void,
): void {
  try {
    write(...args);
  } catch (error) {
    if (!isBrokenPipeError(error)) throw error;
    onBrokenPipe?.();
  }
}

// ── Sensitive-field redaction ────────────────────────────────────────────

// Keys that may carry secrets or PII — redacted regardless of nesting depth.
// Matched case-insensitively against property names. `name` is intentionally
// NOT here (too broad: agent.name / connector.name / project.name are
// legitimate business values). File/path fields use the separate path mask.
const REDACT_KEYS = new Set([
  'key', 'apikey', 'api_key',
  'access', 'refresh',
  'token', 'accesstoken', 'refreshtoken', 'access_token', 'refresh_token',
  'idtoken', 'id_token',
  'sessionid', 'session_id', 'sid',
  'cid', 'conversationid', 'conversation_id',
  'secret', 'clientsecret', 'client_secret',
  'password', 'passwd', 'pwd',
  'authorization',
  'cookie', 'setcookie', 'set-cookie',
  // PII (defense-in-depth — no current call site logs these unmasked, but
  // the rule shields against future regressions).
  'phone', 'mobile',
  'email',
  'username',
]);

const MASK_ID_KEYS = new Set([
  'uid', 'userid', 'user_id',
]);

const PRIVATE_FILE_KEYS = new Set([
  'path', 'abspath', 'abs_path', 'relpath', 'rel_path',
  'filepath', 'file_path', 'filename', 'file_name',
  'workingdir', 'working_dir', 'cwd',
]);

const MASK = '***REDACTED***';
const PATH_MASK = '***REDACTED_PATH***';

/**
 * Return a deep-cloned version of `v` with sensitive-looking fields masked.
 * - Strings are scanned for positional secrets, so `token=...`,
 *   `Authorization: Bearer ...`, JWTs, email addresses, and phone numbers
 *   are masked even when callers interpolate them into message text.
 * - Circular refs are short-circuited to `'[circular]'`.
 * - Errors keep their name/message/stack shape, but message and stack text
 *   are sanitized before they reach file/console transports.
 */
export function redact(v: unknown, seen: WeakSet<object> = new WeakSet(), budget = { nodes: 0, chars: 0 }, depth = 0, wire = false): unknown {
  if (++budget.nodes > 128 || depth > 6) return '[truncated]';
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    if (v.length > 4096 || budget.chars + v.length > 16384) return '[oversized text omitted]';
    budget.chars += v.length;
    return sanitizeLogTextForUpload(v);
  }
  if (typeof v === 'function' || typeof v === 'symbol') return '[unsupported]';
  if (typeof v !== 'object') return v;

  if (seen.has(v as object)) return '[circular]';
  seen.add(v as object);

  if (v instanceof Error) {
    const out = new Error(String(redact(v.message || '', seen, budget, depth + 1, wire)));
    out.name = String(redact(v.name || 'Error', seen, budget, depth + 1, wire));
    if (typeof v.stack === 'string') out.stack = String(redact(v.stack, seen, budget, depth + 1, wire));
    let keys = 0;
    for (const k in v) {
      if (++keys > 32 || budget.nodes >= 128) break;
      if (k.length > 128 || k === '__proto__') continue;
      const descriptor = Object.getOwnPropertyDescriptor(v, k);
      if (!descriptor) continue;
      const val = 'value' in descriptor ? descriptor.value : '[accessor]';
      if (k === 'name' || k === 'message' || k === 'stack') continue;
      const key = k.toLowerCase();
      if (REDACT_KEYS.has(key)) {
        (out as Error & Record<string, unknown>)[k] = MASK;
      } else if (PRIVATE_FILE_KEYS.has(key) && typeof val === 'string') {
        (out as Error & Record<string, unknown>)[k] = PATH_MASK;
      } else if (MASK_ID_KEYS.has(key)) {
        (out as Error & Record<string, unknown>)[k] = maskLogId(typeof val === 'string' && val.length <= 4096 ? val : '[omitted]');
      } else {
        (out as Error & Record<string, unknown>)[k] = redact(val, seen, budget, depth + 1, wire);
      }
    }
    return wire ? { ...out, name: out.name, message: out.message, stack: out.stack } : out;
  }

  if (Array.isArray(v)) {
    const items = [];
    for (let i = 0; i < Math.min(v.length, 32); i++) {
      const element = Object.getOwnPropertyDescriptor(v, String(i));
      items.push(element && 'value' in element ? redact(element.value, seen, budget, depth + 1, wire) : '[accessor]');
    }
    return items;
  }

  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const k in v) {
    if (++keys > 32 || budget.nodes >= 128) { out.truncated = true; break; }
    const descriptor = Object.getOwnPropertyDescriptor(v, k);
    if (!descriptor) continue;
    const val = 'value' in descriptor ? descriptor.value : '[accessor]';
    if (k.length > 128 || k === '__proto__') continue;
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = MASK;
    } else if (PRIVATE_FILE_KEYS.has(k.toLowerCase()) && typeof val === 'string') {
      out[k] = PATH_MASK;
    } else if (MASK_ID_KEYS.has(k.toLowerCase())) {
      out[k] = maskLogId(typeof val === 'string' && val.length <= 4096 ? val : '[omitted]');
    } else {
      out[k] = redact(val, seen, budget, depth + 1, wire);
    }
  }
  return out;
}

// ── Retention sweep ──────────────────────────────────────────────────────

/** Retention policy is shared with the file worker; exposed for isolated tests. */
export function sweepLogs(now: Date = new Date()): { removed: string[]; reason: Record<string, 'age' | 'size'> } {
  return sweepLogDirectory(LOGS_DIR, RETAIN_DAYS, TOTAL_MAX_BYTES, now);
}

// ── Bootstrap ────────────────────────────────────────────────────────────

let _initialized = false;

/**
 * Initialize electron-log once per process. Safe to call before Electron
 * `app.ready` — file access only happens on the first write.
 */
export function initLogger(): void {
  if (_initialized) return;
  _initialized = true;

  const levels = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'];
  const configuredLevel = process.env.ORKAS_LOG_LEVEL || 'info';
  const fileLevel = levels.includes(configuredLevel) ? configuredLevel : 'info';
  const consoleLevel = process.env.ORKAS_DEVTOOLS ? 'debug' : fileLevel;
  // Disable direct transports before starting the worker: startup failure must
  // never fall back to synchronous disk I/O in the business process.
  log.transports.file.level = false;
  log.transports.console.level = false;
  // Renderer logging already has its own bounded bridge and console mirror.
  // electron-log's implicit development IPC serializes raw data synchronously.
  if (log.transports.ipc) log.transports.ipc.level = false;
  try {
    const delivery = createLogDelivery({
      directory: LOGS_DIR, fileLevel, consoleLevel,
      retainDays: RETAIN_DAYS, fileMaxBytes: FILE_MAX_BYTES, totalMaxBytes: TOTAL_MAX_BYTES,
    });
    const transport = (message: LogMessage) => {
      if (!delivery.canAccept(message.level)) { delivery.noteDrop(); return; }
      try {
        delivery.send({
          level: message.level, scope: typeof message.scope === 'string' ? sanitizeLogTextForUpload(message.scope.slice(0, 128)) : '',
          date: message.date,
          data: redact(message.data.slice(0, 16), new WeakSet(), { nodes: 0, chars: 0 }, 0, true),
        });
      } catch (_) { /* Logging must not fail the business operation. */ }
    };
    (transport as any).level = levels[Math.max(levels.indexOf(fileLevel), levels.indexOf(consoleLevel))];
    (log.transports as any).background = transport;
  } catch (_) { /* Worker unavailable: retain business availability. */ }

  // Catch uncaught main-process errors. Must come after transports are
  // configured so the first error hits the file.
  try { log.errorHandler.startCatching({ showDialog: false }); } catch { /* noop */ }

  // Bridge plain `console.{info,warn,error}` into electron-log so that
  // libraries with their own stdlib-style logger (notably core-agent's
  // `shared/logger.ts`, which `pi-provider.ts` uses) actually land in
  // `data/logs/`. Without this, core-agent stream errors only print to
  // stderr and disappear when the dev terminal is closed — making "fetch
  // failed" impossible to retro-diagnose. The console transport writes each
  // bridged record once in the worker.
  try {
    const consoleScope = log.scope('console');
    console.info = (...args: any[]) => { try { consoleScope.info(...args); } catch { /* noop */ } };
    console.warn = (...args: any[]) => { try { consoleScope.warn(...args); } catch { /* noop */ } };
    console.error = (...args: any[]) => { try { consoleScope.error(...args); } catch { /* noop */ } };
  } catch { /* noop */ }

  // The worker owns retention, file creation, rotation and console transport.

}

// ── Scoped-logger factory ────────────────────────────────────────────────

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn (message: string, ...args: unknown[]): void;
  info (message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Get a logger scoped to a functional module. The `module` string appears
 * as `[<module>]` in every record and in file/console output, so sweeping
 * for a single subsystem's activity is `grep '\[auth\]' .../logs/*.log`.
 *
 * Usage:
 *   const log = createLogger('auth');
 *   log.info('OAuth flow started', { provider: 'minimax-portal' });
 */
export function createLogger(module: string): Logger {
  const scope = typeof module === 'string' && module.length <= 128 ? sanitizeLogTextForUpload(module.trim()) || 'app' : 'app';
  const s = log.scope(scope);
  return {
    error: (msg, ...args) => { initLogger(); s.error(msg, ...args); },
    warn:  (msg, ...args) => { initLogger(); s.warn(msg, ...args); },
    info:  (msg, ...args) => { initLogger(); s.info(msg, ...args); },
    debug: (msg, ...args) => { initLogger(); s.debug(msg, ...args); },
  };
}

/**
 * Exported for `main/ipc/index.ts`: receives a log record forwarded from
 * the renderer process and routes it through a `renderer/<module>` scope.
 * Levels outside our four-tier set collapse to `info`.
 */
export function logFromRenderer(payload: {
  level?: string;
  module?: string;
  message?: string;
  data?: unknown[];
} | null | undefined): void {
  const p = payload || {};
  const module = String(p.module || 'app').trim() || 'app';
  const scoped = createLogger(`renderer/${module}`);
  const msg = String(p.message ?? '');
  const args = Array.isArray(p.data) ? p.data.slice(0, 16) : [];
  switch ((p.level || 'info').toLowerCase()) {
    case 'error': return scoped.error(msg, ...args);
    case 'warn':  return scoped.warn (msg, ...args);
    case 'debug': return scoped.debug(msg, ...args);
    default:      return scoped.info (msg, ...args);
  }
}
