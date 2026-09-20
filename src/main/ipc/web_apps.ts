import type { WebContents } from 'electron';
import { z } from 'zod';
import { catalogDocument } from '../features/web_apps/catalog';
import { runtime, openApp, safeFailure } from '../features/web_apps/host';
import { AppError } from '../features/web_apps/runtime';

type Context = { userId: string; sender: WebContents };
const sourceSchema = z.union([
  z.object({ appId: z.string().min(1).max(64) }).strict(),
  z.object({ cid: z.string().min(1).max(128), artifactId: z.string().min(1).max(64) }).strict(),
]);
const owners = new WeakSet<WebContents>();
function bindOwner(sender: WebContents) {
  if (owners.has(sender)) return;
  owners.add(sender);
  sender.once('destroyed', () => runtime.closeOwner(sender.id));
  sender.on('render-process-gone', () => runtime.closeOwner(sender.id));
  sender.on('will-frame-navigate', event => {
    if (event.isMainFrame) runtime.closeOwner(sender.id);
    else {
      // Electron can omit frame for cross-process/document navigation.
      const source = [event.frame?.url, event.initiator?.url]
        .find(url => url?.startsWith('chat-app://app-'));
      if (source) {
        event.preventDefault();
        runtime.closeOrigin(sender.id, source);
      }
    }
  });
}
function credential(payload: any): string {
  if (!payload || typeof payload.token !== 'string' || !/^[a-f0-9]{32}$/.test(payload.token)) throw new AppError('E_INPUT');
  return payload.token;
}
function failure(err: unknown) { const value = safeFailure(err); return { ok: false, error: value.message, code: value.code }; }
export const webAppInvokeHandlers = {
  'webApps.catalog': async () => ({ catalog: catalogDocument() }),
  'webApps.open': async (payload: any, ctx: Context) => {
    try {
      const parsed = sourceSchema.safeParse(payload?.source);
      if (!parsed.success) throw new AppError('E_INPUT');
      bindOwner(ctx.sender);
      return openApp(ctx.userId, ctx.sender.id, parsed.data as any);
    } catch (err) { return failure(err); }
  },
  'webApps.close': async (payload: any, ctx: Context) => {
    try { runtime.close(ctx.userId, ctx.sender.id, credential(payload)); return {}; } catch (err) { return failure(err); }
  },
  'webApps.cancel': async (payload: any, ctx: Context) => {
    try { runtime.cancel(ctx.userId, ctx.sender.id, credential(payload), payload.requestId); return {}; } catch (err) { return failure(err); }
  },
};
export async function* webAppCall(payload: any, ctx: Context, signal: AbortSignal): AsyncGenerator<any> {
  let token: string;
  try { token = credential(payload); } catch (err) { yield { type: 'result', ok: false, value: safeFailure(err) }; return; }
  if (signal.aborted) { yield { type: 'result', ok: false, value: safeFailure(new AppError('E_CANCELLED')) }; return; }
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  let settled = false;
  const emit = (event: any) => { queue.push(event); wake?.(); wake = null; };
  const cancel = () => { try { runtime.cancel(ctx.userId, ctx.sender.id, token, payload.requestId); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  const work = runtime.call(ctx.userId, ctx.sender.id, token, payload.requestId, payload.method, payload.args, value => {
    if (queue.length >= 128) { cancel(); throw new AppError('E_LIMIT'); }
    emit({ type: 'progress', value });
  }).then(value => emit({ type: 'result', ok: true, value }), err => emit({ type: 'result', ok: false, value: safeFailure(err) }))
    .finally(() => { settled = true; wake?.(); wake = null; });
  try {
    while (!settled || queue.length) {
      if (queue.length) yield queue.shift();
      else await new Promise<void>(resolve => { wake = resolve; });
    }
  } finally { signal.removeEventListener('abort', cancel); if (!settled) cancel(); await work; }
}
