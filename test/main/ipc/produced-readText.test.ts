import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expectTestLog } from '../../helpers/test-log-analysis';
import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

// Mock electron — the IPC router imports `shell` / `dialog` / `ipcMain` at
// module load, none of which are exercised by the readText handler.
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
}));

let tmpDir: string;
let sourceDir: string;
let closeLogWorkers: () => Promise<void>;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-readText-'));
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-readText-external-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  closeLogWorkers = await captureMainLogWorkers();
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  await closeLogWorkers();
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Dispatch through the registered production IPC route so scope and content
// checks cannot silently diverge from the handler the renderer actually uses.
async function callPreviewIpc(userId: string, channel: string, input: Record<string, unknown>, sender = trustedIpcSender()): Promise<any> {
  const users = await import('../../../src/main/features/users');
  users.activateUser(userId);
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const entry = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'orkas.invoke');
  expect(entry).toBeTruthy();
  return entry[1]({ sender }, { channel, payload: input });
}
function callReadText(userId: string, input: { path?: unknown; cid?: unknown; htmlPreviewLayoutOnly?: unknown }) {
  return callPreviewIpc(userId, 'produced.readText', input);
}

describe('produced.readText › scope', () => {
  it('previews an external file without importing it and keeps mutation denied', async () => {
    expectTestLog({ level: 'error', source: 'ipc', message: /^invoke produced\.writeText failed \{$/ });
    expectTestLog({ level: 'error', source: 'ipc', message: /^invoke workspace\.deletePath failed \{$/ });
    const file = path.join(sourceDir, 'outside.md');
    fs.writeFileSync(file, '# External reference');
    await expect(callReadText('reader', { path: file }))
      .resolves.toMatchObject({ ok: true, text: '# External reference' });
    await expect(callPreviewIpc('reader', 'workspace.statPath', { path: file }))
      .resolves.toMatchObject({ ok: true, exists: true, readOnly: true });
    for (const channel of ['produced.writeText', 'workspace.deletePath']) {
      await expect(callPreviewIpc('reader', channel, { path: file, content: 'replacement' }))
        .resolves.toMatchObject({ ok: false, error: 'path is outside the user workspace' });
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('# External reference');
  });

  it('rejects another account attachment even with a matching conversation id', async () => {
    expectTestLog({ level: 'error', source: 'ipc', message: /^invoke produced\.readText failed \{$/ });
    const { chatAttachmentDir } = await import('../../../src/main/paths');
    const cid = 'foreign-conversation';
    const directory = chatAttachmentDir('foreign-user', cid);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'private.txt');
    fs.writeFileSync(file, 'private foreign attachment');
    await expect(callReadText('reader', { path: file, cid }))
      .resolves.toMatchObject({ ok: false, error: 'path is outside the user workspace' });
    expect(fs.readFileSync(file, 'utf8')).toBe('private foreign attachment');
  });

  it('rejects external reads from an untrusted renderer', async () => {
    const file = path.join(sourceDir, 'outside.md');
    fs.writeFileSync(file, 'retained source');
    await expect(callPreviewIpc('reader', 'produced.readText', { path: file }, { getURL: () => 'https://example.com' }))
      .resolves.toMatchObject({ ok: false, code: 'E_IPC_SENDER' });
    expect(fs.readFileSync(file, 'utf8')).toBe('retained source');
  });

  it('reads a markdown file inside the user workspace', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u1', dir);
    const file = path.join(dir, 'note.md');
    fs.writeFileSync(file, '# hi');

    const res = await callReadText('u1', { path: file });
    expect(res.ok).toBe(true);
    expect(res.text).toBe('# hi');
  });

  it('reads a file under the per-cid attachment dir when cid is provided', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const { chatAttachmentDir } = await import('../../../src/main/paths');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u2', dir);

    const cid = 'conv-abc';
    const attachDir = chatAttachmentDir('u2', cid);
    fs.mkdirSync(attachDir, { recursive: true });
    const file = path.join(attachDir, 'doc.txt');
    fs.writeFileSync(file, 'hello attachment');

    const res = await callReadText('u2', { path: file, cid });
    expect(res.ok).toBe(true);
    expect(res.text).toBe('hello attachment');
  });

  it('rejects an attachment-dir path when cid is omitted', async () => {
    expectTestLog({ level: 'error', source: 'ipc', message: /^invoke produced\.readText failed \{$/ });
    // Without cid the scope unions to workspace only. Files in
    // chat_attachments/<cid>/ are not visible — even though the user owns them.
    const ws = await import('../../../src/main/features/user_workspace');
    const { chatAttachmentDir } = await import('../../../src/main/paths');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u3', dir);
    const cid = 'conv-xyz';
    const attachDir = chatAttachmentDir('u3', cid);
    fs.mkdirSync(attachDir, { recursive: true });
    const file = path.join(attachDir, 'doc.txt');
    fs.writeFileSync(file, 'hi');

    const res = await callReadText('u3', { path: file });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside/);
  });

  it('keeps unscoped app-managed files private', async () => {
    expectTestLog({ level: 'error', source: 'ipc', message: /^invoke produced\.readText failed \{$/ });
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u4', dir);
    const outside = path.join(tmpDir, 'elsewhere.txt');
    fs.writeFileSync(outside, 'leak me');

    const res = await callReadText('u4', { path: outside, cid: 'conv-aaa' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside/);
  });

  it('rejects a missing path argument', async () => {
    expectTestLog({ level: 'error', source: 'ipc', message: /^invoke produced\.readText failed \{$/ });
    const res = await callReadText('u5', {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing path/);
  });
});

describe('produced.readText › size cap', () => {
  it('rejects files over the 2 MB cap with too_large + size + cap', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u6', dir);
    const file = path.join(dir, 'big.md');
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 1));

    const res = await callReadText('u6', { path: file });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('too_large');
    expect(res.size).toBe(2 * 1024 * 1024 + 1);
    expect(res.cap).toBe(2 * 1024 * 1024);
  });

  it('accepts files exactly at the cap boundary', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u7', dir);
    const file = path.join(dir, 'edge.md');
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024));

    const res = await callReadText('u7', { path: file });
    expect(res.ok).toBe(true);
  });

  it('finds generic fixed-canvas metadata anywhere in HTML over the full-read cap', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u10', dir);
    const file = path.join(dir, 'large.html');
    fs.writeFileSync(
      file,
      'x'.repeat(2 * 1024 * 1024 + 1)
        + '<main data-preview-layout="fixed-canvas" data-preview-width="1920" data-preview-height="1080">',
    );

    const res = await callReadText('u10', { path: file, htmlPreviewLayoutOnly: true });
    expect(res.ok).toBe(true);
    expect(res.layout).toEqual({ kind: 'fixed-canvas', width: 1920, height: 1080 });
    expect(res.size).toBeGreaterThan(2 * 1024 * 1024);
  });

  it('keeps legacy VideoStudio composition attributes on the shared layout path', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u13', dir);
    const file = path.join(dir, 'video.html');
    fs.writeFileSync(
      file,
      '<main data-height="1080" data-composition-id="main" data-width="1920">',
    );

    const res = await callReadText('u13', { path: file, htmlPreviewLayoutOnly: true });
    expect(res.ok).toBe(true);
    expect(res.layout).toEqual({ kind: 'fixed-canvas', width: 1920, height: 1080 });
  });

  it('normalizes a legacy ImageStudio manifest into the shared HTML canvas layout', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws', 'image-project');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u11', path.join(tmpDir, 'ws'));
    const file = path.join(dir, 'index.html');
    fs.writeFileSync(file, '<!doctype html><main class="poster">Poster</main>');
    fs.writeFileSync(path.join(dir, 'image-manifest.json'), JSON.stringify({
      route: 'COMPOSE',
      canvas: { width: 1600, height: 1600 },
    }));

    const res = await callReadText('u11', { path: file, htmlPreviewLayoutOnly: true });
    expect(res.ok).toBe(true);
    expect(res.layout).toEqual({ kind: 'fixed-canvas', width: 1600, height: 1600 });
  });

  it('does not apply ImageStudio canvas metadata to another HTML entry', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws', 'image-project');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u12', path.join(tmpDir, 'ws'));
    const file = path.join(dir, 'preview.html');
    fs.writeFileSync(file, '<!doctype html><main>Preview</main>');
    fs.writeFileSync(path.join(dir, 'image-manifest.json'), JSON.stringify({
      route: 'COMPOSE',
      entry: 'index.html',
      canvas: { width: 1600, height: 1600 },
    }));

    const res = await callReadText('u12', { path: file, htmlPreviewLayoutOnly: true });
    expect(res.ok).toBe(true);
    expect(res.layout).toBeNull();
  });
});

