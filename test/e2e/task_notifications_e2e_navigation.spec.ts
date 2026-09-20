import { expect, test, type OrkasTestApp } from './fixtures/orkas';

type TaskNotificationNavigation = {
  user_id: string;
  conversation_id: string;
  terminal_status: 'completed' | 'stopped' | 'failed' | 'waiting_input';
};

async function sendTaskNotificationNavigation(
  orkas: OrkasTestApp,
  payload: TaskNotificationNavigation,
): Promise<void> {
  if (!orkas.electronApp) throw new Error('Orkas Electron app is unavailable');
  await orkas.electronApp.evaluate(({ BrowserWindow }, navigation) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!win) throw new Error('Orkas BrowserWindow is unavailable');
    win.webContents.send('conversations:open-from-notification', navigation);
  }, payload);
}

async function sendTaskTerminal(
  orkas: OrkasTestApp,
  conversationId: string,
  status: 'completed' | 'stopped' | 'failed' | 'waiting_input' = 'completed',
): Promise<void> {
  if (!orkas.electronApp) throw new Error('Orkas Electron app is unavailable');
  await orkas.electronApp.evaluate(({ BrowserWindow }, terminal) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!win) throw new Error('Orkas BrowserWindow is unavailable');
    win.webContents.send('conversation:task_terminal', terminal);
  }, {
    type: 'terminal',
    conversation_id: conversationId,
    run_id: `e2e-unread-${conversationId}`,
    status,
    finished_at_ms: Date.now(),
  });
}

async function backgroundAppWindow(orkas: OrkasTestApp): Promise<void> {
  if (!orkas.electronApp) throw new Error('Orkas Electron app is unavailable');
  const state = await orkas.electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!win) throw new Error('Orkas BrowserWindow is unavailable');
    win.hide();
    return { focused: win.isFocused(), visible: win.isVisible() };
  });
  expect(state).toEqual({ focused: false, visible: false });
}

