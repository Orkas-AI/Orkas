import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { openSidebarEntry, expect, test, type OrkasTestApp } from './fixtures/orkas';

// Sidebar "Recent Tasks" aggregate (pinned or active in the last 24h) through the real IPC +
// renderer wiring: the startup slice must carry recent rows
// from a collapsed project, the aggregate must exclude older unpinned rows, and the
// unread cue must behave as one task mirrored in two lists.

type Conversation = { conversation_id: string; project_id?: string };

// Sidebar scenarios use the local account service as well as isolated storage;
// an unavailable account endpoint must not introduce unrelated retry noise.

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
      // These are previously active tasks, not empty legacy placeholders.
      // The real startup ghost migration must retain their canonical history.
      writeFileSync(path.join(path.dirname(file), `${row.conversation_id}.jsonl`),
        JSON.stringify({ id: `${row.conversation_id}-activity`, from: 'user',
          to: ['commander'], text: 'Deterministic sidebar activity', ts: iso }) + '\n');
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
  test('retains old pinned tasks after relaunch and removes an expired task when unpinned', async ({ orkas }, info) => {
    const project = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Pinned project' });
    const pid = project.project.project_id;
    const projectPin = await createConversation(orkas, 'Pinned project task from last month with a long title', pid);
    const loosePin = await createConversation(orkas, 'Pinned loose task from last month');
    const expired = await createConversation(orkas, 'Expired task without pin', pid);
    const recent = await createConversation(orkas, 'Recent task without pin');
    for (const conv of [projectPin, loosePin]) {
      await orkas.invoke('conversations.pin', { cid: conv.conversation_id, pinned: true, projectId: conv.project_id });
    }
    backdateConversations(orkas.workspaceRoot,
      [projectPin.conversation_id, loosePin.conversation_id, expired.conversation_id],
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    await orkas.page!.evaluate(() => localStorage.setItem('sidebar.projectExpanded', '{}'));
    const page = await orkas.relaunch();
    const rows = page.locator('#today-list .conv-item');
    const projectCopy = page.locator(`#today-list .conv-item[data-cid="${projectPin.conversation_id}"]`);
    const looseCopy = page.locator(`#today-list .conv-item[data-cid="${loosePin.conversation_id}"]`);
    await expect(rows).toHaveCount(3);
    await expect(projectCopy).toHaveClass(/\bis-pinned\b/);
    await expect(looseCopy).toHaveClass(/\bis-pinned\b/);
    await expect(rows.nth(2)).toHaveAttribute('data-cid', recent.conversation_id);
    await expect(page.locator('#projects-list .conv-item')).toHaveCount(0);
    for (const [lang, width, height] of [['en', 1366, 900], ['zh', 900, 650]] as const) {
      await page.evaluate(language => (window as any).setLang(language), lang);
      await page.setViewportSize({ width, height });
      await expect(projectCopy).toBeVisible();
      await page.screenshot({ path: info.outputPath(`recent-pinned-${lang}.png`) });
    }
    await projectCopy.hover();
    await projectCopy.locator('.conv-item-menu').click();
    await page.locator('#conversation-action-menu [data-action="pin"]').click();
    await expect(projectCopy).toHaveCount(0);
    await expect(looseCopy).toHaveCount(1);
    // Relaunch proves the unpin persisted and the remaining pin is still loaded.
    const restarted = await orkas.relaunch();
    await expect(restarted.locator(`#today-list .conv-item[data-cid="${projectPin.conversation_id}"]`)).toHaveCount(0);
    await expect(restarted.locator(`#today-list .conv-item[data-cid="${loosePin.conversation_id}"]`)).toHaveClass(/\bis-pinned\b/);
  });

  test('lists recent tasks across a collapsed project and the Tasks list and mirrors unread state', async ({ orkas }, info) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;

    const project = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Probe Project' });
    const pid = project.project.project_id;
    const projectToday = await createConversation(orkas, 'Project task ran today', pid);
    const projectOld = await createConversation(orkas, 'Project task from last week', pid);
    const unprojectedToday = await createConversation(orkas, 'Loose task ran today');
    const unprojectedOld = await createConversation(orkas, 'Loose task from last week');
    const projectYesterday = await createConversation(orkas, 'Project task ran yesterday', pid);
    const projectExpired = await createConversation(orkas, 'Project task outside recent window', pid);
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    backdateConversations(orkas.workspaceRoot, [projectOld.conversation_id, unprojectedOld.conversation_id], lastWeek);
    const yesterday = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    backdateConversations(orkas.workspaceRoot, [projectYesterday.conversation_id], yesterday);
    backdateConversations(orkas.workspaceRoot, [projectExpired.conversation_id],
      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());

    // Keep the project collapsed: the aggregate must not depend on expansion.
    await page.evaluate(() => {
      localStorage.setItem('sidebar.projectExpanded', '{}');
    });
    const relaunched = await orkas.relaunch();

    const todayRows = relaunched.locator('#today-list .conv-item');
    await expect(todayRows).toHaveCount(3);
    await expect(relaunched.locator(`#today-list .conv-item[data-cid="${projectYesterday.conversation_id}"]`)).toHaveCount(1);
    await expect(relaunched.locator(`#today-list .conv-item[data-cid="${projectExpired.conversation_id}"]`)).toHaveCount(0);
    await expect(relaunched.locator(`#today-list .conv-item[data-cid="${projectToday.conversation_id}"]`)).toHaveCount(1);
    await expect(relaunched.locator(`#today-list .conv-item[data-cid="${unprojectedToday.conversation_id}"]`)).toHaveCount(1);
    await expect(relaunched.locator(`#today-list .conv-item[data-cid="${projectOld.conversation_id}"]`)).toHaveCount(0);
    await expect(relaunched.locator(`#today-list .conv-item[data-cid="${unprojectedOld.conversation_id}"]`)).toHaveCount(0);
    // Older tasks remain valid records: age filtering, not ghost migration,
    // excludes them from the aggregate.
    const persisted = await orkas.invoke<{ conversations: Conversation[] }>('conversations.list');
    expect(persisted.conversations.map((row) => row.conversation_id))
      .toEqual(expect.arrayContaining([projectYesterday.conversation_id,
        projectOld.conversation_id, unprojectedOld.conversation_id, projectExpired.conversation_id]));
    // The project itself stays collapsed and the Tasks list still owns its
    // own copy of the unprojected task.
    await expect(relaunched.locator('#projects-list .conv-item')).toHaveCount(0);
    await expect(relaunched.locator(`#conversation-list .conv-item[data-cid="${unprojectedToday.conversation_id}"]`)).toHaveCount(1);
    await expect(relaunched.locator(`#conversation-list .conv-item[data-cid="${projectToday.conversation_id}"]`)).toHaveCount(0);
    await relaunched.evaluate(() => (window as any).setLang('zh'));
    await expect(relaunched.locator('[data-i18n="sidebar.today_tasks"]')).toHaveText('近期任务');
    await relaunched.screenshot({ path: info.outputPath('recent-tasks-24h.png') });

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

test.describe('manual task receipt and sidebar refresh', () => {
  test('shows one task when a real list refresh precedes the run receipt', async ({ cliOrkas: orkas }) => {
    const page = orkas.page!;
    await page.evaluate(() => (window as any).setLang('en'));
    const { agent } = await orkas.invoke<{ agent: { agent_id: string } }>('agents.create', {
      name: 'ReceiptRaceCodex', category: 'general', runtime: { kind: 'cli', cli: 'codex' },
    });
    const { project } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', {
      name: 'Receipt race project',
    });
    const pid = project.project_id;
    await orkas.invoke('projects.bindings.add', { projectId: pid, kind: 'agent', id: agent.agent_id });
    const content = 'E2E_CODEX_SEND_NOW_ACTIVE inspect receipt race';
    const { task } = await orkas.invoke<{ task: { id: string } }>('projects.tasks.create', {
      projectId: pid, content, owner_agent_id: agent.agent_id,
    });
    // Hold only the acknowledgement of the admitted execution. Creation,
    // dispatch, persistence, list IPC and sidebar rendering all stay real.
    await orkas.electronApp!.evaluate(({ ipcMain }, tid) => {
      const original = (ipcMain as any)._invokeHandlers.get('orkas.invoke');
      if (typeof original !== 'function') throw new Error('Fixture invoke handler unavailable');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const state = { cid: '', calls: 0, release, restore: () => {
        ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', original);
      } };
      (globalThis as any).__receiptRace = state;
      ipcMain.removeHandler('orkas.invoke');
      ipcMain.handle('orkas.invoke', async (event, request) => {
        const result = await original(event, request);
        if (request?.channel === 'projects.tasks.run' && request.payload?.taskId === tid) {
          state.cid = result.cid;
          state.calls += 1;
          await gate;
        }
        return result;
      });
    }, task.id);
    let cid = '';
    try {
      await openSidebarEntry(page, '#todos-btn');
      const card = page.locator('#todos-content .project-todo-item', { hasText: content });
      await card.hover();
      await card.locator('[data-action="todo-menu"]').click();
      await page.locator('.context-menu-item', { hasText: 'Process now' }).click();
      await expect.poll(async () => {
        cid = await orkas.electronApp!.evaluate(() => (globalThis as any).__receiptRace.cid);
        return !!cid;
      }).toBe(true);
      await page.evaluate(async () => (window as any).loadConversations());
      const todayRow = page.locator(`#today-list .conv-item[data-cid="${cid}"]`);
      await expect(todayRow).toHaveCount(1);
      await expect(todayRow).not.toHaveClass(/\bactive\b/);
      await orkas.electronApp!.evaluate(() => (globalThis as any).__receiptRace.release());
      // The same row becomes active once the original run receipt arrives.
      // No subsequent list reload may mask a duplicate introduced by it.
      await expect(todayRow).toHaveClass(/\bactive\b/);
      await expect(todayRow).toHaveCount(1);
      const listed = await orkas.invoke<{ conversations: Conversation[] }>('conversations.list');
      expect(listed.conversations.filter((row) => row.project_id === pid)).toHaveLength(1);
      const execution = await orkas.invoke<{ tasks: Array<{ assignee: string }> }>('groupChat.tasks.list', { cid });
      expect(execution.tasks).toHaveLength(1);
      expect(execution.tasks[0].assignee).toBe(agent.agent_id);
      expect(await orkas.electronApp!.evaluate(() => (globalThis as any).__receiptRace.calls)).toBe(1);
      await expect.poll(() => orkas.readCliState().invocations.filter((run) => run.prompt.includes(content)).length).toBe(1);
    } finally {
      await orkas.electronApp!.evaluate(() => {
        const state = (globalThis as any).__receiptRace;
        state.release(); state.restore(); delete (globalThis as any).__receiptRace;
      });
      if (cid) await orkas.invoke('groupChat.abort', { cid });
    }
  });
});
