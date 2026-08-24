import * as fs from 'node:fs';

function _strictEncodePathSegment(segment: string): string {
  // encodeURIComponent deliberately leaves !'()* unescaped. They are legal in
  // a URL but collide with Markdown link delimiters, so generated media URLs
  // use the stricter RFC 3986 form.
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) => (
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

/** Build the durable per-conversation media route used for attachment-backed
 * assistant output. Unlike `chatMediaLocalUrl`, this URL survives project
 * relocation and cloud restore because the protocol resolves the active
 * conversation's attachment pool instead of an absolute machine path. */
export function chatMediaCidUrl(cid: string, name: string): string {
  return `chat-media://cid/${_strictEncodePathSegment(String(cid || ''))}/${_strictEncodePathSegment(String(name || ''))}`;
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
// Match the same simple Markdown destination family rendered by
// renderer/modules/utils.js. Local aliases are normalized only inside a media
// link/image destination: an absolute path mentioned as prose or code is not a
// request to rewrite the assistant's text.
const MARKDOWN_LOCAL_MEDIA_DESTINATION = /((?:!\[[^\]\r\n]*\]|\[[^\]\r\n]+\])\()([^\s)]+)((?:\s+"[^"\r\n]*")?\))/g;
const MARKDOWN_CODE_REGION = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\r\n]*`)/g;
const RENDERABLE_LOCAL_MEDIA_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
  '.mp4', '.webm', '.mov', '.m4v', '.ogv',
  '.mp3', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.flac',
  '.html', '.htm',
]);

function _localMediaAliasPath(raw: string, platform = process.platform): string {
  const candidate = String(raw || '').trim();
  if (!candidate || /^chat-media:/i.test(candidate)) return '';

  if (/^file:/i.test(candidate)) {
    let parsed: URL;
    try { parsed = new URL(candidate); }
    catch { return ''; }
    let decoded = '';
    try { decoded = decodeURIComponent(parsed.pathname || ''); }
    catch { return ''; }
    if (platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(decoded)) return decoded.slice(1);
    return decoded;
  }

  const bare = candidate.replace(/^sandbox:/i, '');
  if (bare.startsWith('/') || /^[A-Za-z]:[\\/]/.test(bare)) return bare;
  return '';
}

function _isRenderableLocalMediaPath(absPath: string): boolean {
  const normalized = String(absPath || '').replace(/\\/g, '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  if (dot < 0) return false;
  return RENDERABLE_LOCAL_MEDIA_EXTS.has(basename.slice(dot).toLowerCase());
}

function _normalizeLocalMediaAliasesInMarkdown(text: string): string {
  const normalizeSegment = (segment: string): string => segment.replace(
    MARKDOWN_LOCAL_MEDIA_DESTINATION,
    (full, prefix: string, destination: string, suffix: string) => {
      const absPath = _localMediaAliasPath(destination);
      if (!absPath || !_isRenderableLocalMediaPath(absPath)) return full;
      // Use the canonical route even when the file is currently missing. An
      // existing file gains its byte-derived version below; a missing target
      // remains a stable canonical URL for normal renderer error handling.
      return `${prefix}${chatMediaLocalUrl(absPath)}${suffix}`;
    },
  );

  const source = String(text || '');
  let normalized = '';
  let cursor = 0;
  for (const match of source.matchAll(MARKDOWN_CODE_REGION)) {
    const index = match.index ?? cursor;
    normalized += normalizeSegment(source.slice(cursor, index));
    normalized += match[0];
    cursor = index + match[0].length;
  }
  return normalized + normalizeSegment(source.slice(cursor));
}

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
  const normalized = _normalizeLocalMediaAliasesInMarkdown(text);
  return normalized.replace(CHAT_MEDIA_LOCAL_URL_IN_TEXT, (raw) => {
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
