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

import {
  app,
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
import { genId12, safeId } from '../storage';
import { createLogger } from '../logger';
import { logErrorRef } from '../util/log-redact';
import { prepareBrowserProxy } from '../util/browser-proxy';
import { withOperationTimeout } from '../util/operation-timeout';
import { prepareWebAssistSession } from './web_assist_session';
import { reportWebAssistFailure } from './web_assist_diagnostics';
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
  type WebAssistPageAction,
  type WebAssistStoredElementRef,
} from './web_assist_page';

const log = createLogger('web-assist');
const MAX_LABEL_LENGTH = 120;
const MAX_SEARCH_INPUT_LENGTH = 2048;
const MAX_TABS_PER_CONVERSATION = 10;
const IDLE_PAGE_TIMEOUT_MS = 10 * 60_000;
const IDLE_PAGE_SCAN_MS = 30_000;
const MIN_VIEW_EDGE = 80;
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
}

interface WebAssistTabRecord {
  id: string;
  lifetime: BrowserTabLifetime;
  conversationId: string;
  view?: WebContentsView;
  visible: boolean;
  bounds?: Rectangle;
  virtualViewport?: boolean;
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

function chromeLikeUserAgent(): string {
  const base = String(app.userAgentFallback || '');
  if (!base) return '';
  const appName = String(app.getName() || '');
  let value = base.replace(/\sElectron\/\S+/iu, '');
  if (appName) {
    const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(new RegExp(`\\s${escaped}\\/\\S+`, 'iu'), '');
  }
  return value.replace(/\s{2,}/g, ' ').trim();
}

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
  ses.on('will-download', (event, _item, webContents) => {
    event.preventDefault();
    for (const record of records.values()) {
      for (const tab of record.tabs.values()) {
        if (tab.view?.webContents !== webContents || tab.view.webContents.isDestroyed()) continue;
        tab.errorCode = 'download_blocked';
        emit(record);
        return;
      }
    }
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
      return { ...tab, address_url: rawUrl === 'about:blank' ? rawUrl : safeWebAssistUrl(rawUrl) || '' };
    }),
  };
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
  if (visible && tab.virtualViewport && tab.view && !tab.view.webContents.isDestroyed()) {
    tab.view.webContents.disableDeviceEmulation();
    tab.virtualViewport = false;
  }
  tab.visible = visible;
  tab.view?.setVisible(visible);
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
    reportWebAssistFailure(record.owner.webContents, 'view_unavailable');
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
  const senderObject = sender as unknown as object;
  activeConversationBySender.set(senderObject, conversationId);
  if (!boundSenders.has(senderObject)) {
    boundSenders.add(senderObject);
    const eventSender = sender as WebContents & { once?: (event: string, listener: () => void) => void };
    eventSender.once?.('destroyed', () => {
      for (const [bindingKey, binding] of conversationBindings) {
        if (binding.sender === sender) conversationBindings.delete(bindingKey);
      }
    });
  }
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

