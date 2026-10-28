import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { previewBundle } from '../../../src/main/features/web_apps/preview';
import { freezeFileMetadata } from '../../helpers/frozen-file-metadata';

let root: string, entry: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-preview-bundle-test-'));
  entry = path.join(root, 'app/index.html'); fs.mkdirSync(path.dirname(entry));
  fs.writeFileSync(entry, '<h1>Preview</h1>');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const manifest = (text = '{"sdkVersion":1,"capabilities":["storage"]}') => fs.writeFileSync(path.join(path.dirname(entry), 'orkas-app.json'), text);

describe('preview source opt-in and revision isolation', () => {
  it('preserves ordinary HTML and fails closed for invalid or unsupported opt-ins', async () => {
    expect((await previewBundle(entry))).toBeNull();
    for (const text of ['{', '{"sdkVersion":2,"capabilities":[]}', ' '.repeat(16385)]) {
      manifest(text); await expect(previewBundle(entry)).rejects.toThrow('E_MANIFEST');
    }
  });
  it('rejects entry replacement while collecting the launch inventory', async () => {
    manifest();
    const opening = previewBundle(entry);
    fs.writeFileSync(entry, '<h1>Replaced during launch</h1>');
    await expect(opening).rejects.toThrow('E_BUNDLE');
  });
  it('serves only the frozen bundle and invalidates calls after loaded source changes', async () => {
    manifest(); const bundle = (await previewBundle(entry))!;
    expect(bundle.resolve('index.html')).toEqual({ absPath: entry, mime: 'text/html; charset=utf-8' });
    for (const rel of ['../private.txt', '/private.txt', 'dir/../../private.txt', '.env', 'dir\\file']) expect(bundle.resolve(rel)).toBeNull();
    expect(await bundle.valid!()).toBe(true);
    fs.writeFileSync(entry, '<h1>Changed</h1>');
    expect(await bundle.valid!()).toBe(false); expect(bundle.resolve('index.html')).toBeNull();
  });
  it('rejects linked manifests, sibling files and linked assets before launching', async () => {
    const outside = path.join(root, 'outside.json'); fs.writeFileSync(outside, '{"sdkVersion":1,"capabilities":[]}');
    fs.symlinkSync(outside, path.join(path.dirname(entry), 'orkas-app.json'));
    await expect(previewBundle(entry)).rejects.toThrow('E_MANIFEST');
    fs.unlinkSync(path.join(path.dirname(entry), 'orkas-app.json')); manifest();
    fs.symlinkSync(outside, path.join(path.dirname(entry), 'asset.json'));
    await expect(previewBundle(entry)).rejects.toThrow('E_BUNDLE');
  });
});

it('rejects changed preview content at the actual protocol boundary despite identical metadata', async () => {
  const { EventEmitter } = await import('node:events');
  const { createPreviewSdk } = await import('../../../src/main/features/web_apps/preview');
  manifest();
  const restore = freezeFileMetadata([entry]);
  const contents: any = Object.assign(new EventEmitter(), { id: 20, mainFrame: {}, isDestroyed: () => false });
  let resource!: (request: Request) => Promise<Response>;
  const session: any = { protocol: { handle: (_scheme: string, handler: typeof resource) => { resource = handler; }, unhandle() {} } };
  let preview: Awaited<ReturnType<typeof createPreviewSdk>> | undefined;
  try {
    preview = await createPreviewSdk(session, contents, (await previewBundle(entry))!);
    expect((await resource(new Request(preview.origin + '/index.html'))).status).toBe(200);
    fs.writeFileSync(entry, '<h1>Changed</h1>');
    expect((await resource(new Request(preview.origin + '/index.html'))).status).toBe(403);
  } finally { try { await preview?.dispose(); } finally { restore(); } }
});

