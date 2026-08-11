import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadShim(
  streamImpl: (...args: any[]) => { promise: Promise<void>; cancel: () => void },
  invokeImpl: (...args: any[]) => Promise<any> = vi.fn(),
) {
  const monitorError = vi.fn();
  const loggerWarn = vi.fn();
  const sandbox: any = {
    console,
    URL,
    URLSearchParams,
    ArrayBuffer,
    Uint8Array,
    TextEncoder,
    ReadableStream,
    btoa,
    fetch: vi.fn(),
    createLogger: () => ({ warn: loggerWarn, info() {}, error() {} }),
    window: {
      Monitor: { error: monitorError },
      orkas: {
        invoke: invokeImpl,
        stream: streamImpl,
      },
    },
  };
  sandbox.Monitor = sandbox.window.Monitor;
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/ipc-shim.js'), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'ipc-shim.js' });
  return { apiFetch: sandbox.apiFetch as Function, monitorError, loggerWarn };
}

describe('ipc-shim streams', () => {
  it('closes renderer-cancelled streams without reporting ipc_stream errors', async () => {
    let rejectStream: (err: Error) => void = () => {};
    const { apiFetch, monitorError } = loadShim(() => ({
      promise: new Promise<void>((_resolve, reject) => { rejectStream = reject; }),
      cancel: () => {
        const err = Object.assign(new Error('stream cancelled'), { name: 'AbortError' });
        rejectStream(err);
      },
    }));
    const controller = new AbortController();

    const res = await apiFetch('/api/conversations/c1/events/stream', {
      method: 'POST',
      signal: controller.signal,
    });
    const reader = res.body.getReader();

    controller.abort();

    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true });
    expect(monitorError).not.toHaveBeenCalled();
  });

  it('surfaces unexpected stream failures without exposing raw bridge errors', async () => {
    const boom = new Error('boom');
    const { apiFetch, monitorError } = loadShim(() => ({
      promise: Promise.reject(boom),
      cancel: () => {},
    }));

    const res = await apiFetch('/api/conversations/c1/events/stream', { method: 'POST' });
    const reader = res.body.getReader();

    await expect(reader.read()).rejects.toThrow('ipc stream failed');
    expect(monitorError).not.toHaveBeenCalled();
  });
});

describe('ipc-shim invoke results', () => {
  const idleStream = () => ({ promise: Promise.resolve(), cancel: () => {} });

  it('routes compact conversation-turn pages independently from history', async () => {
    const invoke = vi.fn(async () => ({ ok: true, turns: [], total: 0 }));
    const { apiFetch } = loadShim(idleStream, invoke);

    const response = await apiFetch(
      '/api/conversations/c1/turns?limit=15&before=20&project_id=p1',
    );

    expect(response.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('conversations.turns', {
      cid: 'c1',
      limit: '15',
      before: '20',
      project_id: 'p1',
    });
  });

  it('does not classify expected business failures as IPC transport errors', async () => {
    const invoke = vi.fn(async () => ({ ok: false, error: 'conversation not found', code: 'E_NOT_FOUND' }));
    const { apiFetch, monitorError } = loadShim(idleStream, invoke);

    const response = await apiFetch('/api/conversations/c1/history');

    await expect(response.json()).resolves.toMatchObject({ ok: false, code: 'E_NOT_FOUND' });
    expect(monitorError).not.toHaveBeenCalled();
  });

  it('does not classify upload validation results as IPC transport errors', async () => {
    const invoke = vi.fn(async () => ({ ok: false, error: 'binary too large', code: 'E_TOO_LARGE' }));
    const { apiFetch, monitorError } = loadShim(idleStream, invoke);

    const response = await apiFetch('/api/contexts/upload', {
      method: 'POST',
      headers: { 'X-Filename': 'large.bin' },
      body: new Uint8Array([1, 2, 3]),
    });

    await expect(response.json()).resolves.toMatchObject({ ok: false, code: 'E_TOO_LARGE' });
    expect(monitorError).not.toHaveBeenCalled();
  });

  it('returns a failed response for rejected bridge invocations', async () => {
    const invoke = vi.fn(async () => { throw new Error('bridge disconnected'); });
    const { apiFetch, monitorError, loggerWarn } = loadShim(idleStream, invoke);

    const response = await apiFetch('/api/conversations/list');

    expect(response.ok).toBe(false);
    expect(monitorError).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith('IPC bridge failure', expect.objectContaining({
      kind: 'ipc_invoke',
      channel: 'conversations.list',
      error_name: 'Error',
    }));
  });

  it('collapses repeated bridge failures for the same channel and cause', async () => {
    const invoke = vi.fn(async () => { throw Object.assign(new Error('disconnected'), { code: 'E_PIPE' }); });
    const { apiFetch, monitorError, loggerWarn } = loadShim(idleStream, invoke);

    await apiFetch('/api/conversations/list');
    await apiFetch('/api/conversations/list');

    expect(monitorError).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith('IPC bridge failure', {
      kind: 'ipc_invoke',
      channel: 'conversations.list',
      error_name: 'Error',
      error_code: 'E_PIPE',
    });
  });

  it('uploads only the selected typed-array bytes and accepts Fetch Headers casing', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const { apiFetch } = loadShim(idleStream, invoke);
    const backing = new Uint8Array([9, 1, 2, 8]);

    const response = await apiFetch('/api/contexts/upload', {
      method: 'POST',
      headers: new Headers({ 'x-filename': 'report%20final.bin' }),
      body: backing.subarray(1, 3),
    });

    expect(response.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('contexts.upload', {
      name: 'report final.bin',
      data: 'AQI=',
    });
  });

  it('rejects malformed filename encoding before invoking Main', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const { apiFetch } = loadShim(idleStream, invoke);

    const response = await apiFetch('/api/contexts/upload', {
      method: 'POST',
      headers: { 'x-filename': '%E0%A4%A' },
      body: new Uint8Array([1]),
    });

    expect(response.ok).toBe(false);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'invalid filename encoding' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps decoded path ownership outside body updates', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const { apiFetch } = loadShim(idleStream, invoke);

    await apiFetch('/api/agents/agent%20one/update?force=1', {
      method: 'PUT',
      body: JSON.stringify({ agent_id: 'body-owner', name: 'Updated' }),
    });

    expect(invoke).toHaveBeenCalledWith('agents.update', {
      agent_id: 'agent one',
      updates: { agent_id: 'body-owner', name: 'Updated' },
      force: '1',
    });
  });

  it('turns an empty Main result into a stable failed response', async () => {
    const { apiFetch } = loadShim(idleStream, vi.fn(async () => undefined));

    const response = await apiFetch('/api/conversations/list');

    expect(response).toMatchObject({ ok: false, status: 502 });
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'invalid ipc response' });
  });

  it('does not echo unmatched route identifiers to logs or the UI response', async () => {
    const { apiFetch, monitorError, loggerWarn } = loadShim(idleStream);

    const response = await apiFetch('/api/conversations/private-conversation-id/unknown');
    const body = await response.json();
    const diagnostics = JSON.stringify([monitorError.mock.calls, loggerWarn.mock.calls, body]);

    expect(response.status).toBe(404);
    expect(body).toEqual({ ok: false, error: 'unknown API route' });
    expect(monitorError).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith('IPC bridge failure', {
      kind: 'ipc_unmatched_route',
      channel: 'unmatched',
      method: 'GET',
    });
    expect(diagnostics).not.toContain('private-conversation-id');
  });
});
