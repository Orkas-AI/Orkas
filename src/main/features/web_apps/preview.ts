/** Offline authoring preview: real SDK/runtime, temporary storage, no account services. */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session, WebContents } from 'electron';
import { getLanguage } from '../config';
import { SRC_ROOT } from '../../paths';
import { serveFileRange } from '../../util/http-range';
import { isPathAllowed } from '../../util/path-sandbox';
import { mimeFor } from '../chat_artifacts';
import { bundleRevision } from './bundle-revision';
import { MANIFEST_FILE, manifestSchema } from './catalog';
import { AppError, WebAppRuntime, type Bundle } from './runtime';
import { appResource } from './resources';

export const previewPreload = path.join(SRC_ROOT, 'main/features/web_apps/preview-preload.js');
export interface PreviewSdkEvidence {
  mode: 'preview';
  storage: 'temporary';
  unavailableCapabilities: string[];
  calls: Array<{ method: string; code: string }>;
}

/** Absence preserves legacy HTML; an invalid opt-in must never downgrade. */
export function previewBundle(entry: string): Bundle | null {
  const root = path.dirname(entry);
  const manifestPath = path.join(root, MANIFEST_FILE);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(manifestPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.size > 16 * 1024) throw new AppError('E_MANIFEST');
  let manifest: unknown;
  try { manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))); }
  catch { throw new AppError('E_MANIFEST'); }
  let revision: ReturnType<typeof bundleRevision>;
  try { revision = bundleRevision(root, [entry, manifestPath]); }
  catch { throw new AppError('E_BUNDLE'); }
  return { key: 'preview', title: 'HTML preview', entry: path.basename(entry), manifest,
    valid: () => revision.valid(),
    resolve(rel) {
      if (!rel || rel.includes('\\') || rel.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) return null;
      const file = path.resolve(root, rel);
      if (!isPathAllowed(file, [root])) return null;
      try {
        if (!fs.lstatSync(file).isFile() || !isPathAllowed(fs.realpathSync(file), [root]) || !revision.accept(file)) return null;
        return { absPath: file, mime: mimeFor(file) };
      } catch { return null; }
    },
  };
}

export async function createPreviewSdk(ses: Session, contents: WebContents, bundle: Bundle) {
  const storageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orkas-preview-storage-'));
  // This identity belongs only to this in-memory runtime; no account is created/read.
  const uid = 'preview';
  const unavailable = (): never => { throw new AppError('E_UNAVAILABLE'); };
  const runtime = new WebAppRuntime({ activeUser: () => uid, language: getLanguage, modelAvailable: () => false,
    pick: unavailable, save: unavailable, generate: unavailable, tools: unavailable,
  }, { storageRoot });
  const pending = new Set<Promise<unknown>>();
  const evidence: PreviewSdkEvidence = { mode: 'preview', storage: 'temporary',
    unavailableCapabilities: ['files', 'ai', 'library', 'connectors'], calls: [] };
  let open: ReturnType<WebAppRuntime['open']>;
  let installed = false;
  const channel = 'orkas.web-app-preview';
  let listener: ((event: Electron.IpcMainEvent, channel: string, request: unknown) => void) | undefined;
  async function dispose() {
    runtime.closeOwner(contents.id);
    if (listener) contents.removeListener('ipc-message', listener);
    await Promise.allSettled([...pending]);
    if (installed) { ses.protocol.unhandle('chat-app'); installed = false; }
    await fsp.rm(storageRoot, { recursive: true, force: true });
  }
  try {
    open = runtime.open(uid, contents.id, bundle);
    const url = new URL(open.url);
    const origin = url.protocol + '//' + url.host;
    const bridge = fs.readFileSync(path.join(SRC_ROOT, 'renderer/modules/web-app-host.js'), 'utf8');
    const shellUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${origin}">
      <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>
      </head><body><iframe title="Application preview" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"></iframe>
      <script>${bridge}</script></body></html>`);
    listener = (async (event: Electron.IpcMainEvent, received: string, request: any) => {
      if (received !== channel || event.senderFrame !== contents.mainFrame || contents.getURL() !== shellUrl) return;
      if (!request || !/^[0-9]{1,12}$/.test(request.id) || request.payload?.token !== open.token) return;
      const reply = (ev: unknown) => {
        try {
          if (!contents.isDestroyed() && event.senderFrame && !event.senderFrame.detached) event.senderFrame.send(channel, { id: request.id, event: ev });
        } catch { /* A closing frame has no reply recipient. */ }
      };
      const payload = request.payload;
      const run = async () => {
        try {
          let value: unknown;
          if (request.operation === 'webApps.close') { runtime.close(uid, contents.id, open.token); value = { closed: true }; }
          else if (request.operation === 'webApps.cancel') { runtime.cancel(uid, contents.id, open.token, payload.requestId); value = { cancelled: true }; }
          else if (request.operation === 'webApps.call') {
            value = await runtime.call(uid, contents.id, open.token, payload.requestId, payload.method, payload.args,
              value => reply({ type: 'progress', value }));
            if (evidence.calls.length < 64) evidence.calls.push({ method: payload.method, code: 'OK' });
          } else throw new AppError('E_METHOD');
          reply({ type: 'result', ok: true, value });
        } catch (error) {
          const code = error instanceof AppError ? error.code : 'E_FAILED';
          if (request.operation === 'webApps.call' && evidence.calls.length < 64) evidence.calls.push({ method: String(payload.method).slice(0, 64), code });
          reply({ type: 'result', ok: false, value: { code } });
        }
      };
      const task = run(); pending.add(task);
      try { await task; } finally { pending.delete(task); }
    });
    contents.on('ipc-message', listener);
    contents.on('will-frame-navigate', event => {
      if (event.isMainFrame) { event.preventDefault(); return; }
      // After the initial attach every navigation revokes this preview instance.
      if (event.frame?.url && event.frame.url !== 'about:blank') {
        event.preventDefault(); runtime.closeOwner(contents.id);
      } else if (event.url !== open.url) event.preventDefault();
    });
    ses.protocol.handle('chat-app', async request => {
      const resource = appResource(request, runtime);
      if (!resource || resource.status !== 200) return new Response(null, { status: resource?.status ?? 403 });
      try {
        if ('body' in resource) return new Response(resource.body, { headers: { ...resource.headers, 'Content-Type': resource.mime } });
        const stat = await fsp.stat(resource.file);
        const response = serveFileRange(request, resource.file, resource.mime, stat.size, stat.mtimeMs);
        const headers = new Headers(response.headers);
        for (const [key, value] of Object.entries(resource.headers)) headers.set(key, value);
        return new Response(response.body, { status: response.status, headers });
      } catch { return new Response(null, { status: 404 }); }
    });
    installed = true;
    return { shellUrl, origin, evidence, dispose,
      async attach() {
        await contents.executeJavaScript(`new Promise((resolve, reject) => {
          const frame = document.querySelector('iframe');
          frame.addEventListener('load', resolve, { once: true });
          frame.addEventListener('error', () => reject(new Error('Preview frame load failed')), { once: true });
          window.OrkasWebAppHost.attach(frame, ${JSON.stringify(open)});
        })`);
        const frame = contents.mainFrame.frames.find(frame => frame.url === open.url);
        if (!frame) throw new AppError('E_BUNDLE');
        return frame;
      },
    };
  } catch (error) { await dispose(); throw error; }
}
