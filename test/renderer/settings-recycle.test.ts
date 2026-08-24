import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const settingsSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/settings.js'),
  'utf8',
);
const styleSource = readFileSync(resolve(__dirname, '../../src/renderer/style.css'), 'utf8');

const translations: Record<string, string> = {
  'settings.recycle.tab_cloud': '历史',
  'settings.recycle.tab_local': '本地',
  'settings.recycle.tabs_aria': '删除记录来源',
  'settings.recycle.empty_cloud': '暂无历史删除记录',
  'settings.recycle.empty_local': '暂无本地删除记录',
  'settings.recycle.deleted_at': '{date}',
  'settings.recycle.view': '查看',
  'settings.recycle.collapse': '收起',
  'settings.recycle.restore': '恢复',
  'settings.recycle.delete': '删除',
  'settings.recycle.display_group': '{type}：{items}',
  'settings.recycle.display_group_joiner': '；',
  'settings.recycle.display_with_detail': '{title}（{detail}）',
  'settings.recycle.display_conversation': '任务',
  'settings.recycle.display_file': '文件',
  'settings.recycle.display_other': '其他',
  'settings.recycle.display_unknown': '已删除项目',
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function loadHarness(batches: Array<Record<string, unknown>>) {
  let clickListener: ((event: any) => Promise<void>) | undefined;
  const body: any = {
    innerHTML: '',
    addEventListener(type: string, listener: (event: any) => Promise<void>) {
      if (type === 'click') clickListener = listener;
    },
  };
  const recycleBin = {
    list: vi.fn(async () => ({ ok: true, batches })),
    restore: vi.fn(async () => ({ ok: true, restored: 1 })),
    delete: vi.fn(async () => ({ ok: true, deleted: true })),
  };
  const sandbox: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    t: (key: string) => translations[key] || key,
    escapeHtml,
    getLang: () => 'zh',
    document: {
      documentElement: { lang: 'zh' },
      getElementById: (id: string) => (id === 'settings-recycle-body' ? body : null),
      querySelectorAll: () => [],
    },
    window: {
      addEventListener: vi.fn(),
      orkas: { recycleBin, invoke: vi.fn() },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
  };
  vm.runInNewContext(settingsSource, sandbox, { filename: 'settings.js' });
  return { sandbox, body, recycleBin, getClickListener: () => clickListener };
}

describe('Settings recycle bin', () => {
  const repeatedTitle = '@ContentWriter 最近关于模型即应用';
  const batch = {
    id: 'batch-1',
    source: 'app',
    created_at_ms: Date.UTC(2026, 7, 23, 9, 22, 53),
    display_title: `${repeatedTitle}；${repeatedTitle}；${repeatedTitle}`,
    display_items: [
      { category: 'conversation', id: 'gconv-a', title: repeatedTitle, path: 'cloud/chats/gconv-a/chat.jsonl' },
      { category: 'conversation', id: 'gconv-a', title: repeatedTitle, path: 'cloud/sessions/gconv-a.jsonl' },
      { category: 'conversation', id: 'gconv-a', title: repeatedTitle, path: 'cloud/sessions/gconv-a.tool-results' },
      { category: 'conversation', id: 'gconv-b', title: '第二个任务', path: 'cloud/chats/gconv-b/chat.jsonl' },
      { category: 'conversation', id: 'gconv-c', title: '第三个任务', path: 'cloud/chats/gconv-c/chat.jsonl' },
      { category: 'conversation', id: 'gconv-d', title: '第四个任务', path: 'cloud/chats/gconv-d/chat.jsonl' },
      { category: 'conversation', id: 'gconv-e', title: '第五个任务', path: 'cloud/chats/gconv-e/chat.jsonl' },
    ],
  };

  it('renders batches inside the bounded scrolling viewport', async () => {
    const { sandbox, body } = loadHarness([batch]);

    await sandbox._settingsRefreshRecycleBin();

    expect(body.innerHTML).toContain('class="settings-recycle-scroll"');
    expect(body.innerHTML).toContain('data-recycle-source="app"');
    expect(body.innerHTML).toContain('data-recycle-tab="cloud_sync"');
    expect(body.innerHTML).toContain('data-recycle-tab="app"');
  });

  it('uses structured display items, removes duplicate titles, and bounds the summary', async () => {
    const { sandbox, body } = loadHarness([batch]);

    await sandbox._settingsRefreshRecycleBin();

    const titleMatches = body.innerHTML.match(new RegExp(repeatedTitle, 'g')) || [];
    expect(titleMatches).toHaveLength(1);
    expect(body.innerHTML).not.toContain(batch.display_title);
    expect(body.innerHTML).toContain('任务：');
    expect(body.innerHTML).toContain('+2');
  });

  it('keeps the compact summary by default and exposes deduplicated details on demand', async () => {
    const { sandbox, body, getClickListener } = loadHarness([batch]);
    sandbox._settingsBindRecycleBinOnce();
    await sandbox._settingsRefreshRecycleBin();
    expect(body.innerHTML).not.toContain('settings-recycle-details');

    const viewButton = {
      getAttribute: (name: string) => (name === 'data-recycle-view' ? 'batch-1' : ''),
    };
    await getClickListener()!({
      target: {
        closest(selector: string) {
          return selector === '[data-recycle-view]' ? viewButton : null;
        },
      },
    });

    expect(body.innerHTML).toContain('settings-recycle-details');
    expect(body.innerHTML).toContain('chats/gconv-a/chat.jsonl');
    expect(body.innerHTML).toContain('aria-expanded="true"');
  });

  it('defines one bounded scroll rule and clamps row summaries to two lines', () => {
    expect(styleSource.match(/\.settings-recycle-body\s*\{/g)).toHaveLength(1);
    expect(styleSource).toMatch(/\.settings-recycle-scroll\s*\{[^}]*max-height:\s*min\(320px, 42vh\)[^}]*overflow-y:\s*auto/s);
    expect(styleSource).toMatch(/\.settings-recycle-name\s*\{[^}]*-webkit-line-clamp:\s*2[^}]*overflow:\s*hidden/s);
  });
});
