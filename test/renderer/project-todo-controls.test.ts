import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererDir = path.join(__dirname, '../../src/renderer');
const source = fs.readFileSync(path.join(rendererDir, 'modules/project-detail.js'), 'utf8');

// The editor uploads through the shared renderer base64 helper (utils.js).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rendererUtils = require('../../src/renderer/modules/utils.js');

describe('project to-do controls', () => {
  it.each(['todo', 'progress', 'review'])('opens an immediate run from a %s task menu', async (status) => {
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
    vm.runInContext(source, context);
    context._openTodoRowMenu({}, 't_123456789abc', {
      pid: 'p_test', tasks: [{ id: 't_123456789abc', title: 'Continue work', status }],
    });
    const run = items.find((item) => item.label === 'project.todo.run');
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
    vm.runInContext(source, context, { filename: 'project-detail.js' });

    const card = context._renderTodoCard(task, { pid: 'p_test', tasks: [task], agents: [] });
    const conversationEntry = card.children.find((child: any) => child.dataset?.action === 'todo-conversation');
    expect(conversationEntry).toBeDefined();
    expect(conversationEntry.innerHTML).toBe(`<svg></svg><span>${label}</span>`);
    expect(conversationEntry.attributes['aria-label']).toBe(translations['project.todo.open_conversation']);
    const unlinked = context._renderTodoCard(
      { id: 't_abcdef123456', title: 'Unlinked task', status: 'todo' },
      { pid: 'p_test', tasks: [], agents: [] },
    );
    expect(unlinked.children.some((child: any) => child.dataset?.action === 'todo-conversation')).toBe(false);
    for (const [is_running, key] of [[true, 'running'], [false, 'idle'], [null, 'unknown']] as const) {
      const executionCard = context._renderTodoCard({ ...task, is_running }, { pid: 'p_test', tasks: [], agents: [] });
      const badge = executionCard.children.find((child: any) => child.dataset?.role === 'todo-execution');
      expect(badge?.textContent).toBe(translations[`project.todo.execution.${key}`]);
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
    // Telemetry contract (restored 2026-08-24 — the 1.6.6 merge kept the
    // _result-event code style but dropped both oracles): the toggle emits
    // one terminal result event and no start click.
    expect(source).not.toContain("_projectTrackClick('project_todo_toggle'");
    expect(source).toContain("_projectTrackEvent('project_todo_toggle_result'");
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
    expect(menuItems.map((item) => item.label)).toEqual(['Researcher']);

    // Picking the agent writes owner_agent + owner_agent_id via projects.tasks.update.
    await menuItems[0].onClick!();
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
    expect(menuItems.map((item) => item.label)).toEqual(['Researcher']);

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

  it('edits a title through the shared editor and still creates through it', async () => {
    const invocations: Array<{ channel: string; payload: Record<string, any> }> = [];
    const listeners: Record<string, (event: any) => Promise<void>> = {};
    let currentTask: Record<string, unknown> = {
      id: 't_edit123abcd', title: 'Old title', detail: 'Legacy detail stays intact', status: 'todo',
    };
    const editor = { hidden: true };
    const input = { value: '', maxLength: 200, dataset: {}, focus() {}, setSelectionRange() {}, addEventListener() {} };
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
            if (channel === 'projects.tasks.update' && typeof payload.title === 'string') {
              currentTask = { ...currentTask, title: payload.title, ...(payload.status ? { status: payload.status } : {}) };
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
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'; _bindProjectTodos();", context);
    await context._loadProjectTodos('p_test');

    const row = { dataset: { tid: 't_edit123abcd', status: 'todo' } };
    const editButton = { dataset: { action: 'todo-edit' } };
    const editTarget = {
      closest(selector: string) {
        if (selector === '.project-todo-item') return row;
        if (selector === '[data-action="todo-edit"]') return editButton;
        return null;
      },
    };

    // Clicking the card title opens the shared editor directly; the restored
    // overflow menu remains a separate explicit target.
    await listeners.click({ target: editTarget });
    expect(editor.hidden).toBe(false);
    expect(input.value).toBe('Old title');

    // A background run advances while the title editor is open. Saving the
    // title must preserve that newer status when the status field was untouched.
    currentTask = { ...currentTask, status: 'progress' };
    input.value = 'New title';
    await context._saveProjectTodoEditor();
    const updates = invocations.filter((call) => call.channel === 'projects.tasks.update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ projectId: 'p_test', taskId: 't_edit123abcd', title: 'New title' });
    expect(updates[0].payload.detail).toBeUndefined();
    expect(editor.hidden).toBe(true);
    expect(currentTask).toMatchObject({ title: 'New title', detail: 'Legacy detail stays intact', status: 'progress' });

    // Opening with no task is still create mode — Save creates, not updates.
    context._openProjectTodoEditor();
    input.value = 'Fresh task';
    await context._saveProjectTodoEditor();
    const creates = invocations.filter((call) => call.channel === 'projects.tasks.create');
    expect(creates).toHaveLength(1);
    expect(creates[0].payload).toMatchObject({ projectId: 'p_test', title: 'Fresh task' });
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
    expect(creates[0].payload).toMatchObject({ projectId: 'p_test', title: 'Task with file', taskId: draftTid });
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

  it('keeps the next project editor intact when an earlier attachment deletion finishes late', async () => {
    let resolveDelete!: (value: unknown) => void;
    const deletion = new Promise((resolve) => { resolveDelete = resolve; });
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
      window: { addEventListener() {}, orkas: { async invoke(channel: string) { return channel === 'projects.tasks.attachments.delete' ? deletion : { ok: true }; } } },
      _chatFileIconHtml: () => '<svg></svg>',
      t: (key: string) => key,
      escapeHtml: (value: unknown) => String(value == null ? '' : value),
      uiIconHtml: () => '<svg></svg>',
      setTimeout, clearTimeout,
    });
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test';", context);

    context._openProjectTodoEditor({ id: 't_abcabcabcabc', title: 'Has files', status: 'todo', attachments: ['a.txt', 'b.png'] });
    expect(attachWrap.hidden).toBe(false);
    expect(attachWrap.innerHTML).toContain('a.txt');
    expect(attachWrap.innerHTML).toContain('b.png');
    const pending = context._removeTodoEditorAttachment('a.txt');
    context._openProjectTodoEditor(
      { id: 't_defdefdefdef', title: 'Other project', status: 'todo', attachments: ['a.txt', 'c.png'] },
      { pid: 'p_other', tasks: [], agents: [] },
    );
    resolveDelete({ ok: true });
    await pending;
    expect(attachWrap.innerHTML).toContain('a.txt');
    expect(attachWrap.innerHTML).toContain('c.png');
    expect(attachWrap.innerHTML).not.toContain('b.png');
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
    vm.runInContext(source, context, { filename: 'project-detail.js' });

    // A background driver advance pushes its new conversation; it lands in the
    // shared list (like a human-started run) and the list re-renders.
    context._onProjectAdvance({ projectId: 'p_test', conversation: { conversation_id: 'c_drv1', project_id: 'p_test' } });
    expect(conversationsArr).toHaveLength(1);
    expect(conversationsArr[0]).toMatchObject({ conversation_id: 'c_drv1' });
    expect(renderCalls).toBe(1);
    // It also attaches the run observer so the conversation shows the in-progress
    // breathing badge, like a human-started run.
    expect(observed).toHaveLength(1);
    expect(observed[0].cid).toBe('c_drv1');
    expect(observed[0].opts).toMatchObject({ attachExisting: true });

    // Same cid again updates in place — never duplicates the running task.
    context._onProjectAdvance({ projectId: 'p_test', conversation: { conversation_id: 'c_drv1', project_id: 'p_test', title: 'x' } });
    expect(conversationsArr).toHaveLength(1);
    expect(conversationsArr[0]).toMatchObject({ title: 'x' });
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
    const events: any[] = [];
    const clicks: any[] = [];
    const input = { value: 'project question' };
    const button = { disabled: false };
    const Monitor = {
      click(name: string, payload: any) { clicks.push({ name, payload }); },
      event(name: string, payload: any) { events.push({ name, payload }); },
    };
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
      window: { addEventListener() {}, Monitor: true },
      Monitor,
      t: (key: string) => key,
      ensureModelConfigured: () => true,
      _chatModelTelemetryContext: () => ({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      }),
      _getQuotes: () => [],
      _referenceSnapshotsForQuotes: () => [],
      consumeChatUseSelections: () => [],
      getChatRecipient: () => ({ kind: 'commander' }),
      transformWithChatUse: (value: string) => value,
      applyRecipientPrefix: (value: string) => value,
      apiFetch: async () => ({ json: async () => ({ ok: false, error: 'create failed' }) }),
      uiAlert: async () => {},
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);

    await context._submitProjectChat();

    expect(events).toEqual([]);
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
      _clearQuotes() {},
      autoGrow() {},
      setView() {},
      setChatRecipient() {},
      async sendInCurrentConversation(content: string, extra: Record<string, unknown>) {
        sent.push({ content, extra });
      },
      setTimeout,
      clearTimeout,
    });
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
      _clearQuotes() {},
      autoGrow() {},
      setView() {},
      setChatRecipient() {},
      async sendInCurrentConversation(content: string, extra: Record<string, unknown>) {
        sent.push({ content, extra });
      },
      setTimeout,
      clearTimeout,
    });
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
      async sendInCurrentConversation(content: string, extra: any) {
        sent.push({ content, extra });
      },
      setTimeout,
      clearTimeout,
    });
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
    const events: any[] = [];
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
        Monitor: true,
        orkas: {
          async invoke(channel: string, payload: any) {
            invocations.push({ channel, payload });
            return { ok: true, discarded: true };
          },
        },
      },
      Monitor: {
        click() {},
        event(name: string, payload: any) { events.push({ name, payload }); },
      },
      conversations: [],
      t: (key: string) => key,
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
      _clearQuotes: () => { clearedQuotes += 1; },
      apiFetch: async (url: string) => ({
        json: async () => url.endsWith('/create')
          ? { ok: true, conversation: { conversation_id: 'c_failed_adopt', title: 'New task' } }
          : { ok: false, error: 'disk unavailable' },
      }),
      uiAlert: async (message: string) => { alerts.push(message); },
      renderConversationList() {},
      loadProjects() {},
      async sendInCurrentConversation() { sends += 1; },
      setTimeout,
      clearTimeout,
    });
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
    expect(alerts).toEqual(['chat.attach_adopt_failed']);
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
      async sendInCurrentConversation(content: string, extra: any) { sent.push({ content, extra }); },
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);

    await context._submitProjectChat();

    expect(sent).toEqual([{
      content: 'Review it',
      extra: { title_text: 'Review it', attachments: ['brief (1).pdf'] },
    }]);
    expect(cleared).toEqual(['projchat-p_test']);
  });

  it('blocks project chat when no model is configured without telemetry', async () => {
    const events: any[] = [];
    const clicks: any[] = [];
    const input = { value: 'project question' };
    const Monitor = {
      click(name: string, payload: any) { clicks.push({ name, payload }); },
      event(name: string, payload: any) { events.push({ name, payload }); },
    };
    const apiFetch = async () => {
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
      window: { addEventListener() {}, Monitor: true },
      Monitor,
      t: (key: string) => key,
      ensureModelConfigured: () => false,
      _chatModelTelemetryContext: () => ({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      }),
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
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);

    await context._submitProjectChat();

    expect(clicks).toEqual([]);
    expect(events).toEqual([]);
  });
});
