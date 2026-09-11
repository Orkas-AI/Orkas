import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const loggerMocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerMocks.warn,
    error: vi.fn(),
  }),
}));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-storage-'));
process.env.ORKAS_WORKSPACE_ROOT = TMP;
// Seed users.json so activateUser doesn't have to invent one
fs.writeFileSync(path.join(TMP, 'users.json'),
  JSON.stringify({ current_user_id: '99999999', users: [{ user_id: '99999999', created_at: new Date().toISOString() }] }));

import { activateUser } from '../../../../src/main/features/users';
activateUser('99999999');

import {
  emitSignal,
  querySignals,
  querySignalsForUser,
} from '../../../../src/main/features/expert_signals';
import type { SignalInput } from '../../../../src/main/features/expert_signals/types';

function makeInput(type: SignalInput['type'], over: Partial<SignalInput> = {}): SignalInput {
  return {
    type, source: 'event',
    cid: 'storage-test-cid', aid: 'a1', turn_id: 't1',
    context_ref: { msg_ids: ['m1'] },
    extractor_version: 'test@1.0',
    ...over,
  };
}

describe('expert_signals.storage', () => {
  beforeAll(async () => {
    // give the first appendSignal time to land before the suite queries
    emitSignal('99999999', makeInput('accept'));
    await new Promise((r) => setTimeout(r, 50));
  });

  it('emit + query roundtrip', async () => {
    emitSignal('99999999', makeInput('correction'));
    await new Promise((r) => setTimeout(r, 50));
    const sigs = await querySignals({ types: ['correction'] });
    expect(sigs.length).toBeGreaterThan(0);
    expect(sigs[0].type).toBe('correction');
    expect(sigs[0].id).toMatch(/^sig_/);
    expect(sigs[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('filter by cid', async () => {
    emitSignal('99999999', makeInput('retry', { cid: 'cid-A' }));
    emitSignal('99999999', makeInput('retry', { cid: 'cid-B' }));
    await new Promise((r) => setTimeout(r, 50));
    const sigsA = await querySignals({ types: ['retry'], cid: 'cid-A' });
    const sigsB = await querySignals({ types: ['retry'], cid: 'cid-B' });
    expect(sigsA.every((s) => s.cid === 'cid-A')).toBe(true);
    expect(sigsB.every((s) => s.cid === 'cid-B')).toBe(true);
  });

  it('filter by turn_id groups same-turn signals', async () => {
    emitSignal('99999999', makeInput('correction', { turn_id: 'group-1' }));
    emitSignal('99999999', makeInput('reject', { turn_id: 'group-1' }));
    emitSignal('99999999', makeInput('accept', { turn_id: 'group-2' }));
    await new Promise((r) => setTimeout(r, 50));
    const group1 = await querySignals({ turn_id: 'group-1' });
    expect(group1.length).toBe(2);
    const types = group1.map((s) => s.type).sort();
    expect(types).toEqual(['correction', 'reject']);
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) emitSignal('99999999', makeInput('skip'));
    await new Promise((r) => setTimeout(r, 50));
    const sigs = await querySignals({ types: ['skip'], limit: 2 });
    expect(sigs.length).toBe(2);
  });

  it('does not redirect an explicit background query when the active account changes', async () => {
    const firstUid = '11111111';
    const secondUid = '22222222';
    emitSignal(firstUid, makeInput('correction', { cid: 'account-one-only' }));
    emitSignal(secondUid, makeInput('correction', { cid: 'account-two-only' }));
    await new Promise((r) => setTimeout(r, 50));

    activateUser(secondUid);
    try {
      const first = await querySignalsForUser(firstUid, { types: ['correction'] });
      const activeSecond = await querySignals({ types: ['correction'] });
      expect(first.map((signal) => signal.cid)).toContain('account-one-only');
      expect(first.map((signal) => signal.cid)).not.toContain('account-two-only');
      expect(activeSecond.map((signal) => signal.cid)).toContain('account-two-only');
      expect(activeSecond.map((signal) => signal.cid)).not.toContain('account-one-only');
    } finally {
      activateUser('99999999');
    }
  });
});

describe('pruneSignalFiles', () => {
  it('removes daily files older than the retention window and keeps the rest', async () => {
    // Signal files accumulated one per active day forever; every consumer
    // reads a ≤48h window (2026-08-28 review E1-8).
    const { pruneSignalFiles } = await import('../../../../src/main/features/expert_signals/storage');
    const { userSignalsDir } = await import('../../../../src/main/paths');
    const retentionUid = 'retention-test';
    const dir = userSignalsDir(retentionUid);
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.UTC(2026, 7, 28);
    fs.writeFileSync(path.join(dir, '2026-06-01.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, '2026-08-20.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, '2026-08-28.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
    expect(pruneSignalFiles(retentionUid, 30, now)).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-08-20.jsonl', '2026-08-28.jsonl', 'notes.txt']);
  });

  it('keeps account ids and local paths out of storage failure logs', async () => {
    const storage = await import('../../../../src/main/features/expert_signals/storage');
    const paths = await import('../../../../src/main/paths');
    loggerMocks.warn.mockReset();

    const appendUid = 'append-private-user-12345';
    const appendDir = paths.userSignalsDir(appendUid);
    fs.mkdirSync(path.dirname(appendDir), { recursive: true });
    fs.writeFileSync(appendDir, 'blocks directory creation');
    storage.appendSignal(appendUid, makeInput('accept'));
    for (let attempt = 0; attempt < 20 && loggerMocks.warn.mock.calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const queryUid = 'query-private-user-12345';
    fs.mkdirSync(paths.signalsDailyFile(queryUid), { recursive: true });
    await storage.querySignalsForUser(queryUid);

    const pruneUid = 'prune-private-user-12345';
    const pruneDir = paths.userSignalsDir(pruneUid);
    fs.mkdirSync(path.join(pruneDir, '2026-01-01.jsonl'), { recursive: true });
    storage.pruneSignalFiles(pruneUid, 30, Date.UTC(2026, 7, 28));

    expect(loggerMocks.warn.mock.calls.map(([message]) => message)).toEqual([
      'append signal failed',
      'query signals read failed',
      'prune signal file failed',
    ]);
    const serialized = JSON.stringify(loggerMocks.warn.mock.calls);
    expect(serialized).not.toContain(appendUid);
    expect(serialized).not.toContain(queryUid);
    expect(serialized).not.toContain(pruneUid);
    expect(serialized).not.toContain(TMP);
  });
});
