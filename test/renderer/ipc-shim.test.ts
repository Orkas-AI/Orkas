import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadShim(streamImpl: (...args: any[]) => { promise: Promise<void>; cancel: () => void }) {
  const monitorError = vi.fn();
  const sandbox: any = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    ReadableStream,
    fetch: vi.fn(),
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    window: {
      Monitor: { error: monitorError },
      orkas: {
        invoke: vi.fn(),
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
    expect(monitorError).toHaveBeenCalledWith('ipc_stream', expect.any(Object));
  });
});
