import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

const connector = vi.hoisted(() => ({ instances: [] as any[], call: vi.fn(async () => ({ content: [{ type: 'text', text: 'Verified remote result' }] })), approve: vi.fn(async () => false) }));
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
        if (allowed) expect(appResource(new Request(destination))).toMatchObject({ status: 200 });
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
    const sender = Object.assign(new EventEmitter(), { id: 10, isDestroyed: () => false });
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
        const event = { url, isMainFrame: false, preventDefault: vi.fn(),
          ...(frameAvailable ? { frame: { url: app.url } } : { initiator: { url: app.url } }) };
        sender.emit('will-frame-navigate', event);
        expect(event.preventDefault.mock.calls.length, url).toBe(allowed ? 0 : 1);
        if (allowed) {
          await expect(runtime.call(uid, sender.id, app.token, 'after', 'storage.keys', {})).rejects.toMatchObject({ code: 'E_CLOSED' });
          expect(appResource(new Request(app.url))).toEqual({ status: 403 });
        } else {
          expect(await runtime.call(uid, sender.id, app.token, 'after', 'storage.keys', {})).toEqual({ keys: [] });
          expect(appResource(new Request(app.url))).toMatchObject({ status: 200 });
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
    const legacy = (await openApp(uid, 1, { cid: 'cid-test', artifactId: old.artifactId }));
    expect(legacy).not.toHaveProperty('token'); expect(legacy).toMatchObject({ entry: 'index.html' });
    const created: any = (await artifact.createArtifact(uid, 'cid-test', 'agent', { title: 'SDK', files: [...files,
      { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: ['storage'] }) }] }));
    const app: any = (await openApp(uid, 1, { cid: 'cid-test', artifactId: created.artifactId }));
    expect(appResource(new Request(app.url))).toMatchObject({ status: 200, source: 'chat_app_artifact' });
    const sdk: any = appResource(new Request(new URL('/__orkas/sdk.js', app.url)));
    expect(sdk.body).toContain('"ai.generate"'); expect(sdk.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(appResource(new Request(app.url, { headers: { Origin: 'chat-app://foreign' } }))).toEqual({ status: 403 });
    const file: any = artifact.resolveArtifactFilePath(uid, 'cid-test', created.artifactId, 'index.html');
    fs.writeFileSync(file.absPath, '<h1>Replaced code</h1>');
    await expect(runtime.call(uid, 1, app.token, 'stale', 'storage.keys', {})).rejects.toMatchObject({ code: 'E_CLOSED' });
    expect(appResource(new Request(app.url))).toEqual({ status: 403 });
  });
});
