// Sidebar "Recent Tasks" aggregate (pinned or active within 24h; DOM ids and i18n keys
// keep the historical "today" names). The section mirrors rows that also live
// under a Project or in the catch-all Tasks list, so these cases load the real
// conversation row renderer/handlers (conversation.js) next to the module and
// assert what the user sees: which tasks appear, in what order, that opening
// one navigates like any other sidebar copy, and that the empty/rename/delete
// paths do not disturb the other lists.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// 2026-05-15T14:30:00 local; today starts at 2026-05-15T00:00:00 local.
const NOW = new Date(2026, 4, 15, 14, 30, 0);
const todayStart = (() => { const d = new Date(NOW); d.setHours(0, 0, 0, 0); return d; })();
const at = (ms: number) => new Date(todayStart.getTime() + ms).toISOString();
const HOUR = 60 * 60 * 1000;

function escapeHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c] || c));
}

function readModule(name: string) {
  return fs.readFileSync(path.join(__dirname, '../../src/renderer/modules', name), 'utf8');
}

function makeRow(cid: string) {
  const row: any = { dataset: { cid }, listeners: {} as Record<string, (event: any) => void>, children: [] as any[] };
  row.addEventListener = (type: string, fn: (event: any) => void) => { row.listeners[type] = fn; };
  row.click = () => row.listeners.click?.({ target: { closest: () => null } });
  // Just enough row structure for the shared badge painter to place a live dot.
  row.querySelector = (selector: string) => {
    if (selector === '.conv-status-badge') return row.children.find((child: any) => /conv-status-badge/.test(child.className)) || null;
    if (selector === '.conv-item-title') return { parentElement: row };
    return null;
  };
  row.insertBefore = (el: any) => { el.parent = row; row.children.push(el); };
  row.prepend = (el: any) => { el.parent = row; row.children.unshift(el); };
  row.badges = () => row.children.filter((child: any) => /conv-status-badge/.test(child.className)).map((child: any) => child.className);
  return row;
}

function makeContainer() {
  let html = '';
  const rows: any[] = [];
  const container: any = {
    rows,
    more: null as any,
    renameInput: null as any,
    querySelector(selector: string) {
      if (selector === '[data-recent-conv-more]') return container.more;
      return selector.startsWith('input.conv-item-title-input') ? container.renameInput : null;
    },
    querySelectorAll(selector: string) {
      return selector === '.conv-item' ? rows : [];
    },
    insertAdjacentHTML(_position: string, value: string) { container.innerHTML = html + value; },
    cids() { return rows.map((row) => row.dataset.cid); },
  };
  Object.defineProperty(container, 'innerHTML', {
    get: () => html,
    set: (value: string) => {
      html = value;
      rows.length = 0;
      for (const match of value.matchAll(/\sdata-cid="([^"]+)"/g)) rows.push(makeRow(match[1]));
      container.more = value.includes('data-recent-conv-more') ? makeRow('more') : null;
      if (container.more) container.more.focus = () => {};
    },
  });
  return container;
}

