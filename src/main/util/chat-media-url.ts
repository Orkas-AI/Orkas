import * as fs from 'node:fs';

function _strictEncodePathSegment(segment: string): string {
  // encodeURIComponent deliberately leaves !'()* unescaped. They are legal in
  // a URL but collide with Markdown link delimiters, so generated media URLs
  // use the stricter RFC 3986 form.
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) => (
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

/**
 * Build a durable `chat-media://local/` URL for an absolute filesystem path.
 *
 * Encode path segments independently: `encodeURI` leaves `#` and `?` intact,
 * which makes Chromium interpret the rest of a perfectly valid filename as a
 * fragment/query and sends a truncated path to the protocol handler.
 */
export function chatMediaLocalUrl(absPath: string): string {
  let normalized = String(absPath || '').replace(/\\/g, '/');
  if (normalized.startsWith('/')) normalized = normalized.slice(1);
  const encoded = normalized
    .split('/')
    .map((segment, index) => (
      index === 0 && /^[A-Za-z]:$/.test(segment)
        ? segment
        : _strictEncodePathSegment(segment)
    ))
    .join('/');
  return `chat-media://local/${encoded}`;
}

function _chatMediaLocalVersionToken(absPath: string): string {
  try {
    const st = fs.statSync(absPath, { bigint: true });
    if (!st.isFile()) return '';
    // ctime catches same-path rewrites that deliberately preserve mtime;
    // nanosecond timestamps avoid the millisecond collision window.
    return `${st.mtimeNs}-${st.ctimeNs}-${st.size}`;
  } catch {
    return '';
  }
}

/**
 * Use for generated media that may overwrite an existing path. Chromium only
 * revalidates a stable chat-media URL when an element actually requests it;
 * changing the query token makes a newly rendered message issue that request.
 */
export function versionedChatMediaLocalUrl(absPath: string): string {
  const base = chatMediaLocalUrl(absPath);
  const token = _chatMediaLocalVersionToken(absPath);
  return token ? `${base}?v=${token}` : base;
}

/** Decode only the local route. The caller still owns filesystem validation. */
export function chatMediaLocalPathFromUrl(raw: string, platform = process.platform): string {
  let url: URL;
  try { url = new URL(String(raw || '')); }
  catch { return ''; }
  if (url.protocol !== 'chat-media:' || url.hostname.toLowerCase() !== 'local') return '';
  let decoded = '';
  try { decoded = decodeURIComponent(url.pathname || ''); }
  catch { return ''; }
  if (platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(decoded)) return decoded.slice(1);
  return decoded;
}

// Generated local URLs percent-encode filename punctuation, so raw CJK
// sentence delimiters are always prose boundaries rather than path bytes.
const CHAT_MEDIA_LOCAL_URL_IN_TEXT = /chat-media:\/\/local\/[^\s<>"'`\u3001\u3002\uFF0C\uFF01\uFF1A\uFF1B\uFF1F\uFF09\u3011\u3009\u300D\u300F]+/gi;
const CHAT_MEDIA_TRAILING_DELIMITER = /[)\]},.;:!\u3001\u3002\uFF0C\uFF01\uFF1A\uFF1B\uFF1F\uFF09\u3011\u3009\u300D\u300F]+$/;

function _versionLocalUrlCandidate(candidate: string): string {
  const absPath = chatMediaLocalPathFromUrl(candidate);
  if (!absPath) return '';
  const token = _chatMediaLocalVersionToken(absPath);
  if (!token) return '';
  try {
    const parsed = new URL(candidate);
    parsed.searchParams.set('v', token);
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Refresh every local media URL embedded in assistant-authored Markdown/HTML.
 *
 * Tool results already return versioned URLs, but model prose can retype the
 * same path and drop (or retain an older) `?v=` query. Running this at the
 * message persistence boundary makes the stored and live-rendered text point
 * at the bytes that exist when the reply is committed.
 */
export function versionChatMediaLocalUrlsInText(text: string): string {
  return String(text || '').replace(CHAT_MEDIA_LOCAL_URL_IN_TEXT, (raw) => {
    let candidate = raw;
    let suffix = '';

    // Anything after a query/fragment is not a filesystem-path character, so
    // trailing Markdown/sentence delimiters can be peeled immediately.
    if (/[?#]/.test(candidate)) {
      const trailing = candidate.match(CHAT_MEDIA_TRAILING_DELIMITER)?.[0] || '';
      if (trailing) {
        candidate = candidate.slice(0, -trailing.length);
        suffix = trailing;
      }
    }

    let versioned = _versionLocalUrlCandidate(candidate);
    // For an unversioned Markdown URL, first try the exact filename so real
    // local names ending in punctuation remain valid. Peel delimiters only
    // when the exact path does not exist.
    while (!versioned) {
      const trailing = candidate.match(CHAT_MEDIA_TRAILING_DELIMITER)?.[0] || '';
      if (!trailing) break;
      const last = trailing.slice(-1);
      candidate = candidate.slice(0, -1);
      suffix = last + suffix;
      versioned = _versionLocalUrlCandidate(candidate);
    }
    return versioned ? versioned + suffix : raw;
  });
}

/** Split one matched URL into the longest candidate whose target file exists,
 *  plus the Markdown/sentence punctuation peeled off its end.
 *
 *  A local path may legitimately end in `)` or `.`, so the exact filename is
 *  tried first and delimiters are peeled only while nothing resolves. Shared so
 *  the versioner and the existence check agree on where the URL ends — a
 *  checker with its own peeling would report links the versioner had already
 *  resolved. */
function _splitResolvableCandidate(raw: string): { candidate: string; suffix: string; absPath: string } {
  let candidate = raw;
  let suffix = '';
  if (/[?#]/.test(candidate)) {
    const trailing = candidate.match(CHAT_MEDIA_TRAILING_DELIMITER)?.[0] || '';
    if (trailing) {
      candidate = candidate.slice(0, -trailing.length);
      suffix = trailing;
    }
  }
  for (;;) {
    const absPath = chatMediaLocalPathFromUrl(candidate);
    if (absPath && _chatMediaLocalVersionToken(absPath)) return { candidate, suffix, absPath };
    const trailing = candidate.match(CHAT_MEDIA_TRAILING_DELIMITER)?.[0] || '';
    if (!trailing) return { candidate, suffix, absPath: absPath || '' };
    const last = trailing.slice(-1);
    candidate = candidate.slice(0, -1);
    suffix = last + suffix;
  }
}

/**
 * Local media URLs in assistant prose whose target file does not exist.
 *
 * The versioner above already walks every one of these and already discovers
 * which cannot be versioned, because a missing file yields no version token —
 * and then drops that knowledge on the floor. This returns it.
 *
 * 2026-08-07: an agent closed a run with `<agent-result status="success" />`, a
 * "成片确认", and a `[video](chat-media://local/…/orkas-promo-v1.mp4)` link. That
 * turn made no tool calls at all, the file never existed, and the renderer
 * logged `chat-media/local: reject … not_found` about 300ms later. Every fact
 * needed to catch it was already in the host's hands.
 */
export function unresolvedChatMediaLocalUrls(text: string): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(text || '').match(CHAT_MEDIA_LOCAL_URL_IN_TEXT) || []) {
    const { candidate, absPath } = _splitResolvableCandidate(raw);
    if (absPath && _chatMediaLocalVersionToken(absPath)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    missing.push(candidate);
  }
  return missing;
}
