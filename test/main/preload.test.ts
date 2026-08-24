import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';


const source = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.js'), 'utf8');

type PushSubscriptionInspection = {
  channels: string[];
  nonLiteralCalls: string[];
};

function inspectRendererPushSubscriptions(
  filePath: string,
  fileSource: string,
): PushSubscriptionInspection {
  const sourceFile = ts.createSourceFile(
    filePath,
    fileSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const channels: string[] = [];
  const nonLiteralCalls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'onPushEvent'
    ) {
      const receiver = node.expression.expression.getText(sourceFile);
      if (receiver === 'orkas' || receiver === 'window.orkas') {
        const channel = node.arguments[0];
        if (channel && ts.isStringLiteralLike(channel)) {
          channels.push(channel.text);
        } else {
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          nonLiteralCalls.push(`${filePath}:${location.line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { channels, nonLiteralCalls };
}

function productionRendererPushSubscriptions(): PushSubscriptionInspection {
  const rendererRoot = path.join(process.cwd(), 'src/renderer');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(entryPath);
    }
  };
  walk(rendererRoot);

  const channels = new Set<string>();
  const nonLiteralCalls: string[] = [];
  for (const filePath of files.sort()) {
    const relativePath = path.relative(rendererRoot, filePath);
    const inspected = inspectRendererPushSubscriptions(
      relativePath,
      fs.readFileSync(filePath, 'utf8'),
    );
    for (const channel of inspected.channels) channels.add(channel);
    nonLiteralCalls.push(...inspected.nonLiteralCalls);
  }
  return { channels: [...channels].sort(), nonLiteralCalls };
}

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

  it('allows approval push channels, rejects exact-channel near misses, and contains handler failures', () => {
    const { api, emit } = loadPreload();
    const bashHandler = vi.fn(() => { throw new Error('renderer callback failed'); });
    const bashCancelledHandler = vi.fn();
    const bridgeHandler = vi.fn();
    const interactiveCliHandler = vi.fn();

    api.onPushEvent('bash:permission', bashHandler);
    api.onPushEvent('bash:permission_cancelled', bashCancelledHandler);
    api.onPushEvent('bridge:permission', bridgeHandler);
    api.onPushEvent('interactive-cli:event', interactiveCliHandler);

    expect(() => emit('bash:permission', { request_id: 'bash-1' })).not.toThrow();
    emit('bash:permission_cancelled', { request_ids: ['bash-1'] });
    emit('bridge:permission', { request_id: 'bridge-1' });
    emit('interactive-cli:event', { session_id: 'session-1', kind: 'prompt' });
    expect(bashHandler).toHaveBeenCalledOnce();
    expect(bashCancelledHandler).toHaveBeenCalledWith({ request_ids: ['bash-1'] });
    expect(bridgeHandler).toHaveBeenCalledWith({ request_id: 'bridge-1' });
    expect(interactiveCliHandler).toHaveBeenCalledWith({ session_id: 'session-1', kind: 'prompt' });
  });

  it('delivers materialized media through the exact preview channel and rejects near misses', () => {
    const { api, emit } = loadPreload();
    const handler = vi.fn();

    api.onPushEvent('conversation:media_materialized', handler);
    expect(() => api.onPushEvent('conversation:media_materialized:private', vi.fn())).toThrow(/not allowed/);

    const payload = {
      user_id: 'user-1',
      conversation_id: 'conversation-1',
      remote_url: 'https://cdn.example/result.png',
      local_url: 'chat-media://cid/conversation-1/result.png',
      media_kind: 'image',
    };
    emit('conversation:media_materialized', payload);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('keeps every production renderer push subscription authorized by the real preload policy', () => {
    const negativeControl = inspectRendererPushSubscriptions(
      'negative-control.js',
      [
        "window.orkas.onPushEvent('known:literal', handler);",
        'window.orkas.onPushEvent(dynamicChannel, handler);',
      ].join('\n'),
    );
    expect(negativeControl.channels).toEqual(['known:literal']);
    expect(negativeControl.nonLiteralCalls).toEqual(['negative-control.js:2']);

    const { api } = loadPreload();
    const inspected = productionRendererPushSubscriptions();
    expect(inspected.nonLiteralCalls).toEqual([]);
    expect(inspected.channels).toContain('conversation:media_materialized');

    const rejected: Array<{ channel: string; error: string }> = [];
    for (const channel of inspected.channels) {
      try {
        api.onPushEvent(channel, vi.fn())();
      } catch (error) {
        rejected.push({
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    expect(rejected).toEqual([]);
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
