import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function renderTaskHtml(snapshot: {
  history: any[];
  plan: any;
  members: any[];
}): Promise<string> {
  const elements = new Map<string, any>();
  const getEl = (id: string) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        hidden: false,
        innerHTML: '',
        dataset: {},
        classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {},
        addEventListener(type: string, fn: () => void) { this[`on${type}`] = fn; },
      });
    }
    return elements.get(id);
  };

  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    Date,
    Map,
    Array,
    String,
    Number,
    RegExp,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    t: (key: string) => ({
      'conversation_info.status.pending': 'Pending',
      'conversation_info.status.in_progress': 'Running',
      'conversation_info.status.done': 'Done',
      'chat.recipient_commander': 'Commander',
      'chat.from_user': 'User',
    }[key] || key),
    escapeHtml: (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[c] || c)),
    conversations: [{ conversation_id: 'c1', title: 'Current title' }],
    apiFetch: async (url: string) => ({
      json: async () => {
        if (url.includes('/history')) return { ok: true, conversation: { title: 'Current title' }, history: snapshot.history };
        if (url.includes('/plan')) return { ok: true, plan: snapshot.plan };
        if (url.includes('/members')) return { ok: true, actors: snapshot.members };
        if (url.includes('/attachments')) return { ok: true, items: [] };
        return { ok: false, error: 'unknown' };
      },
    }),
    document: {
      readyState: 'complete',
      getElementById: getEl,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: {
      addEventListener() {},
      uiIconHtml: (name: string) => `[${name}]`,
      fileKindIconHtml: () => '',
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');
  vm.runInContext(source, context);
  context.window.ConversationInfo.bind('c1');
  getEl('conversation-info-toggle').onclick();
  return new Promise((resolve) => setTimeout(() => resolve(getEl('conversation-info-body').innerHTML), 0));
}

function statusTexts(html: string): string[] {
  return Array.from(html.matchAll(/conversation-info-status[^>]*>([^<]+)/g)).map((m) => m[1]);
}

function renderFilesHtml(snapshot: {
  history: any[];
  plan?: any;
  files: any;
}): Promise<string> {
  const elements = new Map<string, any>();
  const getEl = (id: string) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        hidden: false,
        innerHTML: '',
        dataset: {},
        classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {},
        addEventListener(type: string, fn: () => void) { this[`on${type}`] = fn; },
      });
    }
    return elements.get(id);
  };
  const tabs = [
    { dataset: { infoTab: 'tasks' }, classList: { toggle() {} }, addEventListener(type: string, fn: () => void) { (this as any)[`on${type}`] = fn; } },
    { dataset: { infoTab: 'files' }, classList: { toggle() {} }, addEventListener(type: string, fn: () => void) { (this as any)[`on${type}`] = fn; } },
    { dataset: { infoTab: 'attachments' }, classList: { toggle() {} }, addEventListener(type: string, fn: () => void) { (this as any)[`on${type}`] = fn; } },
  ];

  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    Date,
    Map,
    Array,
    String,
    Number,
    RegExp,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    t: (key: string) => key,
    escapeHtml: (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[c] || c)),
    conversations: [{ conversation_id: 'c1', title: 'Current title' }],
    apiFetch: async (url: string) => ({
      json: async () => {
        if (url.includes('/history')) return { ok: true, conversation: { title: 'Current title' }, history: snapshot.history };
        if (url.includes('/plan')) return { ok: true, plan: snapshot.plan || null };
        if (url.includes('/members')) return { ok: true, actors: [] };
        if (url.includes('/files')) return { ok: true, ...snapshot.files };
        if (url.includes('/attachments')) return { ok: true, items: [] };
        return { ok: false, error: 'unknown' };
      },
    }),
    document: {
      readyState: 'complete',
      getElementById: getEl,
      querySelectorAll: () => tabs,
      addEventListener() {},
    },
    window: {
      addEventListener() {},
      uiIconHtml: (name: string) => `[${name}]`,
      fileKindIconHtml: () => '',
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');
  vm.runInContext(source, context);
  context.window.ConversationInfo.bind('c1');
  (tabs[1] as any).onclick();
  getEl('conversation-info-toggle').onclick();
  return new Promise((resolve) => setTimeout(() => resolve(getEl('conversation-info-body').innerHTML), 0));
}

describe('ConversationInfo task status recovery', () => {
  it('infers completed statuses for older plan-announcement cards after a re-plan', async () => {
    const history = [
      { id: 'u1', from: 'user', text: 'old request' },
      {
        id: 'p1',
        from: 'commander',
        to: ['user'],
        plan_announcement: true,
        ts: '2026-01-01T00:00:00',
        text: 'Plan\n\n1. Collect candidates（@Researcher）\n2. Analyze candidates（@Analyst）\n3. Summarize（我自己）',
      },
      { id: 'd1', from: 'commander', to: ['a1'], dispatch: true, text: '@Researcher go' },
      { id: 'd2', from: 'commander', to: ['a2'], dispatch: true, text: '@Analyst go' },
      { id: 'a1out', from: 'a1', to: ['user'], text: 'collected' },
      { id: 'a2out', from: 'a2', to: ['user'], text: 'analyzed' },
      { id: 'cmdout', from: 'commander', to: ['user'], text: 'summary' },
      { id: 'u2', from: 'user', text: 'new request' },
      {
        id: 'p2',
        from: 'commander',
        to: ['user'],
        plan_announcement: true,
        ts: '2026-01-02T00:00:00',
        text: 'Plan\n\n1. New first（我自己）\n2. New second（@Analyst）',
      },
    ];
    const plan = {
      initial_message: 'new request',
      updated_at: '2026-01-02T00:10:00',
      steps: [
        { index: 1, title: 'New first', assignee: 'commander', status: 'done' },
        { index: 2, title: 'New second', assignee: 'Analyst', status: 'in_progress' },
      ],
    };
    const members = [
      { id: 'commander', name: 'Commander', kind: 'commander' },
      { id: 'user', name: 'User', kind: 'user' },
      { id: 'a1', name: 'Researcher', kind: 'agent' },
      { id: 'a2', name: 'Analyst', kind: 'agent' },
    ];

    const html = await renderTaskHtml({ history, plan, members });

    expect(statusTexts(html)).toEqual(['Done', 'Running', 'Done', 'Done', 'Done']);
  });
});

describe('ConversationInfo files tab', () => {
  it('renders the live workspace file listing and drops stale produced files under that root', async () => {
    const html = await renderFilesHtml({
      history: [
        { produced: ['/tmp/workspace/deleted.md', '/tmp/outside.md'] },
      ],
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 1,
        items: [
          {
            path: '/tmp/workspace/batch/skill_large-batch.md',
            relPath: 'batch/skill_large-batch.md',
            name: 'skill_large-batch.md',
            bytes: 12,
            mtime: 1700000000000,
          },
        ],
      },
    });

    expect(html).toContain('batch');
    expect(html).toContain('skill_large-batch.md');
    expect(html).toContain('/tmp/outside.md');
    expect(html).not.toContain('deleted.md');
    expect(html).toContain('draggable="true"');
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|>|=)/);
  });
});