function loadTodayTasksRenderer() {
  let clock = NOW.getTime();
  class FixedDate extends Date {
    constructor(...args: any[]) {
      if (args.length) super(...(args as [any])); else super(clock);
    }
    static now() { return clock; }
  }
  const container = makeContainer();
  // The catch-all Tasks list that `renderConversationList` paints alongside
  // the Today mirror; both feed the document-wide badge queries below.
  const conversationList = makeContainer();
  const allRows = () => [...container.rows, ...conversationList.rows];
  const navigations: Array<[string, string]> = [];
  const trackedClicks: Array<[string, Record<string, unknown>]> = [];
  const projectReloads: unknown[] = [];
  const windowListeners = new Map<string, Function[]>();
  let unreadRefreshes = 0;
  const context: any = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn: Function) => { setTimeout(fn, 0); return 1; },
    encodeURIComponent, URLSearchParams, JSON, Map, Set, Array, String, Number, RegExp,
    Date: FixedDate,
    CSS: { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') },
    currentCid: '',
    currentView: 'new-chat',
    conversations: [],
    pendingConvs: new Map(),
    groupBusyConvs: new Map(),
    isConvPending: (cid: string) => context.pendingConvs.has(cid),
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    escapeHtml,
    t: (key: string) => key,
    renderAvatarHtml: () => '',
    setView: (view: string, cid: string) => { navigations.push([view, cid]); },
    loadProjects: async (force: boolean) => { projectReloads.push(force); },
    _refreshUnreadTaskIndicators: () => { unreadRefreshes += 1; },
    Monitor: {
      click: (action: string, data: Record<string, unknown>) => trackedClicks.push([action, data]),
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector === '.conv-item') return allRows();
        const byCid = /^\.conv-item\[data-cid="(.*)"\]$/.exec(selector);
        return byCid ? allRows().filter((row) => row.dataset.cid === byCid[1]) : [];
      },
      createElement: () => {
        const el: any = { className: '', innerHTML: '', parent: null };
        // Mirror the live DOM's classList, including after className changes.
        el.classList = { contains: (name: string) => el.className.split(/\s+/).includes(name) };
        el.remove = () => { if (el.parent) el.parent.children = el.parent.children.filter((child: any) => child !== el); };
        return el;
      },
      getElementById: (id: string) => (id === 'today-list' ? container : id === 'conversation-list' ? conversationList : null),
    },
    window: {
      addEventListener(type: string, listener: Function) {
        windowListeners.set(type, [...(windowListeners.get(type) || []), listener]);
      },
      dispatchEvent(event: any) {
        for (const listener of windowListeners.get(event.type) || []) listener(event);
      },
      Monitor: true,
      uiIconHtml: () => '',
      ConversationRuntime: {},
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(readModule('conv-bucket.js'), context);
  vm.runInContext(readModule('conversation.js'), context);
  vm.runInContext(readModule('today-tasks.js'), context);
  const recentToggle = makeRow('today-section-toggle');
  recentToggle.setAttribute = () => {};
  const { initSidebarSections } = require('../../src/renderer/modules/sidebar-sections.js');
  initSidebarSections({
    querySelector: (selector: string) => selector === '.sidebar-today-section'
      ? { classList: { toggle() {} } } : null,
    getElementById: (id: string) => id === 'today-section-toggle' ? recentToggle
      : id === 'today-list' ? container : null,
  }, context.localStorage, context.t, (detail: any) => {
    context.window.dispatchEvent({ type: 'sidebar-section-toggle', detail });
  });
  return {
    context,
    container,
    conversationList,
    navigations,
    trackedClicks,
    projectReloads,
    recentToggle,
    unreadRefreshes: () => unreadRefreshes,
    setNow: (date: Date) => { clock = date.getTime(); },
  };
}

