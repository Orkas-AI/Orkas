import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

const modelInputs = vi.hoisted(() => [] as string[]);
vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(options: any) {
    modelInputs.push(String(options.message || ''));
    yield { type: 'final', text: 'Reference received.' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
  abortActiveSessionsForConversation: vi.fn(() => 0),
}));

let tmpDir: string;
let previousWorkspace: string | undefined;
const UID = 'reference-user';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reference-flatten-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  modelInputs.length = 0;
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  try {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    for (const cid of ['target-cid']) {
      await bus.abort(UID, cid);
      await bus.dropConv(UID, cid);
    }
  } catch (_) {}
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('conversation send failure receipts', () => {
  it('keeps an indeterminate storage failure private without labelling the send rejected', async () => {
    const logging = await import('../../../../src/main/logger');
    const create = logging.createLogger;
    const error = vi.fn();
    const logger = vi.spyOn(logging, 'createLogger').mockImplementation(scope => {
      const scoped = create(scope);
      return scope === 'group_chat.facade' ? { ...scoped, error } : scoped;
    });
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const enqueue = vi.spyOn(bus, 'enqueue');
    try {
      const group = await import('../../../../src/main/features/group_chat');
      for (const failure of [new Error('fixture-private-storage-detail'), null]) {
        enqueue.mockRejectedValueOnce(failure);
        const result = await group.send({ userId: UID, cid: 'target-cid', text: 'Hello' });
        expect(result).toEqual({ ok: false, error: 'send failed' });
      }
      expect(error).toHaveBeenCalledTimes(2);
      const recorded = JSON.stringify(error.mock.calls);
      for (const detail of [UID, 'target-cid', 'fixture-private-storage-detail']) {
        expect(recorded).not.toContain(detail);
      }
    } finally {
      enqueue.mockRestore();
      logger.mockRestore();
    }
  });
});

describe('cross-task reference flattening', () => {
  it('rejects missing or deleted quote locators as empty without renaming the target, then accepts a real quote', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const layout = await import('../../../../src/main/util/project-layout');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const source = await chats.createConversation(UID, { title: 'Source' });
    const target = await chats.createConversation(UID, { conversationId: 'target-cid', title: 'New Chat' });
    const targetHistory = layout.conversationMessageFile(UID, target.conversation_id);
    const originalHistory = fs.readFileSync(targetHistory, 'utf8');
    fs.writeFileSync(layout.conversationMessageFile(UID, source.conversation_id), [
      { id: 'deleted-msg', from: 'user', to: ['commander'], ts: '2026-10-10T07:00:00Z',
        text: 'Deleted request', deleted_at: '2026-10-10T07:01:00Z' },
      { id: 'real-msg', from: 'user', to: ['commander'], ts: '2026-10-10T07:00:00Z',
        text: 'Explain the root cause and proposed solution.' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    for (const sourceMsgId of ['missing-msg', 'deleted-msg']) {
      expect(await groupChat.send({ userId: UID, cid: target.conversation_id, text: '@commander',
        references: [{ source_cid: source.conversation_id, source_msg_id: sourceMsgId }],
      })).toEqual({ ok: false, error: 'empty message', admission_rejected: true });
      expect((await chats.getConversation(UID, target.conversation_id))?.title).toBe('New Chat');
      expect(fs.readFileSync(targetHistory, 'utf8')).toBe(originalHistory);
      expect(modelInputs).toEqual([]);
    }
    const accepted = await groupChat.send({ userId: UID, cid: target.conversation_id, text: '@commander',
      title_text: '', references: [{ source_cid: source.conversation_id, source_msg_id: 'real-msg' }],
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.msg?.to).toEqual(['commander']);
    const deadline = Date.now() + 3000;
    while (!bus.isQuiescent(UID, target.conversation_id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(bus.isQuiescent(UID, target.conversation_id)).toBe(true);
    expect(modelInputs).toHaveLength(1);
    expect(modelInputs[0]).toContain('Explain the root cause and proposed solution.');
    expect((await chats.getConversation(UID, target.conversation_id))?.title).toBe('New Chat');
  });

  it('carries source attachments, expands existing references, and deduplicates locators', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const layout = await import('../../../../src/main/util/project-layout');
    const originalConv = await chats.createConversation(UID, { title: 'Original' });
    const wrapperConv = await chats.createConversation(UID, { title: 'Wrapper' });
    const targetConv = await chats.createConversation(UID, { conversationId: 'target-cid', title: 'Target' });

    const originalRow = {
      id: 'original-msg',
      ts: '2026-07-10T10:00:00',
      from: 'user',
      to: ['commander'],
      text: 'Original content',
      attachments: ['brief.txt'],
    };
    fs.writeFileSync(
      layout.conversationMessageFile(UID, originalConv.conversation_id),
      `${JSON.stringify(originalRow)}\n`,
    );
    const sourceAttachmentDir = layout.chatAttachmentDirForConversation(UID, originalConv.conversation_id);
    fs.mkdirSync(sourceAttachmentDir, { recursive: true });
    fs.writeFileSync(path.join(sourceAttachmentDir, 'brief.txt'), 'source attachment');

    const nestedSnapshot = {
      source_cid: originalConv.conversation_id,
      source_title: 'Original',
      source_msg_id: 'original-msg',
      from_actor: 'user',
      source_ts: originalRow.ts,
      text: originalRow.text,
    };
    const wrapperRow = {
      id: 'wrapper-msg',
      ts: '2026-07-10T10:05:00',
      from: 'user',
      to: ['commander'],
      text: 'Wrapper content',
      references: [nestedSnapshot],
    };
    fs.writeFileSync(
      layout.conversationMessageFile(UID, wrapperConv.conversation_id),
      `${JSON.stringify(wrapperRow)}\n`,
    );

    const result = await groupChat.send({
      userId: UID,
      cid: targetConv.conversation_id,
      text: 'Use these records',
      references: [
        { source_cid: wrapperConv.conversation_id, source_msg_id: 'wrapper-msg' },
        { source_cid: originalConv.conversation_id, source_msg_id: 'original-msg' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.msg?.references?.map((ref) => ref.source_msg_id)).toEqual([
      'wrapper-msg',
      'original-msg',
    ]);
    expect(result.msg?.references?.[1].attachments).toEqual([
      { name: 'brief.txt', kind: 'text' },
    ]);
    expect(result.msg?.references?.[1]).not.toHaveProperty('path');
  });
});
