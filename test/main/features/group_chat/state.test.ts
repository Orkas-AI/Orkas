import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const TEST_CID = 'cid01';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-state-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('group_chat state › sessionId builders', () => {
  // session_id format is `<kind>-<tail>` (CLAUDE.md §5 — uid no longer in session_id; user
  // scoping comes from the path root `<activeUid>/cloud/sessions/<sid>.jsonl`).
  it('build commander / member session ids with the right kind segment', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    expect(s.buildGconvSessionId('cidA')).toBe('gconv-cidA');
    expect(s.buildGmemberSessionId('cidA', 'agentX')).toBe('gmember-cidA-agentX');
  });

  it('actorSessionId routes commander → gconv, agent → gmember, user → throw', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    expect(s.actorSessionId('cidA', { kind: 'commander', id: 'commander', joined_at: 't' }))
      .toBe('gconv-cidA');
    expect(s.actorSessionId('cidA', { kind: 'agent', id: 'agentX', joined_at: 't' }))
      .toBe('gmember-cidA-agentX');
    expect(() => s.actorSessionId('cidA', { kind: 'user', id: 'user', joined_at: 't' })).toThrow();
  });
});

describe('group_chat state › durable executing turn identity', () => {
  it('retains each turn across other state writes and clears only the settled actor', async () => {
    const state = await import('../../../../src/main/features/group_chat/state');
    await state.setStatus(TEST_UID, TEST_CID, 'running');
    const a = { turn_id: 'turn-a', source_message_id: 'source-a' };
    const b = { turn_id: 'turn-b', source_message_id: 'source-b' };
    await state.markInFlight(TEST_UID, TEST_CID, 'agent-a', true, a);
    await state.markInFlight(TEST_UID, TEST_CID, 'agent-b', true, b);
    await state.markInFlight(TEST_UID, TEST_CID, 'agent-a', true);
    await state.setActiveRecipient(TEST_UID, TEST_CID, 'agent-b', 'user_selection');
    vi.resetModules();
    const reloaded = await import('../../../../src/main/features/group_chat/state');
    expect(await reloaded.readState(TEST_UID, TEST_CID)).toMatchObject({
      in_flight: ['agent-a', 'agent-b'], in_flight_turns: { 'agent-a': a, 'agent-b': b },
    });
    await reloaded.markInFlight(TEST_UID, TEST_CID, 'agent-a', false);
    expect(await reloaded.readState(TEST_UID, TEST_CID)).toMatchObject({
      in_flight: ['agent-b'], in_flight_turns: { 'agent-b': b },
    });
    expect((await reloaded.readState(TEST_UID, TEST_CID)).in_flight_turns?.['agent-a']).toBeUndefined();
    await reloaded.setStatus(TEST_UID, TEST_CID, 'idle');
    expect((await reloaded.readState(TEST_UID, TEST_CID)).in_flight_turns).toBeUndefined();
  });

  it('reads legacy and malformed turn metadata without losing the actor roster or retaining foreign entries', async () => {
    const paths = await import('../../../../src/main/paths');
    const state = await import('../../../../src/main/features/group_chat/state');
    const file = paths.groupChatStateFile(TEST_UID, TEST_CID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const metadata of [undefined, [], 'invalid', { 'agent-a': { turn_id: 'turn-a', source_message_id: 'source-a', extra: 'drop' },
      'agent-b': { turn_id: '../bad', source_message_id: 'source-b' }, foreign: { turn_id: 'turn-c', source_message_id: 'source-c' } }]) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, status: 'running', in_flight: ['agent-a', 'agent-b'], in_flight_turns: metadata }));
      const current = await state.readState(TEST_UID, TEST_CID);
      expect(current.in_flight).toEqual(['agent-a', 'agent-b']);
      expect(current.in_flight_turns).toEqual(metadata && !Array.isArray(metadata) && typeof metadata === 'object'
        ? { 'agent-a': { turn_id: 'turn-a', source_message_id: 'source-a' } } : undefined);
    }
  });
});

describe('group_chat state › addMember + ensureAgentMember', () => {
  it('addMember idempotent — second call with same id returns false', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const a = await s.addMember(TEST_UID, TEST_CID, { kind: 'agent', id: 'writer', name: 'Writer' });
    const b = await s.addMember(TEST_UID, TEST_CID, { kind: 'agent', id: 'writer', name: 'Writer' });
    expect(a).toBe(true);
    expect(b).toBe(false);
    const m = await s.readMembers(TEST_UID, TEST_CID);
    expect(m.actors.filter((x) => x.id === 'writer')).toHaveLength(1);
  });

  it('seedReservedActors creates commander + user and is idempotent', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.seedReservedActors(TEST_UID, TEST_CID);
    await s.seedReservedActors(TEST_UID, TEST_CID); // again
    const m = await s.readMembers(TEST_UID, TEST_CID);
    expect(m.actors.map((a) => a.id).sort()).toEqual(['commander', 'user']);
  });

  it('ensureAgentMember rejects reserved ids + non-safeId tokens', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    expect(await s.ensureAgentMember(TEST_UID, TEST_CID, 'commander')).toBe(false);
    expect(await s.ensureAgentMember(TEST_UID, TEST_CID, 'user')).toBe(false);
    expect(await s.ensureAgentMember(TEST_UID, TEST_CID, '../etc')).toBe(false);
    expect(await s.ensureAgentMember(TEST_UID, TEST_CID, 'writer', 'Writer')).toBe(true);
  });
});

