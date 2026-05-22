import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-storage-'));
process.env.ORKAS_WORKSPACE_ROOT = TMP;
// Seed users.json so activateUser doesn't have to invent one
fs.writeFileSync(path.join(TMP, 'users.json'),
  JSON.stringify({ current_user_id: '99999999', users: [{ user_id: '99999999', created_at: new Date().toISOString() }] }));

import { activateUser } from '../../../../src/main/features/users';
activateUser('99999999');

import { emitSignal, querySignals } from '../../../../src/main/features/expert_signals';
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
});
