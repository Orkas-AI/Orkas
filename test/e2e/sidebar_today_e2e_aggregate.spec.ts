import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type OrkasTestApp } from './fixtures/orkas';

// Sidebar "Today's Tasks" aggregate through the real IPC + renderer wiring:
// the startup slice must carry today's rows from a collapsed project, the
// aggregate must exclude older rows, and the unread cue must behave as one
// task mirrored in two lists.

type Conversation = { conversation_id: string; project_id?: string };

async function createConversation(orkas: OrkasTestApp, title: string, projectId = ''): Promise<Conversation> {
  const result = await orkas.invoke<{ conversation: Conversation }>('conversations.create', { title, projectId });
  return result.conversation;
}

function findIndexFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.kb') continue;
        walk(full);
      } else if (entry.name === '_index.json' && full.includes(`${path.sep}chats${path.sep}`)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function backdateConversations(workspaceRoot: string, cids: string[], iso: string): void {
  let touched = 0;
  for (const file of findIndexFiles(workspaceRoot)) {
    if (!existsSync(file)) continue;
    const rows = JSON.parse(readFileSync(file, 'utf8')) as any[];
    let changed = false;
    for (const row of rows) {
      if (!cids.includes(row.conversation_id)) continue;
      row.created_at = iso;
      row.updated_at = iso;
      row.participant_summary_updated_at = iso;
      changed = true;
      touched += 1;
    }
    if (changed) writeFileSync(file, JSON.stringify(rows, null, 2));
  }
  if (touched !== cids.length) throw new Error(`backdated ${touched} of ${cids.length} rows`);
}

test.describe('sidebar today aggregate', () => {
  test('lists today\'s tasks across a collapsed project and the Tasks list and mirrors unread state', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;

    const project = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Probe Project' });
    const pid = project.project.project_id;
    const projectToday = await createConversation(orkas, 'Project task ran today', pid);
    const projectOld = await createConversation(orkas, 'Project task from last week', pid);
    const unprojectedToday = await createConversation(orkas, 'Loose task ran today');
    const unprojectedOld = await createConversation(orkas, 'Loose task from last week');
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    backdateConversations(orkas.workspaceRoot, [projectOld.conversation_id, unprojectedOld.conversation_id], lastWeek);

    // Keep the project collapsed: the aggregate must not depend on expansion.
    await page.evaluate(() => {
      localStorage.setItem('sidebar.projectExpanded', '{}');
    });
    const relaunched = await orkas.relaunch();

    const todayRows = relaunched.locator('#today-list .conv-item');
    await expect(todayRows).toHaveCount(2);
    await expect(relaunched.locator(`#today-list .conv-item[data-cid="${projectToday.conversation_id}"]`)).toHaveCount(1);
    await expect(relaunched.locator(`#today-list .conv-item[data-cid="${unprojectedToday.conversation_id}"]`)).toHaveCount(1);
    await expect(relaunched.locator(`#today-list .conv-item[data-cid="${projectOld.conversation_id}"]`)).toHaveCount(0);
    await expect(relaunched.locator(`#today-list .conv-item[data-cid="${unprojectedOld.conversation_id}"]`)).toHaveCount(0);
    // The project itself stays collapsed and the Tasks list still owns its
    // own copy of the unprojected task.
    await expect(relaunched.locator('#projects-list .conv-item')).toHaveCount(0);
    await expect(relaunched.locator(`#conversation-list .conv-item[data-cid="${unprojectedToday.conversation_id}"]`)).toHaveCount(1);
    await expect(relaunched.locator(`#conversation-list .conv-item[data-cid="${projectToday.conversation_id}"]`)).toHaveCount(0);

    // Unread mirror: a terminal on the collapsed-project task lights the Today
    // row, the Today header and the project row.
    await relaunched.evaluate((cid) => {
      (window as any)._markConversationUnread(cid, { finishedAt: Date.now() });
    }, projectToday.conversation_id);
    const todayCopy = relaunched.locator(`#today-list .conv-item[data-cid="${projectToday.conversation_id}"]`);
    await expect(todayCopy).toHaveClass(/has-unread/);
    await expect(relaunched.locator('#today-unread-dot')).toBeVisible();
    await expect(relaunched.locator(`[data-project-unread-dot="${pid}"]`)).toBeVisible();
    await expect(relaunched.locator('#projects-unread-dot')).toBeVisible();

    // Opening it from the aggregate clears every copy at once.
    await todayCopy.click();
    await expect(relaunched.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(todayCopy).not.toHaveClass(/has-unread/);
    await expect(relaunched.locator('#today-unread-dot')).toBeHidden();
    await expect(relaunched.locator(`[data-project-unread-dot="${pid}"]`)).toBeHidden();
    await expect(relaunched.locator('#projects-unread-dot')).toBeHidden();
    // Entering a projected task auto-expands its project: the same task is now
    // mounted twice and both copies are highlighted.
    await expect(relaunched.locator(`.sidebar-conversation-nav .conv-item.active[data-cid="${projectToday.conversation_id}"]`)).toHaveCount(2);
  });
});
