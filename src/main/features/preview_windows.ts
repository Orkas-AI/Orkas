import { BrowserWindow, shell, screen, type WebContents } from 'electron';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SRC_ROOT } from '../paths';
import { createLogger } from '../logger';
import { hardenedWebPreferences, installExternalNavigationGuard, installOfflineHtmlPreviewNavigationGuard } from '../util/window-security';
import { registerUserSwitchHook } from './user-switch-hooks';
import { subscribeBus } from './group_chat';

// Host-only window chrome. Generated applications retain the existing iframe
// sandbox and acquire their SDK instance from their own trusted renderer.
const text = z.string().max(8192);
const id = z.string().min(1).max(128);
const options = z.object({
  cid: id.nullish(), projectId: id.nullish(), absPath: text.optional(),
  projectScoped: z.boolean().optional(), autoplay: z.boolean().optional(),
  startTime: z.number().finite().optional(), duration: z.number().finite().optional(), ended: z.boolean().optional(),
}).strict();
const imageItem = z.object({
  key: z.string().max(2 * 1024 * 1024 + 8192), src: z.string().max(2 * 1024 * 1024), alt: text,
  cid: id.nullish(), absPath: text.optional(), attachmentName: text.nullish(),
}).strict();
const gallerySchema = z.object({
  items: z.array(imageItem).max(10000), index: z.number().int().nonnegative(),
  nextCursor: z.number().int().nonnegative().nullable(), cid: id,
}).strict();
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), src: z.string().min(1).max(2 * 1024 * 1024), title: text, options, gallery: gallerySchema.nullish() }).strict(),
  z.object({ kind: z.literal('file'), path: text.min(1), title: text, options }).strict(),
  z.object({ kind: z.literal('video'), src: text.min(1), title: text, options }).strict(),
  z.object({ kind: z.literal('app'), appId: id, title: text }).strict(),
  z.object({ kind: z.literal('artifact'), cid: id, artifactId: id, agentId: text.optional(), title: text }).strict(),
]);
export type PreviewSource = z.infer<typeof sourceSchema>;
type Record = { win: BrowserWindow; owner: WebContents; uid: string; source: PreviewSource; dirty: boolean;
  ready: boolean; next?: PreviewSource; dispose?: () => void };
const records = new Map<number, Record>();
const owners = new Map<WebContents, { windows: Set<BrowserWindow>; dispose: () => void }>();
const log = createLogger('preview-windows');
const pending = new Map<string, { owner: WebContents; preview: number; finish: (value: any) => void }>();

function sourceKey(source: PreviewSource): string {
  if (source.kind === 'app') return JSON.stringify(['app', source.appId]);
  if (source.kind === 'artifact') return JSON.stringify(['artifact', source.cid, source.artifactId]);
  return JSON.stringify([source.kind, source.options.cid, source.options.projectId, source.kind === 'file' ? source.path : source.src]);
}

function owned(uid: string, sender: WebContents): Record {
  const record = records.get(sender.id);
  if (!record || record.uid !== uid || record.win.isDestroyed()) throw new Error('Preview is unavailable.');
  return record;
}

export function isPreviewContents(sender: WebContents): boolean { return records.has(sender.id); }

function cancelOwnerRequests(record: Record) {
  for (const [key, request] of pending) if (request.preview === record.win.id) {
    pending.delete(key); request.finish({ ok: false });
  }
}

export function readyPreview(uid: string, sender: WebContents) {
  const record = owned(uid, sender);
  record.ready = true;
  if (record.next) sender.send('preview-windows:replace-request', {});
}

export async function replacePreview(uid: string, sender: WebContents, accepted: unknown) {
  const record = owned(uid, sender);
  const source = record.next;
  record.next = undefined;
  if (accepted !== true || !source || !record.ready) return;
  record.ready = false;
  record.dispose?.(); record.dispose = undefined;
  cancelOwnerRequests(record);
  record.source = source;
  record.dirty = false;
  // Recreate only the document: preserve native window position, size and
  // maximized state, and release the old document's media/SDK resources.
  await record.win.loadFile(path.join(SRC_ROOT, 'renderer', 'preview.html'));
}

