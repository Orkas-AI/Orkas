import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';

vi.mock('electron', () => ({ app: { isPackaged: false }, dialog: {} }));
const uid = 'commercial-boundary';
const receipt = { ok: false, code: 'E_COMMERCIAL_REQUIRED', feature: 'web_apps' };
let root: string, previous: string | undefined, closeLogs: () => Promise<void>;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-commercial-entry-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  closeLogs = await captureMainLogWorkers();
  (await import('../../../src/main/features/users')).activateUser(uid);
});
afterEach(async () => {
  await closeLogs();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function seed(dir: string, appType: string | undefined, manifest = true) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><h1>Retained app</h1>');
  fs.writeFileSync(path.join(dir, '__orkas-meta.json'), JSON.stringify({
    title: 'Retained app', appType, entry: 'index.html', savedAt: '2026-10-01T00:00:00Z',
    sourceCid: 'historic', sourceArtifactId: 'historic',
  }));
  if (manifest) fs.writeFileSync(path.join(dir, 'orkas-app.json'), JSON.stringify({ sdkVersion: 1, capabilities: [] }));
}
function snapshot(dir: string): unknown {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name);
    return [name, fs.statSync(file).isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}
describe('unified apps and the publication boundary', () => {
  it.each(['local', 'web', 'cloud'])('creates, saves, reopens, previews and edits a %s app locally', async appType => {
    const artifacts = await import('../../../src/main/features/chat_artifacts');
    const saved = await import('../../../src/main/features/saved_apps');
    const created = await artifacts.createArtifact(uid, 'new-task', 'commander', { appType, files: [
      { path: 'index.html', content: '<h1>Locally available</h1>' },
      { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: [] }) },
    ] });
    expect(created.ok).toBe(true); if (!created.ok) throw new Error(created.error);
    const stored = await saved.saveFromArtifact(uid, 'new-task', created.artifactId);
    expect(stored.ok).toBe(true); if (!stored.ok) throw new Error(stored.error);
    expect(saved.listSavedApps(uid).map(app => app.id)).toContain(stored.id);
    const host = await import('../../../src/main/features/web_apps/host');
    const opened = await host.openApp(uid, 4, { appId: stored.id });
    expect(opened.url).toMatch(/^chat-app:/);
    const { previewBundle } = await import('../../../src/main/features/web_apps/preview');
    const paths = await import('../../../src/main/paths');
    const preview = await previewBundle(path.join(paths.savedAppDir(uid, stored.id), 'index.html'));
    expect(preview?.resolve('index.html')).toMatchObject({ mime: 'text/html; charset=utf-8' });
    expect(await saved.openForEditing(uid, stored.id)).toMatchObject({ ok: true });
    host.runtime.closeUser(uid); await host.runtime.drainData();
  });

  it.each(['web', 'cloud'])('retains existing %s source and capability identity while saving and editing', async appType => {
    const paths = await import('../../../src/main/paths');
    const savedDir = paths.savedAppDir(uid, 'historic-app');
    const artifactDir = path.join(paths.chatArtifactCidDir(uid, 'historic'), 'historic');
    seed(savedDir, appType); seed(artifactDir, appType);
    const before = snapshot(savedDir);
    const saved = await import('../../../src/main/features/saved_apps');
    expect(saved.listSavedApps(uid).map(app => app.id)).toContain('historic-app');
    expect(await saved.saveFromArtifact(uid, 'historic', 'historic')).toMatchObject({ ok: true });
    expect(await saved.saveFromPath(uid, path.join(artifactDir, 'index.html'))).toMatchObject({ ok: true });
    const edited = await saved.openForEditing(uid, 'historic-app');
    expect(edited.ok).toBe(true);
    expect(snapshot(savedDir)).toEqual(before);
    expect(await saved.resolveSavedAppType(uid, 'historic-app')).toBe('web');
  });

  it('keeps legacy web SDK data available without granting host-only capabilities', async () => {
    const { WebAppRuntime } = await import('../../../src/main/features/web_apps/runtime');
    const called = vi.fn();
    const runtime = new WebAppRuntime({ activeUser: () => uid, language: () => 'en', modelAvailable: () => true,
      pick: called, save: called, generate: called, tools: called });
    const bundle = { key: 'direct', appType: 'web', entry: 'index.html', title: 'Retained',
      manifest: { sdkVersion: 1, capabilities: [] }, resolve: () => null } as any;
    const opened = runtime.open(uid, 1, bundle);
    expect(opened.url).toMatch(/^chat-app:/);
    expect(await runtime.call(uid, 1, opened.token, 'context', 'host.getContext', {})).toMatchObject({ language: 'en', sdkVersion: 1 });
    await expect(runtime.call(uid, 1, opened.token, 'host-file', 'files.pick', {})).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
    expect(called).not.toHaveBeenCalled(); runtime.closeUser(uid); await runtime.drainData();
  });

  it('refuses publication before changing saved apps, artifacts, or edit drafts', async () => {
    const paths = await import('../../../src/main/paths');
    seed(paths.savedAppDir(uid, 'historic-app'), 'web');
    seed(path.join(paths.chatArtifactCidDir(uid, 'historic'), 'historic'), 'web');
    const before = snapshot(path.join(root, 'data'));
    const { publishApp } = await import('../../../src/main/features/web_apps/commercial-entry');
    expect(publishApp()).toMatchObject(receipt);
    expect(snapshot(path.join(root, 'data'))).toEqual(before);
  });
  it.each(['{ damaged', '[]', '{"assistance":{"kind":"app_creation","appType":"unexpected"}}'])
  ('does not turn an unreadable task binding into local permission (%s)', async content => {
    const chats = await import('../../../src/main/features/chats');
    const { conversationLayout } = await import('../../../src/main/util/project-layout');
    const conversation = await chats.createConversation(uid, { assistance: { kind: 'app_creation', appType: 'web' } });
    const cid = conversation.conversation_id;
    fs.writeFileSync(conversationLayout(uid, cid).metaFile, content);
    vi.spyOn(chats, 'getConversationMetadata').mockResolvedValue(null);
    try {
      const artifacts = await import('../../../src/main/features/chat_artifacts');
      const paths = await import('../../../src/main/paths');
      const before = snapshot(paths.userChatArtifactsDir(uid));
      expect(await artifacts.createArtifact(uid, cid, 'commander', { appType: 'local', files: [{ path: 'index.html', content: '<h1>No grant</h1>' }] }))
        .toMatchObject({ ok: false });
      expect(snapshot(paths.userChatArtifactsDir(uid))).toEqual(before);
      expect(fs.readFileSync(conversationLayout(uid, cid).metaFile, 'utf8')).toBe(content);
    } finally { vi.restoreAllMocks(); }
  });

});

