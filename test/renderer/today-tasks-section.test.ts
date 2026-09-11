// Sidebar "Today's Tasks" aggregate. The section mirrors rows that also live
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
    renameInput: null as any,
    querySelector(selector: string) {
      return selector.startsWith('input.conv-item-title-input') ? container.renameInput : null;
    },
    querySelectorAll(selector: string) {
      return selector === '.conv-item' ? rows : [];
    },
    insertAdjacentHTML() {},
    cids() { return rows.map((row) => row.dataset.cid); },
  };
  Object.defineProperty(container, 'innerHTML', {
    get: () => html,
    set: (value: string) => {
      html = value;
      rows.length = 0;
      for (const match of value.matchAll(/\sdata-cid="([^"]+)"/g)) rows.push(makeRow(match[1]));
    },
  });
  return container;
}

function loadTodayTasksRenderer() {
  class FixedDate extends Date {
    constructor(...args: any[]) {
      if (args.length) super(...(args as [any])); else super(NOW.getTime());
    }
    static now() { return NOW.getTime(); }
  }
  const container = makeContainer();
  // The catch-all Tasks list that `renderConversationList` paints alongside
  // the Today mirror; both feed the document-wide badge queries below.
  const conversationList = makeContainer();
  const allRows = () => [...container.rows, ...conversationList.rows];
  const navigations: Array<[string, string]> = [];
  const trackedClicks: Array<[string, Record<string, unknown>]> = [];
  const projectReloads: unknown[] = [];
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
        el.remove = () => { if (el.parent) el.parent.children = el.parent.children.filter((child: any) => child !== el); };
        return el;
      },
      getElementById: (id: string) => (id === 'today-list' ? container : id === 'conversation-list' ? conversationList : null),
    },
    window: {
      addEventListener() {},
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
  return {
    context,
    container,
    conversationList,
    navigations,
    trackedClicks,
    projectReloads,
    unreadRefreshes: () => unreadRefreshes,
  };
}

describe('sidebar Today aggregate', () => {
  it('lists every task active today across projects and the unprojected list, pinned first then newest', () => {
    const h = loadTodayTasksRenderer();
    h.context.conversations.push(
      { conversation_id: 'unprojected-10', title: 'u', last_active_at: at(10 * HOUR) },
      // Lives under a collapsed project: never painted in the Projects tree.
      { conversation_id: 'collapsed-project-09', title: 'c', project_id: 'p-collapsed', last_active_at: at(9 * HOUR) },
      { conversation_id: 'yesterday-2359', title: 'y', project_id: 'p1', last_active_at: at(-1) },
      { conversation_id: 'pinned-08', title: 'p', project_id: 'p1', pinned_at: at(8 * HOUR), last_active_at: at(8 * HOUR) },
      { conversation_id: 'ancient', title: 'a', updated_at: '2020-01-01T00:00:00.000Z' },
    );

    h.context.renderTodayTasksSection();

    expect(h.container.cids()).toEqual(['pinned-08', 'unprojected-10', 'collapsed-project-09']);
    // Same row markup as every other sidebar list, no bucket header inside
    // an all-today section.
    expect(h.container.innerHTML).toContain('class="conv-item');
    expect(h.container.innerHTML).not.toContain('conv-list-section-header');
    expect(h.container.innerHTML).not.toContain('conv-item-nested');
  });

  it('opens a task from the Today copy like any sidebar row', () => {
    const h = loadTodayTasksRenderer();
    h.context.conversations.push(
      { conversation_id: 'c1', title: 'one', project_id: 'p1', last_active_at: at(HOUR) },
    );
    h.context.renderTodayTasksSection();

    h.container.querySelectorAll('.conv-item')[0].click();

    expect(h.navigations).toEqual([['conversation', 'c1']]);
  });

  it.each([
    ['a task from yesterday', [{ conversation_id: 'yesterday', title: 'y', last_active_at: at(-HOUR) }]],
    ['no task at all', []],
  ])('shows the empty hint when nothing ran today and the list render clears the header cue (%s)', (_name, rows) => {
    const h = loadTodayTasksRenderer();
    h.context.conversations.push(...rows);

    h.context.renderConversationList();

    expect(h.container.cids()).toEqual([]);
    expect(h.container.innerHTML).toContain('sidebar.today_empty');
    // The header dot follows the rows shown here (date rollover, last row
    // deleted); the one trailing pass of `renderConversationList` settles it.
    expect(h.unreadRefreshes()).toBe(1);
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

  it('refreshes the project list only when the deleted Today row belonged to a project', async () => {
    const h = loadTodayTasksRenderer();
    let bindOpts: any = null;
    h.context._bindConversationSidebarItems = (_container: unknown, opts: any) => { bindOpts = opts; };
    h.context.conversations.push(
      { conversation_id: 'projected', title: 'p', project_id: 'p1', last_active_at: at(HOUR) },
      { conversation_id: 'unprojected', title: 'u', last_active_at: at(2 * HOUR) },
    );
    h.context.renderTodayTasksSection();

    expect(bindOpts?.scope).toBe('today');
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