describe('sidebar Today aggregate', () => {
  it.each([0, 10, 11])('shows at most ten recent tasks and offers more only when needed (%i tasks)', (count) => {
    const h = loadTodayTasksRenderer();
    h.context.conversations = Array.from({ length: count }, (_, i) => ({
      conversation_id: `recent-${i}`, title: `Task ${i}`, last_active_at: at(HOUR - i),
    }));
    h.context.renderConversationList();
    expect(h.container.cids()).toHaveLength(Math.min(count, 10));
    expect(Boolean(h.container.more)).toBe(count > 10);
    // Pagination belongs only to the mirror, not the shared cache or Tasks list.
    expect(h.context.conversations).toHaveLength(count);
    expect(h.conversationList.cids()).toHaveLength(count);
  });

  it('reveals ten more at a time, preserves expansion on refresh and paints newly visible running tasks', () => {
    const h = loadTodayTasksRenderer();
    h.context.conversations = Array.from({ length: 21 }, (_, i) => ({
      conversation_id: `recent-${i}`, title: `Task ${i}`, project_id: 'p1', last_active_at: at(HOUR - i),
    }));
    h.context.pendingConvs.set('recent-10', { aborted: false });
    h.context.renderConversationList();
    expect(h.container.cids()).toEqual(Array.from({ length: 10 }, (_, i) => `recent-${i}`));
    h.container.more.click();
    expect(h.container.cids()).toEqual(Array.from({ length: 20 }, (_, i) => `recent-${i}`));
    expect(h.container.rows[10].badges()).toEqual(['conv-status-badge is-streaming']);
    h.context.renderConversationList();
    expect(h.container.cids()).toHaveLength(20);
    h.container.more.click();
    expect(h.container.cids()).toEqual(Array.from({ length: 21 }, (_, i) => `recent-${i}`));
    expect(h.container.more).toBeNull();
    h.container.rows[20].click();
    expect(h.navigations).toEqual([['conversation', 'recent-20']]);
  });

  it.each([1, 2])('returns to the first ten tasks after reopening with %i extra pages previously revealed', (pages) => {
    const h = loadTodayTasksRenderer();
    h.context.conversations = Array.from({ length: 21 }, (_, i) => ({
      conversation_id: `recent-${i}`, title: `Task ${i}`, last_active_at: at(HOUR - i),
    }));
    h.context.pendingConvs.set('recent-0', { aborted: false });
    h.context.renderConversationList();
    for (let i = 0; i < pages; i += 1) h.container.more.click();
    expect(h.container.cids()).toHaveLength(pages === 1 ? 20 : 21);

    // Other section controls must not discard the Recent list's expansion.
    h.context.window.dispatchEvent({ type: 'sidebar-section-toggle', detail: { name: 'projects', collapsed: false } });
    h.context.renderConversationList();
    expect(h.container.cids()).toHaveLength(pages === 1 ? 20 : 21);
    h.recentToggle.click();
    expect(h.container.hidden).toBe(true);
    h.recentToggle.click();

    expect(h.container.hidden).toBe(false);
    expect(h.container.cids()).toEqual(Array.from({ length: 10 }, (_, i) => `recent-${i}`));
    expect(h.container.rows[0].badges()).toEqual(['conv-status-badge is-streaming']);
    expect(h.context.conversations).toHaveLength(21);
    expect(h.conversationList.cids()).toHaveLength(21);
    expect(h.projectReloads).toEqual([]);
    h.container.more.click();
    expect(h.container.cids()).toHaveLength(20);
  });

  it.each([
    ['project page', 'list-first'],
    ['project page', 'receipt-first'],
    ['startup refresh', 'list-first'],
    ['startup refresh', 'receipt-first'],
    ['pagination', 'list-first'],
    ['pagination', 'receipt-first'],
  ])('keeps one running task when %s and its run receipt arrive %s', async (listKind, order) => {
    const h = loadTodayTasksRenderer();
    vm.runInContext(readModule('project-detail.js'), h.context);
    const original = { conversation_id: 'run-one', project_id: 'p1', title: 'Original task',
      created_at: at(HOUR), updated_at: at(HOUR) };
    const current = { ...original, title: 'Renamed running task', title_manually_set: true,
      updated_at: at(2 * HOUR), last_active_at: at(2 * HOUR), processing: true,
      agent_ids: ['worker'], pinned_at: at(2 * HOUR) };
    // The main process creates one conversation while admission is in flight.
    // A concurrent read may observe it before the original run call returns.
    const persisted = [current];
    let releaseRun!: (value: unknown) => void;
    let runCalls = 0;
    h.context.window.orkas = { invoke: () => {
      runCalls += 1;
      return new Promise((resolve) => { releaseRun = resolve; });
    } };
    h.context.ensureModelConfigured = () => true;
    h.context.apiFetch = async () => ({ json: async () => ({ ok: true,
      conversations: persisted.map((row) => ({ ...row })), total: 1, next_offset: null,
      unprojected_pagination: { total: 0, next_offset: null }, loaded_project_ids: [],
    }) });
    h.context.conversations.push({ conversation_id: 'unrelated', project_id: 'p-other',
      title: 'Other task', last_active_at: at(3 * HOUR) });
    const scope = { pid: 'p1', project: {}, tasks: [{ id: 't_one', status: 'todo' }] };
    const run = h.context._runTodoTask('t_one', scope);
    // Repeated user input while the same admission is pending must not
    // produce a second run, independent of how the sidebar is refreshed.
    await h.context._runTodoTask('t_one', scope);
    const load = () => listKind === 'project page'
      ? h.context.loadConversationProject('p1')
      : listKind === 'startup refresh' ? h.context.loadConversations()
        : Promise.resolve(h.context._appendConversationSlice(persisted));
    if (order === 'list-first') await load();
    releaseRun({ ok: true, cid: original.conversation_id, conversation: original });
    await run;
    if (order === 'receipt-first') await load();
    h.context.renderConversationList();

    expect(runCalls).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(h.context.conversations.filter((row: any) => row.conversation_id === 'run-one'))
      .toEqual([current]);
    expect(h.container.cids().filter((cid: string) => cid === 'run-one')).toEqual(['run-one']);
    if (listKind !== 'startup refresh') {
      expect(h.context.conversations.some((row: any) => row.conversation_id === 'unrelated')).toBe(true);
    }
    // Navigation uses that one row; it does not dispatch the task again.
    h.container.rows.find((row: any) => row.dataset.cid === 'run-one').click();
    expect(h.navigations).toEqual([['conversation', 'run-one'], ['conversation', 'run-one']]);
    expect(runCalls).toBe(1);
  });

  it('preserves a refreshed running task when an older auto-advance receipt is repeated', () => {
    const h = loadTodayTasksRenderer();
    vm.runInContext(readModule('project-detail.js'), h.context);
    h.context._observeConversationRunFromPlanAction = () => {};
    const current = { conversation_id: 'auto-one', project_id: 'p1', title: 'Updated title',
      created_at: at(HOUR), updated_at: at(2 * HOUR), last_active_at: at(2 * HOUR),
      processing: true, agent_ids: ['worker'] };
    h.context._appendConversationSlice([current]);
    const receipt = { projectId: 'p1', conversation: { conversation_id: 'auto-one', project_id: 'p1',
      title: 'Creation title', created_at: at(HOUR), updated_at: at(HOUR) } };
    h.context._onProjectAdvance(receipt);
    h.context._onProjectAdvance(receipt);
    expect(h.context.conversations).toEqual([current]);
    expect(h.container.cids()).toEqual(['auto-one']);
  });

  it('keeps an optimistic request title while preserving list-only metadata', () => {
    const h = loadTodayTasksRenderer();
    const original = { conversation_id: 'new-one', created_at: at(HOUR), updated_at: at(HOUR) };
    h.context._appendConversationSlice([{ ...original, title: 'Untitled',
      last_active_at: at(HOUR), processing: false }]);
    h.context._cacheCreatedConversation({ ...original, title: 'Review the brief' }, 'Review the brief');
    h.context.renderConversationList();
    expect(h.context.conversations).toEqual([{ ...original, title: 'Review the brief',
      last_active_at: at(HOUR), processing: false }]);
    expect(h.container.cids()).toEqual(['new-one']);
  });

  it('preserves a manual rename when creation and rename share the same timestamp', () => {
    const h = loadTodayTasksRenderer();
    const renamed = { conversation_id: 'renamed', title: 'User title', title_manually_set: true,
      created_at: at(HOUR), updated_at: at(HOUR), last_active_at: at(HOUR) };
    h.context._appendConversationSlice([renamed]);
    h.context._cacheCreatedConversation({ conversation_id: 'renamed', title: 'Creation title',
      created_at: at(HOUR), updated_at: at(HOUR) });
    expect(h.context.conversations).toEqual([renamed]);
  });

  it('keeps admitted participants when creation and admission share the same timestamp', () => {
    const h = loadTodayTasksRenderer();
    const admitted = { conversation_id: 'admitted', title: 'Run task', created_at: at(HOUR),
      updated_at: at(HOUR), last_active_at: at(HOUR), agent_ids: ['worker'],
      commander_in_chat: true, participant_summary_updated_at: at(HOUR), processing: true };
    h.context._appendConversationSlice([admitted]);
    // Real createConversation receipts carry empty participant summaries.
    // Second-resolution timestamps cannot order that receipt against admission.
    h.context._cacheCreatedConversation({ ...admitted, agent_ids: [], commander_in_chat: false });
    expect(h.context.conversations).toEqual([admitted]);
  });

  it('keeps one identity when a project page observes a conversation moved from another project', () => {
    const h = loadTodayTasksRenderer();
    const old = { conversation_id: 'moved', project_id: 'old-project', title: 'Moved task', last_active_at: at(HOUR) };
    const unrelated = { conversation_id: 'unrelated', project_id: 'old-project', title: 'Other task', last_active_at: at(HOUR) };
    h.context._appendConversationSlice([old, unrelated]);
    h.context._replaceConversationSlice([{ ...old, project_id: 'new-project' }],
      (row: any) => row.project_id === 'new-project');
    h.context.renderConversationList();
    expect(h.context.conversations).toHaveLength(2);
    expect(h.context.conversations.filter((row: any) => row.conversation_id === 'moved'))
      .toEqual([{ ...old, project_id: 'new-project' }]);
    expect(h.context.conversations).toContainEqual(unrelated);
    expect(h.container.cids().filter((cid: string) => cid === 'moved')).toEqual(['moved']);
  });

  it('lists tasks active within 24h across projects and the unprojected list, pinned first then newest', () => {
    const h = loadTodayTasksRenderer();
    h.context.conversations.push(
      { conversation_id: 'unprojected-10', title: 'u', last_active_at: at(10 * HOUR) },
      // Lives under a collapsed project: never painted in the Projects tree.
      { conversation_id: 'collapsed-project-09', title: 'c', project_id: 'p-collapsed', last_active_at: at(9 * HOUR) },
      { conversation_id: 'yesterday-2359', title: 'y', project_id: 'p1', last_active_at: at(-1) },
      { conversation_id: 'yesterday-morning', title: 'expired', project_id: 'p1', last_active_at: at(-23 * HOUR) },
      { conversation_id: 'day-before-2359', title: 'd', project_id: 'p1', last_active_at: at(-24 * HOUR - 1) },
      { conversation_id: 'pinned-08', title: 'p', project_id: 'p1', pinned_at: at(8 * HOUR), last_active_at: at(8 * HOUR) },
      { conversation_id: 'ancient', title: 'a', updated_at: '2020-01-01T00:00:00.000Z' },
    );

    h.context.renderTodayTasksSection();

    expect(h.container.cids()).toEqual(['pinned-08', 'unprojected-10', 'collapsed-project-09', 'yesterday-2359']);
    // Same row markup as every other sidebar list, no bucket header inside
    // the recent-task section.
    expect(h.container.innerHTML).toContain('class="conv-item');
    expect(h.container.innerHTML).not.toContain('conv-list-section-header');
    expect(h.container.innerHTML).not.toContain('conv-item-nested');
  });

  it.each([false, true])('updates old pinned tasks immediately on unpin and restores them on failure (%s)', async (fail) => {
    const h = loadTodayTasksRenderer();
    const oldPin = { conversation_id: 'old-pin', title: 'Pinned last month', project_id: 'p1',
      pinned_at: at(-30 * 24 * HOUR), last_active_at: at(-30 * 24 * HOUR) };
    h.context.conversations.push(oldPin,
      { conversation_id: 'recent', title: 'Recent task', last_active_at: NOW.toISOString() });
    h.context._refreshChatHeader = () => {};
    h.context.uiAlert = async () => {};
    let release!: () => void;
    h.context.apiFetch = async () => {
      await new Promise<void>(resolve => { release = resolve; });
      if (fail) throw new Error('Synthetic unpin failure');
      return { json: async () => ({ ok: true, conversation: { ...oldPin, pinned_at: undefined } }) };
    };
    h.context.renderConversationList();
    expect(h.container.cids()).toEqual(['old-pin', 'recent']);
    const unpin = h.context._toggleConversationPinned('old-pin', false);
    expect(h.container.cids()).toEqual(['recent']);
    release();
    await unpin;
    expect(h.container.cids()).toEqual(fail ? ['old-pin', 'recent'] : ['recent']);
  });

  it.each(['project', 'unprojected'])('retains pinned tasks beyond the first page when reloading the %s list', async (scope) => {
    const h = loadTodayTasksRenderer();
    const pins = Array.from({ length: 12 }, (_, i) => ({ conversation_id: `pin-${i}`, title: `Pinned task ${i}`,
      ...(scope === 'project' ? { project_id: 'p1' } : {}),
      pinned_at: at(-i * HOUR), last_active_at: at(-30 * 24 * HOUR) }));
    h.context.conversations.push(...pins);
    h.context.apiFetch = async () => ({ json: async () => ({ ok: true,
      conversations: pins.slice(0, 10), total: 12, next_offset: 10 }) });
    if (scope === 'project') await h.context.loadConversationProject('p1', { reset: true });
    else await h.context.loadUnprojectedConversations({ reset: true });
    expect(h.container.cids()).toEqual(pins.slice(0, 10).map(c => c.conversation_id));
    h.container.more.click();
    expect(h.container.cids()).toEqual(pins.map(c => c.conversation_id));
    // A full refresh remains authoritative for remotely removed or unpinned tasks.
    h.context.apiFetch = async () => ({ json: async () => ({ ok: true, conversations: [] }) });
    await h.context.loadConversations();
    expect(h.container.cids()).toEqual([]);
  });

  it('opens a task from the Recent copy like any sidebar row', () => {
    const h = loadTodayTasksRenderer();
    h.context.conversations.push(
      { conversation_id: 'c1', title: 'one', project_id: 'p1', last_active_at: at(HOUR) },
    );
    h.context.renderTodayTasksSection();

    h.container.querySelectorAll('.conv-item')[0].click();

    expect(h.navigations).toEqual([['conversation', 'c1']]);
  });

  it.each([
    ['a task from the day before yesterday', [{ conversation_id: 'day-before', title: 'd', last_active_at: at(-25 * HOUR) }]],
    ['no task at all', []],
  ])('shows the empty hint when nothing ran within 24h and the list render clears the header cue (%s)', (_name, rows) => {
    const h = loadTodayTasksRenderer();
    h.context.conversations.push(...rows);

    h.context.renderConversationList();

    expect(h.container.cids()).toEqual([]);
    expect(h.container.innerHTML).toContain('sidebar.today_empty');
    // The header dot follows the rows shown here (date rollover, last row
    // deleted); the one trailing pass of `renderConversationList` settles it.
    expect(h.unreadRefreshes()).toBe(1);
  });

  it.each(['foreground', 'reopen'])('drops expired rows on %s without changing other task lists', (trigger) => {
    const h = loadTodayTasksRenderer();
    h.context.conversations.push(
      { conversation_id: 'old-pin', title: 'Pinned task', pinned_at: at(-30 * 24 * HOUR), last_active_at: at(-30 * 24 * HOUR) },
      { conversation_id: 'expires', title: 'old', last_active_at: new Date(NOW.getTime() - 24 * HOUR).toISOString() },
      { conversation_id: 'kept', title: 'new', last_active_at: NOW.toISOString() },
    );
    h.context.renderConversationList();
    expect(h.container.cids()).toEqual(['old-pin', 'kept', 'expires']);
    const otherList = h.conversationList.innerHTML;
    h.setNow(new Date(NOW.getTime() + HOUR));
    // Merely advancing time does not trigger background work.
    expect(h.container.cids()).toEqual(['old-pin', 'kept', 'expires']);
    if (trigger === 'foreground') h.context._refreshConversationBucketsForDateChange(new h.context.Date());
    else {
      h.recentToggle.click();
      h.recentToggle.click();
    }
    expect(h.container.cids()).toEqual(['old-pin', 'kept']);
    expect(h.conversationList.innerHTML).toBe(otherList);
    expect(h.context.conversations).toHaveLength(3);
    expect(h.projectReloads).toEqual([]);
  });

  it('keeps recent row nodes and badges untouched on foreground return when no task has expired', () => {
    const h = loadTodayTasksRenderer();
    h.context.conversations.push(
      { conversation_id: 'old-pin', title: 'Pinned task without activity', pinned_at: at(-30 * 24 * HOUR) },
      { conversation_id: 'kept', title: 'new', last_active_at: NOW.toISOString() });
    h.context.renderConversationList();
    const row = h.container.rows[0];
    h.setNow(new Date(NOW.getTime() + HOUR));
    h.context._refreshConversationBucketsForDateChange(new h.context.Date());
    h.context._refreshConversationBucketsForDateChange(new h.context.Date());
    expect(h.container.rows[0]).toBe(row);
    expect(h.unreadRefreshes()).toBe(1);
  });

  it.each([true, false])('requests exactly the same 24h window at startup (shared helper: %s)', (shared) => {
    const h = loadTodayTasksRenderer();
    if (!shared) h.context.recentConversationsSince = undefined;
    const params = new URLSearchParams(h.context._startupConversationParams());
    expect(params.get('active_since')).toBe(new Date(NOW.getTime() - 24 * HOUR).toISOString());
  });

  it.each([
    ['unprojected rows', [
      { conversation_id: 'live', title: 'l', last_active_at: at(HOUR) },
      { conversation_id: 'idle', title: 'i', last_active_at: at(2 * HOUR) },
    ], false],
    ['only projected rows (no Tasks rows, no Projects section)', [
      { conversation_id: 'live', title: 'l', project_id: 'p1', last_active_at: at(HOUR) },
      { conversation_id: 'idle', title: 'i', project_id: 'p1', last_active_at: at(2 * HOUR) },
    ], false],
    ['a rename editor mounted in the Tasks list', [
      { conversation_id: 'live', title: 'l', last_active_at: at(HOUR) },
      { conversation_id: 'idle', title: 'i', last_active_at: at(2 * HOUR) },
    ], true],
  ])('paints live badges once, after the Today rows exist (%s)', (_name, rows, renameInList) => {
    const h = loadTodayTasksRenderer();
    h.context.conversations.push(...rows);
    h.context.pendingConvs.set('live', { aborted: false });
    if (renameInList) {
      h.context.renderConversationList();
      vm.runInContext('_conversationInlineRenameCid = "idle"', h.context);
      h.conversationList.renameInput = { value: 'typing…' };
    }
    const passes: string[][] = [];
    const paint = h.context._refreshAllConvBadges;
    h.context._refreshAllConvBadges = () => { passes.push(h.container.cids()); paint(); };

    h.context.renderConversationList();

    // Exactly one document-wide pass, and it runs after the Today mirror has
    // its rows, so every copy of a running task shows the live dot.
    expect(passes).toEqual([['idle', 'live']]);
    const byCid = (cid: string) => h.container.rows.find((row: any) => row.dataset.cid === cid);
    expect(byCid('live').badges()).toEqual(['conv-status-badge is-streaming']);
    expect(byCid('idle').badges()).toEqual([]);
    expect(h.unreadRefreshes()).toBe(renameInList ? 2 : 1);
  });

  it('refreshes the project list only when the deleted Recent row belonged to a project', async () => {
    const h = loadTodayTasksRenderer();
    let bindOpts: any = null;
    h.context._bindConversationSidebarItems = (_container: unknown, opts: any) => { bindOpts = opts; };
    h.context.conversations.push(
      { conversation_id: 'projected', title: 'p', project_id: 'p1', last_active_at: at(HOUR) },
      { conversation_id: 'unprojected', title: 'u', last_active_at: at(2 * HOUR) },
    );
    h.context.renderTodayTasksSection();

    expect(bindOpts?.scope).toBe('recent');
    await bindOpts.afterDelete('unprojected');
    expect(h.projectReloads).toEqual([]);
    await bindOpts.afterDelete('projected');
    expect(h.projectReloads).toEqual([true]);
  });

  it('keeps an inline rename mounted in the Today list while other refreshes run', () => {
    const h = loadTodayTasksRenderer();
    h.context.conversations.push(
      { conversation_id: 'c1', title: 'one', last_active_at: at(HOUR) },
    );
    h.context.renderTodayTasksSection();
    const before = h.container.innerHTML;
    vm.runInContext('_conversationInlineRenameCid = "c1"', h.context);
    h.container.renameInput = { value: 'typing…' };

    h.context.conversations.push(
      { conversation_id: 'c2', title: 'two', last_active_at: at(2 * HOUR) },
    );
    h.context.renderTodayTasksSection();

    expect(h.container.innerHTML).toBe(before);
    expect(vm.runInContext('_conversationInlineRenameDraft', h.context)).toBe('typing…');
  });
});
