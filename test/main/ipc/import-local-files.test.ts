import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { expectTestLog } from '../../helpers/test-log-analysis';
import * as fs from 'node:fs';
import mutableFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import { makeMinimalPdf } from '../../fixtures/make-minimal-pdf';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';
import { makeMinimalXlsx, makeMinimalPptx } from '../../fixtures/make-minimal-office';
import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';

const { ipcDiagnostics } = vi.hoisted(() => ({ ipcDiagnostics: vi.fn() }));
function captureIpcDiagnostics() {
  // Recreate after resetModules: retaining importOriginal's old logger would
  // retain a delivery worker already closed by the preceding case.
  vi.doMock('../../../src/main/logger', async importOriginal => {
    const actual = await importOriginal<typeof import('../../../src/main/logger')>();
    return { ...actual, createLogger: (scope: string) => {
      const logger = actual.createLogger(scope);
      if (scope !== 'ipc') return logger;
      return { ...logger,
        warn: (...args: Parameters<typeof logger.warn>) => { ipcDiagnostics('warn', ...args); logger.warn(...args); },
        error: (...args: Parameters<typeof logger.error>) => { ipcDiagnostics('error', ...args); logger.error(...args); },
      };
    } };
  });
}

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
  captureIpcDiagnostics();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  await closeLogWorkers();
  vi.doUnmock('../../../src/main/logger');
  vi.restoreAllMocks();
  syncBuiltinESMExports();
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
  it.each(['bytes', 'internal', 'picker', 'drop'])('retains destination errno on the %s route and keeps diagnostics private', async route => {
    const abs = sourceFile('PRIVATE_SELECTED.txt', 'selected bytes');
    const electron = await import('electron') as any;
    const mkdir = mutableFs.mkdirSync;
    const fault = vi.spyOn(mutableFs, 'mkdirSync').mockImplementation(((target: any, ...args: any[]) => {
      if (String(target) === attachmentDir()) throw Object.assign(new Error('PRIVATE_DESTINATION'), { code: 'ENOSPC' });
      return (mkdir as any)(target, ...args);
    }) as any);
    syncBuiltinESMExports();
    const add = () => {
      if (route === 'picker') electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [abs] });
      return route === 'drop'
      ? importLocalFiles({ scope: 'conversation', cid: CID, entries: [{ index: 0, path: abs, name: path.basename(abs) }] })
      : invoke(route === 'bytes' ? 'conversations.attachments.upload' : route === 'picker' ? 'conversations.attachments.pickAndUpload' : 'conversations.attachments.import',
        route === 'bytes' ? { cid: CID, name: path.basename(abs), data: Buffer.from('selected bytes').toString('base64') } : { cid: CID, path: abs });
    };
    if (route === 'bytes' || route === 'internal') expectTestLog({ level: 'error', source: 'ipc', message: /^invoke conversations\.attachments\.(?:upload|import) failed/ });
    const result = await add();
    const failure = route === 'drop' ? result.files[0] : route === 'picker' ? result.failed[0] : result;
    expect(failure).toMatchObject({ failure_kind: 'disk_full' });
    if (route !== 'picker') expect(failure.ok).toBe(false);
    expect(fs.existsSync(attachmentDir())).toBe(false);
    const records = ipcDiagnostics.mock.calls;
    expect(records).toHaveLength(1);
    expect(records[0][2]).toMatchObject({ failure_kind: 'disk_full' });
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_SELECTED|PRIVATE_DESTINATION|\.txt|ENOSPC:/);
    fault.mockRestore(); syncBuiltinESMExports();
    const recovered = await add();
    expect(route === 'drop' ? recovered.files[0].ok : route === 'picker' ? recovered.failed.length === 0 : recovered.ok).toBe(true);
    expect(fs.readFileSync(path.join(attachmentDir(), 'PRIVATE_SELECTED.txt'), 'utf8')).toBe('selected bytes');
  });

  it.each(['picker', 'drop'])('logs one bounded private-safe diagnostic for a mixed %s batch, with dedupe', async route => {
    const good = sourceFile('PRIVATE_GOOD.txt', 'complete');
    const missing = path.join(sourceDir, 'PRIVATE_MISSING.txt');
    const unsupported = sourceFile('PRIVATE_UNSUPPORTED.exe', 'unsupported');
    const add = async () => {
      if (route === 'drop') return importLocalFiles({ scope: 'conversation', cid: CID, entries: [good, missing, unsupported].map((p, index) => ({ index, path: p, name: path.basename(p) })) });
      const electron = await import('electron') as any;
      electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [good, missing, unsupported] });
      return invoke('conversations.attachments.pickAndUpload', { cid: CID });
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await add();
      if (route === 'drop') expect(result.files.map((r: any) => r.ok)).toEqual([true, false, false]);
      else { expect(result.items).toHaveLength(1); expect(result.failed).toHaveLength(2); }
    }
    expect(ipcDiagnostics.mock.calls).toEqual([['warn', 'invoke returned failure', {
      channel: route === 'drop' ? 'orkas.importLocalFiles' : 'conversations.attachments.pickAndUpload',
      code: 'mixed', failure_kind: 'mixed', failed_count: 2,
    }]]);
    expect(JSON.stringify(ipcDiagnostics.mock.calls)).not.toContain('PRIVATE_');
    expect(fs.readFileSync(path.join(attachmentDir(), 'PRIVATE_GOOD.txt'), 'utf8')).toBe('complete');
  });

  it('retains a copy-specific code and does not suppress a different errno category', async () => {
    const abs = sourceFile('PRIVATE_COPY.txt', 'complete source');
    const copy = vi.spyOn(fs.promises, 'copyFile');
    const add = () => invoke('conversations.attachments.import', { cid: CID, path: abs });
    for (const code of ['EACCES', 'EACCES', 'ENOSPC']) {
      copy.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_COPY_ERROR'), { code }));
      expect(await add()).toMatchObject({ ok: false, error_code: 'copy_failed', failure_kind: code === 'ENOSPC' ? 'disk_full' : 'permission_denied' });
    }
    expect(ipcDiagnostics.mock.calls).toEqual(['permission_denied', 'disk_full'].map(failure_kind => ['warn', 'invoke returned failure', {
      channel: 'conversations.attachments.import', code: 'copy_failed', failure_kind,
    }]));
    expect(JSON.stringify(ipcDiagnostics.mock.calls)).not.toContain('PRIVATE_');
    copy.mockRestore();
    expect(await add()).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(attachmentDir(), 'PRIVATE_COPY.txt'), 'utf8')).toBe('complete source');
  });

  it.each([
    ['mp3', 'audio'], ['wav', 'audio'], ['png', 'image'],
    ['txt', 'text'], ['pdf', 'pdf'], ['docx', 'docx'], ['xlsx', 'spreadsheet'],
    ['pptx', 'presentation'], ['zip', 'archive'], ['mp4', 'video'],
  ])('copies an unrecorded external %s file and reuses its pending attachment on repeat', async (ext, kind) => {
    // The two rejected reads/deletes of the original path are asserted below.
    expectTestLog({ level: 'error', source: 'ipc', message: /^invoke produced\.readText failed \{ error: 'path is outside the user workspace'/ });
    expectTestLog({ level: 'error', source: 'ipc', message: /^invoke workspace\.deletePath failed \{ error: 'path/ });
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
    // Each invalid path is asserted to resolve { ok: false } below.
    expectTestLog({ level: 'error', source: 'ipc', message: new RegExp(`^invoke ${channel.replace(/\./g, '\\.')} failed \\{`) });
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
    // Both rejections are asserted with their error before the corrected retry.
    expectTestLog({ level: 'error', source: 'ipc', message: /^invoke autoTasks\.attachments\.import failed \{ error: 'file not found'/ });
    expectTestLog({ level: 'error', source: 'ipc', message: /^invoke autoTasks\.attachments\.import failed \{ error: 'unsupported/ });
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
    expect(viaBytes).toMatchObject({ error_code: 'file_too_large' });
    expect(viaPath.files).toEqual([expect.objectContaining({
      index: 0, ok: false, error: (viaBytes as { error: string }).error, error_code: 'file_too_large',
    })]);
    const viaMenu = await invoke('conversations.attachments.import', { cid: CID, path: abs });
    expect(viaMenu).toMatchObject({ ok: false, error: (viaBytes as { error: string }).error, error_code: 'file_too_large' });
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [abs] });
    await expect(invoke('conversations.attachments.pickAndUpload', { cid: CID }))
      .resolves.toMatchObject({ items: [], failed: [{ name: 'skills.zip', error: (viaBytes as { error: string }).error, error_code: 'file_too_large' }] });
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