describe('group_chat state › legacy visibility slices', () => {
  it('removes a retired per-Agent visibility directory the first time the roster is read', async () => {
    // The slices were derived copies with no reader since 697819029; they are
    // private data that stayed on disk (and in cloud sync) for every existing
    // conversation. The roster read is the first group-dir touch of a turn.
    const s = await import('../../../../src/main/features/group_chat/state');
    s._resetLegacyVisibilitySweepForTest();
    const groupDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats', TEST_CID);
    fs.mkdirSync(path.join(groupDir, 'visibility'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'visibility', 'agent-a.jsonl'), '{"id":"m1"}\n');
    fs.writeFileSync(path.join(groupDir, 'members.json'), JSON.stringify({ version: 1, actors: [{ id: 'agent-a', kind: 'agent', name: 'A' }] }));

    const members = await s.readMembers(TEST_UID, TEST_CID);
    // The roster read schedules background filesystem IO; wait for its result
    // instead of assuming the host completes recursive deletion within 20ms.
    await vi.waitFor(() => expect(fs.existsSync(path.join(groupDir, 'visibility'))).toBe(false));
    // Negative control: the canonical roster file is untouched and still read.
    expect(fs.existsSync(path.join(groupDir, 'members.json'))).toBe(true);
    expect(members.actors.map((a) => a.id)).toEqual(['agent-a']);
  });
});

describe('group_chat state › active recipient provenance', () => {
  it('reads an old persisted multi-recipient default as Commander after restart', async () => {
    const { groupChatStateFile } = await import('../../../../src/main/paths');
    const file = groupChatStateFile(TEST_UID, TEST_CID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, status: 'idle', active_recipients: ['agent-a', 'agent-b'], active_recipient_source: 'user_selection' }));
    const state = await import('../../../../src/main/features/group_chat/state');
    const current = await state.readState(TEST_UID, TEST_CID);
    expect(current.active_recipient).toBeUndefined();
    expect(current.active_recipients).toBeUndefined();
    await state.setActiveRecipient(TEST_UID, TEST_CID, 'agent-a', 'user_selection');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ active_recipient: 'agent-a' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).active_recipients).toBeUndefined();
  });

  it('keeps Commander as the default after a multi-recipient choice and restores a later single choice', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setActiveRecipients(TEST_UID, TEST_CID, ['agent-a', 'commander', 'agent-a'], 'user_selection');
    expect((await s.readState(TEST_UID, TEST_CID)).active_recipients).toBeUndefined();
    const facade = await import('../../../../src/main/features/group_chat');
    expect((await facade.runtimeStatus(TEST_UID, TEST_CID)).active_recipients).toBeUndefined();
    expect(await facade.setFloor(TEST_UID, TEST_CID, ['commander', '../missing'])).toMatchObject({ ok: false });
    expect((await s.readState(TEST_UID, TEST_CID)).active_recipients).toBeUndefined();
    await s.clearOrchestrationForCancellation(TEST_UID, TEST_CID);
    const receipt = await s.beginAgentHandoff(TEST_UID, TEST_CID, {
      ownerAgentId: 'agent-b', claimFloor: true, userGoal: 'review', handoffMessage: 'review',
    });
    expect((await s.readState(TEST_UID, TEST_CID)).active_recipients).toBeUndefined();
    await s.rollbackAgentHandoff(TEST_UID, TEST_CID, receipt);
    expect((await s.readState(TEST_UID, TEST_CID)).active_recipients).toBeUndefined();
    await s.setActiveRecipient(TEST_UID, TEST_CID, 'agent-b', 'user_selection');
    const floor = await s.readState(TEST_UID, TEST_CID);
    expect(floor.active_recipients).toBeUndefined();
    expect(floor.active_recipient).toBe('agent-b');
    await s.rollbackAgentHandoff(TEST_UID, TEST_CID, receipt);
    expect((await s.readState(TEST_UID, TEST_CID)).active_recipient).toBe('agent-b');
  });

  it('preserves the source across same-Agent follow-ups and clears it with the floor', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');

    let floor = await s.setActiveRecipient(
      TEST_UID,
      TEST_CID,
      'agent-a',
      'commander_handoff',
    );
    expect(floor.active_recipient).toBe('agent-a');
    expect(floor.active_recipient_source).toBe('commander_handoff');

    floor = await s.setActiveRecipient(TEST_UID, TEST_CID, 'agent-a');
    expect(floor.active_recipient_source).toBe('commander_handoff');

    floor = await s.setActiveRecipient(TEST_UID, TEST_CID, 'agent-a', 'user_selection');
    expect(floor.active_recipient_source).toBe('user_selection');

    floor = await s.setActiveRecipient(TEST_UID, TEST_CID, 'commander');
    expect(floor.active_recipient).toBeUndefined();
    expect(floor.active_recipient_source).toBeUndefined();
  });
});

