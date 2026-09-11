import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

let root: string;
let previous: string | undefined;
const uid = 'directory-account';
const cid = 'directory-conversation';
function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-directory-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('device-owned CLI directory', () => {
  it.each(['session', 'agent-setting'])('preserves a legacy choice proven by %s, even while its drive is unavailable', async (proof) => {
    const paths = await import('../../../../src/main/paths');
    const dir = path.join(root, 'temporarily-offline');
    if (proof === 'session') write(paths.localCliSessionsFile(uid, cid), {
      a: { cli: 'codex', sessionId: 'local-session', cwdFingerprint: crypto.createHash('sha256').update(dir).digest('hex') },
    });
    else write(paths.userAgentRuntimeConfigFile(uid), { version: 2, project_dirs: { a: { path: dir } } });
    const m = await import('../../../../src/main/features/local_agents/project-directory');
    expect(m.readCodingDirectory(uid, cid, { coding_project_dir: dir, coding_project_dir_explicit: true }))
      .toEqual({ coding_project_dir: dir, coding_project_dir_explicit: true });
    // Restart and a newer remote path must not change the migrated selection.
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/local_agents/project-directory');
    expect(restarted.readCodingDirectory(uid, cid, { coding_project_dir: path.join(root, 'other-device') }).coding_project_dir).toBe(dir);
    fs.mkdirSync(dir);
    expect(restarted.inspectCodingDirectory(dir).kind).toBe('available');
  });

  it('requires confirmation for unproven legacy paths even if they exist, and remembers explicit clearing', async () => {
    const m = await import('../../../../src/main/features/local_agents/project-directory');
    const legacy = { coding_project_dir: root, coding_project_dir_explicit: true };
    expect(m.readCodingDirectory(uid, cid, legacy)).toEqual({ coding_project_dir_pending: root });
    m.writeCodingDirectory(uid, cid, root, true);
    expect(m.readCodingDirectory(uid, cid).coding_project_dir).toBe(root);
    m.writeCodingDirectory(uid, cid, '', false);
    expect(m.readCodingDirectory(uid, cid, legacy)).toEqual({});
  });

  it('fails closed on unreadable local state without replacing the selection from cloud', async () => {
    const paths = await import('../../../../src/main/paths');
    const file = paths.localCliDirectoryFile(uid, cid);
    write(file, { version: 99, directory: root, explicit: true });
    const before = fs.readFileSync(file, 'utf8');
    const m = await import('../../../../src/main/features/local_agents/project-directory');
    expect(() => m.readCodingDirectory(uid, cid, { coding_project_dir: root })).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps the local selection through cloud replacement, state mutations and restart', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(uid);
    const paths = await import('../../../../src/main/paths');
    const state = await import('../../../../src/main/features/group_chat/state');
    await state.setCodingProjectDir(uid, cid, root, { explicit: true });
    await state.setStatus(uid, cid, 'idle');
    const cloudFile = paths.groupChatStateFile(uid, cid);
    expect(JSON.parse(fs.readFileSync(cloudFile, 'utf8')).coding_project_dir).toBeUndefined();
    write(cloudFile, { version: 1, status: 'idle', coding_project_dir: path.join(root, 'remote') });
    await state.setStatus(uid, cid, 'running');
    expect((await state.readState(uid, cid)).coding_project_dir).toBe(root);
    expect(JSON.parse(fs.readFileSync(cloudFile, 'utf8')).coding_project_dir).toBeUndefined();
    expect((await state.readState('other-account', cid)).coding_project_dir).toBeUndefined();
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/group_chat/state');
    expect((await restarted.readState(uid, cid)).coding_project_dir).toBe(root);
  });

  it('retries migration after a legacy source read failure instead of freezing an empty choice', async () => {
    const paths = await import('../../../../src/main/paths');
    const file = paths.groupChatStateFile(uid, cid);
    write(paths.userAgentRuntimeConfigFile(uid), { version: 2, project_dirs: { a: { path: root } } });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{interrupted');
    const m = await import('../../../../src/main/features/local_agents/project-directory');
    expect(() => m.readCodingDirectoryFromStateFile(uid, cid, file)).toThrow();
    expect(fs.existsSync(paths.localCliDirectoryFile(uid, cid))).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{interrupted');
    write(file, { coding_project_dir: root, coding_project_dir_explicit: true });
    expect(m.readCodingDirectoryFromStateFile(uid, cid, file).coding_project_dir).toBe(root);
  });

  it('does not alter cloud state when preserving a legacy selection fails', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(uid);
    const paths = await import('../../../../src/main/paths');
    const cloudFile = paths.groupChatStateFile(uid, cid);
    write(cloudFile, { version: 1, status: 'idle', coding_project_dir: root });
    const before = fs.readFileSync(cloudFile, 'utf8');
    // A file occupying the parent directory forces a deterministic migration failure.
    fs.writeFileSync(path.dirname(paths.localCliDirectoryFile(uid, cid)), 'blocked');
    const state = await import('../../../../src/main/features/group_chat/state');
    await expect(state.setStatus(uid, cid, 'running')).rejects.toThrow();
    expect(fs.readFileSync(cloudFile, 'utf8')).toBe(before);
    expect(fs.existsSync(paths.localCliDirectoryFile(uid, cid))).toBe(false);
    fs.rmSync(path.dirname(paths.localCliDirectoryFile(uid, cid)));
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/group_chat/state');
    await restarted.setStatus(uid, cid, 'running');
    const recovered = await restarted.readState(uid, cid);
    expect(recovered).toMatchObject({ status: 'running', coding_project_dir_pending: root });
    expect(recovered.coding_project_dir).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(cloudFile, 'utf8')).coding_project_dir).toBeUndefined();
  });

  it('does not trust sessions from another task, account, or project during an upgrade', async () => {
    const paths = await import('../../../../src/main/paths');
    const directory = path.join(root, 'existing-project');
    fs.mkdirSync(directory);
    const proof = { cli: 'codex', sessionId: 'local-session',
      cwdFingerprint: crypto.createHash('sha256').update(directory).digest('hex') };
    write(paths.localCliSessionsFile(uid, 'other-task'), { a: proof });
    write(paths.localCliSessionsFile('other-account', cid), { a: proof });
    write(paths.localCliSessionsFile(uid, cid), { a: { ...proof, cwdFingerprint: 'different-project' } });
    const m = await import('../../../../src/main/features/local_agents/project-directory');
    expect(m.readCodingDirectory(uid, cid, { coding_project_dir: directory }))
      .toEqual({ coding_project_dir_pending: directory });
    // The matching task still has valid evidence; isolation must not disable migration globally.
    expect(m.readCodingDirectory(uid, 'other-task', { coding_project_dir: directory }).coding_project_dir).toBe(directory);
    expect(m.readCodingDirectory('other-account', cid, { coding_project_dir: directory }).coding_project_dir).toBe(directory);
  });

  it('preserves the previous choice across an interrupted atomic replacement and permits retry after restart', async () => {
    const paths = await import('../../../../src/main/paths');
    const m = await import('../../../../src/main/features/local_agents/project-directory');
    m.writeCodingDirectory(uid, cid, root, true);
    const file = paths.localCliDirectoryFile(uid, cid);
    const before = fs.readFileSync(file, 'utf8');
    const replacement = path.join(root, 'new-project');
    const { syncBuiltinESMExports } = await import('node:module');
    const nativeFs = (await import('node:fs')).default;
    const realRename = nativeFs.renameSync;
    const rename = vi.spyOn(nativeFs, 'renameSync').mockImplementation((source, target) => {
      if (String(target) === file) throw Object.assign(new Error('injected atomic replacement failure'), { code: 'EIO' });
      return realRename(source, target);
    });
    syncBuiltinESMExports();
    try {
      expect(() => m.writeCodingDirectory(uid, cid, replacement, true)).toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
    } finally { rename.mockRestore(); syncBuiltinESMExports(); }
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/local_agents/project-directory');
    expect(restarted.readCodingDirectory(uid, cid).coding_project_dir).toBe(root);
    restarted.writeCodingDirectory(uid, cid, replacement, true);
    expect(restarted.readCodingDirectory(uid, cid).coding_project_dir).toBe(replacement);
  });
});
