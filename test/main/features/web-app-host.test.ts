import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { freezeFileMetadata } from '../../helpers/frozen-file-metadata';

const connector = vi.hoisted(() => ({ instances: [] as any[], call: vi.fn(async () => ({ content: [{ type: 'text', text: 'Verified remote result' }] })), approve: vi.fn(async () => false) }));

it('keeps structured data errors while returning readable localized recovery instead of raw keys', async () => {
  const {safeFailure}=await import('../../../src/main/features/web_apps/host');
  const {AppError}=await import('../../../src/main/features/web_apps/runtime');
  const {t}=await import('../../../src/main/i18n');
  for(const code of ['E_DATA','E_SCHEMA','E_CONFLICT','E_PERMISSION','E_MIGRATION','E_RELATION','E_TABLE','E_CONDITION']){
    const result=safeFailure(new AppError(code));expect(result.code).toBe(code);
    expect(result.message).not.toMatch(/^web_apps\./);expect(result.message).toBe(t('web_apps.error_E_FAILED'));
  }
});
vi.mock('electron', () => ({ dialog: {}, app: { isPackaged: false } }));
vi.mock('../../../src/main/features/connectors/manager', () => ({
  listInstances: () => connector.instances, restoreComposioConnectionsFromServer: async () => 0,
  refreshStaleToolCaches: async () => 0, callTool: (...args: any[]) => connector.call(...args),
}));
vi.mock('../../../src/main/features/connectors/action_confirm', async original => ({
  ...await original<any>(), requestActionConfirm: (...args: any[]) => connector.approve(...args),
}));
let root: string, previous: string | undefined;
const uid = 'web-host-test';
let closeLogWorkers: () => Promise<void>;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-web-host-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  closeLogWorkers = await captureMainLogWorkers(); connector.instances = []; connector.call.mockClear(); connector.approve.mockClear();
  (await import('../../../src/main/features/users')).activateUser(uid);
});
afterEach(async () => {
  (await import('../../../src/main/features/web_apps/host')).runtime.closeUser(uid);
  (await import('../../../src/main/features/kb_vector')).closeAllKb();
  await closeLogWorkers();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
describe('Web host reuses owning services', () => {
  it('exposes bounded connector search through the existing Web tool adapter and rechecks visibility', async () => {
    const tools = Array.from({ length: 100 }, (_, i) => ({ name: `read_${i}`, description: 'Read ordinary entry', input_schema: { type: 'object' } }));
    const target = { name: 'find_invoice', description: 'Find overdue invoices', input_schema: { type: 'object', properties: { invoice_id: { type: 'string' } } } };
    connector.instances = [{ id: 'custom-search', origin: 'custom', display_name: 'Search fixture', transport: { kind: 'streamable-http', url: 'https://example.invalid/mcp' },
      enabled_subtools: null, tools_cache: [...tools, target], status: { kind: 'connected', since: 0 }, created_at: '', updated_at: '', tools_cached_at: 0 }];
    const { appTools } = await import('../../../src/main/features/web_apps/host');
    const list = (await appTools(uid)).find(t => t.name === 'list_connector_tools')!;
    const invoke = (arguments_: object) => list.execute(arguments_ as any, new AbortController().signal);
    expect(list.inputSchema.properties).toHaveProperty('query');
    const first = JSON.parse((await invoke({ connector_id: 'custom-search' })).content);
    expect(first).toMatchObject({ mode: 'compact', total: 101, next_offset: 20 });
    const found = JSON.parse((await invoke({ query: 'overdue invoices', limit: 1 })).content);
    expect(found.tools[0]).toMatchObject({ name: target.name, input_schema: target.input_schema });
    expect(JSON.parse((await invoke({ query: 'overdue invoices 发票', limit: 1 })).content).tools[0].name).toBe(target.name);
    expect(JSON.parse((await invoke({ query: 'VID-72' })).content)).toMatchObject({ tools: [], total: 0 });
    expect(await invoke({ connector_id: 'custom-search', tool_name: 'read_72' })).toMatchObject({ content: expect.stringMatching(/read_72[\s\S]*Input schema:/) });
    connector.instances[0].enabled_subtools = [target.name];
    const full = await invoke({ connector_id: 'custom-search', limit: 50, offset: 0 });
    expect(full.content).toContain('### find_invoice');
    expect(full.content).toContain('Input schema:');
    expect(connector.call).not.toHaveBeenCalled(); expect(connector.approve).not.toHaveBeenCalled();
    connector.instances[0].enabled_subtools = ['read_0'];
    expect(JSON.parse((await invoke({ query: 'overdue invoices' })).content)).toMatchObject({ tools: [], search: { searched_tools: 1 }, guidance: expect.any(String) });
    expect(await invoke({ connector_id: 'custom-search', tool_name: target.name })).toMatchObject({ isError: true });
    expect(await invoke({ query: ' ' })).toMatchObject({ isError: true });
  });

  it('keeps same-bundle navigation usable and refuses look-alike destinations without closing it', async () => {
    const { createArtifact } = await import('../../../src/main/features/chat_artifacts');
    const { runtime, appResource } = await import('../../../src/main/features/web_apps/host');
    const { webAppInvokeHandlers } = await import('../../../src/main/ipc/web_apps');
    const created = await createArtifact(uid, 'pages-test', 'agent', { files: [
      { path: 'index.html', content: '<h1>First</h1>' },
      { path: 'pages/second.html', content: '<h1>Second</h1>' },
      { path: 'data.json', content: '{}' },
      { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: ['storage'] }) },
    ] });
    if (!created.ok) throw new Error(created.error);
    const sender = Object.assign(new EventEmitter(), { id: 10, isDestroyed: () => false });
    const app: any = await webAppInvokeHandlers['webApps.open'](
      { source: { cid: 'pages-test', artifactId: created.artifactId } }, { userId: uid, sender: sender as any });
    await runtime.call(uid, sender.id, app.token, 'save', 'storage.set', { key: 'draft', value: 'Retained' });
    for (const [relative, allowed] of [['/pages/second.html?view=2#row', true], ['/index.html?reload', true],
      ['/data.json', false], ['/missing.html', false], ['/%E0%A4%A.html', false]] as const) {
      const destination = new URL(relative, app.url).href;
      expect(runtime.canNavigate(999, app.url, destination)).toBe(false);
      for (const frameAvailable of [true, false]) {
        const event = { url: destination, isMainFrame: false, preventDefault: vi.fn(),
          ...(frameAvailable ? { frame: { url: app.url } } : { initiator: { url: app.url } }) };
        sender.emit('will-frame-navigate', event);
        expect(event.preventDefault.mock.calls.length).toBe(allowed ? 0 : 1);
        if (allowed) expect(await appResource(new Request(destination))).toMatchObject({ status: 200 });
      }
    }
    // An external child navigating from about:blank must not revoke its parent.
    sender.emit('will-frame-navigate', { url: 'https://example.test/', isMainFrame: false,
      frame: { url: 'about:blank' }, initiator: { url: app.url }, preventDefault: vi.fn() });
    expect(await runtime.call(uid, sender.id, app.token, 'read', 'storage.get', { key: 'draft' })).toEqual({ value: 'Retained' });
  });
  it('allows external document navigation while revoking only the departing SDK instance', async () => {
    const { createArtifact } = await import('../../../src/main/features/chat_artifacts');
    const { runtime, appResource } = await import('../../../src/main/features/web_apps/host');
    const { webAppInvokeHandlers } = await import('../../../src/main/ipc/web_apps');
    const created = await createArtifact(uid, 'navigation-test', 'agent', { files: [
      { path: 'index.html', content: '<h1>Website launcher</h1>' },
      { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: ['storage'] }) },
    ] });
    if (!created.ok) throw new Error(created.error);
    const liveFrames: any[] = [];
    const sender = Object.assign(new EventEmitter(), { id: 10, isDestroyed: () => false, mainFrame: { framesInSubtree: liveFrames } });
    const open = () => webAppInvokeHandlers['webApps.open'](
      { source: { cid: 'navigation-test', artifactId: created.artifactId } }, { userId: uid, sender: sender as any },
    ) as Promise<any>;
    const sibling = await open();
    for (const [url, allowed] of [
      ['https://www.baidu.com/', true], ['http://example.test:8080/page?q=1#section', true],
      ['file:///private/local.html', false], ['data:text/html,local', false],
      ['javascript:alert(1)', false], ['chat-app://saved/foreign/index.html', false],
      ['https://user:password@example.test/', false], ['https://', false],
    ] as const) {
      for (const frameAvailable of [true, false]) {
        const app = await open();
        await runtime.call(uid, sender.id, app.token, 'before', 'host.getContext', {});
        const frame = { url: app.url, frameTreeNodeId: liveFrames.length + 1, processId: 20, routingId: liveFrames.length + 1 };
        liveFrames.push(frame);
        sender.emit('did-frame-navigate', {}, app.url, 200, 'OK', false, frame.processId, frame.routingId);
        const event = { url, isMainFrame: false, preventDefault: vi.fn(),
          ...(frameAvailable ? { frame } : { initiator: frame }) };
        sender.emit('will-frame-navigate', event);
        expect(event.preventDefault.mock.calls.length, url).toBe(allowed ? 0 : 1);
        if (allowed) {
          // A navigation attempt may become a download or be aborted.
          expect(await runtime.call(uid, sender.id, app.token, 'download-still-open', 'storage.keys', {})).toEqual({ keys: [] });
          // A committed document can have new process/routing IDs.
          frame.url = url; frame.processId = 30; frame.routingId += 1000;
          sender.emit('did-frame-navigate', {}, url, 200, 'OK', false, frame.processId, frame.routingId);
          await expect(runtime.call(uid, sender.id, app.token, 'after', 'storage.keys', {})).rejects.toMatchObject({ code: 'E_CLOSED' });
          expect(await appResource(new Request(app.url))).toEqual({ status: 403 });
        } else {
          expect(await runtime.call(uid, sender.id, app.token, 'after', 'storage.keys', {})).toEqual({ keys: [] });
          expect(await appResource(new Request(app.url))).toMatchObject({ status: 200 });
        }
      }
    }
    expect(await runtime.call(uid, sender.id, sibling.token, 'still-open', 'storage.keys', {})).toEqual({ keys: [] });
    const reopened = await open();
    expect(await runtime.call(uid, sender.id, reopened.token, 'fresh', 'storage.keys', {})).toEqual({ keys: [] });
  });
  it('reads real global Library chunks and cannot adopt a project through caller arguments', async () => {
    const kb = await import('../../../src/main/features/kb_vector');
    const embedding = Array(512).fill(0); embedding[0] = 1;
    await kb.upsertFile(uid, { relPath: 'notes.md', kind: 'text', bytes: 18, mtime: 1, sha1: 'fixture',
      chunks: [{ title: 'Note', content: 'Authorized global note', embedding }] });
    const { appTools } = await import('../../../src/main/features/web_apps/host');
    const tools = await appTools(uid); expect(tools.map(t => t.name)).toEqual(['library']);
    const result = await tools[0].execute({ action: 'read', scope: 'global', path: 'notes.md' }, new AbortController().signal);
    expect(result).toMatchObject({ content: expect.stringContaining('Authorized global note') });
    expect(result).not.toHaveProperty('observations');
    await expect(tools[0].execute({ action: 'read', scope: 'project', path: 'notes.md' }, new AbortController().signal)).rejects.toMatchObject({ code: 'E_INPUT' });
  });
  it('keeps connector action confirmation and live disabled-tool visibility at the owning executor', async () => {
    connector.instances = [{ id: 'gmail', display_name: 'Gmail', transport: { kind: 'streamable-http', url: 'https://example.invalid/mcp' },
      enabled_subtools: null, tools_cache: [{ name: 'GMAIL_SEND_EMAIL', description: 'Send email', input_schema: { type: 'object' } }],
      status: { kind: 'connected', since: 0 }, created_at: '', updated_at: '', tools_cached_at: Date.now() }];
    const { appTools } = await import('../../../src/main/features/web_apps/host');
    const appUsage = { id: 'host-owned-open', owner: 9 };
    const tools = await appTools(uid, appUsage);
    expect(tools.map(t => t.name)).toEqual(['library', 'list_connector_tools', 'call_connector_tool']);
    const invoke = tools.find(t => t.name === 'call_connector_tool')!;
    const request = { connector_id: 'gmail', tool_name: 'GMAIL_SEND_EMAIL', args: {} };
    const result = await invoke.execute(request, new AbortController().signal);
    expect(result).toMatchObject({ isError: true }); expect(connector.approve).toHaveBeenCalledTimes(1);
    expect(connector.call).not.toHaveBeenCalled();
    expect(connector.approve).toHaveBeenCalledWith(expect.objectContaining({ appUsage, userId: uid, cid: undefined }));
    connector.approve.mockResolvedValueOnce(true);
    expect(await invoke.execute(request, new AbortController().signal)).toMatchObject({ content: expect.stringContaining('Verified remote result') });
    expect(connector.call).toHaveBeenCalledTimes(1);
    connector.instances[0].enabled_subtools = [];
    expect(await invoke.execute(request, new AbortController().signal)).toMatchObject({ isError: true });
    expect(connector.call).toHaveBeenCalledTimes(1);
    connector.instances[0].status = { kind: 'disconnected' };
    expect(await appTools(uid)).toHaveLength(1);
  });
  it.each([9_000, 110_000])('returns complete Web connector output without applying model-context budgets (%s tokens)', async (tokens) => {
    connector.instances = [{ id: 'reader', display_name: 'Reader', transport: { kind: 'streamable-http', url: 'https://example.invalid/mcp' },
      enabled_subtools: null, tools_cache: [{ name: 'READ_REPORT', description: 'Read report', input_schema: { type: 'object' } }],
      status: { kind: 'connected', since: 0 }, created_at: '', updated_at: '', tools_cached_at: Date.now() }];
    connector.approve.mockResolvedValueOnce(true);
    connector.call.mockResolvedValueOnce({ content: [{ type: 'text', text: 'x'.repeat(tokens * 4) }] });
    const { appTools } = await import('../../../src/main/features/web_apps/host');
    const invoke = (await appTools(uid)).find(tool => tool.name === 'call_connector_tool')!;
    const result = invoke.execute({ connector_id: 'reader', tool_name: 'READ_REPORT', args: {} }, new AbortController().signal);
    expect(await result).toEqual({ content: 'x'.repeat(tokens * 4) });
    expect(connector.call).toHaveBeenCalledOnce();
  });
  it('keeps legacy URLs and binds SDK resources to the launch revision', async () => {
    const artifact = await import('../../../src/main/features/chat_artifacts');
    const { openApp, appResource, runtime } = await import('../../../src/main/features/web_apps/host');
    const files = [{ path: 'index.html', content: '<h1>Original</h1>' }];
    const old: any = (await artifact.createArtifact(uid, 'cid-test', 'agent', { title: 'Legacy', files }));
    expect(old.ok).toBe(true);
    const oldFile: any = artifact.resolveArtifactFilePath(uid, 'cid-test', old.artifactId, 'index.html');
    const oldMeta = path.join(path.dirname(oldFile.absPath), '__orkas-meta.json');
    const metadata = JSON.parse(fs.readFileSync(oldMeta, 'utf8')); delete metadata.browserStorage;
    fs.writeFileSync(oldMeta, JSON.stringify(metadata));
    const legacy = (await openApp(uid, 1, { cid: 'cid-test', artifactId: old.artifactId }));
    expect(legacy).not.toHaveProperty('token'); expect(legacy).toMatchObject({ entry: 'index.html' });
    expect(legacy.url).toBe(`chat-app://cid/cid-test/${old.artifactId}/index.html`);
    const copied = await (await import('../../../src/main/features/saved_apps')).saveFromArtifact(uid, 'cid-test', old.artifactId);
    if (!copied.ok) throw new Error(copied.error);
    expect(await openApp(uid, 1, { appId: copied.id })).toMatchObject({ browserOnly: true, url: expect.stringMatching(/^chat-app:\/\/a-/) });
    const created: any = (await artifact.createArtifact(uid, 'cid-test', 'agent', { title: 'SDK', files: [...files,
      { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: ['storage'] }) }] }));
    const app: any = (await openApp(uid, 1, { cid: 'cid-test', artifactId: created.artifactId }));
    expect(await appResource(new Request(app.url))).toMatchObject({ status: 200, source: 'chat_app_artifact' });
    const sdk: any = await appResource(new Request(new URL('/__orkas/sdk.js', app.url)));
    expect(sdk.body).toContain('"ai.generate"'); expect(sdk.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(await appResource(new Request(app.url, { headers: { Origin: 'chat-app://foreign' } }))).toEqual({ status: 403 });
    const file: any = artifact.resolveArtifactFilePath(uid, 'cid-test', created.artifactId, 'index.html');
    fs.writeFileSync(file.absPath, '<h1>Replaced code</h1>');
    await expect(runtime.call(uid, 1, app.token, 'stale', 'storage.keys', {})).rejects.toMatchObject({ code: 'E_CLOSED' });
    expect(await appResource(new Request(app.url))).toEqual({ status: 403 });
  });
  it.each([
    ['artifact', 'write'], ['saved', 'write'], ['artifact', 'resource'], ['saved', 'resource'], ['artifact', 'submit'],
  ] as const)('revokes %s authority at the %s boundary after a same-length source edit', async (kind, boundary) => {
    const artifacts = await import('../../../src/main/features/chat_artifacts');
    const saved = await import('../../../src/main/features/saved_apps');
    const { openApp, appResource, runtime } = await import('../../../src/main/features/web_apps/host');
    const created = await artifacts.createArtifact(uid, 'content-revision', 'agent', { files: [
      { path: 'index.html', content: '<h1>Before</h1>' },
      { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: ['storage'] }) },
    ] });
    if (!created.ok) throw new Error(created.error);
    const copy = await saved.saveFromArtifact(uid, 'content-revision', created.artifactId);
    if (!copy.ok) throw new Error(copy.error);
    const source = kind === 'saved' ? { appId: copy.id } : { cid: 'content-revision', artifactId: created.artifactId };
    const file = kind === 'saved' ? saved.resolveSavedAppFilePath(uid, copy.id, 'index.html')
      : artifacts.resolveArtifactFilePath(uid, 'content-revision', created.artifactId, 'index.html');
    if (!file.ok) throw new Error(file.error);
    const before = fs.readFileSync(file.absPath, 'utf8');
    const after = before.replace('Before', 'After!');
    expect(after).not.toBe(before);
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    const restore = freezeFileMetadata([file.absPath]);
    try {
      const app: any = await openApp(uid, 1, source);
      expect(await runtime.call(uid, 1, app.token, 'before', 'storage.set', { key: 'value', value: 'KEEP' })).toEqual({ saved: true });
      expect(await appResource(new Request(app.url))).toMatchObject({ status: 200 });
      if (boundary === 'submit') expect(await runtime.canSubmitArtifact(uid, 1, app.token)).toBe(true);
      fs.writeFileSync(file.absPath, after);
      expect(fs.readFileSync(file.absPath, 'utf8')).toBe(after);
      if (boundary === 'resource') expect(await appResource(new Request(app.url))).toEqual({ status: 403 });
      else if (boundary === 'submit') expect(await runtime.canSubmitArtifact(uid, 1, app.token)).toBe(false);
      else await expect(runtime.call(uid, 1, app.token, 'after', 'storage.set', { key: 'value', value: 'WRONG' }))
          .rejects.toMatchObject({ code: 'E_CLOSED' });
      await expect(runtime.call(uid, 1, app.token, 'still-closed', 'storage.keys', {})).rejects.toMatchObject({ code: 'E_CLOSED' });
      expect(await appResource(new Request(app.url))).toEqual({ status: 403 });
      const reopened: any = await openApp(uid, 1, source);
      expect(await runtime.call(uid, 1, reopened.token, 'read', 'storage.get', { key: 'value' })).toEqual({ value: 'KEEP' });
    } finally { restore(); }
  });
});


