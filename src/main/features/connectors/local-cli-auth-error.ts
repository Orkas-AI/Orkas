/** Public authorization diagnostics from failed official CLI output.
 * Exit status remains the authority for failure; transcript text never decides success or retry.
 * Only the bounded, sanitized message crosses to the renderer. Never log it or the transcript.
 */
import { stripVTControlCharacters } from 'node:util';
import { sanitizeLogTextForUpload } from '../../util/log-sanitize';

const MAX_OUTPUT = 64 * 1024;
const MAX_DETAIL = 1200;
const SECRET_FIELD = '(?:access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|token|client[-_ ]?secret|app[-_ ]?secret|api[-_ ]?key|password|secret|device[-_ ]?code|user[-_ ]?code|auth[-_ ]?code|session[-_ ]?id)';
const SECRET_VALUE = new RegExp(`(["']?${SECRET_FIELD}["']?\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*(?:"|$)|'(?:\\\\.|[^'\\\\])*(?:'|$)|[^\\s,;]+)`, 'gi');

export function sanitizeAuthorizationDetail(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Redact before truncating, so a cut-off credential cannot evade its complete-token pattern.
  let text = stripVTControlCharacters(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b(?:https?:\/\/|file:\/\/)[^\s<>"']+/gi, '[redacted link]')
    .replace(/\b(?:authorization|cookie|set-cookie)\s*:[^\r\n]*/gi, '[redacted]')
    .replace(SECRET_VALUE, '$1[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]');
  text = sanitizeLogTextForUpload(text)
    .replace(/<(?:abs|cloud|file-url)-path:[a-f0-9]+>/g, '[redacted path]')
    .replace(/\b[a-f0-9]{24,}\b/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_+\/-]{40,}={0,2}/g, '[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim();
  // A CLI can emit minutes of progress before its error. Keep the end, after redaction.
  return text.length > MAX_DETAIL ? `…${text.slice(-(MAX_DETAIL - 1))}` : text;
}

function readObject(text: string, start: number): { value: Record<string, unknown>; end: number } | null {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 }; }
      catch { return null; }
    }
  }
  return null;
}

export function localCliAuthDiagnostic(output: string): {
  detail: string; category?: string; provider_exit_code?: number;
} {
  const text = stripVTControlCharacters(String(output || '').slice(-MAX_OUTPUT));
  const fallback = () => ({ detail: sanitizeAuthorizationDetail(text) });
  // CLIs may mix progress with pretty-printed JSON. Consider only line-start objects;
  // quoted braces and nested error-looking user data are not separate error envelopes.
  const starts = [...text.matchAll(/(?:^|\n)[ \t]*(?=\{)/g)];
  if (starts.length > 32) return fallback();
  let last: Record<string, unknown> | null = null;
  let end = 0;
  for (const match of starts) {
    const start = match.index! + match[0].length;
    if (start < end) continue;
    const obj = readObject(text, start);
    if (obj) { last = obj.value; end = obj.end; }
  }
  const error = last?.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return fallback();
  const body = error as Record<string, unknown>;
  // JSON only improves readability; it is never a prerequisite for disclosure. Preserve
  // subsequent output too: an earlier JSON message must not hide a later plain-text failure.
  const message = typeof body.message === 'string' && body.message.trim()
    ? `${body.message}\n${text.slice(end)}` : text;
  return {
    detail: sanitizeAuthorizationDetail(message),
    ...(['auth', 'api', 'validation', 'discovery', 'internal'].includes(String(body.category))
      ? { category: String(body.category) } : {}),
    ...(Number.isInteger(body.code) && Number(body.code) >= 0 && Number(body.code) <= 255
      ? { provider_exit_code: Number(body.code) } : {}),
  };
}
