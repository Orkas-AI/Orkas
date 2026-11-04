import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel() { yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '' }; },
}));
const UID = 'save-source-owner', CID = 'save-source-chat';
let root: string, previous: string | undefined, closeLogs: () => Promise<void>;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-save-source-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  closeLogs = await captureMainLogWorkers();
  (await import('../../../src/main/features/users')).activateUser(UID);
});
afterEach(async () => {
  await drainMainRuntimeForTest(); await closeLogs();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function source() {
  const dir = path.join(root, 'workspace/app');
  fs.mkdirSync(dir, { recursive: true });
  const entry = path.join(dir, 'index.html');
  fs.writeFileSync(entry, '<h1>Keep source</h1>');
  return { dir, entry };
}
it('returns a stable failure if the selected entry disappears after inspection and allows retry', async () => {
  const saved = await import('../../../src/main/features/saved_apps');
  const chats = await import('../../../src/main/features/chats');
  const { dir, entry } = source();
  const metadata = vi.spyOn(chats, 'getConversationMetadata').mockImplementationOnce(async () => {
    fs.unlinkSync(entry); return null;
  });
  try {
    const outcome = await saved.saveFromPath(UID, entry, { sourceCid: CID, fenceRoots: [root] })
      .catch(error => ({ rejected: true, code: error.code }));
    expect.soft(outcome).toEqual({ ok: false, error: 'app_save_failed' });
    expect.soft(saved.listSavedApps(UID)).toEqual([]);
    fs.writeFileSync(entry, '<h1>Retry source</h1>');
    const retried = await saved.saveFromPath(UID, entry, { sourceCid: CID, fenceRoots: [root] });
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error(retried.error);
    const resolved = saved.resolveSavedAppIndex(UID, retried.id);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(fs.readFileSync(resolved.absPath, 'utf8')).toContain('Retry source');
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('Retry source');
  } finally { metadata.mockRestore(); }
});
it('does not retain a phantom active save when source identity resolution fails before queue admission', async () => {
  const saved = await import('../../../src/main/features/saved_apps');
  const paths = await import('../../../src/main/paths');
  const { dir, entry } = source();
  const orphan = path.join(paths.userAppEditsDir(UID), CID);
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'keep-until-settled.txt'), 'temporary snapshot');
  const chatsDir = paths.userChatsDir(UID);
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(path.join(chatsDir, '_index.json'), '[]');
  const nativeFs = (await import('node:fs')).default;
  const realpath = nativeFs.realpathSync;
  let faults = 0;
  const spy = vi.spyOn(nativeFs, 'realpathSync').mockImplementation(((target: any, options: any) => {
    if (String(target) === dir && !faults++) throw Object.assign(new Error('fixture source unavailable'), { code: 'EIO' });
    return realpath(target, options);
  }) as any);
  syncBuiltinESMExports();
  try {
    const outcome = await saved.saveFromArtifact(UID, CID, '', 'new', undefined, {
      rootDir: dir, bindingRoot: dir, entry: 'index.html', explicitEntry: true,
      explicitTitle: false, title: 'Source', files: [entry], appType: 'local', sourceCid: CID,
    }).catch(error => ({ rejected: true, code: error.code }));
    expect.soft(outcome).toEqual({ ok: false, error: 'app_save_failed' });
  } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  expect(faults).toBeGreaterThan(0);
  await saved.cleanupEditSnapshots(UID, false, CID);
  expect.soft(fs.existsSync(orphan)).toBe(false);
  expect.soft(saved.listSavedApps(UID)).toEqual([]);
  const retry = await saved.saveFromPath(UID, entry, { sourceCid: CID, fenceRoots: [root] });
  expect(retry.ok).toBe(true);
  expect(saved.listSavedApps(UID)).toHaveLength(1);
});
