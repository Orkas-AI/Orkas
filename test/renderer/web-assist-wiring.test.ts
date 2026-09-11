import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');
const webAssistSource = fs.readFileSync(path.join(rendererRoot, 'modules/web-assist.js'), 'utf8');
const connectorsSource = fs.readFileSync(path.join(rendererRoot, 'modules/connectors.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
const styleSource = fs.readFileSync(path.join(rendererRoot, 'style.css'), 'utf8');
const preloadSource = fs.readFileSync(path.resolve(__dirname, '../../src/main/preload.js'), 'utf8');

describe('Web Assist renderer wiring', () => {
  it('creates default tabs only in visible empty task browsers, deduplicates requests, and permits failure recovery', async () => {
    const start = webAssistSource.indexOf('  function ensureDefaultTab() {');
    const end = webAssistSource.indexOf('  async function addTab()', start);
    let resolve: (value: unknown) => void = () => {};
    const invoke = vi.fn(() => new Promise(done => { resolve = done; }));
    const renderState = vi.fn();
    const warn = vi.fn();
    const uiToast = vi.fn();
    const context = vm.createContext({
      activeCid: 'c1', activeView: 'conversation', panelOpen: false, panelTab: 'browser',
      defaultTabRequests: new Map(), tabsForConversation: () => [], renderState,
      window: { orkas: { invoke } }, log: { warn }, uiToast, label: (_key: string, fallback: string) => fallback,
    });
    vm.runInContext(webAssistSource.slice(start, end), context);
    await context.ensureDefaultTab();
    context.panelOpen = true;
    context.panelTab = 'files';
    await context.ensureDefaultTab();
    expect(invoke).not.toHaveBeenCalled();
    context.panelTab = 'browser';
    const first = context.ensureDefaultTab();
    expect(context.ensureDefaultTab()).toBe(first);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('webAssist.addTab', { conversationId: 'c1', ifEmpty: true });
    context.activeCid = 'c2';
    resolve({ ok: true, state: { tabs: [{ conversation_id: 'c1' }] } });
    await expect(first).resolves.toBe(true);
    expect(renderState).not.toHaveBeenCalled();
    const failed = context.ensureDefaultTab();
    resolve({ ok: false });
    await expect(failed).resolves.toBe(false);
    expect(uiToast).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith('default tab creation failed');
    const retry = context.ensureDefaultTab();
    const state = { tabs: [{ conversation_id: 'c2', tab_id: 'tab-2' }] };
    resolve({ ok: true, state });
    await expect(retry).resolves.toBe(true);
    expect(renderState).toHaveBeenCalledExactlyOnceWith(state);
    context.tabsForConversation = () => state.tabs;
    await context.ensureDefaultTab();
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('shows the full current address and preserves an editing draft only in its own tab', () => {
    const start = webAssistSource.indexOf('  function renderState(state) {');
    const end = webAssistSource.indexOf('  function ensureShell()', start);
    const first = { tab_id: 'first', display_url: 'https://example.com/work', address_url: 'https://example.com/work?x=one&x=two#section' };
    const input = { value: '' };
    const context = vm.createContext({
      currentState: {}, shell: { classList: { toggle() {} } },
      renderTabs() {}, refreshBrowserCount() {}, selectedTab: () => first,
      renderedTabId: '', addressDirty: false, addressInput: input,
      emptyEl: {}, host: {}, backBtn: {}, forwardBtn: {}, reloadBtn: {}, externalBtn: {}, statusEl: {},
      stateErrorText: () => '', assistantStatusText: () => '',
      ensureMainActiveTab() {}, syncVisibility() {},
    });
    vm.runInContext(webAssistSource.slice(start, end), context);
    context.renderState({});
    expect(input.value).toBe(first.address_url);
    first.address_url = 'https://example.com/redirected?keep=1#new';
    context.renderState({});
    expect(input.value).toBe(first.address_url);
    input.value = 'https://example.com/edit?draft=1';
    context.addressDirty = true;
    context.renderState({});
    expect(input.value).toBe('https://example.com/edit?draft=1');
    first.tab_id = 'second';
    first.address_url = 'https://example.com/other?tab=2#other';
    context.renderState({});
    expect(input.value).toBe(first.address_url);
    expect(context.addressDirty).toBe(false);
  });
  it('wakes an inactive selection only when the user actually shows the task browser', async () => {
    const start = webAssistSource.indexOf('  function ensureMainActiveTab(retry = false) {');
    const end = webAssistSource.indexOf('  function modalIsOpen()', start);
    const invoke = vi.fn(async () => ({ ok: true }));
    const context = vm.createContext({
      selectedTab: () => ({ tab_id: 'same-tab', suspended: true }),
      currentState: { active_tab_id: 'same-tab' }, activationInFlight: '',
      panelOpen: false, panelTab: 'browser', activeView: 'conversation',
      panelResizing: false, modalIsOpen: () => false,
      window: { orkas: { invoke } }, renderState() {}, syncVisibility() {}, log: { warn() {} },
    });
    vm.runInContext(webAssistSource.slice(start, end), context);
    context.ensureMainActiveTab();
    context.panelOpen = true;
    context.panelTab = 'attachments';
    context.ensureMainActiveTab();
    expect(invoke).not.toHaveBeenCalled();
    context.panelTab = 'browser';
    context.modalIsOpen = () => true;
    context.ensureMainActiveTab();
    expect(invoke).not.toHaveBeenCalled();
    context.modalIsOpen = () => false;
    context.selectedTab = () => ({ tab_id: 'same-tab', suspended: true, error_code: 'page_load_failed' });
    context.ensureMainActiveTab();
    expect(invoke).not.toHaveBeenCalled();
    context.ensureMainActiveTab(true);
    context.ensureMainActiveTab();
    context.ensureMainActiveTab();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('webAssist.activateTab', { tabId: 'same-tab' });
    await Promise.resolve();
  });

  it('reveals the browser once per task turn while retaining manual close/tab choices and task isolation', () => {
    const start = webAssistSource.indexOf('  function showFromMain(state) {');
    const end = webAssistSource.indexOf('  function setContext(', start);
    const openAndSetTab = vi.fn();
    const renderState = vi.fn();
    const context = vm.createContext({
      ensureShell() {}, rememberMainActiveTab() {}, renderState,
      activeView: 'conversation', activeCid: 'c1', currentState: null,
      revealedTasks: new Set(), window: { ConversationInfo: { openAndSetTab } },
    });
    vm.runInContext(webAssistSource.slice(start, end), context);
    const state = { conversation_id: 'c1', active_tab_id: 'tab-1', assistant_action: 'observing' };
    context.showFromMain(state);
    expect(openAndSetTab).toHaveBeenCalledExactlyOnceWith('browser');
    // Closing details or selecting Attachments must survive all subsequent
    // browser operations, including operations that create another page.
    openAndSetTab.mockClear();
    for (const assistant_action of ['acting', 'waiting', 'observing']) {
      context.showFromMain({ ...state, active_tab_id: 'tab-2', assistant_action });
    }
    expect(openAndSetTab).not.toHaveBeenCalled();
    expect(renderState).toHaveBeenCalledTimes(4);
    context.showFromMain({ ...state, conversation_id: 'background-task' });
    expect(openAndSetTab).not.toHaveBeenCalled();
    context.beginTaskTurn('background-task');
    context.showFromMain(state);
    expect(openAndSetTab).not.toHaveBeenCalled();
    context.beginTaskTurn('c1');
    context.showFromMain(state);
    expect(openAndSetTab).toHaveBeenCalledExactlyOnceWith('browser');
    openAndSetTab.mockClear();
    context.beginTaskTurn('c1');
    context.activeView = 'connectors';
    context.showFromMain(state);
    expect(openAndSetTab).not.toHaveBeenCalled();
    context.activeView = 'conversation';
    context.showFromMain(state);
    expect(openAndSetTab).toHaveBeenCalledExactlyOnceWith('browser');
  });

  it('reveals model activity from connector state events but not ordinary page updates', () => {
    const handlers = new Map<string, (state: unknown) => void>();
    const showFromMain = vi.fn();
    const renderState = vi.fn();
    const error = vi.fn();
    const start = webAssistSource.indexOf("  window.orkas.onPushEvent('web-assist:state'");
    const end = webAssistSource.indexOf('  window.WebAssist =', start);
    vm.runInNewContext(webAssistSource.slice(start, end), {
      window: { Monitor: { error }, orkas: { onPushEvent: (name: string, handler: (state: unknown) => void) => handlers.set(name, handler) } },
      showFromMain, renderState, rememberMainActiveTab() {},
    });
    const state = { conversation_id: 'c1', loading: true };
    handlers.get('web-assist:state')!(state);
    expect(showFromMain).not.toHaveBeenCalled();
    expect(renderState).toHaveBeenCalledWith(state);
    const activity = { ...state, assistant_action: 'waiting' };
    handlers.get('web-assist:state')!(activity);
    expect(showFromMain).toHaveBeenCalledWith(activity);
    handlers.get('web-assist:show')!(state);
    expect(showFromMain).toHaveBeenCalledTimes(2);
    const failure = { error_code: 'renderer_gone', suppressed_count: 2 };
    handlers.get('web-assist:failure')!(failure);
    expect(error).toHaveBeenCalledExactlyOnceWith('browser', failure);
    expect(showFromMain).toHaveBeenCalledTimes(2);
    error.mockImplementationOnce(() => { throw new Error('fixture monitor unavailable'); });
    expect(() => handlers.get('web-assist:failure')!(failure)).not.toThrow();
  });

  it('settles visibility mutations so the renderer can finish booting and accept input', () => {
    const start = webAssistSource.indexOf('  function syncVisibility() {');
    const end = webAssistSource.indexOf('  function scheduleLayout()', start);
    const pending: Array<() => void> = [];
    let hidden = false;
    const shell = {
      get hidden() { return hidden; },
      set hidden(value) { hidden = value; pending.push(() => context.syncVisibility()); },
    };
    const context = vm.createContext({
      shell, selectedTab: () => null, panelOpen: false, panelTab: 'files',
      activeView: 'new-chat', activeCid: '', nativeVisible: false, nativeTabId: '', currentState: null,
    });
    vm.runInContext(webAssistSource.slice(start, end), context);
    context.syncVisibility();
    // Browsers enqueue an attribute mutation even when a setter repeats its
    // current value. A bounded drain detects starvation without hanging CI.
    for (let i = 0; i < 10 && pending.length; i++) pending.shift()!();
    expect(shell.hidden).toBe(true);
    expect(pending).toHaveLength(0);
  });

  it('lays out a newly selected native tab even when the previous tab was visible', () => {
    const start = webAssistSource.indexOf('  function syncVisibility() {');
    const end = webAssistSource.indexOf('  function scheduleLayout()', start);
    let layoutCalls = 0;
    const context = vm.createContext({
      shell: { hidden: false },
      selectedTab: () => ({ tab_id: 'new-tab', display_url: 'https://example.com/new' }),
      panelOpen: true,
      panelTab: 'browser',
      activeView: 'conversation',
      activeCid: 'c1',
      panelResizing: false,
      nativeVisible: true,
      nativeTabId: 'old-tab',
      currentState: { open: true, active_tab_id: 'new-tab' },
      modalIsOpen: () => false,
      scheduleLayout: () => { layoutCalls += 1; },
      window: { orkas: { invoke: () => Promise.resolve({ ok: true }) } },
      log: { warn() {} },
    });
    vm.runInContext(webAssistSource.slice(start, end), context);
    context.syncVisibility();
    expect(context.nativeVisible).toBe(true);
    expect(context.nativeTabId).toBe('new-tab');
    expect(layoutCalls).toBe(1);
  });

  it('hides native content only for overlays that actually overlap its viewport', () => {
    const start = webAssistSource.indexOf('  function modalIsOpen() {');
    const end = webAssistSource.indexOf('  function syncVisibility()', start);
    const rect = { left: 600, top: 100, right: 1000, bottom: 700, width: 400, height: 600 };
    let matches = [{ hidden: false, getClientRects: () => [rect] }];
    const querySelectorAll = vi.fn(() => matches);
    const context = vm.createContext({ document: { querySelectorAll }, host: { getBoundingClientRect: () => rect } });
    vm.runInContext(webAssistSource.slice(start, end), context);

    expect(context.modalIsOpen()).toBe(true);
    expect(querySelectorAll).toHaveBeenCalledWith(expect.stringContaining('.panel.resource-detail-overlay'));

    matches = [{ hidden: true, getClientRects: () => [rect] }];
    expect(context.modalIsOpen()).toBe(false);
    matches = [{ hidden: false, getClientRects: () => [] }];
    expect(context.modalIsOpen()).toBe(false);
    matches = [{ hidden: false, getClientRects: () => [{ ...rect, left: 0, right: 600, width: 600 }] }];
    expect(context.modalIsOpen()).toBe(false);
    matches = [{ hidden: false, getClientRects: () => [{ ...rect, bottom: 100, top: 0, height: 100 }] }];
    expect(context.modalIsOpen()).toBe(false);
    matches = [{ hidden: false, getClientRects: () => [{ ...rect, left: 599, right: 601, width: 2 }] }];
    expect(context.modalIsOpen()).toBe(true);
  });

  it('keeps the page visible and schedules its new bounds throughout a resize', () => {
    const start = webAssistSource.indexOf('  function syncVisibility() {');
    const end = webAssistSource.indexOf('  function scheduleLayout()', start);
    const resizeStart = webAssistSource.indexOf('  function setResizing(');
    const resizeEnd = webAssistSource.indexOf('  function isOpen()', resizeStart);
    const invoke = vi.fn(async () => ({ ok: true }));
    const scheduleLayout = vi.fn();
    const context = vm.createContext({
      shell: { hidden: false }, selectedTab: () => ({ tab_id: 'tab', display_url: 'https://example.com' }),
      panelOpen: true, panelTab: 'browser', activeView: 'conversation', activeCid: 'c1',
      nativeVisible: true, nativeTabId: 'tab', currentState: { open: true, active_tab_id: 'tab' },
      modalIsOpen: () => false, scheduleLayout, window: { orkas: { invoke } },
    });
    vm.runInContext(webAssistSource.slice(start, end) + webAssistSource.slice(resizeStart, resizeEnd), context);
    context.setResizing(true);
    expect(context.nativeVisible).toBe(true);
    expect(scheduleLayout).toHaveBeenCalledOnce();
    context.setResizing(false);
    expect(context.nativeVisible).toBe(true);
    expect(scheduleLayout).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    { reason: 'closed details', open: false, tab: 'browser', modal: false, resizing: false },
    { reason: 'Files selected', open: true, tab: 'files', modal: false, resizing: false },
    { reason: 'Attachments selected', open: true, tab: 'attachments', modal: false, resizing: false },
    { reason: 'protected dialog open', open: true, tab: 'browser', modal: true, resizing: false },
  ])('hides native content for $reason and restores it without closing the browser session', async (scenario) => {
    const start = webAssistSource.indexOf('  function syncVisibility() {');
    const end = webAssistSource.indexOf('  function scheduleLayout()', start);
    const invoke = vi.fn(async () => ({ ok: true }));
    const scheduleLayout = vi.fn();
    const context = vm.createContext({
      shell: { hidden: false },
      selectedTab: () => ({ tab_id: 'tab-1', display_url: 'https://example.com/setup' }),
      panelOpen: scenario.open, panelTab: scenario.tab, panelResizing: scenario.resizing,
      activeView: 'conversation', activeCid: 'c1', nativeVisible: true, nativeTabId: 'tab-1',
      currentState: { open: true, active_tab_id: 'tab-1' },
      modalIsOpen: () => scenario.modal, scheduleLayout,
      window: { orkas: { invoke } }, log: { warn() {} },
    });
    vm.runInContext(webAssistSource.slice(start, end), context);
    context.syncVisibility();
    context.syncVisibility(); // Repeated page/status events must settle.
    expect(invoke).toHaveBeenCalledExactlyOnceWith('webAssist.layout', { visible: false });
    expect(context.nativeVisible).toBe(false);
    expect(scheduleLayout).not.toHaveBeenCalled();
    expect(context.currentState.open).toBe(true);
    context.panelOpen = true;
    context.panelTab = 'browser';
    context.panelResizing = false;
    context.modalIsOpen = () => false;
    context.syncVisibility();
    expect(context.shell.hidden).toBe(false);
    expect(context.nativeVisible).toBe(true);
    expect(context.nativeTabId).toBe('tab-1');
    expect(scheduleLayout).toHaveBeenCalledOnce();
    // Hiding is layout-only: no close, navigation, or loss of browser state.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('loads trusted browser chrome after icons and before connector callers', () => {
    const iconsIndex = indexSource.indexOf('./modules/icons.js');
    const webAssistIndex = indexSource.indexOf('./modules/web-assist.js');
    const connectorsIndex = indexSource.indexOf('./modules/connectors.js');
    expect(iconsIndex).toBeGreaterThan(-1);
    expect(webAssistIndex).toBeGreaterThan(iconsIndex);
    expect(connectorsIndex).toBeGreaterThan(webAssistIndex);
    expect(styleSource).toContain('.web-assist-native-host');
    expect(indexSource).toContain('data-info-tab="browser"');
    expect(indexSource).toContain('id="conversation-info-resize"');
  });

  it('keeps the current URL in main when opening the system browser', () => {
    expect(webAssistSource).toContain("invoke('webAssist.openExternal', {})");
    expect(webAssistSource).not.toMatch(/webAssist\.openExternal'\s*,\s*\{\s*url/);
    expect(preloadSource).toContain("'web-assist:'");
  });

  it('wires task browser chrome while keeping user guide clicks external', () => {
    const userClickStart = connectorsSource.indexOf("guideBtn.addEventListener('click'");
    const userClickEnd = connectorsSource.indexOf("document.addEventListener('keydown'", userClickStart);
    const userClickBlock = connectorsSource.slice(userClickStart, userClickEnd);
    expect(webAssistSource).toContain('setPanelState,');
    expect(webAssistSource).toContain('setResizing,');
    expect(webAssistSource).toContain("invoke('webAssist.addTab'");
    expect(webAssistSource).toContain("invoke('webAssist.navigateTo'");
    expect(webAssistSource).toContain("invoke('webAssist.closeTab'");
    expect(webAssistSource).toContain("invoke('webAssist.setContext'");
    expect(webAssistSource).toContain('inputmode="search"');
    expect(userClickBlock).toContain("window.orkas.invoke('auth.openExternal', { url })");
    expect(userClickBlock).not.toContain('WebAssist');
    expect(webAssistSource).toContain("onPushEvent('web-assist:show'");
    expect(webAssistSource).toContain('function showFromMain(state)');
    expect(webAssistSource).toContain('assistantStatusText(tab)');
  });

  it('reuses Commander app navigation to begin unconfigured connector guidance', () => {
    const conversationSource = fs.readFileSync(path.join(rendererRoot, 'modules/conversation.js'), 'utf8');
    expect(connectorsSource).toContain('window.openConnectorSetupById = async function');
    expect(conversationSource).toContain('window.openConnectorSetupById(req.target_id)');
  });

  it('ships every visible Web Assist label in all renderer locales', () => {
    for (const language of ['en', 'zh', 'ja', 'pt']) {
      const table = JSON.parse(fs.readFileSync(path.join(rendererRoot, `locales/${language}.json`), 'utf8'));
      for (const key of [
        'web_assist.title',
        'web_assist.new_tab',
        'web_assist.add_tab',
        'web_assist.close_tab',
        'web_assist.address_placeholder',
        'web_assist.empty_title',
        'web_assist.empty_hint',
        'web_assist.add_tab_failed',
        'web_assist.invalid_url',
        'web_assist.resize',
        'conversation_info.resize',
        'conversation_info.tab_browser',
        'web_assist.back',
        'web_assist.forward',
        'web_assist.reload',
        'web_assist.open_external',
        'web_assist.close',
        'web_assist.loading',
        'web_assist.assistant_ready',
        'web_assist.assistant_observing',
        'web_assist.assistant_acting',
        'web_assist.assistant_waiting',
        'web_assist.page_load_failed',
        'web_assist.page_unresponsive',
        'web_assist.download_blocked',
        'web_assist.open_failed',
        'web_assist.open_external_failed',
        'web_assist.close_failed',
      ]) {
        expect(table[key], `${language}:${key}`).toBeTruthy();
      }
    }
  });
});
