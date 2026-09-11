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
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
      ownerAgentId: 'agent-b', interactive: true, userGoal: 'review', handoffMessage: 'review',
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
      interactive: true,
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
    const origin = (await s.readState(TEST_UID, TEST_CID)).active_recipient_revision || 0;
    await s.setActiveRecipient(TEST_UID, TEST_CID, 'commander', 'user_selection');
    const request = { ownerAgentId: 'agent-a', interactive: true, userGoal: 'review', handoffMessage: 'review' };
    const stale = await s.beginAgentHandoff(TEST_UID, TEST_CID, { ...request, expectedFloorRevision: origin });
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

  it('rollback never overwrites a newer user floor or orchestration ledger', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const admission = await s.beginAgentHandoff(TEST_UID, TEST_CID, {
      ownerAgentId: 'agent-a',
      ownerAgentName: 'AgentA',
      interactive: true,
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
  it('heals persisted running/in_flight state when no worker exists in this process', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setStatus(TEST_UID, TEST_CID, 'running');
    await s.markInFlight(TEST_UID, TEST_CID, 'commander', true);

    const facade = await import('../../../../src/main/features/group_chat');
    const runtime = await facade.runtimeStatus(TEST_UID, TEST_CID);
    expect(runtime).toMatchObject({
      processing: false,
      processing_since: null,
      in_flight: [],
      active_turns: [],
    });

    const healed = await s.readState(TEST_UID, TEST_CID);
    expect(healed.status).toBe('idle');
    expect(healed.in_flight).toEqual([]);
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
