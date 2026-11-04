import * as vm from 'node:vm';
import * as path from 'node:path';
import { dialog, session } from 'electron';
import { prepareWebAssistCache } from '../../../src/main/features/web_assist_cache';
import { registerUserSwitchHook } from '../../../src/main/features/user-switch-hooks';
import * as permissions from '../../../src/main/features/web_assist_permissions';
import * as passkeys from '../../../src/main/features/web_assist_passkey';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { logWebAssistFailure } from '../../../src/main/features/web_assist_diagnostics';
import { recordGeneratedAttachment, deleteAttachment } from '../../../src/main/features/chat_attachments';

// The native lifecycle suite controls publication faults. Real attachment
// ownership, restart recovery and sending are exercised by download E2E.
vi.mock('../../../src/main/features/chat_attachments', () => ({
  recordGeneratedAttachment: vi.fn(),
  deleteAttachment: vi.fn(() => ({ ok: false })),
}));

vi.mock('../../../src/main/features/web_assist_diagnostics', () => ({ logWebAssistFailure: vi.fn() }));

const DOWNLOAD_ROOT = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  return fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'orkas-web-assist-downloads-'));
});
afterAll(() => require('node:fs').rmSync(DOWNLOAD_ROOT, { recursive: true, force: true }));

const electronMock = vi.hoisted(() => ({
  renderer: null as any,
  owner: null as any,
  page: null as any,
  createPage: null as null | (() => any),
  createWindow: null as null | (() => { renderer: any; owner: any }),
  beforeRequest: null as any,
  /** Lets a test model the app running with every window closed (tray/dock). */
  windowsOpen: true,
  observeHref: '',
  sessionHandlers: {} as Record<string, (...args: any[]) => void>,
  viewPreferences: null as null | Record<string, unknown>,
  // Page corpora for the observe fixture. Defaults keep every existing test
  // on the single short page they were written against.
  pageText: 'Create an app',
  pageElementCount: 1,
  /** An offscreen PDF/Office/video render host, listed before the app window. */
  renderHost: null as any,
}));

vi.mock('../../../src/main/paths', () => ({
  userWebAssistProfileDir: (uid: string) => `/tmp/orkas-web-assist-control-test/${uid}`,
}));

vi.mock('../../../src/main/features/user-switch-hooks', () => ({
  registerUserSwitchHook: vi.fn(),
}));

vi.mock('../../../src/main/util/project-layout', () => ({
  chatAttachmentDirForConversation: (uid: string, cid: string) => (
    path.join(DOWNLOAD_ROOT, uid, cid)
  ),
}));

vi.mock('../../../src/main/features/web_assist_cache', () => ({
  prepareWebAssistCache: vi.fn(async () => {}),
}));

// This suite owns tab lifecycle without Chromium. Real frame metrics and
// pointer acknowledgements are exercised by the Electron input E2E cases.
vi.mock('../../../src/main/features/web_assist_viewport', () => ({
  configureWebAssistViewport: () => {},
  attachWebAssistViewport: () => {},
  setWebAssistViewport: async (contents: any, factor: number) => {
    contents.emulation = factor < 1 ? { width: 1280, scale: factor, mobile: false } : null;
    contents.emulationCalls += 1;
  },
}));

// Login persistence has its own real-storage and Electron restart coverage.
vi.mock('../../../src/main/features/web_assist_session', () => ({
  prepareWebAssistSession: vi.fn(async () => {}),
}));

vi.mock('electron', () => {
  class FakeEmitter {
    private eventListeners = new Map<string, Array<(...args: any[]) => void>>();

    on(event: string, listener: (...args: any[]) => void): this {
      const rows = this.eventListeners.get(event) || [];
      rows.push(listener);
      this.eventListeners.set(event, rows);
      return this;
    }

    once(event: string, listener: (...args: any[]) => void): this {
      const wrapped = (...args: any[]) => {
        this.removeListener(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    removeListener(event: string, listener: (...args: any[]) => void): this {
      this.eventListeners.set(event, (this.eventListeners.get(event) || []).filter((row) => row !== listener));
      return this;
    }

    listeners(event: string): Array<(...args: any[]) => void> { return this.eventListeners.get(event) || []; }

    emit(event: string, ...args: any[]): void {
      for (const listener of [...(this.eventListeners.get(event) || [])]) listener(...args);
    }
  }

  class FakePage extends FakeEmitter {
    nativeDialogs = vi.fn((_info: any, callback: any) => callback(false, ''));
    constructor() { super(); this.on('-run-dialog', this.nativeDialogs); }
    ipc = new FakeEmitter();
    session = fakeSession;
    static nextId = 1;
    id = FakePage.nextId++;
    private url = '';
    private destroyed = false;
    private loading = false;
    title = 'Provider console';
    audible = false;
    idleSafe = true;
    vetoUnload = false;
    restoredEntries: any[] = [];
    windowOpenHandler: null | ((details: { url: string; disposition?: string; features?: string; postBody?: any; referrer?: any }) => any) = null;
    navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
      getAllEntries: () => [{ url: this.url, title: this.title, pageState: 'private-form-state' }],
      getActiveIndex: () => 0,
      restore: async (options: any) => {
        this.restoredEntries = options.entries;
        await this.loadURL(options.entries[options.index].url);
      },
    };

    isDestroyed(): boolean { return this.destroyed; }
    isLoading(): boolean { return this.loading; }
    isCurrentlyAudible(): boolean { return this.audible; }
    getURL(): string { return this.url; }
    getTitle(): string { return this.title; }
    capturePage = vi.fn();
    getZoomFactor(): number { return this.emulation?.scale || 1; }
    setUserAgent(): void {}
    emulation: null | Record<string, any> = null;
    emulationCalls = 0;
    setWindowOpenHandler(handler: NonNullable<FakePage['windowOpenHandler']>): void {
      this.windowOpenHandler = handler;
    }
    reload(): void {}
    close(options?: { waitForBeforeUnload?: boolean }): void {
      if (options?.waitForBeforeUnload && this.vetoUnload) { this.emit('will-prevent-unload', {}); return; }
      this.destroyed = true;
      this.emit('destroyed');
    }

    async loadURL(url: string): Promise<void> {
      this.url = url;
      this.loading = true;
      this.emit('did-start-navigation', {}, url, false, true);
      this.emit('did-start-loading');
      this.emit('did-navigate');
      this.loading = false;
      this.emit('did-stop-loading');
    }

    async executeJavaScript(): Promise<unknown> {
      throw new Error('Web Assist must not execute controller code in the page main world');
    }

    async executeJavaScriptInIsolatedWorld(
      worldId: number,
      scripts: Array<{ code: string }>,
    ): Promise<unknown> {
      expect(worldId).toBeGreaterThanOrEqual(1000);
      const script = scripts[0]?.code || '';
      if (script.includes('const safeDocument')) return this.idleSafe;
      if (script.includes('elements_truncated:')) {
        // Window the corpus the way the real script does, so a paging test
        // exercises the offset actually reaching the page rather than a
        // hand-made reply.
        const readOffset = (name: string) => Number(
          new RegExp(`const ${name} = (\\d+);`).exec(script)?.[1] || 0,
        );
        const textFrom = Math.min(readOffset('TEXT_FROM'), electronMock.pageText.length);
        const text = electronMock.pageText.slice(textFrom, textFrom + 6000);
        const textEnd = textFrom + text.length;
        const total = electronMock.pageElementCount;
        const elementFrom = Math.min(readOffset('ELEMENT_FROM'), total);
        const shown = Math.min(80, total - elementFrom);
        const elementEnd = elementFrom + shown;
        const template = {
            path: [0, 1],
            signature: { tag: 'input', type: 'text', role: '', label: 'Application name' },
            tag: 'input',
            role: '',
            label: 'Application name',
            input_type: 'text',
            placeholder: 'Name',
            href: electronMock.observeHref,
            disabled: false,
            checked: null,
            sensitive: false,
            fillable: true,
            options: [],
            value: 'must-not-escape',
        };
        return {
          ok: true,
          title: this.title,
          text,
          text_offset: textFrom,
          text_total: electronMock.pageText.length,
          text_next_offset: textEnd < electronMock.pageText.length ? textEnd : null,
          text_truncated: textEnd < electronMock.pageText.length,
          elements: Array.from({ length: shown }, (_, index) => ({
            ...template,
            // Only number them when a test asked for a corpus; the default page
            // stays exactly what every existing assertion was written against.
            ...(total > 1 ? { label: `${template.label} ${elementFrom + index + 1}` } : {}),
          })),
          element_offset: elementFrom,
          element_count: total,
          element_next_offset: elementEnd < total ? elementEnd : null,
          elements_truncated: elementEnd < total,
        };
      }
      if (script.includes("outcome: 'acted'")) {
        return { ok: true, outcome: 'acted', action: 'fill' };
      }
      return true;
    }
  }

  class FakeWebContentsView {
    webContents: FakePage;
    private visible = true;
    constructor(options?: { webContents?: FakePage; webPreferences?: Record<string, unknown> }) {
      this.webContents = options?.webContents || new FakePage();
      electronMock.page = this.webContents;
      electronMock.viewPreferences = options?.webPreferences || null;
    }
    setBackgroundColor(): void {}
    setVisible(visible: boolean): void { this.visible = visible; }
    getVisible(): boolean { return this.visible; }
    private bounds = { x: 0, y: 0, width: 800, height: 600 };
    setBounds(bounds: typeof this.bounds): void { this.bounds = bounds; }
    getBounds() { return this.bounds; }
  }

  electronMock.createPage = () => new FakePage();

  electronMock.createWindow = () => {
    const renderer = new FakeEmitter() as FakeEmitter & {
      send: ReturnType<typeof vi.fn>;
      getURL(): string;
      isDestroyed(): boolean;
    };
    renderer.send = vi.fn();
    // The app window is identified by this entry document; offscreen render
    // hosts load something else and must never host a task browser.
    renderer.getURL = () => 'file:///orkas/renderer/index.html';
    renderer.isDestroyed = () => false;
    const owner = new FakeEmitter() as FakeEmitter & Record<string, any>;
    owner.id = 42;
    owner.webContents = renderer;
    owner.isDestroyed = () => false;
    owner.isFocusable = () => true;
    owner.minimized = false;
    owner.shown = true;
    owner.isMinimized = () => owner.minimized;
    owner.isVisible = () => owner.shown;
    owner.minimize = vi.fn(() => { owner.minimized = true; });
    owner.restore = vi.fn(() => { owner.minimized = false; });
    owner.show = vi.fn(() => { owner.shown = true; });
    owner.focus = vi.fn();
    owner.getContentBounds = () => ({ width: 1200, height: 800 });
    owner.contentView = {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    };
    electronMock.renderer = renderer;
    electronMock.owner = owner;
    return { renderer, owner };
  };

  const fakeSession = {
    registerPreloadScript: vi.fn(),
    webRequest: { onBeforeRequest: (handler: any) => { electronMock.beforeRequest = handler; }, onBeforeSendHeaders: vi.fn() },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      electronMock.sessionHandlers[event] = handler;
    }),
  };

  return {
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    ipcMain: Object.assign(new FakeEmitter(), { handle: vi.fn() }),
    app: { userAgentFallback: 'Chrome/120 Electron/30 Orkas/1.7', getName: () => 'Orkas' },
    BrowserWindow: {
      fromWebContents: (sender: unknown) => (
        sender === electronMock.renderer ? electronMock.owner : null
      ),
      getAllWindows: () => [
        ...(electronMock.renderHost ? [electronMock.renderHost] : []),
        ...(electronMock.windowsOpen && electronMock.owner ? [electronMock.owner] : []),
      ],
    },
    session: { fromPath: vi.fn(() => fakeSession) },
    shell: { openExternal: vi.fn() },
    WebContentsView: FakeWebContentsView,
  };
});

import {
  answerWebAssistPermission,
  actOnControlledWebAssist,
  actOnModelWebAssist,
  activateWebAssistTab,
  addWebAssistTab,
  bindHostStartedWebAssistConversation,
  bindWebAssistConversation,
  closeWebAssistTab,
  closeWebAssist,
  closeModelWebAssistTab,
  chooseModelWebAssistFiles,
  retainModelWebAssistTab,
  listModelWebAssistTabs,
  navigateModelWebAssist,
  navigateControlledWebAssist,
  observeControlledWebAssist,
  observeModelWebAssist,
  screenshotModelWebAssist,
  readModelWebAssistValue,
  openControlledWebAssist,
  openModelWebAssist,
  openWebAssist,
  layoutWebAssist,
  setWebAssistOverlayState,
  navigateWebAssistTo,
  navigateWebAssist,
  setActiveWebAssistConversation,
  waitForModelWebAssist,
  waitForControlledWebAssist,
  reclaimIdleWebAssistPages,
  webAssistIdleSafetyScript,
  webAssistState,
  openWebAssistInDefaultBrowser,
  forgetWebAssistDownloads,
  webAssistDownloads,
  MAX_TABS_PER_CONVERSATION as TAB_LIMIT,
  setAppWindowFactory,
  surfaceAppWindow,
  webAssistNavigations,
  forgetWebAssistNavigations,
  webAssistFrameInventory,
  fitWebAssistObservation,
} from '../../../src/main/features/web_assist';
import { estimateToolResultTokens } from '../../../src/main/util/tool-result-cap';
import {
  beginBrowserTaskRun, finishBrowserTaskRun,
} from '../../../src/main/features/web_assist_lifecycle';

