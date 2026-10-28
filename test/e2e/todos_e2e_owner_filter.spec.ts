import { openSidebarEntry, expect, test } from './fixtures/orkas';

// Hosted All/Mine responsibility is unavailable in the public app. Its local
// work must still survive grouping, refreshes and shortcut navigation.
for (const language of ['zh', 'en', 'ar']) {
  test(`keeps personal global and project work visible across scope changes (${language})`, async ({ orkas }, testInfo) => {
    const page = orkas.page!;
    await page.evaluate(lang => (window as any).setLang(lang), language);
    await page.setViewportSize({ width: 1024, height: 720 });
    const global = await orkas.invoke<any>('projects.tasks.create', { content: 'Personal global work' });
    const { project } = await orkas.invoke<any>('projects.create', { name: 'Release planning with a long project title' });
    const { project: otherProject } = await orkas.invoke<any>('projects.create', { name: 'Other personal project' });
    const tasks = [];
    for (const [content, status, owner_agent_id] of [
      ['Unassigned project work', 'todo', ''],
      ['Commander project work', 'progress', 'commander'],
      ['Project work awaiting review', 'review', ''],
    ]) {
      const { task } = await orkas.invoke<any>('projects.tasks.create', {
        projectId: project.project_id, content, status, ...(owner_agent_id ? { owner_agent_id } : {}),
      });
      tasks.push(task);
    }
    const { task: other } = await orkas.invoke<any>('projects.tasks.create', {
      projectId: otherProject.project_id, content: 'Keep other project work',
    });
    const before = await orkas.invoke('projects.tasks.list', { projectId: project.project_id });
    await openSidebarEntry(page, '#todos-btn');
    const content = page.locator('#todos-content');
    const visibleIds = () => content.locator('.project-todo-item').evaluateAll(elements =>
      elements.map(element => (element as HTMLElement).dataset.tid).sort());
    await page.locator('[data-todo-group="status"]').click();
    await expect(content.locator('.project-todo-shared-filter')).toHaveCount(0);
    await expect.poll(visibleIds).toEqual([global.task.id, other.id, ...tasks.map(task => task.id)].sort());
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 720 });
      await expect(content.locator('.todo-driver-bar-list')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`todo-personal-status-${language}-${width}.png`) });
    }

    await page.locator('[data-todo-group="project"]').click();
    const pickScope = async (pid: string) => {
      await content.locator(`.todo-scope-chip[data-pid="${pid}"]`).click();
    };
    await pickScope(project.project_id);
    await expect.poll(visibleIds).toEqual(tasks.map(task => task.id).sort());
    await expect(content.locator(`.todo-scope-chip[data-pid="${project.project_id}"] .todo-scope-chip-count`)).toHaveText('3');
    await expect(content.locator('.project-todo-shared-filter')).toHaveCount(0);
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 720 });
      await expect(content.locator('.todo-scope-actions .todo-driver-control')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`todo-personal-project-${language}-${width}.png`) });
    }
    await page.evaluate(pid => (window as any)._refreshGlobalTodos(pid), project.project_id);
    await expect.poll(visibleIds).toEqual(tasks.map(task => task.id).sort());
    await expect(content.locator(`.todo-scope-chip[data-pid="${project.project_id}"]`)).toHaveAttribute('aria-pressed', 'true');
    await pickScope('');
    await expect.poll(visibleIds).toEqual([global.task.id]);
    await pickScope(otherProject.project_id);
    await expect.poll(visibleIds).toEqual([other.id]);

    // An explicit shortcut must reveal its target, including from another scope.
    await page.evaluate(({ pid, tid }) => (window as any).focusTodo(pid, tid), {
      pid: project.project_id, tid: tasks[1].id,
    });
    await expect(content.locator(`.project-todo-item[data-tid="${tasks[1].id}"]`)).toBeVisible();
    await expect(content.locator(`.todo-scope-chip[data-pid="${project.project_id}"]`)).toHaveAttribute('aria-pressed', 'true');
    expect(await orkas.invoke('projects.tasks.list', { projectId: project.project_id })).toEqual(before);

    // The project detail keeps the same work without a human-responsibility gate.
    await page.evaluate(pid => (window as any).setView('project', pid), project.project_id);
    await page.locator('[data-project-tab="todo"]').click();
    await expect(page.locator('#project-todo-filter .project-todo-shared-filter')).toHaveCount(0);
    await expect(page.locator('#project-todo-list .project-todo-item')).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath(`todo-personal-detail-${language}.png`) });
    expect(await orkas.invoke('projects.tasks.list', { projectId: project.project_id })).toEqual(before);
  });
}

test('hides the responsibility filter when all work is personal', async ({ orkas }) => {
  const page = orkas.page!;
  await orkas.invoke('projects.tasks.create', { content: 'Personal work only' });
  await openSidebarEntry(page, '#todos-btn');
  for (const mode of ['project', 'status']) {
    await page.locator(`[data-todo-group="${mode}"]`).click();
    await expect(page.locator('#todos-content .project-todo-shared-filter')).toHaveCount(0);
    await expect(page.locator('#todos-content .project-todo-item')).toHaveCount(1);
  }
});
