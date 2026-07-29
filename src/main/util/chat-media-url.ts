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

const CHAT_MEDIA_LOCAL_URL_IN_TEXT = /chat-media:\/\/local\/[^\s<>"'`]+/gi;
const CHAT_MEDIA_TRAILING_DELIMITER = /[)\]},.;:!]+$/;

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
