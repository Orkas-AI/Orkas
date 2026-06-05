/**
 * Central logger — wraps `electron-log/main` with:
 *
 *   - **Daily file rotation** via `resolvePathFn` returning a date-suffixed
 *     path (`YYYY-MM-DD.log`); electron-log opens a fresh file whenever
 *     the path changes, which naturally happens at midnight.
 *   - **Per-file size cap** so a chatty day doesn't produce a 1 GB file —
 *     once a file hits `FILE_MAX_BYTES`, electron-log archives it to
 *     `YYYY-MM-DD.old.log` and starts a new one for the same day.
 *   - **Retention sweep on boot**: drop files older than `RETAIN_DAYS`
 *     days, then (if the logs dir still exceeds `TOTAL_MAX_BYTES`) drop
 *     the oldest until under cap. Runs once per process start — no
 *     timers, no background work.
 *   - **Sensitive-field redaction** via an electron-log hook: any object
 *     property whose name matches our secret-looking key set is masked
 *     before the record is serialized. Stack traces and plain strings
 *     pass through unchanged.
 *   - **Scoped loggers** — `createLogger('auth')` yields a logger that
 *     stamps every record with `[auth]`, so the file reads at-a-glance
 *     as `[2026-04-20 14:23:45.123] [info] [auth] OAuth flow started`.
 *
 * The console transport stays on too: in dev you see the same events in
 * the DevTools / terminal, with a lighter format.
 *
 * Renderer-side callers talk to us through the `orkas.log` IPC channel
 * (wired in `main/ipc/index.ts`); every renderer record gets a
 * `renderer/<module>` scope so it's distinguishable from main-side work.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import log from 'electron-log/main';
import type { LogMessage } from 'electron-log';

import { LOGS_DIR } from './paths';
import { maskLogId, sanitizeLogTextForUpload } from './util/log-sanitize';

// ── Tunables ─────────────────────────────────────────────────────────────

const RETAIN_DAYS     = 7;
const FILE_MAX_BYTES  = 10 * 1024 * 1024;   // 10 MB per file
const TOTAL_MAX_BYTES = 100 * 1024 * 1024;  // 100 MB across the logs dir

// ── Date helpers ─────────────────────────────────────────────────────────

function dateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// File names we manage: either `YYYY-MM-DD.log` (current) or the archive
// variants electron-log creates under size pressure (`...old.log`,
// `...1.log`, etc.). We leave anything else alone.
const LOG_FILE_RE = /^\d{4}-\d{2}-\d{2}.*\.log$/;

function datePrefixOf(name: string): string | null {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// ── Sensitive-field redaction ────────────────────────────────────────────

// Keys that may carry secrets or PII — redacted regardless of nesting depth.
// Matched case-insensitively against property names. `name` is intentionally
// NOT here (too broad: agent.name / connector.name / project.name / filename
// are all legit business values).
const REDACT_KEYS = new Set([
  'key', 'apikey', 'api_key',
  'access', 'refresh',
  'token', 'accesstoken', 'refreshtoken', 'access_token', 'refresh_token',
  'idtoken', 'id_token',
  'sessionid', 'session_id', 'sid',
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

const MASK = '***REDACTED***';

/**
 * Return a deep-cloned version of `v` with sensitive-looking fields masked.
 * - Strings are scanned for positional secrets, so `token=...`,
 *   `Authorization: Bearer ...`, JWTs, email addresses, and phone numbers
 *   are masked even when callers interpolate them into message text.
 * - Circular refs are short-circuited to `'[circular]'`.
 * - Errors keep their name/message/stack shape, but message and stack text
 *   are sanitized before they reach file/console transports.
 */
