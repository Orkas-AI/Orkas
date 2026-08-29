import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const nodeRequire = createRequire(import.meta.url);

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
let prevHome: string | undefined;
let prevGuard: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ws-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevHome = process.env.HOME;
  prevGuard = process.env.ORKAS_TCC_GUARD_FORCE;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  delete process.env.ORKAS_TCC_GUARD_FORCE;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevGuard === undefined) delete process.env.ORKAS_TCC_GUARD_FORCE;
  else process.env.ORKAS_TCC_GUARD_FORCE = prevGuard;
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

function _recordSensitiveFsCalls(sensitiveRoot: string): {
  calls: string[];
  restore(): void;
} {
  const mutableFs = nodeRequire('node:fs') as Record<string, any>;
  const root = path.resolve(sensitiveRoot);
  const calls: string[] = [];
  const originals = new Map<string, (...args: any[]) => any>();
  const promiseOriginals = new Map<string, (...args: any[]) => any>();
  const operationNames = [
    'accessSync',
    'existsSync',
    'lstatSync',
    'openSync',
    'opendirSync',
    'readFileSync',
    'readdirSync',
    'realpathSync',
    'statSync',
  ];

  const resolveTarget = (value: unknown): string => {
    try {
      if (typeof value === 'string') return path.resolve(value);
      if (Buffer.isBuffer(value)) return path.resolve(value.toString());
      if (value instanceof URL && value.protocol === 'file:') return path.resolve(fileURLToPath(value));
    } catch { /* malformed inputs are not relevant to this probe */ }
    return '';
  };
  const record = (operation: string, value: unknown): void => {
    const target = resolveTarget(value);
    if (!target) return;
    const rel = path.relative(root, target);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
      calls.push(`${operation}:${rel || '.'}`);
    }
  };

  for (const name of operationNames) {
    const original = mutableFs[name];
    if (typeof original !== 'function') continue;
    originals.set(name, original);
    mutableFs[name] = function sensitiveFsProbe(this: unknown, ...args: any[]) {
      record(name, args[0]);
      return Reflect.apply(original, this, args);
    };
  }
  for (const name of ['access', 'lstat', 'open', 'opendir', 'readFile', 'readdir', 'realpath', 'stat']) {
    const original = mutableFs.promises?.[name];
    if (typeof original !== 'function') continue;
    promiseOriginals.set(name, original);
    mutableFs.promises[name] = function sensitivePromiseFsProbe(this: unknown, ...args: any[]) {
      record(`promises.${name}`, args[0]);
      return Reflect.apply(original, this, args);
    };
  }
  const wrappedRealpath = mutableFs.realpathSync;
  const originalRealpathNative = originals.get('realpathSync')?.native;
  if (typeof originalRealpathNative === 'function') {
    wrappedRealpath.native = function sensitiveNativeRealpathProbe(this: unknown, ...args: any[]) {
      record('realpathSync.native', args[0]);
      return Reflect.apply(originalRealpathNative, this, args);
    };
  }
  syncBuiltinESMExports();

  return {
    calls,
    restore() {
      for (const [name, original] of originals) mutableFs[name] = original;
      for (const [name, original] of promiseOriginals) mutableFs.promises[name] = original;
      if (typeof originalRealpathNative === 'function') {
        mutableFs.realpathSync.native = originalRealpathNative;
      }
      syncBuiltinESMExports();
    },
  };
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

  it.runIf(process.platform === 'darwin')('persists user-selected macOS privacy-protected workspace roots without probing them again', async () => {
    process.env.ORKAS_TCC_GUARD_FORCE = '1';
    const home = path.join(tmpDir, 'fake-home');
    const protectedRoots = [
      home,
      path.join(home, 'Downloads'),
      path.join(home, 'Downloads', 'project'),
      path.join(home, 'Documents'),
      path.join(home, 'Pictures'),
      path.join(home, 'Desktop'),
      path.join(home, 'Desktop', 'project'),
      path.join(home, 'Movies'),
      path.join(home, 'Music'),
      path.join(home, 'Library', 'Containers', 'com.apple.mail'),
    ];
    protectedRoots.forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
    process.env.HOME = home;
    const ws = await import('../../../src/main/features/user_workspace');
    const p = await import('../../../src/main/paths');

    for (const [idx, protectedRoot] of protectedRoots.entries()) {
      const userId = `userProtected${idx}`;
      const result = ws.setWorkspacePath(userId, protectedRoot);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.path).toBe(protectedRoot);
      expect(ws.getWorkspacePath(userId)).toBe(protectedRoot);
      const info = ws.getWorkspaceInfo(userId);
      expect(info.currentPath).toBe(protectedRoot);
      expect(info.defaultPath).toBe(p.DEFAULT_USER_WORKSPACE);
      expect(info.isDefault).toBe(false);

      const cfgFile = path.join(tmpDir, userId, 'local', 'workspace.json');
      const persisted = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
      expect(persisted.default.macosTccSensitive).toBe(true);
    }

    const downloads = path.join(home, 'Downloads');
    fs.rmSync(downloads, { recursive: true, force: true });
    expect(ws.getWorkspacePath('userProtected1')).toBe(downloads);
  });

  it.runIf(process.platform === 'darwin')('classifies a selected symlink alias into a protected macOS root once and keeps the user-facing path', async () => {
    process.env.ORKAS_TCC_GUARD_FORCE = '1';
    const home = path.join(tmpDir, 'fake-home');
    const desktopProject = path.join(home, 'Desktop', 'project');
    const alias = path.join(tmpDir, 'apparently-safe-workspace');
    fs.mkdirSync(desktopProject, { recursive: true });
    fs.symlinkSync(desktopProject, alias, 'dir');
    process.env.HOME = home;
    const ws = await import('../../../src/main/features/user_workspace');

    const result = ws.setWorkspacePath('userSymlinkProtected', alias);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(alias);
    const cfgFile = path.join(tmpDir, 'userSymlinkProtected', 'local', 'workspace.json');
    const persisted = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    expect(persisted.default.macosTccSensitive).toBe(true);
    fs.rmSync(alias);
    expect(ws.getWorkspacePath('userSymlinkProtected')).toBe(alias);
  });

  it.runIf(process.platform !== 'win32')('accepts a symlink to an ordinary project without rewriting the selected path', async () => {
    process.env.ORKAS_TCC_GUARD_FORCE = '1';
    const target = path.join(tmpDir, 'projects', 'ordinary');
    const alias = path.join(tmpDir, 'ordinary-workspace-alias');
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, alias, 'dir');
    const ws = await import('../../../src/main/features/user_workspace');

    const result = ws.setWorkspacePath('userSafeSymlink', alias);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(alias);
    expect(ws.getWorkspacePath('userSafeSymlink')).toBe(alias);
  });

  it('allows ordinary project directories under the home folder', async () => {
    process.env.ORKAS_TCC_GUARD_FORCE = '1';
    const home = path.join(tmpDir, 'fake-home');
    const projectDir = path.join(home, 'Projects', 'app');
    fs.mkdirSync(projectDir, { recursive: true });
    process.env.HOME = home;
    const ws = await import('../../../src/main/features/user_workspace');

    const result = ws.setWorkspacePath('userProjectDir', projectDir);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(projectDir);
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

  it('seeds the directory picker with the safe default workspace', async () => {
    const { dialog } = await import('electron');
    (dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockClear();
    const ws = await import('../../../src/main/features/user_workspace');
    const p = await import('../../../src/main/paths');

    await ws.selectDirectory();

    const opts = (dialog.showOpenDialog as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(opts?.defaultPath).toBe(p.DEFAULT_USER_WORKSPACE);
    expect(fs.existsSync(p.DEFAULT_USER_WORKSPACE)).toBe(true);
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

  it.runIf(process.platform === 'darwin')('persists a protected directory returned by the native picker', async () => {
    process.env.ORKAS_TCC_GUARD_FORCE = '1';
    const home = path.join(tmpDir, 'fake-home');
    const downloads = path.join(home, 'Downloads');
    fs.mkdirSync(downloads, { recursive: true });
    process.env.HOME = home;
    const { dialog } = await import('electron');
    (dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePaths: [downloads],
    });
    const ws = await import('../../../src/main/features/user_workspace');
    const p = await import('../../../src/main/paths');

    const selected = await ws.selectDirectory();
    expect(selected).toBe(downloads);
    const result = ws.setWorkspacePath('userPickerProtected', selected!);

    expect(result.ok).toBe(true);
    expect(ws.getWorkspacePath('userPickerProtected')).toBe(downloads);
    expect(ws.consumePickerFirstOpenDefault('userPickerProtected')).toBe(p.DEFAULT_USER_WORKSPACE);
  });

  it.runIf(process.platform === 'darwin')('does not issue prompt-triggering filesystem probes after selecting or restoring a protected workspace', async () => {
    process.env.ORKAS_TCC_GUARD_FORCE = '1';
    const home = path.join(tmpDir, 'fake-home');
    const documents = path.join(home, 'Documents', 'active-project');
    fs.mkdirSync(documents, { recursive: true });
    process.env.HOME = home;
    vi.resetModules();
    const { dialog } = await import('electron');
    (dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePaths: [documents],
    });
    const probe = _recordSensitiveFsCalls(path.join(home, 'Documents'));

    try {
      const ws = await import('../../../src/main/features/user_workspace');
      const p = await import('../../../src/main/paths');
      const selected = await ws.selectDirectory();

      expect(selected).toBe(documents);
      expect(ws.setWorkspacePath('userNoTccPrompt', selected!).ok).toBe(true);
      expect(ws.getWorkspacePath('userNoTccPrompt')).toBe(documents);
      expect(ws.getWorkspaceInfo('userNoTccPrompt')).toMatchObject({
        currentPath: documents,
        isDefault: false,
      });
      expect(ws.consumePickerFirstOpenDefault('userNoTccPrompt')).toBe(p.DEFAULT_USER_WORKSPACE);
      expect(ws.sweepEmptyConvDirs('userNoTccPrompt')).toEqual({ swept: 0 });

      // Reload the feature module to model a fresh app process reading the
      // persisted workspace classification. Passive boot/UI reads must still
      // avoid the selected TCC root.
      vi.resetModules();
      const relaunched = await import('../../../src/main/features/user_workspace');
      expect(relaunched.getWorkspacePath('userNoTccPrompt')).toBe(documents);
      expect(relaunched.getWorkspaceInfo('userNoTccPrompt').currentPath).toBe(documents);
      expect(relaunched.consumePickerFirstOpenDefault('userNoTccPrompt')).toBe(p.DEFAULT_USER_WORKSPACE);

      expect(probe.calls).toEqual([]);
    } finally {
      probe.restore();
    }
  });

  it.runIf(process.platform === 'darwin')('fails the TCC probe oracle when sensitive filesystem access occurs', async () => {
    const documents = path.join(tmpDir, 'fake-home', 'Documents', 'negative-control');
    fs.mkdirSync(documents, { recursive: true });
    const probe = _recordSensitiveFsCalls(documents);
    try {
      fs.statSync(documents);
      fs.realpathSync.native(documents);
      await fs.promises.stat(documents);
      expect(probe.calls).toEqual([
        'statSync:.',
        'realpathSync.native:.',
        'promises.stat:.',
      ]);
    } finally {
      probe.restore();
    }
  });
});

// ── Scoped workspace (default vs per-project) — added with the projects
//    feature. workspace.json moved from flat
//    `{selectedPath, recentPaths, updatedAt}` → scoped
//    `{default:{...}, projects:{<pid>:{...}}, updatedAt}`. Legacy flat is
//    promoted into `default` on first read; project scope falls back to
//    default when not set; deleting a project must remove its bucket.
describe('user_workspace › scoped (projects)', () => {
  it('legacy flat config is promoted into `default` on first read', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const cfgFile = path.join(tmpDir, 'userMig', 'local', 'workspace.json');
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    const dir = path.join(tmpDir, 'legacy-ws');
    fs.mkdirSync(dir, { recursive: true });
    // Hand-craft a legacy flat shape (pre-projects schema).
    fs.writeFileSync(cfgFile, JSON.stringify({
      selectedPath: dir,
      updatedAt: '2026-01-01T00:00:00',
      recentPaths: [],
    }));
    // Default scope must read the promoted value back.
    expect(ws.getWorkspacePath('userMig')).toBe(dir);
    // Trigger a write so the file is rewritten in scoped shape, then
    // assert the on-disk schema upgraded.
    const dir2 = path.join(tmpDir, 'legacy-ws2');
    fs.mkdirSync(dir2, { recursive: true });
    const r = ws.setWorkspacePath('userMig', dir2);
    expect(r.ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    expect(after.default.selectedPath).toBe(dir2);
    // Legacy `selectedPath` at the root is gone — value lives under
    // `default` now.
    expect(after.selectedPath).toBeUndefined();
    expect(after.projects).toEqual({});
  });

  it('project scope falls through to default when no project selection is set', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const defaultDir = path.join(tmpDir, 'def-ws');
    fs.mkdirSync(defaultDir, { recursive: true });
    ws.setWorkspacePath('userScope', defaultDir);
    // No call yet for projectId='p_aaaa1111' → effective path is the
    // default selection (which itself falls through to DEFAULT_USER_WORKSPACE
    // only when default is also unset).
    expect(ws.getWorkspacePath('userScope', 'p_aaaa1111')).toBe(defaultDir);
  });

  it('project scope wins over default when explicitly set', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const defaultDir = path.join(tmpDir, 'def');
    const projDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });

    ws.setWorkspacePath('userScope2', defaultDir);
    ws.setWorkspacePath('userScope2', projDir, 'p_b0b0');

    expect(ws.getWorkspacePath('userScope2')).toBe(defaultDir);
    expect(ws.getWorkspacePath('userScope2', 'p_b0b0')).toBe(projDir);
  });

  it('per-scope recents are independent', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const defA = path.join(tmpDir, 'defA');
    const defB = path.join(tmpDir, 'defB');
    const projA = path.join(tmpDir, 'projA');
    const projB = path.join(tmpDir, 'projB');
    [defA, defB, projA, projB].forEach((d) => fs.mkdirSync(d, { recursive: true }));

    ws.setWorkspacePath('userR', defA);
    ws.setWorkspacePath('userR', defB);                 // defA → default.recents
    ws.setWorkspacePath('userR', projA, 'p_recents');
    ws.setWorkspacePath('userR', projB, 'p_recents');   // projA → projects[p_recents].recents

    const defInfo = ws.getWorkspaceInfo('userR');
    const projInfo = ws.getWorkspaceInfo('userR', 'p_recents');
    expect(defInfo.recentPaths).toContain(defA);
    expect(defInfo.recentPaths).not.toContain(projA);
    expect(projInfo.recentPaths).toContain(projA);
    expect(projInfo.recentPaths).not.toContain(defA);
  });

  it('getWorkspaceInfo does not stat recent paths while rendering the chip', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const cfgFile = path.join(tmpDir, 'userProtected', 'local', 'workspace.json');
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    const protectedRecent = path.join(tmpDir, 'missing-protected-recent');
    fs.writeFileSync(cfgFile, JSON.stringify({
      selectedPath: '',
      updatedAt: '2026-06-03T00:00:00.000Z',
      recentPaths: [protectedRecent],
    }));

    const info = ws.getWorkspaceInfo('userProtected');
    expect(fs.existsSync(protectedRecent)).toBe(false);
    expect(info.recentPaths).toContain(protectedRecent);
  });

  it.runIf(process.platform === 'darwin')('restores a legacy protected selectedPath without statting it', async () => {
    process.env.ORKAS_TCC_GUARD_FORCE = '1';
    const home = path.join(tmpDir, 'fake-home');
    const desktop = path.join(home, 'Desktop');
    fs.mkdirSync(desktop, { recursive: true });
    process.env.HOME = home;
    const ws = await import('../../../src/main/features/user_workspace');
    const p = await import('../../../src/main/paths');
    const cfgFile = path.join(tmpDir, 'userLegacyProtected', 'local', 'workspace.json');
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify({
      selectedPath: desktop,
      updatedAt: '2026-06-03T00:00:00.000Z',
      recentPaths: [path.join(home, 'Downloads')],
    }));
    fs.rmSync(desktop, { recursive: true, force: true });

    expect(ws.getWorkspacePath('userLegacyProtected')).toBe(desktop);
    const info = ws.getWorkspaceInfo('userLegacyProtected');
    expect(info.currentPath).toBe(desktop);
    expect(info.defaultPath).toBe(p.DEFAULT_USER_WORKSPACE);
    expect(info.isDefault).toBe(false);
    expect(info.recentPaths).toEqual([]);
    const migrated = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    expect(migrated.default.macosTccSensitive).toBe(true);
  });

  it.runIf(process.platform === 'darwin')('restores a legacy symlink that resolves into a protected workspace root', async () => {
    process.env.ORKAS_TCC_GUARD_FORCE = '1';
    const home = path.join(tmpDir, 'fake-home');
    const downloadsProject = path.join(home, 'Downloads', 'legacy-project');
    const alias = path.join(tmpDir, 'legacy-protected-alias');
    fs.mkdirSync(downloadsProject, { recursive: true });
    fs.symlinkSync(downloadsProject, alias, 'dir');
    process.env.HOME = home;
    const ws = await import('../../../src/main/features/user_workspace');
    const cfgFile = path.join(tmpDir, 'userLegacySymlink', 'local', 'workspace.json');
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify({
      selectedPath: alias,
      updatedAt: '2026-08-24T00:00:00.000Z',
      recentPaths: [],
    }));

    expect(ws.getWorkspacePath('userLegacySymlink')).toBe(alias);
    const migrated = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    expect(migrated.default.macosTccSensitive).toBe(true);
  });

  it('reset on project scope falls through to default; default scope intact', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const defaultDir = path.join(tmpDir, 'reset-def');
    const projDir = path.join(tmpDir, 'reset-proj');
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });

    ws.setWorkspacePath('userReset', defaultDir);
    ws.setWorkspacePath('userReset', projDir, 'p_reset0');
    expect(ws.getWorkspacePath('userReset', 'p_reset0')).toBe(projDir);

    ws.resetWorkspacePath('userReset', 'p_reset0');
    // Project scope now falls through to default.
    expect(ws.getWorkspacePath('userReset', 'p_reset0')).toBe(defaultDir);
    // Default scope unchanged.
    expect(ws.getWorkspacePath('userReset')).toBe(defaultDir);
  });

  it('getWorkspaceInfo returns scope=project when projectId given, default otherwise', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const defInfo = ws.getWorkspaceInfo('userS');
    expect(defInfo.scope).toBe('default');
    expect(defInfo.projectId).toBeUndefined();
    const projInfo = ws.getWorkspaceInfo('userS', 'p_scope1');
    expect(projInfo.scope).toBe('project');
    expect(projInfo.projectId).toBe('p_scope1');
  });

  it('purgeProjectWorkspace removes only that project bucket', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const dir1 = path.join(tmpDir, 'pwA');
    const dir2 = path.join(tmpDir, 'pwB');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    ws.setWorkspacePath('userPurge', dir1, 'p_keep');
    ws.setWorkspacePath('userPurge', dir2, 'p_drop');

    ws.purgeProjectWorkspace('userPurge', 'p_drop');

    expect(ws.getWorkspacePath('userPurge', 'p_keep')).toBe(dir1);
    // p_drop's bucket gone — falls through to default (which is unset →
    // DEFAULT_USER_WORKSPACE).
    const p = await import('../../../src/main/paths');
    expect(ws.getWorkspacePath('userPurge', 'p_drop')).toBe(p.DEFAULT_USER_WORKSPACE);
  });
});

