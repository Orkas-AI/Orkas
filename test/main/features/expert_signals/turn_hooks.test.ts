import { describe, it, expect, afterEach } from 'vitest';
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
} from '../../../../src/main/features/expert_signals/turn_hooks';
import { querySignals } from '../../../../src/main/features/expert_signals';
import { _clearAllPending, scheduleSilenceCheck } from '../../../../src/main/features/expert_signals/extractors/silence';

async function wait() { return new Promise((r) => setTimeout(r, 30)); }

// Observe persisted signals through the real chokepoint. Free-form feedback
// no longer creates a verdict; objective failure events remain available.
afterEach(() => { _clearAllPending(); });

describe('onAgentTurnEnd › objective events', () => {
  it('does not emit failure signals on a clean turn', async () => {
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

describe('onUserMessage / onAgentTurnEnd › set B (must NOT emit)', () => {
  it('onUserMessage with no prior agent turn → no feedback signals', async () => {
    const cid = 'cid-thu-b1';
    await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_b1', text: '不对' },
    });
    await wait();

    const sigs = await querySignals({
      types: ['correction', 'accept', 'reject', 'edit'],
      cid,
    });
    expect(sigs.length).toBe(0);
  });

  it('silent agent turn → next user message does not imply feedback', async () => {
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

  it('neutral user reply → no inferred feedback', async () => {
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

describe('user prose is not a feedback verdict', () => {
  it.each(['Actually, explain the word wrong.', 'Write about perfect numbers.', '不要把“重新做”当作用户反馈。', '好的，就这样', '不对，重新做', '算了，不要这个了'])('does not label a follow-up from keywords: %s', async (text) => {
    const cid = `prose-${text.length}`;
    onAgentTurnEnd({ uid: UID, cid, actorId: 'agent_x', isCommander: false, agentMsg: { id: 'prior', text: 'An earlier answer.' } });
    await onUserMessage({ uid: UID, cid, userMsg: { id: 'next', text } });
    await wait();
    expect(await querySignals({ cid, types: ['accept', 'reject', 'correction', 'edit'] })).toEqual([]);
  });
});

it('does not infer an edit verdict from a follow-up that overlaps the previous answer', async () => {
  const cid = 'followup-overlap';
  const prefix = 'The report should include the project timeline and owners. ';
  onAgentTurnEnd({ uid: UID, cid, actorId: 'agent_x', isCommander: false,
    agentMsg: { id: 'previous-overlap', text: prefix + 'Use the remaining section for a detailed budget and cost summary.' } });
  await onUserMessage({ uid: UID, cid, userMsg: { id: 'followup-overlap',
    text: prefix + 'Explain this sentence in the context of a small volunteer project.' } });
  await wait();
  expect(await querySignals({ cid, types: ['accept', 'reject', 'correction', 'edit'] })).toEqual([]);
});

// The removed classifier shared this hook with inactivity bookkeeping. Keep
// cancellation scoped to the user's conversation, without changing timers.
it('a user reply cancels only its conversation inactivity observation', async () => {
  for (const cid of ['replied-conversation', 'still-inactive']) {
    scheduleSilenceCheck({ uid: UID, cid, aid: 'agent_x', turn_id: cid, msg_ids: [cid], thresholdMs: 30 });
  }
  await onUserMessage({ uid: UID, cid: 'replied-conversation', userMsg: { id: 'reply', text: 'Actually, continue.' } });
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(await querySignals({ cid: 'replied-conversation', types: ['silence', 'accept', 'correction', 'reject', 'edit'] })).toEqual([]);
  expect(await querySignals({ cid: 'still-inactive', types: ['silence'] })).toHaveLength(1);
});
