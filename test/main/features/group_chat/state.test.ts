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
  it('build commander / member session ids with the right kind segment', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    expect(s.buildGconvSessionId('u1', 'cidA')).toBe('u1-gconv-cidA');
    expect(s.buildGmemberSessionId('u1', 'cidA', 'agentX')).toBe('u1-gmember-cidA-agentX');
  });

  it('actorSessionId routes commander → gconv, agent → gmember, user → throw', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    expect(s.actorSessionId('u1', 'cidA', { kind: 'commander', id: 'commander', joined_at: 't' }))
      .toBe('u1-gconv-cidA');
    expect(s.actorSessionId('u1', 'cidA', { kind: 'agent', id: 'agentX', joined_at: 't' }))
      .toBe('u1-gmember-cidA-agentX');
    expect(() => s.actorSessionId('u1', 'cidA', { kind: 'user', id: 'user', joined_at: 't' })).toThrow();
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
