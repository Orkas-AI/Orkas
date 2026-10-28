import type { WebContents } from 'electron';
import { z } from 'zod';
import { catalogDocument } from '../features/web_apps/catalog';
import { runtime, openApp, safeFailure } from '../features/web_apps/host';
import { AppError } from '../features/web_apps/runtime';
import { safeExternalHttpUrl } from '../util/window-security';

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
  // FrameTreeNode identity survives a cross-process document replacement.
  // Track committed app documents, never a URL merely proposed for download.
  const documents = new Map<number, string>();
  sender.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame, processId, routingId) => {
    if (isMainFrame) { documents.clear(); runtime.closeOwner(sender.id); return; }
    const frames = sender.mainFrame.framesInSubtree;
    const current = frames.find(frame => frame.processId === processId && frame.routingId === routingId);
    const live = new Set(frames.map(frame => frame.frameTreeNodeId));
    for (const [node, source] of documents) {
      if (!live.has(node)) { documents.delete(node); runtime.closeOrigin(sender.id, source); }
    }
    if (!current) return;
    const node = current.frameTreeNodeId, previous = documents.get(node);
    if (previous && (new URL(previous).protocol !== new URL(url).protocol || new URL(previous).host !== new URL(url).host)) runtime.closeOrigin(sender.id, previous);
    if (url.startsWith('chat-app://app-')) documents.set(node, url);
    else documents.delete(node);
  });
  sender.on('will-frame-navigate', event => {
    if (event.isMainFrame) runtime.closeOwner(sender.id);
    else {
      // Electron can omit frame for cross-process/document navigation.
      const source = event.frame ? event.frame.url : event.initiator?.url;
      if (source?.startsWith('chat-app://app-')) {
        if (runtime.canNavigate(sender.id, source, event.url)) {
          runtime.cancelOriginRequests(sender.id, source);
          return;
        }
        // Rejected navigation leaves the current document usable. Only an
        // actual departure to a website revokes this application's authority.
        if (!safeExternalHttpUrl(event.url)) event.preventDefault();
        // Actual departure is handled by did-frame-navigate above.
      }
    }
  });
}
function credential(payload: any): string {
  if (!payload || typeof payload.token !== 'string' || !/^[a-f0-9]{32}$/.test(payload.token)) throw new AppError('E_INPUT');
  return payload.token;
}
function failure(err: unknown) { const value = safeFailure(err); return { ...value, ok: false, error: value.message }; }
export const webAppInvokeHandlers = {
  'webApps.catalog': async () => ({ catalog: catalogDocument() }),
  'webApps.open': async (payload: any, ctx: Context) => {
    try {
      const parsed = sourceSchema.safeParse(payload?.source);
      if (!parsed.success) throw new AppError('E_INPUT');
      bindOwner(ctx.sender);
      const opened = await openApp(ctx.userId, ctx.sender.id, parsed.data as any);
      if (ctx.sender.isDestroyed()) {
        runtime.closeOwner(ctx.sender.id);
        throw new AppError('E_CLOSED');
      }
      return opened;
    } catch (err) { return failure(err); }
  },
  'webApps.canSubmitArtifact': async (payload: any, ctx: Context) => {
    try { return { allowed: await runtime.canSubmitArtifact(ctx.userId, ctx.sender.id, credential(payload)) }; }
    catch { return { allowed: false }; }
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