describe('group_chat state › scheduled Agent hand-off admission', () => {
  it('preserves a manual single recipient through unrelated handoff admission and rollback', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setActiveRecipient(TEST_UID, TEST_CID, 'agent-old', 'user_selection');
    await s.setOrchestrationLedger(TEST_UID, TEST_CID, {
      status: 'waiting_for_agent',
      blocked_on: 'agent_handoff',
      source_tool: 'dispatch_to',
      owner_agent_id: 'agent-old',
      owner_agent_name: 'OldAgent',
      user_goal: 'old goal',
      handoff_message: 'old task',
      resume_instruction: 'finish old goal',
    });

    const admission = await s.beginAgentHandoff(TEST_UID, TEST_CID, {
      ownerAgentId: 'agent-new',
      ownerAgentName: 'NewAgent',
      claimFloor: true,
      userGoal: 'new goal',
      handoffMessage: 'new task',
      resumeInstruction: 'finish new goal',
    });
    let current = await s.readState(TEST_UID, TEST_CID);
    expect(current.active_recipient).toBe('agent-old');
    expect(current.active_recipient_source).toBe('user_selection');
    expect(current.orchestration_ledger).toMatchObject({
      id: admission.token,
      source_tool: 'hand_off_to',
      owner_agent_id: 'agent-new',
      resume_instruction: 'finish new goal',
    });

    current = await s.rollbackAgentHandoff(TEST_UID, TEST_CID, admission);
    expect(current.active_recipient).toBe('agent-old');
    expect(current.active_recipient_source).toBe('user_selection');
    expect(current.orchestration_ledger).toMatchObject({
      source_tool: 'dispatch_to',
      owner_agent_id: 'agent-old',
      resume_instruction: 'finish old goal',
    });
  });

  it('rejects stale automatic selection after the user chooses Commander and protects a newer same-Agent handoff', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const origin = (await s.readState(TEST_UID, TEST_CID)).active_recipient_choice_revision || 0;
    await s.setActiveRecipient(TEST_UID, TEST_CID, 'commander', 'user_selection');
    const request = { ownerAgentId: 'agent-a', claimFloor: true, userGoal: 'review', handoffMessage: 'review' };
    const stale = await s.beginAgentHandoff(TEST_UID, TEST_CID, { ...request, expectedChoiceRevision: origin });
    expect(stale.floorApplied).toBe(false);
    expect((await s.readState(TEST_UID, TEST_CID)).active_recipient).toBeUndefined();
    const old = await s.beginAgentHandoff(TEST_UID, TEST_CID, request);
    expect(old.floorApplied).toBe(true);
    const oldRevision = (await s.readState(TEST_UID, TEST_CID)).active_recipient_revision;
    await s.setActiveRecipient(TEST_UID, TEST_CID, 'commander', 'user_selection');
    const newer = await s.beginAgentHandoff(TEST_UID, TEST_CID, request);
    await s.rollbackAgentHandoff(TEST_UID, TEST_CID, old);
    await s.setActiveRecipient(TEST_UID, TEST_CID, 'commander', undefined, oldRevision);
    const current = await s.readState(TEST_UID, TEST_CID);
    expect(current.active_recipient).toBe('agent-a');
    expect(current.active_recipient_handoff_id).toBe(newer.token);
  });

  it('admits a formal hand-off without consulting Agent interaction metadata', async () => {
    const state = await import('../../../../src/main/features/group_chat/state');
    const receipt = await state.beginAgentHandoff(TEST_UID, TEST_CID, {
      ownerAgentId: 'agent-a', claimFloor: true, expectedChoiceRevision: 0,
      userGoal: 'goal', handoffMessage: 'task',
    });
    expect(receipt.floorApplied).toBe(true);
    expect(await state.readState(TEST_UID, TEST_CID)).toMatchObject({
      active_recipient: 'agent-a', active_recipient_source: 'commander_handoff',
      active_recipient_handoff_id: receipt.token, active_recipient_choice_revision: 0,
    });
    await state.rollbackAgentHandoff(TEST_UID, TEST_CID, receipt);
    expect((await state.readState(TEST_UID, TEST_CID)).active_recipient).toBeUndefined();
  });

  it('binds an automatically selected Agent to its waiting task without stealing another selection', async () => {
    const state = await import('../../../../src/main/features/group_chat/state');
    await state.beginAgentHandoff(TEST_UID, TEST_CID, {
      ownerAgentId: 'agent-a', claimFloor: true, userGoal: 'goal', handoffMessage: 'task',
    });
    const origin = (await state.readState(TEST_UID, TEST_CID)).active_recipient_choice_revision;
    expect(await state.claimFloorForWaitingTask(TEST_UID, TEST_CID, 'agent-a', 'task-a', origin)).toBe(true);
    expect((await state.readState(TEST_UID, TEST_CID)).active_recipient_handoff_id).toBe(state.waitingFloorBinding('task-a'));
    expect(await state.releaseWaitingFloor(TEST_UID, TEST_CID, 'agent-a', 'task-b')).toBe(false);
    expect(await state.releaseWaitingFloor(TEST_UID, TEST_CID, 'agent-a', 'task-a')).toBe(true);
    expect((await state.readState(TEST_UID, TEST_CID)).active_recipient).toBeUndefined();
  });

  it('does not let a late input form undo a newer explicit return to Commander', async () => {
    const state = await import('../../../../src/main/features/group_chat/state');
    const origin = (await state.readState(TEST_UID, TEST_CID)).active_recipient_choice_revision || 0;
    await state.setActiveRecipient(TEST_UID, TEST_CID, 'commander', 'user_selection');
    expect(await state.claimFloorForWaitingTask(TEST_UID, TEST_CID, 'agent-a', 'task-a', origin)).toBe(false);
    expect((await state.readState(TEST_UID, TEST_CID)).active_recipient).toBeUndefined();
  });

  it('a stale cancellation cannot consume a newer continuation for the same Agent', async () => {
    const state = await import('../../../../src/main/features/group_chat/state');
    const old = await state.beginAgentHandoff(TEST_UID, TEST_CID, {
      ownerAgentId: 'agent-a', claimFloor: true, userGoal: 'old goal',
      handoffMessage: 'old task', resumeInstruction: 'finish old goal',
    });
    const oldRevision = (await state.readState(TEST_UID, TEST_CID)).active_recipient_revision;
    await state.setActiveRecipient(TEST_UID, TEST_CID, 'commander', 'user_selection');
    const current = await state.beginAgentHandoff(TEST_UID, TEST_CID, {
      ownerAgentId: 'agent-a', claimFloor: true, userGoal: 'new goal',
      handoffMessage: 'new task', resumeInstruction: 'finish new goal',
    });
    expect(await state.takeOrchestrationLedgerForAgent(TEST_UID, TEST_CID, 'agent-a', old.token)).toBeNull();
    expect(await state.releaseWaitingFloor(TEST_UID, TEST_CID, 'agent-a', 'old-task', oldRevision, old.token)).toBe(false);
    expect(await state.readState(TEST_UID, TEST_CID)).toMatchObject({
      active_recipient: 'agent-a', orchestration_ledger: { id: current.token, resume_instruction: 'finish new goal' },
    });
  });

  it('reads legacy floor generations conservatively and persists user choices separately from automatic changes', async () => {
    const state = await import('../../../../src/main/features/group_chat/state');
    const paths = await import('../../../../src/main/paths');
    const file = paths.groupChatStateFile(TEST_UID, TEST_CID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, status: 'idle', active_recipient_revision: 4 }));
    expect((await state.readState(TEST_UID, TEST_CID)).active_recipient_choice_revision).toBe(4);
    await state.beginAgentHandoff(TEST_UID, TEST_CID, {
      ownerAgentId: 'agent-a', claimFloor: true, expectedChoiceRevision: 4,
      userGoal: 'goal', handoffMessage: 'task',
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      active_recipient_revision: 5, active_recipient_choice_revision: 4,
    });
    await state.setActiveRecipient(TEST_UID, TEST_CID, 'commander', 'user_selection');
    expect((await state.readState(TEST_UID, TEST_CID)).active_recipient_choice_revision).toBe(5);
    expect(await state.claimFloorForWaitingTask(TEST_UID, TEST_CID, 'agent-a', 'late-task', 4)).toBe(false);
  });

  it('rollback never overwrites a newer user floor or orchestration ledger', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const admission = await s.beginAgentHandoff(TEST_UID, TEST_CID, {
      ownerAgentId: 'agent-a',
      ownerAgentName: 'AgentA',
      claimFloor: true,
      userGoal: 'goal a',
      handoffMessage: 'task a',
      resumeInstruction: 'resume a',
    });
    await s.setActiveRecipient(TEST_UID, TEST_CID, 'agent-b', 'user_selection');
    await s.setOrchestrationLedger(TEST_UID, TEST_CID, {
      status: 'waiting_for_agent',
      blocked_on: 'agent_handoff',
      source_tool: 'dispatch_to',
      owner_agent_id: 'agent-b',
      user_goal: 'goal b',
      handoff_message: 'task b',
      resume_instruction: 'resume b',
    });

    const current = await s.rollbackAgentHandoff(TEST_UID, TEST_CID, admission);
    expect(current.active_recipient).toBe('agent-b');
    expect(current.active_recipient_source).toBe('user_selection');
    expect(current.orchestration_ledger).toMatchObject({
      source_tool: 'dispatch_to',
      owner_agent_id: 'agent-b',
      resume_instruction: 'resume b',
    });
  });

  it('cancellation clears Commander-owned hand-off state but preserves a user-selected floor', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setActiveRecipient(TEST_UID, TEST_CID, 'agent-user', 'user_selection');
    await s.setOrchestrationLedger(TEST_UID, TEST_CID, {
      status: 'waiting_for_agent',
      blocked_on: 'agent_handoff',
      source_tool: 'hand_off_to',
      owner_agent_id: 'agent-user',
      user_goal: 'goal',
      handoff_message: 'task',
      resume_instruction: 'resume',
    });

    const current = await s.clearOrchestrationForCancellation(TEST_UID, TEST_CID);
    expect(current.orchestration_ledger).toBeUndefined();
    expect(current.active_recipient).toBe('agent-user');
    expect(current.active_recipient_source).toBe('user_selection');
  });
});