// The task browser's proxy policy follows the launch environment. A developer
// shell's HTTP(S)_PROXY must not change these fixtures' system policy, and the
// fake session deliberately has no `setProxy`.
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
const savedProxyEnv = new Map<string, string | undefined>();
beforeAll(() => {
  for (const key of PROXY_ENV_KEYS) {
    savedProxyEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});
afterAll(() => {
  for (const [key, value] of savedProxyEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Web Assist controlled connector lifecycle', () => {
  beforeEach(() => {
    electronMock.createWindow?.();
    vi.mocked(prepareWebAssistCache).mockReset().mockResolvedValue(undefined);
    vi.mocked(logWebAssistFailure).mockClear();
  });

  it('returns path-based recovery without opening a native picker or extending upload grants', async () => {
    const cid = 'c-picker-free';
    bindWebAssistConversation('u1', cid, electronMock.renderer);
    vi.mocked(dialog.showOpenDialog).mockClear();
    for (const directory of [false, true]) {
      expect(await chooseModelWebAssistFiles('u1', cid, directory)).toMatchObject({
        ok: false, code: 'file_paths_required',
      });
    }
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(await chooseModelWebAssistFiles('u1', 'unbound-picker-task', false)).toMatchObject({ ok: false, code: 'file_paths_required' });
    const cancelled = new AbortController(); cancelled.abort();
    expect(await chooseModelWebAssistFiles('u1', cid, false, { signal: cancelled.signal })).toMatchObject({ ok: false, code: 'task_run_ended' });
  });

  describe('observation document freshness', () => {
    afterEach(() => {
      closeWebAssist(electronMock.renderer);
      vi.restoreAllMocks();
      electronMock.pageText = 'Create an app';
    });

    async function pendingObservation(entry: 'browser' | 'connector', scope: 'full' | 'meta' = 'full') {
      const cid = 'c-observe-freshness';
      bindWebAssistConversation('u1', cid, electronMock.renderer);
      const url = 'https://example.com/observation';
      if (entry === 'browser') await openModelWebAssist('u1', cid, { url });
      else await openControlledWebAssist('u1', cid, { scope: 'connector_setup', scopeId: 'shop', url });
      const page = electronMock.page;
      const observe = () => entry === 'browser'
        ? observeModelWebAssist('u1', cid, undefined, scope)
        : observeControlledWebAssist('u1', cid, 'shop');
      electronMock.pageText = 'Before the page transition';
      const before = await observe();
      const execute = page.executeJavaScriptInIsolatedWorld.bind(page);
      let entered!: () => void;
      const reading = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void;
      vi.spyOn(page, 'executeJavaScriptInIsolatedWorld').mockImplementationOnce(async (...args: any[]) => {
        const old = await execute(...args);
        entered();
        return new Promise(resolve => { release = () => resolve(old); });
      });
      const pending = observe();
      await reading;
      return { cid, page, before, observe, pending, release: () => release() };
    }

    for (const entry of ['browser', 'connector'] as const) {
      it.each(['steady', 'different-url', 'same-url-reload', 'closed', 'user-takeover', 'subframe-navigation', 'parser-ready'] as const)(
        `${entry} only publishes DOM evidence from the current document after %s`, async change => {
          const read = await pendingObservation(entry);
          try {
            if (change === 'different-url' || change === 'same-url-reload') {
              electronMock.pageText = 'After the page transition';
              await read.page.loadURL(change === 'different-url' ? 'https://example.com/replacement' : read.page.getURL());
            } else if (change === 'closed') closeWebAssist(electronMock.renderer);
            else if (change === 'user-takeover') read.page.emit('before-input-event', {}, { type: 'keyDown', code: 'KeyA', isComposing: false });
            else if (change === 'subframe-navigation') read.page.emit('did-start-navigation', {}, 'https://frame.example/new', false, false);
            else if (change === 'parser-ready') read.page.emit('did-start-loading');
            read.release();
            const result = await read.pending;
            if (['steady', 'subframe-navigation', 'parser-ready'].includes(change)) {
              expect(result).toMatchObject({ ok: true, text: 'Before the page transition' });
            } else {
              expect(result).toMatchObject({ ok: false, code: 'page_changed' });
              expect(result).not.toHaveProperty('page_id');
              if (change === 'different-url' || change === 'same-url-reload') {
                const action = await actOnModelWebAssist('u1', read.cid, {
                  pageId: read.before.page_id, elementRef: 'e1', action: 'fill', text: 'Must not act on old evidence',
                });
                expect(action).toMatchObject({ ok: false, code: 'stale_page' });
                expect(await read.observe()).toMatchObject({ ok: true, text: 'After the page transition' });
              }
            }
          } finally { read.release(); await read.pending; }
        },
      );
    }

    it.each([false, true])('meta observation keeps usable current refs and rejects same-URL reload=%s', async reload => {
      const read = await pendingObservation('browser', 'meta');
      try {
        if (reload) await read.page.loadURL(read.page.getURL());
        read.release();
        const result = await read.pending;
        if (reload) {
          expect(result).toMatchObject({ ok: false, code: 'page_changed' });
          expect(result).not.toHaveProperty('page_id');
        } else {
          expect(result).toMatchObject({ ok: true, scope: 'meta' });
          expect(result).not.toHaveProperty('text');
          expect(result).not.toHaveProperty('elements');
          expect(await actOnModelWebAssist('u1', read.cid, {
            pageId: result.page_id, elementRef: 'e1', action: 'fill', text: 'Current evidence remains usable',
          })).toMatchObject({ ok: true });
        }
      } finally { read.release(); await read.pending; }
    });

    it.each(['browser', 'connector'] as const)('a late %s observation cannot erase a newer document snapshot', async entry => {
      const read = await pendingObservation(entry);
      try {
        electronMock.pageText = 'After the page transition';
        await read.page.loadURL(read.page.getURL());
        const fresh = await read.observe();
        expect(fresh).toMatchObject({ ok: true, text: 'After the page transition' });
        read.release();
        expect(await read.pending).toMatchObject({ ok: false, code: 'page_changed' });
        expect(await actOnModelWebAssist('u1', read.cid, {
          pageId: fresh.page_id, elementRef: 'e1', action: 'fill', text: 'Keep the newer snapshot usable',
        })).toMatchObject({ ok: true });
      } finally { read.release(); await read.pending; }
    });
  });

  it.each(['open', 'blank'] as const)('%s waits for cache migration and retries a failed preparation without creating a session', async entry => {
    const { renderer } = electronMock;
    let reject!: (error: Error) => void;
    vi.mocked(prepareWebAssistCache).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const open = () => entry === 'open'
      ? openWebAssist('u1', renderer, { conversationId: 'cache-retry', url: 'https://example.com/' })
      : addWebAssistTab('u1', renderer, { conversationId: 'cache-retry' });
    const calls = vi.mocked(session.fromPath).mock.calls.length;
    const pending = open();
    expect(vi.mocked(session.fromPath).mock.calls.length).toBe(calls);
    reject(new Error('Fixture migration failure'));
    expect(await pending).toMatchObject({ ok: false, code: 'view_unavailable' });
    expect(vi.mocked(session.fromPath).mock.calls.length).toBe(calls);
    expect(await open()).toMatchObject({ ok: true });
    closeWebAssist(renderer);
  });

  it('does not open an old account page when the account changes during cache migration', async () => {
    let finish!: () => void;
    vi.mocked(prepareWebAssistCache).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const calls = vi.mocked(session.fromPath).mock.calls.length;
    const pending = openWebAssist('u1', electronMock.renderer, { url: 'https://example.com/' });
    const hook = vi.mocked(registerUserSwitchHook).mock.calls.find(([name]) => name === 'web-assist')![1];
    hook('u1', 'u2');
    finish();
    expect(await pending).toMatchObject({ ok: false });
    expect(vi.mocked(session.fromPath).mock.calls.length).toBe(calls);
  });

  it('keeps the browser closed when the user closes it during cache migration and permits a fresh open', async () => {
    const { renderer } = electronMock;
    let finish!: () => void;
    vi.mocked(prepareWebAssistCache).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = openWebAssist('u1', renderer, { url: 'https://example.com/' });
    closeWebAssist(renderer);
    finish();
    expect(await pending).toMatchObject({ ok: false });
    expect(webAssistState(renderer).state.open).toBe(false);
    expect(await openWebAssist('u1', renderer, { url: 'https://example.com/' })).toMatchObject({ ok: true });
    closeWebAssist(renderer);
  });

  it('delivers site consent only to trusted chrome and accepts only the selected task/page answer', async () => {
    const sender = electronMock.renderer;
    bindWebAssistConversation('u1', 'c-permission', sender);
    setActiveWebAssistConversation(sender, 'c-permission');
    const opened = await openWebAssist('u1', sender, { conversationId: 'c-permission', url: 'https://site.example/request' });
    if (!opened.ok) throw new Error('fixture open failed');
    const page = electronMock.page;
    const handler = vi.mocked(session.fromPath('/tmp/fixture').setPermissionRequestHandler).mock.calls.at(-1)![0]!;
    const response = new Promise<boolean>(resolve => handler(page, 'notifications', resolve, { requestingUrl: 'https://site.example/request?secret=hidden', isMainFrame: true }));
    const tab = webAssistState(sender).state.tabs.find(item => item.tab_id === opened.tab_id)!;
    expect(tab.permission_request).toMatchObject({ permission: 'notifications', origin: 'https://site.example' });
    expect(JSON.stringify(tab.permission_request)).not.toContain('secret=');
    expect(listModelWebAssistTabs('u1', 'c-permission')).not.toHaveProperty('permission_request');
    expect(JSON.stringify(listModelWebAssistTabs('u1', 'c-permission'))).not.toContain('permission_request');
    const input = { tabId: tab.tab_id, requestId: tab.permission_request!.id, allowed: true };
    expect(answerWebAssistPermission(page, input)).toEqual({ handled: false });
    setActiveWebAssistConversation(sender, 'c-other');
    expect(answerWebAssistPermission(sender, input)).toEqual({ handled: false });
    setActiveWebAssistConversation(sender, 'c-permission');
    const other = await addWebAssistTab('u1', sender, { conversationId: 'c-permission' });
    expect(other.ok).toBe(true);
    expect(answerWebAssistPermission(sender, input)).toEqual({ handled: false });
    activateWebAssistTab(sender, tab.tab_id);
    expect(answerWebAssistPermission(sender, input)).toEqual({ handled: true });
    expect(await response).toBe(true);
    expect(webAssistState(sender).state.tabs.find(item => item.tab_id === tab.tab_id)!.permission_request).toBeUndefined();
    expect(answerWebAssistPermission(sender, input)).toEqual({ handled: false });
    closeWebAssist(sender);
  });

  describe.each(['browser', 'connector'] as const)('%s text wait deadline', (scope) => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      closeWebAssist(electronMock.renderer);
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    async function openWait(lifetime: { signal?: AbortSignal; isActive?: () => boolean } = {}) {
      const cid = 'c-wait-deadline';
      bindWebAssistConversation('u1', cid, electronMock.renderer);
      const url = 'https://example.com/ready';
      if (scope === 'browser') {
        expect(await openModelWebAssist('u1', cid, { url })).toMatchObject({ ok: true });
      } else {
        expect(await openControlledWebAssist('u1', cid, {
          scope: 'connector_setup', scopeId: 'shop', url,
        })).toMatchObject({ ok: true });
      }
      const input = { condition: 'text', text: 'Ready', timeoutMs: 500 };
      return () => scope === 'browser'
        ? waitForModelWebAssist('u1', cid, input, lifetime)
        : waitForControlledWebAssist('u1', cid, 'shop', input, lifetime);
    }

    function waitForCondition(condition: 'loaded' | 'text') {
      const input = { condition, ...(condition === 'text' ? { text: 'Ready' } : {}), timeoutMs: 500 };
      return scope === 'browser'
        ? waitForModelWebAssist('u1', 'c-wait-deadline', input)
        : waitForControlledWebAssist('u1', 'c-wait-deadline', 'shop', input);
    }

    function delayedTextRead(initialText: string) {
      let currentText = initialText;
      let release!: () => void;
      const evaluate = (_world: number, scripts: Array<{ code: string }>) =>
        vm.runInNewContext(scripts[0].code, { document: { body: { innerText: currentText } } });
      vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld').mockImplementation(async (...args: Parameters<typeof evaluate>) => evaluate(...args))
        .mockImplementationOnce((...args: Parameters<typeof evaluate>) => {
          const captured = evaluate(...args);
          return new Promise(resolve => { release = () => resolve(captured); });
        });
      return { release: () => release(), setText: (text: string) => { currentText = text; } };
    }

    it.each(['navigation', 'same-url-reload', 'in-page-navigation', 'tab-close', 'tab-replaced', 'user-takeover'] as const)(
      'discards old text readiness after %s without restarting the wait deadline', async change => {
        const wait = await openWait();
        const page = electronMock.page;
        const read = delayedTextRead('Ready');
        const pending = wait();
        if (change === 'navigation' || change === 'same-url-reload') {
          read.setText('New page without the requested status');
          await page.loadURL(change === 'navigation' ? 'https://example.com/next' : page.getURL());
        } else if (change === 'in-page-navigation') {
          read.setText('The route changed without a full reload');
          page.emit('did-navigate-in-page', {}, 'https://example.com/ready#next', true);
        } else if (change === 'tab-close' || change === 'tab-replaced') {
          const tabId = webAssistState(electronMock.renderer).state.active_tab_id;
          expect(closeModelWebAssistTab('u1', 'c-wait-deadline', tabId)).toMatchObject({ ok: true, closed: true });
          if (change === 'tab-replaced') {
            if (scope === 'browser') await openModelWebAssist('u1', 'c-wait-deadline', { url: 'https://example.com/replacement' });
            else await openControlledWebAssist('u1', 'c-wait-deadline', { scope: 'connector_setup', scopeId: 'shop', url: 'https://example.com/replacement' });
          }
        } else {
          page.emit('before-input-event', {}, { type: 'keyDown', code: 'KeyA', isComposing: false });
          expect(listModelWebAssistTabs('u1', 'c-wait-deadline')).toMatchObject({ tabs: [{ user_controlled: true }] });
        }
        read.release();
        await vi.advanceTimersByTimeAsync(500);
        expect(await pending).toMatchObject({ ok: false });
        if (change !== 'tab-close' && change !== 'tab-replaced') {
          expect(await pending).toMatchObject({ code: 'wait_timeout', timeout_ms: 500 });
        }
        if (change === 'tab-replaced') {
          expect(listModelWebAssistTabs('u1', 'c-wait-deadline')).toMatchObject({ tabs: [{ display_url: 'https://example.com/replacement' }] });
          expect(await waitForCondition('loaded')).toMatchObject({ ok: true });
        }
      },
    );

    it('continues waiting for fresh matching text after an expected navigation', async () => {
      const wait = await openWait();
      const read = delayedTextRead('Not ready yet');
      const pending = wait();
      read.setText('Ready');
      await electronMock.page.loadURL('https://example.com/success');
      read.release();
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending).toMatchObject({ ok: true, condition: 'text' });
    });

    it.each(['unchanged', 'subframe-navigation', 'subframe-in-page-navigation'] as const)('accepts valid current text after %s', async change => {
      const wait = await openWait();
      const read = delayedTextRead('Ready');
      const pending = wait();
      if (change === 'subframe-navigation') electronMock.page.emit('did-start-navigation', {}, 'https://example.com/frame', false, false);
      if (change === 'subframe-in-page-navigation') electronMock.page.emit('did-navigate-in-page', {}, 'https://example.com/frame#next', false);
      read.release();
      expect(await pending).toMatchObject({ ok: true, condition: 'text' });
    });

    it('discards pre-takeover text even when the user has released control before it settles', async () => {
      await openWait();
      const read = delayedTextRead('Ready');
      const input = { condition: 'text', text: 'Ready', timeoutMs: 15000 };
      const pending = scope === 'browser' ? waitForModelWebAssist('u1', 'c-wait-deadline', input)
        : waitForControlledWebAssist('u1', 'c-wait-deadline', 'shop', input);
      const page = electronMock.page;
      page.emit('before-input-event', {}, { type: 'keyDown', code: 'KeyA', isComposing: false });
      page.emit('before-input-event', {}, { type: 'keyUp', code: 'KeyA', isComposing: false });
      read.setText('The user changed the status');
      await vi.advanceTimersByTimeAsync(10000);
      expect(listModelWebAssistTabs('u1', 'c-wait-deadline')).toMatchObject({ tabs: [expect.not.objectContaining({ user_controlled: true })] });
      read.release();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({ ok: false, code: 'wait_timeout', timeout_ms: 15000 });
    });

    if (scope === 'connector') it('rejects a text match after explicit navigation revoked its connector binding', async () => {
      const wait = await openWait();
      const read = delayedTextRead('Ready');
      const pending = wait();
      const tabId = webAssistState(electronMock.renderer).state.active_tab_id;
      expect(await navigateModelWebAssist('u1', 'c-wait-deadline', { tabId, action: 'goto', url: 'https://example.com/general' })).toMatchObject({ ok: true });
      read.release();
      expect(await pending).toMatchObject({ ok: false, code: 'scope_mismatch' });
    });

    it.each(['loaded', 'text'] as const)('reports a failed main-frame load instead of satisfying %s, then permits recovery', async condition => {
      await openWait();
      const page = electronMock.page;
      const loading = vi.spyOn(page, 'loadURL');
      const reading = vi.spyOn(page, 'executeJavaScriptInIsolatedWorld');
      page.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', 'https://example.com/failed', true);
      page.emit('did-finish-load'); // Chromium error documents can finish loading.
      page.emit('did-stop-loading');
      expect(webAssistState(electronMock.renderer).state).toMatchObject({ loading: false, error_code: 'page_load_failed' });
      expect(await waitForCondition(condition)).toMatchObject({ ok: false, code: 'page_load_failed' });
      expect(webAssistState(electronMock.renderer).state.assistant_action).toBeUndefined();
      expect(reading).not.toHaveBeenCalled();
      expect(loading).not.toHaveBeenCalled();
      await page.loadURL('https://example.com/recovered');
      expect(await waitForCondition(condition)).toMatchObject({ ok: true, condition });
    });

    it('reports navigation failure arriving during a polling load wait', async () => {
      await openWait();
      const page = electronMock.page;
      page.emit('did-start-loading');
      let result: Record<string, unknown> | undefined;
      const pending = waitForCondition('loaded').then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBeUndefined();
      page.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.com/failed', true);
      page.emit('did-stop-loading');
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      expect(result).toMatchObject({ ok: false, code: 'page_load_failed' });
      expect(webAssistState(electronMock.renderer).state.assistant_action).toBeUndefined();
    });

    it('discards a matched text read when the main-frame load failed before it settled', async () => {
      const wait = await openWait();
      let release!: (matched: boolean) => void;
      vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld')
        .mockReturnValueOnce(new Promise<boolean>(resolve => { release = resolve; }));
      const pending = wait();
      electronMock.page.emit('did-fail-load', {}, -324, 'ERR_EMPTY_RESPONSE', 'https://example.com/failed', true);
      release(true);
      expect(await pending).toMatchObject({ ok: false, code: 'page_load_failed' });
      expect(webAssistState(electronMock.renderer).state.assistant_action).toBeUndefined();
    });

    it.each(['subframe', 'cancelled-navigation'] as const)('does not reject a healthy page after %s failure', async failure => {
      await openWait();
      electronMock.page.emit('did-fail-load', {}, failure === 'subframe' ? -105 : -3,
        'fixture navigation failure', 'https://example.com/frame', failure !== 'subframe');
      expect(await waitForCondition('loaded')).toMatchObject({ ok: true, condition: 'loaded' });
    });

    it.each(['abort', 'task end'] as const)('discards a matched native read after %s and permits a fresh wait', async interruption => {
      const controller = new AbortController();
      let active = true;
      const wait = await openWait({ signal: controller.signal, isActive: () => active });
      let release!: (matched: boolean) => void;
      const evaluate = vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld')
        .mockReturnValueOnce(new Promise<boolean>(resolve => { release = resolve; })).mockResolvedValue(true);
      const pending = wait();
      expect(webAssistState(electronMock.renderer).state.assistant_action).toBe('waiting');
      if (interruption === 'abort') controller.abort(); else active = false;
      release(true);
      expect(await pending).toMatchObject({ ok: false, code: 'task_run_ended' });
      expect(webAssistState(electronMock.renderer).state.assistant_action).toBeUndefined();
      // An already-ended call must not read or restore a page at all.
      expect(await wait()).toMatchObject({ ok: false, code: 'task_run_ended' });
      expect(evaluate).toHaveBeenCalledTimes(1);
      const fresh = await openWait();
      expect(await fresh()).toMatchObject({ ok: true, condition: 'text' });
    });

    it('keeps cancellation authoritative when a native read stalls until the deadline', async () => {
      const controller = new AbortController();
      const wait = await openWait({ signal: controller.signal });
      let rejectRead!: (error: Error) => void;
      vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld')
        .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRead = reject; })).mockResolvedValue(true);
      const pending = wait();
      controller.abort();
      await vi.advanceTimersByTimeAsync(500);
      expect(await pending).toMatchObject({ ok: false, code: 'task_run_ended' });
      expect(webAssistState(electronMock.renderer).state.assistant_action).toBeUndefined();
      rejectRead(new Error('late cancelled native read'));
      await vi.advanceTimersByTimeAsync(1);
      expect(await (await openWait())()).toMatchObject({ ok: true });
    });

    it.each(['abort', 'task end'] as const)('releases waiting before a stalled read settles after %s', async interruption => {
      const controller = new AbortController();
      let active = true;
      const wait = await openWait({ signal: controller.signal, isActive: () => active });
      const initialTimers = vi.getTimerCount();
      let rejectRead!: (reason: Error) => void;
      vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld')
        .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRead = reject; })).mockResolvedValue(true);
      let stopped: Record<string, unknown> | undefined;
      const pending = wait().then(result => { stopped = result; });
      if (interruption === 'abort') controller.abort(); else active = false;
      await vi.advanceTimersByTimeAsync(200);
      expect(stopped, 'Stop must not wait for the original 500ms read deadline')
        .toMatchObject({ ok: false, code: 'task_run_ended' });
      await pending;
      expect(webAssistState(electronMock.renderer).state.assistant_action).toBeUndefined();
      // Native work still exists; a late failure cannot change the stopped
      // outcome, restore the badge or leave cancellation timers behind.
      rejectRead(new Error('late stopped read'));
      await vi.advanceTimersByTimeAsync(1);
      expect(stopped).toMatchObject({ ok: false, code: 'task_run_ended' });
      expect(vi.getTimerCount()).toBe(initialTimers);
      expect(await (await openWait())()).toMatchObject({ ok: true });
    });

    it('bounds native reads across repeated stops and recovers at the original deadline', async () => {
      const controller = new AbortController();
      const first = await openWait({ signal: controller.signal });
      let release!: (value: boolean) => void;
      const evaluate = vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld')
        .mockReturnValueOnce(new Promise<boolean>(resolve => { release = resolve; })).mockResolvedValue(true);
      let stopped: Record<string, unknown> | undefined;
      const pending = first().then(result => { stopped = result; });
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toMatchObject({ ok: false, code: 'task_run_ended' });
      await pending;
      for (let index = 0; index < 5; index++) {
        const nextController = new AbortController();
        const input = { condition: 'text', text: 'Another condition', timeoutMs: 500 };
        let result: Record<string, unknown> | undefined;
        const next = (scope === 'browser'
          ? waitForModelWebAssist('u1', 'c-wait-deadline', input, { signal: nextController.signal })
          : waitForControlledWebAssist('u1', 'c-wait-deadline', 'shop', input, { signal: nextController.signal }))
          .then(value => { result = value; });
        nextController.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(result).toMatchObject({ ok: false, code: 'task_run_ended' });
        await next;
        // Each new attempt must not extend the old read or queue another one.
        expect(evaluate).toHaveBeenCalledTimes(1);
      }
      await vi.advanceTimersByTimeAsync(499);
      expect(evaluate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const input = { condition: 'text', text: 'Ready', timeoutMs: 500 };
      expect(await (scope === 'browser' ? waitForModelWebAssist('u1', 'c-wait-deadline', input)
        : waitForControlledWebAssist('u1', 'c-wait-deadline', 'shop', input))).toMatchObject({ ok: true });
      expect(evaluate).toHaveBeenCalledTimes(2);
      release(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(stopped).toMatchObject({ ok: false, code: 'task_run_ended' });
      expect(webAssistState(electronMock.renderer).state.assistant_action).toBeUndefined();
    });

    it('ends a cancelled polling wait before starting another native read', async () => {
      const controller = new AbortController();
      const wait = await openWait({ signal: controller.signal });
      const evaluate = vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld').mockResolvedValue(false);
      const pending = wait();
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending).toMatchObject({ ok: false, code: 'task_run_ended' });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(webAssistState(electronMock.renderer).state.assistant_action).toBeUndefined();
    });

    it('never treats a stopped read as evidence for a different wait condition', async () => {
      const controller = new AbortController();
      const first = await openWait({ signal: controller.signal });
      let release!: (value: boolean) => void;
      let body = 'Ready';
      vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld')
        .mockImplementation(async (_world: number, scripts: Array<{ code: string }>) =>
          vm.runInNewContext(scripts[0].code, { document: { body: { innerText: body } } }))
        .mockReturnValueOnce(new Promise<boolean>(resolve => { release = resolve; }));
      const stopped = first();
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await stopped).toMatchObject({ ok: false, code: 'task_run_ended' });
      const input = { condition: 'text', text: 'Another condition', timeoutMs: 500 };
      const next = () => scope === 'browser' ? waitForModelWebAssist('u1', 'c-wait-deadline', input)
        : waitForControlledWebAssist('u1', 'c-wait-deadline', 'shop', input);
      let result: Record<string, unknown> | undefined;
      const waiting = next().then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(200);
      release(true); // Only the old "Ready" read matched.
      await vi.advanceTimersByTimeAsync(200);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(100);
      await waiting;
      expect(result).toMatchObject({ ok: false, code: 'wait_timeout' });
      body = 'Another condition';
      expect(await next()).toMatchObject({ ok: true });
    });

    it('lets the default wait span the full human idle interval', async () => {
      await openWait();
      const page = electronMock.page;
      page.emit('before-mouse-event', {}, { type: 'mouseWheel', x: 10, y: 10 });
      let result: Record<string, unknown> | undefined;
      const waiting = (scope === 'browser'
        ? waitForModelWebAssist('u1', 'c-wait-deadline', {})
        : waitForControlledWebAssist('u1', 'c-wait-deadline', 'shop', {}))
        .then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(9999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(201);
      await waiting;
      expect(result).toMatchObject({ ok: true });
    });

    it.each(['pending', 'resolve', 'reject'] as const)('bounds a stalled native read with %s settlement and permits recovery', async (settlement) => {
      const wait = await openWait();
      let resolveRead!: (value: unknown) => void;
      let rejectRead!: (reason: Error) => void;
      const nativeRead = new Promise<unknown>((resolve, reject) => {
        resolveRead = resolve;
        rejectRead = reject;
      });
      const evaluate = vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld')
        .mockReturnValueOnce(nativeRead).mockResolvedValue(true);
      let result: Record<string, unknown> | undefined;
      const waiting = wait().then((value) => { result = value; });
      expect(webAssistState(electronMock.renderer).state.assistant_action).toBe('waiting');
      await vi.advanceTimersByTimeAsync(499);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({ ok: false, code: 'wait_timeout', timeout_ms: 500 });
      await waiting;
      expect(webAssistState(electronMock.renderer).state.assistant_action).toBeUndefined();
      if (settlement === 'resolve') resolveRead(true);
      if (settlement === 'reject') rejectRead(new Error('late native read failure'));
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({ ok: false, code: 'wait_timeout' });
      expect(await wait()).toMatchObject({ ok: true, condition: 'text' });
      expect(evaluate).toHaveBeenCalledTimes(2);
    });

    it('uses the remaining deadline after an unmatched poll', async () => {
      const wait = await openWait();
      const evaluate = vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld')
        .mockResolvedValueOnce(false).mockReturnValue(new Promise(() => {}));
      let result: Record<string, unknown> | undefined;
      void wait().then((value) => { result = value; });
      await vi.advanceTimersByTimeAsync(200);
      expect(evaluate).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(300);
      expect(result).toMatchObject({ ok: false, code: 'wait_timeout' });
      expect(webAssistState(electronMock.renderer).state.assistant_action).toBeUndefined();
    });
  });

  describe('browser presentation behind application layers', () => {
    afterEach(() => { closeWebAssist(electronMock.renderer); vi.useRealTimers(); });
    const layerState = (sender: any, input: any) => setWebAssistOverlayState(sender, { ...input, epoch: webAssistState(electronMock.renderer).state.overlay_epoch });
    async function setup() {
      setActiveWebAssistConversation(electronMock.renderer, 'c-layers');
      const opened = await openWebAssist('u1', electronMock.renderer, { conversationId: 'c-layers', url: 'https://example.com/work' });
      if (!opened.ok) throw new Error('Layer fixture setup failed');
      layoutWebAssist(electronMock.renderer, { x: 400, y: 100, width: 600, height: 500 });
      const view = electronMock.owner.contentView.addChildView.mock.calls.find(([view]: any[]) => view.webContents === electronMock.page)[0];
      return { tabId: opened.state.active_tab_id!, page: electronMock.page, view };
    }
    it('hides pixels without capture, page disposal, observation loss or idle reclamation', async () => {
      const { tabId, page, view } = await setup();
      bindWebAssistConversation('u1', 'c-layers', electronMock.renderer);
      const observed = await observeModelWebAssist('u1', 'c-layers', tabId);
      expect(observed.ok).toBe(true);
      const id = page.id;
      expect(layerState(electronMock.renderer, { blocked: true, revision: 1 })).toMatchObject({ ok: true, blocked: true });
      expect(view.getVisible()).toBe(false);
      await reclaimIdleWebAssistPages(Date.now() + 11 * 60_000);
      expect(page.isDestroyed()).toBe(false);
      expect(page.id).toBe(id);
      expect(page.capturePage).not.toHaveBeenCalled();
      expect(await actOnModelWebAssist('u1', 'c-layers', { tabId, pageId: observed.page_id, elementRef: observed.elements[0].ref, action: 'fill', text: 'Updated while hidden' }))
        .toMatchObject({ ok: true, outcome: 'acted' });
      expect(view.getVisible()).toBe(false);
      expect(page.id).toBe(id);
    });
    it('blocks ordinary and stale layout requests until the latest release and a fresh layout', async () => {
      const { view, page } = await setup();
      const bounds = { x: 400, y: 100, width: 600, height: 500 };
      layerState(electronMock.renderer, { blocked: true, revision: 3 });
      layoutWebAssist(electronMock.renderer, bounds);
      expect(view.getVisible()).toBe(false);
      expect(layerState(electronMock.renderer, { blocked: false, revision: 2 })).toMatchObject({ blocked: true, revision: 3 });
      layerState(electronMock.renderer, { blocked: false, revision: 4 });
      expect(view.getVisible()).toBe(false);
      layoutWebAssist(electronMock.renderer, { ...bounds, overlayRevision: 3 });
      expect(view.getVisible()).toBe(false);
      layoutWebAssist(electronMock.renderer, { ...bounds, overlayRevision: 4 });
      expect(view.getVisible()).toBe(true);
      expect(page.capturePage).not.toHaveBeenCalled();
    });
    it('keeps a visible page on screen when empty layer state is reconciled again', async () => {
      const { view } = await setup();
      layerState(electronMock.renderer, { blocked: false, revision: 1 });
      expect(view.getVisible()).toBe(true);
      layerState(electronMock.renderer, { blocked: false, revision: 2 });
      expect(view.getVisible()).toBe(true);
    });
    it('does not resurrect a page after the user closes its drawer while an overlay is open', async () => {
      const { view } = await setup();
      layerState(electronMock.renderer, { blocked: true, revision: 1 });
      layoutWebAssist(electronMock.renderer, { visible: false, overlayRevision: 1 });
      layerState(electronMock.renderer, { blocked: false, revision: 2 });
      expect(view.getVisible()).toBe(false);
      expect(webAssistState(electronMock.renderer).state.open).toBe(true);
    });
    it('rejects malformed and remote-page layer updates without changing the owning page', async () => {
      const { page, view } = await setup();
      for (const input of [{ blocked: true, revision: -1 }, { blocked: true, revision: '1' }, { blocked: 1, revision: 1 }, { blocked: true, revision: NaN }]) {
        expect(layerState(electronMock.renderer, input)).toMatchObject({ ok: false, code: 'invalid_layer_state' });
      }
      expect(layerState(page, { blocked: true, revision: 1 })).toMatchObject({ ok: false });
      expect(view.getVisible()).toBe(true);
    });
    it('resets update sequence on trusted-document reload without revealing old pixels', async () => {
      const { view } = await setup();
      layerState(electronMock.renderer, { blocked: true, revision: 50 });
      const previousEpoch = webAssistState(electronMock.renderer).state.overlay_epoch;
      electronMock.renderer.emit('did-start-navigation', {}, 'file:///app/index.html', false, true);
      expect(setWebAssistOverlayState(electronMock.renderer, { blocked: false, revision: 100, epoch: previousEpoch })).toMatchObject({ ok: false, code: 'stale_layer_document' });
      expect(view.getVisible()).toBe(false);
      expect(layerState(electronMock.renderer, { blocked: false, revision: 1 })).toMatchObject({ ok: true, blocked: false });
      expect(view.getVisible()).toBe(false);
      layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 500, height: 400, overlayRevision: 1 });
      expect(view.getVisible()).toBe(true);
    });
    it('releases layer listeners safely when the native owner has already been destroyed', async () => {
      const { page } = await setup();
      const owner = electronMock.owner;
      owner.isDestroyed = () => true;
      Object.defineProperty(owner, 'webContents', { get() { throw new Error('Object has been destroyed'); } });
      expect(() => owner.emit('closed')).not.toThrow();
      expect(page.isDestroyed()).toBe(true);
    });
    it('broadcasts closure before disposal so trusted chrome can cancel pending layout', async () => {
      const { page } = await setup();
      electronMock.renderer.send.mockClear();
      expect(closeWebAssist(electronMock.renderer)).toMatchObject({ ok: true, closed: true });
      expect(electronMock.renderer.send).toHaveBeenCalledWith('web-assist:state', expect.objectContaining({ open: false, tabs: [] }));
      expect(page.isDestroyed()).toBe(true);
    });
  });

  describe('navigation status follows the current page', () => {
    afterEach(() => {
      closeWebAssist(electronMock.renderer);
      vi.restoreAllMocks();
    });

    it.each(['https://example.com/slow?item=1#section', '上海 天气'])(
      'publishes the accepted address immediately while %s waits for its first document', async input => {
        const cid = 'c-pending-address';
        bindWebAssistConversation('u1', cid, electronMock.renderer);
        const added = await addWebAssistTab('u1', electronMock.renderer, { conversationId: cid });
        if (!added.ok) throw new Error('Address fixture setup failed');
        const tabId = added.state.active_tab_id;
        const page = electronMock.page;
        const nativeLoad = page.loadURL.bind(page);
        let finish!: () => Promise<void>;
        vi.spyOn(page, 'loadURL').mockImplementationOnce((url: string) => new Promise<void>(resolve => {
          finish = async () => { await nativeLoad(url); resolve(); };
        }));
        const destination = input.startsWith('https:') ? input : 'https://www.bing.com/search?q=%E4%B8%8A%E6%B5%B7+%E5%A4%A9%E6%B0%94';
        electronMock.renderer.send.mockClear();
        const navigated = await navigateWebAssistTo(electronMock.renderer, { tabId, url: input });
        expect(page.getURL()).toBe('');
        expect(navigated).toMatchObject({ ok: true, state: { tabs: [{ loading: true, address_url: destination }] } });
        const pushed = electronMock.renderer.send.mock.calls.filter(([event]: any[]) => event === 'web-assist:state');
        expect(pushed.length).toBeGreaterThan(0);
        for (const [, state] of pushed) expect(state.tabs[0].address_url).toBe(destination);
        expect(webAssistState(electronMock.renderer).state.tabs[0].address_url).toBe(destination);
        // Pending chrome state must not claim a document has committed to model consumers.
        const listed = listModelWebAssistTabs('u1', cid);
        expect(JSON.stringify(listed)).not.toContain('address_url');
        expect(listed).toMatchObject({ tabs: [{ display_url: '' }] });
        await finish();
        expect(webAssistState(electronMock.renderer).state.tabs[0]).toMatchObject({ loading: false, address_url: destination });
      },
    );

    it('replaces pending addresses per tab and resumes the committed address after cancellation or failure', async () => {
      const cid = 'c-pending-recovery';
      const opened = await openWebAssist('u1', electronMock.renderer, { conversationId: cid, url: 'https://example.com/ready' });
      if (!opened.ok) throw new Error('Address recovery fixture setup failed');
      const tabId = opened.state.active_tab_id;
      const page = electronMock.page;
      const nativeLoad = page.loadURL.bind(page);
      const load = vi.spyOn(page, 'loadURL').mockImplementation(() => new Promise<void>(() => {}));
      await navigateWebAssistTo(electronMock.renderer, { tabId, url: 'https://example.com/slow' });
      const replaced = await openWebAssist('u1', electronMock.renderer, { conversationId: cid, tabId, url: 'https://example.com/replacement' });
      expect(replaced).toMatchObject({ ok: true, state: { tabs: [{ address_url: 'https://example.com/replacement' }] } });
      const blank = await addWebAssistTab('u1', electronMock.renderer, { conversationId: cid });
      if (!blank.ok) throw new Error('Blank tab fixture setup failed');
      expect(blank.state.tabs.find(tab => tab.tab_id === blank.state.active_tab_id)?.address_url).toBe('');
      expect(activateWebAssistTab(electronMock.renderer, tabId)).toMatchObject({ ok: true, state: { tabs: [
        { address_url: 'https://example.com/replacement' }, { address_url: '' },
      ] } });
      page.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/slow', true);
      expect(webAssistState(electronMock.renderer).state.tabs[0].address_url).toBe('https://example.com/replacement');
      page.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.com/replacement', true);
      page.emit('did-stop-loading');
      expect(webAssistState(electronMock.renderer).state.tabs[0]).toMatchObject({
        loading: false, error_code: 'page_load_failed', address_url: 'https://example.com/ready',
      });
      load.mockRestore();
      await nativeLoad('https://example.com/recovered');
      expect(webAssistState(electronMock.renderer).state.tabs[0]).toMatchObject({ loading: false, address_url: 'https://example.com/recovered' });
    });

    it('keeps the visible native page mounted when reactivating or reopening the same tab', async () => {
      const opened = await openWebAssist('u1', electronMock.renderer, { conversationId: 'c-visible', url: 'https://example.com/ready' });
      if (!opened.ok) throw new Error('Visible page fixture setup failed');
      const view = electronMock.owner.contentView.addChildView.mock.calls.at(-1)[0];
      layoutWebAssist(electronMock.renderer, { x: 400, y: 100, width: 600, height: 500 });
      expect(view.getVisible()).toBe(true);
      activateWebAssistTab(electronMock.renderer, opened.state.active_tab_id);
      expect(view.getVisible()).toBe(true);
      await openWebAssist('u1', electronMock.renderer, { conversationId: 'c-visible', tabId: opened.state.active_tab_id, url: 'https://example.com/next' });
      expect(view.getVisible()).toBe(true);
      expect(view.webContents.getURL()).toBe('https://example.com/next');
      await openWebAssist('u1', electronMock.renderer, { conversationId: 'c-visible', url: 'https://example.com/other' });
      expect(view.getVisible()).toBe(false);
    });

    it('preserves routing queries and fragments in model results and browser chrome', async () => {
      const cid = 'c-address';
      const url = `https://example.com/work?ticket=fixture-query&item=one&item=two&encoded=%2F%26&long=${'a'.repeat(2200)}#fixture-fragment`;
      bindWebAssistConversation('u1', cid, electronMock.renderer);
      const opened = await openModelWebAssist('u1', cid, { url });
      expect(opened.ok).toBe(true);
      expect(webAssistState(electronMock.renderer).state.tabs[0]).toMatchObject({ address_url: url, display_url: url });
      const shown = electronMock.renderer.send.mock.calls.filter(([event]: any[]) => event === 'web-assist:show').at(-1)[1];
      expect(shown.tabs[0].address_url).toBe(url);
      const navigated = await navigateModelWebAssist('u1', cid, { tabId: opened.active_tab_id, action: 'goto', url });
      const listed = listModelWebAssistTabs('u1', cid);
      const observed = await observeModelWebAssist('u1', cid, opened.active_tab_id);
      const controlled = await openControlledWebAssist('u1', cid, { scope: 'connector_setup', scopeId: 'fixture-connector', url });
      for (const result of [opened, navigated, listed, observed, controlled]) {
        expect(result.ok).toBe(true);
        const text = JSON.stringify(result);
        expect(text).not.toContain('address_url');
        expect(text).toContain('fixture-query');
        expect(text).toContain('fixture-fragment');
      }
      const page = electronMock.page;
      const redirected = 'https://example.com/final?keep=one%26two#section';
      await page.loadURL(redirected);
      const pushed = electronMock.renderer.send.mock.calls.filter(([event]: any[]) => event === 'web-assist:state').at(-1)[1];
      expect(pushed.tabs.at(-1).address_url).toBe(redirected);
      expect(webAssistState(electronMock.renderer).state.tabs.at(-1)?.address_url).toBe(redirected);
    });

    it.each(['open', 'address', 'native-tab'] as const)(
      'does not let a replaced %s navigation mark the loaded page as failed', async entry => {
        const opened = await openWebAssist('u1', electronMock.renderer, { conversationId: 'c-nav', url: 'https://example.com/ready' });
        if (!opened.ok) throw new Error('Navigation fixture setup failed');
        let tabId = opened.state.active_tab_id;
        const firstPage = electronMock.page;
        let reject!: (error: unknown) => void;
        vi.spyOn(Object.getPrototypeOf(firstPage), 'loadURL').mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
        if (entry === 'open') {
          await openWebAssist('u1', electronMock.renderer, { conversationId: 'c-nav', tabId, url: 'https://example.com/ready' });
        } else if (entry === 'address') {
          await navigateWebAssistTo(electronMock.renderer, { tabId, url: 'https://example.com/ready' });
        } else {
          firstPage.windowOpenHandler({ url: 'https://example.com/ready', disposition: 'foreground-tab' }).createWindow({});
          tabId = webAssistState(electronMock.renderer).state.active_tab_id;
        }
        const page = electronMock.page;
        // The replacement deliberately has the same URL: URL equality is not
        // navigation identity. Test both cancellation and delayed real rejection.
        await navigateWebAssistTo(electronMock.renderer, { tabId, url: 'https://example.com/ready' });
        page.emit('did-finish-load');
        reject(Object.assign(new Error('Fixture replaced navigation'), entry === 'address'
          ? { code: 'ERR_CONNECTION_RESET', errno: -101 }
          : { code: 'ERR_ABORTED', errno: -3 }));
        await Promise.resolve();
        expect(webAssistState(electronMock.renderer).state).toMatchObject({ display_url: 'https://example.com/ready', loading: false });
        expect(webAssistState(electronMock.renderer).state.error_code).toBeUndefined();
      },
    );

    it('meta observation drops the page payload but keeps refs usable for a later act', async () => {
      const cid = 'c-observe-meta';
      bindWebAssistConversation('u1', cid, electronMock.renderer);
      const opened = await openModelWebAssist('u1', cid, { url: 'https://example.com/work' });
      expect(opened.ok).toBe(true);
      const tabId = String(opened.active_tab_id);

      const full = await observeModelWebAssist('u1', cid, tabId);
      expect(full).toMatchObject({ ok: true, text: 'Create an app', element_count: 1 });
      expect((full as any).elements).toHaveLength(1);
      expect(full).toMatchObject({ frame_count: 1, frames: [{ frame_id: 'main', display_url: 'https://example.com/work' }] });

      const meta = await observeModelWebAssist('u1', cid, tabId, 'meta');
      expect(meta).toMatchObject({
        ok: true, scope: 'meta', element_count: 1, text_length: 'Create an app'.length,
      });
      // The point of meta is a fresh page_id without paying for the page.
      expect(meta).not.toHaveProperty('text');
      expect(meta).not.toHaveProperty('elements');
      expect(meta).not.toHaveProperty('frames');
      expect(meta).not.toHaveProperty('frame_count');
      expect(String((meta as any).page_id)).not.toBe(String((full as any).page_id));

      // Refs were re-walked, so the id meta returned drives an act.
      const acted = await actOnModelWebAssist('u1', cid, {
        tabId, pageId: (meta as any).page_id, elementRef: 'e1', action: 'fill', text: 'Orkas',
      });
      expect(acted).toMatchObject({ ok: true });
    });

    it('retains a real main-page failure on stop, ignores subframe errors, and clears it only on successful recovery', async () => {
      await openWebAssist('u1', electronMock.renderer, { conversationId: 'c-nav', url: 'https://example.com/ready' });
      const page = electronMock.page;
      page.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://frame.invalid/', false);
      page.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/old', true);
      expect(webAssistState(electronMock.renderer).state.error_code).toBeUndefined();
      expect(logWebAssistFailure).not.toHaveBeenCalled();
      page.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://missing.invalid/', true);
      page.emit('did-stop-loading');
      expect(webAssistState(electronMock.renderer).state).toMatchObject({ loading: false, error_code: 'page_load_failed' });
      expect(logWebAssistFailure).toHaveBeenCalledExactlyOnceWith(electronMock.renderer, 'page_load_failed', -105);
      page.emit('did-finish-load');
      expect(webAssistState(electronMock.renderer).state.error_code).toBe('page_load_failed');
      page.emit('did-navigate', {}, 'https://example.com/recovered', 200, 'OK');
      expect(webAssistState(electronMock.renderer).state.error_code).toBeUndefined();
      page.emit('unresponsive');
      page.emit('did-navigate', {}, 'https://example.com/recovered', 200, 'OK');
      expect(webAssistState(electronMock.renderer).state.error_code).toBe('page_unresponsive');
      expect(logWebAssistFailure).toHaveBeenLastCalledWith(electronMock.renderer, 'page_unresponsive');
      page.emit('render-process-gone', {}, { reason: 'clean-exit' });
      expect(logWebAssistFailure).toHaveBeenCalledTimes(2);
      page.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      expect(logWebAssistFailure).toHaveBeenLastCalledWith(electronMock.renderer, 'renderer_gone',
        undefined, undefined, { reason: 'crashed', exitCode: 1 });
    });
  });

  describe('idle native page reclamation', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      closeWebAssist(electronMock.renderer);
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    async function open(id = 'c-idle') {
      bindWebAssistConversation('u1', id, electronMock.renderer);
      const result = await openModelWebAssist('u1', id, { url: 'https://example.com/work?item=1' });
      expect(result.ok).toBe(true);
      return { tabId: result.active_tab_id as string, page: electronMock.page };
    }

    it('ignores a restored navigation rejection after the user replaces it', async () => {
      const { tabId, page: oldPage } = await open();
      await vi.advanceTimersByTimeAsync(600_000);
      let reject!: (error: unknown) => void;
      vi.spyOn(Object.getPrototypeOf(oldPage), 'loadURL').mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
      activateWebAssistTab(electronMock.renderer, tabId);
      await navigateWebAssistTo(electronMock.renderer, { tabId, url: 'https://example.com/recovered' });
      electronMock.page.emit('did-finish-load');
      reject(Object.assign(new Error('Fixture restore cancelled'), { code: 'ERR_ABORTED', errno: -3 }));
      await Promise.resolve();
      await Promise.resolve();
      oldPage.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://old.invalid', true);
      expect(webAssistState(electronMock.renderer).state).toMatchObject({ display_url: 'https://example.com/recovered', loading: false });
      expect(webAssistState(electronMock.renderer).state.error_code).toBeUndefined();
    });

    it.each(['back', 'forward', 'reload'] as const)('restores %s directly without a second navigation', async action => {
      const { tabId, page } = await open();
      const entries = ['previous', 'current', 'next'].map(name => ({ url: `https://example.com/${name}`, title: name }));
      page.navigationHistory.getAllEntries = () => entries;
      page.navigationHistory.getActiveIndex = () => 1;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(webAssistState(electronMock.renderer).state).toMatchObject({ can_go_back: true, can_go_forward: true });
      expect(await navigateModelWebAssist('u1', 'c-idle', { tabId, action })).toMatchObject({ ok: true });
      expect(electronMock.page.getURL()).toBe(entries[action === 'back' ? 0 : action === 'forward' ? 2 : 1].url);
      expect(electronMock.page.navigationHistory.goBack).not.toHaveBeenCalled();
      expect(electronMock.page.navigationHistory.goForward).not.toHaveBeenCalled();
      page.emit('did-start-loading');
      page.emit('render-process-gone');
      expect(webAssistState(electronMock.renderer).state).toMatchObject({ loading: false });
      expect(webAssistState(electronMock.renderer).state.error_code).toBeUndefined();
    });

    it('bounds a hung safety probe and protects in-flight model observations', async () => {
      const { tabId, page } = await open();
      const probe = vi.spyOn(page, 'executeJavaScriptInIsolatedWorld').mockImplementation(() => new Promise(() => {}));
      const checking = reclaimIdleWebAssistPages(Date.now() + 600_000);
      await vi.advanceTimersByTimeAsync(1000);
      await checking;
      expect(page.isDestroyed()).toBe(false);
      probe.mockRestore();
      let finish!: (value: unknown) => void;
      vi.spyOn(page, 'executeJavaScriptInIsolatedWorld').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const observing = observeModelWebAssist('u1', 'c-idle', tabId);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      await reclaimIdleWebAssistPages(Date.now() + 600_000);
      expect(page.isDestroyed()).toBe(false);
      finish({ ok: true, text: '', elements: [] });
      await observing;
    });

    it('restores an access arriving during asynchronous native close without duplicating the tab', async () => {
      const { tabId, page } = await open();
      const close = vi.spyOn(page, 'close').mockImplementationOnce(() => {});
      await reclaimIdleWebAssistPages(Date.now() + 600_000);
      expect(await observeModelWebAssist('u1', 'c-idle', tabId)).toMatchObject({ ok: false, code: 'page_loading' });
      close.mockRestore();
      page.close();
      expect(electronMock.page).not.toBe(page);
      expect(listModelWebAssistTabs('u1', 'c-idle').tabs).toHaveLength(1);
      expect(await observeModelWebAssist('u1', 'c-idle', tabId)).toMatchObject({ ok: true });
    });

    it.each(['clean', 'password', 'otp', 'text', 'checkbox', 'select', 'file', 'editor', 'media', 'frame', 'session_storage'])(
      'runs the actual reload safety script against %s document hazards without returning content', hazard => {
        const element = { tagName: 'INPUT', type: 'text', value: '', defaultValue: '', checked: false, defaultChecked: false, files: [], options: [], autocomplete: '' } as any;
        if (hazard === 'password') element.type = 'password';
        if (hazard === 'otp') element.autocomplete = 'one-time-code';
        if (hazard === 'text') element.value = 'private-draft';
        if (hazard === 'checkbox') Object.assign(element, { type: 'checkbox', checked: true });
        if (hazard === 'select') Object.assign(element, { tagName: 'SELECT', options: [{ selected: true, defaultSelected: false }] });
        if (hazard === 'file') Object.assign(element, { type: 'file', files: [{}] });
        const document = {
          defaultView: { sessionStorage: { length: hazard === 'session_storage' ? 1 : 0 } },
          querySelector: () => hazard === 'editor' ? {} : null,
          querySelectorAll: (selector: string) => selector === 'input,textarea,select' ? [element]
            : selector === 'audio,video' && hazard === 'media' ? [{ paused: false, ended: false }]
            : selector === 'iframe,frame' && hazard === 'frame' ? [{ contentDocument: null }] : [],
        };
        expect(vm.runInNewContext(webAssistIdleSafetyScript, { document })).toBe(hazard === 'clean');
      },
    );

    it('unloads at ten minutes, retains tab identity, and recreates once on actual observation', async () => {
      const { tabId, page } = await open();
      const observed = await observeModelWebAssist('u1', 'c-idle', tabId);
      await vi.advanceTimersByTimeAsync(599_999);
      expect(page.isDestroyed()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(page.isDestroyed()).toBe(true);
      expect(electronMock.owner.contentView.removeChildView).toHaveBeenCalledOnce();
      const count = electronMock.owner.contentView.addChildView.mock.calls.length;
      for (let i = 0; i < 3; i++) {
        expect(listModelWebAssistTabs('u1', 'c-idle')).toMatchObject({
          tab_limit: TAB_LIMIT, tabs: [{ tab_id: tabId, suspended: true, display_url: 'https://example.com/work?item=1' }],
        });
        webAssistState(electronMock.renderer);
      }
      expect(webAssistState(electronMock.renderer).state.tabs[0].address_url).toBe('https://example.com/work?item=1');
      await openWebAssistInDefaultBrowser(electronMock.renderer);
      expect(electronMock.owner.contentView.addChildView).toHaveBeenCalledTimes(count);
      const fresh = await observeModelWebAssist('u1', 'c-idle', tabId);
      expect(fresh).toMatchObject({ ok: true, tab_id: tabId });
      expect(fresh.page_id).not.toBe(observed.page_id);
      expect(electronMock.page.getURL()).toBe('https://example.com/work?item=1');
      expect(electronMock.page.restoredEntries).toEqual([{ url: 'https://example.com/work?item=1', title: 'Provider console' }]);
      expect(electronMock.owner.contentView.addChildView).toHaveBeenCalledTimes(count + 1);
      expect(await actOnModelWebAssist('u1', 'c-idle', {
        tabId, pageId: observed.page_id, elementRef: 'e1', action: 'fill', text: 'Draft',
      })).toMatchObject({ ok: false, code: 'stale_page' });
    });

    it.each(['activate', 'goto', 'act', 'wait', 'close'] as const)('handles %s on an inactive page without incidental reloads', async operation => {
      const { tabId, page } = await open();
      const observation = await observeModelWebAssist('u1', 'c-idle', tabId);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(page.isDestroyed()).toBe(true);
      const count = electronMock.owner.contentView.addChildView.mock.calls.length;
      if (operation === 'activate') expect(activateWebAssistTab(electronMock.renderer, tabId)).toMatchObject({ ok: true });
      if (operation === 'goto') {
        expect(await navigateModelWebAssist('u1', 'c-idle', { tabId, action: 'goto', url: 'https://example.com/new' })).toMatchObject({ ok: true });
        expect(electronMock.page.getURL()).toBe('https://example.com/new');
        expect(electronMock.page.restoredEntries).toEqual([]);
      }
      if (operation === 'act') expect(await actOnModelWebAssist('u1', 'c-idle', {
        tabId, pageId: observation.page_id, elementRef: 'e1', action: 'click',
      })).toMatchObject({ ok: false, code: 'stale_page' });
      if (operation === 'wait') expect(await waitForModelWebAssist('u1', 'c-idle', { tabId })).toMatchObject({ ok: true });
      if (operation === 'close') expect(closeModelWebAssistTab('u1', 'c-idle', tabId)).toMatchObject({ ok: true, closed: true });
      expect(electronMock.owner.contentView.addChildView).toHaveBeenCalledTimes(count + (operation === 'close' ? 0 : 1));
    });

    it.each(['visible', 'handoff', 'connector', 'edited', 'media', 'unsafe_document', 'popup', 'post', 'veto'])(
      'retains %s pages without losing work', async protection => {
        const { tabId, page } = await open();
        if (protection === 'visible') layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 600, height: 400 });
        if (protection === 'handoff') {
          beginBrowserTaskRun('u1', 'c-idle', 'r1');
          retainModelWebAssistTab('u1', 'c-idle', tabId, 'handoff');
          finishBrowserTaskRun('u1', 'c-idle', 'r1');
        }
        if (protection === 'connector') {
          closeModelWebAssistTab('u1', 'c-idle', tabId);
          await openControlledWebAssist('u1', 'c-idle', { scope: 'connector_setup', scopeId: 'shop', url: 'https://example.com/login' });
        }
        if (protection === 'edited') page.emit('before-input-event', {}, { type: 'keyDown' });
        if (protection === 'media') page.audible = true;
        if (protection === 'unsafe_document') page.idleSafe = false;
        if (protection === 'popup') {
          const popup = { webContents: electronMock.createPage!(), setMenuBarVisibility() {} };
          page.emit('did-create-window', popup);
        }
        if (protection === 'post') electronMock.beforeRequest({ resourceType: 'mainFrame', method: 'POST', webContentsId: page.id }, () => {});
        if (protection === 'veto') page.vetoUnload = true;
        const protectedPage = electronMock.page;
        await vi.advanceTimersByTimeAsync(1_200_000);
        expect(protectedPage.isDestroyed()).toBe(false);
        expect(listModelWebAssistTabs('u1', 'c-idle').tabs).not.toEqual([]);
        expect(webAssistState(electronMock.renderer).state.tabs.every(tab => !tab.suspended)).toBe(true);
      },
    );

    it('starts inactivity when hidden rather than expiring a page still in use', async () => {
      const { page } = await open();
      layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 600, height: 400 });
      await vi.advanceTimersByTimeAsync(1_200_000);
      layoutWebAssist(electronMock.renderer, { visible: false });
      await vi.advanceTimersByTimeAsync(599_999);
      expect(page.isDestroyed()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(page.isDestroyed()).toBe(true);
    });

    it('rechecks activity after a delayed safety probe and never overlaps probes', async () => {
      const { tabId, page } = await open();
      let resolve!: (safe: boolean) => void;
      const probe = vi.spyOn(page, 'executeJavaScriptInIsolatedWorld').mockImplementation(() => new Promise<boolean>(done => { resolve = done; }));
      const checking = reclaimIdleWebAssistPages(Date.now() + 600_000);
      await reclaimIdleWebAssistPages(Date.now() + 600_000);
      expect(probe).toHaveBeenCalledTimes(1);
      activateWebAssistTab(electronMock.renderer, tabId);
      layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 600, height: 400 });
      resolve(true);
      await checking;
      expect(page.isDestroyed()).toBe(false);
    });

    it('retains inaccessible pages and retries creation failures without removing the inactive tab', async () => {
      const { tabId, page } = await open();
      const probe = vi.spyOn(page, 'executeJavaScriptInIsolatedWorld').mockRejectedValueOnce(new Error('Fixture inaccessible document'));
      await reclaimIdleWebAssistPages(Date.now() + 600_000);
      expect(page.isDestroyed()).toBe(false);
      probe.mockRestore();
      await vi.advanceTimersByTimeAsync(600_000);
      electronMock.owner.contentView.addChildView.mockImplementationOnce(() => { throw new Error('Fixture native allocation failure'); });
      expect(activateWebAssistTab(electronMock.renderer, tabId)).toMatchObject({ ok: true, state: { tabs: [{ suspended: true, error_code: 'page_load_failed' }] } });
      expect(activateWebAssistTab(electronMock.renderer, tabId)).toMatchObject({ ok: true, state: { tabs: [{ tab_id: tabId }] } });
      expect(electronMock.page.isDestroyed()).toBe(false);
    });

    it('keeps twenty inactive tabs across two independent task quotas and rejects cross-task access', async () => {
      for (const cid of ['c-a', 'c-b']) {
        for (let i = 0; i < 10; i++) await open(cid);
      }
      await vi.advanceTimersByTimeAsync(600_000);
      expect(webAssistState(electronMock.renderer).state.tabs).toHaveLength(20);
      const before = electronMock.owner.contentView.addChildView.mock.calls.length;
      for (const cid of ['c-a', 'c-b']) {
        setActiveWebAssistConversation(electronMock.renderer, cid);
        const listed = listModelWebAssistTabs('u1', cid);
        expect(listed.tab_limit).toBe(TAB_LIMIT);
        expect(listed.tabs).toHaveLength(10);
        expect((listed.tabs as any[]).every(tab => tab.suspended)).toBe(true);
      }
      const aTab = webAssistState(electronMock.renderer).state.tabs.find(tab => tab.conversation_id === 'c-a')!;
      expect(await observeModelWebAssist('u1', 'c-b', aTab.tab_id)).toMatchObject({ ok: false, code: 'unknown_tab' });
      expect(electronMock.owner.contentView.addChildView).toHaveBeenCalledTimes(before);
    });
  });

  it('automatically returns an idle page to AI after the last user input, requiring a fresh observation', async () => {
    vi.useFakeTimers();
    const { renderer } = electronMock;
    try {
      bindWebAssistConversation('u1', 'c-auto-resume', renderer);
      const opened = await openModelWebAssist('u1', 'c-auto-resume', { url: 'https://example.com/draft' });
      const tabId = opened.active_tab_id;
      const page = electronMock.page;
      vi.spyOn(page, 'reload');
      const before = await observeModelWebAssist('u1', 'c-auto-resume', tabId);
      page.emit('before-input-event', {}, { type: 'keyDown', code: 'KeyA', isComposing: false });
      page.emit('before-input-event', {}, { type: 'keyUp', code: 'KeyA', isComposing: false });
      const navigate = () => navigateModelWebAssist('u1', 'c-auto-resume', { tabId, action: 'reload' });
      expect(await navigate()).toMatchObject({ ok: false, code: 'user_controlled' });
      await vi.advanceTimersByTimeAsync(2500);
      page.emit('before-mouse-event', {}, { type: 'mouseWheel', x: 10, y: 10 });
      // Leaving this task must not require returning to a resume button.
      setActiveWebAssistConversation(renderer, 'other-task');
      await vi.advanceTimersByTimeAsync(9999);
      expect(await navigate()).toMatchObject({ ok: false, code: 'user_controlled' });
      expect(page.reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(listModelWebAssistTabs('u1', 'c-auto-resume')).toMatchObject({ tabs: [expect.not.objectContaining({ user_controlled: true })] });
      const fill = (pageId: unknown) => actOnModelWebAssist('u1', 'c-auto-resume', {
        tabId, pageId, elementRef: 'e1', action: 'fill', text: 'AI continues',
      });
      expect(await fill(before.page_id)).toMatchObject({ ok: false, code: 'stale_page' });
      // A new user edit during an in-flight observation cannot mint usable refs.
      const execute = page.executeJavaScriptInIsolatedWorld.bind(page);
      vi.spyOn(page, 'executeJavaScriptInIsolatedWorld').mockImplementationOnce(async (...args: any[]) => {
        const result = await execute(...args);
        page.emit('before-input-event', {}, { type: 'keyDown', code: 'KeyB', isComposing: false });
        page.emit('before-input-event', {}, { type: 'keyUp', code: 'KeyB', isComposing: false });
        return result;
      });
      expect(await observeModelWebAssist('u1', 'c-auto-resume', tabId)).toMatchObject({ ok: false, code: 'page_changed' });
      await vi.advanceTimersByTimeAsync(10_000);
      const fresh = await observeModelWebAssist('u1', 'c-auto-resume', tabId);
      expect(await fill(fresh.page_id)).toMatchObject({ ok: true });
    } finally {
      closeWebAssist(renderer);
      vi.useRealTimers();
    }
  });

  it('keeps a temporary page after human takeover and task completion', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-takeover', renderer);
    beginBrowserTaskRun('u1', 'c-takeover', 'takeover-run');
    const opened = await openModelWebAssist('u1', 'c-takeover', { url: 'https://example.com/draft' });
    const tabId = opened.active_tab_id;
    expect(retainModelWebAssistTab('u1', 'c-takeover', tabId, 'temporary')).toMatchObject({ ok: true });
    electronMock.page.emit('before-input-event', {}, { type: 'keyDown', code: 'KeyA' });
    expect(retainModelWebAssistTab('u1', 'c-takeover', tabId, 'temporary')).toMatchObject({ ok: false, code: 'user_controlled' });
    finishBrowserTaskRun('u1', 'c-takeover', 'takeover-run');
    expect(electronMock.page.isDestroyed()).toBe(false);
    expect(listModelWebAssistTabs('u1', 'c-takeover')).toMatchObject({ tabs: [{ tab_id: tabId, user_controlled: true }] });
    closeWebAssistTab(renderer, tabId);
  });

  it.each(['foreground-tab', 'background-tab', 'default', 'new-window'])('adopts %s pages into task tabs without reloading Chromium guests', async disposition => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-web-links', renderer);
    const opened = await openWebAssist('u1', renderer, { conversationId: 'c-web-links', url: 'https://example.com/shop' });
    if (!opened.ok) throw new Error('opener setup failed');
    const parent = electronMock.page;
    const guest = electronMock.createPage!();
    await guest.loadURL('https://example.com/balance');
    const load = vi.spyOn(guest, 'loadURL');
    const request = parent.windowOpenHandler({ url: 'https://example.com/balance', disposition });
    expect(request).toMatchObject({ action: 'allow', outlivesOpener: true });
    expect(request.createWindow({ webContents: guest })).toBe(guest);
    expect(load).not.toHaveBeenCalled();
    const result = listModelWebAssistTabs('u1', 'c-web-links') as any;
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs[1]).toMatchObject({ display_url: 'https://example.com/balance', created_by: 'user' });
    expect(result.active_tab_id).toBe(disposition === 'background-tab' ? opened.state.active_tab_id : result.tabs[1].tab_id);
    guest.close();
    expect((listModelWebAssistTabs('u1', 'c-web-links') as any).tabs).toHaveLength(1);
  });

  it('preserves deferred navigation data and denies page-created tabs at the protected capacity limit', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-link-limit', renderer);
    await openWebAssist('u1', renderer, { conversationId: 'c-link-limit', url: 'https://example.com/shop' });
    const parent = electronMock.page;
    const referrer = { url: 'https://example.com/shop', policy: 'strict-origin-when-cross-origin' };
    const data = [{ type: 'rawData', bytes: Buffer.from('period=month') }];
    const request = parent.windowOpenHandler({ url: 'https://example.com/statement', disposition: 'background-tab', referrer, postBody: { data, contentType: 'application/x-www-form-urlencoded' } });
    const load = vi.spyOn(Object.getPrototypeOf(parent), 'loadURL');
    request.createWindow({});
    expect(load).toHaveBeenLastCalledWith('https://example.com/statement', {
      httpReferrer: referrer, postData: data, extraHeaders: 'content-type: application/x-www-form-urlencoded',
    });
    load.mockRestore();
    for (let i = 2; i < TAB_LIMIT; i++) await addWebAssistTab('u1', renderer, { conversationId: 'c-link-limit' });
    expect(parent.windowOpenHandler({ url: 'https://example.com/extra', disposition: 'foreground-tab' })).toEqual({ action: 'deny' });
    expect((listModelWebAssistTabs('u1', 'c-link-limit') as any).tabs).toHaveLength(TAB_LIMIT);
  });

  it.each(['browser', 'connector', 'task completion', 'user'].flatMap(source =>
    [false, true].map(otherTask => ({ source, otherTask }))))(
    'requests browser dismissal only after the last model close: $source, other task=$otherTask',
    async ({ source, otherTask }) => {
      const { renderer } = electronMock;
      const cid = 'c-dismiss-browser';
      bindWebAssistConversation('u1', cid, renderer);
      const open = async (scopeId: string) => {
        if (source === 'connector') {
          const opened = await openControlledWebAssist('u1', cid, {
            scope: 'connector_setup', scopeId, url: 'https://example.com/work',
          });
          if (!opened.ok) throw new Error('connector page setup failed');
          return opened.state.active_tab_id!;
        }
        const opened = await openModelWebAssist('u1', cid, { url: 'https://example.com/work' });
        expect(opened.ok).toBe(true);
        return String(opened.active_tab_id);
      };
      const first = await open('first');
      const last = await open('last');
      if (otherTask) {
        bindWebAssistConversation('u1', 'c-other', renderer);
        await openModelWebAssist('u1', 'c-other', { url: 'https://example.com/other' });
      }
      const close = async (id: string, scopeId: string) => {
        if (source === 'user') return closeWebAssistTab(renderer, id);
        if (source === 'connector') return navigateControlledWebAssist('u1', cid, scopeId, 'close');
        if (source === 'task completion') {
          beginBrowserTaskRun('u1', cid, scopeId);
          expect(retainModelWebAssistTab('u1', cid, id, 'temporary').ok).toBe(true);
          finishBrowserTaskRun('u1', cid, scopeId);
          return { ok: true };
        }
        return closeModelWebAssistTab('u1', cid, id);
      };
      const pushedState = () => renderer.send.mock.calls
        .filter(([channel]: any[]) => channel === 'web-assist:state').at(-1)?.[1];
      renderer.send.mockClear();
      expect((await close(first, 'first')).ok).toBe(true);
      expect(pushedState()).not.toHaveProperty('model_closed_conversation_id');
      expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ tabs: [{ tab_id: last }] });
      renderer.send.mockClear();
      expect((await close(last, 'last')).ok).toBe(true);
      expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ tabs: [] });
      if (source === 'user') expect(pushedState()).not.toHaveProperty('model_closed_conversation_id');
      else expect(pushedState()).toMatchObject({ model_closed_conversation_id: cid });
      // This is a one-shot chrome event, not retained browser or model state.
      expect(webAssistState(renderer).state).not.toHaveProperty('model_closed_conversation_id');
      expect(listModelWebAssistTabs('u1', cid)).not.toHaveProperty('model_closed_conversation_id');
      if (otherTask) expect(listModelWebAssistTabs('u1', 'c-other').tabs).toHaveLength(1);
    },
  );

  it('keeps browser chrome available when the model closes its page but a user page remains', async () => {
    const { renderer } = electronMock;
    const cid = 'c-mixed-close';
    bindWebAssistConversation('u1', cid, renderer);
    const user = await openWebAssist('u1', renderer, { conversationId: cid, url: 'https://example.com/user' });
    if (!user.ok) throw new Error('user page setup failed');
    const model = await openModelWebAssist('u1', cid, { url: 'https://example.com/model' });
    renderer.send.mockClear();
    expect(closeModelWebAssistTab('u1', cid, model.active_tab_id)).toMatchObject({ ok: true });
    expect(listModelWebAssistTabs('u1', cid)).toMatchObject({
      tabs: [{ tab_id: user.state.active_tab_id, created_by: 'user' }],
    });
    const states = renderer.send.mock.calls.filter(([channel]: any[]) => channel === 'web-assist:state');
    expect(states).toHaveLength(1);
    expect(states[0][1]).not.toHaveProperty('model_closed_conversation_id');
  });

  it.each(['temporary', 'deliverable', 'handoff', undefined] as const)('applies open retention %s before publication and cleans only a temporary page', async retention => {
    const { renderer, owner } = electronMock;
    const cid = 'c-open-retention';
    bindWebAssistConversation('u1', cid, renderer);
    beginBrowserTaskRun('u1', cid, 'open-policy-run');
    try {
      const opened = await openModelWebAssist('u1', cid, { url: 'https://example.com/work', ...(retention ? { retention } : {}) });
      expect(opened.ok).toBe(true);
      const native = electronMock.page;
      const published = renderer.send.mock.calls.filter(([channel]: any[]) => channel === 'web-assist:state');
      expect(published.length).toBeGreaterThan(0);
      for (const [, state] of published) {
        const tab = state.tabs.find((tab: any) => tab.tab_id === opened.active_tab_id);
        if (retention) expect(tab.retention).toBe(retention);
        else expect(tab).not.toHaveProperty('retention');
      }
      finishBrowserTaskRun('u1', cid, 'open-policy-run');
      expect(native.isDestroyed()).toBe(retention === 'temporary');
      expect(listModelWebAssistTabs('u1', cid).tabs).toHaveLength(retention === 'temporary' ? 0 : 1);
      expect(owner.contentView.removeChildView).toHaveBeenCalledTimes(retention === 'temporary' ? 1 : 0);
    } finally { closeWebAssist(renderer); }
  });

  it('protects immediate user takeover even when the task finishes before open returns', async () => {
    const { renderer } = electronMock;
    const cid = 'c-open-takeover';
    bindWebAssistConversation('u1', cid, renderer);
    beginBrowserTaskRun('u1', cid, 'takeover-open-run');
    let publishedPolicy: unknown;
    let taken = false;
    renderer.send.mockImplementation((channel: string, state: any) => {
      const tab = state.tabs?.find((tab: any) => tab.created_by === 'model');
      if (channel !== 'web-assist:state' || !tab || taken) return;
      taken = true;
      publishedPolicy = tab.retention;
      electronMock.page.emit('before-input-event', {}, { type: 'keyDown', code: 'KeyA' });
      finishBrowserTaskRun('u1', cid, 'takeover-open-run');
    });
    try {
      const opened = await openModelWebAssist('u1', cid, { url: 'https://example.com/draft', retention: 'temporary' });
      expect(publishedPolicy).toBe('temporary');
      expect(opened).toMatchObject({ ok: true, tab: { retention: 'handoff', user_controlled: true } });
      expect(electronMock.page.isDestroyed()).toBe(false);
      expect(listModelWebAssistTabs('u1', cid).tabs).toHaveLength(1);
    } finally {
      renderer.send.mockReset();
      closeWebAssist(renderer);
    }
  });

  it.each(['ended', 'replaced'] as const)('does not allocate a retained page after its task %s during cache preparation', async outcome => {
    const { renderer, owner } = electronMock;
    const cid = 'c-open-late-retention';
    bindWebAssistConversation('u1', cid, renderer);
    beginBrowserTaskRun('u1', cid, 'open-original-run');
    let release!: () => void;
    vi.mocked(prepareWebAssistCache).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const opening = openModelWebAssist('u1', cid, { url: 'https://example.com/work', retention: 'temporary' });
    finishBrowserTaskRun('u1', cid, 'open-original-run');
    if (outcome === 'replaced') beginBrowserTaskRun('u1', cid, 'open-next-run');
    release();
    try {
      expect(await opening).toMatchObject({ ok: false, code: 'task_run_ended' });
      expect(owner.contentView.addChildView).not.toHaveBeenCalled();
      expect(listModelWebAssistTabs('u1', cid).tabs).toHaveLength(0);
      expect(renderer.send).not.toHaveBeenCalled();
    } finally {
      finishBrowserTaskRun('u1', cid, 'open-next-run');
      closeWebAssist(renderer);
    }
  });

  it('refuses open retention without an active task before creating a page', async () => {
    const { renderer, owner } = electronMock;
    bindWebAssistConversation('u1', 'c-open-no-run', renderer);
    try {
      expect(await openModelWebAssist('u1', 'c-open-no-run', { url: 'https://example.com/work', retention: 'temporary' }))
        .toMatchObject({ ok: false, code: 'no_active_run' });
      expect(owner.contentView.addChildView).not.toHaveBeenCalled();
    } finally { closeWebAssist(renderer); }
  });

  it('rejects malformed open retention before browser allocation or navigation', async () => {
    const { renderer, owner } = electronMock;
    bindWebAssistConversation('u1', 'c-open-invalid-retention', renderer);
    beginBrowserTaskRun('u1', 'c-open-invalid-retention', 'invalid-policy-run');
    try {
      for (const retention of ['forever', 'Temporary', '', null, {}, 1]) {
        expect(await openModelWebAssist('u1', 'c-open-invalid-retention', { url: 'https://example.com/work', retention }))
          .toMatchObject({ ok: false, code: 'invalid_retention' });
      }
      expect(owner.contentView.addChildView).not.toHaveBeenCalled();
      expect(renderer.send).not.toHaveBeenCalled();
    } finally {
      finishBrowserTaskRun('u1', 'c-open-invalid-retention', 'invalid-policy-run');
      closeWebAssist(renderer);
    }
  });

  it('only cleans explicitly temporary pages and resumes an unmarked login across turns', async () => {
    const { renderer, owner } = electronMock;
    const cid = 'c-lifetimes';
    bindWebAssistConversation('u1', cid, renderer);
    beginBrowserTaskRun('u1', cid, 'first');
    const manual = await openWebAssist('u1', renderer, { conversationId: cid, url: 'https://example.com/user' });
    if (!manual.ok) throw new Error('manual page setup failed');
    const manualId = manual.state.active_tab_id!;
    await observeModelWebAssist('u1', cid, manualId);
    const temporary = await openModelWebAssist('u1', cid, { url: 'https://example.com/research' });
    const result = await openModelWebAssist('u1', cid, { url: 'https://example.com/result' });
    const handoff = await openControlledWebAssist('u1', cid, {
      scope: 'connector_setup', scopeId: 'shop', url: 'https://example.com/login',
    });
    if (!handoff.ok) throw new Error('handoff page setup failed');
    const resultId = String(result.active_tab_id);
    const handoffId = handoff.state.active_tab_id!;
    const beforeLogin = await observeControlledWebAssist('u1', cid, 'shop');
    expect(temporary).toMatchObject({ ok: true, tab: { created_by: 'model' } });
    expect(temporary.tab).not.toHaveProperty('retention');
    expect(retainModelWebAssistTab('u1', cid, temporary.active_tab_id, 'temporary'))
      .toMatchObject({ ok: true, tab: { retention: 'temporary' } });
    expect(retainModelWebAssistTab('u1', cid, resultId, 'temporary')).toMatchObject({ ok: true });
    expect(retainModelWebAssistTab('u1', cid, resultId, 'handoff')).toMatchObject({ ok: true });
    expect(retainModelWebAssistTab('u1', cid, resultId, 'deliverable'))
      .toMatchObject({ ok: true, tab: { retention: 'deliverable' } });
    // Reproduce a model handing login to the user without calling retain at all.
    expect(handoff.state.tabs.find(tab => tab.tab_id === handoffId)).not.toHaveProperty('retention');
    expect(retainModelWebAssistTab('u1', cid, manualId, 'deliverable'))
      .toMatchObject({ ok: false, code: 'user_owned_tab' });
    expect(retainModelWebAssistTab('u1', cid, manualId, 'temporary'))
      .toMatchObject({ ok: false, code: 'user_owned_tab' });
    const pages = owner.contentView.addChildView.mock.calls.map(([view]: any[]) => view.webContents);

    finishBrowserTaskRun('u1', cid, 'first');
    expect(pages.map((page: any) => page.isDestroyed())).toEqual([false, true, false, false]);
    expect(listModelWebAssistTabs('u1', cid)).toMatchObject({
      tabs: [{ tab_id: manualId, created_by: 'user' }, { tab_id: resultId, retention: 'deliverable' }, { tab_id: handoffId }],
    });
    beginBrowserTaskRun('u1', cid, 'second');
    // The user completed login in the retained page. A later turn must see
    // that page, not reopen the login URL or reuse pre-login element refs.
    await pages[3].loadURL('https://example.com/applications');
    const resumed = await observeControlledWebAssist('u1', cid, 'shop');
    expect(resumed).toMatchObject({ ok: true, tab_id: handoffId, display_url: 'https://example.com/applications' });
    expect(resumed.page_id).not.toBe(beforeLogin.page_id);
    expect(await actOnControlledWebAssist('u1', cid, 'shop', {
      pageId: beforeLogin.page_id, elementRef: 'e1', action: 'fill', text: 'Application',
    })).toMatchObject({ ok: false, code: 'stale_page' });
    expect(await actOnControlledWebAssist('u1', cid, 'shop', {
      pageId: resumed.page_id, elementRef: 'e1', action: 'fill', text: 'Application',
    })).toMatchObject({ ok: true, outcome: 'acted' });
    // No re-mark is required. Repeated start/old terminal events are harmless.
    beginBrowserTaskRun('u1', cid, 'second');
    finishBrowserTaskRun('u1', cid, 'first');
    expect(pages[3].isDestroyed()).toBe(false);
    finishBrowserTaskRun('u1', cid, 'second');
    expect(pages.map((page: any) => page.isDestroyed())).toEqual([false, true, false, false]);
    expect(listModelWebAssistTabs('u1', cid)).toMatchObject({
      tabs: [{ tab_id: manualId }, { tab_id: resultId, retention: 'deliverable' }, { tab_id: handoffId }],
    });
    beginBrowserTaskRun('u1', cid, 'third');
    expect(retainModelWebAssistTab('u1', cid, resultId, 'temporary')).toMatchObject({ ok: true });
    finishBrowserTaskRun('u1', cid, 'third');
    expect(pages[3].isDestroyed()).toBe(false);
    expect(closeModelWebAssistTab('u1', cid, handoffId)).toMatchObject({ ok: true });
    expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ tabs: [{ tab_id: manualId }] });
    expect(pages[2].isDestroyed()).toBe(true);
  });

  it('cleans a finished task in the background without closing another task or allowing forged retention', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-cleanup', renderer);
    beginBrowserTaskRun('u1', 'c-cleanup', 'run-cleanup');
    const first = await openModelWebAssist('u1', 'c-cleanup', { url: 'https://example.com/first' });
    expect(retainModelWebAssistTab('u1', 'c-cleanup', first.active_tab_id, 'temporary')).toMatchObject({ ok: true });
    const firstPage = electronMock.page;
    bindWebAssistConversation('u1', 'c-active', renderer);
    beginBrowserTaskRun('u1', 'c-active', 'run-active');
    const second = await openModelWebAssist('u1', 'c-active', { url: 'https://example.com/second' });
    const secondPage = electronMock.page;
    expect(retainModelWebAssistTab('u1', 'c-active', first.active_tab_id, 'deliverable'))
      .toMatchObject({ ok: false, code: 'unknown_tab' });
    expect(retainModelWebAssistTab('u1', 'c-active', second.active_tab_id, 'forever'))
      .toMatchObject({ ok: false, code: 'invalid_retention' });
    finishBrowserTaskRun('another-user', 'c-cleanup', 'run-cleanup');
    expect(firstPage.isDestroyed()).toBe(false);
    finishBrowserTaskRun('u1', 'c-cleanup', 'run-cleanup');
    expect(firstPage.isDestroyed()).toBe(true);
    expect(secondPage.isDestroyed()).toBe(false);
    expect(listModelWebAssistTabs('u1', 'c-active')).toMatchObject({ active_tab_id: second.active_tab_id });
    finishBrowserTaskRun('u1', 'c-active', 'run-active');
    expect(secondPage.isDestroyed()).toBe(false);
    expect(closeModelWebAssistTab('u1', 'c-active', second.active_tab_id)).toMatchObject({ ok: true });
    expect(secondPage.isDestroyed()).toBe(true);
    expect(listModelWebAssistTabs('u1', 'c-active')).toMatchObject({ tabs: [] });
  });

  it('binds control to the conversation, connector, and latest page snapshot', async () => {
    const { renderer } = electronMock;
    expect(bindWebAssistConversation('u1', 'c1', renderer)).toBe(true);

    const opened = await openControlledWebAssist('u1', 'c1', {
      scope: 'connector_setup',
      scopeId: 'xiaohongshu-seller',
      url: 'https://provider.example/setup',
      label: 'Xiaohongshu Seller',
    });
    expect(opened).toMatchObject({ ok: true, state: { assistant_controlled: true } });
    expect(renderer.send).toHaveBeenCalledWith(
      'web-assist:show',
      expect.objectContaining({ open: true, assistant_controlled: true }),
    );

    await expect(observeControlledWebAssist('u1', 'c1', 'another-connector')).resolves.toMatchObject({
      ok: false,
      code: 'scope_mismatch',
    });

    const observation = await observeControlledWebAssist('u1', 'c1', 'xiaohongshu-seller');
    expect(observation).toMatchObject({
      ok: true,
      untrusted_content: true,
      elements: [{ ref: 'e1', label: 'Application name', fillable: true }],
    });
    expect(JSON.stringify(observation)).not.toContain('must-not-escape');
    expect(JSON.stringify(observation)).not.toContain('"path"');

    await expect(actOnControlledWebAssist('u1', 'c1', 'xiaohongshu-seller', {
      pageId: 'stale-page',
      elementRef: 'e1',
      action: 'fill',
      text: 'Orkas app',
    })).resolves.toMatchObject({ ok: false, code: 'stale_page' });

    await expect(actOnControlledWebAssist('u1', 'c1', 'xiaohongshu-seller', {
      pageId: observation.page_id,
      elementRef: 'e1',
      action: 'fill',
      text: 'Orkas app',
    })).resolves.toMatchObject({ ok: true, outcome: 'acted' });

    await expect(actOnControlledWebAssist('u1', 'c1', 'xiaohongshu-seller', {
      pageId: observation.page_id,
      elementRef: 'e1',
      action: 'fill',
      text: 'Second write',
    })).resolves.toMatchObject({ ok: true });

    await expect(navigateControlledWebAssist(
      'u1', 'c1', 'xiaohongshu-seller', 'close',
    )).resolves.toMatchObject({ ok: true, closed: true });
    await expect(observeControlledWebAssist('u1', 'c1', 'xiaohongshu-seller')).resolves.toMatchObject({
      ok: false,
      code: 'not_open',
    });
  });

  it.each(['observation_failure', 'loading', 'human_input'] as const)(
    'reuses the exact setup page after %s without navigating or discarding current state', async state => {
      const cid = 'c-reopen-setup';
      const renderer = electronMock.renderer;
      bindWebAssistConversation('u1', cid, renderer);
      const input = { scope: 'connector_setup' as const, scopeId: 'shop', url: 'https://provider.example/setup' };
      const opened = await openControlledWebAssist('u1', cid, input);
      if (!opened.ok) throw new Error('controlled page setup failed');
      const page = electronMock.page;
      const load = vi.spyOn(page, 'loadURL');
      const read = vi.spyOn(page, 'executeJavaScriptInIsolatedWorld');
      if (state === 'observation_failure') {
        read.mockRejectedValueOnce(new Error('fixture observation failure'));
        expect(await observeControlledWebAssist('u1', cid, 'shop')).toMatchObject({ ok: false, code: 'observation_failed' });
      }
      if (state === 'loading') page.emit('did-start-loading');
      if (state === 'human_input') {
        page.emit('before-input-event', {}, { type: 'keyDown', code: 'KeyA', isComposing: false });
        page.emit('before-input-event', {}, { type: 'keyUp', code: 'KeyA', isComposing: false });
      }
      const readsBefore = read.mock.calls.length;
      const resumed = await openControlledWebAssist('u1', cid, input);
      expect(resumed).toMatchObject({ ok: true, state: { active_tab_id: opened.state.active_tab_id,
        ...(state === 'loading' ? { loading: true } : {}), ...(state === 'human_input' ? { user_controlled: true } : {}) } });
      expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ tabs: [{ tab_id: opened.state.active_tab_id }] });
      expect(electronMock.page).toBe(page);
      expect(load).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(readsBefore);
      expect(page.isDestroyed()).toBe(false);
      closeWebAssist(renderer);
    },
  );

  it('keeps an existing setup page when showing it fails, then reuses it on retry', async () => {
    const renderer = electronMock.renderer;
    const cid = 'c-setup-reveal-failure';
    bindWebAssistConversation('u1', cid, renderer);
    const input = { scope: 'connector_setup' as const, scopeId: 'shop', url: 'https://provider.example/setup' };
    const first = await openControlledWebAssist('u1', cid, input);
    if (!first.ok) throw new Error('controlled page setup failed');
    const page = electronMock.page;
    renderer.send.mockImplementation((channel: string) => {
      if (channel === 'web-assist:show') throw new Error('fixture renderer delivery failed');
    });
    try {
      expect(await openControlledWebAssist('u1', cid, input)).toMatchObject({ ok: false, code: 'renderer_unavailable' });
      expect(page.isDestroyed()).toBe(false);
      expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ tabs: [{ tab_id: first.state.active_tab_id }] });
    } finally { renderer.send.mockReset(); }
    expect(await openControlledWebAssist('u1', cid, input)).toMatchObject({ ok: true, state: { active_tab_id: first.state.active_tab_id } });
    expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ tabs: [{ tab_id: first.state.active_tab_id }] });
    closeWebAssist(renderer);
  });

  it('rejects an unsafe guide even when a setup page exists, and opens a fresh page after explicit closure', async () => {
    const renderer = electronMock.renderer;
    const cid = 'c-setup-reopen-boundary';
    bindWebAssistConversation('u1', cid, renderer);
    const input = { scope: 'connector_setup' as const, scopeId: 'shop', url: 'https://provider.example/setup' };
    const first = await openControlledWebAssist('u1', cid, input);
    if (!first.ok) throw new Error('controlled page setup failed');
    expect(await openControlledWebAssist('u1', cid, { ...input, url: 'file:///private' }))
      .toMatchObject({ ok: false, code: 'invalid_url' });
    expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ tabs: [{ tab_id: first.state.active_tab_id }] });
    expect(closeModelWebAssistTab('u1', cid, first.state.active_tab_id)).toMatchObject({ ok: true });
    const next = await openControlledWebAssist('u1', cid, input);
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error('controlled page reopen failed');
    expect(next.state.active_tab_id).not.toBe(first.state.active_tab_id);
    expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ tabs: [{ tab_id: next.state.active_tab_id }] });
    closeWebAssist(renderer);
  });

  it('reselects an existing setup page in the foreground without replacing its other task tab', async () => {
    const renderer = electronMock.renderer;
    const cid = 'c-setup-selection';
    bindWebAssistConversation('u1', cid, renderer);
    const input = { scope: 'connector_setup' as const, scopeId: 'shop', url: 'https://provider.example/setup' };
    const first = await openControlledWebAssist('u1', cid, input);
    if (!first.ok) throw new Error('controlled page setup failed');
    const other = await openWebAssist('u1', renderer, { conversationId: cid, url: 'https://unrelated.example/work' });
    if (!other.ok) throw new Error('other page setup failed');
    expect(webAssistState(renderer).state.active_tab_id).toBe(other.tab_id);
    expect(await openControlledWebAssist('u1', cid, input)).toMatchObject({ ok: true, state: { active_tab_id: first.state.active_tab_id } });
    expect(webAssistState(renderer).state.active_tab_id).toBe(first.state.active_tab_id);
    expect(listModelWebAssistTabs('u1', cid).tabs).toHaveLength(2);
    expect(closeModelWebAssistTab('u1', cid, other.tab_id)).toMatchObject({ ok: true });
    closeWebAssist(renderer);
  });

  it('keeps a connector-controlled tab scoped while the user opens another task tab', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c2', renderer);
    await openControlledWebAssist('u1', 'c2', {
      scope: 'connector_setup',
      scopeId: 'shop-connector',
      url: 'https://provider.example/setup',
    });

    const manual = await openWebAssist('u1', renderer, {
      url: 'https://unrelated.example/',
      label: 'Other work',
      conversationId: 'c2',
    });
    expect(manual).toMatchObject({ ok: true, state: { tabs: [{ assistant_controlled: true }, {}] } });

    await expect(observeControlledWebAssist('u1', 'c2', 'shop-connector')).resolves.toMatchObject({
      ok: true,
      untrusted_content: true,
    });
  });

  it('shares the current task tab with general in-process model browsing', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-browser', renderer);
    const opened = await openModelWebAssist('u1', 'c-browser', {
      url: 'https://example.com/start?secret=hidden',
      label: 'Shared page',
    });
    expect(opened).toMatchObject({
      ok: true,
      tab: { label: 'Shared page', display_url: 'https://example.com/start?secret=%5Bredacted%5D' },
    });
    expect(renderer.send).toHaveBeenCalledWith(
      'web-assist:show',
      expect.objectContaining({ conversation_id: 'c-browser', assistant_controlled: true }),
    );
    const tabs = listModelWebAssistTabs('u1', 'c-browser');
    expect(tabs).toMatchObject({ ok: true, tabs: [{ conversation_id: 'c-browser' }] });
    const tabId = (opened as any).active_tab_id;
    const observation = await observeModelWebAssist('u1', 'c-browser', tabId);
    expect(observation).toMatchObject({ ok: true, tab_id: tabId, untrusted_content: true });
    await expect(actOnModelWebAssist('u1', 'c-browser', {
      tabId,
      pageId: observation.page_id,
      elementRef: 'e1',
      action: 'fill',
      text: 'Shared draft',
    })).resolves.toMatchObject({ ok: true, outcome: 'acted' });
    await expect(navigateModelWebAssist('u1', 'c-browser', {
      tabId,
      action: 'goto',
      url: 'https://example.com/next',
    })).resolves.toMatchObject({ ok: true, action: 'goto' });
    await expect(waitForModelWebAssist('u1', 'c-browser', {
      tabId,
      condition: 'loaded',
      timeoutMs: 500,
    })).resolves.toMatchObject({ ok: true, tab_id: tabId });
    const manualNavigation = await navigateWebAssistTo(renderer, {
      tabId,
      url: 'https://example.com/user-selected',
    });
    expect(manualNavigation).toMatchObject({
      ok: true,
      state: { display_url: 'https://example.com/user-selected' },
    });
    expect((manualNavigation as any).state.assistant_controlled).toBeUndefined();
    await expect(observeModelWebAssist('u1', 'c-browser', tabId)).resolves.toMatchObject({
      ok: true,
      tab_id: tabId,
    });
    expect(listModelWebAssistTabs('u1', 'c-browser')).toMatchObject({
      ok: true,
      tabs: [{ assistant_controlled: true }],
    });
    expect(setActiveWebAssistConversation(renderer, '')).toEqual({ ok: true });
    // Off-task work requests a deferred reveal owned by its originating task.
    renderer.send.mockClear();
    await expect(observeModelWebAssist('u1', 'c-browser', tabId))
      .resolves.toMatchObject({ ok: true, tab_id: tabId });
    expect(renderer.send).toHaveBeenCalledWith('web-assist:show', expect.objectContaining({
      browser_activity_conversation_id: 'c-browser',
    }));
    expect(setActiveWebAssistConversation(renderer, 'c-browser')).toEqual({ ok: true });
    expect(closeModelWebAssistTab('u1', 'c-browser', tabId)).toMatchObject({
      ok: true, closed: true, tab_id: tabId,
    });
    expect(listModelWebAssistTabs('u1', 'other-task')).toMatchObject({ ok: false });
  });

  it('keeps the visible native page mounted while the model observes the selected tab', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-visible', renderer);
    const opened = await openModelWebAssist('u1', 'c-visible', {
      url: 'https://example.com/visible',
    });
    if (opened.ok !== true) throw new Error('model browser setup failed');
    const tabId = String(opened.active_tab_id || '');
    const view = electronMock.owner.contentView.addChildView.mock.calls[0][0];
    const visibility = vi.spyOn(view, 'setVisible');

    expect(layoutWebAssist(renderer, { x: 640, y: 80, width: 520, height: 640 })).toMatchObject({ ok: true });
    expect(visibility).toHaveBeenLastCalledWith(true);

    await expect(observeModelWebAssist('u1', 'c-visible', tabId)).resolves.toMatchObject({ ok: true });
    expect(visibility).toHaveBeenLastCalledWith(true);
  });

  it('enforces the long-article bound in the host before running any page script', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-long-article', renderer);
    const opened = await openModelWebAssist('u1', 'c-long-article', { url: 'https://example.com/editor' });
    const tabId = opened.active_tab_id;
    const observed = await observeModelWebAssist('u1', 'c-long-article', tabId);
    const execute = vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld');
    const input = { tabId, pageId: observed.page_id, elementRef: 'e1', action: 'fill' };
    for (const text of ['x'.repeat(100001), 'article\u0000body']) {
      expect(await actOnModelWebAssist('u1', 'c-long-article', { ...input, text }))
        .toMatchObject({ ok: false, code: 'invalid_text' });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(await actOnModelWebAssist('u1', 'c-long-article', { ...input, text: '文'.repeat(100000) }))
      .toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('navigates a background model tab without changing the foreground selection', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-navigation-background', renderer);
    const background = await openModelWebAssist('u1', 'c-navigation-background', { url: 'https://example.com/before' });
    const backgroundPage = electronMock.page;
    bindWebAssistConversation('u1', 'c-navigation-foreground', renderer);
    const foreground = await openModelWebAssist('u1', 'c-navigation-foreground', { url: 'https://unrelated.example/current' });
    const foregroundPage = electronMock.page;
    renderer.send.mockClear();
    await expect(navigateModelWebAssist('u1', 'c-navigation-background', {
      tabId: background.active_tab_id, action: 'goto', url: 'https://example.com/after',
    })).resolves.toMatchObject({ ok: true, tab: { tab_id: background.active_tab_id, display_url: 'https://example.com/after' } });
    expect(backgroundPage.getURL()).toBe('https://example.com/after');
    expect(foregroundPage.getURL()).toBe('https://unrelated.example/current');
    expect(webAssistState(renderer).state.active_tab_id).toBe(foreground.active_tab_id);
    expect(renderer.send.mock.calls.length).toBeGreaterThan(0);
    for (const [channel, state] of renderer.send.mock.calls) {
      if (channel === 'web-assist:activity') {
        expect(state).toEqual({ conversation_id: 'c-navigation-background' });
      } else if (channel === 'web-assist:show') {
        expect(state).toEqual({ browser_activity_conversation_id: 'c-navigation-background' });
      } else {
        expect(channel).toBe('web-assist:state');
        expect(state.active_tab_id).toBe(foreground.active_tab_id);
      }
    }
    // The same tab still activates when the user navigates it explicitly.
    await expect(navigateWebAssistTo(renderer, { tabId: background.active_tab_id, url: 'https://example.com/manual' }))
      .resolves.toMatchObject({ ok: true, state: { active_tab_id: background.active_tab_id } });
    closeWebAssist(renderer);
  });

  it('binds a background connector to its new task tab without controlling the foreground page', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-setup-background', renderer);
    bindWebAssistConversation('u1', 'c-foreground', renderer);
    const foreground = await openModelWebAssist('u1', 'c-foreground', { url: 'https://unrelated.example/private' });
    const foregroundPage = electronMock.page;
    renderer.send.mockClear();
    const opened = await openControlledWebAssist('u1', 'c-setup-background', {
      scope: 'connector_setup', scopeId: 'shop', url: 'https://provider.example/setup',
    });
    if (!opened.ok) throw new Error('controlled background setup failed');
    const setupPage = electronMock.page;
    const setupId = opened.state.active_tab_id;
    expect(setupId).not.toBe(foreground.active_tab_id);
    expect(opened.state).toMatchObject({ conversation_id: 'c-setup-background', display_url: 'https://provider.example/setup' });
    expect(opened.state.tabs.every(tab => tab.conversation_id === 'c-setup-background')).toBe(true);
    expect(webAssistState(renderer).state.active_tab_id).toBe(foreground.active_tab_id);
    expect(renderer.send).toHaveBeenCalledWith('web-assist:show', { browser_activity_conversation_id: 'c-setup-background' });
    const setupReads = vi.spyOn(setupPage, 'executeJavaScriptInIsolatedWorld');
    const foregroundReads = vi.spyOn(foregroundPage, 'executeJavaScriptInIsolatedWorld');
    const observed = await observeControlledWebAssist('u1', 'c-setup-background', 'shop');
    expect(observed).toMatchObject({ ok: true, tab_id: setupId });
    expect(setupReads).toHaveBeenCalled();
    expect(foregroundReads).not.toHaveBeenCalled();
    await expect(actOnControlledWebAssist('u1', 'c-setup-background', 'shop', {
      pageId: observed.page_id, elementRef: 'e1', action: 'fill', text: 'Fixture app',
    })).resolves.toMatchObject({ ok: true });
    expect(foregroundReads).not.toHaveBeenCalled();
    expect(webAssistState(renderer).state.active_tab_id).toBe(foreground.active_tab_id);
    expect(await openControlledWebAssist('u1', 'c-setup-background', {
      scope: 'connector_setup', scopeId: 'shop', url: 'https://provider.example/setup',
    })).toMatchObject({ ok: true, state: { active_tab_id: setupId } });
    expect(webAssistState(renderer).state.active_tab_id).toBe(foreground.active_tab_id);
    expect(listModelWebAssistTabs('u1', 'c-setup-background')).toMatchObject({ tabs: [{ tab_id: setupId }] });
    expect(closeModelWebAssistTab('u1', 'c-setup-background', foreground.active_tab_id)).toMatchObject({ ok: false });
    expect(foregroundPage.isDestroyed()).toBe(false);
    closeWebAssist(renderer);
  });

  it('keeps unrelated task tabs when revealing a new controlled tab fails', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-existing', renderer);
    const existing = await openModelWebAssist('u1', 'c-existing', { url: 'https://unrelated.example/private' });
    const existingPage = electronMock.page;
    bindWebAssistConversation('u1', 'c-new-setup', renderer);
    renderer.send.mockImplementation((channel: string) => {
      if (channel === 'web-assist:show') throw new Error('fixture renderer delivery failed');
    });
    try {
      await expect(openControlledWebAssist('u1', 'c-new-setup', {
        scope: 'connector_setup', scopeId: 'shop', url: 'https://provider.example/setup',
      })).resolves.toMatchObject({ ok: false, code: 'renderer_unavailable' });
      expect(existingPage.isDestroyed()).toBe(false);
      expect(listModelWebAssistTabs('u1', 'c-existing')).toMatchObject({ tabs: [{ tab_id: existing.active_tab_id }] });
      expect(listModelWebAssistTabs('u1', 'c-new-setup')).toMatchObject({ tabs: [] });
    } finally {
      renderer.send.mockReset();
      closeWebAssist(renderer);
    }
  });

  it.each(['browser', 'connector'])('continues background %s work if its deferred UI notification cannot be delivered', async entry => {
    const { renderer } = electronMock;
    const cid = 'c-deferred-notification';
    bindWebAssistConversation('u1', cid, renderer);
    setActiveWebAssistConversation(renderer, 'c-user-view');
    renderer.send.mockImplementation((channel: string) => {
      if (channel === 'web-assist:show') throw new Error('fixture renderer delivery failed');
    });
    try {
      const opened = entry === 'browser'
        ? await openModelWebAssist('u1', cid, { url: 'https://example.com/draft' })
        : await openControlledWebAssist('u1', cid, { scope: 'connector_setup', scopeId: 'shop', url: 'https://example.com/draft' });
      expect(opened.ok).toBe(true);
      expect(electronMock.page.isDestroyed()).toBe(false);
      expect(listModelWebAssistTabs('u1', cid).tabs).toHaveLength(1);
      const observation = entry === 'browser'
        ? await observeModelWebAssist('u1', cid)
        : await observeControlledWebAssist('u1', cid, 'shop');
      expect(observation).toMatchObject({ ok: true });
      expect(electronMock.owner.contentView.addChildView.mock.calls.every(([view]: any[]) => !view.getVisible())).toBe(true);
    } finally {
      renderer.send.mockReset();
      closeWebAssist(renderer);
    }
  });

  it('selects the connector activity tab for auto-reveal without stealing another task view', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-reveal', renderer);
    const opened = await openControlledWebAssist('u1', 'c-reveal', {
      scope: 'connector_setup', scopeId: 'shop', url: 'https://provider.example/setup',
    });
    if (!opened.ok) throw new Error('controlled page setup failed');
    await addWebAssistTab('u1', renderer, { conversationId: 'c-reveal' });
    renderer.send.mockClear();
    await expect(observeControlledWebAssist('u1', 'c-reveal', 'shop')).resolves.toMatchObject({ ok: true });
    expect(renderer.send).toHaveBeenCalledWith('web-assist:state', expect.objectContaining({
      conversation_id: 'c-reveal', active_tab_id: opened.state.active_tab_id, assistant_action: 'observing',
    }));
    const other = await addWebAssistTab('u1', renderer, { conversationId: 'other-task' });
    if (!other.ok) throw new Error('other task setup failed');
    setActiveWebAssistConversation(renderer, 'other-task');
    renderer.send.mockClear();
    await expect(observeControlledWebAssist('u1', 'c-reveal', 'shop')).resolves.toMatchObject({ ok: true });
    for (const [channel, state] of renderer.send.mock.calls) {
      expect(channel).toBe('web-assist:state');
      expect(state.active_tab_id).toBe(other.state.active_tab_id);
      expect(state.assistant_action).toBeUndefined();
    }
  });

  it('continues connector setup after browser submission without replaying the submitted action', async () => {
    const { renderer } = electronMock;
    const cid = 'c-submit-scope';
    bindWebAssistConversation('u1', cid, renderer);
    const opened = await openControlledWebAssist('u1', cid, {
      scope: 'connector_setup', scopeId: 'shop', url: 'https://provider.example/setup',
    });
    if (!opened.ok) throw new Error('controlled page setup failed');
    class PageElement {
      children: PageElement[] = [];
      parentNode: unknown;
      isConnected = true;
      disabled = false;
      autocomplete = '';
      form: { elements: PageElement[] } | null = null;
      clicks = 0;
      constructor(public tagName: string, public type: string, public innerText: string) {}
      getAttribute(name: string): string | null { return name === 'type' ? this.type : null; }
      getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }; }
      scrollIntoView(): void {}
      focus(): void {}
      click(): void { this.clicks += 1; }
    }
    const submit = new PageElement('BUTTON', 'submit', 'Save');
    const field = new PageElement('INPUT', 'text', 'Display name');
    submit.form = { elements: [field, submit] };
    const document = {
      title: 'Provider setup',
      elementFromPoint: () => submit,
      children: [submit, field],
      querySelectorAll: (selector: string) => selector.startsWith('a[href]') ? [submit, field] : [],
    };
    electronMock.page.debugger = { isAttached: () => false, attach() {}, detach() {}, sendCommand: async (_method: string, params: any) => { if (params.type === 'mouseReleased') submit.click(); } };
    submit.parentNode = document;
    field.parentNode = document;
    const realm = vm.createContext({ crypto: require('node:crypto').webcrypto,
        document, window: { innerWidth: 1280, innerHeight: 800 }, Element: PageElement, ShadowRoot: class {},
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    });
    vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld').mockImplementation(
      async (_worldId: unknown, scripts: Array<{ code: string }>) => vm.runInContext(scripts[0].code, realm),
    );
    const ordinary = await observeControlledWebAssist('u1', cid, 'shop');
    expect(ordinary).toMatchObject({ ok: true, elements: [{ label: 'Save' }, {}] });
    expect((ordinary as any).elements[0]).not.toHaveProperty('requires_user_action');
    await expect(actOnControlledWebAssist('u1', cid, 'shop', {
      pageId: ordinary.page_id, elementRef: 'e1', action: 'click',
    })).resolves.toMatchObject({ ok: true, outcome: 'acted' });
    expect(submit.clicks).toBe(1);

    field.type = 'password';
    const sensitive = await observeControlledWebAssist('u1', cid, 'shop');
    expect(sensitive).toMatchObject({ ok: true, elements: [{}, {}] });
    expect((sensitive as any).elements[0]).not.toHaveProperty('requires_user_action');
    await expect(actOnControlledWebAssist('u1', cid, 'shop', {
      pageId: sensitive.page_id, elementRef: 'e1', action: 'click',
    })).resolves.toMatchObject({ ok: true });
    expect(submit.clicks).toBe(2);

    field.type = 'text';
    const browser = await observeModelWebAssist('u1', cid, opened.state.active_tab_id);
    expect(browser).toMatchObject({ ok: true, elements: [{}, {}] });
    expect((browser as any).elements[0]).not.toHaveProperty('requires_user_action');
    await expect(actOnModelWebAssist('u1', cid, {
      tabId: opened.state.active_tab_id, pageId: browser.page_id, elementRef: 'e1', action: 'click',
    })).resolves.toMatchObject({ ok: true, outcome: 'acted' });
    expect(submit.clicks).toBe(3);
    await expect(actOnControlledWebAssist('u1', cid, 'shop', {
      pageId: browser.page_id, elementRef: 'e1', action: 'click',
    })).resolves.toMatchObject({ ok: false, code: 'stale_page' });
    expect(submit.clicks).toBe(3);
    const resumed = await observeControlledWebAssist('u1', cid, 'shop');
    expect(resumed).toMatchObject({ ok: true, tab_id: opened.state.active_tab_id });
    await expect(actOnControlledWebAssist('u1', cid, 'shop', {
      pageId: resumed.page_id, elementRef: 'e1', action: 'click',
    })).resolves.toMatchObject({ ok: true });
    expect(submit.clicks).toBe(4);
  });

  it.each([
    { page: 'a rendering background', rendering: true, wakes: false, onScreen: false,
      events: ['mouseMoved', 'mousePressed', 'mouseReleased'] },
    { page: 'a never-rendered background', rendering: false, wakes: true, onScreen: false,
      events: ['throttling:false', 'mouseMoved', 'mousePressed', 'mouseReleased'] },
    { page: 'a background needing virtual focus', rendering: false, wakes: false, focusWakes: true, onScreen: false,
      events: ['throttling:false', 'focus:true', 'focus:false', 'mouseMoved', 'mousePressed', 'mouseReleased'] },
    { page: 'an unrenderable background', rendering: false, wakes: false, onScreen: false, refused: 'page_not_rendered',
      events: ['throttling:false', 'focus:true', 'focus:false'] },
    { page: 'a frameless on-screen', rendering: false, wakes: false, onScreen: true,
      events: ['throttling:false', 'mouseMoved', 'mousePressed', 'mouseReleased'] },
  ])('makes $page page render before native input or withholds the input', async ({ rendering: renderingAtStart, wakes, focusWakes, onScreen, refused, events }) => {
    const { renderer } = electronMock;
    const cid = 'c-render';
    bindWebAssistConversation('u1', cid, renderer);
    if (!onScreen) setActiveWebAssistConversation(renderer, 'other-task');
    const opened = await openModelWebAssist('u1', cid, { url: 'https://example.com/report' });
    const tabId = (opened as any).active_tab_id;
    if (onScreen) layoutWebAssist(renderer, { x: 0, y: 0, width: 600, height: 400 });
    class PageElement {
      form: { elements: PageElement[] } | null = null;
      parentNode: any = null;
      disabled = false;
      clicks = 0;
      constructor(public tagName: string, public type: string, public innerText: string) {}
      getAttribute(name: string): string | null { return name === 'type' ? this.type : null; }
      getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }; }
      scrollIntoView(): void {}
      focus(): void {}
      click(): void { this.clicks += 1; }
    }
    const button = new PageElement('BUTTON', 'button', 'Continue');
    const document = {
      title: 'Report',
      elementFromPoint: () => button,
      children: [button],
      querySelectorAll: (selector: string) => (selector.startsWith('a[href]') ? [button] : []),
    };
    button.parentNode = document;
    let rendering = renderingAtStart;
    const seen: string[] = [];
    electronMock.page.setBackgroundThrottling = vi.fn((allowed: boolean) => {
      seen.push(`throttling:${allowed}`);
      if (!allowed && wakes) rendering = true;
    });
    let attached = false;
    electronMock.page.debugger = { isAttached: () => attached, attach() { attached = true; }, detach() { attached = false; }, sendCommand: async (method: string, params: any) => {
      if (method === 'Emulation.setFocusEmulationEnabled') {
        seen.push(`focus:${params.enabled}`);
        if (params.enabled && focusWakes) rendering = true;
        return;
      }
      seen.push(params.type);
      // Measured: an off-screen page that never rendered never acknowledges a mouse move.
      if (!rendering && !onScreen) await new Promise(() => {});
      if (params.type === 'mouseReleased') button.click();
    } };
    const realm = vm.createContext({ crypto: require('node:crypto').webcrypto,
        document, window: { innerWidth: 1280, innerHeight: 800 }, Element: PageElement, ShadowRoot: class {},
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        // A page without frames never runs this callback.
        requestAnimationFrame: (callback: () => void) => { if (rendering) callback(); },
    });
    vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld').mockImplementation(
      async (_worldId: unknown, scripts: Array<{ code: string }>) => vm.runInContext(scripts[0].code, realm),
    );
    const observation = await observeModelWebAssist('u1', cid, tabId);
    vi.useFakeTimers();
    try {
      const click = async () => {
        const pending = actOnModelWebAssist('u1', cid, {
          tabId, pageId: (observation as any).page_id, elementRef: 'e1', action: 'click',
        });
        await vi.advanceTimersByTimeAsync(6000);
        return pending;
      };
      const result = await click();
      expect(attached).toBe(false);
      expect(seen).toEqual(events);
      if (refused) {
        expect(result).toMatchObject({ ok: false, code: refused });
        expect(button.clicks).toBe(0);
        // Once the user shows the page, the same observation clicks exactly once.
        rendering = true;
        seen.length = 0;
        await expect(click()).resolves.toMatchObject({ ok: true, outcome: 'acted' });
        expect(seen).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
      } else {
        expect(result).toMatchObject({ ok: true, outcome: 'acted', action: 'click' });
      }
      expect(button.clicks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('executes an authorization label once without an extra approval and rejects a duplicate', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-approve', renderer);
    const opened = await openModelWebAssist('u1', 'c-approve', { url: 'https://chatgpt.com/' });
    const tabId = (opened as any).active_tab_id;

    class PageElement {
      form: { elements: PageElement[] } | null = null;
      parentNode: any = null;
      disabled = false;
      clicks = 0;
      constructor(public tagName: string, public type: string, public innerText: string) {}
      getAttribute(name: string): string | null { return name === 'type' ? this.type : null; }
      getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }; }
      scrollIntoView(): void {}
      focus(): void {}
      click(): void { this.clicks += 1; }
    }
    const send = new PageElement('BUTTON', 'button', 'Authorize app');
    const remove = new PageElement('BUTTON', 'button', 'Delete chat');
    const document = {
      title: 'ChatGPT',
      elementFromPoint: () => send,
      children: [send, remove],
      querySelectorAll: (selector: string) => (selector.startsWith('a[href]') ? [send, remove] : []),
    };
    electronMock.page.debugger = { isAttached: () => false, attach() {}, detach() {}, sendCommand: async (_method: string, params: any) => { if (params.type === 'mouseReleased') send.click(); } };
    send.parentNode = document;
    remove.parentNode = document;
    const realm = vm.createContext({ crypto: require('node:crypto').webcrypto,
        document, window: { innerWidth: 1280, innerHeight: 800 }, Element: PageElement, ShadowRoot: class {},
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    });
    vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld').mockImplementation(
      async (_worldId: unknown, scripts: Array<{ code: string }>) => vm.runInContext(scripts[0].code, realm),
    );
    const first = await observeModelWebAssist('u1', 'c-approve', tabId);
    expect(first).toMatchObject({ ok: true, elements: [{ label: 'Authorize app' }, {}] });
    expect((first as any).elements[0]).not.toHaveProperty('requires_user_action');
    const input = { tabId, pageId: first.page_id, elementRef: 'e1', action: 'click' };
    await expect(actOnModelWebAssist('u1', 'c-approve', input)).resolves.toMatchObject({ ok: true, outcome: 'acted' });
    await expect(actOnModelWebAssist('u1', 'c-approve', input)).resolves.toMatchObject({ ok: false, code: 'stale_page' });
    expect(send.clicks).toBe(1);
    expect(remove.clicks).toBe(0);
  });

  it.each(['navigation', 'tab close', 'new observation', 'task end', 'abort'])(
    'discards an in-flight field value after %s and holds competing mutations', async change => {
      const cid = 'c-field-race';
      bindWebAssistConversation('u1', cid, electronMock.renderer);
      const opened = await openModelWebAssist('u1', cid, { url: 'https://example.com/form' });
      const tabId = opened.active_tab_id as string;
      const observation = await observeModelWebAssist('u1', cid, tabId);
      const contents = electronMock.page;
      const original = contents.executeJavaScriptInIsolatedWorld.bind(contents);
      let complete!: (value: Record<string, unknown>) => void;
      vi.spyOn(contents, 'executeJavaScriptInIsolatedWorld').mockImplementation(async (world: unknown, scripts: Array<{ code: string }>) => {
        if (scripts[0].code.includes('"action":"read_value"')) return new Promise(resolve => { complete = resolve; });
        return original(world, scripts);
      });
      const controller = new AbortController();
      let active = true;
      const input = { tabId, pageId: observation.page_id, elementRef: 'e1' };
      const reading = readModelWebAssistValue('u1', cid, input, { signal: controller.signal, isActive: () => active });
      await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
      await expect(actOnModelWebAssist('u1', cid, { ...input, action: 'fill', text: 'competing mutation' }))
        .resolves.toMatchObject({ ok: false, code: 'action_in_progress' });
      if (change === 'navigation') await contents.loadURL('https://example.com/other');
      if (change === 'tab close') closeModelWebAssistTab('u1', cid, tabId);
      if (change === 'new observation') await observeModelWebAssist('u1', cid, tabId);
      if (change === 'task end') active = false;
      if (change === 'abort') controller.abort();
      complete({ ok: true, value: 'discard-this-value' });
      const result = await reading;
      expect(result).toMatchObject({ ok: false, code: 'stale_page' });
      expect(JSON.stringify(result)).not.toContain('discard-this-value');
    },
  );

  it('keeps connector setup after browser observation and rejects unobserved input without losing the binding', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-scope', renderer);
    const opened = await openControlledWebAssist('u1', 'c-scope', {
      scope: 'connector_setup', scopeId: 'shop', url: 'https://provider.example/setup',
    });
    if (!opened.ok) throw new Error('controlled page setup failed');
    await expect(actOnModelWebAssist('u1', 'c-scope', {
      tabId: opened.state.active_tab_id,
      pageId: 'not-observed',
      elementRef: 'e1',
      action: 'click',
    })).resolves.toMatchObject({ ok: false, code: 'stale_page' });
    await expect(observeControlledWebAssist('u1', 'c-scope', 'shop'))
      .resolves.toMatchObject({ ok: true });
    await expect(observeModelWebAssist('u1', 'c-scope', opened.state.active_tab_id))
      .resolves.toMatchObject({ ok: true });
    await expect(observeControlledWebAssist('u1', 'c-scope', 'shop'))
      .resolves.toMatchObject({ ok: true, tab_id: opened.state.active_tab_id });
    expect(listModelWebAssistTabs('u1', 'c-scope')).toMatchObject({ tabs: [{ tab_id: opened.state.active_tab_id }] });
  });

  it.each(['wait', 'read_value', 'fill'] as const)('continues the same connector page after generic %s', async operation => {
    const cid = 'c-setup-continuity';
    bindWebAssistConversation('u1', cid, electronMock.renderer);
    const opened = await openControlledWebAssist('u1', cid, {
      scope: 'connector_setup', scopeId: 'shop', url: 'https://provider.example/setup',
    });
    if (!opened.ok) throw new Error('controlled page setup failed');
    const before = await observeControlledWebAssist('u1', cid, 'shop');
    const tabId = opened.state.active_tab_id;
    if (operation === 'wait') {
      await expect(waitForModelWebAssist('u1', cid, { tabId, condition: 'loaded' }))
        .resolves.toMatchObject({ ok: true });
    } else if (operation === 'read_value') {
      vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld').mockResolvedValueOnce({ ok: true, value: 'Application draft' });
      await expect(readModelWebAssistValue('u1', cid, { tabId, pageId: before.page_id, elementRef: 'e1' }))
        .resolves.toMatchObject({ ok: true, value: 'Application draft' });
    } else {
      await expect(actOnModelWebAssist('u1', cid, { tabId, pageId: before.page_id, elementRef: 'e1', action: 'fill', text: 'Application draft' }))
        .resolves.toMatchObject({ ok: true });
    }
    const resumed = await observeControlledWebAssist('u1', cid, 'shop');
    expect(resumed).toMatchObject({ ok: true, tab_id: tabId });
    await expect(actOnControlledWebAssist('u1', cid, 'shop', {
      pageId: resumed.page_id, elementRef: 'e1', action: 'fill', text: 'Continued draft',
    })).resolves.toMatchObject({ ok: true });
    await expect(observeControlledWebAssist('u1', cid, 'foreign-connector'))
      .resolves.toMatchObject({ ok: false, code: 'scope_mismatch' });
  });

  it.each(['goto', 'back', 'forward', 'reload', 'user_address'] as const)(
    'revokes the connector binding after explicit %s navigation', async navigation => {
      const cid = 'c-setup-navigation';
      bindWebAssistConversation('u1', cid, electronMock.renderer);
      const opened = await openControlledWebAssist('u1', cid, {
        scope: 'connector_setup', scopeId: 'shop', url: 'https://provider.example/setup',
      });
      if (!opened.ok) throw new Error('controlled page setup failed');
      const before = await observeControlledWebAssist('u1', cid, 'shop');
      const tabId = opened.state.active_tab_id;
      // A rejected navigation must not discard an otherwise valid setup page.
      await expect(navigateModelWebAssist('u1', cid, { tabId, action: 'goto', url: 'file:///private' }))
        .resolves.toMatchObject({ ok: false, code: 'invalid_url' });
      await expect(observeControlledWebAssist('u1', cid, 'shop')).resolves.toMatchObject({ ok: true });
      electronMock.page.navigationHistory.canGoBack = () => true;
      electronMock.page.navigationHistory.canGoForward = () => true;
      const navigated = navigation === 'user_address'
        ? await navigateWebAssistTo(electronMock.renderer, { tabId, url: 'https://unrelated.example/work' })
        : await navigateModelWebAssist('u1', cid, { tabId, action: navigation,
          ...(navigation === 'goto' ? { url: 'https://unrelated.example/work' } : {}) });
      expect(navigated).toMatchObject({ ok: true });
      await expect(observeControlledWebAssist('u1', cid, 'shop'))
        .resolves.toMatchObject({ ok: false, code: 'scope_mismatch' });
      await expect(actOnModelWebAssist('u1', cid, { tabId, pageId: before.page_id, elementRef: 'e1', action: 'fill', text: 'Stale draft' }))
        .resolves.toMatchObject({ ok: false, code: 'stale_page' });
      expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ tabs: [{ tab_id: tabId }] });
    },
  );

  it('preserves connector setup during human takeover and resumes only with fresh page evidence', async () => {
    vi.useFakeTimers();
    const cid = 'c-setup-handoff';
    const renderer = electronMock.renderer;
    try {
      bindWebAssistConversation('u1', cid, renderer);
      const opened = await openControlledWebAssist('u1', cid, {
        scope: 'connector_setup', scopeId: 'shop', url: 'https://provider.example/setup',
      });
      if (!opened.ok) throw new Error('controlled page setup failed');
      const tabId = opened.state.active_tab_id;
      const before = await observeControlledWebAssist('u1', cid, 'shop');
      const page = electronMock.page;
      page.emit('before-input-event', {}, { type: 'keyDown', code: 'KeyA', isComposing: false });
      page.emit('before-input-event', {}, { type: 'keyUp', code: 'KeyA', isComposing: false });
      const observed = await observeModelWebAssist('u1', cid, tabId);
      expect(observed).toMatchObject({ ok: true, tab_id: tabId });
      await expect(actOnControlledWebAssist('u1', cid, 'shop', {
        pageId: observed.page_id, elementRef: 'e1', action: 'fill', text: 'Competing input',
      })).resolves.toMatchObject({ ok: false, code: 'user_controlled' });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(actOnControlledWebAssist('u1', cid, 'shop', {
        pageId: before.page_id, elementRef: 'e1', action: 'fill', text: 'Old input',
      })).resolves.toMatchObject({ ok: false, code: 'stale_page' });
      const resumed = await observeControlledWebAssist('u1', cid, 'shop');
      expect(resumed).toMatchObject({ ok: true, tab_id: tabId });
      await expect(actOnControlledWebAssist('u1', cid, 'shop', {
        pageId: resumed.page_id, elementRef: 'e1', action: 'fill', text: 'Resumed input',
      })).resolves.toMatchObject({ ok: true });
    } finally {
      closeWebAssist(renderer);
      vi.useRealTimers();
    }
  });

  it('ensures one blank task tab without navigating, duplicating existing work, or selecting another task', async () => {
    const { renderer } = electronMock;
    const first = await addWebAssistTab('u1', renderer, { conversationId: 'c-default', ifEmpty: true });
    if (!first.ok) throw new Error('tab setup failed');
    const firstId = first.state.active_tab_id!;
    const firstPage = electronMock.page;
    expect(firstPage.getURL()).toBe('');
    expect(first.state.tabs).toHaveLength(1);
    expect(first.state.tabs[0]).toMatchObject({ tab_id: firstId, created_by: 'user', loading: false, address_url: '' });
    await navigateWebAssistTo(renderer, { tabId: firstId, url: 'https://example.com/keep?item=1#draft' });
    const second = await addWebAssistTab('u1', renderer, { conversationId: 'c-default', ifEmpty: true });
    expect(second).toEqual({ ok: true, state: webAssistState(renderer).state });
    expect(webAssistState(renderer).state.tabs).toHaveLength(1);
    expect(firstPage.getURL()).toBe('https://example.com/keep?item=1#draft');
    const other = await addWebAssistTab('u1', renderer, { conversationId: 'c-other', ifEmpty: true });
    expect(other).toMatchObject({ ok: true, state: { active_tab_id: firstId } });
    expect(webAssistState(renderer).state.tabs).toHaveLength(2);
    closeWebAssistTab(renderer, firstId);
    const replacement = await addWebAssistTab('u1', renderer, { conversationId: 'c-default', ifEmpty: true });
    if (!replacement.ok) throw new Error('replacement failed');
    const taskTabs = replacement.state.tabs.filter(tab => tab.conversation_id === 'c-default');
    expect(taskTabs).toHaveLength(1);
    expect(taskTabs[0].tab_id).not.toBe(firstId);
    expect(taskTabs[0].address_url).toBe('');
    expect(firstPage.isDestroyed()).toBe(true);
  });

  it('adds, navigates, activates, and closes independent tabs for one task', async () => {
    const { renderer } = electronMock;
    const first = await addWebAssistTab('u1', renderer, { conversationId: 'c-tabs' });
    expect(first).toMatchObject({ ok: true, state: { open: true, tabs: [{ conversation_id: 'c-tabs' }] } });
    if (!first.ok) throw new Error('tab setup failed');
    const firstId = first.state.active_tab_id!;
    await expect(navigateWebAssistTo(renderer, { tabId: firstId, url: 'example.com/one' }))
      .resolves.toMatchObject({ ok: true, state: { display_url: 'https://example.com/one' } });
    await expect(navigateWebAssistTo(renderer, { tabId: firstId, url: 'orkas browser' }))
      .resolves.toMatchObject({ ok: true, state: { display_url: 'https://www.bing.com/search?q=orkas+browser' } });
    expect(electronMock.page.getURL()).toBe('https://www.bing.com/search?q=orkas+browser');
    await expect(navigateWebAssistTo(renderer, { tabId: firstId, url: 'javascript:alert(1)' }))
      .resolves.toMatchObject({ ok: false, code: 'invalid_url' });
    expect(electronMock.page.getURL()).toBe('https://www.bing.com/search?q=orkas+browser');

    const second = await addWebAssistTab('u1', renderer, { conversationId: 'c-tabs' });
    if (!second.ok) throw new Error('tab setup failed');
    const secondId = second.state.active_tab_id!;
    expect(second.state.tabs).toHaveLength(2);
    expect(activateWebAssistTab(renderer, firstId)).toMatchObject({ ok: true, state: { active_tab_id: firstId } });
    expect(closeWebAssistTab(renderer, firstId)).toMatchObject({ ok: true, closed: true });
    expect(closeWebAssistTab(renderer, secondId)).toMatchObject({ ok: true, closed: true, state: { open: false, tabs: [] } });
  });

  it('enforces the tab limit per task without consuming another task quota', async () => {
    const { renderer } = electronMock;
    const created = [];
    for (let index = 0; index < TAB_LIMIT; index++) {
      created.push(await addWebAssistTab('u1', renderer, { conversationId: 'c-limit', label: `Tab ${index + 1}` }));
    }
    expect(created.every(result => result.ok)).toBe(true);
    expect(created.at(-1)).toMatchObject({ ok: true, state: { tabs: expect.any(Array) } });
    const lastCreated = created.at(-1);
    if (!lastCreated?.ok) throw new Error('tab setup failed');
    expect(lastCreated.state.tabs).toHaveLength(TAB_LIMIT);
    expect(await addWebAssistTab('u1', renderer, { conversationId: 'c-limit' }))
      .toMatchObject({ ok: false, code: 'too_many_tabs', error: expect.stringContaining(`${TAB_LIMIT}-tab limit`) });
    await expect(openWebAssist('u1', renderer, {
      conversationId: 'c-limit',
      url: 'https://example.com/eleventh',
    })).resolves.toMatchObject({ ok: false, code: 'too_many_tabs' });
    bindWebAssistConversation('u1', 'c-limit', renderer);
    expect(await openModelWebAssist('u1', 'c-limit', { url: 'https://example.com/model' }))
      .toMatchObject({ ok: false, code: 'too_many_tabs', tab_limit: TAB_LIMIT, error: expect.stringContaining('Reuse an existing tab') });
    const firstId = created[0].ok ? created[0].state.active_tab_id! : '';
    expect(await navigateModelWebAssist('u1', 'c-limit', { tabId: firstId, action: 'goto', url: 'https://example.com/reused' }))
      .toMatchObject({ ok: true, tab: { tab_id: firstId } });
    expect(listModelWebAssistTabs('u1', 'c-limit').tabs).toHaveLength(TAB_LIMIT);
    closeWebAssistTab(renderer, firstId);
    expect(await openModelWebAssist('u1', 'c-limit', { url: 'https://example.com/recovery' })).toMatchObject({ ok: true, closed_tab_ids: [] });
    expect(await addWebAssistTab('u1', renderer, { conversationId: 'c-other' }))
      .toMatchObject({ ok: true, state: { conversation_id: 'c-other' } });
  });

  it.each(['model', 'user', 'connector'] as const)('evicts the oldest inactive model tab when %s opens one past capacity', async (origin) => {
    const { renderer, owner } = electronMock;
    const cid = `c-evict-${origin}`;
    // Another task's older page is never a capacity victim.
    bindWebAssistConversation('u1', 'c-other-limit', renderer);
    await openModelWebAssist('u1', 'c-other-limit', { url: 'https://example.com/other' });
    const otherPage = electronMock.page;
    bindWebAssistConversation('u1', cid, renderer);
    const ids: string[] = [];
    const pages: any[] = [];
    for (let index = 0; index < TAB_LIMIT; index++) {
      const opened = await openModelWebAssist('u1', cid, { url: `https://example.com/${index}` });
      expect(opened.ok).toBe(true);
      ids.push(String(opened.active_tab_id));
      pages.push(electronMock.page);
    }
    expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ tab_limit: TAB_LIMIT, tabs: expect.any(Array) });
    expect(pages.every(page => !page.isDestroyed())).toBe(true);
    activateWebAssistTab(renderer, ids[0]);
    // Invalid requests cannot clean existing work, even at capacity.
    expect(await openModelWebAssist('u1', cid, { url: 'file:///private' })).toMatchObject({ ok: false });
    expect(pages.every(page => !page.isDestroyed())).toBe(true);
    // Native allocation failure must not discard a victim before replacement exists.
    owner.contentView.addChildView.mockImplementationOnce(() => { throw new Error('Fixture allocation failure'); });
    expect(await openModelWebAssist('u1', cid, { url: 'https://example.com/allocation-failure' }))
      .toMatchObject({ ok: false, code: 'view_unavailable' });
    expect(pages.every(page => !page.isDestroyed())).toBe(true);
    const opened = origin === 'model'
      ? await openModelWebAssist('u1', cid, { url: 'https://example.com/new' })
      : origin === 'connector'
        ? await openControlledWebAssist('u1', cid, { scope: 'connector_setup', scopeId: 'shop', url: 'https://example.com/new' })
        : await addWebAssistTab('u1', renderer, { conversationId: cid });
    expect(opened.ok).toBe(true);
    if (origin === 'model') expect(opened).toMatchObject({ tab_limit: TAB_LIMIT, closed_tab_ids: [ids[1]] });
    expect(pages.map(page => page.isDestroyed()))
      .toEqual(Array.from({ length: TAB_LIMIT }, (_, index) => index === 1));
    const remaining = listModelWebAssistTabs('u1', cid).tabs as Array<{ tab_id: string }>;
    expect(remaining).toHaveLength(TAB_LIMIT);
    expect(remaining.map(tab => tab.tab_id)).not.toContain(ids[1]);
    expect(otherPage.isDestroyed()).toBe(false);
    expect(await observeModelWebAssist('u1', cid, ids[1])).toMatchObject({ ok: false, code: 'unknown_tab' });
    // State pushes must never flash an eleventh tab in this task's strip.
    for (const [channel, state] of renderer.send.mock.calls) {
      if (channel === 'web-assist:state' || channel === 'web-assist:show') {
        expect(state.tabs.filter((tab: any) => tab.conversation_id === cid).length).toBeLessThanOrEqual(TAB_LIMIT);
      }
    }
  });

  it.each(['model', 'user', 'connector'] as const)('preserves user edits when %s opens at capacity', async (origin) => {
    const { renderer } = electronMock;
    const cid = `c-edited-limit-${origin}`;
    bindWebAssistConversation('u1', cid, renderer);
    const ids: string[] = [];
    const pages: any[] = [];
    for (let index = 0; index < TAB_LIMIT; index++) {
      const opened = await openModelWebAssist('u1', cid, { url: `https://example.com/${index}` });
      expect(opened.ok).toBe(true);
      ids.push(String(opened.active_tab_id));
      pages.push(electronMock.page);
      if (index === 0) pages[0].emit('before-input-event', {}, { type: 'keyDown', key: 'a' });
    }
    let connectorOpenCount = 0;
    const open = async () => origin === 'model'
      ? openModelWebAssist('u1', cid, { url: 'https://example.com/new' })
      : origin === 'connector'
        ? openControlledWebAssist('u1', cid, { scope: 'connector_setup', scopeId: `shop-${++connectorOpenCount}`, url: 'https://example.com/new' })
        : await addWebAssistTab('u1', renderer, { conversationId: cid });
    expect(await open()).toMatchObject({ ok: true });
    expect(pages[0].isDestroyed()).toBe(false);
    expect(pages[1].isDestroyed()).toBe(true);
    expect(listModelWebAssistTabs('u1', cid).tabs).toHaveLength(TAB_LIMIT);
    // With every inactive page edited, opening must fail without losing work.
    for (const page of pages.filter(page => !page.isDestroyed())) {
      page.emit('before-input-event', {}, { type: 'keyDown', key: 'b' });
    }
    expect(await open()).toMatchObject({ ok: false, code: 'too_many_tabs' });
    expect(pages.filter(page => !page.isDestroyed())).toHaveLength(TAB_LIMIT - 1);
    expect(listModelWebAssistTabs('u1', cid).tabs).toHaveLength(TAB_LIMIT);
  });

  it('protects handoffs, connector setup after browser observation, loading pages and authorization popups from capacity cleanup', async () => {
    const { renderer } = electronMock;
    const cid = 'c-protected-limit';
    bindWebAssistConversation('u1', cid, renderer);
    beginBrowserTaskRun('u1', cid, 'protection-run');
    const ids: string[] = [];
    const pages: any[] = [];
    for (let index = 0; index < TAB_LIMIT; index++) {
      const opened = index === 0
        ? await openControlledWebAssist('u1', cid, { scope: 'connector_setup', scopeId: 'shop', url: 'https://example.com/login' })
        : await openModelWebAssist('u1', cid, { url: `https://example.com/${index}` });
      expect(opened.ok).toBe(true);
      ids.push(String('state' in opened ? (opened.state as any).active_tab_id
        : 'active_tab_id' in opened ? opened.active_tab_id : undefined));
      pages.push(electronMock.page);
      if (index === 1) expect(retainModelWebAssistTab('u1', cid, ids[index], 'handoff')).toMatchObject({ ok: true });
      if (index === 2) expect(retainModelWebAssistTab('u1', cid, ids[index], 'deliverable')).toMatchObject({ ok: true });
    }
    expect(await observeModelWebAssist('u1', cid, ids[0])).toMatchObject({ ok: true });
    // Make the setup tab inactive again: eviction must respect its binding,
    // rather than merely protecting the currently selected page.
    expect(await observeModelWebAssist('u1', cid, ids[ids.length - 1])).toMatchObject({ ok: true });
    pages[3].emit('did-start-loading');
    const popupPage = electronMock.createPage!();
    pages[4].emit('did-create-window', { webContents: popupPage, setMenuBarVisibility: vi.fn() });
    const opened = await openModelWebAssist('u1', cid, { url: 'https://example.com/new' });
    expect(opened).toMatchObject({ ok: true, closed_tab_ids: [ids[5]] });
    expect(pages.slice(0, 5).every(page => !page.isDestroyed())).toBe(true);
    expect(popupPage.isDestroyed()).toBe(false);
    // A finished popup releases only its parent's eviction protection.
    popupPage.close();
    expect(await openModelWebAssist('u1', cid, { url: 'https://example.com/next' }))
      .toMatchObject({ ok: true, closed_tab_ids: [ids[4]] });
    expect(pages[3].isDestroyed()).toBe(false);
    finishBrowserTaskRun('u1', cid, 'protection-run');
  });

  it('keeps task tab inventories and exact tab ids isolated in a shared window', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-left', renderer);
    const left = await addWebAssistTab('u1', renderer, { conversationId: 'c-left', label: 'Left' });
    if (!left.ok) throw new Error('left tab setup failed');
    const leftId = left.state.active_tab_id!;

    bindWebAssistConversation('u1', 'c-right', renderer);
    const right = await addWebAssistTab('u1', renderer, { conversationId: 'c-right', label: 'Right' });
    if (!right.ok) throw new Error('right tab setup failed');
    const rightId = right.state.active_tab_id!;

    expect(setActiveWebAssistConversation(renderer, 'c-left')).toEqual({ ok: true });
    expect(listModelWebAssistTabs('u1', 'c-left')).toMatchObject({
      ok: true,
      active_tab_id: leftId,
      tabs: [{ tab_id: leftId, conversation_id: 'c-left' }],
    });
    // Isolation comes from tab ownership, not from what the user is watching:
    // reaching into another task stays blocked...
    await expect(observeModelWebAssist('u1', 'c-left', rightId))
      .resolves.toMatchObject({ ok: false, code: 'unknown_tab' });
    // ...while the backgrounded task keeps driving its own tab and reading its
    // own inventory.
    await expect(navigateModelWebAssist('u1', 'c-right', {
      tabId: rightId, action: 'goto', url: 'https://example.com/right',
    })).resolves.toMatchObject({ ok: true });
    await expect(observeModelWebAssist('u1', 'c-right', rightId))
      .resolves.toMatchObject({ ok: true, tab_id: rightId });
    expect(listModelWebAssistTabs('u1', 'c-right')).toMatchObject({
      ok: true,
      tabs: [{ tab_id: rightId, conversation_id: 'c-right' }],
    });

    expect(setActiveWebAssistConversation(renderer, 'c-right')).toEqual({ ok: true });
    expect(listModelWebAssistTabs('u1', 'c-right')).toMatchObject({
      ok: true,
      active_tab_id: rightId,
      tabs: [{ tab_id: rightId, conversation_id: 'c-right' }],
    });
  });

  it('hides the native page for other panels without losing conversation ownership or page control', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c3', renderer);
    const result = await openControlledWebAssist('u1', 'c3', {
      scope: 'connector_setup', scopeId: 'shop', url: 'https://provider.example/setup',
    });
    expect(result).toMatchObject({ ok: true, state: { conversation_id: 'c3' } });
    const view = electronMock.owner.contentView.addChildView.mock.calls[0][0];
    const visibility = vi.spyOn(view, 'setVisible');
    expect(layoutWebAssist(renderer, { visible: false })).toMatchObject({ ok: true });
    expect(visibility).toHaveBeenLastCalledWith(false);
    await expect(observeControlledWebAssist('u1', 'c3', 'shop')).resolves.toMatchObject({ ok: true });
    expect(layoutWebAssist(renderer, { x: 650, y: 90, width: 500, height: 600 })).toMatchObject({ ok: true });
    expect(visibility).toHaveBeenLastCalledWith(true);
    await expect(observeControlledWebAssist('u1', 'other-task', 'shop')).resolves.toMatchObject({ ok: false });
  });
});

