import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Same setup shape as turn_buffer.test.ts — WS_ROOT swap + activateUser
// must run before any expert_signals import (storage caches active uid).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-turn-hooks-'));
process.env.ORKAS_WORKSPACE_ROOT = TMP;
fs.writeFileSync(path.join(TMP, 'users.json'),
  JSON.stringify({ current_user_id: '99999993', users: [{ user_id: '99999993', created_at: new Date().toISOString() }] }));
const UID = '99999993';

import { activateUser } from '../../../../src/main/features/users';
activateUser(UID);

import {
  onAgentTurnEnd,
  onUserMessage,
  _clearAgentMsgCache,
} from '../../../../src/main/features/expert_signals/turn_hooks';
import { querySignals } from '../../../../src/main/features/expert_signals';

async function wait() { return new Promise((r) => setTimeout(r, 30)); }

// Why this file exists: phase-0 commit 76358a8e shipped the chokepoint
// functions (onAgentTurnEnd / onUserMessage) and the bus.ts wiring, but
// the bus.ts portion silently fell out of the commit. The fall-out wasn't
// detected because all expert_signals coverage was on the pure extractors
// (text.test.ts / silence.test.ts / event.test.ts) — none exercised the
// chokepoint end-to-end. These fixtures lock the chokepoint behaviour so
// the next time someone refactors turn_hooks or moves the bus call site,
// a missing wire surfaces in the test suite, not in production weeks
// later. See `docs/plans/expert-signals-phase0-wiring-gaps.md`.

beforeEach(() => {
  _clearAgentMsgCache();
});

describe('onAgentTurnEnd › set A (live emit + cache)', () => {
  it('caches agent msg + does NOT emit signals on a clean turn (no errText)', async () => {
    const cid = 'cid-tha-a1';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_a1', text: 'Here is the plan.' },
      // No errText → no tool_failure.
    });
    await wait();

    const errSigs = await querySignals({ types: ['tool_failure'], cid });
    expect(errSigs.length).toBe(0);
    // Cache write is observable via the next onUserMessage call below.
  });

  it('errText non-empty → emits tool_failure once', async () => {
    const cid = 'cid-tha-a2';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_a2', text: 'sorry' },
      errText: 'permanent: agent spec missing',
    });
    await wait();

    const sigs = await querySignals({ types: ['tool_failure'], cid });
    expect(sigs.length).toBe(1);
    expect(sigs[0].turn_id).toBe('m_a2');
    expect(sigs[0].metadata!.error_excerpt).toContain('agent spec missing');
  });

  it('commander turn → aid is null on emitted signals', async () => {
    const cid = 'cid-tha-a3';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'commander',
      isCommander: true,
      agentMsg: { id: 'm_a3', text: 'done.' },
      errText: 'something broke',
    });
    await wait();

    const sigs = await querySignals({ types: ['tool_failure'], cid });
    expect(sigs.length).toBe(1);
    expect(sigs[0].aid).toBeNull();
  });
});

describe('onUserMessage › set A (text-signal extraction after cache)', () => {
  it('correction word → emits correction signal joined on cached turn_id', async () => {
    const cid = 'cid-thu-a1';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_thu_a1', text: '我帮你写了一段示例代码。' },
    });
    const r = await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_a1', text: '不对，应该用另一种写法' },
    });
    expect(r.correctionDetected).toBe(true);
    await wait();

    const sigs = await querySignals({ types: ['correction'], cid });
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    expect(sigs[0].turn_id).toBe('m_thu_a1');
    expect(sigs[0].aid).toBe('agent_x');
  });

  it('explicit accept word → emits accept signal', async () => {
    const cid = 'cid-thu-a2';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_thu_a2', text: 'How about this approach?' },
    });
    await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_a2', text: '好的，就这样' },
    });
    await wait();

    const sigs = await querySignals({ types: ['accept'], cid });
    expect(sigs.length).toBe(1);
    expect(sigs[0].turn_id).toBe('m_thu_a2');
  });

  it('rejection word → emits reject signal', async () => {
    const cid = 'cid-thu-a3';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_thu_a3', text: '我用 Python 实现一个排序。' },
    });
    await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_a3', text: '算了，不要这个了' },
    });
    await wait();

    const sigs = await querySignals({ types: ['reject'], cid });
    expect(sigs.length).toBe(1);
  });
});

describe('onUserMessage / onAgentTurnEnd › set B (must NOT emit)', () => {
  it('onUserMessage with no prior onAgentTurnEnd → no signals (cache miss)', async () => {
    const cid = 'cid-thu-b1';
    const r = await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_b1', text: '不对' },
    });
    expect(r.correctionDetected).toBe(false);
    await wait();

    const sigs = await querySignals({
      types: ['correction', 'accept', 'reject', 'edit'],
      cid,
    });
    expect(sigs.length).toBe(0);
  });

  it('silent agent turn (empty text) → no cache, so next user msg gets no signal', async () => {
    const cid = 'cid-thu-b2';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_thu_b2', text: '' },  // silent turn
    });
    await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_b2', text: '不对' },
    });
    await wait();

    const sigs = await querySignals({
      types: ['correction', 'accept', 'reject', 'edit'],
      cid,
    });
    expect(sigs.length).toBe(0);
  });

  it('neutral user reply → no correction/accept/reject (might still emit edit if it looks like one)', async () => {
    const cid = 'cid-thu-b3';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_thu_b3', text: '我建议先做需求分析。' },
    });
    await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_b3', text: '我去问问产品经理' },
    });
    await wait();

    const tagged = await querySignals({
      types: ['correction', 'accept', 'reject'],
      cid,
    });
    expect(tagged.length).toBe(0);
  });
});