describe('produced.readText › inferred visual HTML layout', () => {
  it('keeps layout inference bounded on a long brace-free HTML body', async () => {
    const { _inferHtmlPreviewLayoutFromCssForTest } = await import('../../../src/main/ipc/index');
    const html = `<style>main { color: #123456; }</style><main>${'preview '.repeat(32_000)}</main>`;
    const startedAt = performance.now();

    expect(_inferHtmlPreviewLayoutFromCssForTest(html)).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('recognizes the legacy responsive-poster canvas contract', async () => {
    const { _inferHtmlPreviewLayoutFromCssForTest } = await import('../../../src/main/ipc/index');
    const html = `<style>
      html, body { width: 100%; height: 100%; }
      .poster {
        width: 100%; height: 100%;
        max-width: 1080px; max-height: 1350px;
        aspect-ratio: 4 / 5;
      }
    </style>`;

    expect(_inferHtmlPreviewLayoutFromCssForTest(html))
      .toEqual({ kind: 'fixed-canvas', width: 1080, height: 1350 });
  });

  it('accepts fixed pixel dimensions when the declared ratio agrees', async () => {
    const { _inferHtmlPreviewLayoutFromCssForTest } = await import('../../../src/main/ipc/index');
    expect(_inferHtmlPreviewLayoutFromCssForTest(
      '<style>.slide { width: 1920px; height: 1080px; aspect-ratio: 1.7777778; }</style>',
    )).toEqual({ kind: 'fixed-canvas', width: 1920, height: 1080 });
  });

  it.each([
    '<style>.poster { max-width:1080px; max-height:1350px; }</style>',
    '<style>.poster { max-width:1080px; max-height:1350px; aspect-ratio:16/9; }</style>',
    '<style>.poster { max-width:100%; max-height:100%; aspect-ratio:4/5; }</style>',
    '<style>.width { max-width:1080px; aspect-ratio:4/5; } .height { max-height:1350px; }</style>',
  ])('rejects ambiguous or contradictory CSS canvas lookalike', async (html) => {
    const { _inferHtmlPreviewLayoutFromCssForTest } = await import('../../../src/main/ipc/index');
    expect(_inferHtmlPreviewLayoutFromCssForTest(html)).toBeNull();
  });
});

describe('produced.readText › content', () => {
  it('strips a leading UTF-8 BOM so it doesn\'t render as an invisible char', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u8', dir);
    const file = path.join(dir, 'bom.md');
    // ﻿ prepended to typical content.
    fs.writeFileSync(file, '﻿# Title\n');

    const res = await callReadText('u8', { path: file });
    expect(res.ok).toBe(true);
    expect(res.text?.charCodeAt(0)).not.toBe(0xFEFF);
    expect(res.text).toBe('# Title\n');
  });

  it('returns not_found for a directory path even inside the workspace', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u9', dir);
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);

    const res = await callReadText('u9', { path: sub });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_found');
  });
});