it('accepts only its own trusted frame, token and narrow operations, then revokes resources and deletes storage', async () => {
  const { EventEmitter } = await import('node:events');
  const { createPreviewSdk } = await import('../../../src/main/features/web_apps/preview');
  manifest();
  const contents: any = new EventEmitter();
  const replies: any[] = [];
  const frame = { detached: false, send: (_channel: string, value: unknown) => replies.push(value) };
  let url = '';
  Object.assign(contents, { id: 19, mainFrame: frame, getURL: () => url, isDestroyed: () => false });
  let resource: ((request: Request) => Promise<Response>) | undefined;
  const ses: any = { protocol: {
    handle: (_scheme: string, handler: typeof resource) => { resource = handler; },
    unhandle: () => { resource = undefined; },
  } };
  const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('orkas-preview-storage-')).sort();
  const preview = await createPreviewSdk(ses, contents, (await previewBundle(entry))!);
  try {
    url = preview.shellUrl;
    expect((await resource!(new Request(preview.origin + '/__orkas/sdk.js'))).status).toBe(200);
    const policy = (await resource!(new Request(preview.origin + '/index.html'))).headers.get('Content-Security-Policy')!;
    expect(policy).toContain("connect-src 'self' http: https: ws: wss:");
    expect(policy).toContain("script-src 'self' http: https: 'unsafe-inline'");
    expect((await resource!(new Request(preview.origin + '/index.html', { headers: { Origin: 'chat-app://foreign' } }))).status).toBe(403);
    expect((await resource!(new Request('chat-app://app-00000000000000000000000000000000/index.html'))).status).toBe(403);
    const message = { id: '1', operation: 'auth.getConfig', payload: { token: 'forged', requestId: 'q1', method: 'storage.set', args: { key: 'x', value: 'forged' } } };
    contents.emit('ipc-message', { senderFrame: frame }, 'orkas.invoke', message);
    contents.emit('ipc-message', { senderFrame: frame }, 'orkas.web-app-preview', message);
    contents.emit('ipc-message', { senderFrame: { ...frame } }, 'orkas.web-app-preview', message);
    await new Promise(resolve => setImmediate(resolve));
    expect(replies).toEqual([]); expect(preview.evidence.calls).toEqual([]);
    let prevented = false;
    contents.emit('will-frame-navigate', { isMainFrame: false, frame: { url: preview.origin + '/index.html' },
      url: 'https://example.invalid/', preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect((await resource!(new Request(preview.origin + '/__orkas/sdk.js'))).status).toBe(200);
  } finally { await preview.dispose(); }
  expect(resource).toBeUndefined(); expect(contents.listenerCount('ipc-message')).toBe(0);
  expect(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('orkas-preview-storage-')).sort()).toEqual(before);
});

it('settles the current bundle document after local navigation and rejects foreign or revoked frames', async () => {
  const { EventEmitter } = await import('node:events');
  const { createPreviewSdk } = await import('../../../src/main/features/web_apps/preview');
  manifest();
  fs.writeFileSync(path.join(path.dirname(entry), 'second.html'), '<h1>Second page</h1>');
  const contents: any = new EventEmitter();
  Object.assign(contents, { id: 20, mainFrame: { frames: [] }, isDestroyed: () => false });
  const ses: any = { protocol: { handle() {}, unhandle() {} } };
  const preview = await createPreviewSdk(ses, contents, (await previewBundle(entry))!);
  let painted = 0;
  const foreign = { url: 'https://example.invalid/second.html', executeJavaScript() { throw new Error('Foreign frame executed'); } };
  const current = { url: preview.origin + '/second.html', async executeJavaScript() { painted++; } };
  try {
    contents.mainFrame.frames = [foreign];
    await expect(preview.settle()).rejects.toThrow('E_BUNDLE');
    contents.mainFrame.frames.push(current);
    await preview.settle();
    expect(painted).toBe(1);
  } finally { await preview.dispose(); }
  await expect(preview.settle()).rejects.toThrow('E_BUNDLE');
});

it('waits for SDK requests and chained results still in transit before finishing authoring evidence', async () => {
  const { EventEmitter } = await import('node:events');
  const { createPreviewSdk } = await import('../../../src/main/features/web_apps/preview');
  manifest('{"sdkVersion":1,"capabilities":["files"]}');
  const contents: any = new EventEmitter();
  const outgoing: any[] = [], replies: any[] = [];
  const events = new Map<string, (event?: any) => void>();
  const paints: Array<() => void> = [];
  const parent = { postMessage: (message: unknown) => outgoing.push(message) };
  const window: any = { parent, addEventListener: (name: string, listener: (event?: any) => void) => events.set(name, listener) };
  const context = vm.createContext({ window, parent, crypto: webcrypto, setTimeout, clearTimeout,
    requestAnimationFrame: (callback: () => void) => paints.push(callback) });
  const frame: any = { detached: false, frames: [], send: (_channel: string, value: any) => replies.push(value) };
  let token = '', resource!: (request: Request) => Promise<Response>;
  Object.assign(contents, { id: 32, mainFrame: frame, isDestroyed: () => false,
    executeJavaScript: async (script: string) => {
      const opened = JSON.parse(/attach\(frame, (\{.*?\})\);/s.exec(script)![1]);
      token = opened.token;
      frame.frames = [{ url: opened.url, executeJavaScript: (source: string) => vm.runInContext(source, context) }];
    } });
  const preview = await createPreviewSdk({ protocol: {
    handle: (_scheme: string, handler: typeof resource) => { resource = handler; }, unhandle() {},
  } } as any, contents, (await previewBundle(entry))!);
  const paint = async () => {
    for (const callback of paints.splice(0)) callback();
    await new Promise(resolve => setImmediate(resolve));
  };
  try {
    contents.getURL = () => preview.shellUrl;
    await preview.attach();
    vm.runInContext(await (await resource(new Request(preview.origin + '/__orkas/sdk.js'))).text(), context);
    const journey = vm.runInContext(`(async () => {
      const catalog = await window.orkasApp.call('capabilities.list');
      try { await window.orkasApp.call('files.pick', {}); }
      catch (error) { window.outcome = { available: catalog.methods.find(method => method.name === 'files.pick').available, code: error.code }; }
    })()`, context);
    let settled = false;
    const settling = preview.settle().then(() => { settled = true; });
    // The first request has left the document but has not reached main IPC.
    await paint(); await paint();
    const finishedBeforeRequestDelivery = settled;
    let finishedBeforeReplyDelivery = false;
    for (let sequence = 1; sequence <= 2; sequence++) {
      await expect.poll(() => outgoing.length).toBe(1);
      const request = outgoing.shift();
      contents.emit('ipc-message', { senderFrame: frame }, 'orkas.web-app-preview', {
        id: String(sequence), operation: 'webApps.call',
        payload: { token, requestId: request.id, method: request.method, args: structuredClone(request.args) },
      });
      await expect.poll(() => replies.length).toBe(1);
      // The runtime has finished, but the SDK promise and its continuation have not.
      await paint(); await paint();
      finishedBeforeReplyDelivery ||= settled;
      const reply = replies.shift().event;
      events.get('message')!({ source: parent, data: { __orkasApp: 1, id: request.id, ...reply } });
      await new Promise(resolve => setImmediate(resolve));
    }
    await journey;
    for (let i = 0; i < 4 && !settled; i++) await paint();
    expect(settled).toBe(true);
    await settling;
    expect(finishedBeforeRequestDelivery).toBe(false);
    expect(finishedBeforeReplyDelivery).toBe(false);
    expect(window.outcome).toEqual({ available: false, code: 'E_UNAVAILABLE' });
    expect(preview.evidence.calls).toEqual([
      { method: 'capabilities.list', code: 'OK' }, { method: 'files.pick', code: 'E_UNAVAILABLE' },
    ]);
  } finally { events.get('pagehide')?.(); await preview.dispose(); }
});

