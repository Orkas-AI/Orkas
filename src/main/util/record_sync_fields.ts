export const RECORD_SYNC_REV_FIELD = '_sync_rev';
export const RECORD_SYNC_DEVICE_FIELD = '_sync_device_id';

export type SyncStampedRecord = Record<string, any>;

export function recordSyncRev(record: SyncStampedRecord | null | undefined): number {
  const raw = record?.[RECORD_SYNC_REV_FIELD];
  if (typeof raw !== 'number' && typeof raw !== 'string') return 0;
  if (typeof raw === 'string' && !raw.trim()) return 0;
  const n = Number(raw);
  const revision = Math.floor(n);
  return Number.isFinite(n)
    && revision > 0
    && revision < Number.MAX_SAFE_INTEGER
    ? revision
    : 0;
}

export function recordSyncDevice(record: SyncStampedRecord | null | undefined): string {
  const value = record?.[RECORD_SYNC_DEVICE_FIELD];
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : '';
}

export function bumpRecordSyncVersion<T extends SyncStampedRecord>(record: T, deviceId: string): T {
  const writable = record as SyncStampedRecord;
  writable[RECORD_SYNC_REV_FIELD] = recordSyncRev(record) + 1;
  const safeDeviceId = recordSyncDevice({ [RECORD_SYNC_DEVICE_FIELD]: deviceId });
  if (safeDeviceId) writable[RECORD_SYNC_DEVICE_FIELD] = safeDeviceId;
  return record;
}

export function withoutRecordSyncFields<T extends SyncStampedRecord>(record: T): SyncStampedRecord {
  const out: SyncStampedRecord = { ...record };
  delete out[RECORD_SYNC_REV_FIELD];
  delete out[RECORD_SYNC_DEVICE_FIELD];
  return out;
}
