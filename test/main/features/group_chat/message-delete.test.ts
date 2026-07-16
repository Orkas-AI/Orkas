import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspace: string | undefined;
const UID = 'delete-user';
const CID = 'delete-cid';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-message-delete-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('group_chat message deletion', () => {
  it('rewrites the main log and actor slices as tombstones and hides them from reads', async () => {
    const layoutModule = await import('../../../../src/main/util/project-layout');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const layout = layoutModule.conversationLayout(UID, CID);
    const rows = [
      { id: 'keep-msg', ts: '2026-07-10T10:00:00', from: 'user', to: ['commander'], text: 'keep' },
      { id: 'delete-msg', ts: '2026-07-10T10:01:00', from: 'commander', to: ['user'], text: 'delete' },
    ];
    fs.mkdirSync(path.dirname(layout.messageFile), { recursive: true });
    fs.writeFileSync(layout.messageFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    fs.mkdirSync(layout.visibilityDir, { recursive: true });
    fs.writeFileSync(layout.visibilityFile('commander'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const attachmentDir = layoutModule.chatAttachmentDirForConversation(UID, CID);
    fs.mkdirSync(attachmentDir, { recursive: true });
    const retainedAttachment = path.join(attachmentDir, 'retained.txt');
    fs.writeFileSync(retainedAttachment, 'kept for existing references');

    const result = await groupChat.deleteMessages(UID, CID, ['delete-msg']);

    expect(result).toMatchObject({ ok: true, deleted: ['delete-msg'] });
    const mainRows = fs.readFileSync(layout.messageFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const sliceRows = fs.readFileSync(layout.visibilityFile('commander'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(mainRows.find((row) => row.id === 'delete-msg')).toMatchObject({
      text: '', deleted_by_user: true, _v: 1,
    });
    expect(sliceRows.find((row) => row.id === 'delete-msg')).toMatchObject({
      text: '', deleted_by_user: true, _v: 1,
    });
    expect((await groupChat.readMessages(UID, CID)).map((row) => row.id)).toEqual(['keep-msg']);
    expect(fs.existsSync(retainedAttachment)).toBe(true);
  });
});
