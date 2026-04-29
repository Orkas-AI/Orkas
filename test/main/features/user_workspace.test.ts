import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ws-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Electron's `dialog` and `BrowserWindow` are not available in unit tests,
// so we mock them. The pure config read/write + validation logic is what
// matters here.
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
  },
  shell: {
    openPath: vi.fn(async (_: string) => ''),
  },
}));

// Pin i18n to zh so existing assertions on Chinese error substrings stay
// stable. i18n's module-level state is per-isolate; vi.resetModules() in
// beforeEach clears it, so we re-pin inside each test via a helper.
async function _pinZh() {
  const i18n = await import('../../../src/main/i18n');
  i18n.setCurrentLang('zh');
}

describe('user_workspace › getWorkspacePath', () => {
  it('returns default when no selection has been made', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const p = await import('../../../src/main/paths');
    const result = ws.getWorkspacePath('user123');
    expect(result).toBe(p.DEFAULT_USER_WORKSPACE);
  });

  it('returns selected path after setWorkspacePath', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    // Create a real directory to select
    const dir = path.join(tmpDir, 'my-workspace');
    fs.mkdirSync(dir, { recursive: true });

    const setResult = ws.setWorkspacePath('user123', dir);
    expect(setResult.ok).toBe(true);
    if (setResult.ok) expect(setResult.path).toBe(dir);

    const result = ws.getWorkspacePath('user123');
    expect(result).toBe(dir);
  });

  it('falls back to default when selected path no longer exists', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const p = await import('../../../src/main/paths');

    // Create and select a directory, then remove it
    const dir = path.join(tmpDir, 'gone-workspace');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('user123', dir);
    fs.rmSync(dir, { recursive: true, force: true });

    const result = ws.getWorkspacePath('user123');
    expect(result).toBe(p.DEFAULT_USER_WORKSPACE);
  });
});

describe('user_workspace › setWorkspacePath', () => {
  it('rejects a non-existent path', async () => {
    await _pinZh();
    const ws = await import('../../../src/main/features/user_workspace');
    const result = ws.setWorkspacePath('user123', '/no/such/path');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('不存在');
  });

  it('rejects a file (not a directory)', async () => {
    await _pinZh();
    const ws = await import('../../../src/main/features/user_workspace');
    const file = path.join(tmpDir, 'not-a-dir.txt');
    fs.writeFileSync(file, 'hello');
    const result = ws.setWorkspacePath('user123', file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('不是目录');
  });

  it('accepts a valid directory path', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir = path.join(tmpDir, 'valid-ws');
    fs.mkdirSync(dir, { recursive: true });
    const result = ws.setWorkspacePath('user123', dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(dir);
  });
});

describe('user_workspace › resetWorkspacePath', () => {
  it('resets to default after a custom selection', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const p = await import('../../../src/main/paths');

    const dir = path.join(tmpDir, 'custom-ws');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('user123', dir);
    expect(ws.getWorkspacePath('user123')).toBe(dir);

    const result = ws.resetWorkspacePath('user123');
    expect(result.ok).toBe(true);
    expect(result.path).toBe(p.DEFAULT_USER_WORKSPACE);
    expect(ws.getWorkspacePath('user123')).toBe(p.DEFAULT_USER_WORKSPACE);
  });
});

describe('user_workspace › per-user isolation', () => {
  it('different users have independent workspace paths', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const p = await import('../../../src/main/paths');

    const dir1 = path.join(tmpDir, 'ws-a');
    const dir2 = path.join(tmpDir, 'ws-b');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    ws.setWorkspacePath('userA', dir1);
    ws.setWorkspacePath('userB', dir2);

    expect(ws.getWorkspacePath('userA')).toBe(dir1);
    expect(ws.getWorkspacePath('userB')).toBe(dir2);
  });
});

describe('user_workspace › selectDirectory (mocked)', () => {
  it('returns null when dialog is cancelled', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const result = await ws.selectDirectory();
    expect(result).toBeNull();
  });

  it('returns the selected path from dialog', async () => {
    const { dialog } = await import('electron');
    const dir = path.join(tmpDir, 'picked');
    fs.mkdirSync(dir, { recursive: true });
    (dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePaths: [dir],
    });

    const ws = await import('../../../src/main/features/user_workspace');
    const result = await ws.selectDirectory();
    expect(result).toBe(dir);
  });
});

describe('user_workspace › openWorkspaceInFileManager', () => {
  it('invokes shell.openPath with the current workspace directory', async () => {
    const { shell } = await import('electron');
    (shell.openPath as ReturnType<typeof vi.fn>).mockClear();
    const ws = await import('../../../src/main/features/user_workspace');

    const dir = path.join(tmpDir, 'to-open');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('userOpen', dir);

    const result = await ws.openWorkspaceInFileManager('userOpen');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(dir);
    expect(shell.openPath).toHaveBeenCalledWith(dir);
  });

  it('propagates shell.openPath error string', async () => {
    const { shell } = await import('electron');
    (shell.openPath as ReturnType<typeof vi.fn>).mockResolvedValueOnce('boom');
    const ws = await import('../../../src/main/features/user_workspace');

    const dir = path.join(tmpDir, 'err-open');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('userErr', dir);

    const result = await ws.openWorkspaceInFileManager('userErr');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('boom');
  });

  it('refuses to open when the workspace directory is gone (falls back to default)', async () => {
    // When selection vanishes, getWorkspacePath falls back to default —
    // and the default is guaranteed to exist by paths.ensureLayout; verify
    // the call still succeeds and targets the default dir, not the missing one.
    const { shell } = await import('electron');
    (shell.openPath as ReturnType<typeof vi.fn>).mockClear();
    const ws = await import('../../../src/main/features/user_workspace');
    const p = await import('../../../src/main/paths');

    const dir = path.join(tmpDir, 'transient');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('userGone', dir);
    fs.rmSync(dir, { recursive: true, force: true });

    // Make sure default actually exists for this assertion to be meaningful.
    fs.mkdirSync(p.DEFAULT_USER_WORKSPACE, { recursive: true });

    const result = await ws.openWorkspaceInFileManager('userGone');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(p.DEFAULT_USER_WORKSPACE);
    expect(shell.openPath).toHaveBeenCalledWith(p.DEFAULT_USER_WORKSPACE);
  });
});