// A conversation the host creates and runs itself — an automation fire or a
// project-driver advance — never passes through the renderer IPC that binds a
// conversation to a window. Before this binding existed every browser call in
// such a turn failed, including listing tabs, so an automation that had to read
// a page could not run at all.
describe('host-started task browser binding', () => {
  beforeEach(() => {
    electronMock.windowsOpen = true;
    electronMock.createWindow?.();
  });

  afterEach(() => {
    closeWebAssist(electronMock.renderer);
    electronMock.windowsOpen = true;
    electronMock.renderHost = null;
    vi.restoreAllMocks();
  });

  it('gives a host-created conversation a browser without taking over the view', async () => {
    const cid = 'c-host-created';
    // The user is already sitting in some other task when the fire lands; the
    // ordering matters, because a bind that claimed foreground would silently
    // evict them here rather than at the moment the page opens.
    setActiveWebAssistConversation(electronMock.renderer, 'c-user-is-here');
    expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ ok: false, code: 'window_unavailable' });

    expect(bindHostStartedWebAssistConversation('u1', cid)).toBe(true);
    expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ ok: true, tabs: [] });

    await expect(openModelWebAssist('u1', cid, { url: 'https://example.com/ready' }))
      .resolves.toMatchObject({ ok: true });
    expect(electronMock.renderer.send).toHaveBeenCalledWith('web-assist:show', expect.objectContaining({
      browser_activity_conversation_id: cid,
    }));
    expect(electronMock.owner.contentView.addChildView.mock.calls.every(([view]: any[]) => !view.getVisible())).toBe(true);
  });

  it('still presents the page when the user is the one sitting in that task', async () => {
    const cid = 'c-user-bound';
    bindWebAssistConversation('u1', cid, electronMock.renderer);
    await expect(openModelWebAssist('u1', cid, { url: 'https://example.com/ready' }))
      .resolves.toMatchObject({ ok: true });
    expect(electronMock.renderer.send).toHaveBeenCalledWith('web-assist:show', expect.anything());
  });

  it('leaves an existing renderer binding alone', () => {
    const cid = 'c-already-bound';
    bindWebAssistConversation('u1', cid, electronMock.renderer);
    setActiveWebAssistConversation(electronMock.renderer, cid);
    expect(bindHostStartedWebAssistConversation('u1', cid)).toBe(true);
    // Re-binding must not have demoted the task the user is sitting in.
    expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ ok: true });
  });

  it('skips an offscreen render host and takes the app window', async () => {
    // A turn rendering a PDF, an Office page or a video owns a real
    // BrowserWindow that is invisible and short-lived. Hosting a task browser
    // there would put the page somewhere the user can never reach.
    electronMock.renderHost = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, getURL: () => 'file:///tmp/orkas-print/report.html' },
    };
    const cid = 'c-render-host';
    expect(bindHostStartedWebAssistConversation('u1', cid)).toBe(true);
    // Binding to the render host would leave the tab with no reachable owner.
    await expect(openModelWebAssist('u1', cid, { url: 'https://example.com/ready' }))
      .resolves.toMatchObject({ ok: true });
    expect(electronMock.owner.contentView.addChildView).toHaveBeenCalled();
  });

  it('reaches page text and elements past the first window, and numbers refs from the offset', async () => {
    // 2026-09-18: the page script capped the joined text at 12000 characters
    // before slicing 6000 out of it, so nothing past that existed at any price.
    const corpus = `${'A'.repeat(6000)}${'B'.repeat(6000)}${'C'.repeat(1000)}`;
    electronMock.pageText = corpus;
    electronMock.pageElementCount = 130;
    try {
      bindWebAssistConversation('u1', 'c-paging', electronMock.renderer);
      const opened = await openModelWebAssist('u1', 'c-paging', { url: 'https://example.com/long' });
      const tabId = String(opened.active_tab_id);

      const first = await observeModelWebAssist('u1', 'c-paging', tabId) as any;
      expect(first.text).toBe('A'.repeat(6000));
      expect(first).toMatchObject({
        text_offset: 0, text_total: corpus.length, text_next_offset: 6000, text_truncated: true,
        element_offset: 0, element_count: 130, element_next_offset: 80, elements_truncated: true,
      });
      expect(first.elements).toHaveLength(80);

      const second = await observeModelWebAssist('u1', 'c-paging', tabId, 'full', { textOffset: 6000 }) as any;
      expect(second.text).toBe('B'.repeat(6000));
      expect(second).toMatchObject({ text_offset: 6000, text_next_offset: 12000 });

      const last = await observeModelWebAssist('u1', 'c-paging', tabId, 'full', { textOffset: 12000 }) as any;
      expect(last.text).toBe('C'.repeat(1000));
      expect(last.text_truncated).toBe(false);
      expect(last).not.toHaveProperty('text_next_offset');

      expect(first.elements[0].ref).toBe('e1');

      // Second element page. Refs carry the offset because the stored map is
      // what `act` resolves against, and page two must not reuse page one's
      // names for different controls.
      const tail = await observeModelWebAssist('u1', 'c-paging', tabId, 'full', { elementOffset: 80 }) as any;
      expect(tail.elements).toHaveLength(50);
      expect(tail.elements[0].ref).toBe('e81');
      expect(tail.elements.at(-1).ref).toBe('e130');
      expect(tail).toMatchObject({ element_offset: 80, element_count: 130, elements_truncated: false });
      expect(tail).not.toHaveProperty('element_next_offset');

      // A ref only the second page names drives an act.
      expect(await actOnModelWebAssist('u1', 'c-paging', {
        tabId, pageId: tail.page_id, elementRef: 'e81', action: 'fill', text: 'Orkas',
      })).toMatchObject({ ok: true });

      // meta reports the sizes without paying for either payload.
      const meta = await observeModelWebAssist('u1', 'c-paging', tabId, 'meta') as any;
      expect(meta).toMatchObject({ scope: 'meta', text_total: corpus.length, element_count: 130 });
      expect(meta).not.toHaveProperty('text');
      expect(meta).not.toHaveProperty('elements');
    } finally {
      electronMock.pageText = 'Create an app';
      electronMock.pageElementCount = 1;
    }
  });

  // A Chinese page's 6000-character window is about 9K estimated tokens on its
  // own, so a full observation spilled and the model lost its element refs.
  it('pages a long Chinese page within the inline limit, keeping the elements and every character', async () => {
    const words = ['订单', '发货', '退款', '商品', '库存', '价格', '优惠券', '店铺'];
    let corpus = '';
    for (let i = 0; corpus.length < 15_000; i++) corpus += words[i % words.length] + (i % 9 === 0 ? '。' : '，');
    electronMock.pageText = corpus;
    electronMock.pageElementCount = 130;
    try {
      bindWebAssistConversation('u1', 'c-cjk-paging', electronMock.renderer);
      const opened = await openModelWebAssist('u1', 'c-cjk-paging', { url: 'https://example.com/orders' });
      const tabId = String(opened.active_tab_id);
      let read = '';
      let offset: number | undefined = 0;
      let pages = 0;
      while (offset !== undefined) {
        const page = await observeModelWebAssist('u1', 'c-cjk-paging', tabId, 'full', { textOffset: offset }) as any;
        expect(estimateToolResultTokens(JSON.stringify(page))).toBeLessThanOrEqual(10_000);
        expect(page.elements).toHaveLength(80);
        expect(page.text_offset).toBe(offset);
        expect(page.text.length).toBeGreaterThan(0);
        read += page.text;
        offset = page.text_next_offset;
        pages += 1;
        expect(pages).toBeLessThan(40);
      }
      expect(read).toBe(corpus);
      expect(pages).toBeGreaterThan(Math.ceil(corpus.length / 6000));
    } finally {
      electronMock.pageText = 'Create an app';
      electronMock.pageElementCount = 1;
    }
  });

  it.each(['release', 'hide'] as const)('keeps a physical pointer target fixed until %s without reopening a hidden page', async ending => {
    const cid = 'c-pointer-layout';
    bindWebAssistConversation('u1', cid, electronMock.renderer);
    setActiveWebAssistConversation(electronMock.renderer, cid);
    const opened = await openModelWebAssist('u1', cid, { url: 'https://example.com/work' });
    const page = electronMock.page;
    const view = electronMock.owner.contentView.addChildView.mock.calls.map(([view]: any[]) => view)
      .find((view: any) => view.webContents === page);
    const original = { x: 0, y: 0, width: 600, height: 500 };
    const moved = { x: 0, y: 28, width: 600, height: 472 };
    layoutWebAssist(electronMock.renderer, original);
    page.emit('before-mouse-event', {}, { type: 'mouseDown', x: 100, y: 100, button: 'left' });
    expect(listModelWebAssistTabs('u1', cid).tabs.find((tab: any) => tab.tab_id === opened.active_tab_id))
      .toMatchObject({ user_controlled: true });
    layoutWebAssist(electronMock.renderer, moved);
    expect(view.getBounds()).toEqual(original);
    if (ending === 'hide') layoutWebAssist(electronMock.renderer, { visible: false });
    page.emit('before-mouse-event', {}, { type: 'mouseUp', x: 100, y: 100, button: 'left' });
    expect(view.getBounds()).toEqual(original);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(view.getBounds()).toEqual(ending === 'release' ? moved : original);
    expect(view.getVisible()).toBe(ending === 'release');
  });

  it('lays a page out at desktop width scaled into the drawer, however wide the drawer is', async () => {
    // 2026-09-18: this used to apply only while a tab was hidden, which made it
    // dead on arrival — exposeTaskTabToModel reveals the tab on every model
    // operation in a foreground task, the renderer lays it out, and the layout
    // marked it visible. Measured innerWidth=408 with a mobile layout.
    electronMock.windowsOpen = true;
    const cid = 'c-viewport';
    bindWebAssistConversation('u1', cid, electronMock.renderer);
    const opened = await openModelWebAssist('u1', cid, { url: 'https://example.com/work' });
    const tabId = String(opened.active_tab_id);
    const page = electronMock.page;

    // The drawer at its default share of a 1280-wide window.
    layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 408, height: 719 });
    await observeModelWebAssist('u1', cid, tabId);
    expect(page.emulation).toMatchObject({
      width: 1280,
      mobile: false,
      scale: 408 / 1280,
    });
    // Height-only resizing preserves the desktop layout.
    layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 408, height: 500 });
    await observeModelWebAssist('u1', cid, tabId);

    // Showing the tab must not undo it. That inversion was the bug.
    expect((await observeModelWebAssist('u1', cid, tabId)).ok).toBe(true);
    expect(page.emulation).not.toBeNull();
    expect(page.emulation.width).toBe(1280);

    // Dragging the drawer wider raises the scale, because the room changed.
    layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 800, height: 719 });
    await observeModelWebAssist('u1', cid, tabId);
    expect(page.emulation.scale).toBeCloseTo(800 / 1280, 5);

    // Past desktop width there is nothing to emulate; let the real viewport
    // through instead of imposing a narrower one on top of it. Bounds are
    // clamped to the owner window, so the window has to allow it first.
    const previousBounds = electronMock.owner.getContentBounds;
    electronMock.owner.getContentBounds = () => ({ width: 1600, height: 900 });
    try {
      layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 1400, height: 900 });
      await observeModelWebAssist('u1', cid, tabId);
      expect(page.emulation).toBeNull();
    } finally {
      electronMock.owner.getContentBounds = previousBounds;
    }

    // Re-applying the same width does not churn the native call.
    layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 408, height: 719 });
    await observeModelWebAssist('u1', cid, tabId);
    const calls = page.emulationCalls;
    layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 408, height: 719 });
    await observeModelWebAssist('u1', cid, tabId);
    expect(page.emulationCalls).toBe(calls);

    // 2026-09-19, found live: a committed navigation drops Chromium's
    // emulation. The cached width made the next call short-circuit, so the page
    // silently went back to the drawer's own width and stayed there.
    page.emulation = null;
    page.emit('did-navigate');
    await observeModelWebAssist('u1', cid, tabId);
    expect(page.emulation, 'a navigation has to restore the desktop layout').not.toBeNull();
    expect(page.emulation.width).toBe(1280);
    expect(page.emulation.scale).toBeCloseTo(408 / 1280, 5);
  });

  it('keeps task-tab timers running off screen without loosening the view hardening', async () => {
    // A task tab is usually not the thing on screen. Chromium clamps a hidden
    // renderer to 1 Hz by default, measured at 20 ticks/s visible against
    // 1.0 minimised, which stalls any page that drives itself on a timer while
    // the agent waits on it.
    electronMock.windowsOpen = true;
    bindWebAssistConversation('u1', 'c-throttle', electronMock.renderer);
    expect((await openModelWebAssist('u1', 'c-throttle', { url: 'https://example.com/work' })).ok).toBe(true);
    expect(electronMock.viewPreferences).toMatchObject({
      backgroundThrottling: false,
      // The security floor is not part of this trade.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: false,
    });
  });

  describe('native task and connector downloads without browser quotas', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const cid = 'c-downloads';
    let page: any;

    function attempt(url: string, filename: string, totalBytes = 1024) {
      const prevented = { value: false };
      const item: any = {
        savePath: '',
        received: 0,
        state: 'progressing',
        handlers: {} as Record<string, (...a: any[]) => void>,
        getURL: () => url,
        getFilename: () => filename,
        getTotalBytes: () => totalBytes,
        getReceivedBytes: () => item.received,
        getState: () => item.state,
        setSavePath: (value: string) => { item.savePath = value; },
        cancel: () => { item.state = 'cancelled'; },
        on: (event: string, handler: any) => { item.handlers[event] = handler; },
        once: (event: string, handler: any) => { item.handlers[event] = handler; },
      };
      electronMock.sessionHandlers['will-download'](
        { preventDefault: () => { prevented.value = true; } },
        item,
        page,
      );
      return { item, prevented };
    }

    beforeEach(async () => {
      fs.rmSync(DOWNLOAD_ROOT, { recursive: true, force: true });
      forgetWebAssistDownloads('u1', cid);
      bindWebAssistConversation('u1', cid, electronMock.renderer);
      const opened = await openControlledWebAssist('u1', cid, { scope: 'connector_setup', scopeId: 'download-fixture', url: 'https://files.example.com/index' });
      expect(opened.ok).toBe(true);
      page = electronMock.page;
    });

    it('allows task-browser downloads from new sites and all file types without an extra grant', async () => {
      await openModelWebAssist('u1', cid, { url: 'https://files.example.com/index' });
      page = electronMock.page;
      const tried = attempt('https://new.example.net/setup.exe', 'setup.exe');
      expect(tried.prevented.value).toBe(false);
      expect(tried.item.savePath).toMatch(/setup\.exe$/);
      expect(webAssistDownloads('u1', cid).downloads).toMatchObject([{ state: 'downloading' }]);
      expect(webAssistState(electronMock.renderer).state.tabs[0]).not.toHaveProperty('download_request');
      tried.item.handlers.done({}, 'completed');
    });

    it('allows connector transfers across sites while keeping saved files and receipts in their task', () => {
      const first = attempt('https://elsewhere.example/report.csv', 'report.csv');
      expect(first.prevented.value).toBe(false);
      expect(first.item.savePath).toBe(path.join(DOWNLOAD_ROOT, 'u1', cid, 'report.csv'));
      expect(webAssistState(electronMock.renderer).state.tabs[0]).not.toHaveProperty('download_request');
      first.item.received = 42; first.item.handlers.done({}, 'completed');
      expect((listModelWebAssistTabs('u1', cid).downloads as unknown[]).at(-1)).toMatchObject({ state: 'saved', bytes: 42, path: first.item.savePath });
      bindWebAssistConversation('u1', 'other-download-task', electronMock.renderer);
      expect(listModelWebAssistTabs('u1', 'other-download-task').downloads).toEqual([]);
      expect(listModelWebAssistTabs('u2', cid)).toMatchObject({ ok: false });
    });

    it('registers download ownership before Chromium can write, and rejects a failed registration without a partial file', () => {
      vi.mocked(recordGeneratedAttachment).mockImplementationOnce((_uid, _cid, file) => {
        expect(fs.existsSync(file)).toBe(true);
        throw Object.assign(new Error('Controlled download ownership failure'), { code: 'ENOSPC' });
      });
      const rejected = attempt('https://files.example.com/report.csv', 'report.csv');
      expect(rejected.prevented.value).toBe(true);
      expect(rejected.item.savePath).toBe('');
      expect(fs.existsSync(path.join(DOWNLOAD_ROOT, 'u1', cid, 'report.csv'))).toBe(false);
      expect(webAssistDownloads('u1', cid).downloads.at(-1)).toMatchObject({ state: 'failed' });
      expect((listModelWebAssistTabs('u1', cid).downloads as unknown[]).at(-1)).not.toHaveProperty('path');
      const retry = attempt('https://files.example.com/report.csv', 'report.csv');
      expect(retry.prevented.value).toBe(false);
      expect(recordGeneratedAttachment).toHaveBeenLastCalledWith('u1', cid, retry.item.savePath);
      retry.item.handlers.done({}, 'completed');
      expect(webAssistDownloads('u1', cid).downloads.at(-1)).toMatchObject({ state: 'saved' });
    });

    it.each(['blob:https://export.example.net/fixture', 'data:text/csv,name%2Cvalue'])('saves page-generated %s without browser consent', url => {
      const transfer = attempt(url, 'site-export.csv');
      expect(transfer.prevented.value).toBe(false);
      expect(transfer.item.savePath).toBe(path.join(DOWNLOAD_ROOT, 'u1', cid, 'site-export.csv'));
    });

    it.each(['blob:null/opaque-id', 'blob:file:///tmp/private.csv', 'file:///tmp/private.csv', 'not-a-url'])
    ('records a transfer without a page origin as failed, with no consent prompt, for %s', (url) => {
      const blocked = attempt(url, 'site-export.csv');
      expect(blocked.prevented.value).toBe(true);
      expect(blocked.item.savePath).toBe('');
      expect(webAssistState(electronMock.renderer).state.tabs[0]).not.toHaveProperty('download_request');
      expect(webAssistDownloads('u1', cid).downloads.at(-1)).toMatchObject({ state: 'failed' });
    });

    it('preserves all existing destinations and reserves concurrent same-name transfers', () => {
      const dir = path.join(DOWNLOAD_ROOT, 'u1', cid);
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(dir, `report${i ? ` (${i})` : ''}.csv`), 'original');
      const transfer = attempt('https://files.example.com/report.csv', 'report.csv');
      expect(transfer.prevented.value).toBe(false);
      expect(fs.statSync(transfer.item.savePath).size).toBe(0);
      expect(path.basename(transfer.item.savePath)).not.toBe('report (99).csv');
      expect(fs.readFileSync(path.join(dir, 'report (99).csv'), 'utf8')).toBe('original');
      const a = attempt('https://files.example.com/new.csv', 'new.csv');
      const b = attempt('https://files.example.com/new.csv', 'new.csv');
      expect(a.item.savePath).not.toBe(b.item.savePath);
    });

    it('has no count or advertised/actual byte quota, including unknown-length transfers', () => {
      for (let i = 0; i < 45; i++) {
        const transfer = attempt(`https://exports.example/${i}`, `export-${i}.bin`, i % 2 ? 0 : 400 * 1024 * 1024);
        expect(transfer.prevented.value).toBe(false);
        transfer.item.received = 400 * 1024 * 1024;
        transfer.item.handlers.updated?.();
        expect(transfer.item.state).toBe('progressing');
        transfer.item.handlers.done({}, 'completed');
      }
      expect(webAssistDownloads('u1', cid).downloads).toHaveLength(45);
      expect(webAssistDownloads('u1', cid).downloads.every(entry => entry.state === 'saved' && entry.bytes === 400 * 1024 * 1024)).toBe(true);
    });

    it('saves all website file types without executing them and contains traversing names', () => {
      for (const filename of ['setup.exe', 'run.sh', 'tool.dmg', 'payload.js', 'export.zip']) {
        const transfer = attempt(`https://new.example/${filename}`, filename);
        expect(transfer.prevented.value).toBe(false);
        expect(path.basename(transfer.item.savePath)).toBe(filename);
      }
      expect(attempt('https://new.example/x', '../../escape.csv').item.savePath).toBe(path.join(DOWNLOAD_ROOT, 'u1', cid, 'escape.csv'));
    });

    it('notifies only the owning task after download state mutations', () => {
      const states: string[][] = [];
      electronMock.renderer.send.mockImplementation((channel: string, payload: any) => {
        if (channel !== 'web-assist:activity') return;
        expect(payload).toEqual({ conversation_id: cid });
        states.push(webAssistDownloads('u1', cid).downloads.map(entry => entry.state));
      });
      try {
        const saved = attempt('https://files.example/a', 'a.csv'); saved.item.handlers.done({}, 'completed');
        const failed = attempt('https://files.example/b', 'b.csv'); failed.item.handlers.done({}, 'cancelled');
        expect(states).toEqual([['downloading'], ['saved'], ['saved', 'downloading'], ['saved', 'failed']]);
      } finally { electronMock.renderer.send.mockReset(); }
    });

    it('cleans up the partial file when a download does not complete', () => {
      const tried = attempt('https://files.example.com/half.csv', 'half.csv');
      expect(tried.prevented.value).toBe(false);
      fs.mkdirSync(path.join(DOWNLOAD_ROOT, 'u1', cid), { recursive: true });
      fs.writeFileSync(tried.item.savePath, 'partial');
      tried.item.received = 7;
      tried.item.handlers.done({}, 'cancelled');
      expect(fs.existsSync(tried.item.savePath)).toBe(false);
      expect(deleteAttachment).toHaveBeenLastCalledWith('u1', cid, 'half.csv');
      expect(webAssistDownloads('u1', cid).downloads.at(-1)).toMatchObject({ state: 'failed' });
      expect((listModelWebAssistTabs('u1', cid).downloads as unknown[]).at(-1)).not.toHaveProperty('path');
    });

    it('keeps simultaneous exports with the same name separate before either file exists', () => {
      const first = attempt('https://files.example.com/report.csv', 'report.csv');
      const second = attempt('https://files.example.com/report.csv', 'report.csv');
      expect(first.item.savePath).toBe(path.join(DOWNLOAD_ROOT, 'u1', cid, 'report.csv'));
      expect(second.item.savePath).toBe(path.join(DOWNLOAD_ROOT, 'u1', cid, 'report (1).csv'));
      expect((listModelWebAssistTabs('u1', cid).downloads as Array<Record<string, unknown>>)
        .every(entry => entry.state === 'downloading' && !entry.path)).toBe(true);
    });
  });

  it('records where an agent took the browser and whether it followed a link', async () => {
    electronMock.windowsOpen = true;
    const cid = 'c-trail';
    forgetWebAssistNavigations('u1', cid);
    bindWebAssistConversation('u1', cid, electronMock.renderer);

    const opened = await openModelWebAssist('u1', cid, { url: 'https://example.com/start' });
    expect(opened.ok).toBe(true);
    const tabId = String(opened.active_tab_id);

    expect(electronMock.renderer.send).toHaveBeenCalledWith('web-assist:activity', { conversation_id: cid });
    electronMock.renderer.send.mockClear();

    // Nothing observed yet, so the first destination cannot have come from a link.
    let trail = webAssistNavigations('u1', cid).navigations;
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      tab_id: tabId, url: 'https://example.com/start', operation: 'open', from_link: false,
    });
    expect(trail[0].origin).toBe('https://example.com');

    // Observe a page that offers a link, then follow it.
    electronMock.observeHref = 'https://example.com/linked';
    expect((await observeModelWebAssist('u1', cid, tabId)).ok).toBe(true);
    expect(await navigateModelWebAssist('u1', cid, {
      tabId, action: 'goto', url: 'https://example.com/linked',
    })).toMatchObject({ ok: true });

    trail = webAssistNavigations('u1', cid).navigations;
    expect(trail).toHaveLength(2);
    expect(electronMock.renderer.send).toHaveBeenCalledWith('web-assist:activity', { conversation_id: cid });
    expect(trail[1]).toMatchObject({
      url: 'https://example.com/linked', operation: 'goto', from_link: true,
    });

    // A destination the page never offered is marked composed — the shape an
    // exfiltration attempt has to take. Reported, not blocked.
    expect((await observeModelWebAssist('u1', cid, tabId)).ok).toBe(true);
    expect(await navigateModelWebAssist('u1', cid, {
      tabId, action: 'goto', url: 'https://elsewhere.example/?d=carried',
    })).toMatchObject({ ok: true });

    trail = webAssistNavigations('u1', cid).navigations;
    expect(trail).toHaveLength(3);
    expect(trail[2]).toMatchObject({ origin: 'https://elsewhere.example', from_link: false });

    // Another task's ledger stays its own.
    expect(webAssistNavigations('u1', 'c-trail-other').navigations).toEqual([]);
    electronMock.observeHref = '';
  });

  it('makes a minimised window for a host-started turn rather than reporting the browser unavailable', () => {
    electronMock.windowsOpen = false;
    // Without a registered factory the old behaviour stands: nothing to host it.
    expect(bindHostStartedWebAssistConversation('u1', 'c-unattended-none')).toBe(false);

    const made = vi.fn(() => { electronMock.windowsOpen = true; return electronMock.owner; });
    setAppWindowFactory(made);
    try {
      expect(bindHostStartedWebAssistConversation('u1', 'c-unattended')).toBe(true);
      expect(made).toHaveBeenCalledTimes(1);
      // Nobody asked to look at this, so it must not take the foreground.
      expect(electronMock.owner.minimize).toHaveBeenCalled();
      // A second host turn reuses the window instead of making another.
      expect(bindHostStartedWebAssistConversation('u1', 'c-unattended-2')).toBe(true);
      expect(made).toHaveBeenCalledTimes(1);
    } finally {
      setAppWindowFactory(null);
    }
  });

  it('surfaces the window only when it is actually out of reach', () => {
    electronMock.windowsOpen = true;
    const { owner } = electronMock;

    // Already on screen: taking focus from the user buys nothing.
    owner.minimized = false;
    owner.shown = true;
    expect(surfaceAppWindow()).toBe(false);
    expect(owner.focus).not.toHaveBeenCalled();

    owner.minimized = true;
    expect(surfaceAppWindow()).toBe(true);
    expect(owner.restore).toHaveBeenCalled();
    expect(owner.focus).toHaveBeenCalled();

    // With no window at all there is nothing to surface.
    electronMock.windowsOpen = false;
    expect(surfaceAppWindow()).toBe(false);
  });

  it('reports a closed window instead of telling a background task to open itself', () => {
    electronMock.windowsOpen = false;
    const cid = 'c-no-window';
    expect(bindHostStartedWebAssistConversation('u1', cid)).toBe(false);
    const listed = listModelWebAssistTabs('u1', cid) as { code?: string; error?: string };
    expect(listed.code).toBe('window_unavailable');
    expect(listed.error).toMatch(/No Orkas window is open/);
    expect(listed.error).not.toMatch(/Open this task in Orkas/);
  });
});

