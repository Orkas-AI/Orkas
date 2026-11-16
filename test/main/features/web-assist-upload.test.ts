import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const roots = vi.hoisted(() => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-')), external: fs.mkdtempSync(path.join(os.tmpdir(), 'browser-picker-')) };
});
const { root, external } = roots;
vi.mock('../../../src/main/paths', () => ({ WS_ROOT: roots.root }));
vi.mock('../../../src/main/util/project-layout', () => ({
  conversationLayout: () => ({ projectId: 'project-current' }),
  chatAttachmentDirForConversation: (uid: string, cid: string) => path.join(root, 'attachments', uid, cid),
}));
vi.mock('../../../src/main/features/user_workspace', () => ({ getWorkspacePath: (uid: string, pid: string) => path.join(root, 'workspace', uid, pid) }));
vi.mock('../../../src/main/features/group_chat/conv_workspace', () => ({ readConversationAuthoringDir: async () => path.join(root, 'authoring') }));
import { loadWebAssistUploadFiles } from '../../../src/main/features/web_assist_upload';
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(external, { recursive: true, force: true }); });
function write(relative: string, content = 'exact upload\n中文\0', base = root) {
  const filename = path.join(base, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content); return filename;
}

describe('native browser upload authorization', () => {
  it('returns authorized paths without loading file bytes into host or model IPC', async () => {
    const paths = ['workspace/u1/project-current/work.txt', 'attachments/u1/c1/attached.txt', 'authoring/code.txt'].map(p => write(p));
    const read = vi.spyOn(fs.promises, 'readFile');
    try {
      const files = await loadWebAssistUploadFiles('u1', 'c1', paths);
      expect(files.map(file => file.path)).toEqual(paths.map(p => fs.realpathSync.native(p)));
      expect(files.map(file => file.name)).toEqual(['work.txt', 'attached.txt', 'code.txt']);
      expect(files.every(file => !('data' in file) && !file.directory)).toBe(true);
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
  it('accepts more than 16 files and more than 50 MiB without a browser quota', async () => {
    const paths = Array.from({ length: 40 }, (_, i) => write(`attachments/u1/c1/large-${i}.txt`, ''));
    fs.truncateSync(paths[0], 60 * 1024 * 1024);
    expect(await loadWebAssistUploadFiles('u1', 'c1', paths)).toHaveLength(40);
    expect(fs.statSync(paths[0]).size).toBe(60 * 1024 * 1024);
  });
  it('supports directories and rejects symlinks escaping the authorized task', async () => {
    const file = write('attachments/u1/c1/tree/sub/file.txt');
    const dir = path.dirname(path.dirname(file));
    expect(await loadWebAssistUploadFiles('u1', 'c1', [dir])).toEqual([{ path: fs.realpathSync.native(dir), name: 'tree', directory: true }]);
    fs.symlinkSync(write('foreign/private.txt'), path.join(dir, 'escape'));
    await expect(loadWebAssistUploadFiles('u1', 'c1', [dir])).rejects.toThrow('upload_outside_task');
  });
  it('rejects foreign tasks, accounts, projects and relative paths', async () => {
    for (const candidate of [write('attachments/u1/c2/foreign.txt'), write('attachments/u2/c1/foreign.txt'), write('workspace/u1/project-other/foreign.txt'), '../relative.txt']) {
      await expect(loadWebAssistUploadFiles('u1', 'c1', [candidate])).rejects.toThrow();
    }
  });
  it('requires external files and directories to enter the task workspace or attachments first', async () => {
    const file = write('external.txt', 'outside task', external);
    for (const candidate of [file, path.dirname(file)]) {
      await expect(loadWebAssistUploadFiles('u1', 'c1', [candidate])).rejects.toThrow('upload_outside_task');
    }
    const attachment = write('attachments/u1/c1/copied.txt', fs.readFileSync(file, 'utf8'));
    expect(await loadWebAssistUploadFiles('u1', 'c1', [attachment])).toHaveLength(1);
  });
  it('rejects cancellation and empty selection before filesystem traversal', async () => {
    await expect(loadWebAssistUploadFiles('u1', 'c1', [])).rejects.toThrow('invalid_upload_files');
    const controller = new AbortController(); controller.abort();
    await expect(loadWebAssistUploadFiles('u1', 'c1', [path.join(root, 'missing')], controller.signal)).rejects.toThrow();
  });
});
