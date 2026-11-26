import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel() { yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '' }; },
}));

const uid = 'app-save-user', cid = 'app-save-task';
let root: string, workspace: string, previousRoot: string | undefined;
let closeLogs: () => Promise<void>, active: boolean;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-app-save-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  active = true;
  vi.resetModules();
  closeLogs = await captureMainLogWorkers();
  (await import('../../../src/main/features/users')).activateUser(uid);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await drainMainRuntimeForTest();
  await closeLogs();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
async function setup() {
  const saved = await import('../../../src/main/features/saved_apps');
  const artifacts = await import('../../../src/main/features/chat_artifacts');
  const { buildSaveAppTool } = await import('../../../src/main/features/group_chat/app_save_tool');
  const scope = () => ({ userId: uid, cid, workspace, roots: [workspace], isActive: () => active });
  const tool = buildSaveAppTool(scope);
  const call = async (input: Record<string, unknown>, signal = new AbortController().signal) => {
    const result = await tool.execute(input, { signal } as any);
    return JSON.parse(result.content);
  };
  const inspect = async (source: Record<string, unknown>) => {
    const result = await call({ ...source, action: 'inspect' });
    expect(result.status).toBe('ready');
    return { app_id: result.target.app_id, expected_revision: result.target.revision };
  };
  return { saved, artifacts, tool, call, inspect };
}
const appDir = (id: string) => path.join(root, uid, 'cloud/saved_apps', id);

