import { openSidebarEntry, expect, test } from './fixtures/orkas';


test('recovers the completed reply without leaving the page when terminal delivery is lost', async ({ modelOrkas: app }) => {
  test.setTimeout(120_000);
  const page = app.page!;
  app.setModelMode('controlled-slow');
  // Drop only terminal bus delivery. Streaming, host execution, persistence,
  // and history reads remain real, so a cleanup that deletes the row fails.
  await page.evaluate(() => {
    const original = (window as any)._handleGroupBusEvent;
    (window as any).__droppedTerminalMessages = 0;
    (window as any)._handleGroupBusEvent = function(cid: string, row: unknown, event: any, opts: unknown) {
      if (event?.type === 'message' && event.msg?.from !== 'user') {
        (window as any).__droppedTerminalMessages++;
        return;
      }
      return original(cid, row, event, opts);
    };
  });
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill('Reply while I keep this page open.');
  await page.locator('#new-chat-send-btn').click();
  await expect.poll(() => app.modelRequests.length, { timeout: 30_000 }).toBe(1);
  app.releaseControlledModelChunk();
  const reply = page.locator('#chat-history .chat-message.assistant').filter({ hasText: 'Hello from the local E2E model.' });
  await expect(reply).toHaveCount(1);
  app.finishControlledModelStream();
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  await expect(reply).toHaveCount(1);
  await expect(reply).toHaveAttribute('data-msg-id', /.+/);
  expect(await page.evaluate(() => (window as any).__droppedTerminalMessages)).toBeGreaterThan(0);
  expect(app.modelRequests).toHaveLength(1);
});

