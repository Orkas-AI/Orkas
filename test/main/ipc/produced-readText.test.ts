import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Mock electron — the IPC router imports `shell` / `dialog` / `ipcMain` at
// module load, none of which are exercised by the readText handler.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
}));

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-readText-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The IPC table in ipc/index.ts isn't exported per-handler, so — same
// pattern as workspace-reveal.test.ts — reproduce the handler body
// inline using the same modules the real handler imports. If the source
// drifts the test must drift with it; the unit-test triage explicitly
// covers this kind of multi-branch decision function (CLAUDE.md §9).
async function callReadText(
  userId: string,
  input: { path?: unknown; cid?: unknown; htmlPreviewLayoutOnly?: unknown },
): Promise<{
  ok: boolean;
  error?: string;
  size?: number;
  cap?: number;
  text?: string;
  layout?: { kind: 'fixed-canvas'; width: number; height: number } | null;
}> {
  const userWorkspace = await import('../../../src/main/features/user_workspace');
  const { chatAttachmentDir } = await import('../../../src/main/paths');
  const { safeId } = await import('../../../src/main/storage');
  const { isPathAllowed } = await import('../../../src/main/util/path-sandbox');

  const target = input?.path;
  if (typeof target !== 'string' || !target) return { ok: false, error: 'missing path' };
  const ws = userWorkspace.getWorkspacePath(userId);
  const norm = path.resolve(target);
  const cidRaw = input?.cid;
  const attachmentScope = (typeof cidRaw === 'string' && cidRaw && safeId(cidRaw))
    ? path.resolve(chatAttachmentDir(userId, cidRaw))
    : null;
  // Mirrors `ipc/index.ts::produced.readText`: delegate the symlink-safe
  // sandbox check to `util/path-sandbox.isPathAllowed`. Drift here = drift
  // from the real handler.
  const allowedRoots: string[] = [path.resolve(ws)];
  if (attachmentScope) allowedRoots.push(attachmentScope);
  if (!isPathAllowed(norm, allowedRoots)) {
    return { ok: false, error: 'path is outside the user workspace' };
  }
  let st: fs.Stats;
  try { st = fs.statSync(norm); }
  catch { return { ok: false, error: 'not_found' }; }
  if (!st.isFile()) return { ok: false, error: 'not_found' };
  const MAX_TEXT_BYTES = 2 * 1024 * 1024;
  const htmlPreviewLayoutOnly = input?.htmlPreviewLayoutOnly === true;
  if (!htmlPreviewLayoutOnly && st.size > MAX_TEXT_BYTES) {
    return { ok: false, error: 'too_large', size: st.size, cap: MAX_TEXT_BYTES };
  }
  if (htmlPreviewLayoutOnly) {
    const stream = fs.createReadStream(norm, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const rootPattern = /<[^>]*\b(?:data-preview-layout\s*=\s*["']fixed-canvas["']|data-composition-id\s*=\s*["'][^"']+["'])[^>]*>/i;
    let carry = '';
    let layout: { kind: 'fixed-canvas'; width: number; height: number } | null = null;
    const validLayout = (widthValue: unknown, heightValue: unknown) => {
      const width = Number(widthValue);
      const height = Number(heightValue);
      if (!Number.isInteger(width) || !Number.isInteger(height)
          || width < 16 || width > 7680 || height < 16 || height > 7680
          || width * height > 16_777_216) return null;
      return { kind: 'fixed-canvas' as const, width, height };
    };
    try {
      for await (const chunk of stream) {
        const combined = carry + String(chunk);
        const match = combined.match(rootPattern);
        if (match) {
          const attrNumber = (name: string) => {
            const attr = match[0].match(new RegExp(`\\b${name}\\s*=\\s*["'](\\d+(?:\\.\\d+)?)["']`, 'i'));
            return attr ? Number(attr[1]) : 0;
          };
          layout = validLayout(
            attrNumber('data-preview-width') || attrNumber('data-width'),
            attrNumber('data-preview-height') || attrNumber('data-height'),
          );
          break;
        }
        const lastOpen = combined.lastIndexOf('<');
        carry = lastOpen >= 0 ? combined.slice(lastOpen) : '';
        if (carry.length > 64 * 1024) carry = '';
      }
    } finally {
      if (!stream.closed) {
        await new Promise<void>((resolve) => {
          stream.once('close', resolve);
          stream.destroy();
        });
      }
    }
    if (!layout) {
      const projectDir = path.dirname(norm);
      const manifestPath = path.join(projectDir, 'image-manifest.json');
      try {
        const manifestStat = fs.lstatSync(manifestPath);
        if (manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.size <= 256 * 1024) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          const entry = typeof manifest.entry === 'string' && manifest.entry.trim()
            ? manifest.entry.trim()
            : 'index.html';
          const entryAbs = path.resolve(projectDir, entry);
          const width = Number(manifest.canvas?.width);
          const height = Number(manifest.canvas?.height);
          if (isPathAllowed(entryAbs, [projectDir])
              && entryAbs === norm) {
            layout = validLayout(width, height);
          }
        }
      } catch { /* no valid ImageStudio manifest */ }
    }
    return { ok: true, layout, size: st.size };
  }
  let text = fs.readFileSync(norm, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return { ok: true, text, size: st.size };
}

describe('produced.readText › scope', () => {
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

  it('rejects a path outside the workspace AND outside the attachment dir', async () => {
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
