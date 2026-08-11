import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererDir = path.join(__dirname, '../../src/renderer');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf8');
const source = fs.readFileSync(path.join(rendererDir, 'modules/project-detail.js'), 'utf8');

describe('project to-do controls', () => {
  it('uses the shared side-card editor pattern instead of a compact input', () => {
    expect(html).toContain('class="project-todo-add project-memory-editor"');
    expect(html).toContain('<textarea class="project-memory-editor-input" id="project-todo-input"');
    expect(html).toContain('id="project-todo-counter"');
    expect(html).toContain('id="project-todo-cancel"');
    expect(html).toContain('id="project-todo-save"');
    expect(html).not.toContain('class="project-todo-input"');
    expect(styles).toContain('.project-todo-add:not([hidden]) ~ .project-todo-list');
    expect(styles).toContain('.project-todo-add:not([hidden]) ~ .empty');
    expect(styles).toContain('.project-todo-item:hover');
    expect(source).toContain('e.isComposing || e.keyCode === 229');
    expect(source).toContain("e.key === 'Enter' && (e.metaKey || e.ctrlKey)");
  });

  it('toggles a row directly between open and done while keeping delete isolated', async () => {
    expect(source).not.toContain("_projectTrackClick('project_todo_toggle'");
    expect(source).toContain("_projectTrackEvent('project_todo_toggle_result'");
    const invocations: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const listeners: Record<string, (event: any) => Promise<void>> = {};
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
      'project-todo-empty': { style: {} },
      'project-todo-count': { textContent: '' },
    };
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) { return elements[id] || null; },
        createElement() { return { appendChild() {}, className: '', dataset: {}, style: {} }; },
      },
      window: {
        addEventListener() {},
        orkas: {
          async invoke(channel: string, payload: Record<string, unknown>) {
            invocations.push({ channel, payload });
            if (channel === 'projects.tasks.list') return { ok: true, tasks: [] };
            return { ok: true };
          },
        },
      },
      t: (key: string) => key,
      uiAlert() {},
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'; _bindProjectTodos();", context);

    const row = { dataset: { tid: 't_123456789abc', status: 'todo' } };
    const titleTarget = {
      closest(selector: string) {
        return selector === '.project-todo-item' ? row : null;
      },
    };
    await listeners.click({ target: titleTarget });

    let updates = invocations.filter((call) => call.channel === 'projects.tasks.update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ taskId: row.dataset.tid, status: 'done' });

    row.dataset.status = 'done';
    await listeners.click({ target: titleTarget });
    updates = invocations.filter((call) => call.channel === 'projects.tasks.update');
    expect(updates).toHaveLength(2);
    expect(updates[1].payload).toMatchObject({ taskId: row.dataset.tid, status: 'todo' });

    const deleteButton = { dataset: { action: 'todo-delete' } };
    const deleteTarget = {
      closest(selector: string) {
        if (selector === '.project-todo-item') return row;
        if (selector === '[data-action="todo-delete"]') return deleteButton;
        return null;
      },
    };
    await listeners.click({ target: deleteTarget });

    expect(invocations.filter((call) => call.channel === 'projects.tasks.delete')).toHaveLength(1);
    expect(invocations.filter((call) => call.channel === 'projects.tasks.update')).toHaveLength(2);
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
