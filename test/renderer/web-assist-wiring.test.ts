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
  it.each(['another task', 'settings', 'leave and return'])('ignores a late browser reveal after navigating to %s', async destination => {
    let resolve: (value: unknown) => void = () => {};
    const invoke = vi.fn(() => new Promise(done => { resolve = done; }));
    const openAndSetTab = vi.fn(() => true);
    const renderState = vi.fn();
    const context = vm.createContext({
      activeView: 'conversation', activeCid: 'a', contextEpoch: 0,
      activeTabByCid: new Map(), revealedTasks: new Set(),
      ensureShell() {}, renderState, log: { warn: vi.fn() },
      window: { orkas: { invoke }, ConversationInfo: { openAndSetTab } },
    });
    vm.runInContext(webAssistSource.slice(webAssistSource.indexOf('  async function openForModel('),
      webAssistSource.indexOf('  function revealCurrentTask(')), context);
    const pending = context.openForModel({ url: 'https://example.com/' });
    expect(invoke).toHaveBeenCalledWith('webAssist.open', expect.objectContaining({ conversationId: 'a' }));
    context.activeCid = destination === 'another task' ? 'b' : 'a';
    context.activeView = destination === 'settings' ? 'settings' : 'conversation';
    context.contextEpoch++;
    resolve({ ok: true, state: { conversation_id: 'a', active_tab_id: 'tab-a' } });
    expect(await pending).toBe(true);
    expect(openAndSetTab).not.toHaveBeenCalled();
    expect(renderState).not.toHaveBeenCalled();
    expect(context.activeTabByCid.get('a')).toBe('tab-a');
    expect(context.activeTabByCid.has('b')).toBe(false);
    expect(context.revealedTasks.size).toBe(0);

    context.activeView = 'conversation';
    context.activeCid = 'b';
    context.contextEpoch++;
    const current = context.openForModel({ url: 'https://example.com/current' });
    resolve({ ok: true, state: { conversation_id: 'b', active_tab_id: 'tab-b' } });
    expect(await current).toBe(true);
    expect(openAndSetTab).toHaveBeenCalledExactlyOnceWith('browser', 'b');
  });

  function activityContext(invoke: ReturnType<typeof vi.fn>) {
    function node() {
      let text = '';
      const el: any = { children: [], listeners: {}, dataset: {},
        append: (...children: any[]) => el.children.push(...children),
        appendChild: (child: any) => el.children.push(child),
        addEventListener: (event: string, fn: any) => { el.listeners[event] = fn; },
      };
      Object.defineProperty(el, 'textContent', {
        get: () => text,
        set: value => { text = value; el.children.length = 0; },
      });
      return el;
    }
    const context = vm.createContext({
      activeView: 'conversation', activeCid: 'a', contextEpoch: 0, activityRequest: 0, activityRefresh: null,
      activityEl: { hidden: false }, activityListEl: node(),
      window: { orkas: { invoke } }, label: (_key: string, fallback: string) => fallback,
      openChatFileViewer: vi.fn(async () => {}), uiToast: vi.fn(),
      icon: (name: string) => name, document: { createElement: node }, Date,
    });
    vm.runInContext(webAssistSource.slice(webAssistSource.indexOf('  function refreshActivity(event) {'),
      webAssistSource.indexOf('  function ensureMainActiveTab(')), context);
    return context;
  }

  function downloadPromptContext(invoke = vi.fn(async () => ({ ok: true }))) {
    const elements = new Map<string, any>();
    const element = (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { hidden: false, disabled: false, textContent: '' });
      return elements.get(selector);
    };
    const context = vm.createContext({
      currentState: { tabs: [{ conversation_id: 'a', download_request: { id: 'first', origin: 'https://files.example', filename: '<report>.csv' } }] },
      panelOpen: true, panelTab: 'browser', activeView: 'conversation', activeCid: 'a', contextEpoch: 0,
      downloadPromptEl: { hidden: true, querySelector: element, querySelectorAll: () => [element('[data-act="deny-download"]'), element('[data-act="allow-download"]')] },
      activityBtn: {}, activeDownloadPrompt: null, downloadRevealKey: '', dismissedDownloadRequests: new Set(),
      window: { orkas: { invoke } }, label: (_key: string, fallback: string) => fallback,
      setActivityOpen: vi.fn(), syncVisibility: vi.fn(),
    });
    context.tabsForConversation = () => context.currentState.tabs.filter((tab: any) => tab.conversation_id === context.activeCid);
    vm.runInContext(webAssistSource.slice(webAssistSource.indexOf('  function renderDownloadPrompt()'),
      webAssistSource.indexOf('  function setActivityOpen(')), context);
    return { context, element, invoke };
  }

  it('shows consent only in its task browser, remembers dismissal, and asks again for a new attempt', () => {
    const { context, element, invoke } = downloadPromptContext();
    context.activeCid = 'other';
    context.renderDownloadPrompt();
    expect(context.downloadPromptEl.hidden).toBe(true);
    context.activeCid = 'a';
    context.renderDownloadPrompt();
    expect(context.downloadPromptEl.hidden).toBe(false);
    expect(element('.web-assist-download-origin').textContent).toBe('https://files.example');
    expect(element('.web-assist-download-filename').textContent).toBe('<report>.csv');
    expect(element('.web-assist-download-filename').innerHTML).toBeUndefined();
    expect(context.setActivityOpen).toHaveBeenCalledWith(false);
    context.dismissDownloadPrompt();
    context.renderDownloadPrompt();
    expect(context.downloadPromptEl.hidden).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    context.currentState.tabs[0].download_request.id = 'retry';
    context.renderDownloadPrompt();
    expect(context.downloadPromptEl.hidden).toBe(false);
    expect(context.dismissedDownloadRequests.size).toBe(0);
    context.panelTab = 'files';
    context.renderDownloadPrompt();
    expect(context.downloadPromptEl.hidden).toBe(true);
    const openAndSetTab = vi.fn(() => { context.panelOpen = true; context.panelTab = 'browser'; return true; });
    context.window.ConversationInfo = { openAndSetTab };
    context.panelOpen = false;
    context.renderDownloadPrompt();
    expect(openAndSetTab).not.toHaveBeenCalled();
    context.contextEpoch++;
    context.renderDownloadPrompt();
    expect(openAndSetTab).toHaveBeenCalledExactlyOnceWith('browser', 'a');
    expect(context.downloadPromptEl.hidden).toBe(false);
  });

  it('keeps a failed consent local and retryable, grants only the displayed task/site, and never retries the transfer', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
    const { context, element } = downloadPromptContext(invoke);
    context.renderDownloadPrompt();
    await context.allowDownloadPrompt();
    expect(context.downloadPromptEl.hidden).toBe(false);
    expect(element('.web-assist-download-error').hidden).toBe(false);
    expect(element('.web-assist-download-error').textContent).toContain('Try again');
    expect(element('[data-act="allow-download"]').disabled).toBe(false);
    await context.allowDownloadPrompt();
    expect(context.downloadPromptEl.hidden).toBe(true);
    expect(invoke.mock.calls).toEqual([
      ['webAssist.allowDownloadOrigin', { conversation_id: 'a', origin: 'https://files.example' }],
      ['webAssist.allowDownloadOrigin', { conversation_id: 'a', origin: 'https://files.example' }],
    ]);
  });

  it('does not dismiss or overwrite another task prompt when an old consent response arrives', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const { context, element } = downloadPromptContext(invoke);
    context.renderDownloadPrompt();
    const pending = context.allowDownloadPrompt();
    await context.allowDownloadPrompt();
    expect(invoke).toHaveBeenCalledTimes(1);
    context.activeCid = 'b';
    context.contextEpoch++;
    context.currentState.tabs.push({ conversation_id: 'b', download_request: { id: 'second', origin: 'https://other.example', filename: 'other.csv' } });
    context.renderDownloadPrompt();
    finish({ ok: false });
    await pending;
    expect(context.downloadPromptEl.hidden).toBe(false);
    expect(element('.web-assist-download-origin').textContent).toBe('https://other.example');
    expect(element('.web-assist-download-error').hidden).toBe(true);
    expect(element('[data-act="allow-download"]').disabled).toBe(false);
  });

  it('merges visits and downloads newest first, identifies their meaning, and offers only answerable grants', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'webAssist.navigations') return { ok: true, navigations: [
        { at: 2, url: 'https://example.com/linked', from_link: true },
        { at: 5, url: 'https://example.com/<script>', from_link: false },
      ] };
      return { ok: true, allowed_origins: [], downloads: [
        { at: 0, origin: 'https://a.example', filename: 'saved.csv', state: 'saved' },
        { at: 1, origin: 'https://b.example', filename: 'ask.csv', state: 'refused', reason: 'needs_origin_grant' },
        { at: 3, origin: 'https://b.example', filename: 'tool.exe', state: 'refused', reason: 'blocked_type' },
        { at: 4, origin: 'https://b.example', filename: 'large.csv', state: 'refused', reason: 'task_budget' },
      ] };
    });
    const context = activityContext(invoke);
    await context.renderActivity();
    const rows = context.activityListEl.children;
    expect(rows.map((row: any) => row.children[2].textContent)).toEqual([
      'https://example.com/<script>', 'large.csv', 'tool.exe', 'https://example.com/linked', 'ask.csv', 'saved.csv',
    ]);
    expect(rows[0].children[2].innerHTML).toBeUndefined();
    expect(rows.map((row: any) => row.children[0].innerHTML)).toEqual(['globe', 'download', 'download', 'globe', 'download', 'download']);
    // Visits have no provenance label, regardless of how the URL was obtained.
    expect(rows[0].children).toHaveLength(3);
    expect(rows[3].children).toHaveLength(3);
    expect(rows[5].children[3].textContent).toBe('saved to attachments');
    const grants = rows.filter((row: any) => row.children.some((child: any) => child.className === 'web-assist-download-allow'));
    expect(rows[5].children[4].children.map((button: any) => button.textContent)).toEqual(['View file', 'Open in folder']);
    expect(rows.slice(0, 5).flatMap((row: any) => row.children).some((child: any) => child.className === 'web-assist-download-actions')).toBe(false);
    expect(grants).toHaveLength(1);
    expect(grants[0].children[2].textContent).toBe('ask.csv');
    await grants[0].children[4].listeners.click();
    expect(invoke).toHaveBeenCalledWith('webAssist.allowDownloadOrigin', { conversation_id: 'a', origin: 'https://b.example' });
    await new Promise(resolve => setImmediate(resolve));
    context.activityEl.hidden = true;
    invoke.mockClear();
    await context.renderActivity();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('shows an unfinished download as loading without offering file actions', async () => {
    const invoke = vi.fn(async (method: string) => method === 'webAssist.navigations'
      ? { ok: true, navigations: [] }
      : { ok: true, downloads: [{ at: 1, filename: 'report.csv', state: 'downloading' }] });
    const context = activityContext(invoke);
    await context.renderActivity();
    const row = context.activityListEl.children[0];
    expect(row.children[3].textContent).toBe('Loading…');
    expect(row.children.some((child: any) => child.className === 'web-assist-download-actions')).toBe(false);
  });

  it.each(['view', 'reveal'])('opens a saved download through %s in its own task, and suppresses duplicate clicks', async (action) => {
    let resolveFile!: (value: unknown) => void;
    const invoke = vi.fn(async (method: string) => {
      if (method === 'webAssist.navigations') return { ok: true, navigations: [] };
      if (method === 'webAssist.downloads') return { ok: true, downloads: [{ at: 1, filename: 'report (1).csv', state: 'saved' }] };
      if (method === 'attachments.absPath') return new Promise(resolve => { resolveFile = resolve; });
      return { ok: true };
    });
    const context = activityContext(invoke);
    await context.renderActivity();
    const buttons = context.activityListEl.children[0].children[4].children;
    const button = buttons.find((item: any) => item.dataset.downloadAction === action);
    const pending = button.listeners.click();
    expect(buttons.every((item: any) => item.disabled)).toBe(true);
    await button.listeners.click();
    expect(invoke.mock.calls.filter(([method]) => method === 'attachments.absPath')).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('attachments.absPath', { cid: 'a', name: 'report (1).csv' });
    resolveFile({ ok: true, path: '/task-attachments/a/report (1).csv' });
    await pending;
    if (action === 'view') {
      expect(context.openChatFileViewer).toHaveBeenCalledExactlyOnceWith('/task-attachments/a/report (1).csv', 'report (1).csv', { cid: 'a' });
      expect(invoke.mock.calls.some(([method]) => method === 'workspace.revealPath')).toBe(false);
    } else {
      expect(invoke).toHaveBeenCalledWith('workspace.revealPath', { path: '/task-attachments/a/report (1).csv', cid: 'a' });
      expect(context.openChatFileViewer).not.toHaveBeenCalled();
    }
    expect(buttons.every((item: any) => !item.disabled)).toBe(true);
    expect(context.uiToast).not.toHaveBeenCalled();
  });

  it.each(['view', 'reveal'])('does not %s a stale download after leaving and returning to the task', async (action) => {
    let resolveFile!: (value: unknown) => void;
    const invoke = vi.fn(async (method: string) => {
      if (method === 'webAssist.navigations') return { ok: true, navigations: [] };
      if (method === 'webAssist.downloads') return { ok: true, downloads: [{ at: 1, filename: 'report.csv', state: 'saved' }] };
      return new Promise(resolve => { resolveFile = resolve; });
    });
    const context = activityContext(invoke);
    await context.renderActivity();
    const button = context.activityListEl.children[0].children[4].children.find((item: any) => item.dataset.downloadAction === action);
    const pending = button.listeners.click();
    context.contextEpoch += 2;
    resolveFile({ ok: true, path: '/task-attachments/a/report.csv' });
    await pending;
    expect(context.openChatFileViewer).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([method]) => method === 'workspace.revealPath')).toBe(false);
    expect(context.uiToast).not.toHaveBeenCalled();
    invoke.mockClear();
    await button.listeners.click();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['missing', 'reveal-failed'])('keeps the download action retryable with useful feedback when %s', async (failure) => {
    let recover = false;
    const invoke = vi.fn(async (method: string) => {
      if (method === 'webAssist.navigations') return { ok: true, navigations: [] };
      if (method === 'webAssist.downloads') return { ok: true, downloads: [{ at: 1, filename: 'report.csv', state: 'saved' }] };
      if (method === 'attachments.absPath') return failure === 'missing' && !recover ? { ok: false } : { ok: true, path: '/task-attachments/a/report.csv' };
      return { ok: recover };
    });
    const context = activityContext(invoke);
    await context.renderActivity();
    const button = context.activityListEl.children[0].children[4].children.find((item: any) => item.dataset.downloadAction === 'reveal');
    await button.listeners.click();
    expect(context.uiToast).toHaveBeenCalledWith(expect.any(String), { variant: 'warning' });
    expect(context.openChatFileViewer).not.toHaveBeenCalled();
    if (failure === 'missing') expect(invoke.mock.calls.some(([method]) => method === 'workspace.revealPath')).toBe(false);
    expect(button.disabled).toBe(false);
    recover = true;
    context.uiToast.mockClear();
    await button.listeners.click();
    expect(context.uiToast).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('workspace.revealPath', { path: '/task-attachments/a/report.csv', cid: 'a' });
  });

  it('retains readable records when one ledger fails and distinguishes unavailable activity from empty activity', async () => {
    let fail = true;
    const invoke = vi.fn(async (method: string) => {
      if (fail && method === 'webAssist.navigations') throw new Error('fixture unavailable');
      return { ok: true, navigations: [], downloads: fail ? [{ at: 1, filename: 'saved.csv', state: 'saved' }] : [] };
    });
    const context = activityContext(invoke);
    await context.renderActivity();
    expect(context.activityListEl.children).toHaveLength(2);
    expect(context.activityListEl.children[0].textContent).toContain('Close and reopen to retry');
    expect(context.activityListEl.children[1].children[2].textContent).toBe('saved.csv');
    fail = false;
    await context.renderActivity();
    expect(context.activityListEl.children).toHaveLength(1);
    expect(context.activityListEl.children[0].textContent).toBe('No visits or downloads in this task yet.');
  });

  it.each([
    ['webAssist.setContext', 'context update failed'],
    ['webAssist.state', 'state reload failed'],
  ])('reports a rejected %s without private payloads and recovers on the next update', async (failedMethod, warning) => {
    const start = webAssistSource.indexOf('  function setContext(view, cid) {');
    const end = webAssistSource.indexOf('  function setPanelState(', start);
    const state = { tabs: [] };
    let failing = true;
    const invoke = vi.fn(async (method: string) => {
      if (failing && method === failedMethod) throw new Error('private-cid https://private.invalid/?token=fixture-secret');
      return { ok: true, state };
    });
    const warn = vi.fn();
    const renderState = vi.fn();
    const ensureDefaultTab = vi.fn();
    const context = vm.createContext({
      activeView: '', activeCid: '', currentState: null, contextEpoch: 0,
      window: { orkas: { invoke } }, log: { warn }, renderState, ensureDefaultTab, revealCurrentTask() {},
    });
    context.updateContext = (view: string, cid: string) => {
      context.activeView = view;
      context.activeCid = cid;
      context.contextEpoch += 1;
    };
    vm.runInContext(webAssistSource.slice(start, end), context);
    context.setContext('conversation', 'private-cid');
    await new Promise(resolve => setImmediate(resolve));
    expect(warn).toHaveBeenCalledExactlyOnceWith(warning);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|token|fixture-secret/);
    expect(invoke).toHaveBeenCalledWith('webAssist.setContext', { conversationId: 'private-cid' });
    expect(invoke).toHaveBeenCalledWith('webAssist.state', {});
    if (failedMethod === 'webAssist.state') expect(ensureDefaultTab).not.toHaveBeenCalled();
    failing = false;
    renderState.mockClear();
    ensureDefaultTab.mockClear();
    context.setContext('conversation', 'next-cid');
    await new Promise(resolve => setImmediate(resolve));
    expect(renderState).toHaveBeenLastCalledWith(state);
    expect(ensureDefaultTab).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    invoke.mockClear();
    context.setContext('connectors', 'next-cid');
    await new Promise(resolve => setImmediate(resolve));
    expect(invoke).toHaveBeenCalledExactlyOnceWith('webAssist.setContext', { conversationId: '' });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('refreshes only an open matching task, coalesces bursts, and retains rows and scrolling during reads', async () => {
    const pending: Array<(value: unknown) => void> = [];
    let delayed = false;
    const response = { ok: true, navigations: [{ at: 1, url: 'first' }], downloads: [] };
    const invoke = vi.fn(() => delayed ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(response));
    const context = activityContext(invoke);
    await context.renderActivity();
    const row = context.activityListEl.children[0];
    invoke.mockClear();
    context.refreshActivity({ conversation_id: 'other' });
    context.activityEl.hidden = true;
    context.refreshActivity({ conversation_id: 'a' });
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    context.activityEl.hidden = false;
    delayed = true;
    const refresh = context.refreshActivity({ conversation_id: 'a' });
    for (let i = 0; i < 100; i++) context.refreshActivity({ conversation_id: 'a' });
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(context.activityListEl.children[0]).toBe(row);
    context.activityListEl.scrollTop = 137;
    for (let i = 0; i < 100; i++) context.refreshActivity({ conversation_id: 'a' });
    pending.splice(0).forEach(resolve => resolve(response));
    await new Promise(resolve => setImmediate(resolve));
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(context.activityListEl.scrollTop).toBe(137);
    pending.splice(0).forEach(resolve => resolve({ ok: true, navigations: [], downloads: [{ at: 2, filename: 'new.csv', state: 'saved' }] }));
    await refresh;
    expect(context.activityListEl.children[0].children[2].textContent).toBe('new.csv');
    expect(context.activityListEl.scrollTop).toBe(137);
    expect(context.activityRefresh).toBeNull();
    expect(webAssistSource).toContain("onPushEvent('web-assist:activity', refreshActivity)");
  });

  it('keeps combined records and grants bound to their task across late responses and reopening', async () => {
    const pending: Array<{ method: string; cid: string; resolve: (value: unknown) => void }> = [];
    const invoke = vi.fn((method: string, args: any) => new Promise(resolve => pending.push({ method, cid: args.conversation_id, resolve })));
    const context = activityContext(invoke);
    const response = (name: string) => ({ ok: true,
      downloads: [{ at: 1, filename: name, origin: `https://${name}.example`, state: 'refused', reason: 'needs_origin_grant' }],
      navigations: [{ at: 0, url: name, from_link: true }], allowed_origins: [],
    });
    const resolvePair = (name: string, offset = 0) => pending.splice(offset, 2).forEach(item => item.resolve(response(name)));
    const first = context.renderActivity();
    resolvePair('a');
    await first;
    const oldButton = context.activityListEl.children[0].children[4];
    const late = context.renderActivity();
    context.activeCid = 'b';
    context.contextEpoch++;
    const next = context.renderActivity();
    expect(pending.map(request => request.cid)).toEqual(['a', 'a', 'b', 'b']);
    resolvePair('b', 2);
    await next;
    resolvePair('old-a');
    await late;
    expect(context.activityListEl.children.map((row: any) => row.children[2].textContent)).toEqual(['b', 'b']);
    context.activeCid = 'a';
    context.contextEpoch++;
    await oldButton.listeners.click();
    expect(invoke.mock.calls.some(([method]) => method === 'webAssist.allowDownloadOrigin')).toBe(false);
    const older = context.renderActivity();
    const newer = context.renderActivity();
    resolvePair('newest-a', 2);
    await newer;
    resolvePair('stale-a');
    await older;
    expect(context.activityListEl.children.map((row: any) => row.children[2].textContent)).toEqual(['newest-a', 'newest-a']);
    const closing = context.renderActivity();
    context.activityEl.hidden = true;
    context.activityRequest++;
    resolvePair('closed-a');
    await closing;
    expect(context.activityListEl.children[0].textContent).toBe('Loading…');
  });

  it('reveals a task used in the background on return without reopening a manually dismissed browser', () => {
    const openAndSetTab = vi.fn(() => true);
    const context = vm.createContext({
      activeView: 'conversation', activeCid: 'foreground', revealedTasks: new Set(),
      tabsForConversation: () => [{ conversation_id: 'background', assistant_controlled: true }].filter(tab => tab.conversation_id === context.activeCid),
      window: { ConversationInfo: { openAndSetTab } },
    });
    vm.runInContext(webAssistSource.slice(webAssistSource.indexOf('  function revealCurrentTask() {'),
      webAssistSource.indexOf('  function showFromMain(')), context);
    context.revealCurrentTask();
    expect(openAndSetTab).not.toHaveBeenCalled();
    context.activeCid = 'background';
    context.revealCurrentTask();
    expect(openAndSetTab).toHaveBeenCalledExactlyOnceWith('browser', 'background');
    context.activeView = 'connectors';
    context.revealCurrentTask();
    context.activeView = 'conversation';
    context.revealCurrentTask();
    expect(openAndSetTab).toHaveBeenCalledOnce();
  });

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
      renderDownloadPrompt() {}, ensureMainActiveTab() {}, syncVisibility() {},
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
    const openAndSetTab = vi.fn(() => true);
    const renderState = vi.fn();
    const context = vm.createContext({
      ensureShell() {}, rememberMainActiveTab() {}, renderState,
      activeView: 'conversation', activeCid: 'c1', currentState: null,
      revealedTasks: new Set(), window: { ConversationInfo: { openAndSetTab } },
    });
    vm.runInContext(webAssistSource.slice(start, end), context);
    const state = { conversation_id: 'c1', active_tab_id: 'tab-1', assistant_action: 'observing' };
    context.showFromMain(state);
    expect(openAndSetTab).toHaveBeenCalledExactlyOnceWith('browser', 'c1');
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
    expect(openAndSetTab).toHaveBeenCalledExactlyOnceWith('browser', 'c1');
    openAndSetTab.mockClear();
    context.beginTaskTurn('c1');
    context.activeView = 'connectors';
    context.showFromMain(state);
    expect(openAndSetTab).not.toHaveBeenCalled();
    context.activeView = 'conversation';
    context.showFromMain(state);
    expect(openAndSetTab).toHaveBeenCalledExactlyOnceWith('browser', 'c1');

    // A panel still bound to the previous task rejects the reveal. The next
    // update must be able to reveal once the matching task is bound.
    openAndSetTab.mockClear();
    context.beginTaskTurn('c1');
    openAndSetTab.mockReturnValueOnce(false);
    context.showFromMain(state);
    expect(context.revealedTasks.has('c1')).toBe(false);
    context.showFromMain(state);
    context.showFromMain(state);
    expect(openAndSetTab).toHaveBeenCalledTimes(2);
    expect(context.revealedTasks.has('c1')).toBe(true);
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

  it.each(['close', 'switch', 'decode-failure', 'ready'])('keeps overlay capture safe during %s', async scenario => {
    let finish!: (value: unknown) => void;
    let decode!: () => void;
    const invoke = vi.fn((method: string) => method === 'webAssist.capturePreview'
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true }));
    const appendChild = vi.fn();
    const context = vm.createContext({
      pagePreview: null, pagePreviewTabId: '', pagePreviewRequest: 0,
      contextEpoch: 0, nativeVisible: false,
      window: { orkas: { invoke } }, host: { appendChild }, log: { warn: vi.fn() },
      Image: class {
        setAttribute() {}
        decode() { return scenario === 'decode-failure' ? Promise.reject(new Error('fixture decode failed'))
          : new Promise<void>(resolve => { decode = resolve; }); }
      },
    });
    vm.runInContext(webAssistSource.slice(webAssistSource.indexOf('  function clearPagePreview()'),
      webAssistSource.indexOf('  function syncVisibility()')), context);
    const pending = context.hideNativeView('tab');
    expect(invoke).not.toHaveBeenCalledWith('webAssist.layout', expect.anything());
    finish({ preview: 'data:image/jpeg;base64,fixture' });
    if (scenario !== 'decode-failure') await vi.waitFor(() => expect(decode).toBeTypeOf('function'));
    if (scenario === 'close') { context.nativeVisible = true; context.pagePreviewRequest++; }
    if (scenario === 'switch') { context.contextEpoch++; context.clearPagePreview(); }
    if (scenario !== 'decode-failure') decode();
    await pending;
    if (scenario === 'ready') {
      expect(appendChild).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenLastCalledWith('webAssist.layout', { visible: false });
      expect(appendChild.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[1]);
    } else if (scenario === 'decode-failure') {
      expect(appendChild).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenLastCalledWith('webAssist.layout', { visible: false });
      expect(context.log.warn).toHaveBeenCalledWith('browser preview unavailable');
    } else {
      expect(appendChild).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledTimes(1);
    }
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
      pagePreviewTabId: '', pagePreviewRequest: 0, activityEl: null, downloadPromptEl: null,
      clearPagePreview() {},
      hideNativeView: () => context.window.orkas.invoke('webAssist.layout', { visible: false }),
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
      pagePreviewTabId: '', pagePreviewRequest: 0, activityEl: null, downloadPromptEl: null,
      clearPagePreview() {},
      hideNativeView: () => context.window.orkas.invoke('webAssist.layout', { visible: false }),
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
      pagePreviewTabId: '', pagePreviewRequest: 0, activityEl: null, downloadPromptEl: null,
      clearPagePreview() {},
      hideNativeView: () => context.window.orkas.invoke('webAssist.layout', { visible: false }),
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
      pagePreviewTabId: '', pagePreviewRequest: 0, activityEl: null, downloadPromptEl: null,
      clearPagePreview() {},
      hideNativeView: () => context.window.orkas.invoke('webAssist.layout', { visible: false }),
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

  it('offers only the supported task-detail destinations in the shipped page', () => {
    // A leftover Tasks tab renders the Files empty state under the wrong label.
    // Read the real page: synthetic controller fixtures cannot catch that drift.
    const tabs = [...indexSource.matchAll(/<button\b[^>]*\bdata-info-tab="([^"]+)"[^>]*>/g)];
    expect(tabs.map((match) => match[1])).toEqual(['files', 'attachments', 'browser']);
    expect(tabs.filter((match) => /\bis-active\b/.test(match[0])).map((match) => match[1])).toEqual(['files']);
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
        'web_assist.download_unavailable',
        'web_assist.download_prompt_title',
        'web_assist.download_prompt_description',
        'web_assist.download_not_now',
        'web_assist.download_permission_failed',
        'chat.process.action_view_file',
        'chat.preview_reveal_title',
        'web_assist.open_failed',
        'web_assist.open_external_failed',
        'web_assist.close_failed',
      ]) {
        expect(table[key], `${language}:${key}`).toBeTruthy();
      }
    }
  });
});
