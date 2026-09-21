import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { previewBundle } from '../../../src/main/features/web_apps/preview';

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
    expect(bundle.valid!()).toBe(true);
    fs.writeFileSync(entry, '<h1>Changed</h1>');
    expect(bundle.valid!()).toBe(false); expect(bundle.resolve('index.html')).toBeNull();
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
