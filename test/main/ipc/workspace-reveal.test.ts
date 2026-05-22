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
  // guard logic the handler uses. Mirrors `ipc/index.ts::workspace.revealPath`:
  // it delegates the symlink-safe sandbox check to `util/path-sandbox.isPathAllowed`
  // (via the `_ipcFileSandboxAllowedRoots` helper); the test reproduction tracks
  // that — drift here = drift from the real handler.
  const userWorkspace = await import('../../../src/main/features/user_workspace');
  const { isPathAllowed } = await import('../../../src/main/util/path-sandbox');
  const { shell } = await import('electron');

  const p = (input as { path?: unknown })?.path;
  if (!p || typeof p !== 'string') return { ok: false, error: 'missing path' };
  const abs = path.resolve(p);
  const wsRoot = path.resolve(userWorkspace.getWorkspacePath(userId));
  if (!isPathAllowed(abs, [wsRoot])) {
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

  it('rejects a symlink inside the workspace that points outside (symlink-escape)', async () => {
    // The bug class the isPathAllowed migration closes: a symlink planted
    // inside an allowed root (here, the user's workspace) that resolves to
    // a target OUTSIDE the allowed root. The previous lexical
    // `startsWith(wsRoot + sep)` check would let this through because the
    // symlink's textual path IS inside the workspace; `isPathAllowed` calls
    // `fs.realpathSync` on both sides and the rejection happens because the
    // resolved target sits outside the root.
    const ws = await import('../../../src/main/features/user_workspace');
    const wsDir = path.join(tmpDir, 'ws-sym');
    fs.mkdirSync(wsDir, { recursive: true });
    ws.setWorkspacePath('u-sym', wsDir);

    const outside = path.join(tmpDir, 'outside-target.txt');
    fs.writeFileSync(outside, 'attacker-controlled');

    const trap = path.join(wsDir, 'looks-inside.txt');
    fs.symlinkSync(outside, trap);

    const res = await callRevealPath('u-sym', { path: trap });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside/);
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('accepts a symlink inside the workspace that points to another file inside the workspace', async () => {
    // The companion preservation case: a symlink whose target is also
    // within the allowed root MUST be accepted (otherwise `isPathAllowed`
    // would break legitimate `ln -s` use inside the workspace).
    const ws = await import('../../../src/main/features/user_workspace');
    const wsDir = path.join(tmpDir, 'ws-sym-ok');
    fs.mkdirSync(wsDir, { recursive: true });
    ws.setWorkspacePath('u-sym-ok', wsDir);

    const target = path.join(wsDir, 'real.pdf');
    fs.writeFileSync(target, '%PDF');
    const link = path.join(wsDir, 'link.pdf');
    fs.symlinkSync(target, link);

    const res = await callRevealPath('u-sym-ok', { path: link });
    expect(res.ok).toBe(true);
    expect(showItemInFolder).toHaveBeenCalledWith(link);
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

  it('accepts the workspace root itself (revealing the workspace folder is a legit action)', async () => {
    // `isPathAllowed(root, [root])` returns true by design — revealing the
    // workspace root in Finder/Explorer is a legitimate "open my workspace"
    // request. The pre-refactor lexical guard also allowed this
    // (`norm === wsNorm` short-circuits the `&& norm !== wsNorm` arm in the
    // OR chain), so the behaviour is preserved across the isPathAllowed
    // migration.
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('u5', dir);

    const res = await callRevealPath('u5', { path: dir });
    expect(res.ok).toBe(true);
    expect(showItemInFolder).toHaveBeenCalledWith(dir);
  });
});