export function redact(v: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return sanitizeLogTextForUpload(v);
  if (typeof v !== 'object') return v;

  if (seen.has(v as object)) return '[circular]';
  seen.add(v as object);

  if (v instanceof Error) {
    const out = new Error(sanitizeLogTextForUpload(v.message || ''));
    out.name = sanitizeLogTextForUpload(v.name || 'Error');
    if (typeof v.stack === 'string') out.stack = sanitizeLogTextForUpload(v.stack);
    for (const [k, val] of Object.entries(v as Error & Record<string, unknown>)) {
      if (k === 'name' || k === 'message' || k === 'stack') continue;
      const key = k.toLowerCase();
      if (REDACT_KEYS.has(key)) {
        (out as Error & Record<string, unknown>)[k] = MASK;
      } else if (MASK_ID_KEYS.has(key)) {
        (out as Error & Record<string, unknown>)[k] = maskLogId(val);
      } else {
        (out as Error & Record<string, unknown>)[k] = redact(val, seen);
      }
    }
    return out;
  }

  if (Array.isArray(v)) return v.map((it) => redact(it, seen));

  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = MASK;
    } else if (MASK_ID_KEYS.has(k.toLowerCase())) {
      out[k] = maskLogId(val);
    } else {
      out[k] = redact(val, seen);
    }
  }
  return out;
}

// ── Retention sweep ──────────────────────────────────────────────────────

interface FileStat {
  name: string;
  full: string;
  size: number;
  mtimeMs: number;
  datePrefix: string;
}

function listLogFiles(): FileStat[] {
  let names: string[];
  try { names = fs.readdirSync(LOGS_DIR); } catch { return []; }
  const out: FileStat[] = [];
  for (const name of names) {
    if (!LOG_FILE_RE.test(name)) continue;
    const full = path.join(LOGS_DIR, name);
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({
      name,
      full,
      size: st.size,
      mtimeMs: st.mtimeMs,
      datePrefix: datePrefixOf(name) || '',
    });
  }
  return out;
}

/**
 * Delete:
 *   1. files whose date prefix is older than `RETAIN_DAYS`, OR
 *   2. oldest-first until total size fits under `TOTAL_MAX_BYTES` (if it
 *      still overshoots after step 1).
 *
 * Today's live file is skipped — we never delete the file electron-log
 * is currently appending to, even if size/age rules would otherwise hit
 * it. Exposed for testing.
 */
