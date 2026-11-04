import { openSidebarEntry, expect, test } from './fixtures/orkas';

for (const language of ['zh', 'en']) {
  test(`shows framed empty lanes and usable collapsed strips on every todo board (${language})`, async ({ orkas }, testInfo) => {
    const page = orkas.page!;
    await page.evaluate(lang => (window as any).setLang(lang), language);
    await page.setViewportSize({ width: language === 'zh' ? 1440 : 1024, height: language === 'zh' ? 900 : 720 });
    const { project } = await orkas.invoke<any>('projects.create', { name: 'Empty lane checks' });
    const { task } = await orkas.invoke<any>('projects.tasks.create', {
      projectId: project.project_id, content: 'Completed work remains reachable', status: 'done',
    });
    await openSidebarEntry(page, '#todos-btn');

    for (const entry of ['project-group', 'status-group', 'project']) {
      if (entry === 'project') {
        await page.evaluate(async pid => (window as any).setView('project', pid), project.project_id);
        await page.locator('[data-project-tab="todo"]').click();
      } else {
        await page.locator(`[data-todo-group="${entry === 'project-group' ? 'project' : 'status'}"]`).click();
      }
      const host = page.locator(entry === 'project' ? '#project-todo-list' : '#todos-content');
      const board = host.locator('.todo-board');
      await expect(board).toBeVisible();
      const review = board.locator('.todo-column.is-review');
      const empty = review.locator('.todo-column-empty');
      await expect(empty).toHaveText(language === 'zh' ? '暂无待办' : 'No tasks yet');
      await expect(empty).toHaveCSS('border-top-style', 'dashed');
      const geometry = await empty.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const body = element.parentElement!.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, bodyWidth: body.width };
      });
      expect(geometry.height).toBeGreaterThanOrEqual(64);
      expect(geometry.width).toBeCloseTo(geometry.bodyWidth, 0);
      const done = board.locator('.todo-column.is-done');
      const completed = done.locator(`.project-todo-item[data-tid="${task.id}"]`);
      await expect(done.locator('.todo-collapse')).toHaveAttribute('aria-expanded', 'false');
      await expect(done).toHaveCSS('width', '40px');
      await expect(done.locator('.todo-collapse-label')).toHaveCSS('writing-mode', 'vertical-rl');
      await expect(completed).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath(`empty-lanes-${entry}-${language}.png`) });

      // A collapsed lane keeps its work accessible and gives space back again.
      await done.locator('.todo-collapse').click();
      await expect(completed).toBeVisible();
      await expect.poll(async () => (await done.boundingBox())?.width || 0).toBeGreaterThanOrEqual(190);
      await done.locator('.todo-collapse').click();
      await expect(completed).toBeHidden();
      const toggle = review.locator('.todo-collapse');
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(empty).toBeHidden();
      await expect(review).toHaveCSS('width', '40px');
      await page.keyboard.press('Enter');
      await expect(empty).toBeVisible();
      await expect(toggle).toBeFocused();
    }
  });
}
