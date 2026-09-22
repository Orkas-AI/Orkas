import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WebAppRuntime } from '../../../src/main/features/web_apps/runtime';

let runtime: WebAppRuntime;
beforeEach(() => vi.resetModules());
afterEach(() => { runtime?.closeOwner(1); vi.doUnmock('../../../src/main/features/web_apps/host'); });

it('cancels a producer that outruns the progress consumer without replay and keeps the next request usable', async () => {
  const { WebAppRuntime, AppError } = await import('../../../src/main/features/web_apps/runtime');
  let resume!: () => void;
  let observedSignal!: AbortSignal;
  const generate = vi.fn(async (_uid, _args, signal, progress) => {
    observedSignal = signal;
    progress({ text: 'First' });
    await new Promise<void>(resolve => { resume = resolve; });
    for (let i = 0; i < 129; i++) progress({ text: String(i) });
    return { text: 'Must not complete after overflow' };
  });
  runtime = new WebAppRuntime({ activeUser: () => 'user', language: () => 'en', modelAvailable: () => true,
    pick: async () => null, save: async () => null, tools: async () => [], generate });
  vi.doMock('../../../src/main/features/web_apps/host', () => ({ runtime,
    openApp: vi.fn(), safeFailure: (error: unknown) => ({ code: error instanceof AppError ? error.code : 'E_FAILED' }) }));
  const { webAppCall } = await import('../../../src/main/ipc/web_apps');
  const app = runtime.open('user', 1, { key: 'stream-test', title: 'Stream', entry: 'index.html',
    manifest: { sdkVersion: 1, capabilities: ['ai'] }, resolve: () => null });
  const ctx = { userId: 'user', sender: { id: 1 } as any };
  const stream = webAppCall({ token: app.token, requestId: 'burst', method: 'ai.generate', args: { prompt: 'Report' } }, ctx, new AbortController().signal);
  expect((await stream.next()).value).toEqual({ type: 'progress', value: { text: 'First' } });
  resume();
  await new Promise(resolve => setImmediate(resolve));
  const events = [];
  for await (const event of stream) events.push(event);
  expect(events.filter(event => event.type === 'progress')).toHaveLength(128);
  expect(events.at(-1)).toMatchObject({ type: 'result', ok: false, value: { code: 'E_CANCELLED' } });
  expect(observedSignal.aborted).toBe(true);
  expect(generate).toHaveBeenCalledOnce();
  const recovered = [];
  for await (const event of webAppCall({ token: app.token, requestId: 'recovered', method: 'host.getContext', args: {} }, ctx, new AbortController().signal)) recovered.push(event);
  expect(recovered).toEqual([{ type: 'result', ok: true, value: { language: 'en', sdkVersion: 1 } }]);
});
