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
  pendingAttachments?: any[];
  historyError?: string;
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
        if (url.includes('/history')) {
          if (snapshot.historyError) return { ok: false, error: snapshot.historyError };
          return { ok: true, conversation: { title: 'Current title' }, history: snapshot.history };
        }
        if (url.includes('/files')) return { ok: true, ...snapshot.files };
        if (url.includes('/attachments')) return {
          ok: true,
          items: new URL(url, 'https://orkas.test').searchParams.get('scope') === 'all'
            ? snapshot.attachments || []
            : snapshot.pendingAttachments || snapshot.attachments || [],
        };
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
  pendingAttachments?: any[];
  activeTab?: 'files' | 'attachments';
}, afterMount?: (context: any) => Promise<void> | void): Promise<string> {
  return renderFilesResult(snapshot, afterMount).then((result) => result.html);
}

describe('ConversationInfo files tab', () => {
  it('lists old sent attachments outside the recent history page alongside pending uploads', async () => {
    const result = await renderFilesResult({
      activeTab: 'attachments',
      history: [{ role: 'assistant', text: 'Recent reply without attachments' }],
      files: { items: [] },
      attachments: [{ name: 'old-brief.txt', bytes: 64 }, { name: 'next-image.png', bytes: 32 }],
      pendingAttachments: [{ name: 'next-image.png', bytes: 32 }],
    });
    expect(result.html).toContain('old-brief.txt');
    expect(result.html).toContain('next-image.png');
    expect(result.counts.attachments).toBe('2');
  });

  it('loads a saved spreadsheet when entering Attachments from Browser with a stale inventory', async () => {
    const snapshot = { history: [], files: { items: [] }, attachments: [] as Array<{ name: string; bytes: number }> };
    const result = await renderFilesResult(snapshot, async context => {
      context.window.ConversationInfo.openAndSetTab('browser');
      snapshot.attachments = [{ name: 'database-export.xls', bytes: 4096 }];
      await context.document.querySelectorAll('.conversation-info-tab')[1].onclick();
    });
    expect(result.html).toContain('data-attachment-name="database-export.xls"');
    expect(result.counts.attachments).toBe('1');
  });

  it('keeps sent attachments when the composer clears and removes deleted files on refresh', async () => {
    const snapshot = {
      activeTab: 'attachments' as const,
      history: [], files: { items: [] },
      attachments: [{ name: 'old-brief.txt' }, { name: 'new-upload.txt' }],
      pendingAttachments: [] as any[],
    };
    await renderFilesResult(snapshot, async context => {
      const info = context.window.ConversationInfo;
      const body = context.document.getElementById('conversation-info-body');
      await info.refreshAttachments('c1', { items: [] });
      expect(body.innerHTML).toContain('old-brief.txt');
      expect(body.innerHTML).toContain('new-upload.txt');
      snapshot.attachments = [{ name: 'old-brief.txt' }];
      await info.refreshAttachments('c1', { items: [] });
      expect(body.innerHTML).toContain('old-brief.txt');
      expect(body.innerHTML).not.toContain('new-upload.txt');
      expect(context.document.getElementById('conversation-info-tab-count-attachments').textContent).toBe('1');
    });
  });

  it('rejects stale attachment refreshes and responses for a previous task', async () => {
    await renderFilesResult({ activeTab: 'attachments', history: [], files: { items: [] } }, async context => {
      const info = context.window.ConversationInfo;
      const body = context.document.getElementById('conversation-info-body');
      const replies: Array<(value: any) => void> = [];
      const apiFetch = context.apiFetch;
      context.apiFetch = () => new Promise(resolve => replies.push(resolve));
      const first = info.refreshAttachments('c1');
      const second = info.refreshAttachments('c1');
      replies[1]({ json: async () => ({ ok: true, items: [{ name: 'latest.txt' }] }) });
      await second;
      replies[0]({ json: async () => ({ ok: true, items: [{ name: 'stale.txt' }] }) });
      await first;
      expect(body.innerHTML).toContain('latest.txt');
      expect(body.innerHTML).not.toContain('stale.txt');
      const previousTask = info.refreshAttachments('c1');
      info.bind('c2');
      context.apiFetch = apiFetch;
      info.openAndSetTab('attachments');
      await info.refresh('c2');
      replies[2]({ json: async () => ({ ok: true, items: [{ name: 'foreign.txt' }] }) });
      await previousTask;
      expect(body.innerHTML).not.toContain('foreign.txt');
    });
  });

  it.each(['files', 'attachments'] as const)('keeps the newer %s refresh when an older full panel load finishes last', async resource => {
    await renderFilesResult({ history: [], files: { items: [] }, activeTab: resource }, async context => {
      const info = context.window.ConversationInfo;
      const body = context.document.getElementById('conversation-info-body');
      const originalFetch = context.apiFetch;
      let resolveOld!: (value: any) => void;
      const item = (name: string) => ({ name, relPath: name, path: '/tmp/workspace/' + name, bytes: 4 });
      context.apiFetch = (url: string) => url.includes('/' + resource)
        ? new Promise(resolve => { resolveOld = resolve; }) : originalFetch(url);
      const oldFull = info.refresh('c1', { silent: true });
      context.apiFetch = async (url: string) => url.includes('/' + resource)
        ? { json: async () => ({ ok: true, items: [item('latest.txt')], count: 1 }) } : originalFetch(url);
      await (resource === 'files' ? info.refreshFiles('c1', { silent: true }) : info.refreshAttachments('c1'));
      resolveOld({ json: async () => ({ ok: true, items: [item('obsolete.txt')], count: 1 }) });
      await oldFull;
      expect(body.innerHTML).toContain('latest.txt');
      expect(body.innerHTML).not.toContain('obsolete.txt');
      expect(context.document.getElementById('conversation-info-tab-count-' + resource).textContent).toBe('1');
    });
  });

  it.each(['attachment-only', 'full-panel'] as const)('shows a saved attachment when a later %s refresh fails', async refreshKind => {
    await renderFilesResult({ activeTab: 'attachments', history: [], files: { items: [] } }, async context => {
      const info = context.window.ConversationInfo;
      const originalFetch = context.apiFetch;
      let deliverInventory!: (response: unknown) => void;
      context.apiFetch = (url: string) => url.includes('/attachments')
        ? new Promise(resolve => { deliverInventory = resolve; }) : originalFetch(url);
      const panelLoad = info.refresh('c1', { silent: true });
      context.apiFetch = (url: string) => url.includes('/attachments')
        ? Promise.resolve({ json: async () => ({ ok: false, error: 'Temporarily unavailable' }) }) : originalFetch(url);
      if (refreshKind === 'attachment-only') await info.refreshAttachments('c1');
      else await info.refresh('c1', { silent: true });
      deliverInventory({ json: async () => ({ ok: true, items: [{ name: 'saved-roster.csv', bytes: 120 }] }) });
      await panelLoad;
      expect(context.document.getElementById('conversation-info-body').innerHTML).toContain('saved-roster.csv');
      expect(context.document.getElementById('conversation-info-tab-count-attachments').textContent).toBe('1');
      await info.refresh('c1', { silent: true });
      expect(context.document.getElementById('conversation-info-body').innerHTML).toContain('saved-roster.csv');
    });
  });

  it.each([
    { items: [{ name: 'saved-roster.csv', bytes: 120 }], expected: 'saved-roster.csv', count: '1' },
    { items: [], expected: 'No attachments', count: '' },
  ])('shows the confirmed attachment inventory with $count visible files when history fails', async ({ items, expected, count }) => {
    await renderFilesResult({
      history: [], files: { items: [] }, attachments: items, activeTab: 'attachments',
      historyError: 'History unavailable',
    }, async context => {
      const body = context.document.getElementById('conversation-info-body');
      const info = context.window.ConversationInfo;
      expect(body.innerHTML).toContain(expected);
      expect(body.innerHTML).not.toContain('is-error');
      expect(context.document.getElementById('conversation-info-tab-count-attachments').textContent).toBe(count);
      await info.refreshAttachments('c1');
      expect(body.innerHTML).toContain(expected);

      context.document.querySelectorAll('.conversation-info-tab')[0].onclick();
      await info.refresh('c1');
      expect(body.innerHTML).toContain('is-error');
    });
  });

  it.each(['files', 'attachments'] as const)('keeps a newer full panel load when an older %s refresh finishes last', async resource => {
    await renderFilesResult({ history: [], files: { items: [] }, activeTab: resource }, async context => {
      const info = context.window.ConversationInfo;
      const body = context.document.getElementById('conversation-info-body');
      const originalFetch = context.apiFetch;
      let resolveOld!: (value: any) => void;
      const item = (name: string) => ({ name, relPath: name, path: '/tmp/workspace/' + name, bytes: 4 });
      context.apiFetch = (url: string) => url.includes('/' + resource)
        ? new Promise(resolve => { resolveOld = resolve; }) : originalFetch(url);
      const oldPartial = resource === 'files' ? info.refreshFiles('c1', { silent: true }) : info.refreshAttachments('c1');
      context.apiFetch = async (url: string) => url.includes('/' + resource)
        ? { json: async () => ({ ok: true, items: [item('latest.txt')], count: 1 }) } : originalFetch(url);
      await info.refresh('c1', { silent: true });
      resolveOld({ json: async () => ({ ok: true, items: [item('obsolete.txt')], count: 1 }) });
      await oldPartial;
      expect(body.innerHTML).toContain('latest.txt');
      expect(body.innerHTML).not.toContain('obsolete.txt');
      expect(context.document.getElementById('conversation-info-tab-count-' + resource).textContent).toBe('1');
    });
  });

  it('restores each task panel visibility and selected tab after switching away and back', async () => {
    await renderFilesResult({ history: [], files: { items: [] } }, context => {
      const info = context.window.ConversationInfo;
      const panel = context.document.getElementById('conversation-info-panel');
      const body = context.document.getElementById('conversation-info-body');
      info.openAndSetTab('browser');
      info.bind('c2');
      expect(panel.hidden).toBe(true);
      expect(body.hidden).toBe(false);
      info.openAndSetTab('attachments');
      info.bind('c1');
      expect(panel.hidden).toBe(false);
      expect(body.hidden).toBe(true);
      info.close();
      info.bind('c2');
      expect(panel.hidden).toBe(false);
      expect(body.hidden).toBe(false);
      info.bind('c1');
      expect(panel.hidden).toBe(true);
      info.open();
      expect(body.hidden).toBe(true);
      info.unbind();
      expect(panel.hidden).toBe(true);
      info.bind('c1');
      expect(panel.hidden).toBe(false);
      expect(body.hidden).toBe(true);
      // A same-task view refresh must also preserve visibility.
      info.bind('c1');
      expect(panel.hidden).toBe(false);
    });
  });

  it('only reveals a task-scoped browser in the currently displayed and bound task', async () => {
    await renderFilesResult({ history: [], files: { items: [] } }, context => {
      const info = context.window.ConversationInfo;
      const panel = context.document.getElementById('conversation-info-panel');
      context.currentView = 'conversation';
      context.currentCid = 'b';
      info.bind('b');
      info.openAndSetTab('browser', 'a');
      expect(panel.hidden).toBe(true);
      // During navigation the panel can still be bound to the previous task.
      info.bind('a');
      info.openAndSetTab('browser', 'a');
      expect(panel.hidden).toBe(true);
      context.currentView = 'settings';
      context.currentCid = 'a';
      info.openAndSetTab('browser', 'a');
      expect(panel.hidden).toBe(true);
      context.currentView = 'conversation';
      expect(info.openAndSetTab('browser', 'a')).toBe(true);
      expect(panel.hidden).toBe(false);
      info.close();
      info.openAndSetTab('files');
      expect(panel.hidden).toBe(false);
    });
  });

  it('dismisses only the owning browser and remembers background dismissal without changing Files or Attachments', async () => {
    await renderFilesResult({ history: [], files: { items: [] } }, context => {
      const info = context.window.ConversationInfo;
      const panel = context.document.getElementById('conversation-info-panel');
      const body = context.document.getElementById('conversation-info-body');
      info.openAndSetTab('browser');
      info.closeBrowserForTask('c1');
      expect(panel.hidden).toBe(true);
      // Returning to the task must retain the automatic dismissal.
      info.bind('c2');
      info.bind('c1');
      expect(panel.hidden).toBe(true);
      info.openAndSetTab('browser');
      info.bind('c2');
      info.openAndSetTab('browser');
      info.closeBrowserForTask('c1');
      expect(panel.hidden).toBe(false);
      info.bind('c1');
      expect(panel.hidden).toBe(true);
      for (const tab of ['files', 'attachments']) {
        info.openAndSetTab(tab);
        info.closeBrowserForTask('c1');
        expect(panel.hidden).toBe(false);
        expect(body.hidden).toBe(false);
        info.bind('c2');
        info.closeBrowserForTask('c1');
        info.bind('c1');
        expect(panel.hidden).toBe(false);
        expect(body.hidden).toBe(false);
      }
    });
  });

  // Membership now arrives already merged from
  // `features/conversation_outputs.ts`; what the panel still owns is where each
  // entry lands. A file written outside the workspace has no tree position, and
  // hanging it off the tree root made it read as a workspace file.
  it('puts workspace files in the tree and everything else in its own group', async () => {
    const html = await renderFilesHtml({
      history: [],
      files: {
        rootExists: true,
        truncated: false,
        count: 3,
        items: [
          {
            origin: 'workspace',
            path: '/tmp/workspace/batch/skill_large-batch.md',
            relPath: 'batch/skill_large-batch.md',
            name: 'skill_large-batch.md',
            bytes: 12,
            mtime: 1700000000000,
          },
          {
            origin: 'outside',
            path: '/tmp/outside.md',
            relPath: '',
            name: 'outside.md',
            bytes: 8,
            mtime: 1700000001000,
          },
          {
            origin: 'artifact',
            artifactId: 'a_calc',
            title: 'Pricing calculator',
            name: 'Pricing calculator',
            relPath: '',
            bytes: 4096,
            mtime: 1700000002000,
          },
        ],
      },
    });

    expect(html).toContain('batch');
    expect(html).toContain('skill_large-batch.md');
    expect(html).toContain('draggable="true"');
    expect(html).toContain('ctx-row-menu-btn conversation-info-file-menu-btn');
    expect(html).toContain('[more-horizontal]');
    expect(html).toContain('data-entry-kind="dir"');
    expect(html).toContain('data-entry-kind="text"');
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|>|=)/);

    // The stray file keeps its full path (a basename cannot tell two apart)
    // and is marked so it never reads as part of the tree above it.
    expect(html).toContain('/tmp/outside.md');
    expect(html).toContain('conversation-info-file is-outside');
    // The artifact opens through the `chat-app://` frame, so it carries an id
    // and no file path.
    expect(html).toContain('data-artifact-id="a_calc"');
    expect(html).toContain('Pricing calculator');
    expect(html).not.toContain('data-file-path="undefined"');
    // Both extra groups render after the workspace tree.
    expect(html.indexOf('conversation-info-group'))
      .toBeGreaterThan(html.indexOf('skill_large-batch.md'));
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

  it('keeps an expanded directory open while the live file list refreshes', async () => {
    const snapshot = {
      history: [] as any[],
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 1,
        items: [
          {
            path: '/tmp/workspace/project/old.txt',
            relPath: 'project/old.txt',
            name: 'old.txt',
            bytes: 4,
            mtime: 1700000000000,
          },
        ],
      },
    };
    const html = await renderFilesHtml(snapshot, async (context) => {
      const body = context.document.getElementById('conversation-info-body');
      body.querySelectorAll = (selector: string) => selector === '.conversation-info-dir[data-directory-key]'
        ? [{ open: true, dataset: { directoryKey: '/tmp/workspace/project' } }]
        : [];
      snapshot.files = {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 1,
        items: [
          {
            path: '/tmp/workspace/project/new.txt',
            relPath: 'project/new.txt',
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
    expect(html).toMatch(
      /<details[^>]*data-directory-key="\/tmp\/workspace\/project"[^>]*\sopen(?:\s|>)/,
    );
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

  // The tab badge is the user's cue that a turn produced something. An
  // artifact is one of those things, so leaving it out of the count would
  // report "no files" for a conversation that just built an app.
  it('counts every listed output, artifacts included', async () => {
    const result = await renderFilesResult({
      history: [],
      files: {
        rootExists: true,
        truncated: false,
        count: 2,
        items: [
          {
            origin: 'workspace',
            path: '/tmp/workspace/calc.html',
            relPath: 'calc.html',
            name: 'calc.html',
            bytes: 42,
            mtime: 1700000000000,
          },
          {
            origin: 'artifact',
            artifactId: 'a_calc',
            title: 'Pricing calculator',
            name: 'Pricing calculator',
            relPath: '',
            bytes: 4096,
            mtime: 1700000002000,
          },
        ],
      },
    });

    expect((result.html.match(/data-file-path=/g) || []).length).toBe(1);
    expect((result.html.match(/data-artifact-id=/g) || []).length).toBe(1);
    expect(result.counts.files).toBe('2');
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


it('has no hosted sync-setting stub, notice or fixture dependency while ordinary files stay visible', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');
  expect(source).not.toMatch(/_loadSyncEnabled|syncEnabled|ci-files-sync-note/);
  const html = await renderFilesHtml({ history: [], files: { items: [
    { path: '/tmp/workspace/report.md', name: 'report.md', relPath: 'report.md', bytes: 42 },
  ] } });
  expect(html).toContain('report.md');
  expect(html).not.toContain('ci-files-sync-note');
});
