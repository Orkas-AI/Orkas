import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel() {
    yield { type: 'final', text: '' };
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
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  try {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    for (const cid of ['target-cid']) {
      await bus.abort(UID, cid);
      bus.dropConv(UID, cid);
    }
  } catch (_) {}
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('cross-task reference flattening', () => {
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