it.each(['web','cloud'])('retains an unrecognized %s save journal and staging bytes for recovery', async appType => {
  const paths = await import('../../../src/main/paths');
  const editing = path.join(paths.userAppEditsDir(uid), 'interrupted-edit');
  const temporary = paths.savedAppDir(uid, 'retained-app.tmp-01234567');
  seed(paths.savedAppDir(uid, 'retained-app'), appType);
  seed(temporary, appType);
  fs.mkdirSync(editing, {recursive:true});
  fs.writeFileSync(path.join(editing,'context.json'), JSON.stringify({version:1,appId:'retained-app',appType,title:'Retained',fingerprint:'0'.repeat(64)}));
  fs.writeFileSync(path.join(editing,'save-journal.json'), JSON.stringify({version:1,appId:'retained-app',temporary:'retained-app.tmp-01234567',before:'0'.repeat(64),after:'1'.repeat(64)}));
  const beforeApps = snapshot(paths.userSavedAppsDir(uid)), beforeEdits = snapshot(editing);
  const saved = await import('../../../src/main/features/saved_apps');
  saved.listSavedApps(uid); await saved.cleanupEditSnapshots(uid);
  expect(snapshot(paths.userSavedAppsDir(uid))).toEqual(beforeApps);
  expect(snapshot(editing)).toEqual(beforeEdits);
});
