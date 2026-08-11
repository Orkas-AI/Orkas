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
  it('does not write a commander slice because Commander reads the canonical log', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const paths = await import('../../../../src/main/paths');
    const legacyCommanderSlice = paths.groupChatVisibilityFile(TEST_UID, TEST_CID, 'commander');
    fs.mkdirSync(path.dirname(legacyCommanderSlice), { recursive: true });
    fs.writeFileSync(legacyCommanderSlice, '{"id":"legacy"}\n');
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
    expect(cmdSlice).toEqual([]);
    expect(fs.existsSync(legacyCommanderSlice)).toBe(false);
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

describe('group_chat visibility › Commander canonical conversation history', () => {
  it('includes exact Agent blockers and actor names from the full log before the current user turn', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      {
        id: 'u1', ts: 't1', from: 'user', to: ['commander'],
        text: '把这段文案做成视频。',
      },
      {
        id: 'dispatch', ts: 't2', from: 'commander', to: ['video-agent'],
        text: '制作视频', dispatch: true,
      },
      {
        id: 'agent-result', ts: 't3', from: 'video-agent', to: ['user'],
        text: '当前不能继续：E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED',
        failure_kind: 'operation',
        failure_code: 'narration_authorization_missing',
        process: [{ type: 'progress', text: 'INTERNAL_PROCESS_MUST_NOT_REPLAY' }],
      },
      {
        id: 'u2', ts: 't4', from: 'user', to: ['commander'],
        text: 'Fix that blocker.',
      },
    ] as any;

    const history = v.buildCommanderConversationHistory(
      rows,
      'u2',
      new Map([['video-agent', 'VideoStudio']]),
    );
    const serialized = JSON.stringify(history);

    expect(history.map((message) => [message.role, message.turnId])).toEqual([
      ['user', 1],
      ['assistant', 1],
    ]);
    expect(serialized).toContain('把这段文案做成视频');
    expect(serialized).toContain('VideoStudio');
    expect(serialized).toContain('E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED');
    expect((history[1].content[0] as any).text).toContain(
      '[Commander -> VideoStudio (video-agent); dispatch]',
    );
    expect((history[1].content[0] as any).text).toContain(
      '[VideoStudio (video-agent) -> User; failure=operation/narration_authorization_missing]',
    );
    expect(serialized).not.toContain('[Historical group conversation');
    expect(serialized).not.toContain('"actor_id"');
    expect(serialized).not.toContain('"dispatch":true');
    expect(serialized).not.toContain('Fix that blocker.');
    expect(serialized).not.toContain('INTERNAL_PROCESS_MUST_NOT_REPLAY');
  });

  it('does not replay a previously leaked internal history serialization', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      {
        id: 'u1', ts: 't1', from: 'user', to: ['commander'],
        text: 'Continue the import.',
      },
      {
        id: 'a1', ts: 't2', from: 'commander', to: ['user'],
        text: [
          '[commander]',
          '[Historical group conversation — actor responses]',
          'These are the recorded responses from Commander and/or Agents.',
          '{"actor_id":"commander","text":"stale internal replay"}',
          '[History retained facts — host-persisted model extraction]',
          '- private stale checkpoint',
        ].join('\n'),
        produced: ['/workspace/export.md'],
      },
      {
        id: 'u2', ts: 't3', from: 'user', to: ['commander'],
        text: 'Why did the literal "[Historical conversation]" appear?',
      },
      {
        id: 'a2', ts: 't4', from: 'commander', to: ['user'],
        text: 'That look-alike phrase is ordinary visible text and should remain.',
      },
      {
        id: 'u3', ts: 't5', from: 'user', to: ['commander'],
        text: 'Continue.',
      },
    ] as any;

    const history = v.buildCommanderConversationHistory(rows, 'u3');
    const serialized = JSON.stringify(history);

    expect(serialized).not.toContain('stale internal replay');
    expect(serialized).not.toContain('private stale checkpoint');
    expect(serialized).toContain('Prior response body omitted because it contained internal history serialization.');
    expect(serialized).toContain('/workspace/export.md');
    expect(serialized).toContain('Why did the literal \\"[Historical conversation]\\" appear?');
    expect(serialized).toContain('That look-alike phrase is ordinary visible text and should remain.');
  });

  it('keeps stable user-turn ids while excluding deleted turns', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      { id: 'u1', ts: 't1', from: 'user', to: ['commander'], text: 'first' },
      { id: 'a1', ts: 't2', from: 'commander', to: ['user'], text: 'reply first' },
      { id: 'u2', ts: 't3', from: 'user', to: ['commander'], text: '', deleted_at: 't9' },
      { id: 'a2', ts: 't4', from: 'commander', to: ['user'], text: 'deleted tail' },
      { id: 'u3', ts: 't5', from: 'user', to: ['commander'], text: 'third' },
      { id: 'a3', ts: 't6', from: 'commander', to: ['user'], text: 'reply third' },
      { id: 'u4', ts: 't7', from: 'user', to: ['commander'], text: 'current' },
    ] as any;

    const history = v.buildCommanderConversationHistory(rows, 'u4');
    expect(history.map((message) => message.turnId)).toEqual([1, 1, 3, 3]);
    expect(JSON.stringify(history)).not.toContain('deleted tail');
  });

  it('projects a bounded tail identically to the matching suffix of a full rebuild', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      { id: 'u1', ts: 't1', from: 'user', to: ['commander'], text: 'first' },
      { id: 'a1', ts: 't2', from: 'commander', to: ['user'], text: 'reply first' },
      { id: 'u2', ts: 't3', from: 'user', to: ['commander'], text: 'deleted', deleted_at: 't9' },
      { id: 'a2', ts: 't4', from: 'commander', to: ['user'], text: 'deleted tail' },
      { id: 'u3', ts: 't5', from: 'user', to: ['commander'], text: 'make video' },
      { id: 'agent', ts: 't6', from: 'video-agent', to: ['user'], text: 'E_BLOCKER' },
      { id: 'u4', ts: 't7', from: 'user', to: ['commander'], text: 'fix it' },
    ] as any;
    const actorNames = new Map([['video-agent', 'VideoStudio']]);

    const full = v.buildCommanderConversationHistory(rows, 'u4', actorNames);
    const tail = v.buildCommanderConversationHistoryTail(
      rows.slice(4),
      'u4',
      2,
      actorNames,
    );

    expect(tail).toEqual(full.filter((message: any) => message.turnId >= 3));
    expect(tail.map((message: any) => message.turnId)).toEqual([3, 3]);
    expect(JSON.stringify(tail)).toContain('VideoStudio');
    expect(JSON.stringify(tail)).toContain('E_BLOCKER');
  });
});
