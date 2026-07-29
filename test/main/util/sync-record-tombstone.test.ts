import { describe, expect, it } from 'vitest';

import {
  bumpRecordSyncVersion,
  recordSyncDevice,
  recordSyncRev,
  withoutRecordSyncFields,
} from '../../../src/main/util/record_sync_fields';
import {
  isExpiredIsoTombstone,
  isExpiredMsTombstone,
  pruneExpiredDeletedRecords,
  pruneExpiredManifestTombstones,
  TOMBSTONE_RETENTION_MS,
} from '../../../src/main/util/tombstone_retention';

const NOW = Date.parse('2026-07-25T00:00:00.000Z');

describe('record-level sync stamps', () => {
  it('accepts compatible positive revisions but rejects coercion and unsafe counters', () => {
    expect(recordSyncRev({ _sync_rev: 4.9 })).toBe(4);
    expect(recordSyncRev({ _sync_rev: '7' })).toBe(7);
    for (const value of [
      0,
      -1,
      '',
      'not-a-revision',
      true,
      [9],
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(recordSyncRev({ _sync_rev: value })).toBe(0);
    }
  });

  it('accepts bounded UUID/MAC/test ids and rejects whitespace or control data', () => {
    expect(recordSyncDevice({ _sync_device_id: '36d6d5be-2de8-4ba0-95b0-e5374aa8010a' }))
      .toBe('36d6d5be-2de8-4ba0-95b0-e5374aa8010a');
    expect(recordSyncDevice({ _sync_device_id: 'aa:bb:cc:dd:ee:ff' }))
      .toBe('aa:bb:cc:dd:ee:ff');
    expect(recordSyncDevice({ _sync_device_id: ' device-a ' })).toBe('');
    expect(recordSyncDevice({ _sync_device_id: `device-a\nsecret` })).toBe('');
    expect(recordSyncDevice({ _sync_device_id: 'x'.repeat(129) })).toBe('');
  });

  it('bumps in place with a validated device and strips stamps without mutating input', () => {
    const record = { id: 'conversation-a', title: 'Keep', _sync_rev: '2' };
    expect(bumpRecordSyncVersion(record, 'device-a')).toBe(record);
    expect(record).toMatchObject({
      _sync_rev: 3,
      _sync_device_id: 'device-a',
    });

    const clean = withoutRecordSyncFields(record);
    expect(clean).toEqual({ id: 'conversation-a', title: 'Keep' });
    expect(record._sync_rev).toBe(3);

    bumpRecordSyncVersion(record, 'invalid device id');
    expect(record._sync_rev).toBe(4);
    expect(record._sync_device_id).toBe('device-a');
  });
});

describe('shared tombstone retention', () => {
  it('expires at the 30-day boundary but preserves a tombstone just inside it', () => {
    expect(isExpiredMsTombstone(NOW - TOMBSTONE_RETENTION_MS, { nowMs: NOW })).toBe(true);
    expect(isExpiredMsTombstone(NOW - TOMBSTONE_RETENTION_MS + 1, { nowMs: NOW })).toBe(false);
    expect(isExpiredIsoTombstone(
      new Date(NOW - TOMBSTONE_RETENTION_MS).toISOString(),
      { nowMs: NOW },
    )).toBe(true);
  });

  it('fails safe for future, malformed, calendar-invalid, and invalid-option timestamps', () => {
    expect(isExpiredMsTombstone(NOW + 1, { nowMs: NOW })).toBe(false);
    expect(isExpiredMsTombstone(Number.NaN, { nowMs: NOW })).toBe(false);
    expect(isExpiredIsoTombstone('2026-02-30T00:00:00Z', { nowMs: NOW })).toBe(false);
    expect(isExpiredIsoTombstone('2026-04-01', { nowMs: NOW })).toBe(false);
    expect(isExpiredMsTombstone(NOW - TOMBSTONE_RETENTION_MS, {
      nowMs: Number.POSITIVE_INFINITY,
    })).toBe(false);
    expect(isExpiredMsTombstone(NOW - TOMBSTONE_RETENTION_MS, {
      nowMs: NOW,
      retentionMs: -1,
    })).toBe(false);
  });

  it('prunes only valid expired record tombstones and preserves ordinary records', () => {
    const records = [
      { id: 'active' },
      { id: 'recent', deleted_at: new Date(NOW - 1_000).toISOString() },
      { id: 'expired', deleted_at: new Date(NOW - TOMBSTONE_RETENTION_MS).toISOString() },
      { id: 'malformed', deleted_at: '2026-02-30T00:00:00Z' },
    ];

    expect(pruneExpiredDeletedRecords(records, { nowMs: NOW }).map((row) => row.id))
      .toEqual(['active', 'recent', 'malformed']);
  });

  it('drops malformed manifest tombstones before they can delete local data', () => {
    const recent = NOW - 1_000;
    const tombstones = {
      valid: { deleted_at_ms: recent, _v: 2, etag: 'keep-extra-compatible-fields' },
      expired: { deleted_at_ms: NOW - TOMBSTONE_RETENTION_MS, _v: 3 },
      missingRevision: { deleted_at_ms: recent },
      zeroRevision: { deleted_at_ms: recent, _v: 0 },
      stringTimestamp: { deleted_at_ms: String(recent), _v: 4 },
      scalar: true,
    };

    expect(pruneExpiredManifestTombstones(tombstones, { nowMs: NOW })).toEqual({
      valid: tombstones.valid,
    });
  });
});