it('keeps preview data in disposable storage: writes are readable during the session and leave no files afterwards', async () => {
  const { EventEmitter } = await import('node:events');
  const { createPreviewSdk } = await import('../../../src/main/features/web_apps/preview');
  const data = { version: 1, tables: [{ id: 'notes', name: 'notes', fields: [{ id: 'body', name: 'body', type: 'string' }], access: { read: ['body'], insert: ['body'], count: true } }] };
  manifest(JSON.stringify({ sdkVersion: 1, capabilities: ['data'], data }));
  const workspace = process.env.ORKAS_WORKSPACE_ROOT!;
  const inventory = (dir: string) => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : [];
  const temporary = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('orkas-preview-storage-')).sort();
  const workspaceBefore = inventory(workspace), sourceBefore = inventory(path.dirname(entry)), tempBefore = temporary();
  const session = async () => {
    const contents: any = new EventEmitter(), replies: any[] = [];
    const frame: any = { detached: false, frames: [], send: (_channel: string, value: any) => replies.push(value) };
    let token = '';
    Object.assign(contents, { id: 31, mainFrame: frame, isDestroyed: () => false,
      // attach() hands the trusted shell its instance; capture it like the shell would.
      executeJavaScript: async (script: string) => { const opened = JSON.parse(/attach\(frame, (\{.*?\})\);/s.exec(script)![1]); token = opened.token; frame.frames = [{ url: opened.url }]; } });
    const preview = await createPreviewSdk({ protocol: { handle() {}, unhandle() {} } } as any, contents, (await previewBundle(entry))!);
    contents.getURL = () => preview.shellUrl; await preview.attach();
    let sequence = 0;
    const invoke = async (method: string, args: unknown) => {
      const id = String(++sequence);
      contents.emit('ipc-message', { senderFrame: frame }, 'orkas.web-app-preview', { id, operation: 'webApps.call', payload: { token, requestId: 'r' + id, method, args } });
      for (let tries = 0; tries < 500 && !replies.some(reply => reply.id === id); tries++) await new Promise(resolve => setTimeout(resolve, 5));
      return replies.find(reply => reply.id === id)?.event;
    };
    return { preview, invoke };
  };
  const first = await session();
  let created: string[] = [];
  try {
    expect(await first.invoke('data.insert', { table: 'notes', values: { body: 'preview only' } })).toMatchObject({ type: 'result', ok: true });
    expect(await first.invoke('data.query', { table: 'notes' })).toEqual({ type: 'result', ok: true, value: { records: [{ body: 'preview only' }] } });
    created = temporary().filter(name => !tempBefore.includes(name));
    expect(created.length).toBeGreaterThan(0);
  } finally { await first.preview.dispose(); }
  // Compare only this session's directories so concurrent suites cannot interfere.
  expect(temporary().filter(name => created.includes(name))).toEqual([]);
  expect(inventory(workspace)).toEqual(workspaceBefore);
  expect(inventory(path.dirname(entry))).toEqual(sourceBefore);
  const second = await session();
  try { expect(await second.invoke('data.count', { table: 'notes' })).toEqual({ type: 'result', ok: true, value: { count: 0 } }); }
  finally { await second.preview.dispose(); }
});
