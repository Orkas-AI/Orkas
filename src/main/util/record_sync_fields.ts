export const RECORD_SYNC_REV_FIELD = '_sync_rev';
export const RECORD_SYNC_DEVICE_FIELD = '_sync_device_id';

export type SyncStampedRecord = Record<string, any>;

export function recordSyncRev(record: SyncStampedRecord | null | undefined): number {
  const n = Number(record?.[RECORD_SYNC_REV_FIELD]) || 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function recordSyncDevice(record: SyncStampedRecord | null | undefined): string {
  const value = record?.[RECORD_SYNC_DEVICE_FIELD];
  return typeof value === 'string' ? value : '';
}

export function bumpRecordSyncVersion<T extends SyncStampedRecord>(record: T, deviceId: string): T {
  const writable = record as SyncStampedRecord;
  writable[RECORD_SYNC_REV_FIELD] = recordSyncRev(record) + 1;
  if (deviceId) writable[RECORD_SYNC_DEVICE_FIELD] = deviceId;
  return record;
}

export function withoutRecordSyncFields<T extends SyncStampedRecord>(record: T): SyncStampedRecord {
  const out: SyncStampedRecord = { ...record };
  delete out[RECORD_SYNC_REV_FIELD];
  delete out[RECORD_SYNC_DEVICE_FIELD];
  return out;
}
