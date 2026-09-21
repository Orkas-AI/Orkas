import * as vm from 'node:vm';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logWebAssistFailure } from '../../../src/main/features/web_assist_diagnostics';

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

// The gate's own rules (which handbacks it offers, how a grant is bound, when
// it is withdrawn) are covered in web-assist-action-confirm.test.ts. Here the
// question is only whether web_assist.ts consults it and retries.
const confirmMock = vi.hoisted(() => ({
  decision: 'deny' as 'deny' | 'once' | 'run',
  requests: [] as Array<Record<string, any>>,
  grants: new Set<string>(),
  key: (target: any) => `${target.userId}|${target.conversationId}|${target.tabId}|${target.origin}|${target.label}`,
}));

vi.mock('../../../src/main/features/web_assist_confirm', async (importOriginal) => ({
  isGateableWebAssistReason: (reason: unknown) => (
    reason === 'high_impact_action' || reason === 'form_submission_or_authorization'
  ),
  webAssistPageOrigin: (await importOriginal<typeof import('../../../src/main/features/web_assist_confirm')>()).webAssistPageOrigin,
  hasWebAssistActionGrant: (target: any) => target.origin !== '' && confirmMock.grants.has(confirmMock.key(target)),
  rememberWebAssistActionGrant: (target: any) => { confirmMock.grants.add(confirmMock.key(target)); },
  clearWebAssistActionGrants: () => { confirmMock.grants.clear(); },
  requestWebAssistActionConfirm: vi.fn(async (opts: any) => {
    confirmMock.requests.push(opts);
    return confirmMock.decision;
  }),
}));

// Login persistence has its own real-storage and Electron restart coverage.
vi.mock('../../../src/main/features/web_assist_session', () => ({
  prepareWebAssistSession: vi.fn(async () => {}),
}));

vi.mock('electron', () => {
  class FakeEmitter {
    private listeners = new Map<string, Array<(...args: any[]) => void>>();

    on(event: string, listener: (...args: any[]) => void): this {
      const rows = this.listeners.get(event) || [];
      rows.push(listener);
      this.listeners.set(event, rows);
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
      this.listeners.set(event, (this.listeners.get(event) || []).filter((row) => row !== listener));
      return this;
    }

    emit(event: string, ...args: any[]): void {
      for (const listener of [...(this.listeners.get(event) || [])]) listener(...args);
    }
  }

  class FakePage extends FakeEmitter {
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
    setUserAgent(): void {}
    emulation: null | Record<string, any> = null;
    emulationCalls = 0;
    enableDeviceEmulation(params: Record<string, any>): void {
      this.emulation = params; this.emulationCalls += 1;
    }
    disableDeviceEmulation(): void { this.emulation = null; }
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
            requires_user_action: false,
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
    setBounds(): void {}
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
    webRequest: { onBeforeRequest: (handler: any) => { electronMock.beforeRequest = handler; } },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      electronMock.sessionHandlers[event] = handler;
    }),
  };

  return {
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
    session: { fromPath: () => fakeSession },
    shell: { openExternal: vi.fn() },
    WebContentsView: FakeWebContentsView,
  };
});

import {
  actOnControlledWebAssist,
  actOnModelWebAssist,
  activateWebAssistTab,
  addWebAssistTab,
  bindHostStartedWebAssistConversation,
  bindWebAssistConversation,
  closeWebAssistTab,
  closeWebAssist,
  closeModelWebAssistTab,
  retainModelWebAssistTab,
  listModelWebAssistTabs,
  navigateModelWebAssist,
  navigateControlledWebAssist,
  observeControlledWebAssist,
  observeModelWebAssist,
  openControlledWebAssist,
  openModelWebAssist,
  openWebAssist,
  layoutWebAssist,
  captureWebAssistPreview,
  navigateWebAssistTo,
  setActiveWebAssistConversation,
  waitForModelWebAssist,
  waitForControlledWebAssist,
  reclaimIdleWebAssistPages,
  webAssistIdleSafetyScript,
  webAssistState,
  openWebAssistInDefaultBrowser,
  allowWebAssistDownloadOrigin,
  forgetWebAssistDownloads,
  webAssistDownloads,
  MAX_TABS_PER_CONVERSATION as TAB_LIMIT,
  setAppWindowFactory,
  surfaceAppWindow,
  webAssistNavigations,
  forgetWebAssistNavigations,
} from '../../../src/main/features/web_assist';
import {
  beginBrowserTaskRun, finishBrowserTaskRun,
} from '../../../src/main/features/web_assist_lifecycle';