describe('task browser frame inventory', () => {
  // An ad-heavy page listed every iframe with its full tracking address, which
  // alone could exceed the inline tool-result limit.
  it('lists at most 20 frames by origin and path, keeps the observed frame and reports the total', () => {
    const frames = [
      { id: 'MAIN', name: '', url: 'https://shop.example/list?page=2#top' },
      ...Array.from({ length: 23 }, (_, i) => ({
        id: `AD${i}`, parentId: 'MAIN', name: `ad_${i}`,
        url: `https://ads.example.net/render/slot${i}?${'k=v&'.repeat(200)}token=private-${i}`,
      })),
      { id: 'PAY', parentId: 'MAIN', name: 'checkout', url: 'https://pay.example.com/embed/card?session=secret#step=2' },
      { id: 'BLANK', parentId: 'MAIN', name: 'editor', url: 'about:blank' },
    ];
    const inventory = webAssistFrameInventory(frames, 'PAY');

    expect(inventory.frame_count).toBe(26);
    expect(inventory.frames).toHaveLength(20);
    expect(inventory.frames[0]).toEqual({ frame_id: 'MAIN', name: '', display_url: 'https://shop.example/list' });
    expect(inventory.frames[1]).toEqual({ frame_id: 'AD0', parent_frame_id: 'MAIN', name: 'ad_0', display_url: 'https://ads.example.net/render/slot0' });
    expect(inventory.frames.at(-1)).toEqual({
      frame_id: 'PAY', parent_frame_id: 'MAIN', name: 'checkout', display_url: 'https://pay.example.com/embed/card',
    });
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain('private-');
    expect(serialized).not.toContain('session=');
    expect(serialized).not.toContain('k=v');
  });

  it('keeps about:blank editors and leaves an unsupported scheme without an address', () => {
    expect(webAssistFrameInventory([
      { id: 'MAIN', name: '', url: 'https://docs.example/edit' },
      { id: 'EDITOR', parentId: 'MAIN', name: 'rich-text', url: 'about:blank' },
      { id: 'DATA', parentId: 'MAIN', name: '', url: 'data:text/html,<p>x</p>' },
    ], 'MAIN')).toEqual({
      frame_count: 3,
      frames: [
        { frame_id: 'MAIN', name: '', display_url: 'https://docs.example/edit' },
        { frame_id: 'EDITOR', parent_frame_id: 'MAIN', name: 'rich-text', display_url: 'about:blank' },
        { frame_id: 'DATA', parent_frame_id: 'MAIN', name: '', display_url: '' },
      ],
    });
  });
});


