import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const TEST_CID = 'cid42';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-vis-'));
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

describe('group_chat visibility › appendVisible filtering', () => {
  it('writes commander slice for every message — sees the whole group', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    // user → commander
    await v.appendVisible(TEST_UID, TEST_CID, {
      id: 'm1', ts: 't', from: 'user', to: ['commander'], text: 'hi',
    }, ['commander', 'user', 'agent-a']);
    // commander → @agent-a
    await v.appendVisible(TEST_UID, TEST_CID, {
      id: 'm2', ts: 't', from: 'commander', to: ['agent-a'], text: 'go',
    }, ['commander', 'user', 'agent-a']);
    // agent-a → commander (default)
    await v.appendVisible(TEST_UID, TEST_CID, {
      id: 'm3', ts: 't', from: 'agent-a', to: ['commander'], text: 'done',
    }, ['commander', 'user', 'agent-a']);

    const cmdSlice = await v.readSlice(TEST_UID, TEST_CID, 'commander');
    expect(cmdSlice.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('agent slice only contains messages where it is from / to / @-mentioned', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    // user → commander (NOT visible to agent-a)
    await v.appendVisible(TEST_UID, TEST_CID, {
      id: 'm1', ts: 't', from: 'user', to: ['commander'], text: 'hi',
    }, ['commander', 'user', 'agent-a']);
    // commander → @agent-a (visible to agent-a)
    await v.appendVisible(TEST_UID, TEST_CID, {
      id: 'm2', ts: 't', from: 'commander', to: ['agent-a'], text: 'go',
    }, ['commander', 'user', 'agent-a']);
    // agent-a → commander (visible to agent-a as own msg)
    await v.appendVisible(TEST_UID, TEST_CID, {
      id: 'm3', ts: 't', from: 'agent-a', to: ['commander'], text: 'done',
    }, ['commander', 'user', 'agent-a']);
    // user → @agent-b (NOT visible to agent-a)
    await v.appendVisible(TEST_UID, TEST_CID, {
      id: 'm4', ts: 't', from: 'user', to: ['agent-b'], text: 'unrelated',
    }, ['commander', 'user', 'agent-a', 'agent-b']);

    const aSlice = await v.readSlice(TEST_UID, TEST_CID, 'agent-a');
    expect(aSlice.map((m) => m.id)).toEqual(['m2', 'm3']);
  });

  it('agent sees a message that mentions it even if not in to[]', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    // user → commander, but mentions agent-x in text → router populates mentions[]
    await v.appendVisible(TEST_UID, TEST_CID, {
      id: 'm1', ts: 't', from: 'user', to: ['commander'],
      mentions: ['agent-x'], text: '@agent-x heads up',
    }, ['commander', 'user', 'agent-x']);
    const slice = await v.readSlice(TEST_UID, TEST_CID, 'agent-x');
    expect(slice).toHaveLength(1);
    expect(slice[0].id).toBe('m1');
  });

  it('user is never written a slice (UI reads main jsonl directly)', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const paths = await import('../../../../src/main/paths');
    await v.appendVisible(TEST_UID, TEST_CID, {
      id: 'm1', ts: 't', from: 'commander', to: ['user'], text: 'hi',
    }, ['commander', 'user']);
    const userSliceFile = paths.groupChatVisibilityFile(TEST_UID, TEST_CID, 'user');
    expect(fs.existsSync(userSliceFile)).toBe(false);
  });
});

describe('group_chat visibility › buildReplayPrefix', () => {
  it('returns empty prefix when slice has no prior history', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const r = v.buildReplayPrefix([], 'never-mind');
    expect(r.prefix).toBe('');
  });

  it('builds <group-chat-history> from prior messages, dropping the trigger msg', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const slice = [
      { id: 'a', ts: 't1', from: 'commander', to: ['agent-x'], text: 'first' },
      { id: 'b', ts: 't2', from: 'agent-x', to: ['commander'], text: 'second' },
      { id: 'c', ts: 't3', from: 'commander', to: ['agent-x'], text: 'TRIGGER' },
    ] as any;
    const r = v.buildReplayPrefix(slice, 'c');
    expect(r.prefix).toContain('<group-chat-history>');
    expect(r.prefix).toContain('first');
    expect(r.prefix).toContain('second');
    expect(r.prefix).not.toContain('TRIGGER');
  });
});
