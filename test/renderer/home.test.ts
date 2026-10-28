// Commander home (modules/home.js): which state the New task view shows, how
// open to-dos and unopened finished runs are grouped, folded and opened, and
// the shortcuts and Connectors navigation. jsdom isn't installed, so — like the other
// renderer tests — the classic script runs in a vm sandbox with a minimal DOM
// shim and the real zh copy, and assertions read the generated HTML.

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const R = path.join(__dirname, '../../src/renderer');
const homeSource = fs.readFileSync(path.join(R, 'modules/home.js'), 'utf8');
const iconsContext: any = { window: {}, document: undefined };
vm.createContext(iconsContext);
vm.runInContext(fs.readFileSync(path.join(R, 'modules/icons.js'), 'utf8'), iconsContext);
const uiIconHtml = iconsContext.window.uiIconHtml;
const zh = JSON.parse(fs.readFileSync(path.join(R, 'locales/zh.json'), 'utf8')) as Record<string, string>;

function t(key: string, vars?: Record<string, unknown>): string {
  let s = Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key;
  if (vars) for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
  return s;
}

function escapeHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c] || c));
}

function element(extra: Record<string, any> = {}) {
  const listeners: Record<string, Array<(event: any) => unknown>> = {};
  const attrs: Record<string, string> = {};
  return {
    dataset: {} as Record<string, string>,
    hidden: false,
    innerHTML: '',
    textContent: '',
    focusCount: 0,
    addEventListener(type: string, fn: (event: any) => unknown) { (listeners[type] ||= []).push(fn); },
    setAttribute(name: string, value: unknown) { attrs[name] = String(value); },
    getAttribute(name: string) { return name in attrs ? attrs[name] : null; },
    focus() { this.focusCount += 1; },
    getBoundingClientRect: () => ({ left: 100, top: 600, bottom: 628 }),
    fire(type: string, event: any) { return (listeners[type] || []).map((fn) => fn(event)); },
    ...extra,
  };
}

/** An event whose target answers `closest()` for the given selectors. */
function click(matches: Record<string, any>) {
  return { target: { closest: (selector: string) => matches[selector] || null } };
}

const MINUTE = 60 * 1000;

