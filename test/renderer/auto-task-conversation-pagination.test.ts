import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/modules/auto.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');

describe('automation execution-history pagination', () => {
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