function controlledRecord(
  userId: string,
  conversationId: string,
  scopeId: string,
): { ok: true; record: WebAssistRecord; tab: WebAssistTabRecord } | { ok: false; code: string; error: string } {
  const sender = boundSender(userId, conversationId);
  if (!sender) {
    return { ok: false, code: 'window_unavailable', error: 'Open this conversation in Orkas to use Web Assist.' };
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
    return { ok: false, code: 'window_unavailable', error: 'Open this task in Orkas to use its browser.' };
  }
  if (activeConversationBySender.get(sender as unknown as object) !== conversationId) {
    return { ok: false, code: 'task_not_visible', error: 'Switch to this task in Orkas before using its browser.' };
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
  record.activeTabId = tab.id;
  for (const candidate of record.tabs.values()) {
    if (candidate !== tab) setTabVisible(candidate, false);
  }
  // A generic browser operation supersedes connector-specific authority on
  // this tab. This prevents connector_setup from inheriting an arbitrary URL
  // or page state selected through the broader browser contract.
  tab.controlContext = {
    userId: record.ownerUserId,
    conversationId: tab.conversationId,
    scope: 'browser',
    scopeId: tab.id,
  };
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
  reportWebAssistFailure(record.owner.webContents, 'page_load_failed', netCode);
  emit(record);
}

function configureWebAssistPopup(popup: BrowserWindow, proxy: ReturnType<typeof prepareBrowserProxy>): void {
  const contents = popup.webContents;
  proxy.attach(contents);
  const userAgent = chromeLikeUserAgent();
  if (userAgent) contents.setUserAgent(userAgent);
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
  const userAgent = chromeLikeUserAgent();
  if (userAgent) contents.setUserAgent(userAgent);
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
        show: true,
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
    reportWebAssistFailure(record.owner.webContents, 'page_unresponsive');
    emit(record);
  });
  contents.on('render-process-gone', (_event, details) => {
    if (tab.view !== view) return;
    tab.loading = false;
    tab.errorCode = 'page_load_failed';
    if (details?.reason !== 'clean-exit') reportWebAssistFailure(record.owner.webContents, 'renderer_gone');
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
    && !tab.loading && !tab.assistantAction
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
): Promise<{ ok: true; state: WebAssistSnapshot; closed_tab_ids: string[] } | { ok: false; code: string; error: string }> {
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
      reportWebAssistFailure(sender, 'view_unavailable');
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
      const created = createTabWithinLimit(record, conversationId, safeLabel(input?.label), createdBy);
      if (!created) return tabLimitFailure();
      tab = created.tab;
      closedTabIds = created.closedTabIds;
    } catch (error) {
      reportWebAssistFailure(sender, 'view_unavailable');
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
  tab.loading = true;
  record.activeTabId = tab.id;
  for (const candidate of record.tabs.values()) {
    if (candidate !== tab) setTabVisible(candidate, false);
  }
  emit(record);
  tab.view.webContents.loadURL(url).catch(() => undefined);
  return { ok: true, state: rendererSnapshot(record), closed_tab_ids: closedTabIds };
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
      reportWebAssistFailure(sender, 'view_unavailable');
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
    reportWebAssistFailure(sender, 'view_unavailable');
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
  record.activeTabId = tab.id;
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
    return { ok: false, code: 'window_unavailable', error: 'Open this conversation in Orkas to use Web Assist.' };
  }
  const opened = await openWebAssist(userId, sender, {
    url: input.url,
    label: input.label,
    conversationId,
  }, 'model');
  if (!opened.ok) return opened;
  const record = recordForSender(sender);
  const tab = record ? activeTab(record) : null;
  if (!record || !tab) {
    return { ok: false, code: 'view_unavailable', error: 'Web Assist could not be controlled.' };
  }
  tab.controlContext = {
    userId,
    conversationId,
    scope: input.scope,
    scopeId: input.scopeId,
  };
  invalidateObservation(tab);
  const state = snapshot(record);
  try {
    sender.send('web-assist:show', rendererSnapshot(record));
  } catch (error) {
    log.warn('controlled view show failed', { error: logErrorRef(error) });
    closeRecord(record, true);
    return { ok: false, code: 'renderer_unavailable', error: 'Web Assist could not be shown.' };
  }
  return { ok: true, state };
}

