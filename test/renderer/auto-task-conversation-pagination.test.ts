import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/modules/auto.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');

describe('automation execution-history pagination', () => {
  it('shows loading for uncached local history, reports failure and recovers on retry', async () => {
    let release!: (value: unknown) => void;
    const warn = vi.fn();
    const context = vm.createContext({
      createLogger: () => ({ warn }),
      document: { readyState: 'loading', addEventListener() {} },
      window: { addEventListener() {}, orkas: { invoke: () => new Promise(resolve => { release = resolve; }) } },
      escapeHtml: (s: unknown) => String(s), t: (key: string) => key,
      _renderConversationTimeBucketList: (rows: any[]) => rows.map(row => row.title).join(','),
    });
    vm.runInContext(rendererSource, context);
    const container = { innerHTML: 'Saved execution', isConnected: true,
      closest: () => null, querySelector: () => null };
    context._autoRenderTaskConvs('task', container);
    expect(container.innerHTML).toContain('chat.loading');
    release({ ok: false, error: 'offline' });
    await vi.waitFor(() => expect(container.innerHTML).toContain('auto.load_failed'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('load task conversations failed');
    expect(warn.mock.calls[0][1].message).toBe('offline');
    context._autoRenderTaskConvs('task', container);
    expect(container.innerHTML).toContain('chat.loading');
    release({ ok: true, conversations: [{ conversation_id: 'new', title: 'Updated execution' }], total: 1, next_offset: null });
    await vi.waitFor(() => expect(container.innerHTML).toBe('Updated execution'));
    context._autoRenderTaskConvs('task', container);
    expect(container.innerHTML).toBe('Updated execution');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('uses authoritative batch totals and a task-scoped conversation page', () => {
    expect(rendererSource).toContain("invoke('conversations.autoTaskCounts'");
    expect(rendererSource).toContain("mode: 'auto_task'");
    expect(rendererSource).toContain('data-auto-task-convs-more="1"');
    expect(rendererSource).toContain("t('sidebar.load_more_conversations')");
    expect(ipcSource).toContain("if (mode === 'auto_task')");
    expect(ipcSource).toContain('chats.listAutoTaskConversationPage');
    expect(ipcSource).toContain("'conversations.autoTaskCounts'");
  });

  it('aligns the project sync note and create action in one toolbar', () => {
    expect(html).toMatch(/class="project-auto-tab-head"[\s\S]*?id="project-auto-sync-note"[\s\S]*?id="project-auto-add-btn"/);
  });
});
