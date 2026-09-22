import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import { makeMinimalPdf } from '../../fixtures/make-minimal-pdf';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';
import { makeMinimalXlsx, makeMinimalPptx } from '../../fixtures/make-minimal-office';
import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';

// `orkas.importLocalFiles` is the private preload → main channel that carries
// paths resolved from genuine user-selected File objects. The conversation
// scope (S9-2) copies composer drops / pastes by path so their bytes never
// cross IPC as base64; it must apply the same per-kind caps and dedupe as the
// base64 `conversations.attachments.upload` route.

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true),
  },
}));

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: vi.fn(),
  kbEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock('../../../src/main/features/search', () => ({
  upsertContext: vi.fn(),
  dropContext: vi.fn(),
}));

vi.mock('../../../src/main/features/kb_vector', () => ({
  findBySha1: vi.fn(() => null),
}));

let tmpDir: string;
let sourceDir: string;
let prevWs: string | undefined;
let closeLogWorkers: () => Promise<void>;
const TEST_UID = 'uImportLocalFiles';
const CID = 'conv-import-local';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-import-local-files-'));
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-external-selection-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  closeLogWorkers = await captureMainLogWorkers();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  await closeLogWorkers();
  vi.restoreAllMocks();
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function attachmentDir(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'chat_attachments', CID);
}

async function importLocalFiles(request: unknown, sender: unknown = trustedIpcSender()): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const call = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'orkas.importLocalFiles');
  expect(call).toBeTruthy();
  return call[1]({ sender }, request);
}

function sourceFile(name: string, content: Buffer | string, folder = 'desktop'): string {
  const dir = path.join(sourceDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, content);
  return abs;
}

async function invoke(channel: string, payload: unknown, sender: unknown = trustedIpcSender()): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const handler = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'orkas.invoke');
  return handler[1]({ sender }, { channel, payload });
}

describe('add a user-selected local file to conversation attachments', () => {
  it.each([
    ['mp3', 'audio'], ['wav', 'audio'], ['png', 'image'],
    ['txt', 'text'], ['pdf', 'pdf'], ['docx', 'docx'], ['xlsx', 'spreadsheet'],
    ['pptx', 'presentation'], ['zip', 'archive'], ['mp4', 'video'],
  ])('copies an unrecorded external %s file and reuses its pending attachment on repeat', async (ext, kind) => {
    const fixtures: Record<string, Buffer> = {
      pdf: makeMinimalPdf(['Selected document']), docx: makeMinimalDocx({ paragraphs: ['Selected document'] }),
      xlsx: makeMinimalXlsx(), pptx: makeMinimalPptx(),
    };
    // Other media are opaque at import time; decoding belongs to preview tests.
    const content = fixtures[ext] || Buffer.from('user-selected file bytes');
    const abs = sourceFile(`preview.${ext}`, content);
    const result = await invoke('conversations.attachments.import', { cid: CID, path: abs });
    expect(result).toMatchObject({ ok: true, info: { name: `preview.${ext}`, kind } });
    expect(fs.readFileSync(path.join(attachmentDir(), result.info.name))).toEqual(content);
    expect(fs.readFileSync(abs)).toEqual(content);
    await expect(invoke('conversations.attachments.import', { cid: CID, path: abs }))
      .resolves.toMatchObject({ ok: true, reused: true, info: { name: result.info.name } });
    // Import copies bytes; it does not grant access to the original directory.
    await expect(invoke('produced.readText', { cid: CID, path: abs })).resolves.toMatchObject({ ok: false });
    await expect(invoke('workspace.deletePath', { cid: CID, path: abs })).resolves.toMatchObject({ ok: false });
    expect(fs.readFileSync(abs)).toEqual(content);
  });

  it('rejects unsupported files, directories, missing and oversized audio and allows retry when the file returns', async () => {
    const unsupported = sourceFile('unsupported.exe', 'unsupported file');
    const directory = path.join(path.dirname(unsupported), 'folder.mp3');
    fs.mkdirSync(directory);
    const oversized = sourceFile('oversized.mp3', '');
    fs.truncateSync(oversized, 50 * 1024 * 1024 + 1);
    const missing = path.join(path.dirname(unsupported), 'missing.mp3');
    for (const target of [unsupported, directory, oversized, missing]) {
      const result = await invoke('conversations.attachments.import', { cid: CID, path: target, name: 'audio.mp3' });
      expect(result).toMatchObject({ ok: false });
      expect(result.error).toBeTruthy();
    }
    expect(fs.existsSync(attachmentDir())).toBe(false);
    fs.writeFileSync(missing, 'available again');
    await expect(invoke('conversations.attachments.import', { cid: CID, path: missing }))
      .resolves.toMatchObject({ ok: true, info: { kind: 'audio' } });
  });
});

