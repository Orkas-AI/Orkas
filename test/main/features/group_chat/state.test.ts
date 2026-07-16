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
    expect(runtime).toEqual({
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
