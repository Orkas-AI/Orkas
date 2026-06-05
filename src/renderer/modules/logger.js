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

  function sanitizeText(value) {
    return String(value ?? '')
      .replace(/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, 'Bearer ***')
      .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***')
      .replace(/\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, '***JWT***')
      .replace(/([?&](?:api_?key|access_?token|refresh_?token|id_?token|session_?id|client_?secret|private_?key|password|passwd|pwd|secret|token|authorization|cookie|set-cookie|code|state|signature|sign|q-ak|q-signature|x-cos-security-token|x-amz-signature|x-amz-security-token|x-amz-credential|ossaccesskeyid|security-token)=)([^&#\s"']+)/gi, '$1***')
      .replace(/\b(?:sk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/g, '***TOKEN***')
      .replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1***$2')
      .replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2');
  }

  function sanitizeValue(value, seen) {
    if (value == null) return value;
    if (typeof value === 'string') return sanitizeText(value);
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
    if (Array.isArray(value)) return value.map((it) => sanitizeValue(it, seen));
    const out = {};
    Object.entries(value).forEach(([k, v]) => {
      out[k] = SECRET_KEY_RE.test(k) ? '***REDACTED***' : sanitizeValue(v, seen);
    });
    return out;
  }

  function send(level, module, message, args) {
    try {
      if (window.orkas && typeof window.orkas.log === 'function') {
        window.orkas.log({ level, module, message: String(message ?? ''), data: args });
      }
    } catch (_) { /* never let logging crash the UI */ }
  }

  // Console mirror — helps debugging while DevTools are open. Keeps the
  // [module] prefix so the two streams read the same way.
  function mirror(level, module, message, args) {
    try {
      const tag = `[${module}]`;
      const safeMessage = sanitizeText(message);
      const safeArgs = args.map((arg) => sanitizeValue(arg, new WeakSet()));
      // eslint-disable-next-line no-console
      const fn = console[level] || console.log;
      if (safeArgs.length) fn.call(console, tag, safeMessage, ...safeArgs);
      else                 fn.call(console, tag, safeMessage);
    } catch (_) { /* noop */ }
  }

  return function createLogger(moduleName) {
    const m = String(moduleName || 'app').trim() || 'app';
    return {
      error: (msg, ...args) => { mirror('error', m, msg, args); send('error', m, msg, args); },
      warn:  (msg, ...args) => { mirror('warn',  m, msg, args); send('warn',  m, msg, args); },
      info:  (msg, ...args) => { mirror('info',  m, msg, args); send('info',  m, msg, args); },
      debug: (msg, ...args) => { mirror('debug', m, msg, args); send('debug', m, msg, args); },
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
