import { openSidebarEntry, expect, test } from './fixtures/orkas';


test('remembers account grouping after restart and keeps it when opening a linked todo', async ({ orkas: app }, testInfo) => {
  let page = app.page!;
  const { task } = await app.invoke<any>('projects.tasks.create', { content: 'Review the release' });
  await openSidebarEntry(page, '#todos-btn');
  await page.locator('[data-todo-group="status"]').click();
  await expect(page.locator('[data-todo-group="status"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await app.invoke<any>('prefs.getTodoGrouping')).grouping).toBe('status');
  page = await app.relaunch();
  await openSidebarEntry(page, '#todos-btn');
  await expect(page.locator('[data-todo-group="status"]')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(id => (window as any).focusTodo('', id), task.id);
  await expect(page.locator('[data-todo-group="status"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`#todos-content [data-tid="${task.id}"]`)).toHaveClass(/\bis-highlighted\b/);
  await page.screenshot({ path: testInfo.outputPath('remembered-grouping.png') });
});

test('keeps an external local preference change pending until editing finishes', async ({ orkas: app }, testInfo) => {
  let page = app.page!;
  await app.invoke('projects.tasks.create', { content: 'Keep this draft intact' });
  await openSidebarEntry(page, '#todos-btn');
  await page.locator('[data-todo-group="status"]').click();
  await expect.poll(async () => (await app.invoke<any>('prefs.getTodoGrouping')).grouping).toBe('status');
  await page.locator('#todos-add-btn').click();
  await expect(page.locator('#todo-editor-modal')).toHaveClass(/\bopen\b/);
  await page.locator('#project-todo-input').fill('Draft remains unchanged during refresh');
  // A second local preferences writer changes the durable choice while editing.
  await app.invoke('prefs.setTodoGrouping', { grouping: 'project' });
  await page.evaluate(async () => (window as any).refreshTodoGroupingFromMain());
  // Wait until the real refresh consumed the local value, while the editor
  // deliberately keeps the visible grouping and draft stable.
  await expect.poll(() => page.evaluate('_todoGroupingState.pending')).toBe('project');
  await expect(page.locator('[data-todo-group="status"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#project-todo-input')).toHaveValue('Draft remains unchanged during refresh');
  await page.locator('#project-todo-cancel').click();
  await expect(page.locator('[data-todo-group="project"]')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('refreshed-grouping.png') });
  await page.locator('[data-todo-group="status"]').click();
  await expect.poll(async () => (await app.invoke<any>('prefs.getTodoGrouping')).grouping).toBe('status');

});