// A full observation is sized like a read_files page: it fits the inline
// allowance with its element refs instead of spilling to a short preview.
describe('task browser observation budget', () => {
  const cost = (value: unknown) => estimateToolResultTokens(JSON.stringify(value));
  const observation = (text: string, elements: Array<Record<string, unknown>>) => ({
    ok: true, tab_id: 'tab', page_id: 'page', title: 'Orders', display_url: 'https://shop.example/orders',
    text, text_offset: 1200, text_total: 50_000, text_truncated: true, text_next_offset: 1200 + text.length,
    elements, element_offset: 80, element_count: 400, elements_truncated: true, element_next_offset: 80 + elements.length,
    untrusted_content: true, frame_id: 'MAIN', frame_count: 1,
    frames: [{ frame_id: 'MAIN', name: '', display_url: 'https://shop.example/orders' }],
  });
  const link = (i: number) => ({
    ref: `e${81 + i}`, tag: 'a', label: `商品 ${i} 新款夏季纯棉短袖`,
    href: `https://shop.example/item/${i}?spm=${'x'.repeat(120)}`,
  });

  it('returns an observation that already fits unchanged', () => {
    const fits = observation('Short page', [link(0)]);
    expect(fitWebAssistObservation(fits, 10_000)).toBe(fits);
  });

  it('cuts the page text before any element and continues where the text stopped', () => {
    const text = '订单发货退款商品库存价格'.repeat(500);
    const full = observation(text, Array.from({ length: 20 }, (_, i) => link(i)));
    expect(cost(full)).toBeGreaterThan(10_000);
    const fitted = fitWebAssistObservation(full, 10_000) as any;
    expect(cost(fitted)).toBeLessThanOrEqual(10_000);
    expect(fitted.elements).toEqual(full.elements);
    expect(fitted.text.length).toBeGreaterThan(0);
    expect(text.startsWith(fitted.text)).toBe(true);
    expect(fitted).toMatchObject({ text_offset: 1200, text_truncated: true, text_next_offset: 1200 + fitted.text.length });
  });

  it('cuts elements from the end only when they alone exceed the budget', () => {
    const full = observation('订单'.repeat(100), Array.from({ length: 80 }, (_, i) => link(i)));
    const fitted = fitWebAssistObservation(full, 3_000) as any;
    expect(cost(fitted)).toBeLessThanOrEqual(3_000);
    expect(fitted.elements.length).toBeGreaterThan(0);
    expect(fitted.elements.length).toBeLessThan(80);
    expect(fitted.elements).toEqual(full.elements.slice(0, fitted.elements.length));
    expect(fitted).toMatchObject({
      element_offset: 80, elements_truncated: true, element_next_offset: 80 + fitted.elements.length,
      text_truncated: true, text_next_offset: 1200 + fitted.text.length,
    });
    expect(full.text.startsWith(fitted.text)).toBe(true);
  });

  it('never ends a text window inside a surrogate pair', () => {
    const text = '😀'.repeat(3000);
    for (let budget = 600; budget < 640; budget++) {
      const fitted = fitWebAssistObservation(observation(text, []), budget) as any;
      expect(fitted.text.length % 2).toBe(0);
      expect(fitted.text_next_offset - 1200).toBe(fitted.text.length);
    }
  });
});


