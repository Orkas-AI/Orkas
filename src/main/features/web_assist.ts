/**
 * In-app Web Assist runtime for model-originated web work.
 *
 * The application renderer owns only trusted toolbar controls and a layout
 * placeholder. Third-party content runs in a main-process WebContentsView so
 * it never receives the Orkas preload, Node, or renderer IPC bridge. A
 * machine-local Chromium profile per Orkas user preserves provider login
 * state without sharing the system browser's profile or cloud-syncing it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BrowserWindow,
  session,
  shell,
  WebContentsView,
  type NativeImage,
  type Rectangle,
  type Session,
  type WebContents,
  type WebContentsViewConstructorOptions,
} from 'electron';

import { userWebAssistProfileDir } from '../paths';
import { chatAttachmentDirForConversation } from '../util/project-layout';
import { genId12, safeId } from '../storage';
import { createLogger } from '../logger';
import { logErrorRef } from '../util/log-redact';
import { prepareBrowserProxy } from '../util/browser-proxy';
import { withOperationTimeout } from '../util/operation-timeout';
import { prepareWebAssistSession } from './web_assist_session';
import { logWebAssistFailure } from './web_assist_diagnostics';
import { registerUserSwitchHook } from './user-switch-hooks';
import {
  registerBrowserTab, forgetBrowserTab, retainBrowserTab,
  type BrowserTabLifetime,
} from './web_assist_lifecycle';
import { hardenedWebPreferences, safeExternalHttpUrl } from '../util/window-security';
import {
  buildWebAssistActionScript,
  buildWebAssistTextConditionScript,
  sanitizeWebAssistObservation,
  webAssistObserveScript,
  type WebAssistObserveWindow,
  type WebAssistPageAction,
  type WebAssistStoredElementRef,
} from './web_assist_page';
import {
  clearWebAssistActionGrants,
  hasWebAssistActionGrant,
  isGateableWebAssistReason,
  rememberWebAssistActionGrant,
  requestWebAssistActionConfirm,
  webAssistPageOrigin,
  type WebAssistActionTarget,
} from './web_assist_confirm';

const log = createLogger('web-assist');
const MAX_LABEL_LENGTH = 120;
const MAX_SEARCH_INPUT_LENGTH = 2048;
/** Raised from 10 on 2026-09-18. Idle reclamation, not this ceiling, governs
 *  live renderer count: `reclaimIdleWebAssistPages` closes any tab that is not
 *  visible and has been idle for ten minutes, so steady-state cost follows
 *  recent use. Ten was too low for a research session. */
export const MAX_TABS_PER_CONVERSATION = 30;
const IDLE_PAGE_TIMEOUT_MS = 10 * 60_000;
const IDLE_PAGE_SCAN_MS = 30_000;
const MIN_VIEW_EDGE = 80;
/** 1280 is the common floor for a site's desktop breakpoint. */
const DESKTOP_VIEWPORT_WIDTH = 1280;
const DESKTOP_VIEWPORT_HEIGHT = 800;
const WEB_ASSIST_ISOLATED_WORLD_ID = 1001;
const WEB_ASSIST_SEARCH_URL = 'https://www.bing.com/search';

export interface WebAssistSnapshot {
  open: boolean;
  loading: boolean;
  tab_id?: string;
  active_tab_id?: string;
  label: string;
  page_title: string;
  display_url: string;
  can_go_back: boolean;
  can_go_forward: boolean;
  assistant_controlled?: boolean;
  conversation_id?: string;
  assistant_action?: 'observing' | 'acting' | 'waiting';
  error_code?: 'page_load_failed' | 'page_unresponsive' | 'download_blocked';
  tabs: WebAssistTabSnapshot[];
}

export interface WebAssistTabSnapshot {
  tab_id: string;
  suspended?: boolean;
  created_by: 'user' | 'model';
  retention?: 'temporary' | 'deliverable' | 'handoff';
  loading: boolean;
  label: string;
  page_title: string;
  display_url: string;
  /** Full destination for trusted browser chrome only; absent from model results. */
  address_url?: string;
  /** Pending download consent for trusted task chrome only. */
  download_request?: { id: string; origin: string; filename: string };
  can_go_back: boolean;
  can_go_forward: boolean;
  conversation_id: string;
  assistant_controlled?: boolean;
  assistant_action?: WebAssistSnapshot['assistant_action'];
  error_code?: WebAssistSnapshot['error_code'];
}

interface WebAssistControlContext {
  userId: string;
  conversationId: string;
  scope: 'connector_setup' | 'browser';
  scopeId: string;
}

interface WebAssistObservationState {
  pageId: string;
  url: string;
  refs: Map<string, WebAssistStoredElementRef>;
  hrefs: Set<string>;
}

/** One model-initiated navigation, kept so an unattended run stays reviewable.
 *
 *  This is a record, not a gate. A page that injects instructions cannot read
 *  the agent's context itself — its own scripts already have the network — so
 *  the one thing an injection buys is making the *agent* carry that context
 *  somewhere. Navigation is where that would happen, and gating it was rejected
 *  on 2026-09-18: research browsing crosses origins constantly, a per-navigation
 *  dialog cannot be adjudicated, and Orkas has already measured users switching
 *  a noisy gate off entirely. Recording costs nothing and makes the one thing
 *  we cannot prevent at least visible. */
export interface WebAssistNavigationEntry {
  at: number;
  tab_id: string;
  url: string;
  origin: string;
  operation: 'open' | 'goto';
  /** The destination was a link in an observation the model was holding.
   *  False means the caller composed the URL. Reported, deliberately not
   *  gated: search URLs and signed URLs are composed too, so the
   *  false-positive rate has to be measured before it can carry a decision. */
  from_link: boolean;
}

const NAVIGATION_LEDGER_LIMIT = 200;

/** Downloads a task may take without asking again, once its origin is allowed. */
const DOWNLOAD_TASK_FILE_LIMIT = 20;
const DOWNLOAD_TASK_BYTE_LIMIT = 200 * 1024 * 1024;
/** Never grantable. Archives are allowed: a zip of CSVs is ordinary data, the
 *  file only lands in the task's attachments, and nothing here runs it. An
 *  executable has no such reading. */
const UNGRANTABLE_DOWNLOAD_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'psm1', 'dll', 'sys',
  'app', 'pkg', 'dmg', 'deb', 'rpm', 'sh', 'bash', 'zsh', 'jar', 'vbs', 'js', 'lnk',
]);

/** One download the task attempted. Refusals are kept too: a refusal the user
 *  never sees is indistinguishable from the page being broken. */
export interface WebAssistDownloadEntry {
  at: number;
  origin: string;
  filename: string;
  bytes: number;
  state: 'downloading' | 'saved' | 'refused' | 'failed';
  /** Why it was refused, when it was. `needs_origin_grant` is the one a user
   *  can answer; the others are policy and are not offered. */
  reason?: 'needs_origin_grant' | 'blocked_type' | 'task_budget';
}

const downloadLedgers = new Map<string, WebAssistDownloadEntry[]>();
// Only terminal, task-owned downloads expose these paths to the model. The
// trusted renderer keeps its existing filename-based attachment actions.
const downloadPaths = new WeakMap<WebAssistDownloadEntry, string>();
// Quota outlives the bounded display ledger. Active reservations include both
// declared size and observed bytes so concurrent transfers share one budget.
const downloadUsage = new Map<string, {
  files: number;
  bytes: number;
  active: Map<object, () => number>;
}>();
const downloadOriginGrants = new Map<string, Set<string>>();
const navigationLedgers = new Map<string, WebAssistNavigationEntry[]>();

interface WebAssistTabRecord {
  id: string;
  lifetime: BrowserTabLifetime;
  conversationId: string;
  view?: WebContentsView;
  visible: boolean;
  bounds?: Rectangle;
  virtualViewport?: boolean;
  /** Drawer width the current emulation was computed for. */
  virtualViewportWidth?: number;
  virtualViewportHeight?: number;
  lastUsedAt: number;
  activeOperations: number;
  edited: boolean;
  replayable: boolean;
  relatedTabs: Set<string>;
  wakeAfterUnload?: boolean;
  idleCheckInFlight?: boolean;
  suspended?: { url: string; title: string; entries: Array<{ url: string; title: string }>; index: number };
  label: string;
  loading: boolean;
  errorCode?: WebAssistSnapshot['error_code'];
  downloadRequest?: WebAssistTabSnapshot['download_request'];
  controlContext?: WebAssistControlContext;
  assistantAction?: WebAssistSnapshot['assistant_action'];
  observation?: WebAssistObservationState;
  authorizationPopups: Set<WebContents>;
}

interface WebAssistRecord {
  owner: BrowserWindow;
  ownerUserId: string;
  tabs: Map<string, WebAssistTabRecord>;
  activeTabId: string;
  ownerClosed: () => void;
  idleTimer?: ReturnType<typeof setInterval>;
}

interface WebAssistConversationBinding {
  userId: string;
  conversationId: string;
  sender: WebContents;
}

const records = new Map<number, WebAssistRecord>();
const configuredSessions = new WeakMap<Session, ReturnType<typeof prepareBrowserProxy>>();
const conversationBindings = new Map<string, WebAssistConversationBinding>();
const boundSenders = new WeakSet<object>();
const activeConversationBySender = new WeakMap<object, string>();
const previewCaptures = new WeakMap<WebContents, Promise<NativeImage>>();

/** Web Assist accepts credential-free HTTP(S) destinations only. */
export function safeWebAssistUrl(raw: unknown): string | null {
  return safeExternalHttpUrl(raw);
}

function directWebAssistAddress(value: string): string | null {
  const normalized = safeWebAssistUrl(`https://${value}`);
  if (!normalized) return null;
  const hostname = new URL(normalized).hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (hostname === 'localhost') return normalized;
  if (hostname.includes(':')) return normalized;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return normalized;
  return hostname.includes('.') ? normalized : null;
}

/** Address-bar input opens HTTP(S) URLs or domains, and searches other text with Bing. */
export function normalizeWebAssistUserUrl(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) return null;

  const absolute = safeWebAssistUrl(value);
  if (absolute) return absolute;

  const direct = directWebAssistAddress(value);
  if (direct) return direct;
  if (value.length > MAX_SEARCH_INPUT_LENGTH) return null;

  // Never reinterpret an explicit unsupported scheme as a web search.
  if (/^[a-z][a-z\d+.-]*:/iu.test(value)) return null;

  const search = new URL(WEB_ASSIST_SEARCH_URL);
  search.searchParams.set('q', value);
  return search.toString();
}

function safeLabel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/g, ' ').trim();
  return value.slice(0, MAX_LABEL_LENGTH);
}

function conversationBindingKey(userId: string, conversationId: string): string {
  return `${userId}\u0000${conversationId}`;
}

/** Did any observation this task is holding actually show this destination? */
function wasObservedLink(userId: string, conversationId: string, url: string): boolean {
  for (const record of records.values()) {
    for (const tab of record.tabs.values()) {
      if (tab.conversationId !== conversationId) continue;
      if (tab.controlContext && tab.controlContext.userId !== userId) continue;
      for (const href of tab.observation?.hrefs || []) {
        if (safeWebAssistUrl(href) === url) return true;
      }
    }
  }
  return false;
}

function recordModelNavigation(
  userId: string,
  conversationId: string,
  tabId: string,
  url: string,
  operation: 'open' | 'goto',
  fromLink: boolean,
): void {
  if (!safeId(userId) || !safeId(conversationId)) return;
  const key = conversationBindingKey(userId, conversationId);
  const ledger = navigationLedgers.get(key) || [];
  ledger.push({
    at: Date.now(),
    tab_id: tabId,
    url,
    origin: webAssistPageOrigin(url),
    operation,
    from_link: fromLink,
  });
  // Newest wins; an unbounded ledger would outlive the task it describes.
  if (ledger.length > NAVIGATION_LEDGER_LIMIT) ledger.splice(0, ledger.length - NAVIGATION_LEDGER_LIMIT);
  navigationLedgers.set(key, ledger);
  emitActivity(userId, conversationId);
}

/** Where this task's browser has been, newest last. Chrome, not model output. */
export function webAssistNavigations(
  userId: string,
  conversationId: string,
): { ok: true; navigations: WebAssistNavigationEntry[] } {
  if (!safeId(userId) || !safeId(conversationId)) return { ok: true, navigations: [] };
  return { ok: true, navigations: [...(navigationLedgers.get(conversationBindingKey(userId, conversationId)) || [])] };
}

export function forgetWebAssistNavigations(userId: string, conversationId: string): void {
  navigationLedgers.delete(conversationBindingKey(userId, conversationId));
}

/** Keep a downloaded name inside the task's own folder and free of surprises. */
function safeDownloadFilename(raw: string): string {
  const base = path.basename(String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ''));
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 120) || 'download';
}

/** Generated downloads have no HTTP request URL. Blob URLs carry their
 * creator's origin; data URLs belong to the browser-owned page initiating the
 * download. Never inherit that page's grant for opaque blobs or other schemes. */
function downloadOrigin(url: string, pageUrl: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'blob:') return webAssistPageOrigin(parsed.origin);
    if (parsed.protocol === 'data:') return webAssistPageOrigin(pageUrl);
    return webAssistPageOrigin(url);
  } catch {
    return '';
  }
}

function downloadExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function recordWebAssistDownload(
  userId: string,
  conversationId: string,
  entry: WebAssistDownloadEntry,
): WebAssistDownloadEntry {
  const key = conversationBindingKey(userId, conversationId);
  const ledger = downloadLedgers.get(key) || [];
  ledger.push(entry);
  if (ledger.length > NAVIGATION_LEDGER_LIMIT) {
    ledger.splice(0, ledger.length - NAVIGATION_LEDGER_LIMIT);
  }
  downloadLedgers.set(key, ledger);
  emitActivity(userId, conversationId);
  return entry;
}

function taskDownloadUsage(userId: string, conversationId: string) {
  const key = conversationBindingKey(userId, conversationId);
  let usage = downloadUsage.get(key);
  if (!usage) {
    usage = { files: 0, bytes: 0, active: new Map() };
    downloadUsage.set(key, usage);
  }
  return usage;
}

function reservedDownloadBytes(usage: ReturnType<typeof taskDownloadUsage>): number {
  return usage.bytes + [...usage.active.values()].reduce((sum, read) => sum + read(), 0);
}

/** Where this task's browser has downloaded from, newest last. */
export function webAssistDownloads(
  userId: string,
  conversationId: string,
): { ok: true; downloads: WebAssistDownloadEntry[]; allowed_origins: string[] } {
  if (!safeId(userId) || !safeId(conversationId)) {
    return { ok: true, downloads: [], allowed_origins: [] };
  }
  const key = conversationBindingKey(userId, conversationId);
  return {
    ok: true,
    downloads: [...(downloadLedgers.get(key) || [])],
    allowed_origins: [...(downloadOriginGrants.get(key) || [])],
  };
}

/** The user's answer to a refused download. Deliberately per origin and per
 *  task, and deliberately granted *outside* the transfer: a download cannot be
 *  held for a dialog. Measured 2026-09-18 — a 256 KB body reaches
 *  done/completed before a 1.5 s approval gap elapses even with `pause()`
 *  reporting true, so the only honest shape is refuse, ask, retry. */
export function allowWebAssistDownloadOrigin(
  userId: string,
  conversationId: string,
  origin: unknown,
): { ok: boolean; error?: string; allowed_origins?: string[] } {
  if (!safeId(userId) || !safeId(conversationId)) {
    return { ok: false, error: 'The browser task scope is invalid.' };
  }
  const normalized = webAssistPageOrigin(String(origin || ''));
  if (!normalized) return { ok: false, error: 'That is not a page origin.' };
  const key = conversationBindingKey(userId, conversationId);
  const grants = downloadOriginGrants.get(key) || new Set<string>();
  grants.add(normalized);
  downloadOriginGrants.set(key, grants);
  for (const record of records.values()) {
    if (record.ownerUserId !== userId) continue;
    let changed = false;
    for (const tab of record.tabs.values()) {
      if (tab.conversationId !== conversationId || tab.downloadRequest?.origin !== normalized) continue;
      tab.downloadRequest = undefined;
      if (tab.errorCode === 'download_blocked') tab.errorCode = undefined;
      changed = true;
    }
    if (changed) emit(record);
  }
  emitActivity(userId, conversationId);
  return { ok: true, allowed_origins: [...grants] };
}

export function forgetWebAssistDownloads(userId: string, conversationId: string): void {
  const key = conversationBindingKey(userId, conversationId);
  downloadLedgers.delete(key);
  downloadOriginGrants.delete(key);
  downloadUsage.delete(key);
}