describe('group_chat state › renameAgentInMembers', () => {
  // Drive the rename sweep through a seeded `_index.json` + a couple of
  // pre-populated members.json files. The bug this guards: members.name is a
  // join-time snapshot the @-router resolves on first, so without the sweep
  // old conversations would keep matching `@<old-name>` after a rename.
  async function seedConv(uid: string, cid: string, actors: any[]): Promise<void> {
    const paths = await import('../../../../src/main/paths');
    const dir = path.join(paths.userChatsDir(uid), cid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'members.json'), JSON.stringify({ version: 1, actors }));
  }
  async function seedIndex(uid: string, cids: string[]): Promise<void> {
    const paths = await import('../../../../src/main/paths');
    const dir = paths.userChatsDir(uid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '_index.json'),
      JSON.stringify({ items: cids.map((c) => ({ conversation_id: c })) }),
    );
  }

  it('updates the name on every roster carrying the agent and skips others', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await seedConv(TEST_UID, 'cidA', [
      { kind: 'agent', id: 'writer', name: 'OldWriter', joined_at: 't' },
      { kind: 'commander', id: 'commander', name: 'Commander', joined_at: 't' },
    ]);
    await seedConv(TEST_UID, 'cidB', [
      { kind: 'agent', id: 'reviewer', name: 'Reviewer', joined_at: 't' },
    ]);
    await seedConv(TEST_UID, 'cidC', [
      { kind: 'agent', id: 'writer', name: 'OldWriter', joined_at: 't' },
    ]);
    await seedIndex(TEST_UID, ['cidA', 'cidB', 'cidC']);

    const touched = await s.renameAgentInMembers(TEST_UID, 'writer', 'NewWriter');
    expect(touched).toBe(2);

    const a = await s.readMembers(TEST_UID, 'cidA');
    expect(a.actors.find((x) => x.id === 'writer')?.name).toBe('NewWriter');
    expect(a.actors.find((x) => x.id === 'commander')?.name).toBe('Commander');

    const b = await s.readMembers(TEST_UID, 'cidB');
    expect(b.actors.find((x) => x.id === 'reviewer')?.name).toBe('Reviewer');

    const c = await s.readMembers(TEST_UID, 'cidC');
    expect(c.actors.find((x) => x.id === 'writer')?.name).toBe('NewWriter');
  });

  it('rejects reserved ids and non-safeId tokens', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await seedIndex(TEST_UID, ['cidA']);
    expect(await s.renameAgentInMembers(TEST_UID, 'commander', 'X')).toBe(0);
    expect(await s.renameAgentInMembers(TEST_UID, 'user', 'X')).toBe(0);
    expect(await s.renameAgentInMembers(TEST_UID, '../etc', 'X')).toBe(0);
  });

  it('returns 0 when the same name is already on the roster (no-op write)', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await seedConv(TEST_UID, 'cidA', [
      { kind: 'agent', id: 'writer', name: 'Writer', joined_at: 't' },
    ]);
    await seedIndex(TEST_UID, ['cidA']);
    expect(await s.renameAgentInMembers(TEST_UID, 'writer', 'Writer')).toBe(0);
  });
});

