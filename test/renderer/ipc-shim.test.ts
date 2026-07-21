import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadShim(
  streamImpl: (...args: any[]) => { promise: Promise<void>; cancel: () => void },
  invokeImpl: (...args: any[]) => Promise<any> = vi.fn(),
) {
  const monitorError = vi.fn();
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
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
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
  return { apiFetch: sandbox.apiFetch as Function, monitorError };
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

  it('still reports unexpected stream failures', async () => {
    const boom = new Error('boom');
    const { apiFetch, monitorError } = loadShim(() => ({
      promise: Promise.reject(boom),
      cancel: () => {},
    }));

    const res = await apiFetch('/api/conversations/c1/events/stream', { method: 'POST' });
    const reader = res.body.getReader();

    await expect(reader.read()).rejects.toThrow('boom');
    expect(monitorError).not.toHaveBeenCalled();
  });
});

describe('ipc-shim invoke results', () => {
  const idleStream = () => ({ promise: Promise.resolve(), cancel: () => {} });

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
    const { apiFetch, monitorError } = loadShim(idleStream, invoke);

    const response = await apiFetch('/api/conversations/list');

    expect(response.ok).toBe(false);
    expect(monitorError).not.toHaveBeenCalled();
  });
});
