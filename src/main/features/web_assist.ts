/**
 * In-app Web Assist runtime for model-originated web work.
 *
 * The application renderer owns only trusted toolbar controls and a layout
 * placeholder. Third-party content runs in a main-process WebContentsView so
 * it never receives the Orkas application preload, Node, or renderer IPC bridge.
 * An isolated activity preload reports only trusted composition state and wheel activity. A
 * machine-local Chromium profile per Orkas user preserves provider login
 * state without sharing the system browser's profile or cloud-syncing it.
 */

import { displayBrowserUrl } from './web_assist_url';
import { webAssistVisualStampScript, buildWebAssistPointScript, type WebAssistVisualStamp } from './web_assist_visual';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BrowserWindow,
  session,
  shell,
  WebContentsView,
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
import { DEFAULT_INLINE_RESULT_TOKENS, estimateToolResultTokens } from '../util/tool-result-cap';
import { encodeImage, imageMetadata } from '../util/sharp-runtime';
import { prepareBrowserProxy } from '../util/browser-proxy';
import { OperationTimeoutError, withOperationTimeout } from '../util/operation-timeout';
import { dispatchWebAssistPointer, dispatchWebAssistKeys, wakeWebAssistRendering } from './web_assist_input';
import { attachWebAssistDialogs, configureWebAssistDialogs, webAssistDialogs, interruptOnWebAssistDialog, WebAssistDialogOpenedError } from './web_assist_dialogs';
import { attachWebAssistViewport, configureWebAssistViewport, setWebAssistViewport } from './web_assist_viewport';
import { watchWebAssistUserActivity, WEB_ASSIST_USER_IDLE_MS } from './web_assist_activity';
import { prepareWebAssistSession } from './web_assist_session';
import { prepareWebAssistCache } from './web_assist_cache';
import { attachWebAssistPasskeys, cancelWebAssistPasskey, webAssistPasskeyRequest, cancelModelWebAssistPasskey } from './web_assist_passkey';
import { configurePasskeyTransportSession } from './web_assist_passkey_transport';
import { logWebAssistFailure } from './web_assist_diagnostics';
import { registerUserSwitchHook } from './user-switch-hooks';
import {
  registerBrowserTab, forgetBrowserTab, retainBrowserTab, browserTaskRunId, watchBrowserTaskRun,
  type BrowserTabLifetime, type BrowserTabRetention,
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

import { webAssistEvaluate, webAssistFrames, webAssistRootPointer, webAssistPointPointer, setWebAssistInputFiles,
  attachWebAssistFileChoosers, refreshWebAssistFileChoosers, webAssistFileChooser, clearWebAssistFileChooser,
  configureWebAssistFilePickers, takeWebAssistFilePickerNotice, cancelWebAssistFileChooser } from './web_assist_protocol';
import { configureWebAssistPermissions, resetWebAssistSitePermissions, webAssistPermissionRequest, respondWebAssistPermission, respondModelWebAssistPermission, webAssistNativeSelection, cancelWebAssistNativeSelection, type WebAssistPermissionRequest } from './web_assist_permissions';
import type { ToolResult } from '#core-agent';
const log = createLogger('web-assist');
function webAssistPageOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch { return ''; }
}
const { MAX_PAGE_ACTION_TEXT_LENGTH } = require('../../../bin/browser-tool-contract.cjs') as {
  MAX_PAGE_ACTION_TEXT_LENGTH: number;
};
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
const WEB_ASSIST_SEARCH_URL = 'https://www.bing.com/search';