describe('external attachment lifecycle and entry-point parity', () => {
  it('keeps an imported temporary file readable after its source is changed and removed', async () => {
    const content = 'selected version';
    const abs = sourceFile('记录 #1 %.txt', content, 'new temporary folder/中文 path');
    const result = await invoke('conversations.attachments.import', { cid: CID, path: abs });
    expect(result).toMatchObject({ ok: true, info: { name: '记录 #1 %.txt' } });
    fs.writeFileSync(abs, 'later version');
    expect(fs.readFileSync(path.join(attachmentDir(), result.info.name), 'utf8')).toBe(content);
    fs.unlinkSync(abs);
    // Reload through the public attachment list; the source is no longer needed.
    await expect(invoke('conversations.attachments.list', { cid: CID }))
      .resolves.toMatchObject({ items: [{ name: result.info.name, bytes: Buffer.byteLength(content) }] });
    const { resolveAttachmentAbsPath } = await import('../../../src/main/features/chat_attachments');
    const resolved = resolveAttachmentAbsPath(TEST_UID, CID, result.info.name);
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) throw new Error('imported attachment must remain readable');
    expect(fs.readFileSync(resolved.absPath, 'utf8')).toBe(content);
  });

  it('imports a selected file through an external directory link', async () => {
    const content = 'linked document';
    const abs = sourceFile('brief.txt', content, 'downloads');
    const alias = path.join(sourceDir, 'linked downloads');
    fs.symlinkSync(path.dirname(abs), alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(invoke('conversations.attachments.import', { cid: CID, path: path.join(alias, 'brief.txt') }))
      .resolves.toMatchObject({ ok: true, info: { name: 'brief.txt' } });
    expect(fs.readFileSync(path.join(attachmentDir(), 'brief.txt'), 'utf8')).toBe(content);
    expect(fs.readFileSync(abs, 'utf8')).toBe(content);
  });

  it('reuses one pending attachment across menu, picker, drop and clipboard byte upload', async () => {
    const content = 'same selected content';
    const abs = sourceFile('brief.txt', content, 'downloads');
    const first = await invoke('conversations.attachments.import', { cid: CID, path: abs });
    expect(first).toMatchObject({ ok: true, info: { name: 'brief.txt' } });
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [abs] });
    await expect(invoke('conversations.attachments.pickAndUpload', { cid: CID }))
      .resolves.toMatchObject({ cancelled: false, failed: [], items: [{ reused: true, info: { name: 'brief.txt' } }] });
    await expect(importLocalFiles({ scope: 'conversation', cid: CID, entries: [{ index: 4, path: abs, name: 'renamed.txt' }] }))
      .resolves.toMatchObject({ files: [{ index: 4, ok: true, reused: true, info: { name: 'brief.txt' } }] });
    await expect(invoke('conversations.attachments.upload', { cid: CID, name: 'clipboard.txt', data: Buffer.from(content).toString('base64') }))
      .resolves.toMatchObject({ ok: true, reused: true, info: { name: 'brief.txt' } });
    await expect(invoke('conversations.attachments.list', { cid: CID }))
      .resolves.toMatchObject({ items: [{ name: 'brief.txt' }] });
    expect(fs.readdirSync(attachmentDir()).filter(name => !name.startsWith('.'))).toEqual(['brief.txt']);
  });

  it.each(['picker', 'drop'])('retains successful files from a mixed %s batch and lets the failed file be retried', async route => {
    const first = sourceFile('first.txt', 'first');
    const missing = path.join(sourceDir, 'desktop', 'missing.txt');
    const last = sourceFile('last.txt', 'last');
    const { dialog } = await import('electron');
    async function add(paths: string[]) {
      if (route === 'picker') {
        vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: paths });
        const result = await invoke('conversations.attachments.pickAndUpload', { cid: CID });
        return { good: result.items.map((item: any) => item.info.name), failed: result.failed };
      }
      const result = await importLocalFiles({ scope: 'conversation', cid: CID, entries: paths.map((abs, index) => ({ index, path: abs, name: path.basename(abs) })) });
      expect(result.files.map((item: any) => item.index)).toEqual(paths.map((_, index) => index));
      return { good: result.files.filter((item: any) => item.ok).map((item: any) => item.info.name), failed: result.files.filter((item: any) => !item.ok) };
    }
    const result = await add([first, missing, last]);
    expect(result.good).toEqual(['first.txt', 'last.txt']);
    expect(result.failed).toMatchObject([{ name: 'missing.txt', error: 'file not found' }]);
    expect(fs.readdirSync(attachmentDir()).filter(name => !name.startsWith('.')).sort()).toEqual(['first.txt', 'last.txt']);
    fs.writeFileSync(missing, 'recovered');
    expect(await add([missing])).toEqual({ good: ['missing.txt'], failed: [] });
    for (const [name, content] of [['first.txt', 'first'], ['last.txt', 'last'], ['missing.txt', 'recovered']]) {
      expect(fs.readFileSync(path.join(attachmentDir(), name), 'utf8')).toBe(content);
    }
  });

  it('reports a copy failure without leaving an attachment and succeeds on retry', async () => {
    const abs = sourceFile('retry.txt', 'recoverable copy');
    const copy = vi.spyOn(fs.promises, 'copyFile').mockRejectedValueOnce(Object.assign(new Error('copy unavailable'), { code: 'EACCES' }));
    await expect(invoke('conversations.attachments.import', { cid: CID, path: abs }))
      .resolves.toMatchObject({ ok: false, error: 'copy unavailable' });
    expect(fs.existsSync(path.join(attachmentDir(), 'retry.txt'))).toBe(false);
    await expect(invoke('conversations.attachments.list', { cid: CID })).resolves.toEqual({ ok: true, items: [] });
    expect(fs.readFileSync(abs, 'utf8')).toBe('recoverable copy');
    copy.mockRestore();
    await expect(invoke('conversations.attachments.import', { cid: CID, path: abs }))
      .resolves.toMatchObject({ ok: true, info: { name: 'retry.txt' } });
    expect(fs.readFileSync(path.join(attachmentDir(), 'retry.txt'), 'utf8')).toBe('recoverable copy');
  });

  it('preserves two different files with the same name and scopes dedupe to the target conversation', async () => {
    const a = sourceFile('same.txt', 'first body', 'downloads');
    const b = sourceFile('same.txt', 'second body', 'temporary');
    const first = await invoke('conversations.attachments.import', { cid: CID, path: a });
    const second = await invoke('conversations.attachments.import', { cid: CID, path: b });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.info.name).not.toBe(first.info.name);
    expect(fs.readFileSync(path.join(attachmentDir(), first.info.name), 'utf8')).toBe('first body');
    expect(fs.readFileSync(path.join(attachmentDir(), second.info.name), 'utf8')).toBe('second body');
    const otherCid = 'other-conversation';
    const other = await invoke('conversations.attachments.import', { cid: otherCid, path: a });
    expect(other).toMatchObject({ ok: true, info: { name: 'same.txt' } });
    expect(other.reused).not.toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, TEST_UID, 'cloud', 'chat_attachments', otherCid, 'same.txt'), 'utf8')).toBe('first body');
  });

  it.each([
    ['conversations.attachments.pickAndUpload', { cid: CID }],
    ['autoTasks.attachments.pickAndUpload', { taskId: 'at_12345678' }],
  ])('treats cancellation of %s as no attachment change', async (channel, target) => {
    await expect(invoke(channel, target)).resolves.toEqual({ ok: true, cancelled: true, items: [], failed: [] });
    expect(fs.existsSync(attachmentDir())).toBe(false);
    const { autoTaskAttachmentsDir } = await import('../../../src/main/paths');
    expect(fs.existsSync(autoTaskAttachmentsDir(TEST_UID, 'at_12345678'))).toBe(false);
  });
});

