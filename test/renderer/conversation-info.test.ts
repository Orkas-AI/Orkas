import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type RenderFilesResult = {
  html: string;
  counts: {
    files: string;
    tasks: string;
    attachments: string;
  };
};

function renderFilesResult(snapshot: {
  history: any[];
  plan?: any;
  planControl?: any;
  files: any;
  syncEnabled?: boolean;
  activeTab?: 'tasks' | 'files' | 'attachments';
}, afterMount?: (context: any) => Promise<void> | void): Promise<RenderFilesResult> {
  const elements = new Map<string, any>();
  const getEl = (id: string) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        hidden: false,
        innerHTML: '',
        textContent: '',
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
        if (url.includes('/plan')) return { ok: true, plan: snapshot.plan || null, control: snapshot.planControl || null };
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
      orkas: {
        sync: {
          getEnabled: async () => ({ ok: true, enabled: snapshot.syncEnabled === true }),
        },
      },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');
  vm.runInContext(source, context);
  context.window.ConversationInfo.bind('c1');
  const tabIndex = snapshot.activeTab === 'tasks' ? 0 : snapshot.activeTab === 'attachments' ? 2 : 1;
  (tabs[tabIndex] as any).onclick();
  getEl('conversation-info-toggle').onclick();
  return new Promise((resolve, reject) => setTimeout(async () => {
    try {
      if (afterMount) await afterMount(context);
      resolve({
        html: getEl('conversation-info-body').innerHTML,
        counts: {
          files: String(getEl('conversation-info-tab-count-files').textContent || ''),
          tasks: String(getEl('conversation-info-tab-count-tasks').textContent || ''),
          attachments: String(getEl('conversation-info-tab-count-attachments').textContent || ''),
        },
      });
    } catch (err) {
      reject(err);
    }
  }, 0));
}

function renderFilesHtml(snapshot: {
  history: any[];
  plan?: any;
  planControl?: any;
  files: any;
  syncEnabled?: boolean;
  activeTab?: 'tasks' | 'files' | 'attachments';
}, afterMount?: (context: any) => Promise<void> | void): Promise<string> {
  return renderFilesResult(snapshot, afterMount).then((result) => result.html);
}

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
    expect(html).toContain('conversation-info-file-menu-btn');
    expect(html).toContain('data-entry-kind="dir"');
    expect(html).toContain('data-entry-kind="file"');
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|>|=)/);
  });

  it('refreshes the files tab without reloading the whole side panel', async () => {
    const snapshot = {
      history: [] as any[],
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 1,
        items: [
          {
            path: '/tmp/workspace/old.txt',
            relPath: 'old.txt',
            name: 'old.txt',
            bytes: 4,
            mtime: 1700000000000,
          },
        ],
      },
    };
    const html = await renderFilesHtml(snapshot, async (context) => {
      snapshot.files = {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 1,
        items: [
          {
            path: '/tmp/workspace/new.txt',
            relPath: 'new.txt',
            name: 'new.txt',
            bytes: 8,
            mtime: 1700000001000,
          },
        ],
      };
      await context.window.ConversationInfo.refreshFiles('c1', { silent: true });
    });

    expect(html).toContain('new.txt');
    expect(html).not.toContain('old.txt');
  });

  it('counts deduped visible files instead of adding workspace and history rows', async () => {
    const result = await renderFilesResult({
      history: [
        { produced: ['/tmp/workspace/calc.html'] },
      ],
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 1,
        items: [
          {
            path: '/tmp/workspace/calc.html',
            relPath: 'calc.html',
            name: 'calc.html',
            bytes: 42,
            mtime: 1700000000000,
          },
        ],
      },
    });

    expect((result.html.match(/data-file-path=/g) || []).length).toBe(1);
    expect(result.counts.files).toBe('1');
  });

  it('shows a cloud-sync scope note above the file list when sync is enabled', async () => {
    const html = await renderFilesHtml({
      syncEnabled: true,
      history: [],
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 1,
        items: [
          {
            path: '/tmp/workspace/report.md',
            relPath: 'report.md',
            name: 'report.md',
            bytes: 42,
            mtime: 1700000000000,
          },
        ],
      },
    });

    expect(html).toContain('ci-files-sync-note');
    expect(html).toContain('Cloud sync does not include these files');
  });
});

describe('ConversationInfo tasks tab', () => {
  it('renders the unified plan control in the progress area without legacy step actions', async () => {
    const html = await renderFilesHtml({
      activeTab: 'tasks',
      history: [],
      planControl: { action: 'continue' },
      plan: {
        steps: [
          { index: 1, title: '搜集', assignee: 'Alpha', status: 'done' },
          { index: 2, title: '分析', assignee: 'Beta', status: 'failed', failure_reason: 'fetch failed' },
        ],
      },
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 0,
        items: [],
      },
    });

    expect(html).toContain('id="ci-tasks-plan-control"');
    expect(html).toContain('data-plan-action="continue"');
    expect(html).toContain('Continue');
    expect(html).not.toContain('Retry');
    expect(html).not.toContain('Skip');
    expect(html).not.toContain('Stop all');
    expect(html).not.toContain('停止全部');
  });

  it('renders blocked plan steps as waiting for input instead of failed', async () => {
    const html = await renderFilesHtml({
      activeTab: 'tasks',
      history: [],
      plan: {
        steps: [
          { index: 1, title: '先收集最小诊断证据', assignee: 'FamilyTutor', status: 'blocked' },
          { index: 2, title: '分析数学学习问题类型', assignee: 'MathTutor', status: 'pending' },
        ],
      },
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 0,
        items: [],
      },
    });

    expect(html).toContain('ci-tasks-bar-cell is-blocked');
    expect(html).not.toContain('ci-tasks-bar-cell is-failed');
    expect(html).toContain('ci-tasks-step is-blocked');
    expect(html).toContain('[document-pencil]');
    expect(html).not.toContain('[x]');
  });

  it('keeps fully completed plans visible in the task details tab', async () => {
    const result = await renderFilesResult({
      activeTab: 'tasks',
      history: [],
      plan: {
        steps: [
          { index: 1, title: '搜集资料', assignee: 'Alpha', status: 'done' },
          { index: 2, title: '整理结论', assignee: 'Beta', status: 'done' },
        ],
      },
      planControl: { action: null },
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 0,
        items: [],
      },
    });

    expect(result.html).toContain('ci-tasks');
    expect(result.html).toContain('搜集资料');
    expect(result.html).toContain('整理结论');
    expect(result.html).toContain('ci-tasks-step is-done');
    expect(result.html).not.toContain('id="ci-tasks-plan-control"');
    expect(result.counts.tasks).toBe('2/2');
  });
});
