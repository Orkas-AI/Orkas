import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HostAdapters, WebAppRuntime } from '../../../src/main/features/web_apps/runtime';

let runtime: WebAppRuntime;
beforeEach(() => vi.resetModules());
afterEach(() => { runtime?.closeOwner(1); vi.doUnmock('../../../src/main/features/web_apps/host'); });

async function setup(generate: HostAdapters['generate'], activeUser = () => 'user') {
  const { WebAppRuntime, AppError } = await import('../../../src/main/features/web_apps/runtime');
  runtime = new WebAppRuntime({ activeUser, language: () => 'en', modelAvailable: () => true,
    pick: async () => null, save: async () => null, tools: async () => [], generate });
  vi.doMock('../../../src/main/features/web_apps/host', () => ({ runtime,
    openApp: vi.fn(), safeFailure: (error: unknown) => ({ code: error instanceof AppError ? error.code : 'E_FAILED' }) }));
  const { webAppCall } = await import('../../../src/main/ipc/web_apps');
  const open = () => runtime.open(activeUser(), 1, { key: 'stream-test', title: 'Stream', entry: 'index.html',
    manifest: { sdkVersion: 1, capabilities: ['ai'] }, resolve: () => null });
  const ctx = () => ({ userId: activeUser(), sender: { id: 1 } as any });
  const call = (token: string, requestId: string, signal = new AbortController().signal) =>
    webAppCall({ token, requestId, method: 'ai.generate', args: { prompt: 'Report' } }, ctx(), signal);
  return { open, call, webAppCall, ctx };
}