describe('manual attachment import boundaries', () => {
  it.each([
    ['conversations.attachments.import', { cid: CID }],
    ['autoTasks.attachments.import', { taskId: 'at_12345678' }],
  ])('rejects invalid paths and untrusted senders for %s without copying files', async (channel, target) => {
    const abs = sourceFile('note.md', '# note\n');
    for (const invalidPath of ['', 'desktop/note.md', abs + '\0']) {
      await expect(invoke(channel, { ...target, path: invalidPath })).resolves.toMatchObject({ ok: false });
    }
    await expect(invoke(channel, { ...target, path: abs }, { getURL: () => 'https://example.invalid/index.html' }))
      .resolves.toMatchObject({ ok: false, code: 'E_IPC_SENDER' });
    expect(fs.existsSync(attachmentDir())).toBe(false);
    const { autoTaskAttachmentsDir } = await import('../../../src/main/paths');
    expect(fs.existsSync(autoTaskAttachmentsDir(TEST_UID, 'at_12345678'))).toBe(false);
  });

  it('reports missing and unsupported scheduled-task selections and allows a corrected retry', async () => {
    const taskId = 'at_12345678';
    const abs = sourceFile('brief.txt', 'restored source', 'downloads');
    const unsupported = sourceFile('program.exe', 'unsupported');
    const { autoTaskAttachmentsDir } = await import('../../../src/main/paths');
    fs.unlinkSync(abs);
    for (const [target, error] of [[abs, 'file not found'], [unsupported, 'unsupported_format']]) {
      await expect(invoke('autoTasks.attachments.import', { taskId, path: target }))
        .resolves.toMatchObject({ ok: false, error });
      expect(fs.existsSync(autoTaskAttachmentsDir(TEST_UID, taskId))).toBe(false);
    }
    fs.writeFileSync(abs, 'restored source');
    await expect(invoke('autoTasks.attachments.import', { taskId, path: abs })).resolves.toMatchObject({ name: 'brief.txt' });
    expect(fs.readFileSync(path.join(autoTaskAttachmentsDir(TEST_UID, taskId), 'brief.txt'), 'utf8')).toBe('restored source');
  });

  it('copies an external document into a scheduled-task draft while preserving the source', async () => {
    const content = 'user-selected brief';
    const abs = sourceFile('brief.txt', content);
    const taskId = 'at_12345678';
    const { autoTaskAttachmentsDir } = await import('../../../src/main/paths');
    await expect(invoke('autoTasks.attachments.import', { taskId, path: abs }))
      .resolves.toMatchObject({ name: 'brief.txt' });
    expect(fs.readFileSync(path.join(autoTaskAttachmentsDir(TEST_UID, taskId), 'brief.txt'), 'utf8')).toBe(content);
    expect(fs.readFileSync(abs, 'utf8')).toBe(content);
  });
});