function loadHome(options: {
  todos?: { tasks: any[]; total: number };
  todosError?: boolean;
  unread?: any[];
  conversations?: any[];
  lookup?: (cids: string[]) => any;
  connectors?: any[];
} = {}) {
  const els: Record<string, any> = {
    'panel-new-chat': element({ dataset: { homeState: 'pending' } }),
    'home-groups': element(),
    'home-explore-context': element(),
  };
  const views: any[][] = [];
  const invokes: Array<[string, any]> = [];
  const forgotten: string[] = [];
  const menus: any[][] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const context: any = {
    console,
    Promise,
    Date,
    Intl,
    currentView: 'new-chat',
    conversations: options.conversations || [],
    _projectsCache: [{ project_id: 'p1', name: '增长' }],
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    escapeHtml,
    t,
    getLang: () => 'zh',
    getLocaleMeta: () => ({ intlLocale: 'zh-CN' }),
    performance: { now: () => 0 },
    setView: (...args: any[]) => { views.push(args); },
    _forgetUnreadConversation: (cid: string) => { forgotten.push(cid); },
    loadRendererFeature: vi.fn(async () => {}),
    focusTodo: vi.fn(),
    showContextMenu: (_anchor: any, items: any[]) => { menus.push(items); },
    document: { getElementById: (id: string) => els[id] || null },
  };
  context.window = {
    uiIconHtml,
    innerHeight: 720,
    addEventListener() {},
    TaskUnread: { list: () => options.unread || [] },
    loadConnectorNavTarget: async (id: string) => ({ name: { feishu: '飞书', dingtalk: '钉钉', gmail: 'Gmail', 'm365-mail': 'Microsoft 365 邮箱' }[id] || id }),
    openConnectorSetupById: vi.fn(async () => true),
    orkas: {
      invoke: async (channel: string, payload: any) => {
        invokes.push([channel, payload]);
        if (channel === 'projects.tasks.listOpen') {
          if (options.todosError) throw new Error('read failed');
          return { ok: true, ...(options.todos || { tasks: [], total: 0 }) };
        }
        if (channel === 'conversations.getMany') {
          return options.lookup ? options.lookup(payload.cids) : { conversations: [], missing: [] };
        }
        if (channel === 'connectors.list') return { ok: true, instances: options.connectors || [] };
        throw new Error(`unexpected channel ${channel}`);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(homeSource, context);
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    context, els, views, invokes, forgotten, menus, timers, settle,
    state: () => els['panel-new-chat'].dataset.homeState,
    html: () => els['home-groups'].innerHTML as string,
    data: () => JSON.parse(vm.runInContext('JSON.stringify(_homeData)', context)),
  };
}

function run(cid: string, status: string, minutesAgo: number, entryPoint?: string) {
  return {
    cid, projectId: '', finishedAt: Date.now() - minutesAgo * MINUTE, status,
    ...(entryPoint ? { entryPoint } : {}),
  };
}

describe('Commander home states', () => {
  it('shows the empty state when nothing is open or unopened', async () => {
    const h = loadHome();
    h.context.homeOnEnter();
    await h.settle();

    expect(h.state()).toBe('empty');
    expect(h.html()).toBe('');
    // The context line carries the Connectors link inside the translated sentence.
    expect(h.els['home-explore-context'].innerHTML).toBe(
      '添加资料或<button type="button" class="home-connect-link" data-home-connect="1">连接邮箱/店铺/办公软件等</button>，让 Orkas 更了解你。从你愿意分享的内容开始。',
    );
  });

  it('shows a dated to-do\'s day on its row and flags one past its day while it is open', async () => {
    const pad = (value: number) => String(value).padStart(2, '0');
    const day = (offset: number) => {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };
    const h = loadHome({
      todos: {
        total: 3,
        tasks: [
          { id: 't_due', project_id: '', project_name: '', status: 'todo', content: '发上线邮件', due_at: day(2) },
          { id: 't_late', project_id: '', project_name: '', status: 'todo', content: '交周报', due_at: day(-2) },
          { id: 't_plain', project_id: '', project_name: '', status: 'todo', content: '整理访谈' },
        ],
      },
    });
    h.context.homeOnEnter();
    await h.settle();
    const html = h.html();
    const metaOf = (title: string) => new RegExp(`${title}</span><span class="home-row-meta"><span class="home-row-source">[^<]*</span>([^<]*)`).exec(html)?.[1] || '';
    expect(metaOf('发上线邮件')).toMatch(/^[^·]+ · .+ 到期$/);
    expect(metaOf('交周报')).toMatch(/^[^·]+ · 已逾期（.+）$/);
    expect(metaOf('整理访谈')).not.toMatch(/到期|逾期/);
  });

  it('groups open to-dos, automation runs and other finished tasks in that order', async () => {
    const h = loadHome({
      todos: {
        total: 5,
        tasks: [
          { id: 't1', project_id: 'p1', project_name: '增长', status: 'review', content: '确认定价方案\n附件见对话', updated_at: new Date(Date.now() - 5 * MINUTE).toISOString() },
          { id: 't2', project_id: '', project_name: '', status: 'todo', content: '整理客户访谈', updated_at: new Date(Date.now() - 3 * 60 * MINUTE).toISOString() },
          { id: 't3', project_id: '', project_name: '', status: 'progress', content: '周报', updated_at: '' },
          { id: 't4', project_id: '', status: 'todo', content: 'Follow-up 4' },
          { id: 't5', project_id: '', status: 'todo', content: 'Follow-up 5' },
        ],
      },
      unread: [
        run('auto-new', 'failed', 2, 'automation'),
        // A reply the user wrote inside an automation run is still that run.
        run('auto-reply', 'completed', 10, 'conversation'),
        run('project-task', 'waiting_input', 20, 'chat_send'),
        run('legacy', '', 30),
        run('deleted-elsewhere', 'completed', 40, 'chat_send'),
      ],
      conversations: [
        { conversation_id: 'auto-new', title: '每周竞品简报', project_id: '', origin_auto_task_id: 'a1' },
        { conversation_id: 'auto-reply', title: '每日销售摘要', project_id: '', origin_auto_task_id: 'a2' },
        { conversation_id: 'project-task', title: '竞品对比', project_id: 'p1' },
      ],
      lookup: (cids) => ({
        conversations: cids.includes('legacy')
          ? [{ conversation_id: 'legacy', title: '', project_id: '', origin_auto_task_id: '' }]
          : [],
        missing: cids.filter((cid) => cid === 'deleted-elsewhere'),
      }),
    });
    h.context.homeOnEnter();
    await h.settle();

    expect(h.state()).toBe('populated');
    // Only conversations missing from the sidebar cache are looked up.
    expect(h.invokes.filter(([channel]) => channel === 'conversations.getMany'))
      .toEqual([['conversations.getMany', { cids: ['legacy', 'deleted-elsewhere'] }]]);
    expect(h.forgotten).toEqual(['deleted-elsewhere']);

    const html = h.html();
    const order = [...html.matchAll(/data-section="(\w+)"/g)].map((match) => match[1]);
    expect(order).toEqual(['todos', 'automations', 'tasks']);
    expect(html).toContain('重要待办<span class="home-group-count">5</span>');
    expect(html).toContain('自动化待处理<span class="home-group-count">2</span>');
    expect(html).toContain('任务待你处理<span class="home-group-count">2</span>');
    // To-do rows share the sidebar's To-do icon, with status still shown in words.
    const sidebarTodoIcon = fs.readFileSync(path.join(R, 'index.html'), 'utf8')
      .match(/id="todos-btn"[^>]*><span data-ui-icon="([^"]+)"/)?.[1];
    expect(sidebarTodoIcon).toBe('clipboard-list');
    const todoIcon = uiIconHtml(sidebarTodoIcon, 'home-row-status-icon');
    expect(html).toContain(`<span class="home-row-status is-review" aria-hidden="true">${todoIcon}</span><span class="home-row-main"><span class="home-row-title">确认定价方案</span>`);
    expect(html).toContain('<span class="home-row-source">增长 · 待办</span>待确认 · 5分钟前更新');
    expect(html).toContain(`<span class="home-row-status is-todo" aria-hidden="true">${todoIcon}</span><span class="home-row-main"><span class="home-row-title">整理客户访谈</span>`);
    expect(html).toContain('<span class="home-row-source">全局待办</span>待处理 · 3小时前更新');
    expect(html).toContain('<span class="home-row-source">全局待办</span>处理中</span>');
    expect(html).toContain(`<span class="home-row-status is-progress" aria-hidden="true">${todoIcon}</span>`);
    // More to-dos than rows: the link to the full To-dos page sits in the group header, not below the list.
    expect(html).toContain('重要待办<span class="home-group-count">5</span></h2><button type="button" class="home-text-btn" data-home-action="more_todos" aria-describedby="home-group-todos-title">查看全部 →</button></div>');
    expect(html).not.toContain('home-group-more" data-home-action="more_todos"');
    expect(html).toContain('data-home-toggle="todos"');
    // Run rows: result-specific glyph and action, automation source, fallbacks for old records.
    expect(html).toMatch(/data-home-cid="auto-new"[^>]*data-home-status="failed"[^>]*><span class="home-row-status is-failed"/);
    expect(html).toMatch(/data-home-cid="auto-reply"[^>]*><span class="home-row-status is-completed"/);
    expect(html).toMatch(/data-home-cid="project-task"[^>]*><span class="home-row-status is-waiting_input"/);
    expect(html).toMatch(/data-home-cid="legacy"[^>]*><span class="home-row-status is-completed"/);
    expect(html).toContain(`<span class="home-row-status is-failed" aria-hidden="true">${uiIconHtml('x-circle', 'home-row-status-icon')}</span>`);
    expect(html).toContain('<span class="home-row-title">每周竞品简报</span><span class="home-row-meta"><span class="home-row-source">自动化</span>失败 · 2分钟前</span></span><span class="home-row-action">查看原因');
    expect(html).toContain('<span class="home-row-source">增长 · 项目任务</span>等你输入 · 20分钟前</span></span><span class="home-row-action">去回复');
    expect(html).toContain('<span class="home-row-title">未命名任务</span><span class="home-row-meta"><span class="home-row-source">全局任务</span>已完成 · 30分钟前');
    expect(html).not.toContain('deleted-elsewhere');
    expect(html).toContain('全部自动化 →');
  });

  it.each(['automations', 'tasks'])('presents missing %s outcomes as completed without overwriting known outcomes or stored records', async (section) => {
    const outcomes = [
      [undefined, 'completed', 'check-circle', '已完成', '查看结果'],
      ['failed', 'failed', 'x-circle', '失败', '查看原因'],
      ['waiting_input', 'waiting_input', 'message-circle-more', '等你输入', '去回复'],
      ['stopped', 'stopped', 'stop', '已停止', '查看结果'],
      ['completed', 'completed', 'check-circle', '已完成', '查看结果'],
      ['', 'completed', 'check-circle', '已完成', '查看结果'],
      ['unknown', 'completed', 'check-circle', '已完成', '查看结果'],
    ];
    const unread = outcomes.map(([status], i) => ({
      cid: `result-${i}`, finishedAt: Date.now() - i * MINUTE,
      ...(status === undefined ? {} : { status }),
      entryPoint: section === 'automations' ? 'automation' : 'chat_send',
    }));
    const h = loadHome({
      unread,
      // No message bodies or execution results exist in this fixture.
      conversations: unread.map(({ cid }) => ({ conversation_id: cid, title: cid })),
    });
    h.context.homeOnEnter();
    await h.settle();
    const html = h.html();
    outcomes.forEach(([original, displayed, icon, label, action], i) => {
      const row = html.match(new RegExp(`<button type="button" class="home-row"[^>]*data-home-cid="result-${i}"[^>]*>.*?<\\/button>`))?.[0] || '';
      expect(row).toContain(`class="home-row-status is-${displayed}" aria-hidden="true">${uiIconHtml(icon, 'home-row-status-icon')}`);
      expect(row).toContain(`</span>${label} · `);
      expect(row).toContain(`<span class="home-row-action">${action}`);
      expect(row).toContain(`data-home-status="${original || 'unknown'}"`);
    });
    expect(html).not.toContain('有新结果');
    expect(h.data()[section].map((row: any) => row.status)).toEqual(outcomes.map(([status]) => status || ''));
    expect(h.invokes.map(([channel]) => channel)).toEqual(['projects.tasks.listOpen']);
  });

  it.each([
    ['todos', 11, '重要待办'],
    ['todos', 46, '重要待办'],
    ['automations', 46, '自动化待处理'],
    ['tasks', 25, '任务待你处理'],
  ] as const)('expands every remaining %s row and keeps the displayed counts accurate (%i total)', async (section, total, title) => {
    const unread = section === 'todos' ? [] : Array.from({ length: total }, (_, i) => run(`task-${i}`, 'completed', i + 1, section === 'automations' ? 'automation' : 'chat_send'));
    const todoRows = Array.from({ length: total }, (_, i) => ({ id: `todo-${i}`, content: `To-do ${i}`, status: 'todo' }));
    const h = loadHome({
      ...(section === 'todos' ? { todos: { tasks: todoRows, total } } : {}),
      unread,
      conversations: unread.map((record) => ({ conversation_id: record.cid, title: record.cid, project_id: '' })),
    });
    h.context.homeOnEnter();
    await h.settle();

    const html = h.html();
    const visible = html.split('<div class="home-list-fold"')[0];
    const fold = html.match(new RegExp(`<div class="home-list-fold" id="home-fold-${section}" hidden>(.*?)<\\/div>`))?.[1] || '';
    expect([...visible.matchAll(/data-home-position="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([1, 2, 3]);
    expect([...fold.matchAll(/data-home-position="(\d+)"/g)].map((m) => Number(m[1])))
      .toEqual(Array.from({ length: total - 3 }, (_, i) => i + 4));
    expect(html).toContain(`aria-expanded="false">展开其余 ${total - 3} 条</button>`);
    expect(html).toContain(`${title}<span class="home-group-count">${total}</span>`);

    const foldEl = element({ hidden: true });
    h.els[`home-fold-${section}`] = foldEl;
    const toggle = element({ dataset: { homeToggle: section, homeFolded: String(total - 3) } });
    h.els['home-groups'].fire('click', click({ '[data-home-toggle]': toggle }));
    expect(foldEl.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('收起');
    // A refresh during the visit keeps the group unfolded.
    expect(vm.runInContext(`_homeSectionHtml("${section}")`, h.context)).toContain(`id="home-fold-${section}">`);

    h.els['home-groups'].fire('click', click({ '[data-home-toggle]': toggle }));
    expect(foldEl.hidden).toBe(true);
    expect(toggle.textContent).toBe(`展开其余 ${total - 3} 条`);
  });

  it.each(['todos', 'automations', 'tasks'])('omits the %s expand control when all three rows fit', async (section) => {
    const h = loadHome({
      ...(section === 'todos'
        ? { todos: { total: 3, tasks: Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, content: `To-do ${i}` })) } }
        : { unread: Array.from({ length: 3 }, (_, i) => run(`c${i}`, 'completed', i, section === 'automations' ? 'automation' : 'chat_send')) }),
    });
    h.context.homeOnEnter();
    await h.settle();
    expect(h.html()).not.toContain('data-home-toggle');
    expect([...h.html().matchAll(/data-home-position=/g)]).toHaveLength(3);
  });

  it('opens a run in its conversation and a to-do on the To-dos page', async () => {
    const h = loadHome({
      todos: { total: 1, tasks: [{ id: 't1', project_id: 'p1', project_name: '增长', status: 'todo', content: 'A' }] },
      unread: [run('auto-new', 'failed', 2, 'automation')],
      conversations: [{ conversation_id: 'auto-new', title: '简报', project_id: '', origin_auto_task_id: 'a1' }],
    });
    h.context.homeOnEnter();
    await h.settle();
    // Every open to-do is already listed, so there is no link to more of them.
    expect(h.html()).not.toContain('data-home-action="more_todos"');

    h.els['home-groups'].fire('click', click({
      '.home-row': { dataset: { homeCid: 'auto-new', homeSection: 'automations', homeStatus: 'failed', homePosition: '1' } },
    }));
    expect(h.views).toEqual([['conversation', 'auto-new', { entryPoint: 'home' }]]);
    // Gone right away, so coming back never shows the run just opened.
    expect(h.data().automations).toEqual([]);

    h.els['home-groups'].fire('click', click({
      '.home-row': { dataset: { homeTodo: 't1', homePid: 'p1', homeStatus: 'todo', homePosition: '1' } },
    }));
    await h.settle();
    expect(h.context.loadRendererFeature).toHaveBeenCalledWith('project');
    expect(h.context.focusTodo).toHaveBeenCalledWith('p1', 't1', { entryPoint: 'home' });

    h.els['home-groups'].fire('click', click({ '[data-home-action]': { dataset: { homeAction: 'all_automations' } } }));
    h.els['home-groups'].fire('click', click({ '[data-home-action]': { dataset: { homeAction: 'more_todos' } } }));
    expect(h.views.slice(1)).toEqual([['auto', null, { entryPoint: 'home' }], ['todos', null, { entryPoint: 'home' }]]);
  });

  it('opens linked global and project to-dos on their cards even when the conversation exists or is gone', async () => {
    const h = loadHome({
      todos: { total: 2, tasks: [
        { id: 't-saved', project_id: '', status: 'todo', content: 'Write chapter 3', origin_cid: 'conv-origin' },
        { id: 't-gone', project_id: 'p1', status: 'progress', content: 'Deleted thread', origin_cid: 'conv-deleted' },
      ] },
      conversations: [{ conversation_id: 'conv-origin', title: 'Novel', project_id: '' }],
      lookup: (cids: string[]) => ({ conversations: [], missing: cids }),
    });
    h.context.homeOnEnter();
    await h.settle();
    const readsBeforeOpen = h.invokes.length;
    for (const [index, task] of h.data().todos.entries()) {
      h.els['home-groups'].fire('click', click({
        '.home-row': { dataset: { homeTodo: task.id, homePid: task.project_id, homeStatus: task.status,
          homePosition: String(index + 1), homeOriginCid: task.origin_cid } },
      }));
      await h.settle();
      expect(h.context.focusTodo).toHaveBeenNthCalledWith(index + 1, task.project_id, task.id, { entryPoint: 'home' });
    }
    expect(h.views).toEqual([]);
    // Opening a to-do must not depend on reading its execution conversation.
    expect(h.invokes.slice(readsBeforeOpen)).toEqual([]);
  });

  it.each(['unavailable', 'failed'])('opens the To-dos page when its card locator is %s', async state => {
    const h = loadHome();
    h.context.focusTodo = undefined;
    if (state === 'failed') h.context.loadRendererFeature.mockRejectedValueOnce(new Error('controlled feature load failure'));
    else h.context.loadRendererFeature = undefined;
    await h.context._homeOpenTodo({ dataset: { homeTodo: 't_saved', homePid: 'p1', homeOriginCid: 'linked-chat' } });
    expect(h.views).toEqual([['todos', null, { entryPoint: 'home' }]]);
    expect(h.invokes).toEqual([]);
  });

  it('hides only the group whose lookup failed', async () => {
    const h = loadHome({
      todosError: true,
      unread: [run('task-a', 'completed', 1, 'chat_send')],
      conversations: [{ conversation_id: 'task-a', title: '报告', project_id: '' }],
    });
    h.context.homeOnEnter();
    await h.settle();

    expect(h.state()).toBe('populated');
    expect(h.html()).not.toContain('data-section="todos"');
    expect(h.html()).toContain('data-section="tasks"');
  });

  it('falls back to the empty layout when the first lookup is slow, then paints what arrives', async () => {
    let release: (value: any) => void = () => {};
    const h = loadHome();
    h.context.window.orkas.invoke = () => new Promise((resolve) => { release = resolve; });
    h.context.homeOnEnter();
    expect(h.state()).toBe('pending');
    const fallback = h.timers.find((timer) => timer.ms === 1500);
    fallback!.fn();
    expect(h.state()).toBe('empty');

    release({ ok: true, tasks: [{ id: 't1', project_id: '', status: 'todo', content: '迟到的待办' }], total: 1 });
    await h.settle();
    expect(h.state()).toBe('populated');
    expect(h.html()).toContain('迟到的待办');
  });

  it('refreshes while the home is showing and leaves it to the next visit otherwise', async () => {
    const h = loadHome();
    h.context.homeOnEnter();
    await h.settle();
    const lookups = () => h.invokes.filter(([channel]) => channel === 'projects.tasks.listOpen').length;
    expect(lookups()).toBe(1);

    h.context.homeRefresh();
    const debounce = h.timers.filter((timer) => timer.ms === 500);
    expect(debounce).toHaveLength(1);
    debounce[0].fn();
    await h.settle();
    expect(lookups()).toBe(2);

    h.context.currentView = 'conversation';
    h.context.homeRefresh();
    expect(h.timers.filter((timer) => timer.ms === 500)).toHaveLength(1);
  });
});

describe('Commander home keyboard continuity during refresh', () => {
  it.each(['homeToggle', 'homeAction', 'homeTodo', 'homeCid'])('keeps the focused %s control usable when new work arrives', async (key) => {
    const h = loadHome();
    const document = h.context.document;
    const oldButton = element({ dataset: { [key]: 'selected', homePid: 'p1' } });
    const replacement = element({ dataset: { [key]: 'selected', homePid: 'p1' },
      focus: vi.fn(() => { document.activeElement = replacement; }) });
    const unrelated = element({ dataset: { [key]: 'other', homePid: 'p1' } });
    const otherProject = element({ dataset: { [key]: 'selected', homePid: 'p2' } });
    const host = h.els['home-groups'];
    host.contains = (node: unknown) => node === oldButton;
    host.querySelectorAll = () => [unrelated, otherProject, replacement];
    document.activeElement = oldButton;
    Object.defineProperty(host, 'innerHTML', { set() { document.activeElement = null; } });

    h.context.homeRefresh();
    h.timers.find((timer) => timer.ms === 500)!.fn();
    await h.settle();

    expect(document.activeElement).toBe(replacement);
    expect(replacement.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(unrelated.focusCount).toBe(0);
    expect(otherProject.focusCount).toBe(0);
  });

  it.each(['outside', 'removed'])('does not move focus to another control when the focused control is %s', async (location) => {
    const h = loadHome();
    const original = element({ dataset: { homeToggle: 'todos' } });
    const other = element({ dataset: { homeToggle: 'tasks' } });
    h.context.document.activeElement = original;
    h.els['home-groups'].contains = () => location !== 'outside';
    h.els['home-groups'].querySelectorAll = () => [other];
    h.context.homeRefresh();
    h.timers.find((timer) => timer.ms === 500)!.fn();
    await h.settle();
    expect(other.focusCount).toBe(0);
    expect(original.focusCount).toBe(0);
  });
});

describe('Commander home Connectors link', () => {
  it('opens Connectors directly without a chooser or starting setup', async () => {
    const h = loadHome();
    h.context.homeOnEnter();
    await h.settle();
    const beforeClick = h.invokes.length;

    h.els['home-explore-context'].fire('click', click({}));
    expect(h.views).toEqual([]);
    h.els['home-explore-context'].fire('click', click({ '[data-home-connect]': element() }));
    expect(h.views).toEqual([['connectors', null, { entryPoint: 'home' }]]);
    await h.settle();
    expect(h.invokes).toHaveLength(beforeClick);
    expect(h.menus).toEqual([]);
    expect(h.context.window.openConnectorSetupById).not.toHaveBeenCalled();
  });
});
