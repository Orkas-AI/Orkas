import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';


const source = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.js'), 'utf8');

type Listener = (event: unknown, payload?: unknown) => void;

function loadPreload(bootResponse: unknown = null) {
  const exposed: Record<string, unknown> = {};
  const listeners = new Map<string, Set<Listener>>();
  const ipcRenderer = {
    sendSync: vi.fn(() => bootResponse),
    invoke: vi.fn(async (_channel: string, payload?: unknown) => ({ ok: true, payload })),
    send: vi.fn(),
    on: vi.fn((channel: string, listener: Listener) => {
      const set = listeners.get(channel) || new Set<Listener>();
      set.add(listener);
      listeners.set(channel, set);
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener);
    }),
  };
  const contextBridge = {
    exposeInMainWorld: vi.fn((key: string, value: unknown) => {
      exposed[key] = value;
    }),
  };
  const sandbox = {
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`unexpected require: ${id}`);
      return { contextBridge, ipcRenderer };
    },
    process: { argv: [] as string[] },
    window: { addEventListener: vi.fn() },
    document: { readyState: 'complete' },
    console,
    Date,
    Error,
    Promise,
    Object,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, sandbox, { filename: 'preload.js' });
  const api = exposed.orkas as {
    invoke: (channel: string, payload?: unknown) => Promise<unknown>;
    stream: (channel: string, payload: unknown, onEvent?: (event: unknown) => void) => {
      promise: Promise<void>;
      cancel: () => void;
    };
    onPushEvent: (channel: string, handler: (payload: unknown) => void) => () => void;
    log: (record: unknown) => void;
  };
  const emit = (channel: string, payload?: unknown) => {
    for (const listener of [...(listeners.get(channel) || [])]) listener({}, payload);
  };
  return { api, emit, exposed, ipcRenderer, contextBridge, listeners };
}


describe('preload bridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes a validated synchronous i18n bundle and rejects incomplete boot data', () => {
    const valid = loadPreload({ ok: true, lang: 'zh-CN', tables: { 'zh-CN': { hello: '你好' } } });
    expect(valid.exposed.__orkasI18nBoot).toEqual({
      lang: 'zh-CN', tables: { 'zh-CN': { hello: '你好' } },
    });

    const invalid = loadPreload({ ok: true, lang: 'en', tables: { 'zh-CN': {} } });
    expect(invalid.exposed.__orkasI18nBoot).toBeNull();
  });

  it('routes invokes through one envelope', async () => {
    const { api, ipcRenderer } = loadPreload();

    await api.invoke('feature.read');
    await api.invoke('feature.write', { enabled: true, purge: true });

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, 'orkas.invoke', {
      channel: 'feature.read', payload: {},
    });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, 'orkas.invoke', {
      channel: 'feature.write', payload: { enabled: true, purge: true },
    });
  });

  it('enforces the push-event allow-list and removes the exact listener', () => {
    const { api, emit, ipcRenderer } = loadPreload();
    const handler = vi.fn();

    expect(() => api.onPushEvent('account:session-secret', handler)).toThrow(/not allowed/);
    const unsubscribe = api.onPushEvent('marketplace:changed', handler);
    emit('marketplace:changed', { id: 'a' });
    unsubscribe();
    emit('marketplace:changed', { id: 'b' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ id: 'a' });
    const registered = ipcRenderer.on.mock.calls.find(([channel]) => channel === 'marketplace:changed')?.[1];
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('marketplace:changed', registered);
  });

  it('delivers stream events, resolves on done, and cleans the listener', async () => {
    const { api, emit, ipcRenderer, listeners } = loadPreload();
    const onEvent = vi.fn();
    const stream = api.stream('chat.send', { cid: 'c' }, onEvent);
    const start = ipcRenderer.send.mock.calls[0];
    const request = start[1] as { requestId: string };
    const eventChannel = `stream:${request.requestId}`;

    expect(start[0]).toBe('orkas.streamStart');
    emit(eventChannel, { type: 'delta', text: 'hello' });
    emit(eventChannel, null);
    emit(eventChannel, { type: 'done' });
    await expect(stream.promise).resolves.toBeUndefined();

    expect(onEvent).toHaveBeenCalledWith({ type: 'delta', text: 'hello' });
    expect(listeners.get(eventChannel)?.size || 0).toBe(0);
  });

  it('cancels main work and rejects when an event callback throws', async () => {
    const { api, emit, ipcRenderer, listeners } = loadPreload();
    const stream = api.stream('chat.send', {}, () => { throw new Error('renderer failed'); });
    const request = ipcRenderer.send.mock.calls[0][1] as { requestId: string };
    const eventChannel = `stream:${request.requestId}`;
    const rejected = expect(stream.promise).rejects.toThrow('renderer failed');

    emit(eventChannel, { type: 'delta' });

    await rejected;
    expect(ipcRenderer.send).toHaveBeenCalledWith('orkas.streamCancel', request.requestId);
    expect(listeners.get(eventChannel)?.size || 0).toBe(0);
  });

  it('marks explicit cancellation as AbortError after main confirms done', async () => {
    const { api, emit, ipcRenderer } = loadPreload();
    const stream = api.stream('chat.send', {}, vi.fn());
    const request = ipcRenderer.send.mock.calls[0][1] as { requestId: string };
    const rejected = expect(stream.promise).rejects.toMatchObject({
      name: 'AbortError', message: 'stream cancelled',
    });

    stream.cancel();
    stream.cancel();
    emit(`stream:${request.requestId}`, { type: 'done' });

    await rejected;
    expect(ipcRenderer.send.mock.calls.filter(([channel]) => channel === 'orkas.streamCancel')).toHaveLength(1);
  });

  it('keeps renderer logging failures from escaping to UI code', async () => {
    const { api, ipcRenderer } = loadPreload();
    ipcRenderer.invoke.mockRejectedValueOnce(new Error('main unavailable'));
    expect(() => api.log({ level: 'info' })).not.toThrow();
    await Promise.resolve();

    ipcRenderer.invoke.mockImplementationOnce(() => { throw new Error('bridge unavailable'); });
    expect(() => api.log({ level: 'info' })).not.toThrow();
  });
});
