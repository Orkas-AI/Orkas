/** History-only media projection. Original records and active input stay intact.
 * The synchronous host/ESM copies are parity-tested like token estimation. */
const MEDIA_MIME = /^(?:image|video)\/[a-z0-9.+-]+$/i;

function omitDataUrls(text: string): string {
  // Parse explicit data-URI syntax, never guess whether ordinary text is Base64.
  return text.replace(/\bdata:((?:image|video)\/[a-z0-9.+-]+)(?:;[a-z0-9.+-]+=[a-z0-9.+-]+)*;base64,[a-z0-9+/_=-]+/gi,
    (_match, mime: string) => `[inline ${mime.toLowerCase()} data omitted from history]`);
}

function mediaReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'string') return projectHistoryMediaText(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  const mime = item.mimeType ?? item.mediaType ?? item.mime_type ?? item.media_type;
  if (typeof item.data === 'string' && typeof mime === 'string' && MEDIA_MIME.test(mime)) {
    const marker = `[inline ${mime.toLowerCase()} data omitted from history]`;
    return item.data === marker ? value : { ...item, data: marker };
  }
  return value;
}

export function stringifyHistoryMedia(value: unknown): string {
  return JSON.stringify(value, mediaReplacer);
}

/** Preserve ordinary text/JSON formatting when there is no media to omit. */
export function projectHistoryMediaText(text: string): string {
  if (!/image\/|video\//i.test(text)) return text;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const value: unknown = JSON.parse(text);
      let changed = false;
      const projected = JSON.stringify(value, (key, item: unknown) => {
        const next = mediaReplacer(key, item);
        if (next !== item) changed = true;
        return next;
      });
      if (changed) return projected;
    } catch { /* Non-JSON text retains its original formatting. */ }
  }
  return omitDataUrls(text);
}
