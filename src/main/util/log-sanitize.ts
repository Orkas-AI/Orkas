/**
 * Best-effort positional redaction for log text.
 *
 * The logger's `redact()` hook covers NAMED object fields (token / api_key
 * / email / ...) but callers still stitch values into positional strings:
 * `log.warn(\`token=${val}\`)`. This util applies narrow regex masks for
 * shapes that are unambiguously sensitive in plain text:
 *
 *   - "Bearer <token>" / "Basic <token>" -> "<scheme> ***"
 *   - JWT (3 base64url segs)             -> "***JWT***"
 *   - obvious key=value / JSON fields    -> "<key>=***" / "<key>":"***"
 *   - sensitive URL query params         -> "?access_token=***"
 *   - common secret prefixes             -> "***TOKEN***"
 *   - email a@b.c                        -> "a***@b.c"     (Server parity)
 *   - CN mobile 13800138000              -> "138****8000"  (Server parity)
 *
 * Opaque hex/SHA tokens (32+ chars of [a-f0-9]) are deliberately NOT
 * masked — too many false positives (commit shas, file hashes, paths).
 */
import * as crypto from 'node:crypto';

const SENSITIVE_FIELD =
  '(?:api_?key|access_?token|refresh_?token|id_?token|session_?id|client_?secret|private_?key|password|passwd|pwd|secret|token|authorization|cookie|set-cookie)';

const SENSITIVE_QUERY_FIELD =
  '(?:api_?key|access_?token|refresh_?token|id_?token|session_?id|client_?secret|private_?key|password|passwd|pwd|secret|token|authorization|cookie|set-cookie|code|state|signature|sign|q-ak|q-signature|x-cos-security-token|x-amz-signature|x-amz-security-token|x-amz-credential|ossaccesskeyid|security-token)';

const JSON_SECRET_FIELD_RE = new RegExp(
  `(["'])(${SENSITIVE_FIELD})\\1(\\s*:\\s*)(["'])(.*?)\\4`,
  'gi',
);

const KV_SECRET_FIELD_RE = new RegExp(
  `\\b(${SENSITIVE_FIELD})(\\s*=\\s*)([^\\s,;&"']+)`,
  'gi',
);

const QUERY_SECRET_FIELD_RE = new RegExp(
  `([?&](${SENSITIVE_QUERY_FIELD})=)([^&#\\s"']+)`,
  'gi',
);

const CLOUD_PATH_RE = /\bcloud\/[^\s'",)]+/g;
const FILE_URL_RE = /\bfile:\/\/\/?[^\s'",)]+/gi;
const POSIX_ABS_PATH_RE = /(^|[\s'",(])((?:\/Users|\/private|\/var|\/tmp|\/Volumes|\/home|\/opt)\/[^\s'",)]+)/g;
const WINDOWS_ABS_PATH_RE = /\b[A-Za-z]:\\[^\s'",)]+/g;

function hashForLog(value: unknown): string {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function normalizePathForHash(value: string): string {
  return value.replace(/\\/g, '/');
}

function pathPlaceholder(kind: 'cloud' | 'abs' | 'file-url', value: string): string {
  return `<${kind}-path:${hashForLog(normalizePathForHash(value))}>`;
}

export function maskLogId(value: unknown): string {
  const s = String(value ?? '');
  if (!s) return '';
  if (s === 'anonymous') return 'anonymous';
  if (s.length <= 8) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

export function sanitizeLogTextForUpload(text: string): string {
  if (!text) return text;
  return text
    // User content paths often carry private filenames or OS usernames. Keep a
    // stable hash for correlation, but never the raw path.
    .replace(CLOUD_PATH_RE, (m) => pathPlaceholder('cloud', m))
    .replace(FILE_URL_RE, (m) => pathPlaceholder('file-url', m))
    .replace(POSIX_ABS_PATH_RE, (_m, prefix: string, p: string) => `${prefix}${pathPlaceholder('abs', p)}`)
    .replace(WINDOWS_ABS_PATH_RE, (m) => pathPlaceholder('abs', m))
    // Bearer in Authorization header — covers raw "Authorization: Bearer X"
    // and JSON-stringified "\"authorization\":\"Bearer X\"". Case-insensitive
    // because RFC 6750 declares the scheme name case-insensitive.
    .replace(/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, 'Bearer ***')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***')
    // JWT — three base64url segments, first two starting "eyJ" (base64 of "{").
    .replace(/\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, '***JWT***')
    // JSON-ish secret fields, preserving the original quote style.
    .replace(JSON_SECRET_FIELD_RE, (_m, q1: string, key: string, sep: string, q2: string) =>
      `${q1}${key}${q1}${sep}${q2}***${q2}`)
    // Plain key=value fragments in exception messages / HTTP client output.
    .replace(KV_SECRET_FIELD_RE, (_m, key: string, sep: string) => `${key}${sep}***`)
    // URL query params. `code` / `state` are masked only when query-shaped.
    .replace(QUERY_SECRET_FIELD_RE, (_m, prefix: string) => `${prefix}***`)
    // User ids are not secrets, but they are user-private identifiers.
    .replace(/\b(uid|user_id|userId)(\s*=\s*)([A-Za-z0-9_-]{9,})/g, (_m, key: string, sep: string, id: string) =>
      `${key}${sep}${maskLogId(id)}`)
    // Common provider token prefixes. Keep the broad random-hex space intact.
    .replace(/\b(?:sk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/g, '***TOKEN***')
    .replace(/\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/g, '***TOKEN***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***TOKEN***')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '***TOKEN***')
    // Email — keep first local char + full domain for diagnostic value.
    .replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1***$2')
    // CN mobile (11 digits starting 1[3-9]) — keep first 3 + last 4.
    .replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2');
}