export async function openPreview(uid: string, owner: WebContents, payload: unknown) {
  if ((JSON.stringify(payload)?.length || 0) > 8 * 1024 * 1024) throw new Error('Preview is too large.');
  const source = sourceSchema.parse(payload);
  if (records.has(owner.id)) throw new Error('Open previews from the main window.');
  const existing = [...records.values()].find(r => r.uid === uid && r.owner === owner
    && (source.kind === 'app' ? sourceKey(r.source) === sourceKey(source) : r.source.kind !== 'app'));
  if (existing) {
    if (existing.win.isFocusable()) {
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.show(); existing.win.focus();
    }
    if (source.kind !== 'app') {
      const unchanged = source.kind !== 'image' && sourceKey(existing.source) === sourceKey(source);
      existing.next = unchanged ? undefined : source;
      if (existing.next && existing.ready) existing.win.webContents.send('preview-windows:replace-request', {});
    }
    return { windowId: existing.win.id };
  }
  if (records.size >= 16) throw new Error('Close a preview window before opening another.');
  const parent = BrowserWindow.fromWebContents(owner);
  if (!parent || parent.isDestroyed()) throw new Error('Preview is unavailable.');
  // Background E2E owners must keep all their native previews off the desktop.
  const focusable = parent.isFocusable();
  const area = screen.getDisplayMatching(parent.getBounds()).workArea;
  const width = Math.min(1040, area.width), height = Math.min(760, area.height);
  const win = new BrowserWindow({
    width, height, minWidth: Math.min(480, area.width), minHeight: Math.min(320, area.height),
    x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
    title: source.title, show: false, focusable, backgroundColor: '#ffffff',
    icon: path.join(SRC_ROOT, 'resources', 'icons', 'icon.png'),
    webPreferences: hardenedWebPreferences({ preload: path.join(SRC_ROOT, 'main', 'preload.js'), plugins: true,
      backgroundThrottling: focusable }),
  });
  const record: Record = { win, owner, uid, source, dirty: false, ready: false };
  const contentsId = win.webContents.id;
  records.set(contentsId, record);
  const destroy = () => { if (!win.isDestroyed()) win.destroy(); };
  let ownerState = owners.get(owner);
  if (!ownerState) {
    const windows = new Set<BrowserWindow>();
    const closeAll = () => { for (const child of windows) if (!child.isDestroyed()) child.destroy(); };
    const onNavigation = (_event: unknown, _url: string, inPlace: boolean, main: boolean) => { if (main && !inPlace) closeAll(); };
    owner.once('destroyed', closeAll);
    owner.on('did-start-navigation', onNavigation);
    ownerState = { windows, dispose: () => {
      owner.removeListener('destroyed', closeAll);
      owner.removeListener('did-start-navigation', onNavigation);
      owners.delete(owner);
    } };
    owners.set(owner, ownerState);
  }
  ownerState.windows.add(win);
  installExternalNavigationGuard(win.webContents, url => shell.openExternal(url), () => log.warn('external link failed', { code: 'open_failed' }));
  installOfflineHtmlPreviewNavigationGuard(win.webContents);
  win.on('close', event => {
    if (!record.dirty) return;
    event.preventDefault();
    win.webContents.send('preview-windows:close-request', {});
  });
  win.on('closed', () => {
    records.delete(contentsId);
    record.dispose?.();
    ownerState!.windows.delete(win);
    if (!ownerState!.windows.size) ownerState!.dispose();
    cancelOwnerRequests(record);
  });
  try {
    await win.loadFile(path.join(SRC_ROOT, 'renderer', 'preview.html'));
    if (!win.isDestroyed() && win.isFocusable()) { win.show(); win.focus(); }
    return { windowId: win.id };
  } catch (error) { destroy(); throw error; }
}

export function initializePreview(uid: string, sender: WebContents) {
  const record = owned(uid, sender);
  const source = record.source;
  if (source.kind === 'image' && source.gallery && !record.dispose) {
    // Only persisted image-list changes matter; streaming process events never
    // cross into preview renderers or trigger repeated history scans.
    record.dispose = subscribeBus(uid, source.gallery.cid, event => {
      if (event.type === 'message' && !sender.isDestroyed()) sender.send('preview-windows:gallery-refresh', {});
    });
  }
  return { source };
}

export function closePreview(uid: string, sender: WebContents) { owned(uid, sender).win.destroy(); }
export function setPreviewDirty(uid: string, sender: WebContents, dirty: unknown) { owned(uid, sender).dirty = dirty === true; }

export function reportPreview(uid: string, sender: WebContents, payload: any) {
  const r = owned(uid, sender);
  if (payload?.kind === 'files-changed') r.owner.send('preview-windows:report', { kind: 'files-changed' });
  else {
    const report = z.object({ kind: z.literal('telemetry'), method: z.enum(['click', 'event', 'error']),
      action: z.string().min(1).max(128), data: z.record(z.string(), z.unknown()) }).strict().parse(payload);
    if (JSON.stringify(report).length > 16384) return;
    r.owner.send('preview-windows:report', report);
  }
}

// Projection stays with the transcript renderer, which owns visibility,
// markdown, attachment and produced-media rules. Requests bind the original
// task and can run while the main window displays another tab or task.
export async function requestPreviewOwner(uid: string, sender: WebContents, payload: any) {
  const r = owned(uid, sender);
  const kind = payload?.kind;
  if (kind !== 'gallery' && kind !== 'artifact-submit') throw new Error('Invalid preview action.');
  if (kind === 'gallery' && (r.source.kind !== 'image' || !r.source.gallery)) throw new Error('Gallery is unavailable.');
  if (kind === 'artifact-submit' && r.source.kind !== 'artifact') throw new Error('Application is unavailable.');
  const before = payload.before == null ? null : z.number().int().nonnegative().parse(payload.before);
  const submission = kind === 'artifact-submit' ? z.string().max(1024 * 1024).parse(payload.text) : undefined;
  if (pending.size >= 32) throw new Error('Preview is busy. Try again.');
  const requestId = randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => { pending.delete(requestId); resolve({ ok: false }); }, 30_000);
    const finish = (value: unknown) => { clearTimeout(timer); resolve(value); };
    pending.set(requestId, { owner: r.owner, preview: r.win.id, finish });
    r.owner.send('preview-windows:owner-request', {
      requestId, kind, before,
      source: r.source.kind === 'image' ? { cid: r.source.gallery!.cid } : r.source,
      ...(kind === 'artifact-submit' ? { text: submission } : {}),
    });
  });
}

export function resolvePreviewOwner(sender: WebContents, payload: any) {
  const request = pending.get(payload?.requestId);
  if (!request || request.owner !== sender) return;
  pending.delete(payload.requestId);
  request.finish(payload.result);
}

registerUserSwitchHook('preview-windows', previousUid => {
  for (const r of records.values()) if (r.uid === previousUid) r.win.destroy();
});
