import { composerAccessorSource } from './composer-test-source';
const attachOrderSource = ts.createSourceFile('conversation.js', fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8'), ts.ScriptTarget.Latest, true);
const attachmentOrderFunction = attachOrderSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === '_chatAttachOrderItems')!.getText(attachOrderSource);
import { conversationCacheSource } from './conversation-cache-test-source';
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';

const rendererDir = path.join(__dirname, '../../src/renderer');
const conversation = ts.createSourceFile('conversation.js', fs.readFileSync(path.join(rendererDir, 'modules/conversation.js'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const sendNames = new Set(['_composerSendIsEmpty', '_resolvedMentionSpans', '_quotedLineRanges', '_buildMentionRe', '_escapeForRegex',
  '_COMMANDER', '_composerAgentScopes', '_MENTION_FALLBACK_CLASS']);
const sendSource = conversation.statements.filter(node =>
  ts.isFunctionDeclaration(node) ? sendNames.has(node.name?.text || '') : ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && sendNames.has(declaration.name.text)))
  .map(node => node.getText(conversation)).join('\n');
const markdown = ts.createSourceFile('strip-structural-blocks.js', fs.readFileSync(path.join(rendererDir, 'modules/strip-structural-blocks.js'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const markdownSource = markdown.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === '_splitMarkdownProseCode')
  .map(node => node.getText(markdown)).join('\n');
const source = [conversationCacheSource, sendSource, markdownSource, fs.readFileSync(path.join(rendererDir, 'modules/project-detail.js'), 'utf8')].join('\n');

// The editor uploads through the shared renderer base64 helper (utils.js).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rendererUtils = require('../../src/renderer/modules/utils.js');

function cardNodes(node: any): any[] {
  return [node, ...(node.children || []).flatMap(cardNodes)];
}

describe('project to-do controls', () => {
  it.each(['same board', 'account', 'project', 'grouping'])('keeps reading positions only within the mounted scope: %s', (change) => {
    const element = (): any => ({
      children: [], dataset: {}, scrollTop: 0, scrollLeft: 0,
      appendChild(child: any) { child.parentElement = this; this.children.push(child); },
      setAttribute() {}, addEventListener() {},
      querySelectorAll(selector: string) {
        return this.children.flatMap((child: any) => [
          ...(child.className?.split(' ').includes(selector.slice(1)) ? [child] : []),
          ...child.querySelectorAll(selector),
        ]);
      },
    });
    const context = vm.createContext({
      currentUserId: 'me', createLogger: () => ({ warn() {} }),
      document: { readyState: 'loading', addEventListener() {}, createElement: element },
      window: { addEventListener() {} }, t: (key: string) => key, escapeHtml: String,
    });
    vm.runInContext(source, context);
    const host = element();
    const board = context._renderTodoBoard([], {}, 'project:one');
    host.appendChild(board);
    host.scrollTop = 120;
    board.scrollLeft = 60;
    const bodies = board.querySelectorAll('.todo-column-body');
    bodies[0].scrollTop = 300;
    bodies[1].scrollTop = 80;
    const snapshot = context._captureTodoScroll(host);
    if (change === 'account') context.currentUserId = 'other';
    const scope = change === 'project' ? 'project:two' : change === 'grouping' ? 'global:status' : 'project:one';
    const next = context._renderTodoBoard([], {}, scope);
    host.children = [];
    host.scrollTop = 0;
    host.appendChild(next);
    // Column order is irrelevant to status-specific reading positions.
    next.children.reverse();
    context._restoreTodoScroll(host, snapshot);
    const retained = change === 'same board';
    expect(host.scrollTop).toBe(retained ? 120 : 0);
    expect(next.scrollLeft).toBe(retained ? 60 : 0);
    const columnTops = Object.fromEntries(next.querySelectorAll('.todo-column-body')
      .map((body: any) => [body.parentElement.dataset.status, body.scrollTop]));
    expect(columnTops).toEqual({ todo: retained ? 300 : 0, progress: retained ? 80 : 0, review: 0, done: 0 });
  });

  it.each(['private', 'global'])('discloses %s card text without editing or writing, retaining state only in its account and scope', (kind) => {
    const element = (tag: string): any => {
      const node: any = { tag, children: [], dataset: {}, className: '', attributes: {},
        appendChild(child: any) { this.children.push(child); return child; },
        setAttribute(key: string, value: string) { this.attributes[key] = value; },
        querySelector() { return this.children.find((child: any) => child.className === 'project-todo-title'); },
      };
      node.classList = {
        add(value: string) { node.className += ` ${value}`; },
        toggle(value: string, enabled: boolean) {
          const classes = node.className.split(' ').filter((name: string) => name !== value);
          if (enabled) classes.push(value);
          node.className = classes.join(' ');
        },
      };
      return node;
    };
    let click!: (event: any) => void;
    const invoke = vi.fn();
    const editor = vi.fn();
    const context = vm.createContext({
      currentUserId: 'me', createLogger: () => ({ warn() {} }),
      document: { readyState: 'loading', addEventListener() {}, createElement: element },
      window: { addEventListener() {}, orkas: { invoke } },
      t: (key: string) => key, escapeHtml: (value: unknown) => String(value),
    });
    vm.runInContext(source, context);
    context._openProjectTodoEditor = editor;
    const task = Object.freeze({ id: 'same_id', content: 'Title\n<literal> & Full content',
      status: 'todo', assignee_uid: 'other' });
    const scope = { pid: kind === 'global' ? '' : 'p_one', global: kind === 'global', tasks: [task],
      project: {}, agents: [], members: [] };
    const row = context._renderTodoCard(task, scope);
    const title = row.querySelector('.project-todo-title');
    expect(title.attributes['aria-expanded']).toBe('false');
    expect(title.textContent).toBe(task.content);
    context._bindTodoListActions({ dataset: {}, addEventListener(_type: string, handler: any) { click = handler; } }, () => scope);
    const target = (action?: string, control = false) => ({ closest(selector: string) {
      if (selector === '.project-todo-item') return row;
      if (action && selector === `[data-action="${action}"]`) return title;
      if (control && selector.startsWith('button,')) return title;
      return null;
    } });
    click({ target: target(title.dataset.action, true) });
    expect(title.attributes['aria-expanded']).toBe('true');
    expect(row.className).toContain('is-expanded');
    expect(editor).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(context._renderTodoCard(task, scope).querySelector().attributes['aria-expanded']).toBe('true');
    expect(context._renderTodoCard(task, { ...scope, pid: 'p_other' }).querySelector().attributes['aria-expanded']).toBe('false');
    expect(context._renderTodoCard(task, { ...scope, global: !scope.global }).querySelector().attributes['aria-expanded']).toBe('false');
    context.currentUserId = 'another_account';
    expect(context._renderTodoCard(task, scope).querySelector().attributes['aria-expanded']).toBe('false');
    context.currentUserId = 'me';
    // An interactive child outside disclosure must not toggle it.
    click({ target: target(undefined, true) });
    expect(title.attributes['aria-expanded']).toBe('true');
    // The next click on plain card padding collapses it.
    click({ target: target() });
    expect(title.attributes['aria-expanded']).toBe('false');
    expect(row.className).not.toContain('is-expanded');
    expect(context._renderTodoCard(task, scope).querySelector().attributes['aria-expanded']).toBe('false');
    expect(task).toEqual({ id: 'same_id', content: 'Title\n<literal> & Full content', status: 'todo', assignee_uid: 'other' });
    expect(editor).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('marks collapsed lanes, so the project board can narrow them, and keeps the choice per board', () => {
    const element = (tag: string): any => {
      const node: any = { tag, children: [] as any[], dataset: {}, attributes: {} as Record<string, string>,
        handlers: {} as Record<string, () => void>, className: '', hidden: false, innerHTML: '', textContent: '',
        appendChild(child: any) { this.children.push(child); return child; },
        setAttribute(key: string, value: string) { this.attributes[key] = value; },
        addEventListener(key: string, handler: () => void) { this.handlers[key] = handler; } };
      node.classList = { toggle(name: string, enabled: boolean) {
        const names = node.className.split(' ').filter((value: string) => value && value !== name);
        if (enabled) names.push(name);
        node.className = names.join(' ');
      } };
      return node;
    };
    const context = vm.createContext({
      currentUserId: 'me', createLogger: () => ({ warn() {} }),
      document: { readyState: 'loading', addEventListener() {}, createElement: element },
      window: { addEventListener() {} }, t: (key: string) => key, escapeHtml: String,
    });
    vm.runInContext(source, context);
    const lanes = (board: any) => Object.fromEntries(board.children.map((column: any) => [column.dataset.status, column]));
    const collapsed = (board: Record<string, any>) => Object.entries(board)
      .filter(([, column]) => column.className.split(' ').includes('is-collapsed')).map(([status]) => status);
    const toggle = (column: any) => column.children[0].children[0];
    let board = lanes(context._renderTodoBoard([], {}, 'project:one'));
    expect(collapsed(board)).toEqual(['done']);
    expect(toggle(board.done).innerHTML).toContain('<span class="todo-collapse-label">project.todo.status_done</span>');
    toggle(board.done).handlers.click();
    expect(collapsed(board)).toEqual([]);
    expect(board.done.children[1].hidden).toBe(false);
    expect(toggle(board.done).attributes['aria-expanded']).toBe('true');
    toggle(board.todo).handlers.click();
    expect(collapsed(board)).toEqual(['todo']);
    expect(board.todo.children[1].hidden).toBe(true);
    // A repaint keeps the choice for this board only.
    board = lanes(context._renderTodoBoard([], {}, 'project:one'));
    expect(collapsed(board)).toEqual(['todo']);
    expect(collapsed(lanes(context._renderTodoBoard([], {}, 'project:two')))).toEqual(['done']);
  });

  it.each(['todo', 'progress', 'review', 'done'])('shows the same %s status and footer controls on project and account cards', (stage) => {
    const element = (tag: string): any => {
      const node: any = { tag, children: [] as any[], dataset: {}, className: '', attributes: {},
        appendChild(child: any) { this.children.push(child); return child; },
        setAttribute(key: string, value: string) { this.attributes[key] = value; },
      };
      node.classList = { add(name: string) { node.className += ` ${name}`; } };
      return node;
    };
    const context = vm.createContext({
      currentUserId: 'me', createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: { readyState: 'loading', addEventListener() {}, createElement: element },
      window: { addEventListener() {} }, t: (key: string) => key, escapeHtml: String,
      setTimeout, clearTimeout,
    });
    vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context);
    const task = { id: 't_one', content: 'Review', status: stage };
    const status = (card: any) => cardNodes(card).find((child: any) => child.dataset.action === 'todo-status');
    const project = status(context._renderTodoCard(task, vm.runInContext('_projectTodoContext()', context)));
    expect(project.className).toBe('btn btn-sm project-todo-status-select is-' + stage);
    expect(project.innerHTML).toBe('<span class="project-todo-status-dot"></span>'
      + '<span class="project-todo-status-label">project.todo.status_' + stage + '</span>');
    expect(project.title).toBe('project.todo.status_' + stage);
    expect(project.attributes['aria-haspopup']).toBe('menu');
    const account = status(context._renderTodoCard(task, { global: true, pid: '', tasks: [task], agents: [] }));
    expect(account.className).toBe(project.className);
    expect(account.innerHTML).toBe(project.innerHTML);
    for (const scope of [vm.runInContext('_projectTodoContext()', context), { global: true, tasks: [task], agents: [] }]) {
      const footer = context._renderTodoCard(task, scope).children.find((child: any) => child.className === 'todo-card-meta');
      expect(footer).toBeDefined();
      expect(cardNodes(footer).filter((child: any) => child.dataset.action).map((child: any) => child.dataset.action))
        .toEqual(['todo-assign', 'todo-status']);
    }
  });

  it('shows only the active tab\'s tools on the project tab row', () => {
    const node = (dataset: Record<string, string>) => ({ dataset, hidden: false, tabIndex: 0,
      classList: { toggle() {} }, setAttribute() {} });
    const tabs = ['tasks', 'auto', 'todo'].map(projectTab => node({ projectTab }));
    const panels = ['tasks', 'auto', 'todo'].map(projectPanel => node({ projectPanel }));
    const tools = ['auto', 'todo'].map(projectTools => node({ projectTools }));
    const context = vm.createContext({
      currentUserId: 'me', createLogger: () => ({ warn() {} }),
      document: { readyState: 'loading', addEventListener() {}, querySelectorAll(selector: string) {
        return ({ '.project-detail-tab': tabs, '.project-detail-tab-panel': panels, '[data-project-tools]': tools } as
          Record<string, unknown[]>)[selector] || [];
      } },
      window: { addEventListener() {} }, t: (key: string) => key,
    });
    vm.runInContext(source, context);
    for (const [active, shown] of [['tasks', []], ['auto', ['auto']], ['todo', ['todo']]] as const) {
      context.__active = active;
      vm.runInContext('_projectDetailActiveTab = __active', context);
      context._syncProjectDetailTabState();
      expect(tools.filter(group => !group.hidden).map(group => group.dataset.projectTools)).toEqual(shown);
      expect(panels.filter(panel => !panel.hidden).map(panel => panel.dataset.projectPanel)).toEqual([active]);
    }
  });

  it('offers only usable Agents for assignment when a bound Agent is unavailable', () => {
    let menu: any[] = [];
    const context = vm.createContext({
      currentUserId: 'me',
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: { readyState: 'loading', addEventListener() {} },
      window: { addEventListener() {}, orkas: { async invoke() { return { ok: true }; } } },
      showContextMenu(_event: any, items: any[]) { menu = items; },
      t: (key: string) => key,
      setTimeout, clearTimeout,
    });
    vm.runInContext(composerAccessorSource, context);
    vm.runInContext(source, context);
    const task = { id: 't_a', status: 'todo', owner_agent_id: 'deleted01', owner_agent: 'Previous owner' };
    const scope = { pid: 'p_personal', project: {}, tasks: [task], agents: [
      { agent_id: 'deleted01', name: '', source: 'custom', enabled: false, unavailable: true },
      { agent_id: 'a', name: 'Alpha' },
    ] };
    context._openTodoAssignMenu({}, 't_a', scope);
    expect(menu.map((item) => item.label)).toEqual(['chat.recipient_commander', 'Alpha']);
    expect(menu.some((item) => item.trailingIcon === 'check')).toBe(false);
  });

  it.each(['todo', 'progress', 'review', 'done'])('offers immediate processing only for unfinished %s tasks', async (status) => {
    const calls: any[] = [];
    const navigations: any[] = [];
    let items: any[] = [];
    const context = vm.createContext({
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: { readyState: 'loading', addEventListener() {} },
      window: { addEventListener() {}, orkas: { async invoke(channel: string, payload: any) {
        calls.push({ channel, payload });
        return { ok: true, cid: 'c_run' };
      } } },
      showContextMenu(_event: any, entries: any[]) { items = entries; },
      setView: (view: string, cid: string) => navigations.push({ view, cid }),
      t: (key: string) => key,
      setTimeout, clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context);
    context._openTodoRowMenu({}, 't_123456789abc', {
      pid: 'p_test', tasks: [{ id: 't_123456789abc', title: 'Continue work', status }],
    });
    const run = items.find((item) => item.label === 'project.todo.run');
    if (status === 'done') {
      expect(run).toBeUndefined();
      await context._runTodoTask('t_123456789abc', { pid: 'p_test', tasks: [{ id: 't_123456789abc', status }] });
      expect(calls).toEqual([]);
      expect(navigations).toEqual([]);
      return;
    }
    expect(run).toBeDefined();
    await run.onClick();
    expect(calls).toEqual([{ channel: 'projects.tasks.run', payload: { projectId: 'p_test', taskId: 't_123456789abc' } }]);
    expect(navigations).toEqual([{ view: 'conversation', cid: 'c_run' }]);
  });

  it.each([
    { locale: 'zh', label: '任务' },
    { locale: 'en', label: 'Task' },
    { locale: 'ja', label: 'タスク' },
    { locale: 'pt', label: 'Tarefa' },
  ])('renders the localized $locale task entry and opens that exact task conversation', async ({ locale, label }) => {
    const translations = JSON.parse(fs.readFileSync(path.join(rendererDir, 'locales', `${locale}.json`), 'utf8'));
    const listeners: Record<string, (event: any) => Promise<void>> = {};
    const navigations: Array<{ view: string; cid: string; opts: Record<string, unknown> }> = [];
    const makeElement = (tagName: string) => ({
      tagName,
      children: [] as any[],
      dataset: {} as Record<string, string>,
      attributes: {} as Record<string, string>,
      className: '',
      innerHTML: '',
      textContent: '',
      title: '',
      style: {},
      appendChild(child: any) { this.children.push(child); return child; },
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      addEventListener() {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    });
    const list = {
      dataset: {},
      addEventListener(type: string, handler: (event: any) => Promise<void>) { listeners[type] = handler; },
    };
    const task = {
      id: 't_123456789abc', title: 'Linked task', status: 'progress', origin_cid: 'c_linked',
    };
    const context = vm.createContext({
      currentUserId: 'me',
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById() { return null; },
        createElement: makeElement,
      },
      window: { addEventListener() {}, orkas: {} },
      setView: (view: string, cid: string, opts: Record<string, unknown>) => navigations.push({ view, cid, opts }),
      t: (key: string) => translations[key] || key,
      escapeHtml: (value: unknown) => String(value == null ? '' : value),
      uiIconHtml: () => '<svg></svg>',
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });

    const card = context._renderTodoCard(task, { pid: 'p_test', tasks: [task], agents: [] });
    const conversationEntry = cardNodes(card).find((child: any) => child.dataset?.action === 'todo-conversation');
    expect(conversationEntry).toBeDefined();
    expect(conversationEntry.innerHTML).toBe(`<svg></svg><span>${label}</span>`);
    expect(conversationEntry.attributes['aria-label']).toBe(translations['project.todo.open_conversation']);
    const unlinked = context._renderTodoCard(
      { id: 't_abcdef123456', title: 'Unlinked task', status: 'todo' },
      { pid: 'p_test', tasks: [], agents: [] },
    );
    expect(cardNodes(unlinked).some((child: any) => child.dataset?.action === 'todo-conversation')).toBe(false);
    // Host execution facts are available to models, without adding a visible card indicator.
    for (const is_running of [true, false, null]) {
      const executionCard = context._renderTodoCard({ ...task, is_running }, { pid: 'p_test', tasks: [], agents: [] });
      const badge = cardNodes(executionCard).find((child: any) => child.dataset?.role === 'todo-execution');
      expect(badge).toBeUndefined();
    }

    context._bindTodoListActions(list, () => ({ pid: 'p_test', tasks: [task], agents: [] }));
    const row = { dataset: { tid: task.id, pid: 'p_test' } };
    await listeners.click({
      target: {
        closest(selector: string) {
          if (selector === '.project-todo-item') return row;
          if (selector === '[data-action="todo-conversation"]') return conversationEntry;
          return null;
        },
      },
    });
    expect(navigations).toEqual([{
      view: 'conversation',
      cid: 'c_linked',
      opts: { entryPoint: 'todo_associated_conversation' },
    }]);
  });

  it('sets a todo status from the row status dropdown (four states)', async () => {
    expect(source).not.toContain('_projectTrackClick');
    expect(source).not.toContain('_projectTrackEvent');
    const invocations: Array<{ channel: string; payload: Record<string, any> }> = [];
    const listeners: Record<string, (event: any) => Promise<void>> = {};
    let menuItems: Array<{ label: string; icon?: string; onClick?: () => void }> = [];
    let currentTask: Record<string, unknown> = { id: 't_123456789abc', title: 'Task', status: 'todo' };
    const elements: Record<string, any> = {
      'project-todo-list': {
        dataset: {},
        innerHTML: '',
        style: {},
        appendChild() {},
        addEventListener(type: string, handler: (event: any) => Promise<void>) {
          listeners[type] = handler;
        },
      },
      'project-todo-count': { textContent: '' },
    };
    const context = vm.createContext({
      currentUserId: 'me',
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) { return elements[id] || null; },
        createElement() {
          return {
            appendChild() {}, className: '', innerHTML: '', title: '', dataset: {}, style: {}, tabIndex: 0,
            setAttribute() {}, addEventListener() {}, textContent: '',
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
          };
        },
      },
      window: {
        addEventListener() {},
        orkas: {
          async invoke(channel: string, payload: Record<string, any>) {
            invocations.push({ channel, payload });
            if (channel === 'projects.tasks.list') return { ok: true, tasks: [{ ...currentTask }] };
            if (channel === 'projects.tasks.update' && typeof payload.status === 'string') {
              currentTask = { ...currentTask, status: payload.status };
            }
            return { ok: true };
          },
        },
      },
      showContextMenu(_evt: unknown, items: any[]) { menuItems = items; },
      t: (key: string) => key,
      escapeHtml: (value: unknown) => String(value == null ? '' : value),
      uiIconHtml: () => '<svg></svg>',
      uiAlert() {},
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'; _bindProjectTodos();", context);
    await context._loadProjectTodos('p_test');

    const row = { dataset: { tid: 't_123456789abc', status: 'todo' } };
    const statusButton = { dataset: { action: 'todo-status' } };
    const statusTarget = {
      closest(selector: string) {
        if (selector === '.project-todo-item') return row;
        if (selector === '[data-action="todo-status"]') return statusButton;
        return null;
      },
    };

    // The status control offers exactly the four workflow states.
    await listeners.click({ target: statusTarget });
    expect(menuItems.map((item) => item.label)).toEqual([
      'project.todo.status_todo',
      'project.todo.status_progress',
      'project.todo.status_review',
      'project.todo.status_done',
    ]);

    // Picking one persists it via projects.tasks.update.
    await menuItems[1].onClick!();
    let updates = invocations.filter((call) => call.channel === 'projects.tasks.update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ taskId: 't_123456789abc', status: 'progress' });

    // Re-opening: the current status (progress) is a no-op, not a re-write.
    await listeners.click({ target: statusTarget });
    await menuItems[1].onClick!();
    updates = invocations.filter((call) => call.channel === 'projects.tasks.update');
    expect(updates).toHaveLength(1);

    // Every card keeps its overflow menu. Unfinished tasks can be
    // processed immediately; menu rows deliberately carry no leading icons.
    context._openTodoRowMenu({}, 't_123456789abc', {
      pid: 'p_test',
      tasks: [{ id: 't_123456789abc', title: 'Task', status: 'todo' }],
    });
    expect(menuItems.map((item) => item.label)).toEqual([
      'project.todo.run',
      'project.todo.edit',
      'project.todo.delete',
    ]);
    expect(menuItems.every((item) => !item.icon)).toBe(true);

    context._openTodoRowMenu({}, 't_123456789abc', {
      pid: 'p_test',
      tasks: [{ id: 't_123456789abc', title: 'Task', status: 'done' }],
    });
    expect(menuItems.map((item) => item.label)).toEqual([
      'project.todo.edit',
      'project.todo.delete',
    ]);
  });

  it('assigns and reassigns a todo owner from the row menu', async () => {
    const invocations: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const listeners: Record<string, (event: any) => Promise<void>> = {};
    let menuItems: Array<{ label: string; icon?: string; disabled?: boolean; onClick?: () => void }> = [];
    // The post-mutation re-fetch reads persisted state back through the list
    // channel, so the shim tracks the owner the same way the backend would.
    let currentTask: Record<string, unknown> = { id: 't_abc123def456', title: 'Task', status: 'todo' };
    const elements: Record<string, any> = {
      'project-todo-list': {
        dataset: {},
        innerHTML: '',
        style: {},
        appendChild() {},
        addEventListener(type: string, handler: (event: any) => Promise<void>) {
          listeners[type] = handler;
        },
      },
      'project-todo-count': { textContent: '' },
    };
    const context = vm.createContext({
      currentUserId: 'me',
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) { return elements[id] || null; },
        createElement() {
          return {
            appendChild() {}, className: '', innerHTML: '', title: '',
            dataset: {}, style: {}, setAttribute() {}, addEventListener() {},
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
          };
        },
      },
      window: {
        addEventListener() {},
        orkas: {
          async invoke(channel: string, payload: Record<string, any>) {
            invocations.push({ channel, payload });
            if (channel === 'projects.tasks.list') return { ok: true, tasks: [{ ...currentTask }] };
            if (channel === 'projects.tasks.update'
              && (payload.owner_agent !== undefined || payload.owner_agent_id !== undefined)) {
              currentTask = {
                ...currentTask,
                owner_agent: payload.owner_agent || undefined,
                owner_agent_id: payload.owner_agent_id || undefined,
              };
            }
            return { ok: true };
          },
        },
      },
      showContextMenu(_evt: unknown, items: any[]) { menuItems = items; },
      t: (key: string) => key,
      escapeHtml: (value: unknown) => String(value == null ? '' : value),
      uiAlert() {},
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext(
      "_projectDetailPid = 'p_test';"
      + " _projectDetailMeta = { agentDetails: [{ agent_id: 'a_researcher', name: 'Researcher', icon: 'ic', color: 'co' }] };"
      + ' _bindProjectTodos();',
      context,
    );

    const row = { dataset: { tid: 't_abc123def456', status: 'todo' } };
    const assignButton = { dataset: { action: 'todo-assign' } };
    const assignTarget = {
      closest(selector: string) {
        if (selector === '.project-todo-item') return row;
        if (selector === '[data-action="todo-assign"]') return assignButton;
        return null;
      },
    };

    // Unassigned task: the menu offers the bound agent and no "unassign" entry.
    await listeners.click({ target: assignTarget });
    expect(menuItems.map((item) => item.label)).toEqual(['chat.recipient_commander', 'Researcher']);

    // Picking the agent writes owner_agent + owner_agent_id via projects.tasks.update.
    await menuItems.find(item => item.label === 'Researcher')!.onClick!();
    let updates = invocations.filter((call) => call.channel === 'projects.tasks.update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({
      projectId: 'p_test',
      taskId: 't_abc123def456',
      owner_agent: 'Researcher',
      owner_agent_id: 'a_researcher',
    });

    // The post-assign re-fetch now reports the owner. The menu only switches
    // agents; clearing moved to the × revealed directly on the assigned chip.
    await listeners.click({ target: assignTarget });
    expect(menuItems.map((item) => item.label)).toEqual(['chat.recipient_commander', 'Researcher']);

    // Clicking that × clears both owner fields (empty strings → backend drops
    // the owner) without opening the assignment menu.
    const clearButton = { dataset: { action: 'todo-unassign' } };
    const clearTarget = {
      closest(selector: string) {
        if (selector === '.project-todo-item') return row;
        if (selector === '[data-action="todo-unassign"]') return clearButton;
        return null;
      },
    };
    await listeners.click({ target: clearTarget });
    updates = invocations.filter((call) => call.channel === 'projects.tasks.update');
    expect(updates).toHaveLength(2);
    expect(updates[1].payload).toMatchObject({
      taskId: 't_abc123def456',
      owner_agent: '',
      owner_agent_id: '',
    });
  });

  it('edits full content through the shared editor and still creates through it', async () => {
    const invocations: Array<{ channel: string; payload: Record<string, any> }> = [];
    const listeners: Record<string, (event: any) => Promise<void>> = {};
    let currentTask: Record<string, unknown> = {
      id: 't_edit123abcd', content: 'Old content\nFull requirements', status: 'todo',
    };
    const editor = { hidden: true };
    const input = { value: '', maxLength: 4000, dataset: {}, focus() {}, setSelectionRange() {}, addEventListener() {} };
    const elements: Record<string, any> = {
      'project-todo-list': {
        dataset: {},
        innerHTML: '',
        style: {},
        appendChild() {},
        addEventListener(type: string, handler: (event: any) => Promise<void>) {
          listeners[type] = handler;
        },
      },
      'project-todo-count': { textContent: '' },
      'project-todo-add': editor,
      'project-todo-input': input,
      'project-todo-save': { disabled: false, dataset: {}, addEventListener() {} },
      'project-todo-counter': { textContent: '' },
      'project-todo-cancel': { dataset: {}, addEventListener() {} },
      'project-todo-add-btn': { dataset: {}, addEventListener() {} },
    };
    const context = vm.createContext({
      currentUserId: 'me',
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) { return elements[id] || null; },
        createElement() {
          return {
            appendChild() {}, className: '', innerHTML: '', title: '', dataset: {}, style: {}, tabIndex: 0,
            setAttribute() {}, addEventListener() {}, textContent: '',
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
          };
        },
      },
      window: {
        addEventListener() {},
        orkas: {
          async invoke(channel: string, payload: Record<string, any>) {
            invocations.push({ channel, payload });
            if (channel === 'projects.tasks.list') return { ok: true, tasks: [{ ...currentTask }] };
            if (channel === 'projects.tasks.update' && typeof payload.content === 'string') {
              currentTask = { ...currentTask, content: payload.content, ...(payload.status ? { status: payload.status } : {}) };
            }
            return { ok: true };
          },
        },
      },
      t: (key: string) => key,
      escapeHtml: (value: unknown) => String(value == null ? '' : value),
      uiIconHtml: () => '<svg></svg>',
      uiAlert() {},
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'; _bindProjectTodos();", context);
    await context._loadProjectTodos('p_test');

    const row = { dataset: { tid: 't_edit123abcd', status: 'todo' } };
    const editButton = { dataset: { action: 'todo-menu' } };
    const editTarget = {
      closest(selector: string) {
        if (selector === '.project-todo-item') return row;
        if (selector === '[data-action="todo-menu"]') return editButton;
        return null;
      },
    };

    // Editing remains an explicit overflow-menu action.
    const menuItems: any[] = [];
    context.showContextMenu = (_event: any, items: any[]) => menuItems.push(...items);
    await listeners.click({ target: editTarget });
    menuItems.find(item => item.label === 'project.todo.edit').onClick();
    expect(editor.hidden).toBe(false);
    expect(input.value).toBe('Old content\nFull requirements');

    // A background run advances while the content editor is open. Saving the
    // content must preserve that newer status when the status field was untouched.
    currentTask = { ...currentTask, status: 'progress' };
    input.value = 'New content\nFull requirements';
    await context._saveProjectTodoEditor();
    const updates = invocations.filter((call) => call.channel === 'projects.tasks.update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ projectId: 'p_test', taskId: 't_edit123abcd', content: 'New content\nFull requirements' });
    expect(updates[0].payload.detail).toBeUndefined();
    expect(editor.hidden).toBe(true);
    expect(currentTask).toMatchObject({ content: 'New content\nFull requirements', status: 'progress' });

    // Opening with no task is still create mode — Save creates, not updates.
    context._openProjectTodoEditor();
    input.value = 'Fresh task';
    await context._saveProjectTodoEditor();
    const creates = invocations.filter((call) => call.channel === 'projects.tasks.create');
    expect(creates).toHaveLength(1);
    expect(creates[0].payload).toMatchObject({ projectId: 'p_test', content: 'Fresh task' });
    expect(invocations.filter((call) => call.channel === 'projects.tasks.update')).toHaveLength(1);
  });

  it('stages an attachment to a pre-allocated draft id that create then adopts', async () => {
    const invocations: Array<{ channel: string; payload: Record<string, any> }> = [];
    const editor = { hidden: true };
    const input = { value: '', maxLength: 200, dataset: {}, focus() {}, setSelectionRange() {}, addEventListener() {} };
    const attachWrap = { innerHTML: '', hidden: true, querySelectorAll: () => [] as any[] };
    const elements: Record<string, any> = {
      'project-todo-add': editor,
      'project-todo-input': input,
      'project-todo-attachments': attachWrap,
      'project-todo-save': { disabled: false, dataset: {}, addEventListener() {} },
      'project-todo-counter': { textContent: '' },
    };
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: { readyState: 'loading', addEventListener() {}, getElementById(id: string) { return elements[id] || null; } },
      window: {
        addEventListener() {},
        orkas: {
          async invoke(channel: string, payload: Record<string, any>) {
            invocations.push({ channel, payload });
            if (channel === 'projects.tasks.attachments.upload') return { name: payload.name };
            return { ok: true };
          },
        },
      },
      // The composer's shared helpers/whitelist, reused by the to-do editor.
      CHAT_ATTACH_ACCEPT: ['.txt'],
      _chatFileIconHtml: () => '<svg></svg>',
      btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
      _arrayBufferToBase64: rendererUtils._arrayBufferToBase64,
      t: (key: string) => key,
      escapeHtml: (value: unknown) => String(value == null ? '' : value),
      uiIconHtml: () => '<svg></svg>',
      uiAlert() {},
      setTimeout, clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test';", context);

    context._openProjectTodoEditor(); // create mode → no task id yet
    const file = { name: 'brief.txt', size: 2, async arrayBuffer() { return new Uint8Array([104, 105]).buffer; } };
    await context._todoPickAndUploadFiles([file]);

    const uploads = invocations.filter((c) => c.channel === 'projects.tasks.attachments.upload');
    expect(uploads).toHaveLength(1);
    expect(uploads[0].payload.name).toBe('brief.txt');
    // A client pre-allocated t_<12hex> so the file could stage before the task existed.
    expect(uploads[0].payload.taskId).toMatch(/^t_[a-f0-9]{12}$/);
    const draftTid = uploads[0].payload.taskId;
    expect(attachWrap.hidden).toBe(false);
    expect(attachWrap.innerHTML).toContain('brief.txt');

    // Save (create mode) passes that same draft id so the new task adopts the file.
    input.value = 'Task with file';
    await context._saveProjectTodoEditor();
    const creates = invocations.filter((c) => c.channel === 'projects.tasks.create');
    expect(creates).toHaveLength(1);
    expect(creates[0].payload).toMatchObject({ projectId: 'p_test', content: 'Task with file', taskId: draftTid });
  });

  it('uploads a picked file through the input change handler (survives the value reset)', async () => {
    const invocations: Array<{ channel: string; payload: Record<string, any> }> = [];
    const editor = { hidden: true };
    const input = { value: '', maxLength: 200, dataset: {}, focus() {}, setSelectionRange() {}, addEventListener() {} };
    const attachWrap = { innerHTML: '', hidden: true, querySelectorAll: () => [] as any[] };
    const file = { name: 'brief.txt', size: 2, async arrayBuffer() { return new Uint8Array([104, 105]).buffer; } };
    // Mimic Chromium: `.files` is a live list that clearing `.value` empties IN
    // PLACE, so a captured reference goes empty after the reset. The handler must
    // snapshot before clearing or the upload silently gets an empty list.
    const fileList: any[] = [file];
    let changeHandler: (() => Promise<void>) | null = null;
    const fileInput = {
      dataset: {} as Record<string, string>,
      get files() { return fileList; },
      get value() { return ''; },
      set value(v: string) { if (v === '') fileList.length = 0; },
      addEventListener(type: string, h: () => Promise<void>) { if (type === 'change') changeHandler = h; },
      setAttribute() {},
      click() {},
    };
    const elements: Record<string, any> = {
      'project-todo-add': editor,
      'project-todo-input': input,
      'project-todo-attachments': attachWrap,
      'project-todo-attach-btn': { dataset: {}, innerHTML: '', addEventListener() {} },
      'project-todo-file-input': fileInput,
      'project-todo-add-btn': { dataset: {}, addEventListener() {} },
      'project-todo-cancel': { dataset: {}, addEventListener() {} },
      'project-todo-save': { disabled: false, dataset: {}, addEventListener() {} },
      'project-todo-counter': { textContent: '' },
      'project-todo-list': { dataset: {}, innerHTML: '', style: {}, appendChild() {}, addEventListener() {} },
    };
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: { readyState: 'loading', addEventListener() {}, getElementById(id: string) { return elements[id] || null; } },
      window: {
        addEventListener() {},
        orkas: {
          async invoke(channel: string, payload: Record<string, any>) {
            invocations.push({ channel, payload });
            if (channel === 'projects.tasks.attachments.upload') return { name: payload.name };
            if (channel === 'projects.tasks.list') return { ok: true, tasks: [] };
            return { ok: true };
          },
        },
      },
      CHAT_ATTACH_ACCEPT: ['.txt'],
      _chatFileIconHtml: () => '<svg></svg>',
      btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
      _arrayBufferToBase64: rendererUtils._arrayBufferToBase64,
      t: (key: string) => key,
      escapeHtml: (value: unknown) => String(value == null ? '' : value),
      uiIconHtml: () => '<svg></svg>',
      uiAlert() {},
      setTimeout, clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'; _bindProjectTodos();", context);
    context._openProjectTodoEditor();

    expect(typeof changeHandler).toBe('function');
    await changeHandler!(); // the OS dialog resolved with `file`

    const uploads = invocations.filter((c) => c.channel === 'projects.tasks.attachments.upload');
    expect(uploads).toHaveLength(1);
    expect(uploads[0].payload.name).toBe('brief.txt');
    expect(attachWrap.innerHTML).toContain('brief.txt');
  });

  it('discards staged attachment removals when switching to another project editor', async () => {
    const deletions: string[] = [];
    const editor = { hidden: true };
    const input = { value: '', maxLength: 200, dataset: {}, focus() {}, setSelectionRange() {}, addEventListener() {} };
    const attachWrap = { innerHTML: '', hidden: true, querySelectorAll: () => [] as any[] };
    const elements: Record<string, any> = {
      'project-todo-add': editor,
      'project-todo-input': input,
      'project-todo-attachments': attachWrap,
      'project-todo-save': { disabled: false, dataset: {}, addEventListener() {} },
      'project-todo-counter': { textContent: '' },
    };
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: { readyState: 'loading', addEventListener() {}, getElementById(id: string) { return elements[id] || null; } },
      window: { addEventListener() {}, orkas: { async invoke(channel: string) { if (channel === 'projects.tasks.attachments.delete') deletions.push(channel); return { ok: true }; } } },
      _chatFileIconHtml: () => '<svg></svg>',
      t: (key: string) => key,
      escapeHtml: (value: unknown) => String(value == null ? '' : value),
      uiIconHtml: () => '<svg></svg>',
      setTimeout, clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test';", context);

    context._openProjectTodoEditor({ id: 't_abcabcabcabc', title: 'Has files', status: 'todo', attachments: ['a.txt', 'b.png'] });
    expect(attachWrap.hidden).toBe(false);
    expect(attachWrap.innerHTML).toContain('a.txt');
    expect(attachWrap.innerHTML).toContain('b.png');
    await context._removeTodoEditorAttachment('a.txt');
    context._openProjectTodoEditor(
      { id: 't_defdefdefdef', title: 'Other project', status: 'todo', attachments: ['a.txt', 'c.png'] },
      { pid: 'p_other', tasks: [], agents: [] },
    );
    expect(deletions).toEqual([]);
    expect(attachWrap.innerHTML).toContain('a.txt');
    expect(attachWrap.innerHTML).toContain('c.png');
    expect(attachWrap.innerHTML).not.toContain('b.png');
    input.value = 'Saved in the other project';
    await context._saveProjectTodoEditor();
    expect(deletions).toEqual([]);
  });

  it('confirms the auto-advance toggle with a toast', async () => {
    const invocations: Array<{ channel: string; payload: Record<string, any> }> = [];
    const toasts: Array<{ msg: string; opts: any }> = [];
    let clickHandler: (() => Promise<void>) | undefined;
    const toggle: any = {
      hidden: true,
      dataset: {},
      _pressed: 'false',
      getAttribute(k: string) { return k === 'aria-pressed' ? this._pressed : null; },
      setAttribute(k: string, v: string) { if (k === 'aria-pressed') this._pressed = v; },
      addEventListener(type: string, h: () => Promise<void>) { if (type === 'click') clickHandler = h; },
    };
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) { return id === 'project-driver-toggle' ? toggle : null; },
      },
      window: {
        addEventListener() {},
        orkas: {
          async invoke(channel: string, payload: Record<string, any>) {
            invocations.push({ channel, payload });
            if (channel === 'projects.driver.set') return { ok: true, config: { enabled: payload.enabled } };
            return { ok: true };
          },
        },
      },
      uiToast: (msg: string, opts: any) => { toasts.push({ msg, opts }); },
      t: (key: string) => key,
      uiAlert() {},
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'; _bindProjectDriver();", context);

    // Turn it on: persists the setting AND surfaces a confirmation toast.
    await clickHandler!();
    const sets = invocations.filter((call) => call.channel === 'projects.driver.set');
    expect(sets).toHaveLength(1);
    expect(sets[0].payload).toMatchObject({ projectId: 'p_test', enabled: true });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].msg).toBe('project.driver.enabled_toast');
    expect(toasts[0].opts).toMatchObject({ variant: 'success' });

    // Turn it off: the off confirmation.
    await clickHandler!();
    expect(toasts).toHaveLength(2);
    expect(toasts[1].msg).toBe('project.driver.disabled_toast');
    expect(toasts[1].opts).toMatchObject({ variant: 'info' });
  });

  it('shows the executing device name and disables then re-enables on the current device', async () => {
    let click!: () => Promise<void>;
    const toggle: any = { dataset: {}, disabled: false, _pressed: 'false',
      getAttribute() { return this._pressed; },
      setAttribute(_key: string, value: string) { this._pressed = value; },
      addEventListener(_type: string, callback: typeof click) { click = callback; } };
    const suffix = { textContent: '' };
    const sets: boolean[] = [];
    const device = { id: 'device-b', name: 'Laptop B' };
    let config: any = { enabled: true, device_id: 'device-a', device_name: '<Office Mac>' };
    const context = vm.createContext({
      createLogger: () => ({ warn() {} }),
      document: { readyState: 'loading', addEventListener() {}, getElementById(id: string) {
        return id === 'project-driver-toggle' ? toggle : id === 'project-driver-device' ? suffix : null;
      } },
      window: { addEventListener() {}, orkas: { async invoke(channel: string, payload: any) {
        if (channel === 'projects.driver.set') {
          sets.push(payload.enabled);
          config = { enabled: payload.enabled, ...(payload.enabled ? { device_id: device.id, device_name: device.name } : {}) };
        }
        return { config, device };
      } } }, t: String,
    });
    vm.runInContext(source, context);
    vm.runInContext("_projectDetailPid = 'p_device'; _bindProjectDriver();", context);
    await context._loadProjectDriver('p_device');
    expect(toggle._pressed).toBe('true');
    // Hostnames are user data and remain text, including markup look-alikes.
    expect(suffix.textContent).toBe(' · <Office Mac>');
    await click();
    expect(toggle._pressed).toBe('false');
    expect(suffix.textContent).toBe('');
    await click();
    expect(toggle._pressed).toBe('true');
    expect(suffix.textContent).toBe(' · auto.device_current');
    expect(sets).toEqual([false, true]);
    context._setProjectDriverToggleState({ enabled: true, device_id: device.id }, device);
    expect(suffix.textContent).toBe(' · auto.device_current');
    context._setProjectDriverToggleState({ enabled: true, device_id: 'device-a', device_name: device.name }, device);
    expect(suffix.textContent).toBe(' · Laptop B');
    context._setProjectDriverToggleState({ enabled: true, device_id: 'device-a' }, device);
    expect(suffix.textContent).toBe(' · device-a');
  });

  it('ignores reordered driver reads across project navigation and blocks toggling unknown state', async () => {
    let click!: () => Promise<void>;
    const toggle: any = { dataset: {}, disabled: false, _pressed: 'false',
      getAttribute() { return this._pressed; },
      setAttribute(_key: string, value: string) { this._pressed = value; },
      addEventListener(_type: string, callback: typeof click) { click = callback; } };
    const suffix = { textContent: '' };
    const pending: Array<(value: any) => void> = [];
    const sets: any[] = [];
    const context = vm.createContext({
      createLogger: () => ({ warn() {} }),
      document: { readyState: 'loading', addEventListener() {}, getElementById(id: string) {
        return id === 'project-driver-toggle' ? toggle : id === 'project-driver-device' ? suffix : null;
      } },
      window: { addEventListener() {}, orkas: { invoke(channel: string, payload: any) {
        if (channel === 'projects.driver.set') sets.push(payload);
        return new Promise(resolve => pending.push(resolve));
      } } }, t: String,
    });
    vm.runInContext(source, context);
    vm.runInContext("_projectDetailPid = 'p_old'; _bindProjectDriver();", context);
    const old = context._loadProjectDriver('p_old');
    expect(toggle.disabled).toBe(true);
    await click();
    expect(sets).toEqual([]);
    vm.runInContext("_projectDetailPid = 'p_new';", context);
    const fresh = context._loadProjectDriver('p_new');
    pending[1]({ config: { enabled: true, device_id: 'device-b', device_name: 'Remote B' }, device: { id: 'device-a' } });
    await fresh;
    expect(toggle.disabled).toBe(false);
    expect(suffix.textContent).toBe(' · Remote B');
    pending[0]({ config: { enabled: false }, device: { id: 'device-a' } });
    await old;
    expect(toggle._pressed).toBe('true');
    expect(suffix.textContent).toBe(' · Remote B');
  });

  it('surfaces a driver-advanced conversation into the shared conversation list', () => {
    const conversationsArr: any[] = [];
    let renderCalls = 0;
    const observed: Array<{ cid: string; opts: any }> = [];
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: { readyState: 'complete', addEventListener() {}, getElementById() { return null; } },
      window: { addEventListener() {}, orkas: {} },
      conversations: conversationsArr,
      renderConversationList: () => { renderCalls += 1; },
      _observeConversationRunFromPlanAction: (cid: string, opts: any) => { observed.push({ cid, opts }); },
      currentView: 'conversation',
      t: (key: string) => key,
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });

    // A background driver advance pushes its new conversation; it lands in the
    // shared list (like a human-started run) and the list re-renders.
    context._onProjectAdvance({ projectId: 'p_test', conversation: { conversation_id: 'c_drv1', project_id: 'p_test' } });
    expect(context.conversations).toHaveLength(1);
    expect(context.conversations[0]).toMatchObject({ conversation_id: 'c_drv1' });
    expect(renderCalls).toBe(1);
    // It also attaches the run observer so the conversation shows the in-progress
    // breathing badge, like a human-started run.
    expect(observed).toHaveLength(1);
    expect(observed[0].cid).toBe('c_drv1');
    expect(observed[0].opts).toMatchObject({ attachExisting: true });

    // Same cid again updates in place — never duplicates the running task.
    context._onProjectAdvance({ projectId: 'p_test', conversation: { conversation_id: 'c_drv1', project_id: 'p_test', title: 'x' } });
    expect(context.conversations).toHaveLength(1);
    expect(context.conversations[0]).toMatchObject({ title: 'x' });
  });

  it('refreshes the open project to-do list on a background task-change broadcast', async () => {
    const invocations: Array<{ channel: string; payload: Record<string, any> }> = [];
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: { readyState: 'complete', addEventListener() {}, getElementById() { return null; } },
      window: {
        addEventListener() {},
        orkas: {
          async invoke(channel: string, payload: Record<string, any>) {
            invocations.push({ channel, payload });
            if (channel === 'projects.tasks.list') return { ok: true, tasks: [] };
            return { ok: true };
          },
        },
      },
      currentView: 'project',
      t: (key: string) => key,
      uiAlert() {},
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'; _projectDetailMeta = { project: {} };", context);

    // A change for the open project reloads its to-dos (so a driver-set
    // progress shows without a view switch).
    context._onProjectTasksChanged({ projectId: 'p_test' });
    // The reload is debounced (one list read per burst of pushes).
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(invocations.filter((c) => c.channel === 'projects.tasks.list')).toHaveLength(1);

    // A change for a different project is ignored.
    context._onProjectTasksChanged({ projectId: 'p_other' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invocations.filter((c) => c.channel === 'projects.tasks.list')).toHaveLength(1);
  });

  it('restores the send control when project conversation creation fails', async () => {
    const input = { value: 'project question' };
    const button = { disabled: false };
    const context = vm.createContext({
      console,
      performance,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) {
          if (id === 'project-chat-input') return input;
          if (id === 'project-chat-send-btn') return button;
          return null;
        },
      },
      window: { addEventListener() {} },
      t: (key: string) => key,
      ensureModelConfigured: () => true,
      _getQuotes: () => [],
      _referenceSnapshotsForQuotes: () => [],
      _chatAttachList: () => [],
      consumeChatUseSelections: () => [],
      getChatRecipient: () => ({ kind: 'commander' }),
      transformWithChatUse: (value: string) => value,
      applyRecipientPrefix: (value: string) => value,
      apiFetch: async () => ({ json: async () => ({ ok: false, error: 'create failed' }) }),
      uiAlert: async () => {},
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);

    await context._submitProjectChat();

    expect(button.disabled).toBe(false);
  });

  it('keeps the project task title text separate from an injected @Agent route', async () => {
    const input = { value: 'Draft the project brief' };
    const button = { disabled: false };
    const sent: Array<{ content: string; extra: Record<string, unknown> }> = [];
    const context = vm.createContext({
      console,
      performance,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) {
          if (id === 'project-chat-input') return input;
          if (id === 'project-chat-send-btn') return button;
          if (id === 'chat-input') return { value: '' };
          return null;
        },
      },
      window: { addEventListener() {} },
      conversations: [],
      currentCid: null,
      t: (key: string) => key,
      ensureModelConfigured: () => true,
      _getQuotes: () => [],
      _referenceSnapshotsForQuotes: () => [],
      consumeChatUseSelections: () => [],
      getChatRecipient: () => ({ kind: 'agent', id: 'agent-title', name: 'TitleAgent' }),
      transformWithChatUse: (value: string) => value,
      transformChatUseTokens: (value: string) => value,
      applyRecipientPrefix: (value: string) => `@TitleAgent ${value}`,
      _autoTitle: (value: string) => value,
      apiFetch: async () => ({
        json: async () => ({
          ok: true,
          conversation: { conversation_id: 'c_project_title', title: 'New task' },
        }),
      }),
      renderConversationList() {},
      loadProjects() {},
      _chatAttachList: () => [],
      _consumeSubmittedQuotes() {},
      _clearQuotes() {},
      autoGrow() {},
      setView() {},
      setChatRecipient() {},
      async sendInConversation(_cid: string, content: string, extra: Record<string, unknown>) {
        sent.push({ content, extra });
      },
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);

    await context._submitProjectChat();

    expect(sent).toEqual([{
      content: '@TitleAgent Draft the project brief',
      extra: { title_text: 'Draft the project brief' },
    }]);
    expect(context.conversations[0].title).toBe('Draft the project brief');
  });

  it('keeps a body-carried @Agent mention out of the project task title', async () => {
    const input = { value: '@TitleAgent Draft the project brief' };
    const button = { disabled: false };
    const sent: Array<{ content: string; extra: Record<string, unknown> }> = [];
    const context = vm.createContext({
      console,
      performance,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) {
          if (id === 'project-chat-input') return input;
          if (id === 'project-chat-send-btn') return button;
          if (id === 'chat-input') return { value: '' };
          return null;
        },
      },
      window: { addEventListener() {} },
      conversations: [],
      currentCid: null,
      t: (key: string) => key,
      ensureModelConfigured: () => true,
      _getQuotes: () => [],
      _referenceSnapshotsForQuotes: () => [],
      consumeChatUseSelections: () => [],
      getChatRecipient: () => ({ kind: 'agent', id: 'agent-title', name: 'TitleAgent' }),
      transformWithChatUse: (value: string) => value,
      transformChatUseTokens: (value: string) => value,
      applyRecipientPrefix: (value: string) => value,
      _titleSeedWithoutRoutingMentions: (value: string) => value.replace(/^@TitleAgent\s+/, ''),
      _autoTitle: (value: string) => value,
      apiFetch: async () => ({
        json: async () => ({
          ok: true,
          conversation: { conversation_id: 'c_project_title', title: 'New task' },
        }),
      }),
      renderConversationList() {},
      loadProjects() {},
      _chatAttachList: () => [],
      _consumeSubmittedQuotes() {},
      _clearQuotes() {},
      autoGrow() {},
      setView() {},
      setChatRecipient() {},
      async sendInConversation(_cid: string, content: string, extra: Record<string, unknown>) {
        sent.push({ content, extra });
      },
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);

    await context._submitProjectChat();

    expect(sent).toEqual([{
      content: '@TitleAgent Draft the project brief',
      extra: { title_text: 'Draft the project brief' },
    }]);
    expect(context.conversations[0].title).toBe('Draft the project brief');
  });

  it('sends a project draft attachment recovered from the main-process snapshot', async () => {
    const input = { value: 'Review the image' };
    const button = { disabled: false };
    const sent: any[] = [];
    const calls: string[] = [];
    const context = vm.createContext({
      console,
      performance,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) {
          if (id === 'project-chat-input') return input;
          if (id === 'project-chat-send-btn') return button;
          if (id === 'chat-input') return { value: '' };
          return null;
        },
      },
      window: { addEventListener() {} },
      conversations: [],
      currentCid: null,
      t: (key: string) => key,
      ensureModelConfigured: () => true,
      _getQuotes: () => [],
      _referenceSnapshotsForQuotes: () => [],
      getChatRecipient: () => ({ kind: 'commander' }),
      transformWithChatUse: (value: string) => value,
      transformChatUseTokens: (value: string) => value,
      applyRecipientPrefix: (value: string) => value,
      _autoTitle: (value: string) => value,
      _chatAttachList: () => [],
      _chatAttachTryBeginSend: () => () => {},
      _chatAttachSnapshotForSend: async () => ({
        ok: true,
        items: [{ name: 'diagram.png', kind: 'image', bytes: 42, status: 'ready' }],
      }),
      _chatAttachClear() {},
      _consumeSubmittedQuotes() {},
      _clearQuotes() {},
      autoGrow() {},
      renderConversationList() {},
      loadProjects() {},
      setView() {},
      setChatRecipient() {},
      apiFetch: async (url: string) => {
        calls.push(url);
        if (url.endsWith('/create')) {
          return { json: async () => ({
            ok: true,
            conversation: { conversation_id: 'c_project_image', title: 'New task' },
          }) };
        }
        return { json: async () => ({
          ok: true,
          items: [{ sourceName: 'diagram.png', targetName: 'diagram.png' }],
        }) };
      },
      async sendInConversation(_cid: string, content: string, extra: any) {
        sent.push({ content, extra });
      },
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);

    await context._submitProjectChat();

    expect(calls).toEqual([
      '/api/conversations/create',
      '/api/conversations/attachments/adopt',
    ]);
    expect(sent).toEqual([{
      content: 'Review the image',
      extra: { title_text: 'Review the image', attachments: ['diagram.png'] },
    }]);
  });

  it('keeps the project composer intact and records failure when attachment adoption fails', async () => {
    const messages = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/en.json'), 'utf8'));
    const invocations: any[] = [];
    const alerts: string[] = [];
    const input = { value: 'Review the attached brief' };
    const button = { disabled: false };
    let clearedAttachments = 0;
    let clearedQuotes = 0;
    let sends = 0;
    let consumedSelections = 0;
    const context = vm.createContext({
      console,
      performance,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) {
          if (id === 'project-chat-input') return input;
          if (id === 'project-chat-send-btn') return button;
          return null;
        },
      },
      window: {
        addEventListener() {},
        orkas: {
          async invoke(channel: string, payload: any) {
            invocations.push({ channel, payload });
            return { ok: true, discarded: true };
          },
        },
      },
      conversations: [],
      currentCid: null,
      t: (key: string, params: Record<string, unknown> = {}) => String(messages[key] || key)
        .replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`)),
      ensureModelConfigured: () => true,
      _getQuotes: () => [{ id: 'quote-1' }],
      _referenceSnapshotsForQuotes: () => [],
      getChatUseSelections: () => [{ kind: 'skill', id: 'review' }],
      consumeChatUseSelections: () => { consumedSelections += 1; return []; },
      getChatRecipient: () => ({ kind: 'commander' }),
      transformWithChatUse: (value: string) => value,
      transformChatUseTokens: (value: string) => value,
      applyRecipientPrefix: (value: string) => value,
      _chatAttachList: () => [{ name: 'brief.pdf', status: 'ready' }],
      _chatAttachClear: () => { clearedAttachments += 1; },
      _consumeSubmittedQuotes: () => { clearedQuotes += 1; },
      _clearQuotes: () => { clearedQuotes += 1; },
      apiFetch: async (url: string) => ({
        json: async () => url.endsWith('/create')
          ? { ok: true, conversation: { conversation_id: 'c_failed_adopt', title: 'New task' } }
          : { ok: false, error: 'EPERM: rename C:\\PRIVATE_ATTACHMENT_PATH\\draft to conversation' },
      }),
      uiAlert: async (message: string) => { alerts.push(message); },
      renderConversationList() {},
      loadProjects() {},
      async sendInConversation() { sends += 1; },
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);

    await context._submitProjectChat();

    expect(invocations).toEqual([{
      channel: 'conversations.discardEmpty',
      payload: { cid: 'c_failed_adopt', project_id: 'p_test' },
    }]);
    expect(input.value).toBe('Review the attached brief');
    expect(button.disabled).toBe(false);
    expect(context.conversations).toEqual([]);
    expect(clearedAttachments).toBe(0);
    expect(clearedQuotes).toBe(0);
    expect(consumedSelections).toBe(0);
    expect(sends).toBe(0);
    expect(alerts).toEqual(['Could not confirm the attachments. Your message and files are still here; try again.']);
    expect(alerts.join(' ')).not.toContain('PRIVATE_ATTACHMENT_PATH');
  });

  it('sends the server-assigned attachment name after successful adoption', async () => {
    const sent: any[] = [];
    const cleared: string[] = [];
    const context = vm.createContext({
      console,
      performance,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) {
          if (id === 'project-chat-input') return { value: 'Review it' };
          if (id === 'project-chat-send-btn') return { disabled: false };
          if (id === 'chat-input') return { value: '' };
          return null;
        },
      },
      window: { addEventListener() {} },
      conversations: [],
      currentCid: null,
      t: (key: string) => key,
      ensureModelConfigured: () => true,
      _getQuotes: () => [],
      _referenceSnapshotsForQuotes: () => [],
      getChatUseSelections: () => [],
      consumeChatUseSelections: () => [],
      getChatRecipient: () => ({ kind: 'commander' }),
      transformWithChatUse: (value: string) => value,
      transformChatUseTokens: (value: string) => value,
      applyRecipientPrefix: (value: string) => value,
      _chatAttachList: () => [{ name: 'brief.pdf', status: 'ready' }],
      _chatAttachClear: (cid: string) => { cleared.push(cid); },
      _consumeSubmittedQuotes() {},
      _clearQuotes() {},
      apiFetch: async (url: string) => ({
        json: async () => url.endsWith('/create')
          ? { ok: true, conversation: { conversation_id: 'c_adopted', title: 'New task' } }
          : {
            ok: true,
            count: 1,
            items: [{ sourceName: 'brief.pdf', targetName: 'brief (1).pdf' }],
          },
      }),
      renderConversationList() {},
      loadProjects() {},
      autoGrow() {},
      setView() {},
      setChatRecipient() {},
      async sendInConversation(_cid: string, content: string, extra: any) { sent.push({ content, extra }); },
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);

    await context._submitProjectChat();

    expect(sent).toEqual([{
      content: 'Review it',
      extra: { title_text: 'Review it', attachments: ['brief (1).pdf'] },
    }]);
    expect(cleared).toEqual(['projchat-p_test']);
  });

  it('blocks project chat when no model is configured without creating a conversation', async () => {
    const input = { value: 'project question' };
    let attempted = false;
    const apiFetch = async () => {
      attempted = true;
      throw new Error('conversation creation must not run while blocked');
    };
    const context = vm.createContext({
      console,
      performance,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) {
          return id === 'project-chat-input' ? input : null;
        },
      },
      window: { addEventListener() {} },
      t: (key: string) => key,
      ensureModelConfigured: () => false,
      _getQuotes: () => [],
      getChatUseSelections: () => [
        { kind: 'skill', id: 'review' },
        { kind: 'connector', id: 'notion' },
      ],
      getChatRecipient: () => ({ kind: 'agent', id: 'reviewer' }),
      _recipientSnapshotForSend: () => ({ kind: 'agent', id: 'reviewer' }),
      _chatAttachList: () => [{ name: 'brief.pdf', status: 'ready' }],
      apiFetch,
      setTimeout,
      clearTimeout,
    });
  vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);

    await context._submitProjectChat();
    expect(attempted).toBe(false);
    expect(input.value).toBe('project question');

  });
});

describe('todo attachment preview recovery', () => {
  it('reports an unavailable file without opening a viewer and permits a scoped retry', async () => {
    let available = false;
    const opened: any[] = [];
    const alerts: string[] = [];
    const warnings: string[] = [];
    const calls: any[] = [];
    const context = vm.createContext({
      document: { readyState: 'loading', addEventListener() {} },
      window: { addEventListener() {}, orkas: { async invoke(channel: string, payload: any) {
        calls.push({ channel, payload });
        return available ? { ok: true, path: '/fixture/brief.txt' } : { ok: false };
      } } },
      createLogger: () => ({ warn: (message: string) => warnings.push(message), info() {}, error() {} }),
      openChatFileViewer: (...args: any[]) => opened.push(args),
      uiAlert: (message: string) => alerts.push(message), t: (key: string) => key,
    });
    vm.runInContext(composerAccessorSource + attachmentOrderFunction, context);
    vm.runInContext(source, context);
    await context._previewTodoAttachment('p_other', 't_123456abcdef', 'brief.txt');
    expect(opened).toEqual([]);
    expect(alerts).toEqual(['chat.file_missing_toast']);
    expect(warnings).toEqual(['todo attachment preview failed']);
    available = true;
    await context._previewTodoAttachment('p_other', 't_123456abcdef', 'brief.txt');
    expect(opened).toEqual([['/fixture/brief.txt', 'brief.txt', {
      projectId: 'p_other', cid: null, readOnly: true, sourceElement: undefined,
    }]]);
    expect(calls.every(call => call.channel === 'projects.tasks.attachments.absPath'
      && call.payload.projectId === 'p_other' && call.payload.taskId === 't_123456abcdef')).toBe(true);
  });
});


describe('todo chip track wheel ownership', () => {
  it.each(['ltr', 'rtl'])('scrolls forward/backward and releases the page at both %s boundaries', direction => {
    const parsed = ts.createSourceFile('todos.js', fs.readFileSync(path.join(rendererDir, 'modules/todos.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const binding = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === '_bindTodoScrollTrack')!;
    let wheel: any;
    let position = 0;
    const track = {
      get scrollLeft() { return position; },
      set scrollLeft(value: number) { position = direction === 'rtl' ? Math.max(-500, Math.min(0, value)) : Math.max(0, Math.min(500, value)); },
      addEventListener(type: string, callback: any) { if (type === 'wheel') wheel = callback; },
    };
    const context = vm.createContext({getComputedStyle: () => ({direction}), _updateTodoScrollTrackFade() {}});
    vm.runInContext(binding.getText(parsed), context);
    context._bindTodoScrollTrack(track);
    const event = (deltaY: number, deltaX = 0) => ({deltaY, deltaX, preventDefault: vi.fn()});
    const forward = event(400); wheel(forward);
    expect(Math.abs(position)).toBe(400); expect(forward.preventDefault).toHaveBeenCalledOnce();
    const horizontal = event(1, 20); wheel(horizontal);
    expect(Math.abs(position)).toBe(400); expect(horizontal.preventDefault).not.toHaveBeenCalled();
    wheel(event(400)); expect(Math.abs(position)).toBe(500);
    const end = event(400); wheel(end); expect(end.preventDefault).not.toHaveBeenCalled();
    const back = event(-500); wheel(back);
    expect(position).toBe(0); expect(back.preventDefault).toHaveBeenCalledOnce();
    const start = event(-400); wheel(start); expect(start.preventDefault).not.toHaveBeenCalled();
  });
});
