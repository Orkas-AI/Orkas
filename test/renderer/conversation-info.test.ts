import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type RenderFilesResult = {
  html: string;
  counts: {
    files: string;
    attachments: string;
  };
};

function renderFilesResult(snapshot: {
  history: any[];
  files: any;
  attachments?: any[];
  syncEnabled?: boolean;
  activeTab?: 'files' | 'attachments';
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
        if (url.includes('/files')) return { ok: true, ...snapshot.files };
        if (url.includes('/attachments')) return { ok: true, items: snapshot.attachments || [] };
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
  const policySource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/file-operation-policy.js'), 'utf8');
  vm.runInContext(policySource, context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');
  vm.runInContext(source, context);
  context.window.ConversationInfo.bind('c1');
  const tabIndex = snapshot.activeTab === 'attachments' ? 1 : 0;
  (tabs[tabIndex] as any).onclick();
  getEl('conversation-info-toggle').onclick();
  return new Promise((resolve, reject) => setTimeout(async () => {
    try {
      if (afterMount) await afterMount(context);
      resolve({
        html: getEl('conversation-info-body').innerHTML,
        counts: {
          files: String(getEl('conversation-info-tab-count-files').textContent || ''),
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
  files: any;
  attachments?: any[];
  syncEnabled?: boolean;
  activeTab?: 'files' | 'attachments';
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
    expect(html).toContain('data-entry-kind="text"');
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|>|=)/);
  });

  it('marks unsupported workspace files distinctly for Library menu filtering', async () => {
    const html = await renderFilesHtml({
      history: [],
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 3,
        items: [
          { path: '/tmp/workspace/archive.zip', relPath: 'archive.zip', name: 'archive.zip', bytes: 10, mtime: 1700000000000 },
          { path: '/tmp/workspace/slides.pptx', relPath: 'slides.pptx', name: 'slides.pptx', bytes: 10, mtime: 1700000000000 },
          { path: '/tmp/workspace/movie.mp4', relPath: 'movie.mp4', name: 'movie.mp4', bytes: 10, mtime: 1700000000000 },
        ],
      },
    });

    expect(html).toContain('data-entry-name="archive.zip"');
    expect(html).toContain('data-entry-kind="unsupported"');
    expect(html).toContain('data-entry-kind="presentation"');
    expect(html).toContain('data-entry-kind="video"');
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

  it('clears file loading when a silent refresh supersedes a visible refresh', async () => {
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
      let fetchCount = 0;
      context.apiFetch = async (url: string) => {
        fetchCount += 1;
        const slowVisibleRefresh = fetchCount <= 1;
        const payload = url.includes('/history')
          ? { ok: true, conversation: { title: 'Current title' }, history: [] }
          : {
              ok: true,
              root: '/tmp/workspace',
              rootExists: true,
              truncated: false,
              count: 1,
              items: [
                {
                  path: slowVisibleRefresh ? '/tmp/workspace/old.txt' : '/tmp/workspace/new.txt',
                  relPath: slowVisibleRefresh ? 'old.txt' : 'new.txt',
                  name: slowVisibleRefresh ? 'old.txt' : 'new.txt',
                  bytes: slowVisibleRefresh ? 4 : 8,
                  mtime: slowVisibleRefresh ? 1700000000000 : 1700000001000,
                },
              ],
            };
        const response = { json: async () => payload };
        if (!slowVisibleRefresh) return response;
        return new Promise((resolve) => setTimeout(() => resolve(response), 25));
      };

      const visibleRefresh = context.window.ConversationInfo.refreshFiles('c1');
      expect(context.document.getElementById('conversation-info-body').innerHTML).toContain('Loading');
      await context.window.ConversationInfo.refreshFiles('c1', { silent: true });
      await visibleRefresh;
    });

    expect(html).toContain('new.txt');
    expect(html).not.toContain('Loading');
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

  it('does not show internal attachment kind labels in the attachment row meta', async () => {
    const html = await renderFilesHtml({
      activeTab: 'attachments',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [
        {
          name: 'grades.xlsx',
          displayName: '初中几何成绩下滑-沟通准备.xlsx',
          kind: 'spreadsheet',
          bytes: 0,
          mtime: Math.floor(new Date('2026-06-23T14:46:00Z').getTime() / 1000),
        },
      ],
    });

    expect(html).toContain('初中几何成绩下滑-沟通准备.xlsx');
    expect(html).toContain('XLS');
    expect(html).not.toContain('spreadsheet');
  });
});