describe('user_workspace › sweepEmptyConvDirs', () => {
  it('skips user-selected external workspace roots on boot cleanup', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const cfgFile = path.join(tmpDir, 'userSweep', 'local', 'workspace.json');
    const external = path.join(tmpDir, 'external-workspace');
    const externalEmpty = path.join(external, 'empty-turn-dir');
    const managed = path.join(tmpDir, '..', 'userWorkSpace');
    const managedEmpty = path.join(managed, 'empty-turn-dir');
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.mkdirSync(externalEmpty, { recursive: true });
    fs.mkdirSync(managedEmpty, { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify({
      selectedPath: external,
      updatedAt: '2026-06-03T00:00:00.000Z',
      recentPaths: [],
    }));

    const result = ws.sweepEmptyConvDirs('userSweep');

    expect(result.swept).toBe(1);
    expect(fs.existsSync(externalEmpty)).toBe(true);
    expect(fs.existsSync(managedEmpty)).toBe(false);
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
    if (result.ok) {
      expect(result.path).toBe(dir);
      expect(result.fallbackUsed).toBeUndefined();
      expect(result.fallbackReason).toBeUndefined();
    }
    expect(shell.openPath).toHaveBeenCalledWith(dir);
  });

  it('does not mark normal project inheritance as a fallback', async () => {
    const { shell } = await import('electron');
    (shell.openPath as ReturnType<typeof vi.fn>).mockClear();
    const ws = await import('../../../src/main/features/user_workspace');

    const dir = path.join(tmpDir, 'inherited-default');
    fs.mkdirSync(dir, { recursive: true });
    ws.setWorkspacePath('userInherited', dir);

    const result = await ws.openWorkspaceInFileManager('userInherited', 'p_inherit');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(dir);
      expect(result.fallbackUsed).toBeUndefined();
      expect(result.fallbackReason).toBeUndefined();
    }
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

  it.runIf(process.platform === 'darwin')('opens a user-selected protected workspace without a preflight filesystem probe', async () => {
    process.env.ORKAS_TCC_GUARD_FORCE = '1';
    const home = path.join(tmpDir, 'fake-home');
    const downloads = path.join(home, 'Downloads', 'active-workspace');
    fs.mkdirSync(downloads, { recursive: true });
    process.env.HOME = home;
    vi.resetModules();
    const { shell } = await import('electron');
    (shell.openPath as ReturnType<typeof vi.fn>).mockClear();
    const probe = _recordSensitiveFsCalls(path.join(home, 'Downloads'));

    try {
      const ws = await import('../../../src/main/features/user_workspace');
      expect(ws.setWorkspacePath('userOpenProtected', downloads).ok).toBe(true);

      const result = await ws.openWorkspaceInFileManager('userOpenProtected');

      expect(result).toEqual({ ok: true, path: downloads });
      expect(shell.openPath).toHaveBeenCalledWith(downloads);
      expect(probe.calls).toEqual([]);
    } finally {
      probe.restore();
    }
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
    if (result.ok) {
      expect(result.path).toBe(p.DEFAULT_USER_WORKSPACE);
      expect(result.fallbackUsed).toBe(true);
      expect(result.fallbackReason).toBe('selected_unavailable');
    }
    expect(shell.openPath).toHaveBeenCalledWith(p.DEFAULT_USER_WORKSPACE);
  });

  it('marks an unavailable project selection when opening its valid default fallback', async () => {
    const { shell } = await import('electron');
    (shell.openPath as ReturnType<typeof vi.fn>).mockClear();
    const ws = await import('../../../src/main/features/user_workspace');

    const defaultDir = path.join(tmpDir, 'project-fallback-default');
    const projectDir = path.join(tmpDir, 'project-fallback-gone');
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    ws.setWorkspacePath('userProjectGone', defaultDir);
    ws.setWorkspacePath('userProjectGone', projectDir, 'p_gone');
    fs.rmSync(projectDir, { recursive: true, force: true });

    const result = await ws.openWorkspaceInFileManager('userProjectGone', 'p_gone');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(defaultDir);
      expect(result.fallbackUsed).toBe(true);
      expect(result.fallbackReason).toBe('selected_unavailable');
    }
    expect(shell.openPath).toHaveBeenCalledWith(defaultDir);
  });
});