export function sweepLogs(now: Date = new Date()): {
  removed: string[];
  reason: Record<string, 'age' | 'size'>;
} {
  const todayKey = dateKey(now);
  const files = listLogFiles();
  const ageLimitMs = now.getTime() - RETAIN_DAYS * 24 * 60 * 60 * 1000;

  const removed: string[] = [];
  const reason: Record<string, 'age' | 'size'> = {};

  // Phase 1: drop anything older than RETAIN_DAYS. Use the date prefix —
  // a mis-stamped mtime shouldn't spare a genuinely old file.
  const survivors: FileStat[] = [];
  for (const f of files) {
    if (f.datePrefix && f.datePrefix < todayKey) {
      const fileDate = new Date(`${f.datePrefix}T00:00:00`).getTime();
      if (fileDate < ageLimitMs) {
        try { fs.unlinkSync(f.full); removed.push(f.name); reason[f.name] = 'age'; continue; }
        catch { /* fall through — leave the file, we'll try again next boot */ }
      }
    }
    survivors.push(f);
  }

  // Phase 2: if still over total cap, drop oldest (by date prefix, then
  // mtime as tiebreak). Never touch today's live file.
  let totalSize = survivors.reduce((s, f) => s + f.size, 0);
  if (totalSize > TOTAL_MAX_BYTES) {
    survivors.sort((a, b) => {
      if (a.datePrefix !== b.datePrefix) return a.datePrefix.localeCompare(b.datePrefix);
      return a.mtimeMs - b.mtimeMs;
    });
    for (const f of survivors) {
      if (totalSize <= TOTAL_MAX_BYTES) break;
      if (f.datePrefix === todayKey && f.name === `${todayKey}.log`) continue;
      try { fs.unlinkSync(f.full); removed.push(f.name); reason[f.name] = 'size'; totalSize -= f.size; }
      catch { /* keep going */ }
    }
  }

  return { removed, reason };
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

  try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch { /* noop */ }

  // Level config — `ORKAS_LOG_LEVEL` overrides in both environments; dev
  // gets verbose console by default so you see activity while coding.
  const fileLevel = (process.env.ORKAS_LOG_LEVEL as any) || 'info';
  const consoleLevel = process.env.ORKAS_DEVTOOLS ? 'debug' : (process.env.ORKAS_LOG_LEVEL as any) || 'info';

  log.transports.file.level    = fileLevel;
  log.transports.console.level = consoleLevel;

  // Daily file path — electron-log reopens the file whenever the resolved
  // path changes, so at midnight the next write naturally lands in a new
  // `YYYY-MM-DD.log`. Size-based rotation (maxSize) produces `.old.log`
  // siblings for the same day.
  log.transports.file.resolvePathFn = () =>
    path.join(LOGS_DIR, `${dateKey()}.log`);

  log.transports.file.maxSize = FILE_MAX_BYTES;

  log.transports.file.format    = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] [{scope}] {text}';
  log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] [{scope}] {text}';

  // Redaction hook — runs for every record before formatting. Walk the
  // `data` array (the arguments passed to log.info(...) etc.) and mask
  // any object property named like a secret.
  log.hooks.push((message: LogMessage) => {
    message.data = message.data.map((d) => redact(d));
    return message;
  });

  // Catch uncaught main-process errors. Must come after transports are
  // configured so the first error hits the file.
  try { log.errorHandler.startCatching({ showDialog: false }); } catch { /* noop */ }

  // Bridge plain `console.{info,warn,error}` into electron-log so that
  // libraries with their own stdlib-style logger (notably core-agent's
  // `shared/logger.ts`, which `pi-provider.ts` uses) actually land in
  // `data/logs/`. Without this, core-agent stream errors only print to
  // stderr and disappear when the dev terminal is closed — making "fetch
  // failed" impossible to retro-diagnose. We keep the original console
  // intact so dev-mode terminal output is unchanged.
  try {
    const consoleScope = log.scope('console');
    const orig = {
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    console.info = (...args: any[]) => { try { consoleScope.info(...args); } catch { /* noop */ } orig.info(...args); };
    console.warn = (...args: any[]) => { try { consoleScope.warn(...args); } catch { /* noop */ } orig.warn(...args); };
    console.error = (...args: any[]) => { try { consoleScope.error(...args); } catch { /* noop */ } orig.error(...args); };
  } catch { /* noop */ }

  // One-shot retention sweep. Log the outcome via the newly-initialized
  // logger so the first line in today's file reads self-diagnostic.
  const sweep = sweepLogs();
  const boot = log.scope('logger');
  if (sweep.removed.length > 0) {
    boot.info(`retention sweep: removed ${sweep.removed.length} file(s)`, sweep.reason);
  } else {
    boot.info(`retention sweep: nothing to drop (${RETAIN_DAYS}d / ${Math.round(TOTAL_MAX_BYTES / 1024 / 1024)}MB caps)`);
  }
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
  const scope = (module || 'app').trim() || 'app';
  const s = log.scope(scope);
  return {
    error: (msg, ...args) => s.error(msg, ...args),
    warn:  (msg, ...args) => s.warn (msg, ...args),
    info:  (msg, ...args) => s.info (msg, ...args),
    debug: (msg, ...args) => s.debug(msg, ...args),
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
  const args = Array.isArray(p.data) ? p.data : [];
  switch ((p.level || 'info').toLowerCase()) {
    case 'error': return scoped.error(msg, ...args);
    case 'warn':  return scoped.warn (msg, ...args);
    case 'debug': return scoped.debug(msg, ...args);
    default:      return scoped.info (msg, ...args);
  }
}
