import * as fs from 'node:fs';

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
        : encodeURIComponent(segment)
    ))
    .join('/');
  return `chat-media://local/${encoded}`;
}

/**
 * Use for generated media that may overwrite an existing path. Chromium only
 * revalidates a stable chat-media URL when an element actually requests it;
 * changing the query token makes a newly rendered message issue that request.
 */
export function versionedChatMediaLocalUrl(absPath: string): string {
  const base = chatMediaLocalUrl(absPath);
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return base;
    return `${base}?v=${Math.floor(st.mtimeMs)}-${st.size}`;
  } catch {
    return base;
  }
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