describe('user_workspace › consumePickerFirstOpenDefault', () => {
  it('returns the safe workspace on every open', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const p = await import('../../../src/main/paths');
    const uid = 'userFirstOpen';

    expect(ws.consumePickerFirstOpenDefault(uid)).toBe(p.DEFAULT_USER_WORKSPACE);
    expect(fs.existsSync(p.pickerFirstOpenMarkerFile(uid))).toBe(false);
    expect(ws.consumePickerFirstOpenDefault(uid)).toBe(p.DEFAULT_USER_WORKSPACE);
    expect(ws.consumePickerFirstOpenDefault(uid)).toBe(p.DEFAULT_USER_WORKSPACE);
  });

  it('does not consume another user by reading one user', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    const p = await import('../../../src/main/paths');
    expect(ws.consumePickerFirstOpenDefault('userA')).toBe(p.DEFAULT_USER_WORKSPACE);
    expect(ws.consumePickerFirstOpenDefault('userB')).toBe(p.DEFAULT_USER_WORKSPACE);
    expect(ws.consumePickerFirstOpenDefault('userA')).toBe(p.DEFAULT_USER_WORKSPACE);
  });

  it('returns undefined for an empty userId', async () => {
    const ws = await import('../../../src/main/features/user_workspace');
    expect(ws.consumePickerFirstOpenDefault('')).toBeUndefined();
  });
});
