import { BrowserWindow, shell, screen, type WebContents } from 'electron';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SRC_ROOT } from '../paths';
import { createLogger } from '../logger';
import { hardenedWebPreferences, installExternalNavigationGuard, installHtmlPreviewNavigationGuard } from '../util/window-security';
import { chatMediaLocalPathFromUrl } from '../util/chat-media-url';
import { registerUserSwitchHook } from './user-switch-hooks';
import { subscribeBus } from './group_chat';

// Host-only window chrome. Generated applications retain the existing iframe
// sandbox and acquire their SDK instance from their own trusted renderer.
const text = z.string().max(8192);
const id = z.string().min(1).max(128);
const options = z.object({
  cid: id.nullish(), projectId: id.nullish(), absPath: text.optional(),
  projectScoped: z.boolean().optional(), autoplay: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  fileRevision: z.string().max(128).optional(),
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
type FileSource = Extract<PreviewSource, { kind: 'file' }>;
type AllowMarkdownLink = (source: FileSource, target: string) => Promise<boolean>;
type Record = { win: BrowserWindow; owner: WebContents; uid: string; source: PreviewSource; dirty: boolean;
  ready: boolean; next?: PreviewSource; dispose?: () => void;
  markdownLinkPending?: boolean;
  revealPending?: boolean;
  artifactRevision?: number };
const records = new Map<number, Record>();
const owners = new Map<WebContents, { windows: Set<BrowserWindow>; dispose: () => void }>();
const log = createLogger('preview-windows');
const pending = new Map<string, { owner: WebContents; preview: number; finish: (value: any) => void }>();

function sourceKey(source: PreviewSource): string {
  if (source.kind === 'app') return JSON.stringify(['app', source.appId]);
  if (source.kind === 'artifact') return JSON.stringify(['artifact', source.cid, source.artifactId]);
  return JSON.stringify([source.kind, source.options.cid, source.options.projectId, source.kind === 'file' ? source.path : source.src]);
}

function canReplaceContent(current: PreviewSource, next: PreviewSource): boolean {
  return ['image', 'file', 'video'].includes(current.kind) && ['image', 'file', 'video'].includes(next.kind);
}

function canRefocusPreview(current: PreviewSource, next: PreviewSource): boolean {
  if (next.kind === 'image' || sourceKey(current) !== sourceKey(next)) return false;
  if ((next.kind === 'file' || next.kind === 'video') && 'options' in current) {
    return current.options.fileRevision === next.options.fileRevision
      && current.options.readOnly === next.options.readOnly;
  }
  return true;
}

function owned(uid: string, sender: WebContents): Record {
  const record = records.get(sender.id);
  if (!record || record.uid !== uid || record.win.isDestroyed()) throw new Error('Preview is unavailable.');
  return record;
}

export function isPreviewContents(sender: WebContents): boolean { return records.has(sender.id); }

function showPreview(record: Record) {
  if (record.win.isDestroyed() || !record.win.isFocusable()) return;
  if (record.win.isMinimized()) record.win.restore();
  record.win.show(); record.win.focus();
}

function installPreviewNavigation(record: Record, allowMarkdownLink?: AllowMarkdownLink) {
  const contents = record.win.webContents;
  installHtmlPreviewNavigationGuard(contents, (event, url) => {
    const target = chatMediaLocalPathFromUrl(url.href);
    if (!/\.(?:md|markdown)$/i.test(target)) return false;
    const source = record.source;
    const frame = event.frame;
    // Only the active file viewer's own HTML frame can request a handoff.
    // Nested frames, popups and a stale frame must never select native content.
    if (!allowMarkdownLink || !record.ready || record.next || record.markdownLinkPending
        || source.kind !== 'file' || !frame || frame.parent !== contents.mainFrame || event.initiator !== frame
        || url.host !== 'local' || url.username || url.password
        || !path.isAbsolute(target) || target.includes('\0') || target.length > 8192
        || path.normalize(chatMediaLocalPathFromUrl(frame.url)) !== path.normalize(source.path)) return true;

    record.markdownLinkPending = true;
    const frameUrl = frame.url;
    void allowMarkdownLink(source, target).then(allowed => {
      if (!allowed || record.win.isDestroyed() || !record.ready || record.next
          || record.source !== source || frame.url !== frameUrl) return;
      const { cid, projectId, projectScoped } = source.options;
      record.next = {
        kind: 'file', path: target, title: path.basename(target),
        options: { cid, projectId, projectScoped, readOnly: true },
      };
      contents.send('preview-windows:replace-request', {});
    }).catch(() => log.warn('Markdown preview link validation failed', { code: 'validation_failed' }))
      .finally(() => { record.markdownLinkPending = false; });
    return true;
  });
}

function cancelOwnerRequests(record: Record) {
  for (const [key, request] of pending) if (request.preview === record.win.id) {
    pending.delete(key); request.finish({ ok: false });
  }
}

export function readyPreview(uid: string, sender: WebContents) {
  const record = owned(uid, sender);
  record.ready = true;
  if (record.next) sender.send('preview-windows:replace-request', {});
  else if (record.revealPending) {
    record.revealPending = false;
    showPreview(record);
  }
}

export async function replacePreview(uid: string, sender: WebContents, accepted: unknown) {
  const record = owned(uid, sender);
  if (!record.ready) return;
  const source = record.next;
  record.next = undefined;
  if (accepted !== true || !source) {
    if (record.revealPending) { record.revealPending = false; showPreview(record); }
    return;
  }
  // A dirty editor stays visible for its discard dialog; once accepted it
  // can release its content through the same path as a clean preview.
  const inPlace = canReplaceContent(record.source, source);
  if (record.revealPending && !inPlace) record.win.hide();
  record.ready = false;
  record.dispose?.(); record.dispose = undefined;
  cancelOwnerRequests(record);
  if (sourceKey(record.source) !== sourceKey(source)) record.artifactRevision = undefined;
  record.source = source;
  record.dirty = false;
  // The existing renderer releases its old media and acknowledges the new
  // source through readyPreview before the window is raised. No navigation.
  if (inPlace) {
    initializePreview(uid, sender);
    return { source };
  }
  // Recreate only the document: preserve native window position, size and
  // maximized state, and release the old document's media/SDK resources.
  try {
    await record.win.loadFile(path.join(SRC_ROOT, 'renderer', 'preview.html'));
  } catch (error) {
    // A failed document cannot signal readiness. Release the hidden window so
    // the next click can create a working preview, as on an initial load failure.
    if (!record.win.isDestroyed()) record.win.destroy();
    throw error;
  }
}

export async function openPreview(uid: string, owner: WebContents, payload: unknown, allowMarkdownLink?: AllowMarkdownLink) {
  if ((JSON.stringify(payload)?.length || 0) > 8 * 1024 * 1024) throw new Error('Preview is too large.');
  const source = sourceSchema.parse(payload);
  if (records.has(owner.id)) throw new Error('Open previews from the main window.');
  const existing = [...records.values()].find(r => r.uid === uid && r.owner === owner
    && (source.kind === 'app' ? sourceKey(r.source) === sourceKey(source) : r.source.kind !== 'app'));
  if (existing) {
    if (source.kind !== 'app') {
      existing.next = canRefocusPreview(existing.source, source) ? undefined : source;
      if (existing.next) {
        // Raise the window only after replacement. File and media swaps keep the shell
        // visible in place; other kinds hide the document being navigated away.
        existing.revealPending = true;
        if (!existing.dirty && !canReplaceContent(existing.source, source)) existing.win.hide();
      } else if (existing.ready) existing.revealPending = false;
      if (existing.next && existing.ready) existing.win.webContents.send('preview-windows:replace-request', {});
    }
    if (!existing.revealPending || existing.dirty) showPreview(existing);
    // Only an app window's opener needs to know its open was a refocus.
    return { windowId: existing.win.id, ...(source.kind === 'app' ? { reused: true } : {}) };
  }
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
  installPreviewNavigation(record, allowMarkdownLink);
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
    if (!record.revealPending) showPreview(record);
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
  if (source.kind === 'artifact' && !record.dispose) {
    record.dispose = subscribeBus(uid, source.cid, event => {
      if (event.type !== 'artifact_created' || event.artifact.id !== source.artifactId
        || !Number.isSafeInteger(event.artifact.revision)
        || event.artifact.revision! <= (record.artifactRevision ?? 0) || sender.isDestroyed()) return;
      record.artifactRevision = event.artifact.revision;
      if (record.next && sourceKey(record.next) !== sourceKey(source)) return;
      record.next = { ...source, title: event.artifact.title };
      if (record.ready) sender.send('preview-windows:replace-request', {});
    });
  }
  return { source };
}

export function closePreview(uid: string, sender: WebContents) { owned(uid, sender).win.destroy(); }
export function setPreviewDirty(uid: string, sender: WebContents, dirty: unknown) { owned(uid, sender).dirty = dirty === true; }

export function notifyPreviewFilesChanged(uid: string, sender: WebContents) {
  const r = owned(uid, sender);
  r.owner.send('preview-windows:files-changed', {});
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