// Local protocol responses drive real tools, persistence, and renderer navigation.
test('keeps saved automation and todo shortcuts usable live and after restart', async ({ modelOrkas: app }, testInfo) => {
  test.setTimeout(120_000);
  if (!app.page) throw new Error('Orkas renderer is unavailable');
  let page = app.page;
  const project = await app.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Release review' });
  app.setSavedTasksScenario('The tasks have been saved.');
  // Project to-dos belong to this conversation's project; a global chat cannot
  // select another backlog. Exercise the real project composer rather than
  // making the protocol fixture request cross-project permission.
  await page.evaluate(async projectId => {
    await (window as any).loadProjects(true);
    (window as any).setView('project', projectId);
  }, project.project.project_id);
  await expect(page.locator('#project-detail-title')).toHaveText('Release review');
  await page.locator('#project-chat-input').fill('Schedule a nightly review and add a release-note todo.');
  await page.locator('#project-chat-send-btn').click();
  await expect(page.locator('#chat-history .chat-message.assistant .chat-bubble > :is(.markdown-body, [data-role="final"])'))
    .toContainText('The tasks have been saved.', { timeout: 30_000 });
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  const { conversations } = await app.invoke<{
    conversations: Array<{ conversation_id: string; project_id?: string }>;
  }>('conversations.list');
  const cid = conversations.find(item => item.project_id === project.project.project_id)?.conversation_id;
  expect(cid).toBeTruthy();
  const { history } = await app.invoke<{ history: Array<{ saved_tasks?: Array<{ kind: string; task_id: string; title: string; project_id?: string }> }> }>(
    'conversations.history', { cid, limit: 20 },
  );
  const links = history.flatMap(row => row.saved_tasks || []);
  expect(links.map(link => [link.kind, link.title])).toEqual([
    ['automation', 'Nightly review'], ['todo', 'Review release notes'],
  ]);
  const automation = links.find(link => link.kind === 'automation')!;
  const todo = links.find(link => link.kind === 'todo')!;
  const storedAutomations = await app.invoke<{
    tasks: Array<{ id: string; title: string; project_id?: string; enabled: boolean }>;
  }>('autoTasks.list', { projectId: project.project.project_id });
  expect(storedAutomations.tasks).toEqual([
    expect.objectContaining({ id: automation.task_id, title: 'Nightly review',
      project_id: project.project.project_id, enabled: false }),
  ]);
  expect((await app.invoke<{ tasks: unknown[] }>('autoTasks.list', { projectId: null })).tasks).toEqual([]);
  expect(todo.project_id).toBe(project.project.project_id);
  const storedTodos = await app.invoke<{ tasks: Array<{ id: string; content: string }> }>(
    'projects.tasks.list', { projectId: project.project.project_id },
  );
  expect(storedTodos.tasks).toEqual([
    expect.objectContaining({ id: todo.task_id, content: 'Review release notes' }),
  ]);
  const globalTodos = await app.invoke<{ tasks: Array<{ id: string }> }>('projects.tasks.list');
  expect(globalTodos.tasks).toEqual([]);
  await app.invoke('projects.tasks.create', { projectId: project.project.project_id, content: 'Another release check' });
  await expect(page.locator('#chat-history [data-saved-task-key]')).toHaveCount(2);
  await page.evaluate(() => (window as any).setLang('zh'));
  await expect(page.locator('#chat-history [data-saved-task-key] .chat-msg-created-agent-label').first()).toContainText('打开');
  await page.evaluate(() => (window as any).setLang('en'));
  await expect(page.locator('#chat-history [data-saved-task-key] .chat-msg-created-agent-label').first()).toContainText('Open');
  await page.locator('#chat-history [data-saved-task-key]', { hasText: 'Nightly review' }).click();
  const autoCard = () => page.locator(`#auto-list .auto-row[data-task-id="${automation.task_id}"]`);
  const expectAutomationFocused = async () => {
    await expect(autoCard()).toBeInViewport();
    await expect(autoCard()).toHaveClass(/\bis-highlighted\b/);
    await expect(page.locator('#auto-list .auto-row.is-highlighted')).toHaveCount(1);
    await expect(page.locator('#auto-task-dialog-overlay')).toBeHidden();
    await expect(page.locator(`#auto-list .todo-scope-chip[data-project-id="${project.project.project_id}"]`))
      .toHaveAttribute('aria-pressed', 'true');
  };
  await expectAutomationFocused();
  const autoHighlight = await autoCard().evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, shadow: style.boxShadow };
  });
  await page.screenshot({ path: testInfo.outputPath('automation-shortcut-highlight-en.png') });
  await expect(autoCard()).not.toHaveClass(/\bis-highlighted\b/);
  await expect(autoCard()).not.toHaveCSS('background-color', autoHighlight.background);
  await expect(autoCard()).not.toHaveCSS('box-shadow', autoHighlight.shadow);
  // Editing remains an explicit action in the card's menu.
  await autoCard().hover();
  await autoCard().locator('.auto-row-more').click();
  await page.locator('.auto-row-menu-item[data-action="edit"]').click();
  await expect(page.locator('#auto-task-dialog-overlay')).toBeVisible();
  await expect(page.locator('#auto-title-input')).toHaveValue('Nightly review');
  await expect(page.locator(`#auto-list .todo-scope-chip[data-project-id="${project.project.project_id}"]`))
    .toHaveAttribute('aria-pressed', 'true');
  await page.locator('#auto-dialog-cancel-btn').click();
  await expect(page.locator(`#auto-list .auto-row[data-task-id="${automation.task_id}"]`)).toBeVisible();
  // Remember another scope and status grouping before following the shortcuts again.
  await page.locator('#auto-list .todo-scope-chip[data-project-id=""]').click();
  await openSidebarEntry(page, '#todos-btn');
  await page.locator('[data-todo-group="status"]').click();
  const todoCard = page.locator(`#todos-content [data-tid="${todo.task_id}"]`);
  await expect(todoCard).toBeVisible();
  const restingStyle = await todoCard.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, shadow: style.boxShadow };
  });
  await page.evaluate((id) => (window as any).setView('conversation', id), cid);
  await page.locator('#chat-history [data-saved-task-key]', { hasText: 'Review release notes' }).click();
  await expect(todoCard).toBeInViewport();
  await expect(todoCard).toHaveClass(/\bis-highlighted\b/);
  // A class alone misses board styles overriding the actual highlight.
  await expect(todoCard).not.toHaveCSS('background-color', restingStyle.background, { timeout: 1500 });
  await expect(todoCard).not.toHaveCSS('box-shadow', restingStyle.shadow, { timeout: 1500 });
  await expect(page.locator('#todos-content .is-highlighted')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('todo-shortcut-highlight-en.png') });
  await expect(todoCard).not.toHaveClass(/\bis-highlighted\b/);
  await expect(todoCard).toHaveCSS('background-color', restingStyle.background);
  await expect(todoCard).toHaveCSS('box-shadow', restingStyle.shadow);
  await expect(page.locator('[data-todo-group="project"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`#todos-content .todo-scope-chip[data-pid="${project.project.project_id}"]`))
    .toHaveAttribute('aria-pressed', 'true');
  // Reopening the shortcut should reveal the highlight again in a narrow window.
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.evaluate((id) => { (window as any).setLang('zh'); (window as any).setView('conversation', id); }, cid);
  await page.locator('#chat-history [data-saved-task-key]', { hasText: 'Review release notes' }).click();
  await expect(todoCard).toBeInViewport();
  await expect(todoCard).not.toHaveCSS('background-color', restingStyle.background, { timeout: 1500 });
  await page.screenshot({ path: testInfo.outputPath('todo-shortcut-highlight-zh-narrow.png') });
  await page.evaluate((id) => (window as any).setView('conversation', id), cid);
  await page.locator('#chat-history [data-saved-task-key]', { hasText: 'Nightly review' }).click();
  await expectAutomationFocused();
  await expect(autoCard()).toHaveCSS('background-color', autoHighlight.background);
  await page.screenshot({ path: testInfo.outputPath('automation-shortcut-highlight-zh-narrow.png') });
  page = await app.relaunch();
  const restored = await app.invoke<{
    conversations: Array<{ conversation_id: string; project_id?: string }>;
  }>('conversations.list');
  expect(restored.conversations.find(item => item.conversation_id === cid)?.project_id)
    .toBe(project.project.project_id);
  // Project conversations live in their project's sidebar, not the global
  // conversation list. Reopen through the same public route used above.
  await page.evaluate(id => (window as any).setView('conversation', id), cid);
  await expect(page.locator('#chat-history [data-saved-task-key]')).toHaveCount(2);
  await page.locator('#chat-history [data-saved-task-key]', { hasText: 'Nightly review' }).click();
  await expectAutomationFocused();
});
