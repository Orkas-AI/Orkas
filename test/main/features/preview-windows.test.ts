import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const runtime = vi.hoisted(() => ({ windows: [] as any[], hook: null as any, nextId: 0, unsubscribe: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Contents extends EventEmitter {
    id = ++runtime.nextId;
    send = vi.fn();
    setWindowOpenHandler = vi.fn();
    isDestroyed = () => false;
  }
  class Window extends EventEmitter {
    id = ++runtime.nextId;
    webContents = new Contents();
    dead = false;
    show = vi.fn(); focus = vi.fn(); restore = vi.fn();
    isMinimized = () => false;
    isFocusable = () => this.options.focusable !== false;
    isDestroyed = () => this.dead;
    getBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 });
    loadFile = vi.fn(async () => {});
    destroy() { if (!this.dead) { this.dead = true; this.webContents.emit('destroyed'); this.emit('closed'); } }
    constructor(public options: any) { super(); runtime.windows.push(this); }
    static fromWebContents(sender: any) { return runtime.windows.find(w => w.webContents === sender && !w.dead); }
  }
  return { BrowserWindow: Window, shell: { openExternal: vi.fn() }, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) } };
});
vi.mock('../../../src/main/features/user-switch-hooks', () => ({ registerUserSwitchHook: (_name: string, fn: any) => { runtime.hook = fn; } }));
vi.mock('../../../src/main/features/group_chat', () => ({ subscribeBus: () => runtime.unsubscribe }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

import { BrowserWindow } from 'electron';
import { openPreview, initializePreview, closePreview, setPreviewDirty, requestPreviewOwner, resolvePreviewOwner, isPreviewContents, readyPreview, replacePreview } from '../../../src/main/features/preview_windows';

beforeEach(() => {
  for (const win of runtime.windows) win.destroy();
  runtime.windows.length = 0;
  runtime.unsubscribe.mockClear();
});

describe('independent preview ownership and lifecycle', () => {
  it.each([false, true])('inherits owner focusability across every preview kind, including reopening minimized windows: %s', async (focusable) => {
    const sources = [
      { kind: 'app', appId: 'a', title: 'App' },
      { kind: 'file', path: '/fixture/note.md', title: 'Note', options: {} },
      { kind: 'image', src: 'chat-media://local/a.png', title: 'Image', options: {} },
      { kind: 'video', src: 'chat-media://local/a.mp4', title: 'Video', options: {} },
      { kind: 'artifact', cid: 'task', artifactId: 'result', title: 'Result' },
    ];
    for (const source of sources) {
      const main = new BrowserWindow({ focusable });
      const result = await openPreview('user-a', main.webContents, source);
      const child = runtime.windows.at(-1);
      expect(child.options.show).toBe(false);
      expect(child.options.icon).toBe(path.resolve(__dirname, '../../../src/resources/icons/icon.png'));
      expect(child.isFocusable()).toBe(focusable);
      expect(child.show).toHaveBeenCalledTimes(focusable ? 1 : 0);
      expect(child.focus).toHaveBeenCalledTimes(focusable ? 1 : 0);
      if (!focusable) expect(child.options.webPreferences.backgroundThrottling).toBe(false);
      child.isMinimized = () => true;
      expect(await openPreview('user-a', main.webContents, source)).toEqual(result);
      expect(child.restore).toHaveBeenCalledTimes(focusable ? 1 : 0);
      expect(child.show).toHaveBeenCalledTimes(focusable ? 2 : 0);
      expect(child.focus).toHaveBeenCalledTimes(focusable ? 2 : 0);
      expect(initializePreview('user-a', child.webContents).source).toEqual(source);
      main.destroy();
      expect(child.dead).toBe(true);
    }
  });

  it('shares one task preview across sources, preserves cancelled edits and keeps the latest click during loading', async () => {
    const main = new BrowserWindow({});
    const file = { kind: 'file', path: '/fixture/note.md', title: 'Note', options: { cid: 'task-a' } };
    const initial = await openPreview('user-a', main.webContents, file);
    const child = runtime.windows[1];
    readyPreview('user-a', child.webContents);
    setPreviewDirty('user-a', child.webContents, true);
    const image = { kind: 'image', src: 'chat-media://local/a.png', title: 'Image', options: { cid: 'task-b' } };
    expect(await openPreview('user-a', main.webContents, image)).toEqual(initial);
    await replacePreview('user-a', child.webContents, false);
    expect(initializePreview('user-a', child.webContents).source).toEqual(file);
    const close = { preventDefault: vi.fn() }; child.emit('close', close);
    expect(close.preventDefault).toHaveBeenCalledOnce();
    await openPreview('user-a', main.webContents, image);
    await replacePreview('user-a', child.webContents, true);
    expect(initializePreview('user-a', child.webContents).source).toEqual(image);
    await openPreview('user-a', main.webContents, { kind: 'video', src: 'chat-media://local/a.mp4', title: '', options: {} });
    const artifact = { kind: 'artifact', cid: 'task-c', artifactId: 'result', title: 'Result' };
    expect(await openPreview('user-a', main.webContents, artifact)).toEqual(initial);
    readyPreview('user-a', child.webContents);
    await replacePreview('user-a', child.webContents, true);
    expect(initializePreview('user-a', child.webContents).source).toEqual(artifact);
    expect(runtime.windows).toHaveLength(2);
  });

  it('reuses the same application without reloading and gives different applications separate isolated windows', async () => {
    const main = new BrowserWindow({});
    const a = await openPreview('user-a', main.webContents, { kind: 'app', appId: 'a', title: 'App A' });
    const again = await openPreview('user-a', main.webContents, { kind: 'app', appId: 'a', title: 'App A' });
    const b = await openPreview('user-a', main.webContents, { kind: 'app', appId: 'b', title: 'App B' });
    expect(again.windowId).toBe(a.windowId);
    expect(b.windowId).not.toBe(a.windowId);
    const child = runtime.windows[1];
    expect(child.loadFile).toHaveBeenCalledTimes(1);
    expect(child.options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
    expect(child.options).not.toHaveProperty('modal', true);
    main.destroy();
    expect(runtime.windows.every(w => w.dead)).toBe(true);
  });

  it('intercepts only dirty native closes and rejects another account or a child opening privileged previews', async () => {
    const main = new BrowserWindow({});
    await openPreview('user-a', main.webContents, { kind: 'file', path: '/fixture/note.md', title: 'Note', options: {} });
    const child = runtime.windows[1];
    initializePreview('user-a', child.webContents);
    const clean = { preventDefault: vi.fn() };
    child.emit('close', clean);
    expect(clean.preventDefault).not.toHaveBeenCalled();
    setPreviewDirty('user-a', child.webContents, true);
    const dirty = { preventDefault: vi.fn() };
    child.emit('close', dirty);
    expect(dirty.preventDefault).toHaveBeenCalledOnce();
    expect(child.webContents.send).toHaveBeenCalledWith('preview-windows:close-request', {});
    expect(() => closePreview('user-b', child.webContents)).toThrow();
    expect(child.dead).toBe(false);
    await expect(openPreview('user-a', child.webContents, { kind: 'app', appId: 'other', title: '' })).rejects.toThrow();
    closePreview('user-a', child.webContents);
    expect(child.dead).toBe(true);
    expect(isPreviewContents(child.webContents)).toBe(false);
  });

  it('opens more than sixteen apps and releases every window and owner listener on account switch', async () => {
    const main = new BrowserWindow({});
    const sources = Array.from({ length: 20 }, (_, index) => ({ kind: 'app', appId: `app-${index}`, title: `App ${index}` }));
    const opened = [];
    for (const source of sources) opened.push(await openPreview('user-a', main.webContents, source));
    expect(new Set(opened.map(value => value.windowId)).size).toBe(20);
    for (const [index, child] of runtime.windows.slice(1).entries()) {
      expect(initializePreview('user-a', child.webContents).source).toEqual(sources[index]);
      expect(child.dead).toBe(false);
    }
    expect(await openPreview('user-a', main.webContents, sources[0])).toEqual(opened[0]);
    runtime.hook('user-a', 'user-b');
    expect(runtime.windows.slice(1).every(child => child.dead && !isPreviewContents(child.webContents))).toBe(true);
    expect(main.webContents.listenerCount('destroyed')).toBe(0);
    expect(main.webContents.listenerCount('did-start-navigation')).toBe(0);
    const fresh = await openPreview('user-b', main.webContents, sources[0]);
    expect(fresh.windowId).not.toBe(opened[0].windowId);
    expect(initializePreview('user-b', runtime.windows.at(-1).webContents).source).toEqual(sources[0]);
  });

  it('binds gallery pages to the original task, accepts only its owner response, and cancels requests on account switch', async () => {
    const main = new BrowserWindow({});
    const other = new BrowserWindow({});
    await openPreview('user-a', main.webContents, { kind: 'image', src: 'chat-media://local/a.png', title: '', options: { cid: 'original' },
      gallery: { cid: 'original', index: 0, nextCursor: 100, items: [{ key: 'a', src: 'chat-media://local/a.png', alt: 'A' }] } });
    const child = runtime.windows[2];
    initializePreview('user-a', child.webContents);
    const response = requestPreviewOwner('user-a', child.webContents, { kind: 'gallery', before: 100, cid: 'wrong-task' });
    const [, request] = (main.webContents.send as any).mock.calls.at(-1);
    expect(request.source).toEqual({ cid: 'original' });
    resolvePreviewOwner(other.webContents, { requestId: request.requestId, result: { ok: true, items: ['forged'] } });
    resolvePreviewOwner(main.webContents, { requestId: request.requestId, result: { ok: true, items: ['original'] } });
    expect(await response).toEqual({ ok: true, items: ['original'] });
    const interrupted = requestPreviewOwner('user-a', child.webContents, { kind: 'gallery', before: 10 });
    runtime.hook('user-a', 'user-b');
    expect(await interrupted).toEqual({ ok: false });
    expect(child.dead).toBe(true);
    expect(runtime.unsubscribe).toHaveBeenCalledOnce();
  });
});
