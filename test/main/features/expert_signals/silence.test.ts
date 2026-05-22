import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Pre-set ORKAS_WORKSPACE_ROOT before importing anything that loads paths.ts.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-silence-'));
process.env.ORKAS_WORKSPACE_ROOT = TMP;
fs.writeFileSync(path.join(TMP, 'users.json'),
  JSON.stringify({ current_user_id: '12345678', users: [{ user_id: '12345678', created_at: new Date().toISOString() }] }));

import { activateUser } from '../../../../src/main/features/users';
activateUser('12345678');

import {
  scheduleSilenceCheck,
  cancelSilenceCheck,
  _clearAllPending,
} from '../../../../src/main/features/expert_signals/extractors/silence';
import { querySignals } from '../../../../src/main/features/expert_signals';

describe('expert_signals.silence', () => {
  beforeEach(() => {
    _clearAllPending();
  });
  afterEach(() => {
    _clearAllPending();
  });

  it('positive: timer fires after threshold → silence appears', async () => {
    scheduleSilenceCheck({
      uid: '12345678', cid: 'cid-silence-1', aid: 'agent-x',
      turn_id: 'msg-1', msg_ids: ['msg-1'],
      thresholdMs: 30,
    });
    await new Promise((r) => setTimeout(r, 80));
    // Read what got emitted today
    const sigs = await querySignals({ types: ['silence'], cid: 'cid-silence-1' });
    expect(sigs.length).toBeGreaterThan(0);
    expect(sigs[0].turn_id).toBe('msg-1');
  });

  it('negative: cancel before timer fires → no silence', async () => {
    scheduleSilenceCheck({
      uid: '12345678', cid: 'cid-silence-2', aid: 'agent-x',
      turn_id: 'msg-2', msg_ids: ['msg-2'],
      thresholdMs: 100,
    });
    cancelSilenceCheck('12345678', 'cid-silence-2');
    await new Promise((r) => setTimeout(r, 150));
    const sigs = await querySignals({ types: ['silence'], cid: 'cid-silence-2' });
    expect(sigs.length).toBe(0);
  });

  it('rescheduling cancels the previous timer', async () => {
    scheduleSilenceCheck({
      uid: '12345678', cid: 'cid-silence-3', aid: 'agent-x',
      turn_id: 'msg-3a', msg_ids: ['msg-3a'],
      thresholdMs: 50,
    });
    // Schedule a fresh one before the first fires
    scheduleSilenceCheck({
      uid: '12345678', cid: 'cid-silence-3', aid: 'agent-x',
      turn_id: 'msg-3b', msg_ids: ['msg-3b'],
      thresholdMs: 200,
    });
    await new Promise((r) => setTimeout(r, 120));
    const sigs = await querySignals({ types: ['silence'], cid: 'cid-silence-3' });
    // Neither has fired yet (first cancelled, second still pending)
    expect(sigs.length).toBe(0);
  });
});