describe('group_chat state › markInFlight does NOT touch status', () => {
  it('flipping in_flight on/off leaves status untouched (status is owned by bus)', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    // Pre-set status='running' to simulate worker activation.
    await s.setStatus(TEST_UID, TEST_CID, 'running');
    let st = await s.readState(TEST_UID, TEST_CID);
    expect(st.status).toBe('running');

    // Add an actor; status must stay 'running' (the previous bug had
    // markInFlight flip status to 'idle' here, racing the IPC handler).
    await s.markInFlight(TEST_UID, TEST_CID, 'commander', true);
    st = await s.readState(TEST_UID, TEST_CID);
    expect(st.status).toBe('running');
    expect(st.in_flight).toEqual(['commander']);

    // Remove the actor; status STILL stays 'running'.
    await s.markInFlight(TEST_UID, TEST_CID, 'commander', false);
    st = await s.readState(TEST_UID, TEST_CID);
    expect(st.status).toBe('running');
    expect(st.in_flight).toEqual([]);
  });

  it('setStatus to idle clears in_flight; aborted clears too', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setStatus(TEST_UID, TEST_CID, 'running');
    await s.markInFlight(TEST_UID, TEST_CID, 'commander', true);
    await s.markInFlight(TEST_UID, TEST_CID, 'agent-a', true);
    let st = await s.readState(TEST_UID, TEST_CID);
    expect(st.in_flight).toContain('commander');
    expect(st.in_flight).toContain('agent-a');

    await s.setStatus(TEST_UID, TEST_CID, 'idle');
    st = await s.readState(TEST_UID, TEST_CID);
    expect(st.status).toBe('idle');
    expect(st.in_flight).toEqual([]);
  });
});