async function collect(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

it('cancels a producer that outruns the progress consumer without replay and keeps the next request usable', async () => {
  let resume!: () => void;
  let observedSignal!: AbortSignal;
  const generate = vi.fn(async (_uid, _args, signal, progress) => {
    observedSignal = signal;
    progress({ text: 'First' });
    await new Promise<void>(resolve => { resume = resolve; });
    for (let i = 0; i < 129; i++) progress({ text: String(i) });
    return { text: 'Must not complete after overflow' };
  });
  const { open, call, webAppCall, ctx } = await setup(generate);
  const app = open();
  const stream = call(app.token, 'burst');
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
  for await (const event of webAppCall({ token: app.token, requestId: 'recovered', method: 'host.getContext', args: {} }, ctx(), new AbortController().signal)) recovered.push(event);
  expect(recovered).toEqual([{ type: 'result', ok: true, value: { language: 'en', sdkVersion: 1 } }]);
});

it('admits submission only from a live local artifact owned by the active account and window', async () => {
  const { WebAppRuntime } = await import('../../../src/main/features/web_apps/runtime');
  let active = 'user';
  let valid = true;
  runtime = new WebAppRuntime({ activeUser: () => active, language: () => 'en', modelAvailable: () => true,
    pick: async () => null, save: async () => null, tools: async () => [], generate: vi.fn() });
  vi.doMock('../../../src/main/features/web_apps/host', () => ({ runtime, openApp: vi.fn(), safeFailure: () => ({ code: 'E_FAILED' }) }));
  const { webAppInvokeHandlers } = await import('../../../src/main/ipc/web_apps');
  const check = (token: string, userId = 'user', owner = 1) => webAppInvokeHandlers['webApps.canSubmitArtifact'](
    { token }, { userId, sender: { id: owner } as any });
  const bundle = { key: 'artifact', title: 'Form', entry: 'index.html', kind: 'artifact' as const, appType: 'local' as const,
    manifest: { sdkVersion: 1, capabilities: [] }, valid: () => valid, resolve: () => null };
  const local = runtime.open('user', 1, bundle);
  expect(await check(local.token)).toEqual({ allowed: true });
  expect(await check(local.token, 'foreign')).toEqual({ allowed: false });
  expect(await check(local.token, 'user', 99)).toEqual({ allowed: false });
  for (const app of [runtime.open('user', 1, { ...bundle, kind: 'saved' }),
    runtime.open('user', 1, { ...bundle, appType: 'web' })])
    expect(await check(app.token)).toEqual({ allowed: false });
  active = 'foreign'; expect(await check(local.token)).toEqual({ allowed: false });
  active = 'user'; expect(await check(local.token)).toEqual({ allowed: true });
  valid = false; expect(await check(local.token)).toEqual({ allowed: false });
  valid = true; expect(await check(local.token)).toEqual({ allowed: false });
  const reopened = runtime.open('user', 1, bundle);
  expect(await check(reopened.token)).toEqual({ allowed: true });
  await runtime.call('user', 1, reopened.token, 'revoke', 'permissions.revoke', {});
  expect(await check(reopened.token)).toEqual({ allowed: false });
});

it.each(['cancel', 'close', 'account-switch'] as const)('emits one cancellation terminal and discards a late result after %s', async action => {
  let uid = 'user';
  let resume!: () => void;
  let observedSignal!: AbortSignal;
  const generate = vi.fn<HostAdapters['generate']>(async (_uid, _args, signal, progress) => {
    observedSignal = signal;
    progress({ text: 'Accepted progress' });
    await new Promise<void>(resolve => { resume = resolve; });
    // Simulate a dependency that completes despite cancellation.
    return { text: 'Late private result' };
  });
  const { open, call, webAppCall, ctx } = await setup(generate, () => uid);
  const app = open();
  const controller = new AbortController();
  const stream = call(app.token, 'departing', controller.signal);
  expect((await stream.next()).value).toEqual({ type: 'progress', value: { text: 'Accepted progress' } });
  if (action === 'cancel') controller.abort();
  else if (action === 'close') runtime.close('user', 1, app.token);
  else { uid = 'other'; runtime.closeUser('user'); }
  expect(observedSignal.aborted).toBe(true);
  resume();
  expect(await collect(stream)).toEqual([{ type: 'result', ok: false, value: { code: 'E_CANCELLED' } }]);
  expect(generate).toHaveBeenCalledOnce();
  const recovered = action === 'cancel' ? app : open();
  expect(await collect(webAppCall({ token: recovered.token, requestId: 'recovered', method: 'host.getContext', args: {} },
    ctx(), new AbortController().signal))).toEqual([{ type: 'result', ok: true, value: { language: 'en', sdkVersion: 1 } }]);
});

it('aborts the producer when the IPC consumer leaves and does not replay its request', async () => {
  let observedSignal!: AbortSignal;
  const generate = vi.fn<HostAdapters['generate']>(async (_uid, _args, signal, progress) => {
    observedSignal = signal;
    progress({ text: 'Started' });
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return { text: 'Discarded' };
  });
  const { open, call } = await setup(generate);
  const app = open();
  const stream = call(app.token, 'abandoned');
  await stream.next();
  expect(await stream.return(undefined)).toEqual({ done: true, value: undefined });
  expect(observedSignal.aborted).toBe(true);
  expect(await collect(call(app.token, 'abandoned'))).toEqual([{ type: 'result', ok: false, value: { code: 'E_DUPLICATE' } }]);
  expect(generate).toHaveBeenCalledOnce();
});

it.each(['signal', 'tombstone', 'credential', 'owner'] as const)('rejects %s before invoking a side-effecting adapter and keeps an independent request usable', async rejection => {
  const generate = vi.fn(async () => ({ text: 'Explicit new request' }));
  const { open, call, webAppCall, ctx } = await setup(generate);
  const app = open();
  const controller = new AbortController();
  if (rejection === 'signal') controller.abort();
  if (rejection === 'tombstone') runtime.cancel('user', 1, app.token, 'blocked');
  const events = await collect(webAppCall({ token: rejection === 'credential' ? 'invalid' : app.token,
    requestId: 'blocked', method: 'ai.generate', args: { prompt: 'Report' } },
    rejection === 'owner' ? { userId: 'user', sender: { id: 2 } as any } : ctx(), controller.signal));
  const codes = { signal: 'E_CANCELLED', tombstone: 'E_DUPLICATE', credential: 'E_INPUT', owner: 'E_CLOSED' };
  expect(events).toEqual([{ type: 'result', ok: false, value: { code: codes[rejection] } }]);
  expect(generate).not.toHaveBeenCalled();
  expect(await collect(call(app.token, 'fresh'))).toEqual([{ type: 'result', ok: true, value: { text: 'Explicit new request' } }]);
  expect(generate).toHaveBeenCalledOnce();
});

it('scopes cancellation and duplicate IDs to the originating app instance', async () => {
  const generate = vi.fn(async () => ({ text: 'Sibling result' }));
  const { open, call } = await setup(generate);
  const first = open(), sibling = open();
  runtime.cancel('user', 1, first.token, 'same-id');
  expect(await collect(call(first.token, 'same-id'))).toEqual([{ type: 'result', ok: false, value: { code: 'E_DUPLICATE' } }]);
  expect(await collect(call(sibling.token, 'same-id'))).toEqual([{ type: 'result', ok: true, value: { text: 'Sibling result' } }]);
  expect(await collect(call(sibling.token, 'same-id'))).toEqual([{ type: 'result', ok: false, value: { code: 'E_DUPLICATE' } }]);
  expect(generate).toHaveBeenCalledOnce();
});

it.each(['cancel', 'close', 'account-switch'] as const)('does not dispatch after %s during asynchronous source validation', async action => {
  let uid = 'user', release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const generate = vi.fn(async () => ({ text: 'Must not run' }));
  const { open, call, webAppCall, ctx } = await setup(generate, () => uid);
  let first = true;
  const app = runtime.open(uid, 1, { key: 'guarded', title: 'Guarded', entry: 'index.html',
    manifest: { sdkVersion: 1, capabilities: ['ai'] }, resolve: () => null,
    valid: async () => { if (first) { first = false; entered(); await gate; } return true; } });
  const pending = collect(call(app.token, 'guarded'));
  await started;
  if (action === 'cancel') runtime.cancel('user', 1, app.token, 'guarded');
  else if (action === 'close') runtime.close('user', 1, app.token);
  else { uid = 'other'; runtime.closeUser('user'); }
  release();
  expect(await pending).toEqual([{ type: 'result', ok: false, value: { code: 'E_CANCELLED' } }]);
  expect(generate).not.toHaveBeenCalled();
  const recovered = action === 'cancel' ? app : open();
  expect(await collect(webAppCall({ token: recovered.token, requestId: 'fresh', method: 'host.getContext', args: {} },
    ctx(), new AbortController().signal))).toMatchObject([{ type: 'result', ok: true }]);
});