async function observeWebAssistTab(
  record: WebAssistRecord,
  tab: WebAssistTabRecord,
): Promise<Record<string, unknown>> {
  if (!ensureTabLoaded(record, tab)) return { ok: false, code: 'page_loading', error: 'The page is being restored; wait before observing it.' };
  const contents = tab.view.webContents;
  if (tab.loading || contents.isLoading()) {
    return { ok: false, code: 'page_loading', error: 'The page is still loading; wait before observing it.' };
  }
  const currentUrl = safeWebAssistUrl(contents.getURL());
  if (!currentUrl) return { ok: false, code: 'page_unavailable', error: 'There is no controllable web page.' };
  try {
    // On macOS a recreated hidden view can have a zero-width Chromium viewport.
    // Initialize desktop layout only after loading (before that this native API
    // has no RenderViewHost), and remove the override when the user shows it.
    if (!tab.visible && !tab.virtualViewport) {
      const { width, height } = tab.bounds || { width: 800, height: 600 };
      contents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width, height },
        viewPosition: { x: 0, y: 0 }, viewSize: { width, height }, deviceScaleFactor: 0, scale: 1 });
      tab.virtualViewport = true;
    }
    const raw = await withAssistantAction(record, tab, 'observing', () => (
      executeWebAssistScript(contents, webAssistObserveScript(tab.controlContext?.scope))
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
    tab.observation = { pageId, url: currentUrl, refs: sanitized.refs };
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
): Promise<Record<string, unknown>> {
  const checked = checkWebAssistAction(tab, input);
  if (!checked.ok) return checked;
  try {
    const result = await withAssistantAction(record, tab, 'acting', () => executeWebAssistScript(
      checked.contents,
      buildWebAssistActionScript({
        ...(checked.ref ? { ref: checked.ref } : {}),
        action: checked.action,
        ...(typeof input.text === 'string' ? { text: checked.text } : {}),
        direction: checked.direction,
      }, tab.controlContext?.scope),
      true,
    ));
    const publicResult = result && typeof result === 'object'
      ? result as Record<string, unknown>
      : { ok: false, code: 'action_failed', error: 'The page action failed.' };
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
    return { ok: false, code: 'window_unavailable', error: 'Open this task in Orkas to use its browser.' };
  }
  if (activeConversationBySender.get(sender as unknown as object) !== conversationId) {
    return { ok: false, code: 'task_not_visible', error: 'Switch to this task in Orkas before using its browser.' };
  }
  const record = recordForSender(sender);
  if (!record) return { ok: true, active_tab_id: null, tabs: [], tab_limit: MAX_TABS_PER_CONVERSATION };
  const tabs = [...record.tabs.values()]
    .filter((tab) => tab.conversationId === conversationId)
    .map(tabSnapshot);
  const active = tabs.find((tab) => tab.tab_id === record.activeTabId) || tabs[0] || null;
  return { ok: true, active_tab_id: active?.tab_id || null, tabs, tab_limit: MAX_TABS_PER_CONVERSATION };
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
    return { ok: false, code: 'window_unavailable', error: 'Open this task in Orkas to use its browser.' };
  }
  if (activeConversationBySender.get(sender as unknown as object) !== conversationId) {
    return { ok: false, code: 'task_not_visible', error: 'Switch to this task in Orkas before using its browser.' };
  }
  const url = safeWebAssistUrl(input.url);
  if (!url) return { ok: false, code: 'invalid_url', error: 'Open an absolute HTTP or HTTPS URL.' };
  const opened = await openWebAssist(userId, sender, {
    url,
    label: input.label,
    conversationId,
  }, 'model');
  if (!opened.ok) return opened;
  const resolved = taskTab(userId, conversationId, opened.state.active_tab_id);
  if (!resolved.ok) return resolved;
  const exposed = exposeTaskTabToModel(resolved);
  if (!exposed.ok) return exposed;
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
    const navigated = await navigateWebAssistTo(resolved.sender, { tabId: resolved.tab.id, url });
    if (!navigated.ok) return navigated;
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
): Promise<Record<string, unknown>> {
  const resolved = taskTab(userId, conversationId, tabId);
  if (!resolved.ok) return resolved;
  const exposed = exposeTaskTabToModel(resolved);
  if (!exposed.ok) return exposed;
  return observeWebAssistTab(resolved.record, resolved.tab);
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
): Promise<Record<string, unknown>> {
  const resolved = taskTab(userId, conversationId, input.tabId);
  if (!resolved.ok) return resolved;
  if (!PAGE_ACTIONS.has(String(input.action || '') as WebAssistPageAction)) return { ok: false, code: 'invalid_action', error: 'Unsupported Web Assist page action.' };
  ensureTabLoaded(resolved.record, resolved.tab);
  const checked = checkWebAssistAction(resolved.tab, input);
  if (!checked.ok) return checked;
  const exposed = exposeTaskTabToModel(resolved);
  if (!exposed.ok) return exposed;
  return actOnWebAssistTab(resolved.record, resolved.tab, input);
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