describe('group_chat state › compact running registry', () => {
  it('tracks running before state persistence and removes it after idle', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const paths = await import('../../../../src/main/paths');
    await s.setStatus(TEST_UID, TEST_CID, 'running');

    const running = JSON.parse(fs.readFileSync(
      paths.userRunningConversationsFile(TEST_UID), 'utf8'));
    expect(running).toEqual({
      version: 1,
      items: [{ conversation_id: TEST_CID }],
    });

    await s.setStatus(TEST_UID, TEST_CID, 'idle');
    const idle = JSON.parse(fs.readFileSync(
      paths.userRunningConversationsFile(TEST_UID), 'utf8'));
    expect(idle).toEqual({ version: 1, items: [] });
  });

  it('serialises concurrent conversation starts without losing entries', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await Promise.all([
      s.transitionStatus(TEST_UID, 'cid-a', () => 'running'),
      s.transitionStatus(TEST_UID, 'cid-b', () => 'running'),
    ]);

    const registry = await s.readRunningConversationRegistry(TEST_UID);
    expect(registry.valid).toBe(true);
    expect(registry.items.map((item) => item.conversation_id).sort())
      .toEqual(['cid-a', 'cid-b']);
  });
});

describe('group_chat state › touchActivity (stuck-turn watchdog heartbeat)', () => {
  // `touchActivity` is what keeps `processing_since` (= last_active_at) fresh
  // during a long single turn so the renderer's 12-min stuck-turn watchdog
  // doesn't false-positive. Invariants: bumps while running, throttles bursts
  // to one write per window, and never resurrects an idle conversation.
  it('bumps while running, throttles within the window, ignores idle convs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 12, 16, 0, 0, 0));
    try {
      const s = await import('../../../../src/main/features/group_chat/state');
      await s.setStatus(TEST_UID, TEST_CID, 'running');
      const t0 = (await s.readState(TEST_UID, TEST_CID)).last_active_at;

      // Past the 30s throttle window → first touch writes a fresh stamp.
      vi.advanceTimersByTime(40_000);
      await s.touchActivity(TEST_UID, TEST_CID);
      const t1 = (await s.readState(TEST_UID, TEST_CID)).last_active_at;
      expect(t1).not.toBe(t0);

      // Immediate second touch is inside the window → no new write.
      vi.advanceTimersByTime(5_000);
      await s.touchActivity(TEST_UID, TEST_CID);
      const t2 = (await s.readState(TEST_UID, TEST_CID)).last_active_at;
      expect(t2).toBe(t1);

      // Conversation goes idle; a later touch must NOT re-stamp it (would
      // otherwise keep a crashed/finished turn looking "fresh" forever).
      await s.setStatus(TEST_UID, TEST_CID, 'idle');
      const tIdle = (await s.readState(TEST_UID, TEST_CID)).last_active_at;
      vi.advanceTimersByTime(40_000);
      await s.touchActivity(TEST_UID, TEST_CID);
      const tAfter = (await s.readState(TEST_UID, TEST_CID)).last_active_at;
      expect(tAfter).toBe(tIdle);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('group_chat facade › runtimeStatus orphan recovery', () => {
  async function loadFacade() {
    const logger = await import('../../../../src/main/logger');
    const original = logger.createLogger;
    const warn = vi.fn();
    vi.spyOn(logger, 'createLogger').mockImplementation((scope) => {
      const scoped = original(scope);
      return scope === 'group_chat.facade' ? { ...scoped, warn } : scoped;
    });
    return { facade: await import('../../../../src/main/features/group_chat'), warn };
  }

  // Hold a real disk snapshot while another state writer finishes. This
  // reproduces history/status queries overlapping task completion or cancel.
  async function pauseNextStateRead(skip = 0) {
    const storage = await import('../../../../src/main/storage');
    const { groupChatStateFile } = await import('../../../../src/main/paths');
    const file = groupChatStateFile(TEST_UID, TEST_CID);
    const original = storage.readJson;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let intercepted = false;
    vi.spyOn(storage, 'readJson').mockImplementation(async (...args) => {
      const hold = args[0] === file && !intercepted && skip-- <= 0;
      if (hold) intercepted = true;
      const value = await original(...args);
      if (hold) { entered(); await gate; }
      return value;
    });
    return { paused, release };
  }

  it('heals persisted running/in_flight state when no worker exists in this process', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setStatus(TEST_UID, TEST_CID, 'running');
    await s.markInFlight(TEST_UID, TEST_CID, 'commander', true);

    const { facade, warn } = await loadFacade();
    const [runtime, concurrent] = await Promise.all([
      facade.runtimeStatus(TEST_UID, TEST_CID),
      facade.runtimeStatus(TEST_UID, TEST_CID),
    ]);
    expect(runtime).toMatchObject({
      processing: false,
      processing_since: null,
      in_flight: [],
      active_turns: [],
    });

    const healed = await s.readState(TEST_UID, TEST_CID);
    expect(healed.status).toBe('idle');
    expect(healed.in_flight).toEqual([]);
    expect(concurrent).toEqual(runtime);
    expect((await s.readRunningConversationRegistry(TEST_UID)).items).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(['idle', 'aborted'] as const)('preserves a concurrent %s transition without a false recovery warning', async (status) => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setStatus(TEST_UID, TEST_CID, 'running');
    const { facade, warn } = await loadFacade();
    const read = await pauseNextStateRead();
    const query = facade.runtimeStatus(TEST_UID, TEST_CID);
    await read.paused;
    try {
      await s.setStatus(TEST_UID, TEST_CID, status);
    } finally { read.release(); }
    expect(await query).toMatchObject({ processing: false, in_flight: [] });
    expect((await s.readState(TEST_UID, TEST_CID)).status).toBe(status);
    expect(warn).not.toHaveBeenCalled();
  });

  it('preserves a new task admitted between the initial snapshot and recovery', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setStatus(TEST_UID, TEST_CID, 'running');
    await s.markInFlight(TEST_UID, TEST_CID, 'commander', true);
    const { facade, warn } = await loadFacade();
    const bus = await import('../../../../src/main/features/group_chat/bus');
    let admitted = false;
    vi.spyOn(bus, 'runtimeSnapshot').mockImplementation(() => ({
      processing: admitted, inFlight: admitted ? ['commander'] : [], activeTurns: [],
    }));
    // Admit while the recovery's locked disk read is pending, after the
    // facade has already observed an idle bus. Rechecking before locking
    // or before the asynchronous read would still erase the new task.
    const read = await pauseNextStateRead(1);
    const query = facade.runtimeStatus(TEST_UID, TEST_CID);
    await read.paused;
    admitted = true;
    read.release();
    const runtime = await query;
    expect(runtime).toMatchObject({ processing: true, in_flight: ['commander'] });
    expect(await s.readState(TEST_UID, TEST_CID)).toMatchObject({ status: 'running', in_flight: ['commander'] });
    expect((await s.readRunningConversationRegistry(TEST_UID)).items).toEqual([{ conversation_id: TEST_CID }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['idle', 'aborted'] as const)('clears an orphan roster while preserving the persisted %s status', async (status) => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setStatus(TEST_UID, TEST_CID, status);
    await s.markInFlight(TEST_UID, TEST_CID, 'commander', true);
    const { facade, warn } = await loadFacade();
    expect(await facade.runtimeStatus(TEST_UID, TEST_CID)).toMatchObject({ processing: false, in_flight: [] });
    expect(await s.readState(TEST_UID, TEST_CID)).toMatchObject({ status, in_flight: [] });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports work admitted during recovery persistence and retains its running registry', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setStatus(TEST_UID, TEST_CID, 'running');
    const { facade, warn } = await loadFacade();
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const storage = await import('../../../../src/main/storage');
    const { groupChatStateFile } = await import('../../../../src/main/paths');
    const file = groupChatStateFile(TEST_UID, TEST_CID);
    const original = storage.writeJson;
    let admitted = false;
    let restart: Promise<unknown> | undefined;
    vi.spyOn(bus, 'runtimeSnapshot').mockImplementation(() => ({
      processing: admitted, inFlight: admitted ? ['commander'] : [], activeTurns: [],
    }));
    vi.spyOn(storage, 'writeJson').mockImplementation(async (...args) => {
      if (args[0] === file && !admitted) {
        admitted = true;
        // Like normal admission, its state write queues behind recovery.
        restart = s.setStatus(TEST_UID, TEST_CID, 'running')
          .then(() => s.markInFlight(TEST_UID, TEST_CID, 'commander', true));
      }
      return original(...args);
    });
    expect(await facade.runtimeStatus(TEST_UID, TEST_CID)).toMatchObject({
      processing: true, in_flight: ['commander'],
    });
    await restart;
    expect(await s.readState(TEST_UID, TEST_CID)).toMatchObject({ status: 'running', in_flight: ['commander'] });
    expect((await s.readRunningConversationRegistry(TEST_UID)).items).toEqual([{ conversation_id: TEST_CID }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// Two coding agents' FIRST turns in one conversation race the lazy
// coding-project-dir initialisation. The conversation contract is one frozen
// dir for its whole lifetime, so exactly one initialiser may win and both
// racers must converge on the winner — a check-then-set outside the state
// lock let the loser overwrite the winner while each turn ran in its own cwd.
describe('group_chat state › setCodingProjectDirOnce', () => {
  it('concurrent first-turn initialisers converge on exactly one winner', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const [a, b] = await Promise.all([
      s.setCodingProjectDirOnce(TEST_UID, TEST_CID, '/proj/from-agent-a', { explicit: true }),
      s.setCodingProjectDirOnce(TEST_UID, TEST_CID, '/proj/from-agent-b', { explicit: false }),
    ]);
    const winners = [a, b].filter((r) => r.applied);
    expect(winners).toHaveLength(1);
    const winnerDir = winners[0].state.coding_project_dir;
    expect(['/proj/from-agent-a', '/proj/from-agent-b']).toContain(winnerDir);
    // Both racers observe the SAME recorded dir, and disk agrees.
    expect(a.state.coding_project_dir).toBe(winnerDir);
    expect(b.state.coding_project_dir).toBe(winnerDir);
    const persisted = await s.readState(TEST_UID, TEST_CID);
    expect(persisted.coding_project_dir).toBe(winnerDir);
    // The explicit flag belongs to the winner, not the loser.
    expect(persisted.coding_project_dir_explicit === true)
      .toBe(winnerDir === '/proj/from-agent-a');
  });

  it('never overwrites an existing dir and ignores a blank one', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setCodingProjectDir(TEST_UID, TEST_CID, '/proj/user-chosen', { explicit: true });
    const later = await s.setCodingProjectDirOnce(TEST_UID, TEST_CID, '/proj/other', { explicit: false });
    expect(later.applied).toBe(false);
    expect(later.state.coding_project_dir).toBe('/proj/user-chosen');
    expect(later.state.coding_project_dir_explicit).toBe(true);

    const blank = await s.setCodingProjectDirOnce(TEST_UID, 'cid-fresh', '   ', { explicit: false });
    expect(blank.applied).toBe(false);
    expect((await s.readState(TEST_UID, 'cid-fresh')).coding_project_dir).toBeUndefined();
  });
});

// Use the production redactor as the transport boundary: caller summaries must
// remain private even when arbitrary user text has no recognizable secret shape.
async function capturePrivateDiagnostics(): Promise<unknown[][]> {
  const logger = await import('../../../../src/main/logger');
  const original = logger.createLogger;
  const records: unknown[][] = [];
  vi.spyOn(logger, 'createLogger').mockImplementation((scope) => {
    const scoped = original(scope);
    if (scope !== 'group_chat.state') return scoped;
    const capture = (message: string, ...args: unknown[]) => {
      records.push([message, ...args].map((value) => logger.redact(value)));
    };
    return { info: capture, warn: capture, error: capture, debug: capture };
  });
  return records;
}

describe('group_chat state › diagnostic privacy', () => {
  it('preserves member names through join and rename without including them in logs', async () => {
    const records = await capturePrivateDiagnostics();
    const state = await import('../../../../src/main/features/group_chat/state');
    const paths = await import('../../../../src/main/paths');
    const original = 'Confidential customer';
    const renamed = 'Private customer notes';
    expect(await state.addMember(TEST_UID, TEST_CID, { kind: 'agent', id: 'writer', name: original })).toBe(true);
    fs.writeFileSync(path.join(paths.userChatsDir(TEST_UID), '_index.json'), JSON.stringify([
      { conversation_id: TEST_CID },
    ]));
    expect(await state.renameAgentInMembers(TEST_UID, 'writer', renamed)).toBe(1);
    expect((await state.readMembers(TEST_UID, TEST_CID)).actors).toEqual([
      expect.objectContaining({ id: 'writer', name: renamed }),
    ]);
    expect(records).toHaveLength(2);
    const emitted = JSON.stringify(records);
    expect(emitted).not.toContain(original);
    expect(emitted).not.toContain(renamed);
  });
});