describe('AI task browser native dialogs', () => {
  const cid = 'c-native-dialogs';
  beforeEach(async () => {
    electronMock.createWindow?.();
    beginBrowserTaskRun('u1', cid, 'dialog-run');
    bindWebAssistConversation('u1', cid, electronMock.renderer);
    await openModelWebAssist('u1', cid, { url: 'https://example.com/dialogs' });
    // Fake windows share one Chromium Session, including human consent choices.
    permissions.resetWebAssistSitePermissions(electronMock.page);
  });
  afterEach(() => {
    finishBrowserTaskRun('u1', cid, 'dialog-run');
    closeWebAssist(electronMock.renderer);
    vi.useRealTimers();
  });
  const show = (type: string, message = 'Continue?', defaultText = '') => {
    const callback = vi.fn();
    electronMock.page.emit('-run-dialog', { dialogType: type, messageText: message, defaultPromptText: defaultText,
      frame: { url: 'https://example.com/dialogs', origin: 'https://example.com' } }, callback);
    return callback;
  };
  const observe = () => observeModelWebAssist('u1', cid);
  const click = (snapshot: any, label: string) => actOnModelWebAssist('u1', cid, {
    pageId: snapshot.page_id, action: 'click', elementRef: snapshot.elements.find((e: any) => e.label === label)?.ref,
  });

  const requestPermission = (permission = 'screen-wake-lock') => {
    const handler = vi.mocked(session.fromPath('/tmp/fixture').setPermissionRequestHandler).mock.calls.at(-1)![0]!;
    const callback = vi.fn();
    handler(electronMock.page, permission, callback, { requestingUrl: 'https://example.com/request?secret=private', isMainFrame: true });
    return callback;
  };

  it.each([true, false])('answers a screen wake request once without remembering an AI site grant (%s)', async allowed => {
    const before = await observe();
    const callback = requestPermission();
    const snapshot: any = await observe();
    expect(snapshot).toMatchObject({ ok: true, dialog_type: 'permission', permission: 'screen-wake-lock', origin: 'https://example.com', requires_user_action: false });
    expect(JSON.stringify(snapshot)).not.toContain('secret=private');
    expect(await click(before, 'Application name')).toMatchObject({ ok: false, code: 'stale_page' });
    expect(await click(snapshot, allowed ? 'Allow' : 'Deny')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(allowed));
    expect(await click(snapshot, 'Allow')).toMatchObject({ ok: false, code: 'stale_page' });
    const again = requestPermission();
    expect(again).not.toHaveBeenCalled();
    expect(await click(await observe(), 'Deny')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(again).toHaveBeenCalledExactlyOnceWith(false));
  });

  it('exposes sensitive consent through screenshot and wait, preserves human approval and allows cancellation', async () => {
    const callback = requestPermission('media');
    const waited: any = await waitForModelWebAssist('u1', cid, { condition: 'loaded' });
    expect(waited).toMatchObject({ dialog_type: 'permission', permission: 'media', requires_user_action: true, condition_matched: false });
    const shot = await screenshotModelWebAssist('u1', cid, {});
    const snapshot = JSON.parse(shot.content);
    expect(snapshot).toMatchObject({ dialog_type: 'permission', requires_user_action: true });
    expect(electronMock.page.capturePage).not.toHaveBeenCalled();
    expect(await click(snapshot, 'Allow')).toMatchObject({ ok: false, code: 'user_action_required' });
    expect(callback).not.toHaveBeenCalled();
    expect(await click(snapshot, 'Deny')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(false));
  });

  it('rejects stale permission responses after human answers, cancellation and task replacement', async () => {
    setActiveWebAssistConversation(electronMock.renderer, cid);
    const callback = requestPermission();
    let snapshot: any = await observe();
    const controller = new AbortController(); controller.abort();
    expect(await actOnModelWebAssist('u1', cid, { pageId: snapshot.page_id, action: 'click', elementRef: 'e1' }, { signal: controller.signal }))
      .toMatchObject({ ok: false, code: 'task_run_ended' });
    expect(callback).not.toHaveBeenCalled();
    const tab = webAssistState(electronMock.renderer).state.tabs[0];
    expect(answerWebAssistPermission(electronMock.renderer, { tabId: tab.tab_id, requestId: tab.permission_request!.id, allowed: false })).toEqual({ handled: true });
    expect(await click(snapshot, 'Allow')).toMatchObject({ ok: false, code: 'stale_page' });
    requestPermission('system-wake-lock');
    snapshot = await observe();
    finishBrowserTaskRun('u1', cid, 'dialog-run');
    beginBrowserTaskRun('u1', cid, 'replacement');
    expect(await click(snapshot, 'Allow')).toMatchObject({ ok: false, code: 'stale_page' });
    finishBrowserTaskRun('u1', cid, 'replacement');
  });

  it.each(['browser', 'connector'] as const)('returns a permission that arrives during a %s text read instead of a stale success', async scope => {
    if (scope === 'connector') await openControlledWebAssist('u1', cid, { scope: 'connector_setup', scopeId: 'shop', url: 'https://example.com/dialogs' });
    const execute = vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld').mockImplementationOnce(async () => {
      requestPermission();
      return true;
    });
    const input = { condition: 'text', text: 'Ready', timeoutMs: 250 };
    const result = scope === 'browser' ? await waitForModelWebAssist('u1', cid, input)
      : await waitForControlledWebAssist('u1', cid, 'shop', input);
    expect(result).toMatchObject({ dialog_type: 'permission', condition_matched: false });
    execute.mockRestore();
    expect(await click(result, 'Deny')).toMatchObject({ ok: true });
  });

  it('prevents foreign-task and human-takeover permission actions without granting the website', async () => {
    const callback = requestPermission();
    const snapshot: any = await observe();
    expect(await actOnModelWebAssist('u1', 'foreign-task', { pageId: snapshot.page_id, action: 'click', elementRef: 'e1' })).toMatchObject({ ok: false });
    electronMock.page.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left', x: 1, y: 1 });
    expect(await click(snapshot, 'Allow')).toMatchObject({ ok: false, code: 'user_controlled' });
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(['selection', 'passkey'] as const)('projects a pending %s through all browser reads and only permits scoped cancellation', async kind => {
    const read = kind === 'selection'
      ? vi.spyOn(permissions, 'webAssistNativeSelection').mockReturnValue({ id: 'native-decision', origin: 'https://example.com', kind: 'usb' })
      : vi.spyOn(passkeys, 'webAssistPasskeyRequest').mockReturnValue({ id: 'native-decision', origin: 'https://example.com' });
    const cancel = kind === 'selection' ? vi.spyOn(permissions, 'cancelWebAssistNativeSelection') : vi.spyOn(passkeys, 'cancelModelWebAssistPasskey');
    cancel.mockImplementation(() => { read.mockReturnValue(undefined); return true; });
    try {
      const expected = { dialog_type: kind === 'selection' ? 'device_selection' : 'passkey', requires_user_action: true };
      expect(await waitForModelWebAssist('u1', cid, { condition: 'loaded' })).toMatchObject({ ...expected, condition_matched: false });
      expect(JSON.parse((await screenshotModelWebAssist('u1', cid, {})).content)).toMatchObject(expected);
      const snapshot: any = await observe();
      expect(snapshot).toMatchObject(expected);
      expect(snapshot.elements.map((e: any) => e.label)).toEqual(['Cancel']);
      expect(await actOnModelWebAssist('u1', cid, { pageId: snapshot.page_id, action: 'press', keys: 'Enter' }))
        .toMatchObject({ ok: false, code: 'user_action_required' });
      expect(cancel).not.toHaveBeenCalled();
      expect(await click(snapshot, 'Cancel')).toMatchObject({ ok: true });
      expect(cancel).toHaveBeenCalledExactlyOnceWith(electronMock.page, 'native-decision');
      expect(await click(snapshot, 'Cancel')).toMatchObject({ ok: false, code: 'stale_page' });
    } finally { read.mockRestore(); cancel.mockRestore(); }
  });

  it('resumes alerts without native UI and preserves their bounded untrusted messages', async () => {
    const callback = show('alert', 'Saved successfully');
    expect(callback).toHaveBeenCalledExactlyOnceWith(true, '');
    expect(electronMock.page.nativeDialogs).not.toHaveBeenCalled();
    const snapshot = await observe();
    expect(snapshot).toMatchObject({ ok: true, untrusted_content: true, dismissed_dialogs: [{ type: 'alert', message: 'Saved successfully' }] });
    expect((await observe()).dismissed_dialogs).toBeUndefined();
  });

  it.each([true, false])('lets AI explicitly answer a confirmation (%s) exactly once', async accept => {
    const before = await observe();
    const callback = show('confirm');
    expect(callback).not.toHaveBeenCalled();
    const snapshot = await observe();
    expect(snapshot).toMatchObject({ ok: true, dialog_type: 'confirm', text: 'Continue?' });
    expect(await click(before, 'Application name')).toMatchObject({ ok: false, code: 'stale_page' });
    expect(await click(snapshot, accept ? 'OK' : 'Cancel')).toMatchObject({ ok: true });
    expect(callback).toHaveBeenCalledExactlyOnceWith(accept, '');
    expect(await click(snapshot, 'OK')).toMatchObject({ ok: false, code: 'stale_page' });
    expect(electronMock.page.nativeDialogs).not.toHaveBeenCalled();
  });

  it('fills a prompt verbatim without exposing its default or entered value', async () => {
    const callback = show('prompt', 'Name?', 'private-default');
    const snapshot: any = await observe();
    expect(snapshot.dialog_type).toBe('prompt');
    expect(JSON.stringify(snapshot)).not.toContain('private-default');
    const field = snapshot.elements.find((e: any) => e.fillable);
    const text = '  张三\n😀  ';
    expect(await actOnModelWebAssist('u1', cid, { pageId: snapshot.page_id, elementRef: field.ref, action: 'fill', text })).toMatchObject({ ok: true });
    expect(callback).not.toHaveBeenCalled();
    expect(await readModelWebAssistValue('u1', cid, { pageId: snapshot.page_id, elementRef: field.ref })).toMatchObject({ ok: false, code: 'sensitive_field' });
    expect(await click(snapshot, 'OK')).toMatchObject({ ok: true });
    expect(callback).toHaveBeenCalledExactlyOnceWith(true, text);
  });

  it.each(['browser', 'connector'] as const)('claims %s dialogs before current-turn history navigation starts', async entry => {
    if (entry === 'connector') await openControlledWebAssist('u1', cid, { scope: 'connector_setup', scopeId: 'shop', url: 'https://example.com/dialogs' });
    finishBrowserTaskRun('u1', cid, 'dialog-run');
    beginBrowserTaskRun('u1', cid, 'replacement');
    let callback: any;
    electronMock.page.reload = () => { callback = show('alert', 'Reloaded'); };
    const result = entry === 'browser'
      ? await navigateModelWebAssist('u1', cid, { action: 'reload' })
      : await navigateControlledWebAssist('u1', cid, 'shop', 'reload');
    expect(result).toMatchObject({ ok: true });
    expect(callback).toHaveBeenCalledExactlyOnceWith(true, '');
    expect(electronMock.page.nativeDialogs).not.toHaveBeenCalled();
    finishBrowserTaskRun('u1', cid, 'replacement');
  });

  it('reclaims connector dialog control after observing in a new turn and revokes it for manual history navigation', async () => {
    await openControlledWebAssist('u1', cid, { scope: 'connector_setup', scopeId: 'shop', url: 'https://example.com/dialogs' });
    finishBrowserTaskRun('u1', cid, 'dialog-run');
    beginBrowserTaskRun('u1', cid, 'replacement');
    await observeControlledWebAssist('u1', cid, 'shop');
    const callback = show('alert');
    expect(callback).toHaveBeenCalledExactlyOnceWith(true, '');
    electronMock.page.reload = () => { show('alert'); };
    expect(navigateWebAssist(electronMock.renderer, 'reload')).toMatchObject({ ok: true });
    expect(electronMock.page.nativeDialogs).toHaveBeenCalledTimes(1);
    finishBrowserTaskRun('u1', cid, 'replacement');
  });

  it('does not replace a pending decision with a navigation or unsupported page input', async () => {
    const callback = show('confirm');
    const snapshot: any = await observe();
    expect(await navigateModelWebAssist('u1', cid, { action: 'goto', url: 'https://example.com/other' }))
      .toMatchObject({ ok: false, code: 'dialog_pending' });
    expect(await actOnModelWebAssist('u1', cid, { pageId: snapshot.page_id, action: 'scroll' }))
      .toMatchObject({ ok: false, code: 'invalid_action' });
    expect(callback).not.toHaveBeenCalled();
    expect(await click(snapshot, 'Cancel')).toMatchObject({ ok: true });
    expect(callback).toHaveBeenCalledExactlyOnceWith(false, '');
  });

  it('does not send a cancelled answer and keeps the decision available to a fresh action', async () => {
    const callback = show('confirm');
    const snapshot: any = await observe();
    const controller = new AbortController(); controller.abort();
    expect(await actOnModelWebAssist('u1', cid, { pageId: snapshot.page_id, action: 'click', elementRef: 'e1' }, { signal: controller.signal }))
      .toMatchObject({ ok: false, code: 'task_run_ended' });
    expect(callback).not.toHaveBeenCalled();
    expect(await click(snapshot, 'Cancel')).toMatchObject({ ok: true });
    expect(callback).toHaveBeenCalledExactlyOnceWith(false, '');
  });

  it('yields a dialog that opens during observation without waiting for the frozen renderer or publishing its late reply', async () => {
    let entered!: () => void, release!: (value: unknown) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const execute = vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld').mockImplementation(() => {
      entered(); return new Promise(resolve => { release = resolve; });
    });
    const reading = observe();
    await started;
    const callback = show('confirm', 'Timer confirmation');
    const result: any = await reading;
    expect(result).toMatchObject({ ok: true, dialog_type: 'confirm', text: 'Timer confirmation' });
    release({ ok: true, text: 'Stale underlying page', elements: [] });
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
    expect(await click(result, 'Cancel')).toMatchObject({ ok: true });
    expect(callback).toHaveBeenCalledExactlyOnceWith(false, '');
    execute.mockRestore();
  });

  it('reports dialogs through wait without entering the blocked page executor', async () => {
    const callback = show('confirm');
    const execute = vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld').mockRejectedValue(new Error('renderer is blocked'));
    const result = await waitForModelWebAssist('u1', cid, { condition: 'text', text: 'Done', timeoutMs: 250 });
    expect(result).toMatchObject({ ok: true, dialog_type: 'confirm' });
    expect(execute).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    execute.mockRestore();
  });

  it('returns a pending dialog to the native handler on human takeover and invalidates AI input', async () => {
    const callback = show('confirm');
    const snapshot = await observe();
    electronMock.page.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left', x: 1, y: 1 });
    expect(electronMock.page.nativeDialogs).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false, '');
    expect(await click(snapshot, 'OK')).toMatchObject({ ok: false, code: 'user_controlled' });
    const humanAlert = show('alert');
    expect(humanAlert).toHaveBeenCalledExactlyOnceWith(false, '');
    expect(electronMock.page.nativeDialogs).toHaveBeenCalledTimes(2);
  });

  it('cancels pending input on task end and never inherits control in a replacement run', async () => {
    const callback = show('prompt');
    const snapshot = await observe();
    finishBrowserTaskRun('u1', cid, 'dialog-run');
    expect(callback).toHaveBeenCalledExactlyOnceWith(false, '');
    beginBrowserTaskRun('u1', cid, 'replacement');
    const human = show('confirm');
    expect(human).toHaveBeenCalledExactlyOnceWith(false, '');
    expect(electronMock.page.nativeDialogs).toHaveBeenCalledTimes(1);
    expect(await click(snapshot, 'OK')).toMatchObject({ ok: false, code: 'stale_page' });
    finishBrowserTaskRun('u1', cid, 'replacement');
  });
});