function displayUrl(raw: unknown): string {
  // A real child browsing context may be populated through document.write
  // before navigation. This is distinct from an unused, empty toolbar tab.
  if (raw === 'about:blank') return 'about:blank';
  const safe = safeWebAssistUrl(raw);
  if (!safe) return '';
  try {
    const url = new URL(safe);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.origin}${path}`.slice(0, 320);
  } catch {
    return '';
  }
}

/** Clamp renderer-supplied CSS-pixel bounds to the owner window's content. */
export function normalizeWebAssistBounds(
  raw: unknown,
  ownerBounds: Pick<Rectangle, 'width' | 'height'>,
): Rectangle | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Partial<Rectangle>;
  const values = [input.x, input.y, input.width, input.height];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null;
  const ownerWidth = Math.max(0, Math.floor(ownerBounds.width));
  const ownerHeight = Math.max(0, Math.floor(ownerBounds.height));
  const x = Math.max(0, Math.min(ownerWidth, Math.floor(input.x!)));
  const y = Math.max(0, Math.min(ownerHeight, Math.floor(input.y!)));
  const width = Math.max(0, Math.min(Math.floor(input.width!), ownerWidth - x));
  const height = Math.max(0, Math.min(Math.floor(input.height!), ownerHeight - y));
  if (width < MIN_VIEW_EDGE || height < MIN_VIEW_EDGE) return null;
  return { x, y, width, height };
}

/*
 * We deliberately do NOT override the user agent here.
 *
 * Stripping the `Electron/<ver>` and app-name tokens looks like it should make
 * a page treat us as ordinary Chrome. It does the opposite, because of a fact
 * the stripping cannot change: Electron never sends the `Sec-CH-UA` client
 * hints, override or not (measured — Chromium builds them from user agent
 * *metadata*, which `setUserAgent()` cannot reach, and Electron ships none).
 *
 * So a UA washed down to plain Chrome contradicts itself: it claims to be
 * Chrome while omitting three headers every real Chrome sends. Leaving the
 * Electron/app token in place makes it an honest non-Chrome client instead,
 * and bot detection treats that far more kindly.
 *
 * Measured against openai.com (Cloudflare) on 2026-09-21, same Electron build,
 * 25s settle window, three runs each — only the UA handling varied:
 *
 *   default UA, Electron token kept ......................... 3/3 HTTP 200
 *   UA washed to plain Chrome (what this used to do) ........ 1/3 HTTP 403,
 *                                                             hard block
 *
 * Confirmed in-app after restart: the page that previously stalled on the
 * Cloudflare interstitial now renders in ~4s.
 *
 * If a future change really needs a custom UA, it must supply the metadata too
 * (`Network.setUserAgentOverride` via the debugger, with `userAgentMetadata`),
 * so the claimed brand and the client hints agree. Do not call `setUserAgent()`
 * on its own.
 */

/** Let provider copy buttons work without granting pages clipboard read access. */
export function isWebAssistPermissionAllowed(permission: unknown): boolean {
  return permission === 'clipboard-sanitized-write';
}

function configureSession(userId: string, ses: Session): ReturnType<typeof prepareBrowserProxy> {
  const existing = configuredSessions.get(ses);
  if (existing) return existing;
  const proxy = prepareBrowserProxy(ses);
  const restored = prepareWebAssistSession(userId, ses);
  const ready = Promise.all([restored, proxy.ready]).then(([, proxyReady]) => proxyReady !== false, () => false);
  configuredSessions.set(ses, proxy);
  ses.setPermissionCheckHandler((_webContents, permission) => isWebAssistPermissionAllowed(permission));
  ses.setPermissionRequestHandler((_webContents, permission, callback) => (
    callback(isWebAssistPermissionAllowed(permission))
  ));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (details.resourceType === 'mainFrame') {
      for (const record of records.values()) for (const tab of record.tabs.values()) {
        if (tab.view?.webContents.id === details.webContentsId) {
          tab.replayable = tab.replayable && details.method === 'GET';
        }
      }
    }
    // Includes native child windows and subresources, not only loadURL callers.
    void ready.then(ready => callback({ cancel: !ready }));
  });
  // A download cannot be held for an approval dialog. Measured 2026-09-18: a
  // 2.5 MB streamed body does stay at received=0 under `pause()`, but a 256 KB
  // body sent in one write reaches done/completed before a 1.5 s gap elapses
  // even though `isPaused()` reports true — and most documents arrive in one
  // chunk. So the decision here is synchronous, and a refusal must call
  // preventDefault *without* setSavePath: setting a path and cancelling later
  // still leaves a partial file on disk.
  ses.on('will-download', (event, item, webContents) => {
    let owner: { record: WebAssistRecord; tab: WebAssistTabRecord } | null = null;
    for (const record of records.values()) {
      for (const tab of record.tabs.values()) {
        if (tab.view?.webContents !== webContents || tab.view.webContents.isDestroyed()) continue;
        owner = { record, tab };
        break;
      }
      if (owner) break;
    }
    if (!owner) { event.preventDefault(); return; }
    const { record, tab } = owner;
    const conversationId = tab.conversationId;
    const origin = downloadOrigin(item.getURL(), webContents.getURL());
    const filename = safeDownloadFilename(item.getFilename());
    const declared = Math.max(0, Number(item.getTotalBytes()) || 0);

    const refuse = (reason: WebAssistDownloadEntry['reason']): void => {
      event.preventDefault();
      tab.downloadRequest = reason === 'needs_origin_grant'
        ? { id: genId12(), origin, filename } : undefined;
      recordWebAssistDownload(userId, conversationId, {
        at: Date.now(), origin, filename, bytes: declared, state: reason ? 'refused' : 'failed', reason,
      });
      tab.errorCode = 'download_blocked';
      emit(record);
    };

    // An unknown site cannot be authorized; do not show an empty consent.
    if (!origin) return refuse(undefined);
    if (UNGRANTABLE_DOWNLOAD_EXTENSIONS.has(downloadExtension(filename))) return refuse('blocked_type');
    if (!(downloadOriginGrants.get(conversationBindingKey(userId, conversationId))?.has(origin))) {
      return refuse('needs_origin_grant');
    }
    const usage = taskDownloadUsage(userId, conversationId);
    const remaining = DOWNLOAD_TASK_BYTE_LIMIT - reservedDownloadBytes(usage);
    if (usage.files + usage.active.size >= DOWNLOAD_TASK_FILE_LIMIT || declared > remaining) return refuse('task_budget');

    let target = '';
    try {
      const dir = chatAttachmentDirForConversation(userId, conversationId);
      fs.mkdirSync(dir, { recursive: true });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const dot = filename.lastIndexOf('.');
        const candidate = path.join(dir, attempt === 0 ? filename : dot > 0
          ? `${filename.slice(0, dot)} (${attempt})${filename.slice(dot)}`
          : `${filename} (${attempt})`);
        try {
          const fd = fs.openSync(candidate, 'wx');
          target = candidate;
          fs.closeSync(fd);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      if (!target) return refuse('task_budget');
      item.setSavePath(target);
    } catch (error) {
      if (target) { try { fs.unlinkSync(target); } catch { /* own reservation only */ } }
      log.warn('download destination unavailable', { error: logErrorRef(error) });
      return refuse('task_budget');
    }

    const received = () => Math.max(0, Number(item.getReceivedBytes()) || 0);
    usage.active.set(item, () => Math.max(declared, received()));
    let overBudget = false;
    const entry = recordWebAssistDownload(userId, conversationId, {
      at: Date.now(), origin, filename: path.basename(target), bytes: declared, state: 'downloading',
    });
    downloadPaths.set(entry, target);
    // A declared size is the server's claim. Enforce the budget against what
    // actually arrives, and clean up the partial rather than leaving it.
    item.on('updated', () => {
      if (reservedDownloadBytes(usage) <= DOWNLOAD_TASK_BYTE_LIMIT) return;
      overBudget = true;
      try { item.cancel(); } catch { /* already finishing; done also checks */ }
    });
    item.once('done', (_done, state) => {
      entry.bytes = received();
      overBudget ||= reservedDownloadBytes(usage) > DOWNLOAD_TASK_BYTE_LIMIT;
      usage.active.delete(item);
      if (state !== 'completed' || overBudget) {
        entry.state = 'failed';
        try { fs.unlinkSync(target); } catch { /* best effort */ }
        tab.errorCode = 'download_blocked';
      } else {
        entry.state = 'saved';
        usage.files += 1;
        usage.bytes += entry.bytes;
      }
      emitActivity(userId, conversationId);
      emit(record);
    });
    emit(record);
  });
  return proxy;
}

function tabSnapshot(tab: WebAssistTabRecord): WebAssistTabSnapshot {
  const contents = tab.view?.webContents;
  const live = contents && !contents.isDestroyed();
  const rawUrl = live ? contents.getURL() : tab.suspended?.url || '';
  const title = live ? safeLabel(contents.getTitle()) : tab.suspended?.title || '';
  return {
    tab_id: tab.id,
    ...(tab.suspended ? { suspended: true } : {}),
    created_by: tab.lifetime.createdBy,
    ...(tab.lifetime.createdBy === 'model' && tab.lifetime.retention ? { retention: tab.lifetime.retention } : {}),
    loading: tab.loading,
    label: tab.label,
    page_title: title,
    display_url: displayUrl(rawUrl),
    can_go_back: tab.suspended ? tab.suspended.index > 0 : !!live && contents.navigationHistory.canGoBack(),
    can_go_forward: tab.suspended ? tab.suspended.index < tab.suspended.entries.length - 1 : !!live && contents.navigationHistory.canGoForward(),
    conversation_id: tab.conversationId,
    ...(tab.controlContext ? { assistant_controlled: true } : {}),
    ...(tab.assistantAction ? { assistant_action: tab.assistantAction } : {}),
    ...(tab.errorCode ? { error_code: tab.errorCode } : {}),
  };
}

function activeTab(record: WebAssistRecord): WebAssistTabRecord | null {
  const current = record.tabs.get(record.activeTabId);
  if (current) return current;
  const next = record.tabs.values().next().value || null;
  record.activeTabId = next?.id || '';
  return next;
}

function emptySnapshot(): WebAssistSnapshot {
  return {
    open: false,
    loading: false,
    label: '',
    page_title: '',
    display_url: '',
    can_go_back: false,
    can_go_forward: false,
    tabs: [],
  };
}

function snapshot(record: WebAssistRecord): WebAssistSnapshot {
  const tabs = [...record.tabs.values()]
    .map(tabSnapshot);
  const tab = activeTab(record);
  if (!tab) return emptySnapshot();
  const current = tabSnapshot(tab);
  return {
    open: true,
    active_tab_id: tab.id,
    tab_id: tab.id,
    loading: current.loading,
    label: current.label,
    page_title: current.page_title,
    display_url: current.display_url,
    can_go_back: current.can_go_back,
    can_go_forward: current.can_go_forward,
    conversation_id: current.conversation_id,
    ...(current.assistant_controlled ? { assistant_controlled: true } : {}),
    ...(current.assistant_action ? { assistant_action: current.assistant_action } : {}),
    ...(current.error_code ? { error_code: current.error_code } : {}),
    tabs,
  };
}

/** Never use this projection in model results: query and fragment may hold credentials. */
function rendererSnapshot(record: WebAssistRecord): WebAssistSnapshot {
  const state = snapshot(record);
  return {
    ...state,
    tabs: state.tabs.map(tab => {
      const source = record.tabs.get(tab.tab_id)!;
      const contents = source.view?.webContents;
      const rawUrl = contents && !contents.isDestroyed() ? contents.getURL() : source.suspended?.url || '';
      return {
        ...tab,
        address_url: rawUrl === 'about:blank' ? rawUrl : safeWebAssistUrl(rawUrl) || '',
        ...(source.downloadRequest ? { download_request: source.downloadRequest } : {}),
      };
    }),
  };
}

/** Invalidate only after the ledger mutation, independently of page-state timing. */
function emitActivity(userId: string, conversationId: string): void {
  for (const record of records.values()) {
    if (record.ownerUserId !== userId || record.owner.isDestroyed() || record.owner.webContents.isDestroyed()) continue;
    if (![...record.tabs.values()].some(tab => tab.conversationId === conversationId)) continue;
    try {
      record.owner.webContents.send('web-assist:activity', { conversation_id: conversationId });
    } catch (error) {
      log.warn('activity delivery failed', { error: logErrorRef(error) });
    }
  }
}

function emit(record: WebAssistRecord): void {
  if (record.owner.isDestroyed() || record.owner.webContents.isDestroyed()) return;
  try {
    record.owner.webContents.send('web-assist:state', rendererSnapshot(record));
  } catch (error) {
    log.warn('state delivery failed', { error: logErrorRef(error) });
  }
}

function emitClosed(record: WebAssistRecord): void {
  if (record.owner.isDestroyed() || record.owner.webContents.isDestroyed()) return;
  try {
    record.owner.webContents.send('web-assist:state', emptySnapshot());
  } catch (error) {
    log.warn('close state delivery failed', { error: logErrorRef(error) });
  }
}

function closeRecord(record: WebAssistRecord, notifyRenderer = false): void {
  clearInterval(record.idleTimer);
  records.delete(record.owner.id);
  record.owner.removeListener('closed', record.ownerClosed);
  if (notifyRenderer) emitClosed(record);
  for (const tab of record.tabs.values()) {
    forgetBrowserTab(record.ownerUserId, tab.conversationId, tab.id);
    clearWebAssistActionGrants({ tabId: tab.id });
    try { setTabVisible(tab, false); } catch { /* best effort */ }
    try { record.owner.contentView.removeChildView(tab.view); } catch { /* best effort */ }
    try {
      if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    } catch { /* best effort */ }
  }
  record.tabs.clear();
  record.activeTabId = '';
}

function recordForSender(sender: WebContents): WebAssistRecord | null {
  const owner = BrowserWindow.fromWebContents(sender);
  if (!owner || owner.isDestroyed()) return null;
  const record = records.get(owner.id);
  return record && record.owner.webContents === sender ? record : null;
}

function invalidateObservation(tab: WebAssistTabRecord): void {
  tab.observation = undefined;
}

function setTabVisible(tab: WebAssistTabRecord, visible: boolean): void {
  if (tab.visible !== visible) tab.lastUsedAt = Date.now();
  tab.visible = visible;
  tab.view?.setVisible(visible);
}

/** Lay every task page out at desktop width, scaled into whatever room the
 *  drawer has.
 *
 *  The drawer defaults to about 30% of the app window, which is a phone
 *  viewport, and mobile layouts omit rather than rearrange: tables, bulk
 *  controls and secondary navigation are absent from the DOM below a
 *  breakpoint. A person notices a cramped page and widens it; a model sees a
 *  DOM where the control it needs was never rendered and cannot tell that from
 *  the control not existing.
 *
 *  An earlier version applied this only while a tab was hidden, on the
 *  reasoning that widening a layout nobody is looking at costs no pixels. That
 *  was self-defeating: `exposeTaskTabToModel` reveals the tab on every model
 *  operation in a foreground task, the renderer then lays it out, and the
 *  layout marked it visible — so the case the emulation was for was exactly
 *  the case that switched it off. Measured 2026-09-18 at innerWidth=408 with a
 *  mobile layout, which is the bug.
 *
 *  The cost is real and is the user's to manage: at the default width the page
 *  renders about 2.2x smaller than the mobile layout would. Widening the
 *  drawer raises the scale directly, and past DESKTOP_VIEWPORT_WIDTH the
 *  emulation disengages because the viewport is genuinely a desktop one. */
function applyDesktopViewport(tab: WebAssistTabRecord): void {
  const contents = tab.view?.webContents;
  if (!contents || contents.isDestroyed()) return;
  const width = Math.round(Number(tab.bounds?.width) || 0);
  const height = Math.round(Number(tab.bounds?.height) || 0);
  try {
    if (width >= DESKTOP_VIEWPORT_WIDTH) {
      // Already desktop. Let the real viewport through rather than emulating
      // a narrower one on top of it.
      if (tab.virtualViewport) {
        contents.disableDeviceEmulation();
        tab.virtualViewport = false;
        tab.virtualViewportWidth = 0;
        tab.virtualViewportHeight = 0;
      }
      return;
    }
    // A tab with no bounds has never been laid out and nobody is looking at
    // it; emulate unscaled so its layout is still a desktop one.
    const scale = width > 0 ? width / DESKTOP_VIEWPORT_WIDTH : 1;
    const emulatedHeight = height > 0
      ? Math.round(height / scale)
      : DESKTOP_VIEWPORT_HEIGHT;
    if (tab.virtualViewport && tab.virtualViewportWidth === width && tab.virtualViewportHeight === height) return;
    const size = { width: DESKTOP_VIEWPORT_WIDTH, height: emulatedHeight };
    contents.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: size,
      viewPosition: { x: 0, y: 0 },
      viewSize: size,
      deviceScaleFactor: 0,
      scale,
    });
    tab.virtualViewport = true;
    tab.virtualViewportWidth = width;
    tab.virtualViewportHeight = height;
  } catch (error) {
    log.warn('desktop viewport emulation failed', { error: logErrorRef(error) });
  }
}

// Inspect only structural reload hazards. No field contents leave the page.
// Opaque frames and rich editors are conservatively retained.
export const webAssistIdleSafetyScript = `(() => {
  const safeDocument = (doc) => {
    // A recreated WebContents cannot restore tab-scoped storage without copying secrets.
    if (doc.defaultView.sessionStorage.length) return false;
    if (doc.querySelector('[contenteditable]:not([contenteditable="false"])')) return false;
    for (const el of doc.querySelectorAll('input,textarea,select')) {
      if (el.type === 'password' || el.autocomplete === 'one-time-code') return false;
      if (el.tagName === 'SELECT') {
        if ([...el.options].some(o => o.selected !== o.defaultSelected)) return false;
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked !== el.defaultChecked) return false;
      } else if (el.type === 'file' ? el.files.length > 0 : el.value !== el.defaultValue) return false;
    }
    for (const media of doc.querySelectorAll('audio,video')) if (!media.paused && !media.ended) return false;
    for (const frame of doc.querySelectorAll('iframe,frame')) {
      if (!frame.contentDocument || !safeDocument(frame.contentDocument)) return false;
    }
    return true;
  };
  try { return safeDocument(document); } catch { return false; }
})()`;

function canUnloadTab(record: WebAssistRecord, tab: WebAssistTabRecord, now: number): boolean {
  return records.get(record.owner.id) === record && record.tabs.get(tab.id) === tab
    && !!tab.view && !tab.view.webContents.isDestroyed() && !tab.suspended
    && !tab.visible && now - tab.lastUsedAt >= IDLE_PAGE_TIMEOUT_MS
    && !tab.loading && !tab.view.webContents.isLoading() && !tab.activeOperations
    && !tab.assistantAction && !tab.edited && tab.replayable
    && tab.lifetime.retention !== 'handoff' && tab.controlContext?.scope !== 'connector_setup'
    && !tab.authorizationPopups.size
    && ![...tab.relatedTabs].some(id => record.tabs.has(id))
    && !tab.view.webContents.isCurrentlyAudible();
}

/** Host maintenance only. Listing tabs never calls this or wakes a page. */
export async function reclaimIdleWebAssistPages(now = Date.now(), ownerId?: number): Promise<void> {
  for (const record of records.values()) for (const tab of record.tabs.values()) {
    if ((ownerId !== undefined && record.owner.id !== ownerId) || tab.idleCheckInFlight || !canUnloadTab(record, tab, now)) continue;
    const view = tab.view;
    const touchedAt = tab.lastUsedAt;
    const url = safeWebAssistUrl(view.webContents.getURL());
    if (!url) continue; // Empty/document-written contexts cannot be replayed.
    tab.idleCheckInFlight = true;
    let timer: ReturnType<typeof setTimeout>;
    try {
      const safe = await Promise.race([
        executeWebAssistScript(view.webContents, webAssistIdleSafetyScript),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
      ]);
      if (safe !== true || tab.view !== view || tab.lastUsedAt !== touchedAt
          || view.webContents.getURL() !== url || !canUnloadTab(record, tab, now)) continue;
      const history = view.webContents.navigationHistory;
      const entries = history.getAllEntries().map(entry => ({ url: entry.url, title: safeLabel(entry.title) }));
      if (entries.length > 100 || entries.some(entry => !safeWebAssistUrl(entry.url))) continue;
      const saved = { url, title: safeLabel(view.webContents.getTitle()), entries, index: history.getActiveIndex() };
      // Respect the page's beforeunload veto. Do not force-close unsaved work.
      const veto = () => {
        if (tab.view !== view) return;
        tab.edited = true;
        tab.suspended = undefined;
        tab.wakeAfterUnload = false;
        emit(record);
      };
      view.webContents.once('will-prevent-unload', veto);
      tab.suspended = saved;
      invalidateObservation(tab);
      view.webContents.close({ waitForBeforeUnload: true });
    } catch {
      // A busy, inaccessible or changed document is not evidence of safe reload.
      if (tab.view === view) tab.suspended = undefined;
    } finally {
      clearTimeout(timer!);
      tab.idleCheckInFlight = false;
    }
  }
}

/** Recreate only the requested tab, retaining its logical ID and account profile. */
function ensureTabLoaded(record: WebAssistRecord, tab: WebAssistTabRecord, load = true, historyIndex?: number): boolean {
  tab.lastUsedAt = Date.now();
  if (tab.suspended && tab.view && !tab.view.webContents.isDestroyed()) {
    tab.wakeAfterUnload = true;
    return false;
  }
  if (tab.view && !tab.view.webContents.isDestroyed()) return true;
  const saved = tab.suspended;
  if (!saved) return false;
  try {
    mountTab(record, tab);
    tab.suspended = undefined;
    tab.wakeAfterUnload = false;
    tab.loading = true;
    tab.errorCode = undefined;
    invalidateObservation(tab);
    const view = tab.view;
    if (!load) return true;
    const loaded = saved.entries.length
      ? view.webContents.navigationHistory.restore({ entries: saved.entries, index: historyIndex ?? saved.index })
      : view.webContents.loadURL(saved.url);
    loaded.catch(() => undefined);
    return true;
  } catch {
    tab.errorCode = 'page_load_failed';
    logWebAssistFailure(record.owner.webContents, 'view_unavailable');
    emit(record);
    return false;
  }
}

function navigateTabHistory(record: WebAssistRecord, tab: WebAssistTabRecord, action: unknown):
  { ok: true } | { ok: false; code: string; error: string } {
  const unavailable = { ok: false as const, code: 'navigation_unavailable', error: 'This browser navigation is unavailable.' };
  if (!['back', 'forward', 'reload'].includes(String(action))) return unavailable;
  const saved = tab.suspended;
  const index = saved ? saved.index + (action === 'back' ? -1 : action === 'forward' ? 1 : 0) : undefined;
  if (saved && action !== 'reload' && (index! < 0 || index! >= saved.entries.length)) return unavailable;
  if (!ensureTabLoaded(record, tab, true, index)) {
    return { ok: false, code: 'page_loading', error: 'The page is being restored; wait before navigating.' };
  }
  // Restoration itself navigates directly to the requested history entry.
  if (!saved) {
    const contents = tab.view.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === 'reload') contents.reload();
    else return unavailable;
  }
  invalidateObservation(tab);
  return { ok: true };
}

/** Drop every binding held by a sender once its window goes away. Registered
 *  once per sender so repeated binds do not stack listeners. */
function trackBoundSender(sender: WebContents): void {
  const senderObject = sender as unknown as object;
  if (boundSenders.has(senderObject)) return;
  boundSenders.add(senderObject);
  const eventSender = sender as WebContents & { once?: (event: string, listener: () => void) => void };
  eventSender.once?.('destroyed', () => {
    for (const [bindingKey, binding] of conversationBindings) {
      if (binding.sender === sender) conversationBindings.delete(bindingKey);
    }
  });
}

/** Bind a renderer-originated conversation turn to its owning app window. */
export function bindWebAssistConversation(
  userId: string,
  conversationId: string,
  sender: WebContents,
): boolean {
  if (!safeId(userId)
      || !safeId(conversationId)
      || !sender
      || typeof sender.isDestroyed !== 'function'
      || sender.isDestroyed()) return false;
  const key = conversationBindingKey(userId, conversationId);
  conversationBindings.set(key, { userId, conversationId, sender });
  // A renderer send is the user arriving in this conversation, so it also
  // becomes the foreground task for that window.
  activeConversationBySender.set(sender as unknown as object, conversationId);
  trackBoundSender(sender);
  return true;
}

/** Windows that actually show the app, in creation order.
 *
 *  `BrowserWindow.getAllWindows()` also returns the offscreen hosts that PDF,
 *  Office, HTML-preview, video and web-fetch rendering create while a turn runs.
 *  Hosting a task browser in one of those would attach the page to a window the
 *  user can never see and that is destroyed as soon as its render finishes, so
 *  match the renderer entry document rather than taking whichever window is
 *  first. Only the app window is ever loaded from `renderer/index.html`. */
function liveAppWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((candidate) => {
    if (candidate.isDestroyed() || candidate.webContents.isDestroyed()) return false;
    try {
      const url = new URL(candidate.webContents.getURL());
      return url.protocol === 'file:' && url.pathname.endsWith('/renderer/index.html');
    } catch {
      return false;
    }
  });
}

/** How the app entry makes a window, for turns that start without one.
 *
 *  The browser needs a *restorable* window, not a visible one: every protected
 *  step — credentials, OTP, upload, CAPTCHA — ends with a human acting in the
 *  page, so a window that can never be surfaced is not an acceptable host. A
 *  minimised real window satisfies both halves.
 *
 *  Registered by `index.ts`; absent under tests and in builds that strip the
 *  app entry, where binding fails exactly as it did before. */
let appWindowFactory: (() => BrowserWindow) | null = null;

export function setAppWindowFactory(factory: (() => BrowserWindow) | null): void {
  appWindowFactory = factory;
}

/** Make a window for an unattended turn without taking the user's screen. */
function createUnattendedAppWindow(): BrowserWindow | null {
  if (!appWindowFactory) return null;
  try {
    const created = appWindowFactory();
    if (!created || created.isDestroyed()) return null;
    // Nobody asked to look at this. Minimise rather than claim the foreground;
    // `surfaceAppWindow` brings it back when the turn actually needs a human.
    try { if (created.isFocusable() && !created.isMinimized()) created.minimize(); } catch { /* platform */ }
    return liveAppWindows().includes(created) ? created : null;
  } catch (error) {
    log.warn('unattended app window creation failed', { error: logErrorRef(error) });
    return null;
  }
}

/** Bring the app window back for a step only a human can complete.
 *
 *  No-ops when the window is already on screen. A visible window is somewhere
 *  the user can already reach, so taking focus from whatever they are doing
 *  buys nothing; the case worth interrupting for is the unattended one, where
 *  the window is minimised or was created for this run. */
export function surfaceAppWindow(): boolean {
  const win = liveAppWindows()[0];
  if (!win || !win.isFocusable()) return false;
  if (win.isVisible() && !win.isMinimized()) return false;
  try {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    return true;
  } catch (error) {
    log.warn('surfacing the app window failed', { error: logErrorRef(error) });
    return false;
  }
}

/** Give a host-started turn the window its task browser needs.
 *
 *  Automation fires and project-driver advances reach `groupChat.send` directly
 *  instead of through the renderer IPC that binds a conversation, and both
 *  create the conversation they are about to run — so its id can never have
 *  been bound by a user send. Without an owner window every `inner_browser`
 *  operation fails as `window_unavailable`, down to merely listing tabs, and
 *  the model is told to "open this task in Orkas" for a task nobody opened.
 *
 *  Unlike the renderer bind this must NOT claim foreground: the user did not
 *  navigate here. Leaving `activeConversationBySender` untouched keeps
 *  `taskIsForeground` false for this conversation, so a tab the turn opens
 *  stays behind whatever the user is actually watching.
 *
 *  Returns false only when the app genuinely has no live window — the one case
 *  where a browser turn really cannot run. */
export function bindHostStartedWebAssistConversation(
  userId: string,
  conversationId: string,
): boolean {
  if (!safeId(userId) || !safeId(conversationId)) return false;
  // An existing binding is either this same window or the renderer the user is
  // working in; both outrank an arbitrary pick, so never overwrite one.
  if (boundSender(userId, conversationId)) return true;
  // An automation fire or driver advance can land with every window closed —
  // routine on macOS, where `window-all-closed` deliberately does not quit.
  // Ensure a window rather than reporting the browser unavailable.
  const owner = liveAppWindows()[0] || createUnattendedAppWindow();
  if (!owner) return false;
  const sender = owner.webContents;
  conversationBindings.set(
    conversationBindingKey(userId, conversationId),
    { userId, conversationId, sender },
  );
  trackBoundSender(sender);
  return true;
}

/** Track which conversation's Browser tab is actually foreground in a renderer. */
export function setActiveWebAssistConversation(
  sender: WebContents,
  conversationId: unknown,
): { ok: true } | { ok: false; code: string; error: string } {
  if (!sender || typeof sender.isDestroyed !== 'function' || sender.isDestroyed()) {
    return { ok: false, code: 'window_unavailable', error: 'The Orkas window is unavailable.' };
  }
  const value = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (value && !safeId(value)) {
    return { ok: false, code: 'invalid_conversation', error: 'The active task is invalid.' };
  }
  activeConversationBySender.set(sender as unknown as object, value);
  return { ok: true };
}

function boundSender(userId: string, conversationId: string): WebContents | null {
  const key = conversationBindingKey(userId, conversationId);
  const binding = conversationBindings.get(key);
  if (!binding || binding.sender.isDestroyed()) {
    conversationBindings.delete(key);
    return null;
  }
  return binding.sender;
}

/** Explain an unbound conversation without guessing at the cause.
 *
 *  "Open this task in Orkas" is only actionable while a window exists to open
 *  it in. With every window gone — the app running from the tray or dock — the
 *  browser is unavailable for a reason no reader of the task can act on, and
 *  saying otherwise sends the model into retries that cannot succeed. */
function unboundSenderFailure(subject: string): { ok: false; code: string; error: string } {
  const hasWindow = liveAppWindows().length > 0;
  return {
    ok: false,
    code: 'window_unavailable',
    error: hasWindow
      ? `Open this ${subject} in Orkas to use its browser.`
      : 'No Orkas window is open, so this browser is unavailable until one is.',
  };
}

function controlledRecord(
  userId: string,
  conversationId: string,
  scopeId: string,
): { ok: true; record: WebAssistRecord; tab: WebAssistTabRecord } | { ok: false; code: string; error: string } {
  const sender = boundSender(userId, conversationId);
  if (!sender) {
    return unboundSenderFailure('conversation');
  }
  const record = recordForSender(sender);
  if (!record) {
    return { ok: false, code: 'not_open', error: 'Web Assist is not open for this connector.' };
  }
  const tab = [...record.tabs.values()].find((candidate) => {
    const context = candidate.controlContext;
    return context?.userId === userId
      && context.conversationId === conversationId
      && context.scope === 'connector_setup'
      && context.scopeId === scopeId;
  });
  if (!tab) {
    return { ok: false, code: 'scope_mismatch', error: 'This Web Assist page is not bound to the requested connector setup.' };
  }
  return { ok: true, record, tab };
}

type WebAssistResolvedTaskTab =
  | {
      ok: true;
      sender: WebContents;
      record: WebAssistRecord;
      tab: WebAssistTabRecord;
    }
  | { ok: false; code: string; error: string };

/** Whether the user is currently looking at this task in the owning window.
 *  Task scoping and authority come from the sender binding plus each tab's
 *  conversationId, so this answers a UI question only: a background task still
 *  drives its own tabs, it just must not take over what the user is watching. */
function taskIsForeground(sender: WebContents, conversationId: string): boolean {
  return activeConversationBySender.get(sender as unknown as object) === conversationId;
}

function taskTab(
  userId: string,
  conversationId: string,
  tabId?: unknown,
): WebAssistResolvedTaskTab {
  if (!safeId(userId) || !safeId(conversationId)) {
    return { ok: false, code: 'invalid_scope', error: 'The browser task scope is invalid.' };
  }
  const sender = boundSender(userId, conversationId);
  if (!sender) {
    return unboundSenderFailure('task');
  }
  const record = recordForSender(sender);
  if (!record) return { ok: false, code: 'not_open', error: 'This task has no browser tabs.' };
  const requestedId = typeof tabId === 'string' ? tabId.trim() : '';
  const selected = requestedId
    ? record.tabs.get(requestedId)
    : (
        record.tabs.get(record.activeTabId)?.conversationId === conversationId
          ? record.tabs.get(record.activeTabId)
          : [...record.tabs.values()].find((candidate) => candidate.conversationId === conversationId)
      );
  if (!selected || selected.conversationId !== conversationId) {
    return { ok: false, code: 'unknown_tab', error: 'This browser tab is unavailable in the current task.' };
  }
  return { ok: true, sender, record, tab: selected };
}

function exposeTaskTabToModel(
  resolved: Extract<WebAssistResolvedTaskTab, { ok: true }>,
): { ok: true } | { ok: false; code: string; error: string } {
  const { sender, record, tab } = resolved;
  if (!ensureTabLoaded(record, tab)) return { ok: false, code: tab.suspended && tab.view ? 'page_loading' : 'page_unavailable', error: 'The page is not ready. Wait, then observe it again.' };
  // A generic browser operation supersedes connector-specific authority on
  // this tab. This prevents connector_setup from inheriting an arbitrary URL
  // or page state selected through the broader browser contract. This is
  // authority rather than presentation, so it applies in the background too.
  tab.controlContext = {
    userId: record.ownerUserId,
    conversationId: tab.conversationId,
    scope: 'browser',
    scopeId: tab.id,
  };
  // A background task drives its own tab without selecting it or revealing the
  // panel over whatever the user is watching. The renderer re-reads state when
  // the user returns to this task, so nothing needs to be pushed now.
  if (!taskIsForeground(sender, tab.conversationId)) return { ok: true };
  record.activeTabId = tab.id;
  for (const candidate of record.tabs.values()) {
    if (candidate !== tab) setTabVisible(candidate, false);
  }
  try {
    sender.send('web-assist:show', rendererSnapshot(record));
    return { ok: true };
  } catch (error) {
    log.warn('model browser show failed', { error: logErrorRef(error) });
    return { ok: false, code: 'renderer_unavailable', error: 'The task browser could not be shown.' };
  }
}

async function withAssistantAction<T>(
  record: WebAssistRecord,
  tab: WebAssistTabRecord,
  action: NonNullable<WebAssistSnapshot['assistant_action']>,
  run: () => Promise<T>,
): Promise<T> {
  tab.activeOperations += 1;
  tab.lastUsedAt = Date.now();
  // Connector and generic browser work share the same selected tab and UI
  // activity signal. The renderer owns whether to reveal or keep it hidden.
  if (activeConversationBySender.get(record.owner.webContents as unknown as object) === tab.conversationId) {
    record.activeTabId = tab.id;
    for (const candidate of record.tabs.values()) {
      if (candidate !== tab) setTabVisible(candidate, false);
    }
  }
  tab.assistantAction = action;
  emit(record);
  try {
    return await run();
  } finally {
    tab.activeOperations -= 1;
    tab.lastUsedAt = Date.now();
    tab.assistantAction = undefined;
    emit(record);
  }
}

function executeWebAssistScript(
  contents: WebContents,
  code: string,
  userGesture = false,
): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(
    WEB_ASSIST_ISOLATED_WORLD_ID,
    [{ code }],
    userGesture,
  );
}

function readWebAssistTextCondition(contents: WebContents, text: string, deadline: number): Promise<unknown> {
  // Native evaluation can remain pending on an unresponsive page. Bound each
  // read by the shared wait deadline; timing out does not cancel native work.
  return withOperationTimeout(
    executeWebAssistScript(contents, buildWebAssistTextConditionScript(text)),
    { timeoutMs: Math.max(1, deadline - Date.now()), code: 'wait_timeout', stage: 'browser text condition' },
  );
}

// Native load events own navigation status. A loadURL/restore promise can reject
// after a replacement navigation starts (including ERR_ABORTED), so its catch
// must never overwrite the current page's state.
function handleLoadFailure(record: WebAssistRecord, tab: WebAssistTabRecord, netCode: number): void {
  tab.loading = false;
  tab.errorCode = 'page_load_failed';
  logWebAssistFailure(record.owner.webContents, 'page_load_failed', netCode);
  emit(record);
}

function configureWebAssistPopup(popup: BrowserWindow, proxy: ReturnType<typeof prepareBrowserProxy>): void {
  const contents = popup.webContents;
  proxy.attach(contents);
  popup.setMenuBarVisibility(false);
  // Authorization popups may communicate with their opener, but cannot create
  // an unbounded window tree of their own.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guardNavigation = (event: { preventDefault(): void }, target: string): void => {
    if (!safeWebAssistUrl(target)) event.preventDefault();
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
}

function createRecord(owner: BrowserWindow, userId: string): WebAssistRecord {
  let record!: WebAssistRecord;
  record = {
    owner,
    ownerUserId: userId,
    tabs: new Map(),
    activeTabId: '',
    ownerClosed: () => {},
  };
  record.ownerClosed = () => closeRecord(record);
  owner.once('closed', record.ownerClosed);
  record.idleTimer = setInterval(() => { void reclaimIdleWebAssistPages(Date.now(), record.owner.id); }, IDLE_PAGE_SCAN_MS);
  record.idleTimer.unref();
  return record;
}

function removeTab(record: WebAssistRecord, tab: WebAssistTabRecord, notifyRenderer = true): void {
  if (record.tabs.get(tab.id) !== tab) return;
  forgetBrowserTab(record.ownerUserId, tab.conversationId, tab.id);
  clearWebAssistActionGrants({ tabId: tab.id });
  record.tabs.delete(tab.id);
  for (const candidate of record.tabs.values()) candidate.relatedTabs.delete(tab.id);
  try { setTabVisible(tab, false); } catch { /* best effort */ }
  try { record.owner.contentView.removeChildView(tab.view); } catch { /* best effort */ }
  try {
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
  } catch { /* best effort */ }
  if (record.activeTabId === tab.id) {
    const sameConversation = [...record.tabs.values()].find((candidate) => (
      candidate.conversationId === tab.conversationId
    ));
    record.activeTabId = sameConversation?.id || activeTab(record)?.id || '';
  }
  if (!record.tabs.size) {
    closeRecord(record, notifyRenderer);
  } else if (notifyRenderer) {
    emit(record);
  }
}

function createTab(
  record: WebAssistRecord,
  conversationId: string,
  label: string,
  createdBy: BrowserTabLifetime['createdBy'] = 'user',
  options: WebContentsViewConstructorOptions & { activate?: boolean } = {},
): WebAssistTabRecord {
  const tab: WebAssistTabRecord = {
    id: genId12(), lifetime: { createdBy }, conversationId, label,
    visible: false, lastUsedAt: Date.now(), activeOperations: 0, edited: false,
    replayable: !options.webContents, relatedTabs: new Set(),
    loading: false, authorizationPopups: new Set(),
  };
  mountTab(record, tab, options);
  record.tabs.set(tab.id, tab);
  tab.lifetime = registerBrowserTab(record.ownerUserId, conversationId, tab.id, createdBy, () => {
    removeTab(record, tab, true);
  });
  if (options.activate !== false) record.activeTabId = tab.id;
  return tab;
}

function mountTab(
  record: WebAssistRecord, tab: WebAssistTabRecord,
  options: WebContentsViewConstructorOptions = {},
): void {
  const conversationId = tab.conversationId;
  const profileDir = userWebAssistProfileDir(record.ownerUserId);
  fs.mkdirSync(profileDir, { recursive: true });
  const ses = session.fromPath(profileDir, { cache: true });
  const proxy = configureSession(record.ownerUserId, ses);

  const view = new WebContentsView({
    ...(options.webContents ? { webContents: options.webContents } : {}),
    webPreferences: hardenedWebPreferences({
      ...options.webPreferences,
      session: ses,
      devTools: false,
      spellcheck: true,
      // A task tab is routinely off screen: another conversation is in front,
      // Task Details is closed, or an unattended run made a minimised window.
      // Chromium's default clamps a hidden renderer's timers to 1 Hz, measured
      // here at 20 ticks/s visible against 1.0 ticks/s minimised — a page that
      // polls or drives itself on a timer effectively stops while the agent is
      // waiting on it.
      //
      // Measured cost of turning that off: a parked page stays at 0% CPU, and
      // a page running a continuous rAF animation — the worst case — reaches
      // 0.9%. Idle reclamation still closes any tab left unattended for ten
      // minutes, so nothing accumulates. Scoped to task tabs; authorization
      // popups below keep the default, since a popup the user is completing is
      // on screen anyway.
      backgroundThrottling: false,
    }),
  });
  try {
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    view.setBounds(tab.bounds || { x: 0, y: 0, width: 800, height: 600 });
    record.owner.contentView.addChildView(view);
  } catch (error) {
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    } catch { /* best effort */ }
    throw error;
  }
  tab.view = view;
  tab.virtualViewport = false;

  const contents = view.webContents;
  proxy.attach(contents);
  contents.on('before-input-event', () => { tab.lastUsedAt = Date.now(); tab.edited = true; });
  contents.on('before-mouse-event', () => { tab.lastUsedAt = Date.now(); });
  contents.setWindowOpenHandler((details) => {
    const { url, disposition } = details;
    if (records.get(record.owner.id) !== record || record.tabs.get(tab.id) !== tab) {
      return { action: 'deny' };
    }
    if (url !== 'about:blank' && !safeWebAssistUrl(url)) return { action: 'deny' };
    // Chromium has already interpreted target, popup features and click
    // modifiers. Do not infer a window type from page content or URL keywords.
    if (disposition === 'foreground-tab' || disposition === 'background-tab' || disposition === 'default') {
      if (!tabCapacityVictims(record, conversationId, tab.id)) return { action: 'deny' };
      const createdBy = tab.assistantAction ? 'model' : 'user';
      return {
        action: 'allow',
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          webPreferences: hardenedWebPreferences({ session: ses, devTools: false, spellcheck: true }),
        },
        createWindow: (windowOptions) => {
          // Electron supplies this guest at runtime; its constructor type omits it.
          const nativeOptions = windowOptions as typeof windowOptions & { webContents?: WebContents };
          // Adopt Chromium's guest rather than cancelling and reopening the URL:
          // this preserves opener, named targets, POST and referrer semantics.
          const activate = disposition !== 'background-tab'
            && activeConversationBySender.get(record.owner.webContents as unknown as object) === conversationId;
          const created = createTabWithinLimit(record, conversationId, '', createdBy, {
            webContents: nativeOptions.webContents,
            webPreferences: nativeOptions.webPreferences,
            activate,
          }, tab.id);
          if (!created) throw new Error('The browser task has no available tab slot.');
          const child = created.tab;
          tab.relatedTabs.add(child.id);
          child.relatedTabs.add(tab.id);
          if (activate) {
            for (const candidate of record.tabs.values()) {
              if (candidate !== child) setTabVisible(candidate, false);
            }
          }
          // Browser-process opens (e.g. middle-click) have no pre-created guest.
          // Electron delegates their navigation to createWindow as well.
          if (!nativeOptions.webContents) {
            const post = details.postBody;
            child.loading = true;
            child.view.webContents.loadURL(url, {
              httpReferrer: details.referrer,
              ...(post ? {
                postData: post.data,
                extraHeaders: `content-type: ${post.contentType}${post.boundary ? `; boundary=${post.boundary}` : ''}`,
              } : {}),
            }).catch(() => undefined);
          }
          emit(record);
          return child.view.webContents;
        },
      };
    }
    if (disposition !== 'new-window') return { action: 'deny' };
    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        parent: record.owner,
        modal: false,
        // Native authorization windows inherit the host's background E2E mode.
        show: record.owner.isFocusable(),
        focusable: record.owner.isFocusable(),
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: hardenedWebPreferences({
          session: ses,
          devTools: false,
          spellcheck: true,
        }),
      },
    };
  });
  contents.on('did-create-window', (popup) => {
    tab.authorizationPopups.add(popup.webContents);
    popup.webContents.once('destroyed', () => tab.authorizationPopups.delete(popup.webContents));
    configureWebAssistPopup(popup, proxy);
  });
  const guardNavigation = (event: { preventDefault(): void }, target: string): void => {
    if (!safeWebAssistUrl(target)) event.preventDefault();
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.on('did-start-navigation', (_event, _url, _isSameDocument, isMainFrame) => {
    if (tab.view !== view) return;
    if (isMainFrame) {
      tab.lastUsedAt = Date.now();
      if (!_isSameDocument) tab.edited = false;
      invalidateObservation(tab);
    }
  });
  contents.on('did-start-loading', () => {
    if (tab.view !== view) return;
    tab.loading = true;
    tab.errorCode = undefined;
    emit(record);
  });
  contents.on('did-stop-loading', () => {
    if (tab.view !== view) return;
    tab.loading = false;
    emit(record);
  });
  contents.on('did-navigate', () => {
    if (tab.view !== view) return;
    // Error documents also emit did-finish-load; only a committed navigation
    // proves that a new page has replaced the previous load failure.
    if (tab.errorCode === 'page_load_failed') tab.errorCode = undefined;
    // A committed navigation drops Chromium's emulation, and the cached flag
    // would otherwise keep us from noticing. Measured 2026-09-19: a reload put
    // the page back to the drawer's own width with the flag still set, so the
    // next observe short-circuited and never restored it. Re-apply here rather
    // than at observe, so the new document's own scripts see the width too.
    tab.virtualViewport = false;
    tab.virtualViewportWidth = 0;
    applyDesktopViewport(tab);
    invalidateObservation(tab);
    emit(record);
  });
  contents.on('did-navigate-in-page', () => {
    if (tab.view !== view) return;
    invalidateObservation(tab);
    emit(record);
  });
  contents.on('page-title-updated', () => { if (tab.view === view) emit(record); });
  contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (tab.view === view && isMainFrame && errorCode !== -3) handleLoadFailure(record, tab, errorCode);
  });
  contents.on('unresponsive', () => {
    if (tab.view !== view) return;
    tab.errorCode = 'page_unresponsive';
    logWebAssistFailure(record.owner.webContents, 'page_unresponsive');
    emit(record);
  });
  contents.on('render-process-gone', (_event, details) => {
    if (tab.view !== view) return;
    tab.loading = false;
    tab.errorCode = 'page_load_failed';
    if (details?.reason !== 'clean-exit') logWebAssistFailure(record.owner.webContents, 'renderer_gone');
    emit(record);
  });
  contents.once('destroyed', () => {
    if (tab.view !== view || records.get(record.owner.id) !== record || record.tabs.get(tab.id) !== tab) return;
    if (tab.suspended) {
      tab.view = undefined;
      tab.loading = false;
      try { record.owner.contentView.removeChildView(view); } catch { /* owner may be closing */ }
      if (tab.wakeAfterUnload) ensureTabLoaded(record, tab);
      emit(record);
      return;
    }
    // A page may close its own top-level browsing context. Keep the trusted
    // toolbar and the native child-view registry in sync even when closing
    // did not originate from the Orkas close button.
    if (records.get(record.owner.id) !== record || record.tabs.get(tab.id) !== tab) return;
    removeTab(record, tab, true);
  });
}

function tabCapacityVictims(
  record: WebAssistRecord, conversationId: string, openerId?: string,
): WebAssistTabRecord[] | null {
  const tabs = [...record.tabs.values()].filter(tab => tab.conversationId === conversationId);
  const needed = Math.max(0, tabs.length + 1 - MAX_TABS_PER_CONVERSATION);
  const removable = tabs.filter(tab => (
    tab.id !== record.activeTabId
    && tab.id !== openerId
    && tab.lifetime.createdBy === 'model'
    && tab.lifetime.retention !== 'handoff'
    && tab.lifetime.retention !== 'deliverable'
    && tab.controlContext?.scope !== 'connector_setup'
    && !tab.loading && !tab.assistantAction && !tab.edited
    && !tab.authorizationPopups.size
  )).slice(0, needed);
  return removable.length < needed ? null : removable;
}

/** Make room only inside this task, in opening order, without discarding handoffs. */
function createTabWithinLimit(
  record: WebAssistRecord, conversationId: string, label: string,
  createdBy: BrowserTabLifetime['createdBy'] = 'user',
  options: WebContentsViewConstructorOptions & { activate?: boolean } = {},
  openerId?: string,
): { tab: WebAssistTabRecord; closedTabIds: string[] } | null {
  const removable = tabCapacityVictims(record, conversationId, openerId);
  if (!removable) return null;
  // Allocate first: a native-view creation failure must not lose existing work.
  // createTab does not emit state, so the renderer never sees an eleventh tab.
  const tab = createTab(record, conversationId, label, createdBy, options);
  for (const old of removable) removeTab(record, old, false);
  return { tab, closedTabIds: removable.map(old => old.id) };
}

function tabLimitFailure() {
  return {
    ok: false as const, code: 'too_many_tabs', tab_limit: MAX_TABS_PER_CONVERSATION,
    error: 'This task has reached its 10-tab limit with no safely removable old model tab. Reuse an existing tab with navigate, or close an unneeded tab before opening another.',
  };
}

export async function openWebAssist(
  userId: string,
  sender: WebContents,
  input: { url?: unknown; label?: unknown; conversationId?: unknown; tabId?: unknown },
  createdBy: BrowserTabLifetime['createdBy'] = 'user',
): Promise<{ ok: true; state: WebAssistSnapshot; closed_tab_ids: string[]; tab_id: string } | { ok: false; code: string; error: string }> {
  if (!safeId(userId)) return { ok: false, code: 'invalid_user', error: 'Web Assist is unavailable for this account.' };
  const url = safeWebAssistUrl(input?.url);
  if (!url) return { ok: false, code: 'invalid_url', error: 'Open an HTTP or HTTPS page in Web Assist.' };
  const owner = BrowserWindow.fromWebContents(sender);
  if (!owner || owner.isDestroyed()) {
    return { ok: false, code: 'window_unavailable', error: 'The Orkas window is unavailable.' };
  }
  const conversationId = String(input?.conversationId || '');
  if (conversationId && !safeId(conversationId)) {
    return { ok: false, code: 'invalid_conversation', error: 'Open Web Assist from a valid task.' };
  }
  // A renderer-driven open is the user's own click and always presents. Only a
  // model-driven open can belong to a task running in the background, and that
  // one must not steal tab selection or visibility from the foreground task.
  const foreground = createdBy !== 'model' || taskIsForeground(sender, conversationId);

  let record = records.get(owner.id);
  let createdRecord = false;
  if (record && (record.owner.webContents !== sender || record.ownerUserId !== userId)) {
    closeRecord(record);
    record = undefined;
  }
  if (!record) {
    try {
      record = createRecord(owner, userId);
      records.set(owner.id, record);
      createdRecord = true;
    } catch (error) {
      logWebAssistFailure(sender, 'view_unavailable');
      return { ok: false, code: 'view_unavailable', error: 'Web Assist could not be opened.' };
    }
  }
  let tab: WebAssistTabRecord | undefined;
  let closedTabIds: string[] = [];
  const requestedTabId = typeof input?.tabId === 'string' ? input.tabId : '';
  if (requestedTabId) {
    tab = record.tabs.get(requestedTabId);
    if (!tab || (conversationId && tab.conversationId !== conversationId)) {
      return { ok: false, code: 'unknown_tab', error: 'This browser tab is unavailable.' };
    }
  }
  if (!tab) {
    try {
      const created = createTabWithinLimit(record, conversationId, safeLabel(input?.label), createdBy, { activate: foreground });
      if (!created) return tabLimitFailure();
      tab = created.tab;
      closedTabIds = created.closedTabIds;
    } catch (error) {
      logWebAssistFailure(sender, 'view_unavailable');
      if (createdRecord && !record.tabs.size) closeRecord(record);
      return { ok: false, code: 'view_unavailable', error: 'Web Assist could not be opened.' };
    }
  }
  tab.label = safeLabel(input?.label) || tab.label;
  if (!ensureTabLoaded(record, tab, false)) return { ok: false, code: 'page_unavailable', error: 'The page could not be restored. Try opening it again.' };
  tab.errorCode = undefined;
  // A renderer-originated navigation never inherits a model control grant.
  tab.controlContext = undefined;
  clearWebAssistActionGrants({ tabId: tab.id });
  tab.assistantAction = undefined;
  invalidateObservation(tab);
  tab.loading = true;
  if (foreground) {
    record.activeTabId = tab.id;
    for (const candidate of record.tabs.values()) {
      if (candidate !== tab) setTabVisible(candidate, false);
    }
  }
  emit(record);
  tab.view.webContents.loadURL(url).catch(() => undefined);
  // Report the tab this call actually opened. A background open leaves the
  // window's selection alone, so the snapshot's active tab may be another task.
  return { ok: true, state: rendererSnapshot(record), closed_tab_ids: closedTabIds, tab_id: tab.id };
}

export function addWebAssistTab(
  userId: string,
  sender: WebContents,
  input: { conversationId?: unknown; label?: unknown; ifEmpty?: unknown },
): { ok: true; state: WebAssistSnapshot } | { ok: false; code: string; error: string } {
  if (!safeId(userId)) return { ok: false, code: 'invalid_user', error: 'Web Assist is unavailable for this account.' };
  const conversationId = String(input?.conversationId || '');
  if (!safeId(conversationId)) return { ok: false, code: 'invalid_conversation', error: 'Open a task before adding a browser tab.' };
  const owner = BrowserWindow.fromWebContents(sender);
  if (!owner || owner.isDestroyed()) return { ok: false, code: 'window_unavailable', error: 'The Orkas window is unavailable.' };
  let record = records.get(owner.id);
  if (record && (record.owner.webContents !== sender || record.ownerUserId !== userId)) {
    closeRecord(record);
    record = undefined;
  }
  // Reopening browser chrome must not duplicate a task's existing tabs, even
  // when the renderer has not received the latest state yet.
  if (input?.ifEmpty === true && record
    && [...record.tabs.values()].some(tab => tab.conversationId === conversationId)) {
    return { ok: true, state: rendererSnapshot(record) };
  }
  let createdRecord = false;
  if (!record) {
    try {
      record = createRecord(owner, userId);
      records.set(owner.id, record);
      createdRecord = true;
    } catch (error) {
      logWebAssistFailure(sender, 'view_unavailable');
      return { ok: false, code: 'view_unavailable', error: 'Web Assist could not be opened.' };
    }
  }
  let tab: WebAssistTabRecord;
  try {
    const created = createTabWithinLimit(record, conversationId, safeLabel(input?.label), 'user', {
      activate: input?.ifEmpty !== true,
    });
    if (!created) return tabLimitFailure();
    tab = created.tab;
  } catch (error) {
    logWebAssistFailure(sender, 'view_unavailable');
    if (createdRecord && !record.tabs.size) closeRecord(record);
    return { ok: false, code: 'view_unavailable', error: 'Web Assist could not be opened.' };
  }
  if (input?.ifEmpty !== true) record.activeTabId = tab.id;
  emit(record);
  return { ok: true, state: rendererSnapshot(record) };
}

export async function navigateWebAssistTo(
  sender: WebContents,
  input: { tabId?: unknown; url?: unknown },
  activate = true,
): Promise<{ ok: true; state: WebAssistSnapshot } | { ok: false; code: string; error: string }> {
  const record = recordForSender(sender);
  if (!record) return { ok: false, code: 'not_open', error: 'Add a browser tab first.' };
  const tab = record.tabs.get(String(input?.tabId || ''));
  if (!tab) return { ok: false, code: 'unknown_tab', error: 'This browser tab is unavailable.' };
  const url = normalizeWebAssistUserUrl(input?.url);
  if (!url) return { ok: false, code: 'invalid_url', error: 'Enter a valid HTTP or HTTPS URL.' };
  if (!ensureTabLoaded(record, tab, false)) return { ok: false, code: 'page_unavailable', error: 'The page could not be restored. Try opening it again.' };
  tab.errorCode = undefined;
  tab.controlContext = undefined;
  clearWebAssistActionGrants({ tabId: tab.id });
  tab.assistantAction = undefined;
  invalidateObservation(tab);
  tab.loading = true;
  if (activate) record.activeTabId = tab.id;
  emit(record);
  tab.view.webContents.loadURL(url).catch(() => undefined);
  return { ok: true, state: rendererSnapshot(record) };
}

export function activateWebAssistTab(
  sender: WebContents,
  tabId: unknown,
): { ok: true; state: WebAssistSnapshot } | { ok: false; code: string; error: string } {
  const record = recordForSender(sender);
  const tab = record?.tabs.get(String(tabId || ''));
  if (!record || !tab) {
    return { ok: false, code: 'unknown_tab', error: 'This browser tab is unavailable.' };
  }
  record.activeTabId = tab.id;
  for (const candidate of record.tabs.values()) {
    if (candidate !== tab) setTabVisible(candidate, false);
  }
  ensureTabLoaded(record, tab);
  emit(record);
  return { ok: true, state: rendererSnapshot(record) };
}

export function closeWebAssistTab(
  sender: WebContents,
  tabId: unknown,
): { ok: true; closed: boolean; state: WebAssistSnapshot } | { ok: false; code: string; error: string } {
  const record = recordForSender(sender);
  const tab = record?.tabs.get(String(tabId || ''));
  if (!record || !tab) return { ok: true, closed: false, state: record ? rendererSnapshot(record) : emptySnapshot() };
  removeTab(record, tab, false);
  const liveRecord = recordForSender(sender);
  if (liveRecord) emit(liveRecord);
  else emitClosed(record);
  return { ok: true, closed: true, state: liveRecord ? rendererSnapshot(liveRecord) : emptySnapshot() };
}

export async function openControlledWebAssist(
  userId: string,
  conversationId: string,
  input: {
    scope: 'connector_setup';
    scopeId: string;
    url: unknown;
    label?: unknown;
  },
): Promise<{ ok: true; state: WebAssistSnapshot } | { ok: false; code: string; error: string }> {
  if (!safeId(userId) || !safeId(conversationId) || !safeId(input.scopeId)) {
    return { ok: false, code: 'invalid_scope', error: 'Web Assist control scope is invalid.' };
  }
  const sender = boundSender(userId, conversationId);
  if (!sender) {
    return unboundSenderFailure('conversation');
  }
  const opened = await openWebAssist(userId, sender, {
    url: input.url,
    label: input.label,
    conversationId,
  }, 'model');
  if (!opened.ok) return opened;
  const resolved = taskTab(userId, conversationId, opened.tab_id);
  if (resolved.ok === false) return resolved;
  const { record, tab } = resolved;
  tab.controlContext = {
    userId,
    conversationId,
    scope: input.scope,
    scopeId: input.scopeId,
  };
  invalidateObservation(tab);
  const state: WebAssistSnapshot = {
    open: true,
    ...tabSnapshot(tab),
    active_tab_id: tab.id,
    tabs: [...record.tabs.values()]
      .filter(candidate => candidate.conversationId === conversationId)
      .map(tabSnapshot),
  };
  if (!taskIsForeground(sender, conversationId)) return { ok: true, state };
  try {
    sender.send('web-assist:show', rendererSnapshot(record));
  } catch (error) {
    log.warn('controlled view show failed', { error: logErrorRef(error) });
    removeTab(record, tab, true);
    return { ok: false, code: 'renderer_unavailable', error: 'Web Assist could not be shown.' };
  }
  return { ok: true, state };
}

async function observeWebAssistTab(
  record: WebAssistRecord,
  tab: WebAssistTabRecord,
  scope: 'full' | 'meta' = 'full',
  window: WebAssistObserveWindow = {},
): Promise<Record<string, unknown>> {
  if (!ensureTabLoaded(record, tab)) return { ok: false, code: 'page_loading', error: 'The page is being restored; wait before observing it.' };
  const contents = tab.view.webContents;
  if (tab.loading || contents.isLoading()) {
    return { ok: false, code: 'page_loading', error: 'The page is still loading; wait before observing it.' };
  }
  const currentUrl = safeWebAssistUrl(contents.getURL());
  if (!currentUrl) return { ok: false, code: 'page_unavailable', error: 'There is no controllable web page.' };
  try {
    // Only after loading: before that this native API has no RenderViewHost.
    // Also covers the macOS case where a recreated hidden view would otherwise
    // have a zero-width Chromium viewport.
    applyDesktopViewport(tab);
    const raw = await withAssistantAction(record, tab, 'observing', () => (
      executeWebAssistScript(contents, webAssistObserveScript(tab.controlContext?.scope, window))
    ));
    if (contents.isDestroyed() || contents.getURL() !== currentUrl) {
      invalidateObservation(tab);
      return { ok: false, code: 'page_changed', error: 'The page changed while it was being observed; observe it again.' };
    }
    const pageId = genId12();
    const sanitized = sanitizeWebAssistObservation(raw, pageId, displayUrl(currentUrl));
    if (!sanitized) {
      return { ok: false, code: 'observation_failed', error: 'The page could not be observed.' };
    }
    tab.observation = { pageId, url: currentUrl, refs: sanitized.refs, hrefs: sanitized.hrefs };
    // `meta` walks and stores refs exactly as `full` does, then drops the page
    // payload from the reply. An act whose page_id went stale needs a fresh
    // page_id and valid refs, not the page re-read; charging a full observation
    // for that made scroll-then-read loops cost one whole page per step.
    if (scope === 'meta') {
      const { text, elements, ...rest } = sanitized.publicSnapshot as
        Record<string, unknown> & { text?: unknown; elements?: unknown };
      return {
        ok: true,
        tab_id: tab.id,
        ...rest,
        scope: 'meta',
        text_length: typeof text === 'string' ? text.length : 0,
      };
    }
    return { ok: true, tab_id: tab.id, ...sanitized.publicSnapshot };
  } catch (error) {
    log.warn('page observation failed', { error: logErrorRef(error) });
    invalidateObservation(tab);
    return { ok: false, code: 'observation_failed', error: 'The page could not be observed.' };
  }
}

export async function observeControlledWebAssist(
  userId: string,
  conversationId: string,
  scopeId: string,
): Promise<Record<string, unknown>> {
  const resolved = controlledRecord(userId, conversationId, scopeId);
  if (!('record' in resolved)) return { ok: false, code: resolved.code, error: resolved.error };
  return observeWebAssistTab(resolved.record, resolved.tab);
}

const PAGE_ACTIONS = new Set<WebAssistPageAction>([
  'click', 'fill', 'select', 'check', 'uncheck', 'scroll',
]);

type CheckedWebAssistAction =
  | {
      ok: true;
      contents: WebContents;
      action: WebAssistPageAction;
      text: string;
      direction: 'up' | 'down' | 'top' | 'bottom';
      ref?: WebAssistStoredElementRef;
    }
  | { ok: false; code: string; error: string };

function checkWebAssistAction(
  tab: WebAssistTabRecord,
  input: {
    pageId?: unknown;
    elementRef?: unknown;
    action?: unknown;
    text?: unknown;
    direction?: unknown;
  },
): CheckedWebAssistAction {
  const contents = tab.view?.webContents;
  const action = String(input.action || '') as WebAssistPageAction;
  if (!PAGE_ACTIONS.has(action)) {
    return { ok: false, code: 'invalid_action', error: 'Unsupported Web Assist page action.' };
  }
  if (!contents || tab.suspended) return { ok: false, code: 'stale_page', error: 'The page changed; observe it again before acting.' };
  if (tab.loading || contents.isLoading()) {
    return { ok: false, code: 'page_loading', error: 'The page is still loading; wait before acting.' };
  }
  const observation = tab.observation;
  const pageId = String(input.pageId || '');
  if (!observation || observation.pageId !== pageId || contents.getURL() !== observation.url) {
    return { ok: false, code: 'stale_page', error: 'The page changed; observe it again before acting.' };
  }
  const text = typeof input.text === 'string' ? input.text : '';
  if (text.length > 2_000 || /[\u0000]/u.test(text)) {
    return { ok: false, code: 'invalid_text', error: 'Page action text must be at most 2000 characters.' };
  }
  const directionRaw = String(input.direction || 'down');
  if (!['up', 'down', 'top', 'bottom'].includes(directionRaw)) {
    return { ok: false, code: 'invalid_direction', error: 'Scroll direction must be up, down, top, or bottom.' };
  }
  let ref: WebAssistStoredElementRef | undefined;
  if (action !== 'scroll') {
    const elementRef = String(input.elementRef || '');
    ref = observation.refs.get(elementRef);
    if (!ref) {
      return { ok: false, code: 'unknown_element', error: 'Use an element ref from the current page observation.' };
    }
  }
  if ((action === 'fill' || action === 'select') && typeof input.text !== 'string') {
    return { ok: false, code: 'text_required', error: `Text is required for ${action}.` };
  }
  return {
    ok: true,
    contents,
    action,
    text,
    direction: directionRaw as 'up' | 'down' | 'top' | 'bottom',
    ...(ref ? { ref } : {}),
  };
}

/** Decide whether a controller handback becomes a user-approved retry.
 *
 * Returns false for every handback the user is not offered: credential entry,
 * uploads, the connector scope, and any action without a live element ref. */
async function resolveProtectedWebAssistAction(
  tab: WebAssistTabRecord,
  checked: { ref?: WebAssistStoredElementRef; contents: WebContents },
  result: Record<string, unknown>,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isCurrent()) return false;
  if (result.ok !== false || result.code !== 'user_action_required') return false;
  if (!isGateableWebAssistReason(result.reason)) return false;
  const context = tab.controlContext;
  // connector_setup already runs ordinary submissions; what it still hands
  // back is credential entry, which this gate must not offer to resolve.
  if (context?.scope !== 'browser' || !checked.ref) return false;
  const target: WebAssistActionTarget = {
    userId: context.userId,
    conversationId: context.conversationId,
    tabId: tab.id,
    origin: webAssistPageOrigin(tab.observation?.url || ''),
    tag: checked.ref.signature.tag,
    label: checked.ref.signature.label,
  };
  try {
    if (hasWebAssistActionGrant(target)) return true;
    let pageTitle = tab.label;
    try { pageTitle = checked.contents.getTitle() || tab.label; } catch { /* a title is context, not a precondition */ }
    // The decision is about a page the user is meant to look at.
    surfaceAppWindow();
    const decision = await requestWebAssistActionConfirm({
      target,
      reason: result.reason,
      pageTitle,
      controlKind: checked.ref.signature.role || checked.ref.signature.tag,
      signal,
    });
    if (decision === 'deny' || !isCurrent()) return false;
    if (decision === 'run') rememberWebAssistActionGrant(target);
    return true;
  } catch (error) {
    // This gate only ever adds a way to say yes. If it cannot run, the caller
    // keeps the handback it already has instead of reporting a page failure.
    log.warn('web assist action confirmation unavailable', { error: logErrorRef(error) });
    return false;
  }
}

interface WebAssistActionLifetime {
  signal?: AbortSignal;
  isActive?: () => boolean;
}

async function actOnWebAssistTab(
  record: WebAssistRecord,
  tab: WebAssistTabRecord,
  input: {
    pageId?: unknown;
    elementRef?: unknown;
    action?: unknown;
    text?: unknown;
    direction?: unknown;
  },
  lifetime: WebAssistActionLifetime = {},
): Promise<Record<string, unknown>> {
  const checked = checkWebAssistAction(tab, input);
  if (!checked.ok) return checked;
  const context = tab.controlContext;
  const validate = (): Record<string, unknown> | null => {
    if (lifetime.signal?.aborted || lifetime.isActive?.() === false) {
      return { ok: false, code: 'task_run_ended', error: 'This browser task turn has ended.' };
    }
    if (record.tabs.get(tab.id) !== tab || tab.controlContext !== context
      || tab.view?.webContents !== checked.contents || checked.contents.isDestroyed()) {
      return { ok: false, code: 'stale_page', error: 'The page changed; observe it again before acting.' };
    }
    const current = checkWebAssistAction(tab, input);
    return current.ok ? null : current;
  };
  const runAction = async (grantedProtectedAction: boolean): Promise<Record<string, unknown>> => {
    const invalid = validate();
    if (invalid) return invalid;
    const result = await withAssistantAction(record, tab, 'acting', () => executeWebAssistScript(
      checked.contents,
      buildWebAssistActionScript({
        ...(checked.ref ? { ref: checked.ref } : {}),
        action: checked.action,
        ...(typeof input.text === 'string' ? { text: checked.text } : {}),
        direction: checked.direction,
      }, tab.controlContext?.scope, { grantedProtectedAction }),
      true,
    ));
    return result && typeof result === 'object'
      ? result as Record<string, unknown>
      : { ok: false, code: 'action_failed', error: 'The page action failed.' };
  };
  try {
    let publicResult = await runAction(false);
    if (publicResult.ok === false) {
      const approved = await resolveProtectedWebAssistAction(
        tab, checked, publicResult, () => validate() === null, lifetime.signal,
      );
      const invalid = validate();
      if (invalid) return invalid;
      // Revalidate page identity and caller lifetime after the asynchronous
      // decision; the DOM signature alone may match on a different page.
      if (approved) publicResult = await runAction(true);
      // Still handed back: this turn now waits on a person — credential entry,
      // OTP, upload or CAPTCHA, none of which the model may complete. An
      // unattended run reached here with its window minimised or freshly made
      // for the fire, so the page has to become reachable or the wait never
      // ends.
      if (publicResult.ok === false && publicResult.code === 'user_action_required') {
        surfaceAppWindow();
      }
    }
    if (publicResult.ok === true) {
      if (['fill', 'select', 'check', 'uncheck'].includes(checked.action)) tab.edited = true;
      invalidateObservation(tab);
    }
    return publicResult;
  } catch (error) {
    log.warn('page action failed', { error: logErrorRef(error) });
    invalidateObservation(tab);
    return { ok: false, code: 'action_failed', error: 'The page action failed.' };
  }
}

export async function actOnControlledWebAssist(
  userId: string,
  conversationId: string,
  scopeId: string,
  input: {
    pageId?: unknown;
    elementRef?: unknown;
    action?: unknown;
    text?: unknown;
    direction?: unknown;
  },
): Promise<Record<string, unknown>> {
  const resolved = controlledRecord(userId, conversationId, scopeId);
  if (!('record' in resolved)) return { ok: false, code: resolved.code, error: resolved.error };
  if (!PAGE_ACTIONS.has(String(input.action || '') as WebAssistPageAction)) return { ok: false, code: 'invalid_action', error: 'Unsupported Web Assist page action.' };
  ensureTabLoaded(resolved.record, resolved.tab);
  return actOnWebAssistTab(resolved.record, resolved.tab, input);
}

export async function navigateControlledWebAssist(
  userId: string,
  conversationId: string,
  scopeId: string,
  action: unknown,
): Promise<Record<string, unknown>> {
  const resolved = controlledRecord(userId, conversationId, scopeId);
  if (!('record' in resolved)) return { ok: false, code: resolved.code, error: resolved.error };
  const { record, tab } = resolved;
  if (action === 'close') {
    removeTab(record, tab, true);
    return { ok: true, action: 'close', closed: true, tab_id: tab.id };
  }
  const navigation = navigateTabHistory(record, tab, action);
  if (navigation.ok === false) return navigation;
  return { ok: true, action, state: tabSnapshot(tab) };
}

export async function waitForControlledWebAssist(
  userId: string,
  conversationId: string,
  scopeId: string,
  input: { condition?: unknown; text?: unknown; timeoutMs?: unknown },
): Promise<Record<string, unknown>> {
  const initial = controlledRecord(userId, conversationId, scopeId);
  if (!('record' in initial)) return { ok: false, code: initial.code, error: initial.error };
  if (!ensureTabLoaded(initial.record, initial.tab)) return { ok: false, code: 'page_loading', error: 'The page is being restored; wait before observing it.' };
  const condition = String(input.condition || 'loaded');
  if (condition !== 'loaded' && condition !== 'text') {
    return { ok: false, code: 'invalid_condition', error: 'Wait condition must be loaded or text.' };
  }
  const expectedText = typeof input.text === 'string' ? input.text.trim() : '';
  if (condition === 'text' && (!expectedText || expectedText.length > 240)) {
    return { ok: false, code: 'invalid_text', error: 'A text condition requires 1 to 240 characters.' };
  }
  const requestedTimeout = Number(input.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(250, Math.min(15_000, Math.round(requestedTimeout)))
    : 8_000;
  const started = Date.now();
  return withAssistantAction(initial.record, initial.tab, 'waiting', async () => {
    while (Date.now() - started < timeoutMs) {
      const current = controlledRecord(userId, conversationId, scopeId);
      if (!('record' in current)) return { ok: false, code: current.code, error: current.error };
      const contents = current.tab.view.webContents;
      let matched = false;
      try {
        if (condition === 'loaded') {
          matched = !current.tab.loading && !contents.isLoading();
        } else if (!current.tab.loading && !contents.isLoading()) {
          matched = await readWebAssistTextCondition(contents, expectedText, started + timeoutMs) === true;
        }
      } catch {
        matched = false;
      }
      if (matched) {
        return { ok: true, condition, elapsed_ms: Math.max(0, Date.now() - started) };
      }
      const remaining = started + timeoutMs - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200, remaining)));
    }
    return { ok: false, code: 'wait_timeout', error: 'The Web Assist wait timed out.', condition, timeout_ms: timeoutMs };
  });
}

/** Return only browser tabs owned by the current task. */
export function listModelWebAssistTabs(
  userId: string,
  conversationId: string,
): Record<string, unknown> {
  if (!safeId(userId) || !safeId(conversationId)) {
    return { ok: false, code: 'invalid_scope', error: 'The browser task scope is invalid.' };
  }
  const sender = boundSender(userId, conversationId);
  if (!sender) {
    return unboundSenderFailure('task');
  }
  const record = recordForSender(sender);
  // Queries never start/retry a transfer or grant a download origin. A path is
  // returned only after Chromium reports completion, within this task's normal
  // attachment read scope. Closing a tab does not erase its download receipt.
  const downloads = webAssistDownloads(userId, conversationId).downloads.map(entry => ({
    ...entry,
    ...(entry.state === 'saved' && downloadPaths.has(entry) ? { path: downloadPaths.get(entry) } : {}),
  }));
  if (!record) return { ok: true, active_tab_id: null, tabs: [], downloads, tab_limit: MAX_TABS_PER_CONVERSATION };
  const tabs = [...record.tabs.values()]
    .filter((tab) => tab.conversationId === conversationId)
    .map(tabSnapshot);
  const active = tabs.find((tab) => tab.tab_id === record.activeTabId) || tabs[0] || null;
  return { ok: true, active_tab_id: active?.tab_id || null, tabs, downloads, tab_limit: MAX_TABS_PER_CONVERSATION };
}

/** Open one model-visible tab and reveal the shared task browser to the user. */
export async function openModelWebAssist(
  userId: string,
  conversationId: string,
  input: { url?: unknown; label?: unknown },
): Promise<Record<string, unknown>> {
  if (!safeId(userId) || !safeId(conversationId)) {
    return { ok: false, code: 'invalid_scope', error: 'The browser task scope is invalid.' };
  }
  const sender = boundSender(userId, conversationId);
  if (!sender) {
    return unboundSenderFailure('task');
  }
  const url = safeWebAssistUrl(input.url);
  if (!url) return { ok: false, code: 'invalid_url', error: 'Open an absolute HTTP or HTTPS URL.' };
  // Judge link-derivation against what the model was holding, before opening
  // the tab changes it.
  const fromLink = wasObservedLink(userId, conversationId, url);
  const opened = await openWebAssist(userId, sender, {
    url,
    label: input.label,
    conversationId,
  }, 'model');
  if (!opened.ok) return opened;
  const resolved = taskTab(userId, conversationId, opened.tab_id);
  if (!resolved.ok) return resolved;
  const exposed = exposeTaskTabToModel(resolved);
  if (!exposed.ok) return exposed;
  recordModelNavigation(userId, conversationId, resolved.tab.id, url, 'open', fromLink);
  return {
    ok: true,
    active_tab_id: resolved.tab.id,
    tab: tabSnapshot(resolved.tab),
    tab_limit: MAX_TABS_PER_CONVERSATION,
    closed_tab_ids: opened.closed_tab_ids,
  };
}

/** Navigate one shared task tab; generic browsing replaces connector scope. */
export async function navigateModelWebAssist(
  userId: string,
  conversationId: string,
  input: { tabId?: unknown; action?: unknown; url?: unknown },
): Promise<Record<string, unknown>> {
  const resolved = taskTab(userId, conversationId, input.tabId);
  if (!resolved.ok) return resolved;
  const action = String(input.action || '').trim();
  if (!['goto', 'back', 'forward', 'reload'].includes(action)) {
    return { ok: false, code: 'invalid_action', error: 'Navigation must be goto, back, forward, or reload.' };
  }
  if (action === 'goto') {
    const url = safeWebAssistUrl(input.url);
    if (!url) return { ok: false, code: 'invalid_url', error: 'goto requires an absolute HTTP or HTTPS URL.' };
    // Read link-derivation from the observation still in hand; navigating
    // replaces it.
    const fromLink = wasObservedLink(userId, conversationId, url);
    const navigated = await navigateWebAssistTo(
      resolved.sender, { tabId: resolved.tab.id, url }, taskIsForeground(resolved.sender, conversationId),
    );
    if (!navigated.ok) return navigated;
    recordModelNavigation(userId, conversationId, resolved.tab.id, url, 'goto', fromLink);
  } else {
    const navigation = navigateTabHistory(resolved.record, resolved.tab, action);
    if (navigation.ok === false) return navigation;
  }
  const current = taskTab(userId, conversationId, resolved.tab.id);
  if (!current.ok) return current;
  const exposed = exposeTaskTabToModel(current);
  if (!exposed.ok) return exposed;
  return { ok: true, action, tab: tabSnapshot(current.tab) };
}

export async function observeModelWebAssist(
  userId: string,
  conversationId: string,
  tabId?: unknown,
  scope?: 'full' | 'meta',
  window?: WebAssistObserveWindow,
): Promise<Record<string, unknown>> {
  const resolved = taskTab(userId, conversationId, tabId);
  if (!resolved.ok) return resolved;
  const exposed = exposeTaskTabToModel(resolved);
  if (!exposed.ok) return exposed;
  return observeWebAssistTab(
    resolved.record, resolved.tab, scope === 'meta' ? 'meta' : 'full', window || {},
  );
}

export async function actOnModelWebAssist(
  userId: string,
  conversationId: string,
  input: {
    tabId?: unknown;
    pageId?: unknown;
    elementRef?: unknown;
    action?: unknown;
    text?: unknown;
    direction?: unknown;
  },
  lifetime: WebAssistActionLifetime = {},
): Promise<Record<string, unknown>> {
  const resolved = taskTab(userId, conversationId, input.tabId);
  if (!resolved.ok) return resolved;
  if (!PAGE_ACTIONS.has(String(input.action || '') as WebAssistPageAction)) return { ok: false, code: 'invalid_action', error: 'Unsupported Web Assist page action.' };
  ensureTabLoaded(resolved.record, resolved.tab);
  const checked = checkWebAssistAction(resolved.tab, input);
  if (!checked.ok) return checked;
  const exposed = exposeTaskTabToModel(resolved);
  if (!exposed.ok) return exposed;
  return actOnWebAssistTab(resolved.record, resolved.tab, input, lifetime);
}

export async function waitForModelWebAssist(
  userId: string,
  conversationId: string,
  input: { tabId?: unknown; condition?: unknown; text?: unknown; timeoutMs?: unknown },
): Promise<Record<string, unknown>> {
  const initial = taskTab(userId, conversationId, input.tabId);
  if (!initial.ok) return initial;
  const condition = String(input.condition || 'loaded');
  if (condition !== 'loaded' && condition !== 'text') {
    return { ok: false, code: 'invalid_condition', error: 'Wait condition must be loaded or text.' };
  }
  const expectedText = typeof input.text === 'string' ? input.text.trim() : '';
  if (condition === 'text' && (!expectedText || expectedText.length > 240)) {
    return { ok: false, code: 'invalid_text', error: 'A text condition requires 1 to 240 characters.' };
  }
  const requestedTimeout = Number(input.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(250, Math.min(15_000, Math.round(requestedTimeout)))
    : 8_000;
  const exposed = exposeTaskTabToModel(initial);
  if (!exposed.ok) return exposed;
  const started = Date.now();
  return withAssistantAction(initial.record, initial.tab, 'waiting', async () => {
    while (Date.now() - started < timeoutMs) {
      const current = taskTab(userId, conversationId, initial.tab.id);
      if (!current.ok) return current;
      const contents = current.tab.view.webContents;
      let matched = false;
      try {
        if (condition === 'loaded') {
          matched = !current.tab.loading && !contents.isLoading();
        } else if (!current.tab.loading && !contents.isLoading()) {
          matched = await readWebAssistTextCondition(contents, expectedText, started + timeoutMs) === true;
        }
      } catch {
        matched = false;
      }
      if (matched) {
        return { ok: true, tab_id: current.tab.id, condition, elapsed_ms: Math.max(0, Date.now() - started) };
      }
      const remaining = started + timeoutMs - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200, remaining)));
    }
    return { ok: false, code: 'wait_timeout', error: 'The browser wait timed out.', condition, timeout_ms: timeoutMs };
  });
}

export function retainModelWebAssistTab(
  userId: string,
  conversationId: string,
  tabId: unknown,
  retention: unknown,
): Record<string, unknown> {
  if (retention !== 'deliverable' && retention !== 'handoff' && retention !== 'temporary') {
    return { ok: false, code: 'invalid_retention', error: 'Retention must be deliverable, handoff or temporary.' };
  }
  if (typeof tabId !== 'string' || !tabId.trim()) {
    return { ok: false, code: 'tab_required', error: 'Choose an exact tab ID from tabs before retaining it.' };
  }
  const resolved = taskTab(userId, conversationId, tabId);
  if (!resolved.ok) return resolved;
  if (resolved.tab.lifetime.createdBy === 'user') {
    return { ok: false, code: 'user_owned_tab', error: 'User-created tabs already remain open without a retention mark.' };
  }
  if (!retainBrowserTab(userId, conversationId, resolved.tab.id, retention)) {
    return { ok: false, code: 'no_active_run', error: 'Retention marks require an active task turn.' };
  }
  emit(resolved.record);
  return { ok: true, tab: tabSnapshot(resolved.tab) };
}

export function closeModelWebAssistTab(
  userId: string,
  conversationId: string,
  tabId?: unknown,
): Record<string, unknown> {
  const resolved = taskTab(userId, conversationId, tabId);
  if (!resolved.ok) return resolved;
  const closedTabId = resolved.tab.id;
  removeTab(resolved.record, resolved.tab, true);
  return { ok: true, closed: true, tab_id: closedTabId };
}

/** Ephemeral browser chrome backdrop; never persisted or returned to models. */
export async function captureWebAssistPreview(sender: WebContents, tabId: unknown) {
  const record = recordForSender(sender);
  const tab = record && activeTab(record);
  const contents = tab?.view?.webContents;
  const conversationId = activeConversationBySender.get(sender);
  const available = () => !!record && recordForSender(sender) === record
    && activeTab(record) === tab && tab?.id === tabId && tab.conversationId === conversationId
    && tab.view?.webContents === contents && !contents?.isDestroyed()
    && activeConversationBySender.get(sender) === conversationId;
  if (!contents || !available()) return { preview: null };
  const url = contents.getURL();
  try {
    let capture = previewCaptures.get(contents);
    if (!capture) {
      capture = contents.capturePage(undefined, { stayHidden: true });
      previewCaptures.set(contents, capture);
      // Retain a timed-out native call until settlement to bound repeated opens.
      void capture.finally(() => previewCaptures.delete(contents)).catch(() => {});
    }
    let bitmap = await withOperationTimeout(capture, {
      timeoutMs: 1500, code: 'preview_timeout', stage: 'browser_preview',
    });
    if (!available() || contents.getURL() !== url || bitmap.isEmpty()) return { preview: null };
    const { width, height } = bitmap.getSize();
    const scale = Math.min(1, 1600 / Math.max(width, height));
    if (scale < 1) bitmap = bitmap.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
    const jpeg = bitmap.toJPEG(80);
    if (jpeg.length > 2 * 1024 * 1024) return { preview: null };
    return { preview: `data:image/jpeg;base64,${jpeg.toString('base64')}` };
  } catch {
    log.warn('browser preview unavailable');
    return { preview: null };
  }
}

export function layoutWebAssist(
  sender: WebContents,
  rawBounds: unknown,
): { ok: true; state: WebAssistSnapshot } | { ok: false; code: string; error: string } {
  const record = recordForSender(sender);
  if (!record) return { ok: false, code: 'not_open', error: 'Web Assist is not open.' };
  if (rawBounds && typeof rawBounds === 'object' && (rawBounds as { visible?: unknown }).visible === false) {
    for (const tab of record.tabs.values()) setTabVisible(tab, false);
    return { ok: true, state: rendererSnapshot(record) };
  }
  const bounds = normalizeWebAssistBounds(rawBounds, record.owner.getContentBounds());
  if (!bounds) return { ok: false, code: 'invalid_bounds', error: 'Web Assist could not be positioned.' };
  const tab = activeTab(record);
  if (!tab) return { ok: false, code: 'not_open', error: 'Web Assist is not open.' };
  if (!ensureTabLoaded(record, tab)) return { ok: true, state: rendererSnapshot(record) };
  for (const candidate of record.tabs.values()) {
    if (candidate !== tab) setTabVisible(candidate, false);
  }
  tab.view.setBounds(bounds);
  tab.bounds = bounds;
  setTabVisible(tab, true);
  // The drawer is user-draggable, so the room available changed with it.
  applyDesktopViewport(tab);
  return { ok: true, state: rendererSnapshot(record) };
}

export function navigateWebAssist(
  sender: WebContents,
  action: unknown,
): { ok: true; state: WebAssistSnapshot } | { ok: false; code: string; error: string } {
  const record = recordForSender(sender);
  if (!record) return { ok: false, code: 'not_open', error: 'Web Assist is not open.' };
  const tab = activeTab(record);
  if (!tab) return { ok: false, code: 'not_open', error: 'Web Assist is not open.' };
  const navigation = navigateTabHistory(record, tab, action);
  if (navigation.ok === false) return navigation;
  return { ok: true, state: rendererSnapshot(record) };
}

export async function openWebAssistInDefaultBrowser(
  sender: WebContents,
): Promise<{ ok: true; opened: true } | { ok: false; code: string; error: string }> {
  const record = recordForSender(sender);
  const tab = record ? activeTab(record) : null;
  const url = tab ? safeWebAssistUrl(tab.suspended?.url || tab.view?.webContents.getURL()) : null;
  if (!url) return { ok: false, code: 'page_unavailable', error: 'There is no web page to open.' };
  try {
    await shell.openExternal(url);
    return { ok: true, opened: true };
  } catch (error) {
    log.warn('default browser open failed', { error: logErrorRef(error) });
    return { ok: false, code: 'browser_open_failed', error: 'The page could not be opened in your default browser.' };
  }
}

export function closeWebAssist(sender: WebContents): { ok: true; closed: boolean } {
  const record = recordForSender(sender);
  if (!record) return { ok: true, closed: false };
  closeRecord(record);
  return { ok: true, closed: true };
}

export function webAssistState(sender: WebContents): { state: WebAssistSnapshot } {
  const record = recordForSender(sender);
  return {
    state: record ? rendererSnapshot(record) : emptySnapshot(),
  };
}

// A browser authenticated as one Orkas user must never survive an account
// switch into another user's renderer session.
registerUserSwitchHook('web-assist', (previousUid) => {
  for (const record of [...records.values()]) {
    if (record.ownerUserId === previousUid) closeRecord(record, true);
  }
  for (const [key, binding] of conversationBindings) {
    if (binding.userId === previousUid) conversationBindings.delete(key);
  }
});
