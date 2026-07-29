export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

const MAX_SCOPE_CHARS = 80;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_COLLECTION_ITEMS = 32;
const MAX_VALUE_DEPTH = 4;
const REDACTED = '[REDACTED]';

function boundText(value: unknown, maxChars: number): string {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\bAKID[A-Za-z0-9]{8,}\b/g, REDACTED)
    .replace(
      /\b(token|api[_-]?key|secret(?:[_-]?key)?|password|authorization|session[_-]?(?:id|token)|access[_-]?key(?:[_-]?id)?)\s*([:=])\s*([^\s,;}\]]+)/gi,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
    )
    .replace(
      /(^|[\s("'=])\/(?:Users|home|private|var|tmp|Volumes|opt|etc)\/[^\s"'<>)]*/g,
      (_match, prefix: string) => `${prefix}<local-path>`,
    )
    .replace(/[A-Za-z]:\\(?:[^\\\s"'<>]+\\)*[^\\\s"'<>]*/g, '<local-path>')
    .trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated]`;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return [
    'token',
    'accesstoken',
    'refreshtoken',
    'apikey',
    'secret',
    'secretkey',
    'password',
    'authorization',
    'session',
    'sessionid',
    'sessiontoken',
    'credentials',
    'content',
    'body',
    'requestbody',
    'responsebody',
  ].includes(normalized);
}

function sanitizeValue(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0,
): unknown {
  if (typeof value === 'string') return boundText(value, MAX_MESSAGE_CHARS);
  if (
    value == null
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
  ) return value;
  if (typeof value === 'symbol' || typeof value === 'function') {
    return boundText(String(value), MAX_MESSAGE_CHARS);
  }
  if (value instanceof Error) {
    return {
      name: boundText(value.name, 120),
      message: boundText(value.message, MAX_MESSAGE_CHARS),
    };
  }
  if (depth >= MAX_VALUE_DEPTH) return '[MaxDepth]';
  if (typeof value !== 'object') return boundText(value, MAX_MESSAGE_CHARS);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => sanitizeValue(item, seen, depth + 1));
    if (value.length > MAX_COLLECTION_ITEMS) result.push(`[${value.length - MAX_COLLECTION_ITEMS} more]`);
    return result;
  }

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, MAX_COLLECTION_ITEMS);
  for (const [rawKey, item] of entries) {
    const key = boundText(rawKey, 120) || 'field';
    result[key] = isSensitiveKey(rawKey)
      ? REDACTED
      : sanitizeValue(item, seen, depth + 1);
  }
  const extra = Object.keys(value).length - entries.length;
  if (extra > 0) result.__truncated_fields__ = extra;
  return result;
}

export function createLogger(moduleName: string): Logger {
  const scope = boundText(moduleName || 'video-script', MAX_SCOPE_CHARS) || 'video-script';
  const write = (level: 'error' | 'warn' | 'info' | 'debug', message: string, args: unknown[]) => {
    if (process.env.ORKAS_VIDEO_SCRIPT_DEBUG !== '1') return;
    const line = `[${scope}] ${boundText(message, MAX_MESSAGE_CHARS)}`;
    const safeArgs = args.map((arg) => sanitizeValue(arg, new WeakSet()));
    if (level === 'error') console.error(line, ...safeArgs);
    else if (level === 'warn') console.warn(line, ...safeArgs);
    else if (level === 'debug') console.debug(line, ...safeArgs);
    else console.info(line, ...safeArgs);
  };
  return {
    error: (message, ...args) => write('error', message, args),
    warn: (message, ...args) => write('warn', message, args),
    info: (message, ...args) => write('info', message, args),
    debug: (message, ...args) => write('debug', message, args),
  };
}
