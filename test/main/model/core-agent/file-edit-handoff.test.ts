import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const uid = 'file-edit-handoff';
let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-file-handoff-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(uid);
  const permissions = await import('../../../../src/main/features/permissions');
  permissions.setLocalExecMode('all_files_auto');
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const workingDir = path.join(root, 'workspace');
  fs.mkdirSync(workingDir);
  const workspace = await import('../../../../src/main/features/user_workspace');
  expect(workspace.setWorkspacePath(uid, workingDir).ok).toBe(true);
  const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
  const { createFileTools } = await import('../../../../src/main/model/core-agent/file-tools');
  const opts = { userId: uid, cid: 'handoff' };
  const tools = [...createLocalTools(opts), ...createFileTools(opts)];
  const ctx = { workingDir, state: { readFileState: new Map() } } as any;
  const call = (name: string, input: Record<string, unknown>) => tools.find(t => t.name === name)!.execute(input, ctx);
  const patch = (from: string, to: string) => ({ patch: `*** Begin Patch\n*** Update File: target.py\n@@\n-${from}\n+${to}\n*** End Patch` });
  return { workingDir, ctx, call, patch, target: path.join(workingDir, 'target.py') };
}

// Replay the two observed handoffs with real file executors and shell commands.
// File bytes are the independent oracle; a rejected edit must not write anything.
it.skipIf(process.platform === 'win32')('reproduces N02: shell read cannot establish a patch baseline; explicit file read recovers', async () => {
  const { target, ctx, call, patch } = await setup();
  fs.writeFileSync(target, 'value = 1\n');
  const shell = await call('bash', { command: "sed -n '1,10p' target.py" });
  expect(shell.isError).toBeFalsy();
  expect(shell.content).toContain('value = 1');
  expect(ctx.state.readFileState.has(target)).toBe(false);
  const rejected = await call('apply_patch', patch('value = 1', 'value = 2'));
  expect(rejected.content).toContain('E_NOT_READ');
  expect(fs.readFileSync(target, 'utf8')).toBe('value = 1\n');
  expect((await call('read_files', { paths: [{ path: 'target.py' }] })).isError).toBeFalsy();
  expect((await call('apply_patch', patch('value = 1', 'value = 2'))).isError).toBeFalsy();
  expect(fs.readFileSync(target, 'utf8')).toBe('value = 2\n');
});

it.skipIf(process.platform === 'win32')('reproduces N09: shell-created source needs a file read before targeted editing', async () => {
  const { target, ctx, call } = await setup();
  expect((await call('bash', { command: "cat > target.py <<'PY'\nvalue = 1\nPY" })).isError).toBeFalsy();
  expect(fs.readFileSync(target, 'utf8')).toBe('value = 1\n');
  expect(ctx.state.readFileState.has(target)).toBe(false);
  const edit = { path: 'target.py', old_string: 'value = 1', new_string: 'value = 2' };
  const rejected = await call('edit_file', edit);
  expect(rejected.content).toContain('E_NOT_READ');
  expect(fs.readFileSync(target, 'utf8')).toBe('value = 1\n');
  expect((await call('read_files', { paths: [{ path: 'target.py' }] })).isError).toBeFalsy();
  expect((await call('edit_file', edit)).isError).toBeFalsy();
  expect(fs.readFileSync(target, 'utf8')).toBe('value = 2\n');
});

it.skipIf(process.platform === 'win32')('preserves a dedicated read across unrelated shell work and rejects a later shell mutation', async () => {
  const { target, call, patch } = await setup();
  fs.writeFileSync(target, 'value = 1\n');
  expect((await call('read_files', { paths: [{ path: 'target.py' }] })).isError).toBeFalsy();
  expect((await call('bash', { command: "cat > other.py <<'PY'\nother = 1\nPY" })).isError).toBeFalsy();
  expect((await call('apply_patch', patch('value = 1', 'value = 2'))).isError).toBeFalsy();
  expect((await call('bash', { command: "cat > target.py <<'PY'\nvalue = 9\nPY" })).isError).toBeFalsy();
  const stale = await call('apply_patch', patch('value = 9', 'value = 3'));
  expect(stale.content).toContain('E_STALE');
  expect(fs.readFileSync(target, 'utf8')).toBe('value = 9\n');
});

it('does not let a decoded read authorize an edit that would rewrite the file as UTF-8', async () => {
  const { workingDir, ctx, call } = await setup();
  const file = path.join(workingDir, 'orders.csv');
  const gbk = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0x2C, 0x41, 0x42, 0x0A]);
  fs.writeFileSync(file, gbk);
  const decoded = await call('read_files', { paths: [{ path: 'orders.csv', encoding: 'gb18030' }] });
  expect(decoded.content).toContain('中文,AB');
  expect(ctx.state.readFileState.has(file)).toBe(false);
  const rejected = await call('edit_file', { path: 'orders.csv', old_string: 'AB', new_string: 'CD' });
  expect(rejected.content).toContain('E_NOT_READ');
  expect(fs.readFileSync(file)).toEqual(gbk);
});

it('keeps edit evidence when a valid UTF-8 file is read with an explicit utf-8 label', async () => {
  const { target, call } = await setup();
  fs.writeFileSync(target, 'value = 1\n');
  const read = await call('read_files', { paths: [{ path: 'target.py', encoding: 'utf8' }] });
  expect(read.content).toContain('file_hash="sha256:');
  expect(read.content).not.toContain('encoding=');
  expect((await call('edit_file', { path: 'target.py', old_string: 'value = 1', new_string: 'value = 2' })).isError).toBeFalsy();
  expect(fs.readFileSync(target, 'utf8')).toBe('value = 2\n');
});

it('hands the refreshed source byte size from a raced read to one replay-safe append', async () => {
  const { target, call } = await setup();
  fs.writeFileSync(target, 'value = 1\n');
  const current = 'value = 100\nother = 200\n';
  const originalRead = fs.promises.readFile;
  let changed = false;
  const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (file, options) => {
    const body = await originalRead(file, options);
    if (String(file) === target && !changed) {
      changed = true;
      fs.writeFileSync(target, current);
      const at = new Date(Date.now() + 10_000);
      fs.utimesSync(target, at, at);
    }
    return body;
  });
  let read;
  try { read = await call('read_files', { paths: [{ path: 'target.py' }] }); }
  finally { spy.mockRestore(); }
  expect(changed).toBe(true);
  expect(read.isError).toBeFalsy();
  const revision = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(read.content)?.[1];
  expect(revision).toBeTruthy();
  const input = { path: 'target.py', content: 'last = 300\n', base_revision: revision };
  expect((await call('append_file', input)).isError).toBeFalsy();
  expect(fs.readFileSync(target, 'utf8')).toBe(current + input.content);
  expect((await call('append_file', input)).isError).toBeFalsy();
  expect(fs.readFileSync(target, 'utf8')).toBe(current + input.content);
});

it.each(['write_file', 'apply_patch'])('continues editing after a dedicated %s creates the file without another read', async creator => {
  const { target, call, patch } = await setup();
  const input = creator === 'write_file'
    ? { path: 'target.py', content: 'value = 1\n' }
    : { patch: '*** Begin Patch\n*** Add File: target.py\n+value = 1\n*** End Patch' };
  expect((await call(creator, input)).isError).toBeFalsy();
  expect((await call('edit_file', { path: 'target.py', old_string: 'value = 1', new_string: 'value = 2' })).isError).toBeFalsy();
  expect((await call('apply_patch', patch('value = 2', 'value = 3'))).isError).toBeFalsy();
  expect(fs.readFileSync(target, 'utf8')).toBe('value = 3\n');
});
