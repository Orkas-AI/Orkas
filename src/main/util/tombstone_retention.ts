export const TOMBSTONE_RETENTION_DAYS = 30;
export const TOMBSTONE_RETENTION_MS = TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

interface RetentionOptions {
  nowMs?: number;
  retentionMs?: number;
}

function _isExpired(deletedAtMs: number, opts?: RetentionOptions): boolean {
  if (!Number.isFinite(deletedAtMs) || deletedAtMs <= 0) return false;
  const nowMs = opts?.nowMs ?? Date.now();
  const retentionMs = opts?.retentionMs ?? TOMBSTONE_RETENTION_MS;
  if (!Number.isFinite(nowMs) || !Number.isFinite(retentionMs) || retentionMs <= 0) return false;
  return nowMs - deletedAtMs >= retentionMs;
}

function _strictIsoTimestampMs(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return Number.NaN;
  const fractionMs = Number((match[7] || '').padEnd(3, '0'));
  const expected = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    fractionMs,
  );
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed !== expected) return Number.NaN;
  const date = new Date(parsed);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5])
    && date.getUTCSeconds() === Number(match[6])
    && date.getUTCMilliseconds() === fractionMs
    ? parsed
    : Number.NaN;
}

export function isExpiredIsoTombstone(deletedAt: unknown, opts?: RetentionOptions): boolean {
  if (typeof deletedAt !== 'string' || !deletedAt) return false;
  const ms = _strictIsoTimestampMs(deletedAt);
  return _isExpired(ms, opts);
}

export function isExpiredMsTombstone(deletedAtMs: unknown, opts?: RetentionOptions): boolean {
  return _isExpired(Number(deletedAtMs), opts);
}

export function pruneExpiredDeletedRecords<T extends Record<string, any>>(
  records: T[],
  opts?: RetentionOptions,
): T[] {
  return records.filter((record) => !isExpiredIsoTombstone(record?.deleted_at, opts));
}

export function pruneExpiredManifestTombstones<T extends Record<string, any>>(
  tombstones: T,
  opts?: RetentionOptions,
): T {
  return Object.fromEntries(
    Object.entries(tombstones || {}).filter(([, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const deletedAtMs = value.deleted_at_ms;
      const revision = value._v;
      if (
        typeof deletedAtMs !== 'number'
        || !Number.isFinite(deletedAtMs)
        || deletedAtMs <= 0
        || typeof revision !== 'number'
        || !Number.isSafeInteger(revision)
        || revision <= 0
      ) {
        return false;
      }
      return !isExpiredMsTombstone(deletedAtMs, opts);
    }),
  ) as T;
}
