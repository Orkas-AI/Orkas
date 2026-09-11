import * as vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportWebAssistFailure } from '../../../src/main/features/web_assist_diagnostics';

vi.mock('../../../src/main/features/web_assist_diagnostics', () => ({ reportWebAssistFailure: vi.fn() }));

const electronMock = vi.hoisted(() => ({
  renderer: null as any,
  owner: null as any,
  page: null as any,
  createPage: null as null | (() => any),
  createWindow: null as null | (() => { renderer: any; owner: any }),
  beforeRequest: null as any,
}));

vi.mock('../../../src/main/paths', () => ({
  userWebAssistProfileDir: (uid: string) => `/tmp/orkas-web-assist-control-test/${uid}`,
}));

vi.mock('../../../src/main/features/user-switch-hooks', () => ({
  registerUserSwitchHook: vi.fn(),
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
    setUserAgent(): void {}
    enableDeviceEmulation(): void {}
    disableDeviceEmulation(): void {}
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
      if (script.includes('const MAX_ELEMENTS = 80')) {
        return {
          ok: true,
          title: this.title,
          text: 'Create an app',
          text_truncated: false,
          element_count: 1,
          elements_truncated: false,
          elements: [{
            path: [0, 1],
            signature: { tag: 'input', type: 'text', role: '', label: 'Application name' },
            tag: 'input',
            role: '',
            label: 'Application name',
            input_type: 'text',
            placeholder: 'Name',
            href: '',
            disabled: false,
            checked: null,
            sensitive: false,
            fillable: true,
            requires_user_action: false,
            options: [],
            value: 'must-not-escape',
          }],
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
    constructor(options?: { webContents?: FakePage }) {
      this.webContents = options?.webContents || new FakePage();
      electronMock.page = this.webContents;
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
    renderer.getURL = () => 'file:///orkas/index.html';
    renderer.isDestroyed = () => false;
    const owner = new FakeEmitter() as FakeEmitter & Record<string, any>;
    owner.id = 42;
    owner.webContents = renderer;
    owner.isDestroyed = () => false;
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
    on: vi.fn(),
  };

  return {
    app: { userAgentFallback: 'Chrome/120 Electron/30 Orkas/1.7', getName: () => 'Orkas' },
    BrowserWindow: {
      fromWebContents: (sender: unknown) => (
        sender === electronMock.renderer ? electronMock.owner : null
      ),
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
  navigateWebAssistTo,
  setActiveWebAssistConversation,
  waitForModelWebAssist,
  waitForControlledWebAssist,
  reclaimIdleWebAssistPages,
  webAssistIdleSafetyScript,
  webAssistState,
  openWebAssistInDefaultBrowser,
} from '../../../src/main/features/web_assist';
import {
  beginBrowserTaskRun, finishBrowserTaskRun,
} from '../../../src/main/features/web_assist_lifecycle';

describe('Web Assist controlled connector lifecycle', () => {
  beforeEach(() => {
    electronMock.createWindow?.();
    vi.mocked(reportWebAssistFailure).mockClear();
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

    it('retains a real main-page failure on stop, ignores subframe errors, and clears it only on successful recovery', async () => {
      await openWebAssist('u1', electronMock.renderer, { conversationId: 'c-nav', url: 'https://example.com/ready' });
      const page = electronMock.page;
      page.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://frame.invalid/', false);
      page.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/old', true);
      expect(webAssistState(electronMock.renderer).state.error_code).toBeUndefined();
      expect(reportWebAssistFailure).not.toHaveBeenCalled();
      page.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://missing.invalid/', true);
      page.emit('did-stop-loading');
      expect(webAssistState(electronMock.renderer).state).toMatchObject({ loading: false, error_code: 'page_load_failed' });
      expect(reportWebAssistFailure).toHaveBeenCalledExactlyOnceWith(electronMock.renderer, 'page_load_failed', -105);
      page.emit('did-finish-load');
      expect(webAssistState(electronMock.renderer).state.error_code).toBe('page_load_failed');
      page.emit('did-navigate', {}, 'https://example.com/recovered', 200, 'OK');
      expect(webAssistState(electronMock.renderer).state.error_code).toBeUndefined();
      page.emit('unresponsive');
      page.emit('did-navigate', {}, 'https://example.com/recovered', 200, 'OK');
      expect(webAssistState(electronMock.renderer).state.error_code).toBe('page_unresponsive');
      expect(reportWebAssistFailure).toHaveBeenLastCalledWith(electronMock.renderer, 'page_unresponsive');
      page.emit('render-process-gone', {}, { reason: 'clean-exit' });
      expect(reportWebAssistFailure).toHaveBeenCalledTimes(2);
      page.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      expect(reportWebAssistFailure).toHaveBeenLastCalledWith(electronMock.renderer, 'renderer_gone');
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
          tab_limit: 10, tabs: [{ tab_id: tabId, suspended: true, display_url: 'https://example.com/work' }],
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
        expect(listed.tab_limit).toBe(10);
        expect(listed.tabs).toHaveLength(10);
        expect((listed.tabs as any[]).every(tab => tab.suspended)).toBe(true);
      }
      const aTab = webAssistState(electronMock.renderer).state.tabs.find(tab => tab.conversation_id === 'c-a')!;
      expect(await observeModelWebAssist('u1', 'c-b', aTab.tab_id)).toMatchObject({ ok: false, code: 'unknown_tab' });
      expect(electronMock.owner.contentView.addChildView).toHaveBeenCalledTimes(before);
    });
  });

  it('allows one safe child authorization window and rejects unsafe or nested popup navigation', async () => {
    const { renderer, owner } = electronMock;
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
    for (let i = 2; i < 10; i++) addWebAssistTab('u1', renderer, { conversationId: 'c-link-limit' });
    expect(parent.windowOpenHandler({ url: 'https://example.com/extra', disposition: 'foreground-tab' })).toEqual({ action: 'deny' });
    expect((listModelWebAssistTabs('u1', 'c-link-limit') as any).tabs).toHaveLength(10);
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
    await expect(observeModelWebAssist('u1', 'c-browser', tabId))
      .resolves.toMatchObject({ ok: false, code: 'task_not_visible' });
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

  it('keeps connector submission authority separate when the general browser takes over the same page', async () => {
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
    expect(browser).toMatchObject({ ok: true, elements: [{ requires_user_action: true }, {}] });
    await expect(actOnModelWebAssist('u1', cid, {
      tabId: opened.state.active_tab_id, pageId: browser.page_id, elementRef: 'e1', action: 'click',
    })).resolves.toMatchObject({ ok: false, code: 'user_action_required', reason: 'form_submission_or_authorization' });
    expect(submit.clicks).toBe(1);
    await expect(actOnControlledWebAssist('u1', cid, 'shop', {
      pageId: browser.page_id, elementRef: 'e1', action: 'click',
    })).resolves.toMatchObject({ ok: false, code: 'scope_mismatch' });
    expect(submit.clicks).toBe(1);
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
    const created = Array.from({ length: 10 }, (_, index) => (
      addWebAssistTab('u1', renderer, { conversationId: 'c-limit', label: `Tab ${index + 1}` })
    ));
    expect(created.every(result => result.ok)).toBe(true);
    expect(created.at(-1)).toMatchObject({ ok: true, state: { tabs: expect.any(Array) } });
    if (!created.at(-1)?.ok) throw new Error('tab setup failed');
    expect(created.at(-1)!.state.tabs).toHaveLength(10);
    expect(addWebAssistTab('u1', renderer, { conversationId: 'c-limit' }))
      .toMatchObject({ ok: false, code: 'too_many_tabs' });
    await expect(openWebAssist('u1', renderer, {
      conversationId: 'c-limit',
      url: 'https://example.com/eleventh',
    })).resolves.toMatchObject({ ok: false, code: 'too_many_tabs' });
    bindWebAssistConversation('u1', 'c-limit', renderer);
    expect(await openModelWebAssist('u1', 'c-limit', { url: 'https://example.com/model' }))
      .toMatchObject({ ok: false, code: 'too_many_tabs', tab_limit: 10, error: expect.stringContaining('Reuse an existing tab') });
    const firstId = created[0].ok ? created[0].state.active_tab_id! : '';
    expect(await navigateModelWebAssist('u1', 'c-limit', { tabId: firstId, action: 'goto', url: 'https://example.com/reused' }))
      .toMatchObject({ ok: true, tab: { tab_id: firstId } });
    expect(listModelWebAssistTabs('u1', 'c-limit').tabs).toHaveLength(10);
    closeWebAssistTab(renderer, firstId);
    expect(await openModelWebAssist('u1', 'c-limit', { url: 'https://example.com/recovery' })).toMatchObject({ ok: true, closed_tab_ids: [] });
    expect(addWebAssistTab('u1', renderer, { conversationId: 'c-other' }))
      .toMatchObject({ ok: true, state: { conversation_id: 'c-other' } });
  });

  it.each(['model', 'user', 'connector'] as const)('evicts the oldest inactive model tab when %s opens an eleventh tab', async (origin) => {
    const { renderer, owner } = electronMock;
    const cid = `c-evict-${origin}`;
    // Another task's older page is never a capacity victim.
    bindWebAssistConversation('u1', 'c-other-limit', renderer);
    await openModelWebAssist('u1', 'c-other-limit', { url: 'https://example.com/other' });
    const otherPage = electronMock.page;
    bindWebAssistConversation('u1', cid, renderer);
    const ids: string[] = [];
    const pages: any[] = [];
    for (let index = 0; index < 10; index++) {
      const opened = await openModelWebAssist('u1', cid, { url: `https://example.com/${index}` });
      expect(opened.ok).toBe(true);
      ids.push(String(opened.active_tab_id));
      pages.push(electronMock.page);
    }
    expect(listModelWebAssistTabs('u1', cid)).toMatchObject({ tab_limit: 10, tabs: expect.any(Array) });
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
    if (origin === 'model') expect(opened).toMatchObject({ tab_limit: 10, closed_tab_ids: [ids[1]] });
    expect(pages.map(page => page.isDestroyed())).toEqual([false, true, false, false, false, false, false, false, false, false]);
    const remaining = listModelWebAssistTabs('u1', cid).tabs as Array<{ tab_id: string }>;
    expect(remaining).toHaveLength(10);
    expect(remaining.map(tab => tab.tab_id)).not.toContain(ids[1]);
    expect(otherPage.isDestroyed()).toBe(false);
    expect(await observeModelWebAssist('u1', cid, ids[1])).toMatchObject({ ok: false, code: 'unknown_tab' });
    // State pushes must never flash an eleventh tab in this task's strip.
    for (const [channel, state] of renderer.send.mock.calls) {
      if (channel === 'web-assist:state' || channel === 'web-assist:show') {
        expect(state.tabs.filter((tab: any) => tab.conversation_id === cid).length).toBeLessThanOrEqual(10);
      }
    }
  });

  it('protects handoffs, connector setup, loading pages and authorization popups from capacity cleanup', async () => {
    const { renderer } = electronMock;
    const cid = 'c-protected-limit';
    bindWebAssistConversation('u1', cid, renderer);
    beginBrowserTaskRun('u1', cid, 'protection-run');
    const ids: string[] = [];
    const pages: any[] = [];
    for (let index = 0; index < 10; index++) {
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
    await expect(observeModelWebAssist('u1', 'c-left', rightId))
      .resolves.toMatchObject({ ok: false, code: 'unknown_tab' });
    await expect(observeModelWebAssist('u1', 'c-right', rightId))
      .resolves.toMatchObject({ ok: false, code: 'task_not_visible' });

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
