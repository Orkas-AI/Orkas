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
