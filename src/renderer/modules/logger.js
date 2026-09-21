/**
 * Renderer-side logger bridge.
 *
 * Every call is forwarded to main via `window.orkas.log({ level, module,
 * message, data })`. Main's `logFromRenderer()` routes the record through
 * `electron-log` under a `renderer/<module>` scope, so renderer activity
 * ends up in the same daily file as main-process activity, grep-able
 * by subsystem tag.
 *
 * Usage (vanilla, matches the classic-script pattern used elsewhere):
 *
 *   const rlog = createLogger('conversation');
 *   rlog.info('message sent', { cid, length: text.length });
 *   rlog.warn('unexpected shape', { response });
 *   rlog.error('save failed', err);
 *
 * Sensitive data: the main-side redaction hook masks object fields whose
 * key name matches our secret set (key/token/secret/...). Renderer code
 * should still avoid logging full message bodies / chat content — pass
 * lengths or hashes, not payloads.
 *
 * This file is loaded as a classic `<script>` (no ESM) and exposes
 * `createLogger` as a top-level `const` — sibling modules reach it via
 * the shared lexical environment, matching the existing renderer
 * convention.
 */

// eslint-disable-next-line no-unused-vars
const createLogger = (function () {
  const SECRET_KEY_RE = /^(?:api_?key|access_?token|refresh_?token|id_?token|session_?id|client_?secret|private_?key|password|passwd|pwd|secret|token|authorization|cookie|set-cookie|phone|mobile|email|username)$/i;
  const PRIVATE_FILE_KEY_RE = /^(?:path|abs_?path|rel_?path|file_?path|file_?name|filename|working_?dir|cwd)$/i;
  const PATH_END = '(?=\\s+(?:then|while|failed|failure|error|at|from|to|for|because|with)\\b|$|[\\\'",);`])';
  const FILE_URL_RE = new RegExp(`file:\\/\\/\\/?[^\\n\\r)'";]+?${PATH_END}`, 'gi');
  const POSIX_PATH_RE = new RegExp(`(^|[\\s"'(=])\\/(?:Users|private|var|tmp|Volumes|home|opt)\\/[^\\n\\r)<>'";]+?${PATH_END}`, 'g');
  const WINDOWS_PATH_RE = new RegExp(`(^|[\\s"'(=])[A-Za-z]:\\\\[^\\n\\r)<>'";]+?${PATH_END}`, 'g');
  const CLOUD_PATH_RE = new RegExp(`\\bcloud\\/[^\\n\\r)'",;]+?${PATH_END}`, 'g');

  function sanitizeText(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (text.length > 4096) return '[oversized text omitted]';
    return text
      .replace(/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, 'Bearer ***')
      .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***')
      .replace(/\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, '***JWT***')
      .replace(/([?&](?:api_?key|access_?token|refresh_?token|id_?token|session_?id|client_?secret|private_?key|password|passwd|pwd|secret|token|authorization|cookie|set-cookie|code|state|signature|sign|q-ak|q-signature|x-cos-security-token|x-amz-signature|x-amz-security-token|x-amz-credential|ossaccesskeyid|security-token)=)([^&#\s"']+)/gi, '$1***')
      .replace(FILE_URL_RE, 'file:///<redacted>')
      .replace(POSIX_PATH_RE, '$1<local_path>')
      .replace(WINDOWS_PATH_RE, '$1<local_path>')
      .replace(CLOUD_PATH_RE, '<cloud_path>')
      .replace(/\b(?:sk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/g, '***TOKEN***')
      .replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1***$2')
      .replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2');
  }

  function sanitizeValue(value, seen, budget, depth = 0) {
    if (++budget.nodes > 128 || depth > 6) return '[truncated]';
    if (value == null) return value;
    if (typeof value === 'string') {
      if (budget.chars + value.length > 16384) return '[oversized text omitted]';
      budget.chars += value.length;
      return sanitizeText(value);
    }
    if (typeof value === 'function' || typeof value === 'symbol') return '[unsupported]';
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (value instanceof Error) {
      return {
        name: sanitizeText(value.name || 'Error'),
        message: sanitizeText(value.message || ''),
        stack: value.stack ? sanitizeText(value.stack) : undefined,
      };
    }
    if (Array.isArray(value)) {
      const items = [];
      for (let i = 0; i < Math.min(value.length, 32); i++) {
        const element = Object.getOwnPropertyDescriptor(value, String(i));
        items.push(element && 'value' in element ? sanitizeValue(element.value, seen, budget, depth + 1) : '[accessor]');
      }
      return items;
    }
    const out = {};
    let keys = 0;
    for (const k in value) {
      if (++keys > 32 || budget.nodes >= 128) { out.truncated = true; break; }
      if (k.length > 128 || k === '__proto__') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, k);
      if (!descriptor) continue;
      const v = 'value' in descriptor ? descriptor.value : '[accessor]';
      if (SECRET_KEY_RE.test(k)) out[k] = '***REDACTED***';
      else if (PRIVATE_FILE_KEY_RE.test(k) && typeof v === 'string') out[k] = '***REDACTED_PATH***';
      else out[k] = sanitizeValue(v, seen, budget, depth + 1);
    }
    return out;
  }

  const pending = [];
  let timer = null;
  let dropped = 0;
  function flush() {
    timer = null;
    const batch = pending.splice(0, 8);
    if (dropped) {
      batch.push({ level: 'warn', module: 'logger', message: 'Log buffer full', data: [{ dropped }] });
      dropped = 0;
    }
    for (const record of batch) {
      try {
        const fn = console[record.level] || console.log;
        fn.call(console, `[${record.module}]`, record.message, ...record.data);
      } catch (_) { /* Console failures cannot prevent file delivery. */ }
      try {
        if (window.orkas && typeof window.orkas.log === 'function') window.orkas.log(record);
      } catch (_) { /* Logging cannot fail the user action. */ }
    }
    if (pending.length) timer = setTimeout(flush, 0);
  }
  function enqueue(level, module, message, args) {
    try {
      const limit = level === 'warn' || level === 'error' ? 256 : 192;
      if (pending.length >= limit) { dropped += 1; return; }
      // Snapshot once before crossing the async boundary; later caller changes
      // must not change the diagnostic or introduce private data.
      pending.push({ level, module, message: sanitizeText(message),
        data: sanitizeValue(args.slice(0, 16), new WeakSet(), { nodes: 0, chars: 0 }) });
      if (timer === null) timer = setTimeout(flush, 0);
    } catch (_) { /* Never let logging crash the UI. */ }
  }

  return function createLogger(moduleName) {
    const m = typeof moduleName === 'string' && moduleName.length <= 128 ? sanitizeText(moduleName.trim()) || 'app' : 'app';
    return {
      error: (msg, ...args) => { enqueue('error', m, msg, args); },
      warn:  (msg, ...args) => { enqueue('warn', m, msg, args); },
      info:  (msg, ...args) => { enqueue('info', m, msg, args); },
      debug: (msg, ...args) => { enqueue('debug', m, msg, args); },
    };
  };
})();

// ── Global error capture ────────────────────────────────────────────────
//
// Surfaces unhandled renderer errors into the log file so they survive
// devtools being closed. The listener is set up once here and keys off a
// window-level guard so dev iteration (reloading the preload bridge via
// ?v= bumps) doesn't re-register duplicate handlers.

(function installGlobalErrorCapture() {
  if (window._errorCaptureInstalled) return;
  window._errorCaptureInstalled = true;

  const rootLog = createLogger('global');

  window.addEventListener('error', (ev) => {
    try {
      // Chromium delivers these notifications without an application exception.
      // Keep them visible, while retaining real callback exceptions as errors.
      if (!ev.error && (ev.message === 'ResizeObserver loop completed with undelivered notifications.'
        || ev.message === 'ResizeObserver loop limit exceeded')) {
        rootLog.warn('browser resize notification', { message: ev.message });
        return;
      }
      rootLog.error('uncaught error', {
        message: ev.message,
        source: ev.filename,
        line: ev.lineno,
        col: ev.colno,
        stack: ev.error && ev.error.stack ? String(ev.error.stack) : undefined,
      });
    } catch (_) { /* noop */ }
  });

  window.addEventListener('unhandledrejection', (ev) => {
    try {
      const reason = ev.reason;
      rootLog.error('unhandled promise rejection', {
        message: reason && reason.message ? reason.message : String(reason),
        stack:   reason && reason.stack   ? String(reason.stack) : undefined,
      });
    } catch (_) { /* noop */ }
  });
})();