describe('orkas.importLocalFiles › conversation scope', () => {
  it('copies a dropped OS file into the conversation pool by path and echoes the chip index and hash', async () => {
    const content = 'id,value\n1,2\n';
    const abs = sourceFile('report.csv', content);

    const res = await importLocalFiles({
      scope: 'conversation',
      cid: CID,
      entries: [{ index: 3, path: abs, name: 'report.csv', size: content.length }],
    });

    expect(res).toMatchObject({
      ok: true,
      files: [{
        index: 3,
        name: 'report.csv',
        ok: true,
        info: { name: 'report.csv', kind: 'text', bytes: content.length },
        sha256: createHash('sha256').update(content).digest('hex'),
      }],
    });
    expect(fs.readFileSync(path.join(attachmentDir(), 'report.csv'), 'utf8')).toBe(content);
    // The reply never carries the source path back to the renderer.
    expect(JSON.stringify(res)).not.toContain(abs);
  });

  it('reuses the pending attachment when the same bytes arrive by path after a byte upload', async () => {
    const attachments = await import('../../../src/main/features/chat_attachments');
    const content = Buffer.from('duplicate body');
    await expect(attachments.uploadAttachment(TEST_UID, CID, 'first.txt', content))
      .resolves.toMatchObject({ ok: true });
    const abs = sourceFile('second.txt', content);

    const res = await importLocalFiles({
      scope: 'conversation',
      cid: CID,
      entries: [{ index: 0, path: abs, name: 'second.txt', size: content.length }],
    });

    expect(res.files).toEqual([expect.objectContaining({
      index: 0, ok: true, reused: true, info: expect.objectContaining({ name: 'first.txt' }),
    })]);
    expect(fs.existsSync(path.join(attachmentDir(), 'second.txt'))).toBe(false);
  });

  it('enforces the same per-kind cap as the byte upload with the same user-facing reason', async () => {
    const attachments = await import('../../../src/main/features/chat_attachments');
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
    const abs = sourceFile('skills.zip', oversized);

    const viaBytes = await attachments.uploadAttachment(TEST_UID, CID, 'skills.zip', oversized);
    const viaPath = await importLocalFiles({
      scope: 'conversation',
      cid: CID,
      entries: [{ index: 0, path: abs, name: 'skills.zip', size: oversized.length }],
    });

    expect(viaBytes.ok).toBe(false);
    expect(viaPath.files).toEqual([expect.objectContaining({
      index: 0, ok: false, error: (viaBytes as { error: string }).error,
    })]);
    const viaMenu = await invoke('conversations.attachments.import', { cid: CID, path: abs });
    expect(viaMenu).toMatchObject({ ok: false, error: (viaBytes as { error: string }).error });
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [abs] });
    await expect(invoke('conversations.attachments.pickAndUpload', { cid: CID }))
      .resolves.toMatchObject({ items: [], failed: [{ name: 'skills.zip', error: (viaBytes as { error: string }).error }] });
    expect(fs.existsSync(path.join(attachmentDir(), 'skills.zip'))).toBe(false);
    // The exact supported limit succeeds; this catches an off-by-one rejection.
    fs.truncateSync(abs, 8 * 1024 * 1024);
    await expect(invoke('conversations.attachments.import', { cid: CID, path: abs }))
      .resolves.toMatchObject({ ok: true, info: { name: 'skills.zip', bytes: 8 * 1024 * 1024 } });
    const storedHash = createHash('sha256').update(fs.readFileSync(path.join(attachmentDir(), 'skills.zip'))).digest('hex');
    expect(storedHash).toBe(createHash('sha256').update(oversized.subarray(0, 8 * 1024 * 1024)).digest('hex'));
  });

  it('rejects an invalid cid, an unknown scope, and a non-absolute path without touching the pool', async () => {
    const abs = sourceFile('note.md', '# note\n');

    await expect(importLocalFiles({
      scope: 'conversation',
      cid: '../escape',
      entries: [{ index: 0, path: abs, name: 'note.md', size: 7 }],
    })).resolves.toMatchObject({ ok: false });
    await expect(importLocalFiles({
      scope: 'attachments',
      cid: CID,
      entries: [{ index: 0, path: abs, name: 'note.md', size: 7 }],
    })).resolves.toMatchObject({ ok: false });
    await expect(importLocalFiles({
      scope: 'conversation',
      cid: CID,
      entries: [{ index: 0, path: 'desktop/note.md', name: 'note.md', size: 7 }],
    })).resolves.toEqual({ ok: true, files: [] });

    expect(fs.existsSync(attachmentDir())).toBe(false);
  });

  it('refuses the channel from an untrusted renderer', async () => {
    const abs = sourceFile('note.md', '# note\n');

    const res = await importLocalFiles({
      scope: 'conversation',
      cid: CID,
      entries: [{ index: 0, path: abs, name: 'note.md', size: 7 }],
    }, { getURL: () => 'https://example.invalid/index.html' });

    expect(res).toMatchObject({ ok: false, code: 'E_IPC_SENDER' });
    expect(fs.existsSync(attachmentDir())).toBe(false);
  });
});
