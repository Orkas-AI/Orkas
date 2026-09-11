import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

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
let prevWs: string | undefined;
const TEST_UID = 'uImportLocalFiles';
const CID = 'conv-import-local';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-import-local-files-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
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

function sourceFile(name: string, content: Buffer | string): string {
  const dir = path.join(tmpDir, 'desktop');
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, content);
  return abs;
}

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
    expect(fs.existsSync(path.join(attachmentDir(), 'skills.zip'))).toBe(false);
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