describe('Web Assist controlled connector lifecycle', () => {
  beforeEach(() => {
    electronMock.createWindow?.();
    vi.mocked(logWebAssistFailure).mockClear();
    confirmMock.decision = 'deny';
    confirmMock.requests.length = 0;
    confirmMock.grants.clear();
  });

  describe.each(['browser', 'connector'] as const)('%s text wait deadline', (scope) => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      closeWebAssist(electronMock.renderer);
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    async function openWait() {
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
        ? waitForModelWebAssist('u1', cid, input)
        : waitForControlledWebAssist('u1', cid, 'shop', input);
    }

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

  describe('browser overlay preview', () => {
    afterEach(() => { closeWebAssist(electronMock.renderer); vi.useRealTimers(); });
    async function setup() {
      setActiveWebAssistConversation(electronMock.renderer, 'c-preview');
      const opened = await openWebAssist('u1', electronMock.renderer, { conversationId: 'c-preview', url: 'https://example.com/work' });
      if (!opened.ok) throw new Error('Preview fixture setup failed');
      layoutWebAssist(electronMock.renderer, { x: 400, y: 100, width: 600, height: 500 });
      const bitmap = { isEmpty: () => false, getSize: () => ({ width: 3200, height: 1600 }),
        resize: vi.fn(), toJPEG: () => Buffer.from('fixture-pixels') };
      bitmap.resize.mockReturnValue(bitmap);
      electronMock.page.capturePage.mockResolvedValue(bitmap);
      return { tabId: opened.state.active_tab_id, bitmap, page: electronMock.page };
    }
    it('captures only the current owned tab, including a hidden overlay backdrop, with a bounded image', async () => {
      const { tabId, bitmap, page } = await setup();
      expect(await captureWebAssistPreview(electronMock.renderer, 'other-tab')).toEqual({ preview: null });
      expect(await captureWebAssistPreview({} as any, tabId)).toEqual({ preview: null });
      expect(page.capturePage).not.toHaveBeenCalled();
      expect(await captureWebAssistPreview(electronMock.renderer, tabId)).toEqual({ preview: 'data:image/jpeg;base64,' + Buffer.from('fixture-pixels').toString('base64') });
      expect(bitmap.resize).toHaveBeenCalledWith({ width: 1600, height: 800 });
      expect(JSON.stringify(webAssistState(electronMock.renderer))).not.toContain('base64');
      layoutWebAssist(electronMock.renderer, { visible: false });
      expect((await captureWebAssistPreview(electronMock.renderer, tabId)).preview).toContain('data:image/jpeg');
      expect(page.capturePage).toHaveBeenCalledTimes(2);
      expect(page.capturePage).toHaveBeenLastCalledWith(undefined, { stayHidden: true });
    });
    it.each(['task', 'navigation', 'close'])('discards an image after %s changes during capture', async change => {
      const { tabId, bitmap, page } = await setup();
      let finish!: (value: any) => void;
      page.capturePage.mockReturnValue(new Promise(resolve => { finish = resolve; }));
      const pending = captureWebAssistPreview(electronMock.renderer, tabId);
      if (change === 'task') setActiveWebAssistConversation(electronMock.renderer, 'other-task');
      if (change === 'navigation') await page.loadURL('https://example.com/next');
      if (change === 'close') closeWebAssist(electronMock.renderer);
      finish(bitmap);
      expect(await pending).toEqual({ preview: null });
    });
    it('bounds stalled captures without accumulating native calls and allows recovery', async () => {
      vi.useFakeTimers();
      const { tabId, bitmap, page } = await setup();
      let finish!: (value: any) => void;
      page.capturePage.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      const first = captureWebAssistPreview(electronMock.renderer, tabId);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await first).toEqual({ preview: null });
      const second = captureWebAssistPreview(electronMock.renderer, tabId);
      expect(page.capturePage).toHaveBeenCalledTimes(1);
      finish(bitmap);
      expect((await second).preview).toContain('data:image/jpeg');
      expect((await captureWebAssistPreview(electronMock.renderer, tabId)).preview).toContain('data:image/jpeg');
      expect(page.capturePage).toHaveBeenCalledTimes(2);
    });
  });

  describe('navigation status follows the current page', () => {
    afterEach(() => {
      closeWebAssist(electronMock.renderer);
      vi.restoreAllMocks();
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

    it('keeps full addresses in browser chrome without adding them to general or connector model results', async () => {
      const cid = 'c-address';
      const url = `https://example.com/work?ticket=fixture-query&item=one&item=two&encoded=%2F%26&long=${'a'.repeat(2200)}#fixture-fragment`;
      bindWebAssistConversation('u1', cid, electronMock.renderer);
      const opened = await openModelWebAssist('u1', cid, { url });
      expect(opened.ok).toBe(true);
      expect(webAssistState(electronMock.renderer).state.tabs[0]).toMatchObject({ address_url: url, display_url: 'https://example.com/work' });
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
        expect(text).not.toContain('fixture-query');
        expect(text).not.toContain('fixture-fragment');
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

      const meta = await observeModelWebAssist('u1', cid, tabId, 'meta');
      expect(meta).toMatchObject({
        ok: true, scope: 'meta', element_count: 1, text_length: 'Create an app'.length,
      });
      // The point of meta is a fresh page_id without paying for the page.
      expect(meta).not.toHaveProperty('text');
      expect(meta).not.toHaveProperty('elements');
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
      expect(logWebAssistFailure).toHaveBeenLastCalledWith(electronMock.renderer, 'renderer_gone');
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
          tab_limit: TAB_LIMIT, tabs: [{ tab_id: tabId, suspended: true, display_url: 'https://example.com/work' }],
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

  it.each([true, false])('allows one safe child authorization window with host focusability %s and rejects unsafe or nested navigation', async (focusable) => {
    const { renderer, owner } = electronMock;
    owner.isFocusable = () => focusable;
    const opened = await openWebAssist('u1', renderer, {
      conversationId: 'c-popup',
      url: 'https://provider.example/settings',
    });
    expect(opened).toMatchObject({ ok: true });
    const parentPage = electronMock.page;
    const requested = parentPage.windowOpenHandler?.({ url: 'https://login.example/authorize', disposition: 'new-window' });
    expect(requested).toMatchObject({
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        parent: owner,
        modal: false,
        show: focusable,
        focusable,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      },
    });
    expect(requested.overrideBrowserWindowOptions).not.toHaveProperty('width');
    expect(requested.overrideBrowserWindowOptions).not.toHaveProperty('height');
    expect(parentPage.windowOpenHandler?.({ url: 'about:blank', disposition: 'new-window' })).toMatchObject({ action: 'allow' });
    for (const url of ['file:///tmp/private', 'javascript:alert(1)', 'https://user:secret@login.example/']) {
      expect(parentPage.windowOpenHandler?.({ url }), url).toEqual({ action: 'deny' });
    }

    const popupPage = electronMock.createPage?.();
    parentPage.emit('did-create-window', {
      webContents: popupPage,
      setMenuBarVisibility: vi.fn(),
    }, { url: 'https://login.example/authorize' });
    expect(popupPage.windowOpenHandler?.({ url: 'https://login.example/nested' }))
      .toEqual({ action: 'deny' });
    const blockedNavigation = { preventDefault: vi.fn() };
    popupPage.emit('will-navigate', blockedNavigation, 'orkas://oauth/callback');
    expect(blockedNavigation.preventDefault).toHaveBeenCalledOnce();
    const allowedNavigation = { preventDefault: vi.fn() };
    popupPage.emit('will-redirect', allowedNavigation, 'https://provider.example/callback');
    expect(allowedNavigation.preventDefault).not.toHaveBeenCalled();
  });

  it.each(['foreground-tab', 'background-tab', 'default'])('adopts %s pages into task tabs without reloading Chromium guests', async disposition => {
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
    for (let i = 2; i < TAB_LIMIT; i++) addWebAssistTab('u1', renderer, { conversationId: 'c-link-limit' });
    expect(parent.windowOpenHandler({ url: 'https://example.com/extra', disposition: 'foreground-tab' })).toEqual({ action: 'deny' });
    expect((listModelWebAssistTabs('u1', 'c-link-limit') as any).tabs).toHaveLength(TAB_LIMIT);
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
    })).resolves.toMatchObject({ ok: false, code: 'stale_page' });

    await expect(navigateControlledWebAssist(
      'u1', 'c1', 'xiaohongshu-seller', 'close',
    )).resolves.toMatchObject({ ok: true, closed: true });
    await expect(observeControlledWebAssist('u1', 'c1', 'xiaohongshu-seller')).resolves.toMatchObject({
      ok: false,
      code: 'not_open',
    });
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

  it('shares the current task tab with general in-process model browsing and replaces narrower connector scope', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-browser', renderer);
    const opened = await openModelWebAssist('u1', 'c-browser', {
      url: 'https://example.com/start?secret=hidden',
      label: 'Shared page',
    });
    expect(opened).toMatchObject({
      ok: true,
      tab: { label: 'Shared page', display_url: 'https://example.com/start' },
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
    // Off-task the work continues, but nothing is revealed over what the user
    // is watching: no web-assist:show is pushed while running in background.
    const revealsBefore = renderer.send.mock.calls
      .filter(([event]: any[]) => event === 'web-assist:show').length;
    await expect(observeModelWebAssist('u1', 'c-browser', tabId))
      .resolves.toMatchObject({ ok: true, tab_id: tabId });
    expect(renderer.send.mock.calls
      .filter(([event]: any[]) => event === 'web-assist:show').length).toBe(revealsBefore);
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
    expect(renderer.send.mock.calls.some(([channel]: any[]) => channel === 'web-assist:show')).toBe(false);
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

  it('selects the connector activity tab for auto-reveal without stealing another task view', async () => {
    const { renderer } = electronMock;
    bindWebAssistConversation('u1', 'c-reveal', renderer);
    const opened = await openControlledWebAssist('u1', 'c-reveal', {
      scope: 'connector_setup', scopeId: 'shop', url: 'https://provider.example/setup',
    });
    if (!opened.ok) throw new Error('controlled page setup failed');
    addWebAssistTab('u1', renderer, { conversationId: 'c-reveal' });
    renderer.send.mockClear();
    await expect(observeControlledWebAssist('u1', 'c-reveal', 'shop')).resolves.toMatchObject({ ok: true });
    expect(renderer.send).toHaveBeenCalledWith('web-assist:state', expect.objectContaining({
      conversation_id: 'c-reveal', active_tab_id: opened.state.active_tab_id, assistant_action: 'observing',
    }));
    const other = addWebAssistTab('u1', renderer, { conversationId: 'other-task' });
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

  it('allows ordinary submissions after browser takeover without retaining connector authority', async () => {
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
      disabled = false;
      autocomplete = '';
      form: { elements: PageElement[] } | null = null;
      clicks = 0;
      constructor(public tagName: string, public type: string, public innerText: string) {}
      getAttribute(name: string): string | null { return name === 'type' ? this.type : null; }
      getBoundingClientRect(): { width: number; height: number } { return { width: 100, height: 30 }; }
      scrollIntoView(): void {}
      focus(): void {}
      click(): void { this.clicks += 1; }
    }
    const submit = new PageElement('BUTTON', 'submit', 'Save');
    const field = new PageElement('INPUT', 'text', 'Display name');
    submit.form = { elements: [field, submit] };
    const document = {
      title: 'Provider setup',
      children: [submit, field],
      querySelectorAll: (selector: string) => selector.startsWith('a[href]') ? [submit, field] : [],
    };
    submit.parentNode = document;
    field.parentNode = document;
    vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld').mockImplementation(
      async (_worldId: unknown, scripts: Array<{ code: string }>) => vm.runInNewContext(scripts[0].code, {
        document, Element: PageElement, ShadowRoot: class {},
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      }),
    );
    const ordinary = await observeControlledWebAssist('u1', cid, 'shop');
    expect(ordinary).toMatchObject({ ok: true, elements: [{ label: 'Save', requires_user_action: false }, {}] });
    await expect(actOnControlledWebAssist('u1', cid, 'shop', {
      pageId: ordinary.page_id, elementRef: 'e1', action: 'click',
    })).resolves.toMatchObject({ ok: true, outcome: 'acted' });
    expect(submit.clicks).toBe(1);

    field.type = 'password';
    const sensitive = await observeControlledWebAssist('u1', cid, 'shop');
    expect(sensitive).toMatchObject({ ok: true, elements: [{ requires_user_action: true }, {}] });
    await expect(actOnControlledWebAssist('u1', cid, 'shop', {
      pageId: sensitive.page_id, elementRef: 'e1', action: 'click',
    })).resolves.toMatchObject({ ok: false, code: 'user_action_required', reason: 'sensitive_form_submission' });
    expect(submit.clicks).toBe(1);

    field.type = 'text';
    const browser = await observeModelWebAssist('u1', cid, opened.state.active_tab_id);
    expect(browser).toMatchObject({ ok: true, elements: [{ requires_user_action: false }, {}] });
    await expect(actOnModelWebAssist('u1', cid, {
      tabId: opened.state.active_tab_id, pageId: browser.page_id, elementRef: 'e1', action: 'click',
    })).resolves.toMatchObject({ ok: true, outcome: 'acted' });
    expect(submit.clicks).toBe(2);
    await expect(actOnControlledWebAssist('u1', cid, 'shop', {
      pageId: browser.page_id, elementRef: 'e1', action: 'click',
    })).resolves.toMatchObject({ ok: false, code: 'scope_mismatch' });
    expect(submit.clicks).toBe(2);
  });

  it('turns a handed-back control into an approved click and repeats it under a task grant', async () => {
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
      getBoundingClientRect(): { width: number; height: number } { return { width: 100, height: 30 }; }
      scrollIntoView(): void {}
      focus(): void {}
      click(): void { this.clicks += 1; }
    }
    // Ordinary submissions run without asking, so the handback this case is
    // about is a high-impact control: an authorization the user must accept.
    const send = new PageElement('BUTTON', 'button', 'Authorize app');
    const remove = new PageElement('BUTTON', 'button', 'Delete chat');
    const document = {
      title: 'ChatGPT',
      children: [send, remove],
      querySelectorAll: (selector: string) => (selector.startsWith('a[href]') ? [send, remove] : []),
    };
    send.parentNode = document;
    remove.parentNode = document;
    vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld').mockImplementation(
      async (_worldId: unknown, scripts: Array<{ code: string }>) => vm.runInNewContext(scripts[0].code, {
        document, Element: PageElement, ShadowRoot: class {},
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      }),
    );
    const clickSend = async () => {
      const observation = await observeModelWebAssist('u1', 'c-approve', tabId);
      return actOnModelWebAssist('u1', 'c-approve', {
        tabId, pageId: (observation as any).page_id, elementRef: 'e1', action: 'click',
      });
    };

    const first = await observeModelWebAssist('u1', 'c-approve', tabId);
    expect(first).toMatchObject({ ok: true, elements: [{ label: 'Authorize app', requires_user_action: true }, {}] });

    // Denied: the model keeps exactly the handback it already had.
    await expect(actOnModelWebAssist('u1', 'c-approve', {
      tabId, pageId: (first as any).page_id, elementRef: 'e1', action: 'click',
    })).resolves.toMatchObject({ ok: false, code: 'user_action_required', reason: 'high_impact_action' });
    expect(send.clicks).toBe(0);
    expect(confirmMock.requests).toHaveLength(1);
    expect(confirmMock.requests[0]).toMatchObject({
      reason: 'high_impact_action',
      // The title comes from the live page, not the observation snapshot.
      pageTitle: expect.stringMatching(/\S/),
      target: { origin: 'https://chatgpt.com', label: 'Authorize app', tabId, conversationId: 'c-approve' },
    });

    confirmMock.decision = 'run';
    await expect(clickSend()).resolves.toMatchObject({ ok: true, outcome: 'acted', action: 'click' });
    expect(send.clicks).toBe(1);
    expect(confirmMock.requests).toHaveLength(2);

    // The grant is what makes a repeated step usable: same control, no dialog.
    await expect(clickSend()).resolves.toMatchObject({ ok: true, outcome: 'acted' });
    expect(send.clicks).toBe(2);
    expect(confirmMock.requests).toHaveLength(2);

    // It does not spread to the next control on the same page.
    confirmMock.decision = 'deny';
    const other = await observeModelWebAssist('u1', 'c-approve', tabId);
    await expect(actOnModelWebAssist('u1', 'c-approve', {
      tabId, pageId: (other as any).page_id, elementRef: 'e2', action: 'click',
    })).resolves.toMatchObject({ ok: false, code: 'user_action_required', reason: 'high_impact_action' });
    expect(remove.clicks).toBe(0);
    expect(confirmMock.requests).toHaveLength(3);
    expect(confirmMock.requests[2]).toMatchObject({ target: { label: 'Delete chat' } });
  });

  it.each(['navigation', 'tab close', 'new observation', 'task end', 'abort'])(
    'rejects delayed approval after %s, even if the control signature still matches', async (change) => {
    const cid = 'c-approval-race';
    bindWebAssistConversation('u1', cid, electronMock.renderer);
    const { beginBrowserTaskRun, finishBrowserTaskRun } = await import('../../../src/main/features/web_assist_lifecycle');
    beginBrowserTaskRun('u1', cid, 'approval-run');
    const opened = await openModelWebAssist('u1', cid, { url: 'https://chatgpt.com/' });
    const tabId = opened.active_tab_id as string;
    class PageElement {
      form: { elements: PageElement[] } | null = null;
      parentNode: any = null;
      disabled = false;
      clicks = 0;
      constructor(public tagName: string, public type: string, public innerText: string) {}
      getAttribute(name: string): string | null { return name === 'type' ? this.type : null; }
      getBoundingClientRect(): { width: number; height: number } { return { width: 100, height: 30 }; }
      scrollIntoView(): void {}
      focus(): void {}
      click(): void { this.clicks += 1; }
    }
    // Ordinary submissions run without asking, so the handback this case is
    // about is a high-impact control: an authorization the user must accept.
    const send = new PageElement('BUTTON', 'button', 'Authorize app');
    const remove = new PageElement('BUTTON', 'button', 'Delete chat');
    const document = {
      title: 'ChatGPT',
      children: [send, remove],
      querySelectorAll: (selector: string) => (selector.startsWith('a[href]') ? [send, remove] : []),
    };
    send.parentNode = document;
    remove.parentNode = document;
    vi.spyOn(electronMock.page, 'executeJavaScriptInIsolatedWorld').mockImplementation(
      async (_worldId: unknown, scripts: Array<{ code: string }>) => vm.runInNewContext(scripts[0].code, {
        document, Element: PageElement, ShadowRoot: class {},
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      }),
    );

    const { requestWebAssistActionConfirm } = await import('../../../src/main/features/web_assist_confirm');
    let approve!: (decision: 'run') => void;
    vi.mocked(requestWebAssistActionConfirm).mockImplementationOnce(async (options) => {
      confirmMock.requests.push(options);
      return new Promise((resolve) => { approve = resolve; });
    });
    const { buildConversationBrowserTool } = await import('../../../src/main/features/group_chat/browser_tool');
    const tool = buildConversationBrowserTool('u1', cid);
    const observation = await observeModelWebAssist('u1', cid, tabId);
    const controller = new AbortController();
    const pending = tool.execute({ operation: 'act', tab_id: tabId, page_id: observation.page_id,
      element_ref: 'e1', page_action: 'click' }, { signal: controller.signal } as never);
    await vi.waitFor(() => expect(confirmMock.requests).toHaveLength(1));
    if (change === 'navigation') await electronMock.page.loadURL('https://chatgpt.com/other');
    if (change === 'tab close') closeModelWebAssistTab('u1', cid, tabId);
    if (change === 'new observation') await observeModelWebAssist('u1', cid, tabId);
    if (change === 'task end') finishBrowserTaskRun('u1', cid, 'approval-run');
    if (change === 'abort') controller.abort();
    approve('run');
    expect(JSON.parse((await pending).content).ok).toBe(false);
    expect(send.clicks).toBe(0);
    expect(confirmMock.grants.size).toBe(0);
    finishBrowserTaskRun('u1', cid, 'approval-run');
  });

  it('does not let connector_setup inherit a tab after the general browser tool takes it over', async () => {
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
      .resolves.toMatchObject({ ok: false, code: 'scope_mismatch' });
  });

  it('ensures one blank task tab without navigating, duplicating existing work, or selecting another task', async () => {
    const { renderer } = electronMock;
    const first = addWebAssistTab('u1', renderer, { conversationId: 'c-default', ifEmpty: true });
    if (!first.ok) throw new Error('tab setup failed');
    const firstId = first.state.active_tab_id!;
    const firstPage = electronMock.page;
    expect(firstPage.getURL()).toBe('');
    expect(first.state.tabs).toHaveLength(1);
    expect(first.state.tabs[0]).toMatchObject({ tab_id: firstId, created_by: 'user', loading: false, address_url: '' });
    await navigateWebAssistTo(renderer, { tabId: firstId, url: 'https://example.com/keep?item=1#draft' });
    const second = addWebAssistTab('u1', renderer, { conversationId: 'c-default', ifEmpty: true });
    expect(second).toEqual({ ok: true, state: webAssistState(renderer).state });
    expect(webAssistState(renderer).state.tabs).toHaveLength(1);
    expect(firstPage.getURL()).toBe('https://example.com/keep?item=1#draft');
    const other = addWebAssistTab('u1', renderer, { conversationId: 'c-other', ifEmpty: true });
    expect(other).toMatchObject({ ok: true, state: { active_tab_id: firstId } });
    expect(webAssistState(renderer).state.tabs).toHaveLength(2);
    closeWebAssistTab(renderer, firstId);
    const replacement = addWebAssistTab('u1', renderer, { conversationId: 'c-default', ifEmpty: true });
    if (!replacement.ok) throw new Error('replacement failed');
    const taskTabs = replacement.state.tabs.filter(tab => tab.conversation_id === 'c-default');
    expect(taskTabs).toHaveLength(1);
    expect(taskTabs[0].tab_id).not.toBe(firstId);
    expect(taskTabs[0].address_url).toBe('');
    expect(firstPage.isDestroyed()).toBe(true);
  });

  it('adds, navigates, activates, and closes independent tabs for one task', async () => {
    const { renderer } = electronMock;
    const first = addWebAssistTab('u1', renderer, { conversationId: 'c-tabs' });
    expect(first).toMatchObject({ ok: true, state: { open: true, tabs: [{ conversation_id: 'c-tabs' }] } });
    if (!first.ok) throw new Error('tab setup failed');
    const firstId = first.state.active_tab_id!;
    await expect(navigateWebAssistTo(renderer, { tabId: firstId, url: 'example.com/one' }))
      .resolves.toMatchObject({ ok: true, state: { display_url: 'https://example.com/one' } });
    await expect(navigateWebAssistTo(renderer, { tabId: firstId, url: 'orkas browser' }))
      .resolves.toMatchObject({ ok: true, state: { display_url: 'https://www.bing.com/search' } });
    expect(electronMock.page.getURL()).toBe('https://www.bing.com/search?q=orkas+browser');
    await expect(navigateWebAssistTo(renderer, { tabId: firstId, url: 'javascript:alert(1)' }))
      .resolves.toMatchObject({ ok: false, code: 'invalid_url' });
    expect(electronMock.page.getURL()).toBe('https://www.bing.com/search?q=orkas+browser');

    const second = addWebAssistTab('u1', renderer, { conversationId: 'c-tabs' });
    if (!second.ok) throw new Error('tab setup failed');
    const secondId = second.state.active_tab_id!;
    expect(second.state.tabs).toHaveLength(2);
    expect(activateWebAssistTab(renderer, firstId)).toMatchObject({ ok: true, state: { active_tab_id: firstId } });
    expect(closeWebAssistTab(renderer, firstId)).toMatchObject({ ok: true, closed: true });
    expect(closeWebAssistTab(renderer, secondId)).toMatchObject({ ok: true, closed: true, state: { open: false, tabs: [] } });
  });

  it('enforces the tab limit per task without consuming another task quota', async () => {
    const { renderer } = electronMock;
    const created = Array.from({ length: TAB_LIMIT }, (_, index) => (
      addWebAssistTab('u1', renderer, { conversationId: 'c-limit', label: `Tab ${index + 1}` })
    ));
    expect(created.every(result => result.ok)).toBe(true);
    expect(created.at(-1)).toMatchObject({ ok: true, state: { tabs: expect.any(Array) } });
    if (!created.at(-1)?.ok) throw new Error('tab setup failed');
    expect(created.at(-1)!.state.tabs).toHaveLength(TAB_LIMIT);
    expect(addWebAssistTab('u1', renderer, { conversationId: 'c-limit' }))
      .toMatchObject({ ok: false, code: 'too_many_tabs' });
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
    expect(addWebAssistTab('u1', renderer, { conversationId: 'c-other' }))
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
        : addWebAssistTab('u1', renderer, { conversationId: cid });
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
    const open = () => origin === 'model'
      ? openModelWebAssist('u1', cid, { url: 'https://example.com/new' })
      : origin === 'connector'
        ? openControlledWebAssist('u1', cid, { scope: 'connector_setup', scopeId: 'shop', url: 'https://example.com/new' })
        : addWebAssistTab('u1', renderer, { conversationId: cid });
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

  it('protects handoffs, connector setup, loading pages and authorization popups from capacity cleanup', async () => {
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
      ids.push(String('state' in opened ? (opened.state as any).active_tab_id : opened.active_tab_id));
      pages.push(electronMock.page);
      if (index === 1) expect(retainModelWebAssistTab('u1', cid, ids[index], 'handoff')).toMatchObject({ ok: true });
      if (index === 2) expect(retainModelWebAssistTab('u1', cid, ids[index], 'deliverable')).toMatchObject({ ok: true });
    }
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
    const left = addWebAssistTab('u1', renderer, { conversationId: 'c-left', label: 'Left' });
    if (!left.ok) throw new Error('left tab setup failed');
    const leftId = left.state.active_tab_id!;

    bindWebAssistConversation('u1', 'c-right', renderer);
    const right = addWebAssistTab('u1', renderer, { conversationId: 'c-right', label: 'Right' });
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
    expect(electronMock.renderer.send).not.toHaveBeenCalledWith('web-assist:show', expect.anything());
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
    expect(page.emulation).toMatchObject({
      screenSize: { width: 1280 },
      viewSize: { width: 1280 },
      scale: 408 / 1280,
    });
    // The emulated height fills the drawer rather than leaving dead space.
    expect(page.emulation.screenSize.height).toBe(Math.round(719 / (408 / 1280)));
    layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 408, height: 500 });
    expect(page.emulation.viewSize.height).toBe(Math.round(500 / (408 / 1280)));

    // Showing the tab must not undo it. That inversion was the bug.
    expect((await observeModelWebAssist('u1', cid, tabId)).ok).toBe(true);
    expect(page.emulation).not.toBeNull();
    expect(page.emulation.screenSize.width).toBe(1280);

    // Dragging the drawer wider raises the scale, because the room changed.
    layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 800, height: 719 });
    expect(page.emulation.scale).toBeCloseTo(800 / 1280, 5);

    // Past desktop width there is nothing to emulate; let the real viewport
    // through instead of imposing a narrower one on top of it. Bounds are
    // clamped to the owner window, so the window has to allow it first.
    const previousBounds = electronMock.owner.getContentBounds;
    electronMock.owner.getContentBounds = () => ({ width: 1600, height: 900 });
    try {
      layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 1400, height: 900 });
      expect(page.emulation).toBeNull();
    } finally {
      electronMock.owner.getContentBounds = previousBounds;
    }

    // Re-applying the same width does not churn the native call.
    layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 408, height: 719 });
    const calls = page.emulationCalls;
    layoutWebAssist(electronMock.renderer, { x: 0, y: 0, width: 408, height: 719 });
    expect(page.emulationCalls).toBe(calls);

    // 2026-09-19, found live: a committed navigation drops Chromium's
    // emulation. The cached width made the next call short-circuit, so the page
    // silently went back to the drawer's own width and stayed there.
    page.emulation = null;
    page.emit('did-navigate');
    expect(page.emulation, 'a navigation has to restore the desktop layout').not.toBeNull();
    expect(page.emulation.screenSize.width).toBe(1280);
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

  describe('downloads land in the task, once its origin is allowed', () => {
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
      const opened = await openModelWebAssist('u1', cid, { url: 'https://files.example.com/index' });
      expect(opened.ok).toBe(true);
      page = electronMock.page;
    });

    it('refuses an unknown origin without writing anything, then saves after the user allows it', () => {
      const first = attempt('https://files.example.com/report.csv', 'report.csv');
      expect(first.prevented.value).toBe(true);
      // Refusing must not set a save path: a path plus a later cancel still
      // leaves a partial file on disk.
      expect(first.item.savePath).toBe('');
      expect(webAssistDownloads('u1', cid).downloads).toMatchObject([
        { filename: 'report.csv', state: 'refused', reason: 'needs_origin_grant', origin: 'https://files.example.com' },
      ]);

      const pending = webAssistState(electronMock.renderer).state.tabs[0].download_request;
      expect(pending).toMatchObject({ id: expect.any(String), origin: 'https://files.example.com', filename: 'report.csv' });
      expect(electronMock.renderer.send).toHaveBeenCalledWith('web-assist:state', expect.objectContaining({
        tabs: expect.arrayContaining([expect.objectContaining({ download_request: pending })]),
      }));
      expect(listModelWebAssistTabs('u1', cid).tabs[0]).not.toHaveProperty('download_request');
      // Another task's grant cannot clear this task's pending consent.
      allowWebAssistDownloadOrigin('u1', 'another-task', 'https://files.example.com');
      expect(webAssistState(electronMock.renderer).state.tabs[0].download_request).toEqual(pending);

      expect(allowWebAssistDownloadOrigin('u1', cid, 'https://files.example.com'))
        .toMatchObject({ ok: true, allowed_origins: ['https://files.example.com'] });

      expect(webAssistState(electronMock.renderer).state.tabs[0].download_request).toBeUndefined();
      expect(webAssistState(electronMock.renderer).state.error_code).toBeUndefined();
      expect(webAssistDownloads('u1', cid).downloads).toHaveLength(1);
      const second = attempt('https://files.example.com/report.csv', 'report.csv');
      expect(second.prevented.value).toBe(false);
      expect(second.item.savePath).toBe(path.join(DOWNLOAD_ROOT, 'u1', cid, 'report.csv'));
      expect(fs.existsSync(path.join(DOWNLOAD_ROOT, 'u1', cid))).toBe(true);
      expect(webAssistDownloads('u1', cid).downloads.at(-1)).toMatchObject({ state: 'downloading' });
      expect(listModelWebAssistTabs('u1', cid).downloads.at(-1)).not.toHaveProperty('path');
      second.item.received = 42;
      second.item.handlers.done({}, 'completed');
      expect(listModelWebAssistTabs('u1', cid).downloads.at(-1)).toMatchObject({
        state: 'saved', bytes: 42, path: path.join(DOWNLOAD_ROOT, 'u1', cid, 'report.csv'),
      });
      bindWebAssistConversation('u1', 'other-download-task', electronMock.renderer);
      expect(listModelWebAssistTabs('u1', 'other-download-task').downloads).toEqual([]);
      expect(listModelWebAssistTabs('u2', cid)).toMatchObject({ ok: false });

      // A grant is one origin, not the web.
      const other = attempt('https://elsewhere.example/data.csv', 'data.csv');
      expect(other.prevented.value).toBe(true);
      expect(webAssistDownloads('u1', cid).downloads.at(-1))
        .toMatchObject({ origin: 'https://elsewhere.example', reason: 'needs_origin_grant' });
    });

    it.each([
      ['blob:https://files.example.com/550e8400-e29b-41d4-a716-446655440000', 'https://files.example.com'],
      ['blob:https://export.example.net/550e8400-e29b-41d4-a716-446655440000', 'https://export.example.net'],
      ['data:text/csv;charset=utf-8,name%2Cvalue%0Afixture%2C1', 'https://files.example.com'],
    ])('authorizes a page-generated download %s using its site origin', (url, origin) => {
      const first = attempt(url, 'site-export.csv');
      expect(first.prevented.value).toBe(true);
      expect(first.item.savePath).toBe('');
      expect(webAssistState(electronMock.renderer).state.tabs[0].download_request)
        .toMatchObject({ origin, filename: 'site-export.csv' });
      expect(allowWebAssistDownloadOrigin('u1', cid, origin)).toMatchObject({ ok: true });
      const retry = attempt(url, 'site-export.csv');
      expect(retry.prevented.value).toBe(false);
      expect(retry.item.savePath).toBe(path.join(DOWNLOAD_ROOT, 'u1', cid, 'site-export.csv'));
    });

    it.each(['blob:null/opaque-id', 'blob:file:///tmp/private.csv', 'file:///tmp/private.csv', 'not-a-url'])
    ('does not offer an unusable empty-origin grant or inherit a site grant for %s', (url) => {
      allowWebAssistDownloadOrigin('u1', cid, 'https://files.example.com');
      const blocked = attempt(url, 'site-export.csv');
      expect(blocked.prevented.value).toBe(true);
      expect(blocked.item.savePath).toBe('');
      expect(webAssistState(electronMock.renderer).state.tabs[0].download_request).toBeUndefined();
      expect(webAssistDownloads('u1', cid).downloads.at(-1)).toMatchObject({ state: 'failed' });
    });

    it('gives a retried refusal a fresh prompt while preserving the origin grant boundary', () => {
      attempt('https://files.example.com/report.csv', 'report.csv');
      const first = webAssistState(electronMock.renderer).state.tabs[0].download_request!.id;
      attempt('https://files.example.com/report.csv', 'report.csv');
      expect(webAssistState(electronMock.renderer).state.tabs[0].download_request!.id).not.toBe(first);
      attempt('https://files.example.com/tool.exe', 'tool.exe');
      expect(webAssistState(electronMock.renderer).state.tabs[0].download_request).toBeUndefined();
    });

    it('preserves existing destinations and reserves concurrent same-name transfers', () => {
      allowWebAssistDownloadOrigin('u1', cid, 'https://files.example.com');
      const dir = `${DOWNLOAD_ROOT}/u1/${cid}`;
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 100; i++) fs.writeFileSync(`${dir}/report${i ? ` (${i})` : ''}.csv`, 'original');
      const exhausted = attempt('https://files.example.com/report.csv', 'report.csv');
      expect(exhausted.prevented.value).toBe(true);
      expect(exhausted.item.savePath).toBe('');
      expect(fs.readFileSync(`${dir}/report (99).csv`, 'utf8')).toBe('original');
      const a = attempt('https://files.example.com/new.csv', 'new.csv');
      const b = attempt('https://files.example.com/new.csv', 'new.csv');
      expect(a.prevented.value).toBe(false);
      expect(b.prevented.value).toBe(false);
      expect(a.item.savePath).not.toBe(b.item.savePath);
    });

    it('retains consumed quota when refusals evict the display ledger', () => {
      allowWebAssistDownloadOrigin('u1', cid, 'https://files.example.com');
      const saved = attempt('https://files.example.com/full.csv', 'full.csv', 200 * 1024 * 1024);
      saved.item.received = 200 * 1024 * 1024;
      saved.item.handlers.done({}, 'completed');
      for (let i = 0; i < 201; i++) attempt('https://other.example/refused', 'refused.csv');
      expect(attempt('https://files.example.com/extra.csv', 'extra.csv').prevented.value).toBe(true);
    });

    it.each(['updated', 'done'])('enforces aggregate actual bytes at %s for unknown-length transfers', (event) => {
      allowWebAssistDownloadOrigin('u1', cid, 'https://files.example.com');
      const a = attempt('https://files.example.com/a.csv', 'a.csv', 0);
      const b = attempt('https://files.example.com/b.csv', 'b.csv', 0);
      a.item.received = 120 * 1024 * 1024;
      a.item.handlers.updated();
      b.item.received = 100 * 1024 * 1024;
      if (event === 'updated') {
        b.item.handlers.updated();
        expect(b.item.state).toBe('cancelled');
      }
      b.item.handlers.done({}, 'completed');
      expect(fs.existsSync(b.item.savePath)).toBe(false);
      expect(webAssistDownloads('u1', cid).downloads.at(-1).state).toBe('failed');
      a.item.handlers.done({}, 'completed');
      expect(attempt('https://files.example.com/c.csv', 'c.csv', 80 * 1024 * 1024).prevented.value).toBe(false);
    });

    it('never offers an executable, even from an allowed origin', () => {
      allowWebAssistDownloadOrigin('u1', cid, 'https://files.example.com');
      for (const name of ['setup.exe', 'run.sh', 'tool.dmg', 'payload.js']) {
        const tried = attempt(`https://files.example.com/${name}`, name);
        expect(tried.prevented.value, name).toBe(true);
        expect(tried.item.savePath, name).toBe('');
        expect(webAssistDownloads('u1', cid).downloads.at(-1), name)
          .toMatchObject({ filename: name, reason: 'blocked_type' });
      }
      // An archive is ordinary data; nothing here runs it.
      const archive = attempt('https://files.example.com/export.zip', 'export.zip');
      expect(archive.prevented.value).toBe(false);
    });

    it('stops at the task byte budget and keeps names inside the task folder', () => {
      allowWebAssistDownloadOrigin('u1', cid, 'https://files.example.com');
      const huge = attempt('https://files.example.com/big.bin', 'big.bin', 400 * 1024 * 1024);
      expect(huge.prevented.value).toBe(true);
      expect(webAssistDownloads('u1', cid).downloads.at(-1)).toMatchObject({ reason: 'task_budget' });

      // A traversing name cannot climb out of the task's own directory.
      const sneaky = attempt('https://files.example.com/x', '../../escape.csv');
      expect(sneaky.prevented.value).toBe(false);
      expect(sneaky.item.savePath).toBe(path.join(DOWNLOAD_ROOT, 'u1', cid, 'escape.csv'));
    });

    it('notifies task activity after grants and every download state mutation', () => {
      const seen: Array<{ states: string[]; grants: string[] }> = [];
      const deliveries: unknown[] = [];
      electronMock.renderer.send.mockImplementation((channel: string, payload: any) => {
        if (channel !== 'web-assist:activity') return;
        deliveries.push(payload);
        const ledger = webAssistDownloads('u1', cid);
        seen.push({ states: ledger.downloads.map(entry => entry.state), grants: ledger.allowed_origins });
      });
      try {
        attempt('https://files.example.com/report.csv', 'report.csv');
        allowWebAssistDownloadOrigin('u2', cid, 'https://files.example.com');
        allowWebAssistDownloadOrigin('u1', 'unrelated-task', 'https://files.example.com');
        expect(seen).toEqual([{ states: ['refused'], grants: [] }]);
        allowWebAssistDownloadOrigin('u1', cid, 'https://files.example.com');
        const saved = attempt('https://files.example.com/report.csv', 'report.csv');
        saved.item.handlers.done({}, 'completed');
        const failed = attempt('https://files.example.com/failed.csv', 'failed.csv');
        failed.item.handlers.done({}, 'cancelled');
        expect(seen.map(entry => entry.states)).toEqual([
          ['refused'], ['refused'], ['refused', 'downloading'], ['refused', 'saved'],
          ['refused', 'saved', 'downloading'], ['refused', 'saved', 'failed'],
        ]);
        expect(seen.slice(1).every(entry => entry.grants[0] === 'https://files.example.com')).toBe(true);
        expect(deliveries).toEqual(Array.from({ length: 6 }, () => ({ conversation_id: cid })));
      } finally {
        electronMock.renderer.send.mockReset();
      }
    });

    it('cleans up the partial file when a download does not complete', () => {
      allowWebAssistDownloadOrigin('u1', cid, 'https://files.example.com');
      const tried = attempt('https://files.example.com/half.csv', 'half.csv');
      expect(tried.prevented.value).toBe(false);
      fs.mkdirSync(path.join(DOWNLOAD_ROOT, 'u1', cid), { recursive: true });
      fs.writeFileSync(tried.item.savePath, 'partial');
      tried.item.received = 7;
      tried.item.handlers.done({}, 'cancelled');
      expect(fs.existsSync(tried.item.savePath)).toBe(false);
      expect(webAssistDownloads('u1', cid).downloads.at(-1)).toMatchObject({ state: 'failed' });
      expect(listModelWebAssistTabs('u1', cid).downloads.at(-1)).not.toHaveProperty('path');
    });

    it('keeps simultaneous exports with the same name separate before either file exists', () => {
      allowWebAssistDownloadOrigin('u1', cid, 'https://files.example.com');
      const first = attempt('https://files.example.com/report.csv', 'report.csv');
      const second = attempt('https://files.example.com/report.csv', 'report.csv');
      expect(first.item.savePath).toBe(path.join(DOWNLOAD_ROOT, 'u1', cid, 'report.csv'));
      expect(second.item.savePath).toBe(path.join(DOWNLOAD_ROOT, 'u1', cid, 'report (1).csv'));
      expect(listModelWebAssistTabs('u1', cid).downloads.every((entry: any) => entry.state === 'downloading' && !entry.path)).toBe(true);
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