test.describe('task notification navigation', () => {
  test('keeps background completion unread after embedded content loads', async ({ modelOrkas }) => {
    if (!modelOrkas.page || !modelOrkas.electronApp) throw new Error('Orkas is unavailable');
    const page = modelOrkas.page;
    // Embedded previews must not make the already-loaded task UI unavailable
    // to Main's terminal channel. Use the real bus and local model fixture;
    // webContents.send alone would bypass the delivery readiness gate.
    await page.evaluate(async () => {
      const frame = document.createElement('iframe');
      frame.hidden = true;
      const loaded = new Promise<void>((resolve) => { frame.onload = () => resolve(); });
      frame.srcdoc = '<p>Embedded preview</p>';
      document.body.appendChild(frame);
      await loaded;
      frame.remove();
    });
    modelOrkas.setModelMode('controlled-slow');
    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill('Reply through the isolated E2E model.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(1);
    const cid = await page.locator('#conversation-list .conv-item.active').getAttribute('data-cid');
    expect(cid).toBeTruthy();
    await page.locator('#new-chat-btn').click();
    modelOrkas.releaseControlledModelChunk();
    modelOrkas.finishControlledModelStream();
    const row = page.locator(`#conversation-list .conv-item[data-cid="${cid}"]`);
    await expect(row.locator('.conv-item-unread-dot')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#tasks-unread-dot')).toBeVisible();
    await row.click();
    await expect(row.locator('.conv-item-unread-dot')).toHaveCount(0);
  });

  test('renders sidebar-only red unread dots from a background production terminal', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const project = await orkas.invoke<{ project: { project_id: string } }>('projects.create', {
      name: 'E2E Unread Dot Project',
    });
    const globalConversation = await orkas.invoke<{ conversation: { conversation_id: string } }>(
      'conversations.create',
      { title: 'E2E Global Unread Task' },
    );
    const projectConversation = await orkas.invoke<{ conversation: { conversation_id: string } }>(
      'conversations.create',
      { title: 'E2E Project Unread Task', projectId: project.project.project_id },
    );
    await page.evaluate(async () => {
      await (window as any).loadProjects(true);
      await (window as any).loadConversations();
    });
    await page.locator('#new-chat-btn').click();
    await backgroundAppWindow(orkas);

    await sendTaskTerminal(orkas, globalConversation.conversation.conversation_id);
    await sendTaskTerminal(orkas, projectConversation.conversation.conversation_id);

    const globalRow = page.locator(
      `#conversation-list .conv-item[data-cid="${globalConversation.conversation.conversation_id}"]`,
    );
    const globalTitle = globalRow.locator('.conv-item-title');
    const globalDot = globalRow.locator('.conv-item-unread-dot');
    const projectRow = page.locator(`.project-row[data-pid="${project.project.project_id}"]`);
    const projectName = projectRow.locator('.project-name');
    const projectDot = projectRow.locator('.project-unread-dot');

    await expect(globalDot).toBeVisible();
    await expect(projectDot).toBeVisible();
    await expect(page.locator('#tasks-unread-dot')).toBeVisible();
    await expect(page.locator('#projects-unread-dot')).toBeVisible();
    await expect(page.locator('.main-content .task-unread-dot')).toHaveCount(0);

    const layout = await page.evaluate(({ globalCid, projectId }) => {
      const taskRow = document.querySelector(
        `#conversation-list .conv-item[data-cid="${CSS.escape(globalCid)}"]`,
      );
      const taskTitle = taskRow?.querySelector('.conv-item-title');
      const taskDot = taskRow?.querySelector('.conv-item-unread-dot');
      const projectRowEl = document.querySelector(`.project-row[data-pid="${CSS.escape(projectId)}"]`);
      const projectNameEl = projectRowEl?.querySelector('.project-name');
      const projectDotEl = projectRowEl?.querySelector('.project-unread-dot');
      if (!taskTitle || !taskDot || !projectNameEl || !projectDotEl) {
        throw new Error('Unread-dot comparison elements are missing');
      }
      const taskStyle = getComputedStyle(taskDot);
      const projectStyle = getComputedStyle(projectDotEl);
      const result = {
        task: {
          width: taskStyle.width,
          height: taskStyle.height,
          color: taskStyle.backgroundColor,
          gapAfterText: taskDot.getBoundingClientRect().left - taskTitle.getBoundingClientRect().right,
        },
        project: {
          width: projectStyle.width,
          height: projectStyle.height,
          color: projectStyle.backgroundColor,
        },
        projectGapAfterText: projectDotEl.getBoundingClientRect().left - projectNameEl.getBoundingClientRect().right,
      };
      return result;
    }, {
      globalCid: globalConversation.conversation.conversation_id,
      projectId: project.project.project_id,
    });

    expect(layout.project).toEqual({
      width: layout.task.width, height: layout.task.height, color: layout.task.color,
    });
    expect(parseFloat(layout.task.width)).toBeGreaterThan(0);
    expect(layout.task.gapAfterText).toBeGreaterThanOrEqual(0);
    expect(layout.task.gapAfterText).toBeLessThanOrEqual(8);
    expect(layout.projectGapAfterText).toBeGreaterThanOrEqual(0);
    expect(layout.projectGapAfterText).toBeLessThanOrEqual(8);

    await projectRow.click();
    await expect(page.locator('#project-detail-title')).toHaveText('E2E Unread Dot Project');
    await expect(page.locator('.main-content .task-unread-dot')).toHaveCount(0);

    await projectRow.click();
    const projectTaskRow = page.locator(
      `.project-conv-list .conv-item[data-cid="${projectConversation.conversation.conversation_id}"]`,
    );
    await expect(projectTaskRow.locator('.conv-item-unread-dot')).toBeVisible();
    const projectTaskOrder = await projectTaskRow.evaluate((row) => {
      const title = row.querySelector('.conv-item-title');
      const dot = row.querySelector('.conv-item-unread-dot');
      return !!title && title.nextElementSibling === dot;
    });
    expect(projectTaskOrder).toBe(true);
    await expect(page.locator('.main-content .task-unread-dot')).toHaveCount(0);
  });

  test('rejects a stale account notification while opening one for the active account', async ({ orkas }) => {
    const accountAConversation = await orkas.invoke<{
      conversation: { conversation_id: string };
    }>('conversations.create', { title: 'E2E Account A Notification' });

    const page = await orkas.switchLocalUser('notification-account-b', {
      nickname: 'Notification User B',
      email: 'notification-b@example.invalid',
    });
    const accountBConversation = await orkas.invoke<{
      conversation: { conversation_id: string };
    }>('conversations.create', { title: 'E2E Account B Notification' });
    await page.evaluate(async () => (window as any).loadConversations());
    await page.locator('#new-chat-btn').click();
    await expect(page.locator('#panel-new-chat')).toHaveClass(/active/);

    await sendTaskNotificationNavigation(orkas, {
      user_id: 'account-e2e',
      conversation_id: accountAConversation.conversation.conversation_id,
      terminal_status: 'completed',
    });
    await expect(page.locator('#panel-new-chat')).toHaveClass(/active/);
    await expect(page.locator('#panel-conversation')).not.toHaveClass(/active/);

    await sendTaskNotificationNavigation(orkas, {
      user_id: 'notification-account-b',
      conversation_id: accountBConversation.conversation.conversation_id,
      terminal_status: 'failed',
    });
    await expect(page.locator('#panel-conversation')).toHaveClass(/active/);
    await expect(page.locator(
      `#conversation-list .conv-item[data-cid="${accountBConversation.conversation.conversation_id}"]`,
    )).toHaveClass(/active/);
  });
});