export interface WebAssistSnapshot {
  open: boolean;
  /** Trusted renderer presentation generation; omitted from model projections. */
  overlay_epoch?: number;
  /** One-shot trusted chrome signal after a model closes this task's last tab. */
  model_closed_conversation_id?: string;
  loading: boolean;
  tab_id?: string;
  active_tab_id?: string;
  label: string;
  page_title: string;
  display_url: string;
  can_go_back: boolean;
  can_go_forward: boolean;
  assistant_controlled?: boolean;
  user_controlled?: boolean;
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
  /** Pending site permission for trusted browser chrome, never model output. */
  permission_request?: WebAssistPermissionRequest;
  can_go_back: boolean;
  can_go_forward: boolean;
  conversation_id: string;
  assistant_controlled?: boolean;
  user_controlled?: boolean;
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
  dialogId?: string;
  fileChooserId?: string;
  permissionId?: string;
  nativeDecision?: { id: string; kind: 'selection' | 'passkey' };
  url: string;
  refs: Map<string, WebAssistStoredElementRef>;
  hrefs: Set<string>;
  frameId?: string;
  visual?: WebAssistVisualStamp & { pageId: string };
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

/** One download the task attempted. Failures are kept too: a failure the user
 *  never sees is indistinguishable from the page being broken. */
export interface WebAssistDownloadEntry {
  at: number;
  origin: string;
  filename: string;
  bytes: number;
  state: 'downloading' | 'saved' | 'failed';
}

const downloadLedgers = new Map<string, WebAssistDownloadEntry[]>();
// Only terminal, task-owned downloads expose these paths to the model. The
// trusted renderer keeps its existing filename-based attachment actions.
const downloadPaths = new WeakMap<WebAssistDownloadEntry, string>();
const navigationLedgers = new Map<string, WebAssistNavigationEntry[]>();

interface WebAssistTabRecord {
  id: string;
  lifetime: BrowserTabLifetime;
  conversationId: string;
  view?: WebContentsView;
  visible: boolean;
  /** Presentation only; the selected page still runs and is not idle-reclaimed. */
  presentationSuppressed: boolean;
  bounds?: Rectangle;
  pendingBounds?: Rectangle;
  boundsUpdate?: ReturnType<typeof setImmediate>;
  /** Drawer width the current emulation was computed for. */
  virtualViewportWidth?: number;
  virtualViewportHeight?: number;
  viewportUpdate?: Promise<void>;
  lastUsedAt: number;
  activeOperations: number;
  userControlled?: boolean;
  modelControlRunId?: string;
  userActivity?: ReturnType<typeof watchWebAssistUserActivity>;
  controlRevision?: number;
  /** Host-only wait evidence version, including same-URL reloads. */
  navigationRevision?: number;
  inputBusy?: boolean;
  edited: boolean;
  replayable: boolean;
  relatedTabs: Set<string>;
  wakeAfterUnload?: boolean;
  idleCheckInFlight?: boolean;
  suspended?: { url: string; title: string; entries: Array<{ url: string; title: string }>; index: number };
  label: string;
  loading: boolean;
  /** Accepted destination until commit; used only by trusted address chrome. */
  pendingAddressUrl?: string;
  errorCode?: WebAssistSnapshot['error_code'];
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
  ownerNavigation: (...args: any[]) => void;
  overlayBlocked: boolean;
  overlayRevision: number;
  overlayEpoch: number;
  idleTimer?: ReturnType<typeof setInterval>;
}

interface WebAssistConversationBinding {
  userId: string;
  conversationId: string;
  sender: WebContents;
}

let nextOverlayEpoch = 0;
const records = new Map<number, WebAssistRecord>();
const configuredSessions = new WeakMap<Session, ReturnType<typeof prepareBrowserProxy>>();
const conversationBindings = new Map<string, WebAssistConversationBinding>();
const boundSenders = new WeakSet<object>();
const activeConversationBySender = new WeakMap<object, string>();

/** Web Assist accepts credential-free HTTP(S) destinations only. */
export function safeWebAssistUrl(raw: unknown): string | null {
  return safeExternalHttpUrl(raw);
}

function directWebAssistAddress(value: string): string | null {
  const normalized = safeWebAssistUrl(`https://${value}`);
  if (!normalized) return null;
  const hostname = new URL(normalized).hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(hostname)) {
    // Reparse the input so an explicit :443 survives HTTPS default-port normalization.
    return safeWebAssistUrl(`http://${value}`);
  }
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

/** Where this task's browser has downloaded from, newest last. */
export function webAssistDownloads(
  userId: string,
  conversationId: string,
): { ok: true; downloads: WebAssistDownloadEntry[] } {
  if (!safeId(userId) || !safeId(conversationId)) return { ok: true, downloads: [] };
  return { ok: true, downloads: [...(downloadLedgers.get(conversationBindingKey(userId, conversationId)) || [])] };
}

export function forgetWebAssistDownloads(userId: string, conversationId: string): void {
  downloadLedgers.delete(conversationBindingKey(userId, conversationId));
}

export function displayUrl(raw: unknown): string {
  if (raw === 'about:blank') return 'about:blank';
  const safe = safeWebAssistUrl(raw);
  if (!safe) return '';
  return displayBrowserUrl(safe);
}

/** Frames listed per full observation; `frame_count` gives the total. */
const MAX_LISTED_FRAMES = 20;

/** The frame inventory of a full observation. Entries only identify frames for
 *  `frame_id`, so each URL keeps its origin and path: query strings, mostly ad
 *  and tracking parameters, made this list larger than the page it described.
 *  Frame tree order lists the main frame first; the observed frame is always
 *  listed. The page's own address and link targets stay complete. */
export function webAssistFrameInventory(
  frames: ReadonlyArray<{ id: string; parentId?: string; name: string; url: string }>,
  observedFrameId: string,
): {
  frames: Array<{ frame_id: string; parent_frame_id?: string; name: string; display_url: string }>;
  frame_count: number;
} {
  const listed = frames.slice(0, MAX_LISTED_FRAMES);
  const observed = frames.find((frame) => frame.id === observedFrameId);
  if (observed && !listed.includes(observed)) listed[listed.length - 1] = observed;
  return {
    frames: listed.map((frame) => ({
      frame_id: frame.id,
      parent_frame_id: frame.parentId,
      name: safeLabel(frame.name),
      display_url: frameDisplayUrl(frame.url),
    })),
    frame_count: frames.length,
  };
}

/** Size a full observation the way read_files sizes a page: the result the
 *  model receives stays within `budget` estimated tokens. Everything except
 *  the page text is kept first and the text gets what remains, cut at a UTF-16
 *  offset the caller continues from with `text_offset`. Elements are cut from
 *  the end, with `element_next_offset`, only when they alone do not fit. */
export function fitWebAssistObservation(
  result: Record<string, unknown>,
  budget: number,
): Record<string, unknown> {
  const limit = Math.max(0, Math.floor(budget));
  const cost = (value: Record<string, unknown>) => estimateToolResultTokens(JSON.stringify(value));
  if (cost(result) <= limit) return result;
  const text = typeof result.text === 'string' ? result.text : '';
  const textOffset = Number(result.text_offset) || 0;
  const elements = Array.isArray(result.elements) ? result.elements : [];
  const elementOffset = Number(result.element_offset) || 0;
  const withElements = (count: number): Record<string, unknown> => count >= elements.length
    ? result
    : { ...result, elements: elements.slice(0, count), elements_truncated: true, element_next_offset: elementOffset + count };
  const withText = (base: Record<string, unknown>, end: number): Record<string, unknown> => end >= text.length
    ? base
    : { ...base, text: text.slice(0, end), text_truncated: true, text_next_offset: textOffset + end };
  /** Largest n in [0, high] that fits; 0 is the floor even when it does not. */
  const largest = (high: number, fits: (n: number) => boolean): number => {
    let low = 0;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const count = cost(withText(result, 0)) <= limit
    ? elements.length
    : largest(elements.length, n => cost(withText(withElements(n), 0)) <= limit);
  const base = withElements(count);
  let end = largest(text.length, n => cost(withText(base, n)) <= limit);
  // Never leave half of a surrogate pair at the end of the window.
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
  }
  return withText(base, end);
}

function frameDisplayUrl(raw: string): string {
  const shown = displayUrl(raw);
  if (!shown || shown === 'about:blank') return shown;
  try {
    const url = new URL(shown);
    return `${url.origin}${url.pathname}`;
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
  configureWebAssistViewport();
  ses.registerPreloadScript({ id: 'orkas-browser-activity', type: 'frame',
    filePath: path.join(__dirname, 'web_assist_activity_preload.js') });
  configureWebAssistDialogs();
  ses.registerPreloadScript({ id: 'orkas-browser-dialogs', type: 'frame',
    filePath: path.join(__dirname, 'web_assist_dialog_preload.js') });
  configureWebAssistFilePickers();
  ses.registerPreloadScript({ id: 'orkas-browser-file-pickers', type: 'frame',
    filePath: path.join(__dirname, 'web_assist_file_picker_preload.js') });
  if (process.platform === 'darwin') {
    ses.registerPreloadScript({ id: 'orkas-browser-phone-passkey', type: 'frame',
      filePath: path.join(__dirname, 'web_assist_passkey_preload.js') });
    configurePasskeyTransportSession(ses);
  }
  const restored = prepareWebAssistSession(userId, ses);
  const ready = Promise.all([restored, proxy.ready]).then(([, proxyReady]) => proxyReady !== false, () => false);
  configuredSessions.set(ses, proxy);
  configureWebAssistPermissions(ses, contents => {
    for (const record of records.values()) {
      if (record.ownerUserId !== userId || record.owner.isDestroyed()) continue;
      if (!contents || [...record.tabs.values()].some(tab => tab.view?.webContents === contents)) return record.owner;
    }
    return undefined;
  }, contents => {
    for (const record of records.values()) {
      if (record.ownerUserId !== userId) continue;
      const tab = [...record.tabs.values()].find(tab => tab.view?.webContents === contents);
      if (tab) { invalidateObservation(tab); emit(record); }
    }
  });
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

    const fail = (): void => {
      event.preventDefault();
      recordWebAssistDownload(userId, conversationId, {
        at: Date.now(), origin, filename, bytes: declared, state: 'failed',
      });
      tab.errorCode = 'download_blocked';
      emit(record);
    };

    // Without a page origin the file has no site to be attributed to.
    if (!origin) return fail();
    let target = '';
    try {
      const dir = chatAttachmentDirForConversation(userId, conversationId);
      fs.mkdirSync(dir, { recursive: true });
      for (let attempt = 0; ; attempt += 1) {
        const dot = filename.lastIndexOf('.');
        const suffix = attempt < 100 ? String(attempt) : genId12();
        const candidate = path.join(dir, attempt === 0 ? filename : dot > 0
          ? `${filename.slice(0, dot)} (${suffix})${filename.slice(dot)}`
          : `${filename} (${suffix})`);
        try {
          const fd = fs.openSync(candidate, 'wx');
          target = candidate;
          fs.closeSync(fd);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      if (!target) return fail();
      item.setSavePath(target);
    } catch (error) {
      if (target) { try { fs.unlinkSync(target); } catch { /* own reservation only */ } }
      log.warn('download destination unavailable', { error: logErrorRef(error) });
      return fail();
    }

    const received = () => Math.max(0, Number(item.getReceivedBytes()) || 0);
    const entry = recordWebAssistDownload(userId, conversationId, {
      at: Date.now(), origin, filename: path.basename(target), bytes: declared, state: 'downloading',
    });
    downloadPaths.set(entry, target);
    item.once('done', (_done, state) => {
      entry.bytes = received();
      if (state !== 'completed') {
        entry.state = 'failed';
        try { fs.unlinkSync(target); } catch { /* best effort */ }
        tab.errorCode = 'download_blocked';
      } else {
        entry.state = 'saved';
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
    ...(tab.userControlled ? { user_controlled: true } : {}),
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
    overlay_epoch: record.overlayEpoch,
    tabs: state.tabs.map(tab => {
      const source = record.tabs.get(tab.tab_id)!;
      const contents = source.view?.webContents;
      const rawUrl = source.loading && source.pendingAddressUrl
        ? source.pendingAddressUrl
        : contents && !contents.isDestroyed() ? contents.getURL() : source.suspended?.url || '';
      const permission = contents && !contents.isDestroyed() ? webAssistPermissionRequest(contents) : undefined;
      return {
        ...tab,
        address_url: rawUrl === 'about:blank' ? rawUrl : safeWebAssistUrl(rawUrl) || '',
        ...(permission ? { permission_request: permission } : {}),
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

function emit(record: WebAssistRecord, modelClosedConversationId?: string): void {
  if (record.owner.isDestroyed() || record.owner.webContents.isDestroyed()) return;
  try {
    record.owner.webContents.send('web-assist:state', {
      ...rendererSnapshot(record),
      ...(modelClosedConversationId ? { model_closed_conversation_id: modelClosedConversationId } : {}),
    });
  } catch (error) {
    log.warn('state delivery failed', { error: logErrorRef(error) });
  }
}

function emitClosed(record: WebAssistRecord, modelClosedConversationId?: string): void {
  if (record.owner.isDestroyed() || record.owner.webContents.isDestroyed()) return;
  try {
    record.owner.webContents.send('web-assist:state', {
      ...emptySnapshot(),
      ...(modelClosedConversationId ? { model_closed_conversation_id: modelClosedConversationId } : {}),
    });
  } catch (error) {
    log.warn('close state delivery failed', { error: logErrorRef(error) });
  }
}

function closeRecord(record: WebAssistRecord, notifyRenderer = false, modelClosedConversationId?: string): void {
  clearInterval(record.idleTimer);
  records.delete(record.owner.id);
  record.owner.removeListener('closed', record.ownerClosed);
  if (!record.owner.isDestroyed()) record.owner.webContents.removeListener('did-start-navigation', record.ownerNavigation);
  if (notifyRenderer) emitClosed(record, modelClosedConversationId);
  for (const tab of record.tabs.values()) {
    cancelWebAssistPasskey(tab.view?.webContents);
    for (const popup of tab.authorizationPopups) {
      cancelWebAssistPasskey(popup);
      if (!popup.isDestroyed()) popup.close({ waitForBeforeUnload: false });
    }
    clearDeferredWebAssistBounds(tab);
    tab.userActivity?.dispose();
    forgetBrowserTab(record.ownerUserId, tab.conversationId, tab.id);
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

function userControlResult(): Record<string, unknown> & { ok: false; code: string; error: string } {
  return { ok: false, code: 'user_controlled', retry_after_ms: WEB_ASSIST_USER_IDLE_MS,
    error: `User input temporarily paused this page. Control resumes after ${WEB_ASSIST_USER_IDLE_MS / 1000} seconds without input once held input ends. Wait, then observe the page before continuing.` };
}

function takePageControl(record: WebAssistRecord, tab: WebAssistTabRecord, controlled: boolean): void {
  const changed = Boolean(tab.userControlled) !== controlled;
  if (!changed && !controlled) return;
  tab.userControlled = controlled;
  if (controlled && tab.view) webAssistDialogs(tab.view.webContents)?.handback();
  if (tab.view) void refreshWebAssistFileChoosers(tab.view.webContents).catch(error => {
    log.warn('file chooser control update failed', { error: logErrorRef(error) });
  });
  // A user taking over a temporary page must not lose it when the task ends.
  if (controlled && tab.lifetime.retention === 'temporary') tab.lifetime.retention = 'handoff';
  tab.controlRevision = (tab.controlRevision || 0) + 1;
  tab.lastUsedAt = Date.now();
  invalidateObservation(tab);
  if (changed) emit(record);
}

function setTabVisible(tab: WebAssistTabRecord, visible: boolean): void {
  if (tab.visible && !visible) {
    cancelWebAssistPasskey(tab.view?.webContents);
    for (const popup of tab.authorizationPopups) cancelWebAssistPasskey(popup);
  }
  if (tab.visible !== visible) tab.lastUsedAt = Date.now();
  if (tab.visible && !visible) tab.userActivity?.release();
  tab.visible = visible;
  tab.view?.setVisible(visible && !tab.presentationSuppressed);
}

function clearDeferredWebAssistBounds(tab: WebAssistTabRecord): void {
  if (tab.boundsUpdate) clearImmediate(tab.boundsUpdate);
  tab.boundsUpdate = undefined;
  tab.pendingBounds = undefined;
}

/** A human press must reach its release before native page geometry changes.
 * Ownership still changes immediately; only presentation waits for the gesture. */
function flushDeferredWebAssistBounds(record: WebAssistRecord, tab: WebAssistTabRecord): void {
  if (!tab.pendingBounds || tab.boundsUpdate || tab.userActivity?.pointerHeld()) return;
  const view = tab.view;
  tab.boundsUpdate = setImmediate(() => {
    tab.boundsUpdate = undefined;
    if (tab.userActivity?.pointerHeld()) return;
    const bounds = tab.pendingBounds;
    tab.pendingBounds = undefined;
    if (!bounds || !view || record.owner.isDestroyed() || record.tabs.get(tab.id) !== tab
      || tab.view !== view || record.activeTabId !== tab.id || !tab.visible || !view.getVisible()) return;
    layoutWebAssist(record.owner.webContents, bounds);
  });
}

const deferredAuthorizationPopups = new WeakSet<WebContents>();
function revealDeferredAuthorizationPopups(record: WebAssistRecord, tab: WebAssistTabRecord): void {
  if (!record.owner.isFocusable() || !taskIsForeground(record.owner.webContents, tab.conversationId)) return;
  for (const contents of tab.authorizationPopups) {
    if (!deferredAuthorizationPopups.has(contents)) continue;
    const popup = BrowserWindow.fromWebContents(contents);
    if (popup && !popup.isDestroyed()) {
      deferredAuthorizationPopups.delete(contents);
      popup.showInactive();
    }
  }
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
function applyDesktopViewport(tab: WebAssistTabRecord): Promise<void> {
  const contents = tab.view?.webContents;
  if (!contents || contents.isDestroyed()) return Promise.resolve();
  const width = Math.round(Number(tab.bounds?.width) || 0);
  const height = Math.round(Number(tab.bounds?.height) || 0);
  if (tab.virtualViewportWidth === width && tab.virtualViewportHeight === height) return tab.viewportUpdate || Promise.resolve();
  const actualWidth = width || tab.view!.getBounds().width;
  const scale = Math.min(1, actualWidth / DESKTOP_VIEWPORT_WIDTH);
  const update = setWebAssistViewport(contents, scale);
  const previous = tab.viewportUpdate;
  tab.viewportUpdate = update;
  tab.virtualViewportWidth = width;
  tab.virtualViewportHeight = height;
  if (previous !== update) void update.catch(error => {
    if (tab.view?.webContents !== contents || contents.isDestroyed()) return;
    if (tab.viewportUpdate === update) {
      tab.virtualViewportWidth = undefined;
      tab.virtualViewportHeight = undefined;
    }
    log.warn('desktop viewport emulation failed', { error: logErrorRef(error) });
  });
  return update;
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
    && !tab.userControlled && !tab.inputBusy
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
    tab.pendingAddressUrl = saved.entries.length ? saved.entries[historyIndex ?? saved.index].url : saved.url;
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

function navigateTabHistory(record: WebAssistRecord, tab: WebAssistTabRecord, action: unknown, modelInitiated = false):
  { ok: true } | { ok: false; code: string; error: string } {
  const unavailable = { ok: false as const, code: 'navigation_unavailable', error: 'This browser navigation is unavailable.' };
  if (!['back', 'forward', 'reload'].includes(String(action))) return unavailable;
  if (modelInitiated && webAssistDialogs(tab.view?.webContents)?.pending()) {
    return { ok: false, code: 'dialog_pending', error: 'Answer the current dialog before navigating.' };
  }
  const saved = tab.suspended;
  const index = saved ? saved.index + (action === 'back' ? -1 : action === 'forward' ? 1 : 0) : undefined;
  if (saved && action !== 'reload' && (index! < 0 || index! >= saved.entries.length)) return unavailable;
  if (saved) tab.modelControlRunId = modelInitiated ? browserTaskRunId(record.ownerUserId, tab.conversationId) : undefined;
  if (!ensureTabLoaded(record, tab, true, index)) {
    return { ok: false, code: 'page_loading', error: 'The page is being restored; wait before navigating.' };
  }
  // Restoration itself navigates directly to the requested history entry.
  if (!saved) {
    const contents = tab.view.webContents;
    if (action === 'back' && !contents.navigationHistory.canGoBack()
      || action === 'forward' && !contents.navigationHistory.canGoForward()) return unavailable;
    tab.modelControlRunId = modelInitiated ? browserTaskRunId(record.ownerUserId, tab.conversationId) : undefined;
    if (action === 'back') contents.navigationHistory.goBack();
    else if (action === 'forward') contents.navigationHistory.goForward();
    else contents.reload();
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
  tabId?: string,
): { ok: true; record: WebAssistRecord; tab: WebAssistTabRecord } | { ok: false; code: string; error: string } {
  const sender = boundSender(userId, conversationId);
  if (!sender) {
    return unboundSenderFailure('conversation');
  }
  const record = recordForSender(sender);
  if (!record) {
    return { ok: false, code: 'not_open', error: 'Web Assist is not open for this connector.' };
  }
  const matches = (candidate: WebAssistTabRecord) => {
    const context = candidate.controlContext;
    return context?.userId === userId
      && context.conversationId === conversationId
      && context.scope === 'connector_setup'
      && context.scopeId === scopeId;
  };
  const tab = tabId ? record.tabs.get(tabId) : [...record.tabs.values()].find(matches);
  if (!tab || !matches(tab)) {
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
  tab.modelControlRunId = browserTaskRunId(record.ownerUserId, tab.conversationId);
  // Both tools operate the same task-owned page. Observation, screenshots and
  // page input must preserve its setup binding and in-flight control identity.
  // Explicit browser navigation revokes the binding before exposing its page.
  const context = tab.controlContext;
  if (!context || context.userId !== record.ownerUserId
    || context.conversationId !== tab.conversationId) {
    tab.controlContext = {
      userId: record.ownerUserId,
      conversationId: tab.conversationId,
      scope: 'browser',
      scopeId: tab.id,
    };
  }
  // Background work records a deferred reveal for its task without changing
  // the window's selection. Old control bindings alone never request a reveal.
  if (tab.userControlled) return { ok: true };
  const foreground = taskIsForeground(sender, tab.conversationId);
  if (foreground) {
    record.activeTabId = tab.id;
    for (const candidate of record.tabs.values()) {
      if (candidate !== tab) setTabVisible(candidate, false);
    }
  }
  try {
    sender.send('web-assist:show', {
      ...(foreground ? rendererSnapshot(record) : {}), browser_activity_conversation_id: tab.conversationId,
    });
    return { ok: true };
  } catch (error) {
    log.warn('model browser show failed', { error: logErrorRef(error) });
    if (!foreground) return { ok: true };
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
  if (!tab.userControlled && activeConversationBySender.get(record.owner.webContents as unknown as object) === tab.conversationId) {
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
  frameId?: string,
): Promise<unknown> {
  return interruptOnWebAssistDialog(contents, () => webAssistEvaluate(contents, code, frameId, true, userGesture));
}

const pendingTextReads = new WeakMap<WebContents, Promise<unknown>>();

async function readWebAssistTextCondition(
  contents: WebContents, text: string, deadline: number, lifetime: WebAssistActionLifetime,
): Promise<unknown> {
  // A stopped caller cannot cancel Chromium work. Keep the original bounded
  // read reserved until settlement/deadline, without reusing its answer for a
  // new condition or extending its lifetime on repeated stop/restart.
  if (pendingTextReads.has(contents)) return undefined;
  // Native evaluation can remain pending on an unresponsive page. Bound each
  // read by the shared wait deadline; timing out does not cancel native work.
  const reading = withOperationTimeout(
    executeWebAssistScript(contents, buildWebAssistTextConditionScript(text)),
    { timeoutMs: Math.max(1, deadline - Date.now()), code: 'wait_timeout', stage: 'browser text condition' },
  );
  pendingTextReads.set(contents, reading);
  const release = () => {
    if (pendingTextReads.get(contents) === reading) pendingTextReads.delete(contents);
  };
  void reading.then(release, release);
  if (!lifetime.signal && !lifetime.isActive) return reading;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped!: () => void;
  const cancelled = new Promise<undefined>(resolve => {
    stopped = () => resolve(undefined);
    lifetime.signal?.addEventListener('abort', stopped, { once: true });
    if (lifetime.isActive) {
      // Task replacement has no separate signal. Use the existing wait polling
      // cadence; this timer observes lifetime only and never reads Chromium.
      timer = setInterval(() => { if (lifetime.isActive?.() === false) stopped(); }, 200);
      timer.unref();
    }
    if (lifetime.signal?.aborted || lifetime.isActive?.() === false) stopped();
  });
  try {
    return await Promise.race([reading, cancelled]);
  } finally {
    clearInterval(timer);
    lifetime.signal?.removeEventListener('abort', stopped);
  }
}

// Native load events own navigation status. A loadURL/restore promise can reject
// after a replacement navigation starts (including ERR_ABORTED), so its catch
// must never overwrite the current page's state.
function handleLoadFailure(record: WebAssistRecord, tab: WebAssistTabRecord, netCode: number): void {
  tab.loading = false;
  tab.pendingAddressUrl = undefined;
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
    ownerNavigation: () => {},
    overlayBlocked: false,
    overlayRevision: -1,
    overlayEpoch: ++nextOverlayEpoch,
  };
  record.ownerClosed = () => closeRecord(record);
  owner.once('closed', record.ownerClosed);
  record.ownerNavigation = (_event, _url, isSameDocument, isMainFrame) => {
    if (!isMainFrame || isSameDocument) return;
    // A new trusted document starts a new update sequence. Keep pixels hidden
    // until that document has synchronized its layers and supplied fresh layout.
    record.overlayEpoch = ++nextOverlayEpoch;
    record.overlayRevision = -1;
    record.overlayBlocked = true;
    for (const tab of record.tabs.values()) {
      tab.presentationSuppressed = true;
      tab.view?.setVisible(false);
    }
  };
  owner.webContents.on('did-start-navigation', record.ownerNavigation);
  record.idleTimer = setInterval(() => { void reclaimIdleWebAssistPages(Date.now(), record.owner.id); }, IDLE_PAGE_SCAN_MS);
  record.idleTimer.unref();
  return record;
}

function removeTab(record: WebAssistRecord, tab: WebAssistTabRecord, notifyRenderer = true, modelInitiated = false): void {
  if (record.tabs.get(tab.id) !== tab) return;
  cancelWebAssistPasskey(tab.view?.webContents);
  for (const popup of tab.authorizationPopups) {
    cancelWebAssistPasskey(popup);
    if (!popup.isDestroyed()) popup.close({ waitForBeforeUnload: false });
  }
  clearDeferredWebAssistBounds(tab);
  tab.userActivity?.dispose();
  forgetBrowserTab(record.ownerUserId, tab.conversationId, tab.id);
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
  const modelClosedConversationId = modelInitiated
    && ![...record.tabs.values()].some(candidate => candidate.conversationId === tab.conversationId)
    ? tab.conversationId : undefined;
  if (!record.tabs.size) {
    closeRecord(record, notifyRenderer, modelClosedConversationId);
  } else if (notifyRenderer) {
    emit(record, modelClosedConversationId);
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
    modelControlRunId: createdBy === 'model' ? browserTaskRunId(record.ownerUserId, conversationId) : undefined,
    visible: false, presentationSuppressed: record.overlayBlocked,
    lastUsedAt: Date.now(), activeOperations: 0, edited: false,
    replayable: !options.webContents, relatedTabs: new Set(),
    loading: false, authorizationPopups: new Set(),
  };
  mountTab(record, tab, options);
  record.tabs.set(tab.id, tab);
  tab.lifetime = registerBrowserTab(record.ownerUserId, conversationId, tab.id, createdBy, () => {
    removeTab(record, tab, true, true);
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
  tab.virtualViewportWidth = undefined;
  tab.virtualViewportHeight = undefined;
  tab.viewportUpdate = undefined;

  const contents = view.webContents;
  const authority = () => {
    const runId = browserTaskRunId(record.ownerUserId, conversationId);
    return runId && runId === tab.modelControlRunId && !tab.userControlled
      && tab.view === view && records.get(record.owner.id) === record && record.tabs.get(tab.id) === tab
      ? runId : undefined;
  };
  const dialogs = attachWebAssistDialogs(contents, authority, () => invalidateObservation(tab));
  attachWebAssistFileChoosers(contents, authority, () => invalidateObservation(tab));
  const stopWatching = watchBrowserTaskRun(record.ownerUserId, conversationId, () => {
    dialogs?.cancel(); invalidateObservation(tab);
    void refreshWebAssistFileChoosers(contents).catch(error => {
      log.warn('file chooser control update failed', { error: logErrorRef(error) });
    });
  });
  contents.once('destroyed', stopWatching);
  attachWebAssistViewport(contents, Math.min(1, view.getBounds().width / DESKTOP_VIEWPORT_WIDTH));
  proxy.attach(contents);
  attachWebAssistPasskeys(contents, {
    parent: record.owner, attachProxy: proxy.attach,
    changed: () => invalidateObservation(tab),
    eligible: () => records.get(record.owner.id) === record && record.tabs.get(tab.id) === tab
      && tab.view === view && view.getVisible() && record.activeTabId === tab.id
      && (!conversationId || taskIsForeground(record.owner.webContents, conversationId)),
  });
  tab.userActivity = watchWebAssistUserActivity(contents, (controlled, edited) => {
    if (tab.view !== view || record.tabs.get(tab.id) !== tab) return;
    if (edited) tab.edited = true;
    takePageControl(record, tab, controlled);
    flushDeferredWebAssistBounds(record, tab);
  });
  contents.setWindowOpenHandler((details) => {
    const { url, disposition } = details;
    if (records.get(record.owner.id) !== record || record.tabs.get(tab.id) !== tab) {
      return { action: 'deny' };
    }
    if (url !== 'about:blank' && !safeWebAssistUrl(url)) return { action: 'deny' };
    // Chromium has already interpreted target, popup features and click
    // modifiers. Do not infer a window type from page content or URL keywords.
    if (['foreground-tab', 'background-tab', 'default', 'new-window'].includes(disposition)) {
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
            child.pendingAddressUrl = url;
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
    return { action: 'deny' };
  });
  contents.on('did-create-window', (popup) => {
    tab.authorizationPopups.add(popup.webContents);
    if (!taskIsForeground(record.owner.webContents, conversationId)) deferredAuthorizationPopups.add(popup.webContents);
    popup.webContents.once('destroyed', () => tab.authorizationPopups.delete(popup.webContents));
    configureWebAssistPopup(popup, proxy);
    attachWebAssistPasskeys(popup.webContents, {
      parent: popup, attachProxy: proxy.attach,
      eligible: () => records.get(record.owner.id) === record && record.tabs.get(tab.id) === tab
        && record.activeTabId === tab.id && tab.authorizationPopups.has(popup.webContents)
        && popup.isVisible() && taskIsForeground(record.owner.webContents, conversationId),
    });
  });
  const guardNavigation = (event: { preventDefault(): void }, target: string): void => {
    if (!safeWebAssistUrl(target)) event.preventDefault();
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.on('did-start-navigation', (_event, _url, _isSameDocument, isMainFrame) => {
    if (tab.view !== view) return;
    if (isMainFrame) {
      tab.navigationRevision = (tab.navigationRevision || 0) + 1;
      tab.lastUsedAt = Date.now();
      if (!_isSameDocument) {
        tab.edited = false;
        tab.pendingAddressUrl = safeWebAssistUrl(_url) || undefined;
      }
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
    tab.pendingAddressUrl = undefined;
    emit(record);
  });
  contents.on('did-navigate', () => {
    if (tab.view !== view) return;
    tab.navigationRevision = (tab.navigationRevision || 0) + 1;
    tab.pendingAddressUrl = undefined;
    // Error documents also emit did-finish-load; only a committed navigation
    // proves that a new page has replaced the previous load failure.
    if (tab.errorCode === 'page_load_failed') tab.errorCode = undefined;
    // A new document initializes its temporary zoom in the isolated preload.
    // Invalidate the layout receipt so observation waits for the new document.
    tab.virtualViewportWidth = undefined;
    tab.virtualViewportHeight = undefined;
    applyDesktopViewport(tab);
    invalidateObservation(tab);
    emit(record);
  });
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (tab.view !== view) return;
    if (isMainFrame !== false) tab.navigationRevision = (tab.navigationRevision || 0) + 1;
    tab.pendingAddressUrl = undefined;
    invalidateObservation(tab);
    emit(record);
  });
  contents.on('page-title-updated', () => { if (tab.view === view) emit(record); });
  contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (tab.view === view && isMainFrame && errorCode !== -3) {
      handleLoadFailure(record, tab, errorCode);
    }
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
    tab.pendingAddressUrl = undefined;
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
    && !tab.userControlled && !tab.inputBusy && !tab.activeOperations
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
  // createTab does not emit state, so the renderer never sees tabs beyond the limit.
  const tab = createTab(record, conversationId, label, createdBy, options);
  for (const old of removable) removeTab(record, old, false);
  return { tab, closedTabIds: removable.map(old => old.id) };
}

function tabLimitFailure() {
  return {
    ok: false as const, code: 'too_many_tabs', tab_limit: MAX_TABS_PER_CONVERSATION,
    error: `This task has reached its ${MAX_TABS_PER_CONVERSATION}-tab limit with no safely removable old model tab. Reuse an existing tab with navigate, or close an unneeded tab before opening another.`,
  };
}

let accountGeneration = 0;
const browserOpenGenerations = new WeakMap<WebContents, number>();

async function prepareBrowserCache(userId: string, sender: WebContents, owner: BrowserWindow): Promise<boolean> {
  const generation = accountGeneration;
  const openGeneration = browserOpenGenerations.get(sender);
  try {
    await prepareWebAssistCache(userId);
    return generation === accountGeneration && openGeneration === browserOpenGenerations.get(sender)
      && !sender.isDestroyed() && !owner.isDestroyed();
  } catch {
    logWebAssistFailure(sender, 'view_unavailable');
    return false;
  }
}

export async function openWebAssist(
  userId: string,
  sender: WebContents,
  input: { url?: unknown; label?: unknown; conversationId?: unknown; tabId?: unknown },
  createdBy: BrowserTabLifetime['createdBy'] = 'user',
  modelRetention?: { runId: string; retention: BrowserTabRetention },
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
  if (!await prepareBrowserCache(userId, sender, owner)) return { ok: false, code: 'view_unavailable', error: 'Web Assist could not be opened. Try again.' };
  // The async preparation must not carry an old turn's cleanup policy into a
  // replacement run. Renderer-owned opens never receive this host-only option.
  if (modelRetention && (createdBy !== 'model' || browserTaskRunId(userId, conversationId) !== modelRetention.runId)) {
    return { ok: false, code: 'task_run_ended', error: 'This browser task turn has ended.' };
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
      // Apply only to this newly created model tab, before navigation or any
      // renderer notification. Immediate human input can then preserve it.
      if (modelRetention && (browserTaskRunId(userId, conversationId) !== modelRetention.runId
          || !retainBrowserTab(userId, conversationId, tab.id, modelRetention.retention))) {
        removeTab(record, tab, false);
        return { ok: false, code: 'task_run_ended', error: 'This browser task turn has ended.' };
      }
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
  tab.assistantAction = undefined;
  invalidateObservation(tab);
  tab.modelControlRunId = createdBy === 'model' ? browserTaskRunId(userId, conversationId) : undefined;
  tab.loading = true;
  tab.pendingAddressUrl = url;
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

export async function addWebAssistTab(
  userId: string,
  sender: WebContents,
  input: { conversationId?: unknown; label?: unknown; ifEmpty?: unknown },
): Promise<{ ok: true; state: WebAssistSnapshot } | { ok: false; code: string; error: string }> {
  if (!safeId(userId)) return { ok: false, code: 'invalid_user', error: 'Web Assist is unavailable for this account.' };
  const conversationId = String(input?.conversationId || '');
  if (!safeId(conversationId)) return { ok: false, code: 'invalid_conversation', error: 'Open a task before adding a browser tab.' };
  const owner = BrowserWindow.fromWebContents(sender);
  if (!owner || owner.isDestroyed()) return { ok: false, code: 'window_unavailable', error: 'The Orkas window is unavailable.' };
  if (!await prepareBrowserCache(userId, sender, owner)) return { ok: false, code: 'view_unavailable', error: 'Web Assist could not be opened. Try again.' };
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
  modelInitiated = false,
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
  tab.assistantAction = undefined;
  invalidateObservation(tab);
  tab.loading = true;
  tab.modelControlRunId = modelInitiated ? browserTaskRunId(record.ownerUserId, tab.conversationId) : undefined;
  tab.pendingAddressUrl = url;
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
  const url = safeWebAssistUrl(input.url);
  if (!url) return { ok: false, code: 'invalid_url', error: 'Open an HTTP or HTTPS page in Web Assist.' };
  // DOM availability is not page existence. Reuse the host-owned binding even
  // when observation failed, navigation is loading or the user is editing.
  const existing = controlledRecord(userId, conversationId, input.scopeId);
  let resolved: { record: WebAssistRecord; tab: WebAssistTabRecord };
  const created = !existing.ok;
  if (existing.ok) {
    resolved = existing;
  } else {
    const opened = await openWebAssist(userId, sender, {
      url,
      label: input.label,
      conversationId,
    }, 'model');
    if (!opened.ok) return opened;
    const current = taskTab(userId, conversationId, opened.tab_id);
    if (current.ok === false) return current;
    resolved = current;
    current.tab.controlContext = {
      userId,
      conversationId,
      scope: input.scope,
      scopeId: input.scopeId,
    };
    invalidateObservation(current.tab);
  }
  const { record, tab } = resolved;
  const foreground = taskIsForeground(sender, conversationId);
  if (foreground) {
    record.activeTabId = tab.id;
    for (const candidate of record.tabs.values()) {
      if (candidate !== tab) setTabVisible(candidate, false);
    }
  }
  const state: WebAssistSnapshot = {
    open: true,
    ...tabSnapshot(tab),
    active_tab_id: tab.id,
    tabs: [...record.tabs.values()]
      .filter(candidate => candidate.conversationId === conversationId)
      .map(tabSnapshot),
  };
  try {
    sender.send('web-assist:show', {
      ...(foreground ? rendererSnapshot(record) : {}), browser_activity_conversation_id: conversationId,
    });
  } catch (error) {
    log.warn('controlled view show failed', { error: logErrorRef(error) });
    if (!foreground) return { ok: true, state };
    if (created) removeTab(record, tab, true);
    return { ok: false, code: 'renderer_unavailable', error: 'Web Assist could not be shown.' };
  }
  return { ok: true, state };
}

function observeWebAssistDialog(tab: WebAssistTabRecord, scope: 'full' | 'meta' = 'full', window: WebAssistObserveWindow = {}): Record<string, unknown> | undefined {
  const contents = tab.view?.webContents;
  if (!contents || tab.userControlled) return undefined;
  const controller = webAssistDialogs(contents);
  const dialog = controller?.pending();
  if (!dialog) return undefined;
  const pageId = genId12();
  const elements = [
    { ref: 'e1', tag: 'button', role: 'button', label: 'OK' },
    { ref: 'e2', tag: 'button', role: 'button', label: 'Cancel' },
    ...(dialog.info.dialogType === 'prompt' ? [{ ref: 'e3', tag: 'input', role: 'textbox', label: 'Prompt', input_type: 'text', fillable: true, sensitive: true }] : []),
  ];
  tab.observation = { pageId, dialogId: dialog.id, url: contents.getURL(), hrefs: new Set(),
    refs: new Map(elements.map(e => [e.ref, { path: [], signature: { tag: e.tag, type: '', role: e.role, label: e.label } }])),
  };
  const text = dialog.info.messageText.slice(0, 6000);
  return fitWebAssistObservation({ ok: true, tab_id: tab.id, page_id: pageId, dialog_type: dialog.info.dialogType,
    display_url: displayUrl(contents.getURL()), untrusted_content: true,
    ...(scope === 'meta' ? { scope, text_length: text.length } : { text, text_total: dialog.info.messageText.length,
      text_truncated: dialog.info.messageText.length > text.length, elements, element_count: elements.length }),
    ...controller!.notices(),
  }, window.tokenBudget ?? DEFAULT_INLINE_RESULT_TOKENS);
}

function observeWebAssistFileChooser(tab: WebAssistTabRecord, scope: 'full' | 'meta' = 'full'): Record<string, unknown> | undefined {
  const contents = tab.view?.webContents;
  const chooser = contents && webAssistFileChooser(contents);
  if (!chooser) return;
  const pageId = genId12();
  const elements = [
    { ref: 'e1', tag: 'input', role: '', label: 'Upload files', input_type: 'file', multiple: chooser.multiple, fillable: false },
    { ref: 'e2', tag: 'button', role: 'button', label: 'Cancel' },
  ];
  tab.observation = { pageId, fileChooserId: chooser.id, url: contents!.getURL(), hrefs: new Set(),
    refs: new Map(elements.map(e => [e.ref, { path: [], signature: { tag: e.tag, type: 'input_type' in e ? e.input_type! : '', role: e.role, label: e.label } }])) };
  return { ok: true, tab_id: tab.id, page_id: pageId, dialog_type: 'file_chooser', frame_id: chooser.frameId,
    display_url: displayUrl(contents!.getURL()), untrusted_content: true,
    ...(scope === 'meta' ? { scope, text_length: 0 } : { text: '', elements, element_count: elements.length }) };
}

function observeWebAssistPermission(tab: WebAssistTabRecord, scope: 'full' | 'meta'): Record<string, unknown> | undefined {
  const contents = tab.view?.webContents;
  const request = contents && webAssistPermissionRequest(contents);
  if (!request) return;
  const pageId = genId12();
  const requiresUser = request.permission !== 'screen-wake-lock';
  const elements = [
    { ref: 'e1', tag: 'button', role: 'button', label: 'Allow', ...(requiresUser ? { requires_user_action: true } : {}) },
    { ref: 'e2', tag: 'button', role: 'button', label: 'Deny' },
  ];
  tab.observation = { pageId, permissionId: request.id, url: contents!.getURL(), hrefs: new Set(),
    refs: new Map(elements.map(e => [e.ref, { path: [], signature: { tag: e.tag, type: '', role: e.role, label: e.label } }])) };
  return { ok: true, tab_id: tab.id, page_id: pageId, dialog_type: 'permission',
    origin: request.origin, permission: request.permission, requires_user_action: requiresUser,
    ...(scope === 'meta' ? { scope, text_length: 0 } : { elements, element_count: elements.length }) };
}

function observeWebAssistNativeDecision(tab: WebAssistTabRecord, scope: 'full' | 'meta'): Record<string, unknown> | undefined {
  const contents = tab.view?.webContents;
  if (!contents) return;
  const selection = webAssistNativeSelection(contents);
  const passkey = webAssistPasskeyRequest(contents);
  const request = selection || passkey;
  if (!request) return;
  const pageId = genId12();
  const elements = [{ ref: 'e1', tag: 'button', role: 'button', label: 'Cancel' }];
  tab.observation = { pageId, nativeDecision: { id: request.id, kind: selection ? 'selection' : 'passkey' },
    url: contents.getURL(), hrefs: new Set(),
    refs: new Map(elements.map(e => [e.ref, { path: [], signature: { tag: e.tag, type: '', role: e.role, label: e.label } }])) };
  return { ok: true, tab_id: tab.id, page_id: pageId, dialog_type: selection ? 'device_selection' : 'passkey',
    ...(selection ? { selection_kind: selection.kind } : {}), origin: request.origin, requires_user_action: true,
    ...(scope === 'meta' ? { scope, text_length: 0 } : { elements, element_count: elements.length }) };
}

/** Host-owned decisions are outside the website DOM and its captured pixels.
 * Every browser observation lane must project the same current decision. */
function observeWebAssistInteraction(tab: WebAssistTabRecord, scope: 'full' | 'meta' = 'full', window: WebAssistObserveWindow = {}): Record<string, unknown> | undefined {
  if (tab.userControlled) return;
  return observeWebAssistDialog(tab, scope, window)
    || observeWebAssistNativeDecision(tab, scope)
    || observeWebAssistPermission(tab, scope)
    || observeWebAssistFileChooser(tab, scope);
}

async function observeWebAssistTab(
  record: WebAssistRecord,
  tab: WebAssistTabRecord,
  scope: 'full' | 'meta' = 'full',
  window: WebAssistObserveWindow = {},
): Promise<Record<string, unknown>> {
  if (!ensureTabLoaded(record, tab)) return { ok: false, code: 'page_loading', error: 'The page is being restored; wait before observing it.' };
  const contents = tab.view.webContents;
  tab.modelControlRunId = browserTaskRunId(record.ownerUserId, tab.conversationId);
  const dialog = observeWebAssistInteraction(tab, scope, window);
  if (dialog) return dialog;
  const controlRevision = tab.controlRevision || 0;
  const navigationRevision = tab.navigationRevision || 0;
  const currentUrl = contents.getURL() === 'about:blank' ? 'about:blank' : safeWebAssistUrl(contents.getURL());
  if (!currentUrl) return { ok: false, code: 'page_unavailable', error: 'There is no controllable web page.' };
  try {
    // A parser-ready page can be observed before subresources finish. Restore
    // the desktop viewport for recreated hidden views on macOS as well.
    await applyDesktopViewport(tab);
    const frames = await webAssistFrames(contents);
    const frame = window.frameId ? frames.find(frame => frame.id === window.frameId) : frames.find(frame => !frame.parentId);
    if (!frame) return { ok: false, code: 'unknown_frame', error: 'Choose a frame from observe.' };
    const raw = await withAssistantAction(record, tab, 'observing', () => (
      withOperationTimeout(executeWebAssistScript(contents, webAssistObserveScript(tab.controlContext?.scope, window), false, frame.id),
        { timeoutMs: 5000, code: 'observation_timeout', stage: 'browser observation' })
    ));
    const dialog = observeWebAssistInteraction(tab, scope, window);
    if (dialog) return dialog;
    const navigated = (tab.navigationRevision || 0) !== navigationRevision;
    if (navigated || contents.isDestroyed() || contents.getURL() !== currentUrl || (tab.controlRevision || 0) !== controlRevision) {
      // Navigation already invalidated old refs; a newer read may own current refs.
      if (!navigated) invalidateObservation(tab);
      return { ok: false, code: 'page_changed', error: 'The page changed while it was being observed; observe it again.' };
    }
    const pageId = genId12();
    const sanitized = sanitizeWebAssistObservation(raw, pageId, displayUrl(currentUrl));
    if (!sanitized) {
      return { ok: false, code: 'observation_failed', error: 'The page could not be observed.' };
    }
    tab.observation = { pageId, url: currentUrl, refs: sanitized.refs, hrefs: sanitized.hrefs, frameId: frame.id };
    sanitized.publicSnapshot.frame_id = frame.id;
    // `meta` walks and stores refs exactly as `full` does, then drops the page
    // payload and the frame inventory from the reply. An act whose page_id went
    // stale needs a fresh page_id and valid refs, not the page re-read; charging
    // a full observation for that made scroll-then-read loops cost one whole
    // page per step.
    if (scope === 'meta') {
      const { text, elements, ...rest } = sanitized.publicSnapshot as
        Record<string, unknown> & { text?: unknown; elements?: unknown };
      return {
        ok: true,
        tab_id: tab.id,
        ...rest,
        scope: 'meta',
        text_length: typeof text === 'string' ? text.length : 0,
        ...webAssistDialogs(contents)?.notices(),
        ...takeWebAssistFilePickerNotice(contents),
      };
    }
    Object.assign(sanitized.publicSnapshot, webAssistFrameInventory(frames, frame.id));
    return fitWebAssistObservation(
      { ok: true, tab_id: tab.id, ...sanitized.publicSnapshot, ...webAssistDialogs(contents)?.notices(), ...takeWebAssistFilePickerNotice(contents) },
      window.tokenBudget ?? DEFAULT_INLINE_RESULT_TOKENS,
    );
  } catch (error) {
    if (error instanceof WebAssistDialogOpenedError) {
      const dialog = observeWebAssistInteraction(tab, scope, window);
      if (dialog) return dialog;
    }
    log.warn('page observation failed', { error: logErrorRef(error) });
    invalidateObservation(tab);
    return { ok: false, code: 'observation_failed', error: 'The page could not be observed.' };
  }
}

/** Read one current field without changing it or invalidating its snapshot. */
export async function readModelWebAssistValue(
  userId: string, conversationId: string,
  input: { tabId?: unknown; pageId?: unknown; elementRef?: unknown; textOffset?: unknown; action?: 'read_value' | 'options'; optionOffset?: number },
  lifetime: WebAssistActionLifetime = {},
): Promise<Record<string, unknown>> {
  const resolved = taskTab(userId, conversationId, input.tabId);
  if (!resolved.ok) return resolved;
  if (resolved.tab.inputBusy) return { ok: false, code: 'action_in_progress', error: 'An operation is already running on this page.' };
  const offset = input.textOffset === undefined ? 0 : input.textOffset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 5_000_000) {
    return { ok: false, code: 'invalid_offset', error: 'The field offset must be an integer from 0 to 5000000.' };
  }
  const checked = checkWebAssistAction(resolved.tab, { ...input, action: 'fill', text: '' });
  if (!checked.ok) return checked;
  const exposed = exposeTaskTabToModel(resolved);
  if (!exposed.ok) return exposed;
  const { record, tab } = resolved;
  if (tab.observation?.dialogId) return { ok: false, code: 'sensitive_field', error: 'Dialog input values are not returned.' };
  if (tab.observation?.permissionId || tab.observation?.fileChooserId || tab.observation?.nativeDecision) return { ok: false, code: 'invalid_action', error: 'This browser decision has no readable field.' };
  const revision = tab.controlRevision || 0;
  const current = () => !lifetime.signal?.aborted && lifetime.isActive?.() !== false
    && record.tabs.get(tab.id) === tab && tab.view?.webContents === checked.contents
    && !checked.contents.isDestroyed() && (tab.controlRevision || 0) === revision
    && checkWebAssistAction(tab, { ...input, action: 'fill', text: '' }).ok;
  if (!current()) return { ok: false, code: 'stale_page', error: 'The page changed before the field was read.' };
  tab.inputBusy = true;
  try {
    const raw = await withAssistantAction(record, tab, 'observing', () => withOperationTimeout(
      executeWebAssistScript(checked.contents, buildWebAssistActionScript({
        action: input.action || 'read_value', ref: checked.ref, textOffset: offset, optionOffset: input.optionOffset,
      }), false, tab.observation?.frameId), { timeoutMs: 5000, code: 'observation_timeout', stage: 'browser field' },
    ));
    if (!current()) return { ok: false, code: 'stale_page', error: 'The page changed while the field was read.' };
    return raw as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'observation_failed', error: 'The field could not be read.' };
  } finally { tab.inputBusy = false; }
}

export async function observeControlledWebAssist(
  userId: string,
  conversationId: string,
  scopeId: string,
  tokenBudget?: number,
): Promise<Record<string, unknown>> {
  const resolved = controlledRecord(userId, conversationId, scopeId);
  if (!('record' in resolved)) return { ok: false, code: resolved.code, error: resolved.error };
  return observeWebAssistTab(resolved.record, resolved.tab, 'full', tokenBudget === undefined ? {} : { tokenBudget });
}

const PAGE_ACTIONS = new Set<WebAssistPageAction>([
  'click', 'fill', 'select', 'check', 'uncheck', 'scroll', 'drag', 'upload', 'press', 'hover', 'double_click', 'right_click',
]);

type CheckedWebAssistAction =
  | {
      ok: true;
      contents: WebContents;
      action: WebAssistPageAction;
      text: string;
      direction: 'up' | 'down' | 'top' | 'bottom' | 'left' | 'right';
      ref?: WebAssistStoredElementRef;
      drag?: { x: number; y: number };
    }
  | { ok: false; code: string; error: string };

function checkWebAssistAction(
  tab: WebAssistTabRecord,
  input: {
    pageId?: unknown;
    elementRef?: unknown;
    point?: number[];
    action?: unknown;
    text?: unknown;
    direction?: unknown;
    dragDeltaX?: unknown;
    dragDeltaY?: unknown;
    filePaths?: unknown;
    values?: string[];
    keys?: string;
  },
): CheckedWebAssistAction {
  if (tab.userControlled) return userControlResult();
  const contents = tab.view?.webContents;
  const action = String(input.action || '') as WebAssistPageAction;
  if (!PAGE_ACTIONS.has(action)) {
    return { ok: false, code: 'invalid_action', error: 'Unsupported Web Assist page action.' };
  }
  if (!contents || tab.suspended) return { ok: false, code: 'stale_page', error: 'The page changed; observe it again before acting.' };
  const observation = tab.observation;
  const pageId = String(input.pageId || '');
  if (input.point !== undefined && observation?.pageId === pageId) {
    return { ok: false, code: 'screenshot_required', error: 'Point input requires page_id from a current screenshot.' };
  }
  const expectedId = input.point !== undefined ? observation?.visual?.pageId : observation?.pageId;
  if (!observation || expectedId !== pageId || contents.getURL() !== observation.url) {
    return { ok: false, code: 'stale_page', error: input.point !== undefined
      ? 'The screenshot changed; take another screenshot before point input.' : 'The page changed; observe it again before acting.' };
  }
  const text = typeof input.text === 'string' ? input.text : '';
  if (text.length > MAX_PAGE_ACTION_TEXT_LENGTH || /[\u0000]/u.test(text)) {
    return { ok: false, code: 'invalid_text', error: `Page action text must be at most ${MAX_PAGE_ACTION_TEXT_LENGTH} characters and contain no NUL characters.` };
  }
  const directionRaw = String(input.direction || 'down');
  if (!['up', 'down', 'top', 'bottom', 'left', 'right'].includes(directionRaw)) {
    return { ok: false, code: 'invalid_direction', error: 'Scroll direction must be up, down, top, bottom, left, or right.' };
  }
  if (input.point !== undefined) {
    if (input.elementRef || !['click', 'hover', 'double_click', 'right_click', 'drag'].includes(action)
      || !Array.isArray(input.point) || input.point.length !== 2
      || !input.point.every(value => Number.isFinite(value) && value >= 0)) {
      return { ok: false, code: 'invalid_point', error: 'Use point [x,y] alone for click, hover, double_click, right_click or drag.' };
    }
    const visual = observation.visual;
    if (!visual) return { ok: false, code: 'screenshot_required', error: 'Point input requires page_id from a current screenshot.' };
    if (input.point[0] >= visual.width || input.point[1] >= visual.height) {
      return { ok: false, code: 'invalid_point', error: `Point must be inside the ${visual.width} by ${visual.height} CSS-pixel viewport.` };
    }
  }
  let ref: WebAssistStoredElementRef | undefined;
  if (input.point === undefined && (!['scroll', 'press'].includes(action) || input.elementRef)) {
    const elementRef = String(input.elementRef || '');
    ref = observation.refs.get(elementRef);
    if (!ref) {
      return { ok: false, code: 'unknown_element', error: 'Use an element ref from the current page observation.' };
    }
  }
  if ((action === 'fill' || (action === 'select' && !Array.isArray(input.values))) && typeof input.text !== 'string') {
    return { ok: false, code: 'text_required', error: `Text is required for ${action}.` };
  }
  const drag = action === 'drag' ? { x: input.dragDeltaX, y: input.dragDeltaY } : undefined;
  if (drag && (![drag.x, drag.y].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 4096)
      || (drag.x === 0 && drag.y === 0))) {
    return { ok: false, code: 'invalid_drag', error: 'Drag requires nonzero movement with drag_delta_x and drag_delta_y between -4096 and 4096 CSS pixels.' };
  }
  return {
    ok: true,
    ...(drag ? { drag: drag as { x: number; y: number } } : {}),
    contents,
    action,
    text,
    direction: directionRaw as 'up' | 'down' | 'top' | 'bottom' | 'left' | 'right',
    ...(ref ? { ref } : {}),
  };
}

interface WebAssistActionLifetime {
  signal?: AbortSignal;
  isActive?: () => boolean;
}

const WEB_ASSIST_FRAME_SCRIPT = 'new Promise(resolve => requestAnimationFrame(() => resolve(true)))';

async function webAssistFrameWithin(contents: WebContents, timeoutMs: number): Promise<boolean> {
  try {
    await withOperationTimeout(executeWebAssistScript(contents, WEB_ASSIST_FRAME_SCRIPT), {
      timeoutMs, code: 'frame_timeout', stage: 'browser frame',
    });
  } catch (error) {
    // Only a missing frame is evidence. A probe that cannot run leaves the
    // page to the input path, which reports it as before.
    if (error instanceof OperationTimeoutError) return false;
  }
  return true;
}

function tabOnScreen(record: WebAssistRecord, tab: WebAssistTabRecord): boolean {
  const owner = record.owner;
  return tab.view?.getVisible() === true && !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized();
}

async function actOnWebAssistTab(
  record: WebAssistRecord,
  tab: WebAssistTabRecord,
  input: {
    pageId?: unknown;
    elementRef?: unknown;
    point?: number[];
    action?: unknown;
    text?: unknown;
    direction?: unknown;
    dragDeltaX?: unknown;
    dragDeltaY?: unknown;
    filePaths?: unknown;
    values?: string[];
    keys?: string;
  },
  lifetime: WebAssistActionLifetime = {},
): Promise<Record<string, unknown>> {
  if (tab.inputBusy) return { ok: false, code: 'action_in_progress', error: 'An operation is already running on this page.' };
  const checked = checkWebAssistAction(tab, input);
  if (!checked.ok) return checked;
  const revision = tab.controlRevision || 0;
  let pointerDispatched = false;
  let uploadFiles: import('./web_assist_upload').WebAssistUploadFile[] | undefined;
  const context = tab.controlContext;
  const validate = (): Record<string, unknown> | null => {
    if (tab.userControlled) return userControlResult();
    if ((tab.controlRevision || 0) !== revision) return { ok: false, code: 'stale_page', error: 'User input changed this page; observe it again.' };
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
  const runAction = async (): Promise<Record<string, unknown>> => {
    const invalidBefore = validate();
    if (invalidBefore) return invalidBefore;
    const nativeDecision = tab.observation?.nativeDecision;
    if (nativeDecision) {
      if (!(checked.action === 'click' && input.elementRef === 'e1' || checked.action === 'press' && input.keys === 'Escape')) {
        return { ok: false, code: 'user_action_required', error: 'The user must complete this browser decision; Cancel remains available.' };
      }
      const handled = nativeDecision.kind === 'selection'
        ? cancelWebAssistNativeSelection(checked.contents, nativeDecision.id)
        : cancelModelWebAssistPasskey(checked.contents, nativeDecision.id);
      return handled ? { ok: true, outcome: 'acted', action: checked.action } : { ok: false, code: 'stale_page' };
    }
    const permissionId = tab.observation?.permissionId;
    if (permissionId) {
      const allowed = checked.action === 'click' && input.elementRef === 'e1';
      const denied = checked.action === 'click' && input.elementRef === 'e2' || checked.action === 'press' && input.keys === 'Escape';
      if (!allowed && !denied) return { ok: false, code: 'invalid_action', error: 'Permission requests accept Allow, Deny or Escape.' };
      return respondModelWebAssistPermission(checked.contents, permissionId, allowed);
    }
    const fileChooserId = tab.observation?.fileChooserId;
    if (fileChooserId) {
      const chooser = webAssistFileChooser(checked.contents);
      if (!chooser || chooser.id !== fileChooserId) return { ok: false, code: 'stale_page', error: 'The file selection changed; observe the page again.' };
      if ((checked.action === 'press' && input.keys === 'Escape') || (checked.action === 'click' && input.elementRef === 'e2')) {
        await cancelWebAssistFileChooser(checked.contents, chooser, validate);
        return { ok: true, outcome: 'acted', action: checked.action };
      }
      if (checked.action !== 'upload' || input.elementRef !== 'e1') return { ok: false, code: 'invalid_action', error: 'File selection accepts upload with authorized file_paths, or Escape to cancel.' };
      const count = await setWebAssistInputFiles(checked.contents, chooser, uploadFiles!.map(file => file.path), undefined, validate);
      clearWebAssistFileChooser(checked.contents);
      return { ok: true, outcome: 'acted', action: 'upload', file_count: count };
    }
    const dialogId = tab.observation?.dialogId;
    if (dialogId) return webAssistDialogs(checked.contents)!.act(dialogId, checked.action,
      typeof input.elementRef === 'string' ? input.elementRef : undefined, checked.text, input.keys);
    await applyDesktopViewport(tab);
    await refreshWebAssistFileChoosers(checked.contents);
    const invalid = validate();
    if (invalid) return invalid;
    const visual = tab.observation?.visual;
    let hitIdentity: number | undefined;
    const preparePoint = async () => {
      const result = await executeWebAssistScript(checked.contents,
        buildWebAssistPointScript(visual!, input.point!, hitIdentity)) as { pointer?: { identity?: number } };
      if (typeof result?.pointer?.identity === 'number') hitIdentity = result.pointer.identity;
      return webAssistPointPointer(checked.contents, result) as Promise<Record<string, unknown>>;
    };
    const prepare = input.point ? preparePoint : () => executeWebAssistScript(
      checked.contents,
      buildWebAssistActionScript({
        ...(checked.ref ? { ref: checked.ref } : {}),
        action: checked.action,
        ...(input.values ? { values: input.values } : {}),
        ...(typeof input.text === 'string' ? { text: checked.text } : {}),
        direction: checked.direction,
      }, tab.controlContext?.scope, { preparePointer: true }),
      true, tab.observation?.frameId,
    ).then(result => webAssistRootPointer(checked.contents, tab.observation?.frameId, result)) as Promise<Record<string, unknown>>;
    const result = await withAssistantAction(record, tab, 'acting', async () => {
      if (checked.action === 'upload') {
        const invalid = validate(); if (invalid) return invalid;
        const fileCount = await setWebAssistInputFiles(checked.contents, buildWebAssistActionScript({ action: 'upload', ref: checked.ref }, tab.controlContext?.scope), uploadFiles!.map(file => file.path), tab.observation?.frameId, validate);
        return { ok: true, outcome: 'acted', action: 'upload', file_count: fileCount };
      }
      if (checked.action === 'press') {
        if (checked.ref) { const focused = await prepare(); if (focused.ok === false) return focused; }
        const invalid = validate(); if (invalid) return invalid;
        return dispatchWebAssistKeys(checked.contents, input.keys || '', validate, () => { pointerDispatched = true; });
      }
      if (['click', 'check', 'uncheck', 'drag', 'hover', 'double_click', 'right_click'].includes(checked.action)) {
        const rendering = await wakeWebAssistRendering(checked.contents,
          timeoutMs => webAssistFrameWithin(checked.contents, timeoutMs),
          () => !tabOnScreen(record, tab) && validate() === null);
        // Waking did not make this off-screen page render. Refuse before any
        // input, so a retry after the user shows it cannot click twice. On
        // screen such a page is busy instead; the input path reports it as before.
        if (rendering === 'not_rendered' && !tabOnScreen(record, tab)) {
          log.warn('browser page is not rendering; pointer input withheld');
          return { ok: false, code: 'page_not_rendered',
            error: 'This page is not rendering while it is off screen, so the action was not sent. Ask the user to open this task and look at its browser once, then observe the page and retry.' };
        }
        const result = await dispatchWebAssistPointer(checked.contents, prepare, validate,
          () => checked.contents.getZoomFactor(),
          checked.drag, () => { pointerDispatched = true; }, checked.action);
        if (result.ok && ['check', 'uncheck'].includes(checked.action)) {
          const verified = await withOperationTimeout(prepare(), {
            timeoutMs: 2000, code: 'input_timeout', stage: 'browser control state',
          });
          if (verified.ok === false) return verified;
          if (verified.pointer) return { ok: false, code: 'action_no_effect', error: 'The control did not reach the requested state; observe the page again.' };
        }
        return result.ok ? { ...result, action: checked.action } : result;
      }
      const timeoutMs = checked.action === 'fill' && checked.text.length > 2000 ? 30_000 : 5000;
      return withOperationTimeout(prepare(), { timeoutMs, code: 'action_timeout', stage: 'browser action' });
    });
    return result && typeof result === 'object'
      ? result as Record<string, unknown>
      : { ok: false, code: 'action_failed', error: 'The page action failed.' };
  };
  tab.inputBusy = true;
  try {
    if (checked.action === 'upload') {
      const { loadWebAssistUploadFiles } = await import('./web_assist_upload');
      try {
        uploadFiles = await loadWebAssistUploadFiles(record.ownerUserId, tab.conversationId, input.filePaths, lifetime.signal);
      } catch {
        return { ok: false, code: 'upload_files_unavailable', error: 'Provide authorized files or a directory from the task workspace or attachments.' };
      }
    }
    const publicResult = await runAction();
    if (publicResult.ok === false && publicResult.code === 'user_action_required') surfaceAppWindow();
    if (tab.observation) tab.observation.visual = undefined;
    if (publicResult.ok === true) {
      if (['fill', 'select', 'check', 'uncheck', 'drag', 'upload'].includes(checked.action)) tab.edited = true;
      if (['click', 'press', 'drag', 'double_click', 'right_click', 'hover'].includes(checked.action)) invalidateObservation(tab);
    }
    const interaction = publicResult.ok === true && !(checked.action === 'fill' && tab.observation?.dialogId)
      ? observeWebAssistInteraction(tab) : undefined;
    return { ...(interaction ? { ...interaction, outcome: interaction.dialog_type === 'file_chooser' ? 'file_chooser_pending' : 'dialog_pending' } : publicResult),
      ...takeWebAssistFilePickerNotice(checked.contents) };
  } catch (error) {
    if (error instanceof WebAssistDialogOpenedError) {
      const dialog = observeWebAssistInteraction(tab);
      if (dialog) return { ...dialog, outcome: 'dialog_pending' };
    }
    if (error instanceof Error && error.message === 'browser_directory_page_hidden') {
      invalidateObservation(tab);
      return { ok: false, code: 'page_not_visible', error: 'Chromium requires a visible active tab for directory selection. Open this task’s Browser tab, observe it and retry.' };
    }
    if (error instanceof Error && error.message === 'browser_upload_cancelled') {
      invalidateObservation(tab);
      return { ok: false, code: 'upload_cancelled', error: 'Chromium cancelled file selection; observe the control before trying again.' };
    }
    log.warn('page action failed', { error: logErrorRef(error) });
    invalidateObservation(tab);
    return { ok: false, code: 'action_failed', error: 'The page action failed; observe it before deciding what to do next.' };
  } finally {
    // Even a cancelled pointer or a hover can change the page. Do not reuse
    // references from before an attempted action, or replay uncertain input.
    if (pointerDispatched && !tab.observation?.dialogId && !tab.observation?.fileChooserId && !tab.observation?.permissionId && !tab.observation?.nativeDecision && !['check', 'uncheck'].includes(checked.action)) invalidateObservation(tab);
    tab.inputBusy = false;
  }
}

export async function actOnControlledWebAssist(
  userId: string,
  conversationId: string,
  scopeId: string,
  input: {
    pageId?: unknown;
    elementRef?: unknown;
    point?: number[];
    action?: unknown;
    text?: unknown;
    direction?: unknown;
    dragDeltaX?: unknown;
    dragDeltaY?: unknown;
    filePaths?: unknown;
    values?: string[];
    keys?: string;
  },
  lifetime: WebAssistActionLifetime = {},
): Promise<Record<string, unknown>> {
  if (lifetime.signal?.aborted || lifetime.isActive?.() === false) {
    return { ok: false, code: 'task_run_ended', error: 'This browser task turn has ended.' };
  }
  const resolved = controlledRecord(userId, conversationId, scopeId);
  if (!('record' in resolved)) return { ok: false, code: resolved.code, error: resolved.error };
  if (!PAGE_ACTIONS.has(String(input.action || '') as WebAssistPageAction)) return { ok: false, code: 'invalid_action', error: 'Unsupported Web Assist page action.' };
  ensureTabLoaded(resolved.record, resolved.tab);
  return actOnWebAssistTab(resolved.record, resolved.tab, input, lifetime);
}

export async function navigateControlledWebAssist(
  userId: string,
  conversationId: string,
  scopeId: string,
  action: unknown,
  lifetime: WebAssistActionLifetime = {},
): Promise<Record<string, unknown>> {
  if (lifetime.signal?.aborted || lifetime.isActive?.() === false) {
    return { ok: false, code: 'task_run_ended', error: 'This browser task turn has ended.' };
  }
  const resolved = controlledRecord(userId, conversationId, scopeId);
  if (!('record' in resolved)) return { ok: false, code: resolved.code, error: resolved.error };
  const { record, tab } = resolved;
  if (tab.userControlled) return userControlResult();
  if (action === 'close') {
    removeTab(record, tab, true, true);
    return { ok: true, action: 'close', closed: true, tab_id: tab.id };
  }
  const navigation = navigateTabHistory(record, tab, action, true);
  if (navigation.ok === false) return navigation;
  return { ok: true, action, state: tabSnapshot(tab) };
}

function pageLoadWaitFailure(tab: WebAssistTabRecord): Record<string, unknown> | undefined {
  if (tab.errorCode !== 'page_load_failed') return undefined;
  return { ok: false, code: 'page_load_failed', error: 'The page failed to load.' };
}

function waitPageIsCurrent(
  tab: WebAssistTabRecord, contents: WebContents,
  navigationRevision: number, controlRevision: number,
): boolean {
  return tab.view?.webContents === contents && !contents.isDestroyed()
    && (tab.navigationRevision || 0) === navigationRevision
    && (tab.controlRevision || 0) === controlRevision
    && !tab.userControlled && !tab.loading && !contents.isLoading();
}

export async function waitForControlledWebAssist(
  userId: string,
  conversationId: string,
  scopeId: string,
  input: { condition?: unknown; text?: unknown; timeoutMs?: unknown },
  lifetime: WebAssistActionLifetime = {},
): Promise<Record<string, unknown>> {
  const ended = () => lifetime.signal?.aborted || lifetime.isActive?.() === false;
  const endedResult = { ok: false, code: 'task_run_ended', error: 'This browser task turn has ended.' };
  if (ended()) return endedResult;
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
    : initial.tab.userControlled ? Math.max(8_000, WEB_ASSIST_USER_IDLE_MS + 1000) : 8_000;
  const started = Date.now();
  return withAssistantAction(initial.record, initial.tab, 'waiting', async () => {
    while (Date.now() - started < timeoutMs) {
      if (ended()) return endedResult;
      const current = controlledRecord(userId, conversationId, scopeId, initial.tab.id);
      if (!('record' in current)) return { ok: false, code: current.code, error: current.error };
      const loadFailure = pageLoadWaitFailure(current.tab);
      if (loadFailure) return loadFailure;
      const dialog = observeWebAssistInteraction(current.tab);
      if (dialog) return { ...dialog, condition, condition_matched: false };
      const contents = current.tab.view.webContents;
      const navigationRevision = current.tab.navigationRevision || 0;
      const controlRevision = current.tab.controlRevision || 0;
      let matched = false;
      try {
        if (condition === 'loaded') {
          matched = !current.tab.userControlled && !current.tab.loading && !contents.isLoading();
        } else if (!current.tab.userControlled && !current.tab.loading && !contents.isLoading()) {
          matched = await readWebAssistTextCondition(contents, expectedText, started + timeoutMs, lifetime) === true;
        }
      } catch {
        matched = false;
      }
      // Native reads cannot be cancelled; discard their late readiness result.
      if (ended()) return endedResult;
      const latest = controlledRecord(userId, conversationId, scopeId, initial.tab.id);
      if (latest.ok === false) return latest;
      const lateLoadFailure = pageLoadWaitFailure(latest.tab);
      if (lateLoadFailure) return lateLoadFailure;
      const interaction = observeWebAssistInteraction(latest.tab);
      if (interaction) return { ...interaction, condition, condition_matched: false };
      if (matched && Date.now() - started < timeoutMs
        && latest.tab === current.tab && waitPageIsCurrent(latest.tab, contents, navigationRevision, controlRevision)) {
        return { ok: true, condition, elapsed_ms: Math.max(0, Date.now() - started) };
      }
      const remaining = started + timeoutMs - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200, remaining)));
    }
    if (ended()) return endedResult;
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
  input: { url?: unknown; label?: unknown; retention?: unknown },
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
  const retention = input.retention;
  if (retention !== undefined && retention !== 'deliverable' && retention !== 'handoff' && retention !== 'temporary') {
    return { ok: false, code: 'invalid_retention', error: 'Retention must be deliverable, handoff or temporary.' };
  }
  const runId = retention === undefined ? undefined : browserTaskRunId(userId, conversationId);
  if (retention !== undefined && !runId) {
    return { ok: false, code: 'no_active_run', error: 'Retention marks require an active task turn.' };
  }
  // Judge link-derivation against what the model was holding, before opening
  // the tab changes it.
  const fromLink = wasObservedLink(userId, conversationId, url);
  const opened = await openWebAssist(userId, sender, {
    url,
    label: input.label,
    conversationId,
  }, 'model', retention !== undefined && runId ? { runId, retention: retention as BrowserTabRetention } : undefined);
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
  if (resolved.tab.userControlled) return userControlResult();
  if (resolved.tab.inputBusy) return { ok: false, code: 'action_in_progress', error: 'An operation is already running on this page.' };
  const action = String(input.action || '').trim();
  if (!['goto', 'back', 'forward', 'reload'].includes(action)) {
    return { ok: false, code: 'invalid_action', error: 'Navigation must be goto, back, forward, or reload.' };
  }
  if (webAssistDialogs(resolved.tab.view?.webContents)?.pending()) return { ok: false, code: 'dialog_pending', error: 'Answer the current dialog before navigating.' };
  if (action === 'goto') {
    const url = safeWebAssistUrl(input.url);
    if (!url) return { ok: false, code: 'invalid_url', error: 'goto requires an absolute HTTP or HTTPS URL.' };
    // Read link-derivation from the observation still in hand; navigating
    // replaces it.
    const fromLink = wasObservedLink(userId, conversationId, url);
    const navigated = await navigateWebAssistTo(
      resolved.sender, { tabId: resolved.tab.id, url }, taskIsForeground(resolved.sender, conversationId), true,
    );
    if (!navigated.ok) return navigated;
    recordModelNavigation(userId, conversationId, resolved.tab.id, url, 'goto', fromLink);
  } else {
    const navigation = navigateTabHistory(resolved.record, resolved.tab, action, true);
    if (navigation.ok === false) return navigation;
  }
  const current = taskTab(userId, conversationId, resolved.tab.id);
  if (!current.ok) return current;
  // A successful explicit navigation selects a broader browsing context;
  // connector_setup must not inherit that destination. Rejected calls above
  // leave the original setup binding intact.
  current.tab.controlContext = undefined;
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
    point?: number[];
    action?: unknown;
    text?: unknown;
    direction?: unknown;
    dragDeltaX?: unknown;
    dragDeltaY?: unknown;
    filePaths?: unknown;
    values?: string[];
    keys?: string;
  },
  lifetime: WebAssistActionLifetime = {},
): Promise<Record<string, unknown>> {
  const resolved = taskTab(userId, conversationId, input.tabId);
  if (!resolved.ok) return resolved;
  // Reject competing input before exposure can replace the running action's authority.
  if (resolved.tab.inputBusy) return { ok: false, code: 'action_in_progress', error: 'An operation is already running on this page.' };
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
  lifetime: WebAssistActionLifetime = {},
): Promise<Record<string, unknown>> {
  const ended = () => lifetime.signal?.aborted || lifetime.isActive?.() === false;
  const endedResult = { ok: false, code: 'task_run_ended', error: 'This browser task turn has ended.' };
  if (ended()) return endedResult;
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
    : initial.tab.userControlled ? Math.max(8_000, WEB_ASSIST_USER_IDLE_MS + 1000) : 8_000;
  const exposed = exposeTaskTabToModel(initial);
  if (!exposed.ok) return exposed;
  const started = Date.now();
  return withAssistantAction(initial.record, initial.tab, 'waiting', async () => {
    while (Date.now() - started < timeoutMs) {
      if (ended()) return endedResult;
      const current = taskTab(userId, conversationId, initial.tab.id);
      if (!current.ok) return current;
      const loadFailure = pageLoadWaitFailure(current.tab);
      if (loadFailure) return loadFailure;
      const dialog = observeWebAssistInteraction(current.tab);
      if (dialog) return { ...dialog, condition, condition_matched: false };
      const contents = current.tab.view.webContents;
      const navigationRevision = current.tab.navigationRevision || 0;
      const controlRevision = current.tab.controlRevision || 0;
      let matched = false;
      try {
        if (condition === 'loaded') {
          matched = !current.tab.userControlled && !current.tab.loading && !contents.isLoading();
        } else if (!current.tab.userControlled && !current.tab.loading && !contents.isLoading()) {
          matched = await readWebAssistTextCondition(contents, expectedText, started + timeoutMs, lifetime) === true;
        }
      } catch {
        matched = false;
      }
      // Native reads cannot be cancelled; discard their late readiness result.
      if (ended()) return endedResult;
      const latest = taskTab(userId, conversationId, initial.tab.id);
      if (!latest.ok) return latest;
      const lateLoadFailure = pageLoadWaitFailure(latest.tab);
      if (lateLoadFailure) return lateLoadFailure;
      const interaction = observeWebAssistInteraction(latest.tab);
      if (interaction) return { ...interaction, condition, condition_matched: false };
      if (matched && Date.now() - started < timeoutMs
        && latest.tab === current.tab && waitPageIsCurrent(latest.tab, contents, navigationRevision, controlRevision)) {
        return { ok: true, tab_id: current.tab.id, condition, elapsed_ms: Math.max(0, Date.now() - started) };
      }
      const remaining = started + timeoutMs - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200, remaining)));
    }
    if (ended()) return endedResult;
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
  if (resolved.tab.userControlled) return userControlResult();
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
  if (resolved.tab.userControlled) return userControlResult();
  const closedTabId = resolved.tab.id;
  removeTab(resolved.record, resolved.tab, true, true);
  return { ok: true, closed: true, tab_id: closedTabId };
}

/** Kept for native/CLI input compatibility; AI never opens a human file picker. */
export async function chooseModelWebAssistFiles(_uid: string, _cid: string, _directory: boolean, lifetime: WebAssistActionLifetime = {}): Promise<Record<string, unknown>> {
  if (lifetime.signal?.aborted || lifetime.isActive?.() === false) return { ok: false, code: 'task_run_ended' };
  return { ok: false, code: 'file_paths_required', error: 'Provide authorized absolute file_paths to an upload action. Use files in this task workspace or attachments; ask the user to attach external files when needed.' };
}

/** Trusted chrome handback never restarts a task or replays a dispatched input. */
export function handBackWebAssist(sender: WebContents, tabId: unknown): Record<string, unknown> {
  const record = recordForSender(sender);
  const tab = record && record.tabs.get(String(tabId || ''));
  if (!record || !tab || tab.conversationId !== activeConversationBySender.get(sender)) return { ok: false, code: 'unknown_tab' };
  if (tab.userActivity?.handback() === false) return { ok: false, code: 'input_held' };
  takePageControl(record, tab, false);
  return { ok: true, tab_id: tab.id };
}

/** Model-visible screenshot with structural secret fields masked in host pixels. */
export async function screenshotModelWebAssist(
  uid: string, cid: string, input: { tabId?: string; frameId?: string; clip?: number[] }, lifetime: WebAssistActionLifetime = {},
): Promise<ToolResult> {
  const fail = (code: string, error?: string): ToolResult => ({ content: JSON.stringify({ ok: false, code, ...(error ? { error } : {}) }), isError: true });
  const resolved = taskTab(uid, cid, input.tabId);
  if (resolved.ok === false) return fail(resolved.code);
  const { record, tab } = resolved;
  const exposed = exposeTaskTabToModel(resolved);
  if (exposed.ok === false) return fail(exposed.code);
  if (tab.inputBusy || tab.userControlled) return fail('page_busy');
  const dialog = observeWebAssistInteraction(tab);
  if (dialog) return { content: JSON.stringify(dialog) };
  const contents = tab.view!.webContents;
  const url = contents.getURL();
  const revision = tab.controlRevision || 0;
  const current = () => !lifetime.signal?.aborted && lifetime.isActive?.() !== false
    && record.tabs.get(tab.id) === tab && tab.view?.webContents === contents
    && !contents.isDestroyed() && contents.getURL() === url && (tab.controlRevision || 0) === revision;
  tab.inputBusy = true;
  let stage = 'frames';
  try {
    return await withAssistantAction(record, tab, 'observing', async () => {
      await applyDesktopViewport(tab);
      let frames = await webAssistFrames(contents);
      if (input.frameId && !frames.some(frame => frame.id === input.frameId)) return fail('unknown_frame');
      const rectangles: Array<{ x: number; y: number; width: number; height: number }> = [];
      const readMasks = async () => {
        frames = await webAssistFrames(contents);
        for (const frame of frames) {
          const rects = await webAssistEvaluate(contents, WEB_ASSIST_SECRET_RECTS_SCRIPT, frame.id, true, false, frames);
          if (!rects?.length) continue;
          const project = async (x: number, y: number) => (await webAssistRootPointer(contents, frame.id, { pointer: { x, y } }, false, frames)).pointer;
          const origin = await project(0, 0), axisX = await project(1, 0), axisY = await project(0, 1);
          for (const rect of rects) {
            const points = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height]]
              .map(([x, y]) => ({ x: origin.x + x * (axisX.x - origin.x) + y * (axisY.x - origin.x), y: origin.y + x * (axisX.y - origin.y) + y * (axisY.y - origin.y) }));
            const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
            rectangles.push({ x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y });
          }
        }
      };
      stage = 'render';
      const rendering = await wakeWebAssistRendering(contents, timeout => webAssistFrameWithin(contents, timeout), current);
      if (rendering === 'not_rendered' || !current()) return fail('page_not_rendered');
      stage = 'mask';
      await readMasks();
      const viewport: WebAssistVisualStamp = await webAssistEvaluate(contents, webAssistVisualStampScript);
      const clip = input.clip;
      if (clip && (!Array.isArray(clip) || clip.length !== 4 || !clip.every(Number.isFinite)
        || clip[0] < 0 || clip[1] < 0 || clip[2] <= 0 || clip[3] <= 0
        || clip[0] + clip[2] > viewport.width || clip[1] + clip[3] > viewport.height)) return fail('invalid_clip', `clip [x,y,width,height] needs positive dimensions inside ${viewport.width} by ${viewport.height} CSS pixels.`);
      stage = 'capture';
      const bitmap = await withOperationTimeout(contents.capturePage(undefined, { stayHidden: true }), {
        timeoutMs: 5000, code: 'screenshot_timeout', stage: 'browser screenshot',
      });
      if (bitmap.isEmpty()) return fail('page_changed');
      const bytes = bitmap.toPNG();
      await readMasks();
      const after: WebAssistVisualStamp = await webAssistEvaluate(contents, webAssistVisualStampScript);
      if (!current() || JSON.stringify(after) !== JSON.stringify(viewport)) return fail('page_changed');
      stage = 'encode';
      const metadata = await imageMetadata(bytes);
      const width = metadata.width!, height = metadata.height!;
      let capturedClip = [0, 0, viewport.width, viewport.height];
      const sx = width / viewport.width, sy = height / viewport.height;
      const mask = rectangles.map(rect => `<rect x="${rect.x * sx - 2}" y="${rect.y * sy - 2}" width="${Math.max(0, rect.width * sx + 4)}" height="${Math.max(0, rect.height * sy + 4)}" fill="black"/>`).join('');
      // Mask at capture resolution before resizing, so the SVG and pixels use
      // the same coordinates even on a high-DPI display.
      const { data: masked } = await encodeImage(bytes, {
        format: 'png', composite: [{ input: Buffer.from(`<svg width="${width}" height="${height}">${mask}</svg>`) }],
      });
      let pixels = masked;
      if (clip) {
        const left = Math.floor(clip[0] * sx), top = Math.floor(clip[1] * sy);
        const right = Math.min(width, Math.ceil((clip[0] + clip[2]) * sx));
        const bottom = Math.min(height, Math.ceil((clip[1] + clip[3]) * sy));
        capturedClip = [left / sx, top / sy, (right - left) / sx, (bottom - top) / sy];
        // Materialize extraction before resize to retain available native detail.
        ({ data: pixels } = await encodeImage(pixels, {
          format: 'png', extract: { left, top, width: right - left, height: bottom - top },
        }));
      }
      const { data: image, info } = await encodeImage(pixels, {
        format: 'png', resize: { width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true },
      });
      if (!current() || JSON.stringify(await webAssistEvaluate(contents, webAssistVisualStampScript)) !== JSON.stringify(viewport)) return fail('page_changed');
      const interaction = observeWebAssistInteraction(tab);
      if (interaction) return { content: JSON.stringify(interaction) };
      const observation = tab.observation?.url === url ? tab.observation : {
        pageId: genId12(), url, refs: new Map<string, WebAssistStoredElementRef>(), hrefs: new Set<string>(),
      };
      observation.visual = { ...viewport, pageId: genId12() };
      tab.observation = observation;
      return { content: JSON.stringify({ ok: true, tab_id: tab.id, page_id: observation.visual.pageId,
        viewport: { width: viewport.width, height: viewport.height }, clip: capturedClip, width: info.width, height: info.height, sensitive_fields_masked: true, untrusted_content: true }),
        images: [{ data: image.toString('base64'), mediaType: 'image/png' }] };
    });
  } catch (error) {
    if (current()) {
      const interaction = observeWebAssistInteraction(tab);
      if (interaction) return { content: JSON.stringify(interaction) };
    }
    log.warn('browser screenshot failed', { stage, error: logErrorRef(error) }); return fail('screenshot_failed');
  }
  finally { tab.inputBusy = false; }
}

const WEB_ASSIST_SECRET_RECTS_SCRIPT = String.raw`(() => {
  const rects = [];
  const visit = root => {
    for (const element of root.querySelectorAll('*')) {
      const type = String(element.type || '').toLowerCase();
      const tokens = String(element.autocomplete || element.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
      if (type === 'password' || tokens.some(token => ['current-password', 'new-password', 'one-time-code'].includes(token) || token.startsWith('cc-'))) {
        const rect = element.getBoundingClientRect();
        if (rect.width && rect.height) rects.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document); return rects;
})()`;

/** Trusted application layer state. Remote task pages cannot call this boundary. */
export function setWebAssistOverlayState(
  sender: WebContents, input: { blocked?: unknown; revision?: unknown; epoch?: unknown },
): { ok: true; blocked: boolean; revision: number } | { ok: false; code: string } {
  const record = recordForSender(sender);
  if (!record) return { ok: false, code: 'not_open' };
  if (input?.epoch !== record.overlayEpoch) return { ok: false, code: 'stale_layer_document' };
  if (typeof input?.blocked !== 'boolean' || !Number.isSafeInteger(input?.revision)
    || Number(input.revision) < 0) return { ok: false, code: 'invalid_layer_state' };
  const revision = Number(input.revision);
  if (revision > record.overlayRevision) {
    const wasBlocked = record.overlayBlocked;
    record.overlayRevision = revision;
    record.overlayBlocked = input.blocked;
    for (const tab of record.tabs.values()) {
      tab.presentationSuppressed = input.blocked;
      // Release permits a fresh renderer layout; it never resurrects a page
      // whose task or drawer may have changed while the floating UI was open.
      if (input.blocked || wasBlocked) tab.view?.setVisible(false);
    }
  }
  return { ok: true, blocked: record.overlayBlocked, revision: record.overlayRevision };
}

export function layoutWebAssist(
  sender: WebContents,
  rawBounds: unknown,
): { ok: true; state: WebAssistSnapshot } | { ok: false; code: string; error: string } {
  const record = recordForSender(sender);
  if (!record) return { ok: false, code: 'not_open', error: 'Web Assist is not open.' };
  const epoch = (rawBounds as { overlayEpoch?: unknown } | null)?.overlayEpoch;
  if (epoch !== undefined && epoch !== record.overlayEpoch) return { ok: true, state: rendererSnapshot(record) };
  const revision = (rawBounds as { overlayRevision?: unknown } | null)?.overlayRevision;
  if (revision !== undefined) {
    if (!Number.isSafeInteger(revision) || Number(revision) < 0) return { ok: false, code: 'invalid_bounds', error: 'Web Assist could not be positioned.' };
    if (Number(revision) < record.overlayRevision) return { ok: true, state: rendererSnapshot(record) };
  }
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
  if (tab.userActivity?.pointerHeld()) {
    tab.pendingBounds = bounds;
    return { ok: true, state: rendererSnapshot(record) };
  }
  clearDeferredWebAssistBounds(tab);
  tab.view.setBounds(bounds);
  tab.bounds = bounds;
  setTabVisible(tab, true);
  revealDeferredAuthorizationPopups(record, tab);
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
  browserOpenGenerations.set(sender, (browserOpenGenerations.get(sender) || 0) + 1);
  const record = recordForSender(sender);
  if (!record) return { ok: true, closed: false };
  closeRecord(record, true);
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
  accountGeneration++;
  for (const record of [...records.values()]) {
    if (record.ownerUserId === previousUid) closeRecord(record, true);
  }
  for (const [key, binding] of conversationBindings) {
    if (binding.userId === previousUid) conversationBindings.delete(key);
  }
});

export function resetWebAssistPermissions(sender: WebContents, tabId: unknown): Record<string, unknown> {
  const record = recordForSender(sender);
  const tab = record && record.tabs.get(String(tabId || ''));
  if (!tab?.view || tab.conversationId !== activeConversationBySender.get(sender)) return { ok: false, code: 'unknown_tab' };
  return { ok: resetWebAssistSitePermissions(tab.view.webContents) };
}

/** A page has no application IPC; only the selected task's trusted chrome may reply. */
export function answerWebAssistPermission(sender: WebContents, input: { tabId?: unknown; requestId?: unknown; allowed?: unknown }): { handled: boolean } {
  const owner = BrowserWindow.fromWebContents(sender);
  const record = owner && records.get(owner.id);
  const tab = typeof input.tabId === 'string' ? record?.tabs.get(input.tabId) : undefined;
  if (!record || record.owner.webContents !== sender || record.activeTabId !== tab?.id
    || activeConversationBySender.get(sender) !== tab?.conversationId || !tab?.view) return { handled: false };
  return { handled: respondWebAssistPermission(tab.view.webContents, input.requestId, input.allowed) };
}
