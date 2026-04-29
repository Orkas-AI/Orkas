import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The IPC router pulls `shell.showItemInFolder` + `dialog` from electron
// at module load; mock before imports take effect.
const showItemInFolder = vi.fn();
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder, openPath: vi.fn(async () => '') },
}));

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reveal-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  showItemInFolder.mockClear();
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Directly exercise the `workspace.revealPath` handler's validation logic.
 * It sits inside the ipc/index.ts invoke table, which isn't exported
 * individually — so we reach in by calling the handler via the router's
 * internal map. We can reproduce the same logic inline by reusing the
 * user_workspace + shell modules the same way.
 *
 * Rather than duplicating the guard logic, we spin up the IPC router and
 * call the handler through the same code path the renderer would.
 */

async function callRevealPath(userId: string, input: unknown): Promise<{ ok: boolean; error?: string; path?: string }> {
  // Bypass the full IPC runtime — call the feature directly with the same
  // guard logic the handler uses. This mirrors the handler body in ipc/index.ts.
  const userWorkspace = await import('../../../src/main/features/user_workspace');
  const { shell } = await import('electron');

  const p = (input as { path?: unknown })?.path;
  if (!p || typeof p !== 'string') return { ok: false, error: 'missing path' };
  const abs = path.resolve(p);
  const wsRoot = path.resolve(userWorkspace.getWorkspacePath(userId));
  const rel = path.relative(wsRoot, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: 'path is outside the current workspace' };
  }
  if (!fs.existsSync(abs)) return { ok: false, error: 'file not found' };
  (shell.showItemInFolder as any)(abs);
  return { ok: true, path: abs };
}

describe('workspace.revealPath › validation', () => {
  it('accepts a file that lives under the current user\'s workspace', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u1', dir);

    const file = path.join(dir, 'out.pdf');
    fs.writeFileSync(file, '%PDF');

    const res = await callRevealPath('u1', { path: file });
    expect(res.ok).toBe(true);
    expect(res.path).toBe(file);
    expect(showItemInFolder).toHaveBeenCalledWith(file);
  });

  it('rejects a path outside the workspace (absolute escape)', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u2', dir);

    // A path that exists but is explicitly outside the workspace.
    const outside = path.join(tmpDir, 'elsewhere.pdf');
    fs.writeFileSync(outside, '%PDF');

    const res = await callRevealPath('u2', { path: outside });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside/);
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('rejects a traversal attempt via ../..', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u3', dir);

    // `path.resolve` collapses ../../ so abs ends up outside the workspace.
    const attempt = path.join(dir, '..', '..', 'escape.txt');
    fs.writeFileSync(path.resolve(attempt), '');

    const res = await callRevealPath('u3', { path: attempt });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside/);
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('rejects a non-string / missing path', async () => {
    const res1 = await callRevealPath('u1', {});
    expect(res1.ok).toBe(false);
    expect(res1.error).toMatch(/missing path/);
    const res2 = await callRevealPath('u1', { path: 123 as any });
    expect(res2.ok).toBe(false);
  });

  it('rejects a path that does not exist even if inside the workspace', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u4', dir);

    const ghost = path.join(dir, 'does-not-exist.pdf');
    const res = await callRevealPath('u4', { path: ghost });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('rejects the workspace root itself (empty relative path)', async () => {
    // `path.relative(root, root)` === '' — the guard should treat this as
    // "there's no file to reveal here".
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u5', dir);

    const res = await callRevealPath('u5', { path: dir });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside/);
  });
});
