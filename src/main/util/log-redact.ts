import * as crypto from 'crypto';
import * as path from 'path';

const MAX_LOG_MESSAGE_LEN = 240;

export function maskId(value: unknown): string {
  const s = String(value || '');
  if (!s) return '';
  if (s === 'anonymous') return 'anonymous';
  if (s.length <= 8) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function hashForLog(value: unknown): string {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function normalizePathForLog(value: unknown): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

export function logCorrelationId(nowMs = Date.now(), seq = 0): string {
  return `${nowMs.toString(36)}-${seq.toString(36)}`;
}

export function logPathRef(relPath: unknown): Record<string, unknown> {
  const raw = String(relPath || '');
  const rel = normalizePathForLog(raw);
  const parts = rel.split('/').filter(Boolean);
  const root = parts[0] === 'cloud' || parts[0] === 'local'
    ? parts[1] || parts[0]
    : path.isAbsolute(raw)
      ? 'absolute'
      : 'relative';
  const base = parts[parts.length - 1] || '';
  const ext = path.extname(base).toLowerCase();
  return {
    path_hash: hashForLog(rel),
    domain: root,
    depth: parts.length,
    ext: ext || undefined,
  };
}

export function logPathRefs(paths: unknown[], limit = 5): Record<string, unknown> {
  const items = (paths || []).map(logPathRef).slice(0, limit);
  return {
    count: Array.isArray(paths) ? paths.length : 0,
    sample: items,
    truncated: Array.isArray(paths) && paths.length > limit,
  };
}

export function logRenameRef(from: unknown, to: unknown): Record<string, unknown> {
  return {
    from: logPathRef(from),
    to: logPathRef(to),
  };
}

export function sanitizeLogText(value: unknown): string {
  let text = String(value ?? '');
  text = text.replace(/cloud\/[^\s'",)]+/g, (m) => `<cloud-path:${hashForLog(m)}>`);
  text = text.replace(/\/sync\/[A-Za-z0-9_/-]+/g, (m) => m.split('?')[0]);
  text = text.replace(/https?:\/\/[^\s'",)]+/g, (m) => safeUrlAction(m));
  text = text.replace(/\b(ORKLSEC1|ghp|github_pat|sk|sk-proj|xox[baprs])[-_][-_A-Za-z0-9+/=:.]{12,}\b/g, '***REDACTED***');
  if (text.length > MAX_LOG_MESSAGE_LEN) text = `${text.slice(0, MAX_LOG_MESSAGE_LEN)}...`;
  return text;
}

export function logErrorRef(err: unknown): Record<string, unknown> {
  const e = err as any;
  return {
    name: e?.name ? String(e.name) : undefined,
    code: e?.code || e?.Code || undefined,
    status: e?.status || e?.statusCode || undefined,
    message: sanitizeLogText(e?.message || String(err ?? '')),
  };
}

export function logErrorSummary(err: unknown): Record<string, unknown> {
  const e = err as any;
  const message = String(e?.message || err || '');
  return {
    name: e?.name ? String(e.name) : undefined,
    code: e?.code || e?.Code || undefined,
    status: e?.status || e?.statusCode || undefined,
    message_hash: hashForLog(message),
    message_chars: message.length,
  };
}

export function logFailureRef(result: {
  code?: unknown;
  error_key?: unknown;
  msg?: unknown;
  current_generation?: unknown;
  server_data_version?: unknown;
  used_bytes?: unknown;
  quota_bytes?: unknown;
  delta_bytes?: unknown;
}): Record<string, unknown> {
  return {
    code: result.code,
    error_key: result.error_key,
    msg: sanitizeLogText(result.msg || ''),
    current_generation: result.current_generation,
    server_data_version: result.server_data_version,
    used_bytes: result.used_bytes,
    quota_bytes: result.quota_bytes,
    delta_bytes: result.delta_bytes,
  };
}

export function safeUrlAction(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<non-url>';
  }
}