it('isolates new ordinary objects and accounts with short stable origins and no SDK authority', async () => {
  const artifacts = await import('../../../src/main/features/chat_artifacts');
  const saved = await import('../../../src/main/features/saved_apps');
  const { openApp, appResource, runtime } = await import('../../../src/main/features/web_apps/host');
  const users = await import('../../../src/main/features/users');
  const paths = await import('../../../src/main/paths');
  const sources: any[] = [];
  for (const cid of ['same-task', 'same-task', 'other-task']) {
    const a = await artifacts.createArtifact(uid, cid, 'agent', { files: [{ path: 'index.html', content: '<h1>Ordinary</h1>' }] });
    if (!a.ok) throw new Error(a.error);
    sources.push({ cid, artifactId: a.artifactId });
  }
  const copy = await saved.saveFromArtifact(uid, sources[0].cid, sources[0].artifactId);
  if (!copy.ok) throw new Error(copy.error);
  sources.push({ appId: copy.id });
  const apps: any[] = [];
  for (const source of sources) {
    const app: any = await openApp(uid, 1, source); apps.push(app);
    expect(new URL(app.url).host).toMatch(/^a-[a-f0-9]{20}$/);
    expect(app.url.length).toBeLessThan(50);
    expect(app).toMatchObject({ browserOnly: true });
    expect(app).not.toHaveProperty('sdkVersion');
    expect(await appResource(new Request(app.url))).toMatchObject({ status: 200 });
    expect(await appResource(new Request(new URL('__orkas/bridge.js', app.url)))).toMatchObject({ status: 200, body: artifacts.BRIDGE_JS });
    for (const rel of ['__orkas/sdk.js', '__orkas/capabilities.json'])
      expect(await appResource(new Request(new URL(rel, app.url)))).toMatchObject({ status: 403 });
    expect(await appResource(new Request(app.url, { headers: { Origin: 'chat-app://cid' } }))).toMatchObject({ status: 403 });
    await expect(runtime.call(uid, 1, app.token, 'probe', 'host.getContext', {})).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
    expect(() => runtime.cancel(uid, 1, app.token, 'probe')).toThrow('E_UNAVAILABLE');
    const second: any = await openApp(uid, 2, source);
    runtime.close(uid, 1, app.token);
    expect(second.url).toBe(app.url);
    expect(await appResource(new Request(second.url))).toMatchObject({ status: 200 });
    runtime.close(uid, 2, second.token);
    expect(await appResource(new Request(second.url))).toMatchObject({ status: 403 });
    expect((await openApp(uid, 1, source)).url).toBe(app.url);
  }
  expect(new Set(apps.map(a => new URL(a.url).host)).size).toBe(4);
  const other = 'other-browser-account';
  fs.mkdirSync(path.dirname(paths.savedAppDir(other, copy.id)), { recursive: true });
  fs.cpSync(paths.savedAppDir(uid, copy.id), paths.savedAppDir(other, copy.id), { recursive: true });
  users.activateUser(other);
  expect(await appResource(new Request(apps[3].url))).toMatchObject({ status: 403 });
  const foreign: any = await openApp(other, 1, { appId: copy.id });
  expect(foreign.url).not.toBe(apps[3].url);
  users.activateUser(uid);
  expect(await appResource(new Request(foreign.url))).toMatchObject({ status: 403 });
  expect((await openApp(uid, 1, { appId: copy.id })).url).toBe(apps[3].url);
});
