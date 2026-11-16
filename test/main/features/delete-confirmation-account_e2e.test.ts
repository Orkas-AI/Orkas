import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const emitted = vi.hoisted(() => [] as Array<{ channel: string; payload: any }>);
vi.mock('../../../src/main/ipc', () => ({
  broadcastToRenderer: (channel: string, payload: any) => { emitted.push({ channel, payload }); return true; },
}));
let root: string, previousRoot: string | undefined;
let users: typeof import('../../../src/main/features/users');
let confirms: typeof import('../../../src/main/model/core-agent/delete-file-confirm');
let factory: typeof import('../../../src/main/model/core-agent/local-tools');
let permissions: typeof import('../../../src/main/features/permissions');
let workspace: typeof import('../../../src/main/features/user_workspace');

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-delete-account-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  emitted.length = 0;
  users = await import('../../../src/main/features/users');
  users.activateUser('confirm-a');
  permissions = await import('../../../src/main/features/permissions');
  permissions.setLocalExecMode('all_files_approval');
  workspace = await import('../../../src/main/features/user_workspace');
  factory = await import('../../../src/main/model/core-agent/local-tools');
  confirms = await import('../../../src/main/model/core-agent/delete-file-confirm');
});
afterEach(() => {
  for (const e of emitted) if (e.channel === 'delete_file.confirmation_required') confirms.cancelConfirmation(e.payload.confirm_id);
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
function actor(uid: string) {
  const dir = path.join(root, `${uid}-workspace`);
  fs.mkdirSync(dir, { recursive: true });
  expect(workspace.setWorkspacePath(uid, dir).ok).toBe(true);
  const tool = factory.createLocalTools({ userId: uid, cid: 'confirm-conversation' }).find(t => t.name === 'delete_file')!;
  return { tool, ctx: { workingDir: dir, state: {} } as any };
}
async function ask(a: ReturnType<typeof actor>, file: string) {
  const before = emitted.length;
  const pending = a.tool.execute({ path: file }, a.ctx);
  await vi.waitFor(() => expect(emitted.slice(before).some(e => e.channel === 'delete_file.confirmation_required')).toBe(true));
  const token = emitted.slice(before).find(e => e.channel === 'delete_file.confirmation_required')!.payload.confirm_id;
  expect(confirms.markConfirmationVisible(token)).toBe(true);
  expect((await pending).content).toContain('requires_user_confirmation');
  expect(fs.readFileSync(file, 'utf8')).toBe('keep until current-account approval');
  return token;
}
function outside() {
  const file = path.join(root, 'outside-workspace.txt');
  fs.writeFileSync(file, 'keep until current-account approval');
  return file;
}
function switchTo(uid: string) {
  // Real account activation invokes the production synchronous safety hooks.
  users.activateUser(uid);
  permissions.setLocalExecMode('all_files_approval');
  return actor(uid);
}

it('does not let another account consume an already granted delete capability', async () => {
  const a = actor('confirm-a'), file = outside(), token = await ask(a, file);
  expect(confirms.resolveConfirmation(token, true)).toBe(true);
  const b = switchTo('confirm-b');
  const result = await b.tool.execute({ path: file, confirmation_token: token }, b.ctx);
  expect(fs.existsSync(file)).toBe(true);
  expect(result.isError).toBe(true);
  expect(result.content).toContain('E_INVALID_TOKEN');
});

it('invalidates a pending card before a late renderer approval after account switch', async () => {
  const a = actor('confirm-a'), file = outside(), token = await ask(a, file);
  switchTo('confirm-b');
  expect(confirms.resolveConfirmation(token, true)).toBe(false);
  expect(confirms.consumeGrantedConfirmation(token, file).outcome).toBe('invalid');
  expect(fs.existsSync(file)).toBe(true);
});

it('does not revive the old grant after switching away and back', async () => {
  const a = actor('confirm-a'), file = outside(), token = await ask(a, file);
  expect(confirms.resolveConfirmation(token, true)).toBe(true);
  switchTo('confirm-b');
  const returned = switchTo('confirm-a');
  const result = await returned.tool.execute({ path: file, confirmation_token: token }, returned.ctx);
  expect(fs.existsSync(file)).toBe(true);
  expect(result.isError).toBe(true);
});

it('retains same-account approval and deletes exactly the confirmed file', async () => {
  const a = actor('confirm-a'), file = outside(), token = await ask(a, file);
  expect(confirms.resolveConfirmation(token, true)).toBe(true);
  const same = switchTo('confirm-a');
  const result = await same.tool.execute({ path: file, confirmation_token: token }, same.ctx);
  expect(result.isError).toBeFalsy();
  expect(fs.existsSync(file)).toBe(false);
  expect(confirms.consumeGrantedConfirmation(token, file).outcome).toBe('invalid');
});

it('settles an in-flight visibility wait and retracts its card on account switch', async () => {
  const a = actor('confirm-a'), file = outside();
  const pending = a.tool.execute({ path: file }, a.ctx);
  await vi.waitFor(() => expect(emitted.some(e => e.channel === 'delete_file.confirmation_required')).toBe(true));
  const token = emitted.find(e => e.channel === 'delete_file.confirmation_required')!.payload.confirm_id;
  switchTo('confirm-b');
  expect(confirms.markConfirmationVisible(token)).toBe(false);
  expect((await pending).isError).toBe(true);
  expect(fs.existsSync(file)).toBe(true);
  expect(emitted).toContainEqual({ channel: 'delete_file.confirmation_invalidated', payload: { confirm_id: token, reason: 'cancelled' } });
});
