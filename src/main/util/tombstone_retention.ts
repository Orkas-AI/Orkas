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
  return nowMs - deletedAtMs >= retentionMs;
}

export function isExpiredIsoTombstone(deletedAt: unknown, opts?: RetentionOptions): boolean {
  if (typeof deletedAt !== 'string' || !deletedAt) return false;
  const ms = Date.parse(deletedAt);
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
    Object.entries(tombstones || {}).filter(([, value]) => !isExpiredMsTombstone(value?.deleted_at_ms, opts)),
  ) as T;
}