describe('Commander application save contract', () => {
  it('save_app saves an artifact once, updates its bound identity, and explicitly forks a copy', async () => {
    const { artifacts, saved, tool, call, inspect } = await setup();
    expect(tool.name).toBe('save_app');
    expect(tool.executionMode).not.toBe('parallel');
    expect((tool.inputSchema as any).properties.action.description).toBe('Both actions require exactly one source: artifact_id or path. Inspect returns the bound saved destination and its revision without saving.');
    const title = 'Budget Tracker';
    const first = await artifacts.createArtifact(uid, cid, 'maker', { title, files: [
      { path: 'index.html', content: '<h1>Version one</h1>' }, { path: 'logo.png', content: 'AQID', encoding: 'base64' },
    ] });
    if (!first.ok) throw new Error(first.error);
    expect(await call({ action: 'save', artifact_id: title, mode: 'auto' }))
      .toMatchObject({ status: 'blocked', code: 'app_save_input' });
    expect(saved.listSavedApps(uid)).toEqual([]);
    const source = { artifact_id: first.artifactId };
    expect(await call({ ...source, action: 'inspect' })).toMatchObject({ status: 'ready', target: null });
    expect(saved.listSavedApps(uid)).toEqual([]);
    const created = await call(source);
    expect(created).toMatchObject({ status: 'saved', action: 'created', navigation: { target_id: created.app.id } });
    const revision = await artifacts.createArtifact(uid, cid, 'maker', { artifact_id: first.artifactId,
      files: [{ path: 'index.html', content: '<h1>Version two</h1>' }, { path: 'logo.png', content: 'AQID', encoding: 'base64' }] });
    expect(revision.ok).toBe(true);
    expect(await call(source)).toMatchObject({ status: 'blocked', code: 'app_save_inspection_required' });
    expect(fs.readFileSync(path.join(appDir(created.app.id), 'index.html'), 'utf8')).toContain('Version one');
    const updated = await call({ ...source, mode: 'update', ...await inspect(source) });
    expect(updated).toMatchObject({ status: 'saved', action: 'updated', app: { id: created.app.id } });
    expect(saved.listSavedApps(uid)).toHaveLength(1);
    expect(fs.readFileSync(path.join(appDir(created.app.id), 'logo.png'))).toEqual(Buffer.from([1, 2, 3]));
    const copy = await call({ ...source, mode: 'new' });
    expect(copy.app.id).not.toBe(created.app.id);
    expect(saved.listSavedApps(uid)).toHaveLength(2);
    expect(await call({ ...source, ...await inspect(source) })).toMatchObject({ action: 'updated', app: { id: copy.app.id } });
    expect(JSON.stringify(updated)).not.toContain(root);
  });

  it('saves a workspace bundle with a non-index entry and assets independently of the source', async () => {
    const { call, inspect, saved } = await setup();
    fs.mkdirSync(path.join(workspace, 'quote'));
    const file = path.join(workspace, 'quote', 'quote.html');
    fs.writeFileSync(file, '<title>Quote</title><h1>One</h1>');
    fs.writeFileSync(path.join(workspace, 'quote', 'style.css'), 'h1{color:blue}');
    const source = { path: 'quote/quote.html' };
    const created = await call(source);
    const old = await inspect(source);
    fs.writeFileSync(file, '<title>Quote</title><h1>Two</h1>');
    expect(await call({ ...source, ...old })).toMatchObject({ action: 'updated', app: { id: created.app.id } });
    fs.rmSync(path.join(workspace, 'quote'), { recursive: true });
    expect(saved.resolveSavedAppIndex(uid, created.app.id).ok).toBe(true);
    expect(fs.readFileSync(path.join(appDir(created.app.id), 'quote.html'), 'utf8')).toContain('Two');
    expect(fs.readFileSync(path.join(appDir(created.app.id), 'style.css'), 'utf8')).toBe('h1{color:blue}');
  });

  it('saves a complete workspace catalog without passing the application contents through model output', async () => {
    const { call, saved } = await setup();
    const folder = path.join(workspace, 'catalog');
    fs.mkdirSync(folder);
    const html = '<title>Catalog</title><script src="./catalog.js"></script><main id="catalog"></main>';
    const entries = Array.from({ length: 376 }, (_, index) => ({
      id: index + 1,
      label: `Catalog entry ${index + 1}`,
      description: 'A synthetic catalog item used to verify that the application save retains every record.',
    }));
    const catalog = `window.catalog = ${JSON.stringify(entries)};`;
    expect(Buffer.byteLength(catalog)).toBeGreaterThan(48 * 1024);
    fs.writeFileSync(path.join(folder, 'index.html'), html);
    fs.writeFileSync(path.join(folder, 'catalog.js'), catalog);

    const result = await call({ path: 'catalog' });

    expect(result).toMatchObject({ ok: true, status: 'saved', action: 'created',
      navigation: { surface_id: 'apps', action: 'configure' } });
    expect(saved.listSavedApps(uid).map(app => app.id)).toEqual([result.app.id]);
    expect(fs.readFileSync(path.join(appDir(result.app.id), 'index.html'), 'utf8')).toBe(html);
    expect(fs.readFileSync(path.join(appDir(result.app.id), 'catalog.js'), 'utf8')).toBe(catalog);
  });

  it('rejects stale revisions, wrong destinations and deleted update targets without creating applications', async () => {
    const { call, inspect, saved } = await setup();
    fs.mkdirSync(path.join(workspace, 'quote'));
    fs.writeFileSync(path.join(workspace, 'quote/index.html'), '<h1>Quote</h1>');
    const source = { path: 'quote/index.html' };
    const created = await call(source), old = await inspect(source);
    expect(await call({ ...source, ...old, app_id: 'unrelated' })).toMatchObject({ code: 'app_edit_conflict' });
    fs.writeFileSync(path.join(appDir(created.app.id), 'index.html'), '<h1>Concurrent edit</h1>');
    expect(await call({ ...source, ...old })).toMatchObject({ code: 'app_edit_conflict' });
    expect(fs.readFileSync(path.join(appDir(created.app.id), 'index.html'), 'utf8')).toContain('Concurrent edit');
    fs.rmSync(appDir(created.app.id), { recursive: true });
    expect(await call({ ...source, ...old, mode: 'update' })).toMatchObject({ code: 'app_edit_target_missing' });
    expect(await call(source)).toMatchObject({ code: 'app_edit_target_missing' });
    expect(saved.listSavedApps(uid)).toEqual([]);
    expect(await call({ ...source, mode: 'new' })).toMatchObject({ status: 'saved', action: 'created' });
  });

  it('rejects foreign artifacts, escaped paths and whole-workspace bundles without leaking paths', async () => {
    const { artifacts, saved, call } = await setup();
    const foreign = await artifacts.createArtifact(uid, 'another-task', 'maker', { files: [{ path: 'index.html', content: '<h1>Private</h1>' }] });
    if (!foreign.ok) throw new Error(foreign.error);
    fs.writeFileSync(path.join(workspace, 'index.html'), '<h1>Workspace</h1>');
    const outside = path.join(root, 'private-app'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'index.html'), '<h1>Private app</h1>');
    fs.symlinkSync(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const input of [{ action: 'inspect' }, { artifact_id: foreign.artifactId }, { path: workspace }, { path: '../secret/index.html' },
      { path: 'escape' }, { path: 'index.html', artifact_id: foreign.artifactId }, { artifact_id: '../bad' }, { action: 'publish', path: 'index.html' }]) {
      const result = await call(input);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(root);
    }
    expect(saved.listSavedApps(uid)).toEqual([]);
  });

  it('serializes competing updates and retains the application data when a schema update is incompatible', async () => {
    const { call, inspect, saved } = await setup();
    const folder = path.join(workspace, 'notes'); fs.mkdirSync(folder);
    const html = path.join(folder, 'index.html'), manifest = path.join(folder, 'orkas-app.json');
    const definition = { version: 1, tables: [{ id: 'notes', name: 'notes', fields: [{ id: 'body', name: 'body', type: 'string' }],
      access: { read: ['body'], insert: ['body'] } }] };
    fs.writeFileSync(html, '<h1>Original notes</h1>');
    fs.writeFileSync(manifest, JSON.stringify({ sdkVersion: 1, capabilities: ['data'], data: definition }));
    const source = { path: 'notes' }, created = await call(source), revision = await inspect(source);
    fs.writeFileSync(html, '<h1>Updated notes</h1>');
    const writes = await Promise.all([call({ ...source, ...revision }), call({ ...source, ...revision })]);
    expect(writes.filter(row => row.status === 'saved')).toHaveLength(1);
    expect(writes.filter(row => row.code === 'app_edit_conflict')).toHaveLength(1);
    expect(saved.listSavedApps(uid)).toHaveLength(1);
    const key = createHash('sha256').update(JSON.stringify(['saved', created.app.id])).digest('hex');
    const databaseFile = path.join(root, uid, 'local/web_apps', key, 'data.sqlite');
    const { LocalAppData } = await import('../../../src/main/features/web_apps/data');
    const database = new LocalAppData(databaseFile, path.join(root, uid, 'local'), definition as any);
    try { await database.call('data.insert', { table: 'notes', values: { body: 'KEEP' } }); }
    finally { await database.close(); }
    const latest = await inspect(source);
    fs.writeFileSync(manifest, JSON.stringify({ sdkVersion: 1, capabilities: ['data'], data: {
      version: 1, tables: [{ id: 'notes', name: 'notes', fields: [], access: { read: [], insert: [] } }],
    } }));
    const result = await call({ ...source, ...latest });
    expect(result).toMatchObject({ status: 'blocked', code: 'app_edit_data_migration' });
    expect(JSON.stringify(result)).not.toContain(root);
    const reopened = new LocalAppData(databaseFile, path.join(root, uid, 'local'), definition as any);
    try { expect(await reopened.call('data.query', { table: 'notes' })).toEqual({ records: [{ body: 'KEEP' }] }); }
    finally { await reopened.close(); }
    expect(JSON.parse(fs.readFileSync(path.join(appDir(created.app.id), 'orkas-app.json'), 'utf8')).data).toEqual(definition);
  });

  it('rejects stopped and cancelled tasks before any durable save', async () => {
    const { call, saved } = await setup();
    fs.mkdirSync(path.join(workspace, 'quote'));
    fs.writeFileSync(path.join(workspace, 'quote/index.html'), '<h1>Quote</h1>');
    const aborted = new AbortController(); aborted.abort();
    expect(await call({ path: 'quote' }, aborted.signal)).toMatchObject({ code: 'app_save_closed' });
    active = false;
    expect(await call({ path: 'quote' })).toMatchObject({ code: 'app_save_closed' });
    expect(saved.listSavedApps(uid)).toEqual([]);
  });
});
