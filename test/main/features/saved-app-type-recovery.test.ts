import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

const wire = { uid: 'type-owner' };
vi.mock('electron', () => ({ app: { isPackaged: false }, dialog: {} }));
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel() { yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '' }; },
}));

let root: string, previous: string | undefined, closeLogs: () => Promise<void>;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-type-recovery-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules(); wire.uid = 'type-owner';
  closeLogs = await captureMainLogWorkers();
  (await import('../../../src/main/features/users')).activateUser(wire.uid);
});
afterEach(async () => {
  await drainMainRuntimeForTest(); await closeLogs();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const saved = await import('../../../src/main/features/saved_apps');
  const artifacts = await import('../../../src/main/features/chat_artifacts');
  const created = await artifacts.createArtifact(wire.uid, 'type-conversation', 'helper', {
    appType: 'local', files: [{ path: 'index.html', content: '<h1>Keep this source</h1>' }],
  });
  if (!created.ok) throw new Error(created.error);
  const kept = await saved.saveFromArtifact(wire.uid, 'type-conversation', created.artifactId);
  if (!kept.ok) throw new Error(kept.error);
  const metadata = path.join(root, wire.uid, 'cloud/saved_apps', kept.id, '__orkas-meta.json');
  return { saved, artifacts, kept, metadata };
}

it('uses valid local metadata and preserves its edit binding without any hosted service', async () => {
  const f = await fixture();
  const edited = await f.saved.openForEditing(wire.uid, f.kept.id);
  expect(edited.ok).toBe(true); if (!edited.ok) throw new Error(edited.error);
  expect(await f.saved.getEditTarget(wire.uid, (edited.conversation as any).conversation_id)).toMatchObject({ appType: 'local' });
});

it('preserves legacy local editing when metadata is absent without creating metadata', async () => {
  const f = await fixture(); fs.unlinkSync(f.metadata);
  const edited = await f.saved.openForEditing(wire.uid, f.kept.id);
  expect(edited.ok).toBe(true); if (!edited.ok) throw new Error(edited.error);
  expect(await f.saved.getEditTarget(wire.uid, (edited.conversation as any).conversation_id)).toMatchObject({ appType: 'local' });
  expect(fs.existsSync(f.metadata)).toBe(false);
});

it.each(['{ damaged', '{"appType":"unexpected"}', '[]'])('refuses damaged authoritative metadata %s without rewriting source bytes', async damaged => {
  const f = await fixture(); fs.writeFileSync(f.metadata, damaged);
  expect((await f.saved.openForEditing(wire.uid, f.kept.id)).ok).toBe(false);
  expect(fs.readFileSync(f.metadata, 'utf8')).toBe(damaged);
});

it('resolves a mixed local listing using explicit metadata and the legacy fallback', async () => {
  const f = await fixture(); const dir = path.dirname(path.dirname(f.metadata));
  for (const [id, meta] of [['legacy', '{}'], ['historic-web', '{"appType":"web"}'], ['invalid', '{ damaged']]) {
    fs.mkdirSync(path.join(dir, id)); fs.writeFileSync(path.join(dir, id, '__orkas-meta.json'), meta);
    fs.writeFileSync(path.join(dir, id, 'index.html'), '<h1>Keep</h1>');
  }
  const list = await f.saved.listResolvedSavedApps(wire.uid);
  expect(Object.fromEntries(list.map(app => [app.id, app.appType]))).toEqual({
    [f.kept.id]: 'local', legacy: 'local', 'historic-web': 'web', invalid: undefined,
  });
});

it('rechecks the original app when an edit context loses its type and refuses damaged contexts', async () => {
  const f = await fixture(); const edited = await f.saved.openForEditing(wire.uid, f.kept.id);
  if (!edited.ok) throw new Error(edited.error);
  const cid = (edited.conversation as any).conversation_id;
  const contextFile = path.join(root, wire.uid, 'local/app-edits', cid, 'context.json');
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8')); delete context.appType;
  fs.writeFileSync(contextFile, JSON.stringify(context));
  expect(await f.saved.boundAppType(wire.uid, cid)).toBe('local');
  fs.writeFileSync(f.metadata, JSON.stringify({ ...JSON.parse(fs.readFileSync(f.metadata, 'utf8')), appType: 'web' }));
  expect(await f.saved.boundAppType(wire.uid, cid)).toBe('web');
  expect(await f.artifacts.createArtifact(wire.uid, cid, 'helper', { appType: 'local', files: [] }))
    .toMatchObject({ ok: false, error: 'app type must match the task or editing source' });
  fs.writeFileSync(contextFile, '{ damaged');
  await expect(f.saved.boundAppType(wire.uid, cid)).rejects.toMatchObject({ code: 'app_edit_context_unavailable' });
});

it('keeps a local edit on its original type and writes nothing for a conflicting web request', async () => {
  const f = await fixture(); const edited = await f.saved.openForEditing(wire.uid, f.kept.id);
  if (!edited.ok) throw new Error(edited.error);
  const cid = (edited.conversation as any).conversation_id;
  const denied = await f.artifacts.createArtifact(wire.uid, cid, 'helper', { appType: 'web', files: [{ path: 'index.html', content: '<h1>Other type</h1>' }] });
  expect(denied).toMatchObject({ ok: false, error: 'app type must match the task or editing source' });
  expect(fs.existsSync(path.join(root, wire.uid, 'cloud/chat_artifacts', cid))).toBe(false);
  const inherited = await f.artifacts.createArtifact(wire.uid, cid, 'helper', { files: [{ path: 'index.html', content: '<h1>Same type</h1>' }] });
  if (!inherited.ok) throw new Error(inherited.error);
  expect(f.artifacts.readArtifactMeta(wire.uid, cid, inherited.artifactId)?.appType).toBe('local');
});

it.each([undefined, null])('keeps omitted/null application types compatible in an ordinary conversation (%s)', async appType => {
  const f = await fixture();
  const created = await f.artifacts.createArtifact(wire.uid, 'ordinary', 'helper', { appType, files: [{ path: 'index.html', content: '<h1>Local</h1>' }] });
  if (!created.ok) throw new Error(created.error);
  expect(f.artifacts.readArtifactMeta(wire.uid, 'ordinary', created.artifactId)?.appType).toBe('local');
});

it('does not label an untyped artifact whose editing binding is damaged', async () => {
  const f = await fixture(); const edited = await f.saved.openForEditing(wire.uid, f.kept.id);
  if (!edited.ok) throw new Error(edited.error);
  const cid = (edited.conversation as any).conversation_id;
  const created = await f.artifacts.createArtifact(wire.uid, cid, 'helper', { files: [{ path: 'index.html', content: '<h1>Untyped</h1>' }] });
  if (!created.ok) throw new Error(created.error);
  fs.writeFileSync(path.join(root, wire.uid, 'cloud/chat_artifacts', cid, created.artifactId, '__orkas-meta.json'), '{}');
  fs.writeFileSync(path.join(root, wire.uid, 'local/app-edits', cid, 'context.json'), '{ damaged');
  const inspection = await f.artifacts.inspectArtifactIndex(wire.uid, cid, created.artifactId);
  expect(inspection.ok).toBe(false); expect(inspection).not.toHaveProperty('appType');
});

it.each([false, true])('updates an untyped destination offline as local under the same ID (historical binding: %s)', async historical => {
  const f = await fixture();
  const meta = JSON.parse(fs.readFileSync(f.metadata, 'utf8'));
  delete meta.appType;
  fs.writeFileSync(f.metadata, JSON.stringify(meta));
  const artifactId = meta.sourceArtifactId;
  if (historical) {
    const artifactMeta = path.join(root, wire.uid, 'cloud/chat_artifacts/type-conversation', artifactId, '__orkas-meta.json');
    const source = JSON.parse(fs.readFileSync(artifactMeta, 'utf8'));
    delete source.savedAppId;
    fs.writeFileSync(artifactMeta, JSON.stringify(source));
  }
  const before = fs.readFileSync(f.metadata, 'utf8');
  expect(await f.saved.getSaveTarget(wire.uid, 'type-conversation', { artifactId }))
    .toMatchObject({ appId: f.kept.id, appType: 'local' });
  expect(fs.readFileSync(f.metadata, 'utf8')).toBe(before);
  expect(await f.saved.saveFromArtifact(wire.uid, 'type-conversation', artifactId, 'auto'))
    .toMatchObject({ ok: true, id: f.kept.id });
  expect(JSON.parse(fs.readFileSync(f.metadata, 'utf8')).appType).toBe('local');
  expect(fs.readFileSync(path.join(path.dirname(f.metadata), 'index.html'), 'utf8')).toContain('Keep this source');
  vi.resetModules();
  const reopened = await import('../../../src/main/features/saved_apps');
  expect(reopened.listSavedApps(wire.uid)).toMatchObject([{ id: f.kept.id, appType: 'local' }]);
});


it('generates and saves edits of an untyped app as local offline', async () => {
  const f = await fixture();
  const meta = JSON.parse(fs.readFileSync(f.metadata, 'utf8')); delete meta.appType;
  fs.writeFileSync(f.metadata, JSON.stringify(meta));
  const edited = await f.saved.openForEditing(wire.uid, f.kept.id);
  if (!edited.ok) throw new Error(edited.error);
  const cid = (edited.conversation as any).conversation_id;
  const revised = await f.artifacts.createArtifact(wire.uid, cid, 'helper', {
    files: [{ path: 'index.html', content: '<h1>Edited offline</h1>' }],
  });
  if (!revised.ok) throw new Error(revised.error);
  expect(f.artifacts.readArtifactMeta(wire.uid, cid, revised.artifactId)?.appType).toBe('local');
  expect(await f.saved.saveFromArtifact(wire.uid, cid, revised.artifactId, 'update'))
    .toMatchObject({ ok: true, id: f.kept.id });
  expect(fs.readFileSync(path.join(path.dirname(f.metadata), 'index.html'), 'utf8')).toContain('Edited offline');
  expect(await f.saved.listResolvedSavedApps(wire.uid)).toMatchObject([{ id: f.kept.id, appType: 'local' }]);
});


it('does not turn an unresolved edit of a missing legacy destination into a new app', async () => {
  const f = await fixture();
  const edited = await f.saved.openForEditing(wire.uid, f.kept.id);
  if (!edited.ok) throw new Error(edited.error);
  const cid = (edited.conversation as any).conversation_id;
  const revised = await f.artifacts.createArtifact(wire.uid, cid, 'helper', {
    files: [{ path: 'index.html', content: '<h1>Revised source</h1>' }],
  });
  if (!revised.ok) throw new Error(revised.error);
  const contextFile = path.join(root, wire.uid, 'local/app-edits', cid, 'context.json');
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8')); delete context.appType;
  fs.writeFileSync(contextFile, JSON.stringify(context));
  fs.rmSync(path.dirname(f.metadata), { recursive: true });
  expect(await f.saved.getSaveTargetForDisplay(wire.uid, cid, { artifactId: revised.artifactId })).toBeNull();
  await expect(f.saved.getSaveTarget(wire.uid, cid, { artifactId: revised.artifactId })).rejects.toThrow('app not found');
  expect(await f.saved.saveFromArtifact(wire.uid, cid, revised.artifactId, 'auto'))
    .toMatchObject({ ok: false, error: 'app_edit_target_missing' });
  expect(f.saved.listSavedApps(wire.uid)).toHaveLength(0);
});


it('keeps save-as-new available and returns recoverable failures when an editing context is damaged', async () => {
  const f = await fixture(); const edited = await f.saved.openForEditing(wire.uid, f.kept.id);
  if (!edited.ok) throw new Error(edited.error);
  const cid = (edited.conversation as any).conversation_id, before = fs.readFileSync(f.metadata);
  const typed = await f.artifacts.createArtifact(wire.uid, cid, 'helper', { files: [{ path: 'index.html', content: '<h1>Typed</h1>' }] });
  const untyped = await f.artifacts.createArtifact(wire.uid, cid, 'helper', { files: [{ path: 'index.html', content: '<h1>Untyped</h1>' }] });
  if (!typed.ok || !untyped.ok) throw new Error('artifact fixture failed');
  fs.writeFileSync(path.join(root, wire.uid, 'cloud/chat_artifacts', cid, untyped.artifactId, '__orkas-meta.json'), '{}');
  fs.writeFileSync(path.join(root, wire.uid, 'local/app-edits', cid, 'context.json'), '{ damaged');
  const artifactsBefore = fs.readdirSync(path.join(root, wire.uid, 'cloud/chat_artifacts', cid)).sort();
  expect(await f.artifacts.createArtifact(wire.uid, cid, 'helper', { files: [{ path: 'index.html', content: '<h1>New</h1>' }] }))
    .toEqual({ ok: false, error: 'app editing source unavailable; reopen editing from the app or save as a new app' });
  expect(fs.readdirSync(path.join(root, wire.uid, 'cloud/chat_artifacts', cid)).sort()).toEqual(artifactsBefore);
  const appsBefore = f.saved.listSavedApps(wire.uid).map(app => app.id);
  expect(await f.saved.saveFromArtifact(wire.uid, cid, typed.artifactId, 'update')).toEqual({ ok: false, error: 'app_edit_target_missing' });
  expect(await f.saved.saveFromArtifact(wire.uid, cid, untyped.artifactId)).toEqual({ ok: false, error: 'app_edit_target_missing' });
  expect(f.saved.listSavedApps(wire.uid).map(app => app.id)).toEqual(appsBefore);
  const copy = await f.saved.saveFromArtifact(wire.uid, cid, typed.artifactId);
  if (!copy.ok) throw new Error(copy.error);
  expect(f.saved.listSavedApps(wire.uid).find(app => app.id === copy.id)?.appType).toBe('local');
  expect(fs.readFileSync(f.metadata)).toEqual(before);
});

