import { expect, test } from './fixtures/orkas';


test('keeps task pagination close to its rows without losing focus or page navigation', async ({ orkas }, info) => {
  const page = orkas.page!;
  const { project } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', {
    name: 'Pagination layout',
  });
  for (const projectId of ['', project.project_id]) {
    for (let index = 0; index < 11; index++) {
      await orkas.invoke('conversations.create', {
        projectId, title: `Task ${index}: 验证很长的任务标题 / A long conversation title for narrow sidebars`,
      });
    }
  }
  await page.evaluate(async (pid) => {
    const w = window as any;
    await w.loadProjects(true);
    // The caches are production renderer inputs; the fixture uses real IPC
    // records in isolated storage, without running a model or writing user data.
    await w.loadConversationProject(pid, { reset: true });
    await w.loadUnprojectedConversations({ reset: true });
  }, project.project_id);
  await page.evaluate((pid) => {
    // Classic-script lexical state is deliberately scoped to this renderer.
    (0, eval)(`_projectsExpanded[${JSON.stringify(pid)}] = true; renderProjectsSection();`);
  }, project.project_id);

  await page.evaluate((pid) => { (window as any).setView('project', pid); }, project.project_id);
  await expect(page.locator('#project-tasks-list > .conversation-list-load-more')).toBeVisible();
  const lists = ['#conversation-list', `[data-pid-children="${project.project_id}"]`, '#project-tasks-list'];
  for (const [language, width, height] of [['zh', 1100, 740], ['en', 900, 600]] as const) {
    await page.setViewportSize({ width, height });
    const existingMore = page.locator('#conversation-list > .conversation-list-load-more');
    const originalButton = await existingMore.elementHandle();
    await existingMore.focus();
    await page.evaluate(async (lang) => { await (window as any).setLang(lang); }, language);
    await expect(existingMore).toBeFocused();
    expect(await existingMore.evaluate((button, original) => button === original, originalButton)).toBe(true);
    for (const list of lists) {
      const more = page.locator(`${list} > .conversation-list-load-more`);
      await expect(more).toBeVisible();
      await expect(more).toHaveText(language === 'zh' ? '显示更多' : 'Show more');
      await more.scrollIntoViewIfNeeded();
      const geometry = await more.evaluate((button) => {
        const row = button.previousElementSibling!;
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          gap: rect.top - row.getBoundingClientRect().bottom,
          height: rect.height,
          footprint: rect.height + parseFloat(style.marginTop) + parseFloat(style.marginBottom),
          fits: button.scrollWidth <= button.clientWidth,
        };
      });
      // Compact pagination belongs to the list: at most a small sibling gap,
      // with a usable target rather than a separate blank section.
      expect(geometry.gap).toBeGreaterThanOrEqual(0);
      expect(geometry.gap).toBeLessThanOrEqual(6);
      expect(geometry.height).toBeGreaterThanOrEqual(24);
      expect(geometry.footprint).toBeLessThanOrEqual(36);
      expect(geometry.fits).toBe(true);
      await more.focus();
      await expect(more).toBeFocused();
      await page.locator(list === '#project-tasks-list' ? '#panel-project' : '.sidebar').screenshot({
        path: info.outputPath(`pagination-${language}-${lists.indexOf(list)}.png`),
      });
    }
  }
  // Pagination still appends the remaining row and removes the exhausted
  // control; layout changes must not affect the real navigation contract.
  for (const list of lists.slice(0, 2)) {
    const more = page.locator(`${list} > .conversation-list-load-more`);
    await more.click();
    await expect(page.locator(`${list} > .conv-item`)).toHaveCount(11);
    await expect(more).toHaveCount(0);
  }
  // The automation history shares the same row and pagination styles. Seed
  // only its read cache; render with the shipped row component and handlers.
  await page.locator('#auto-btn').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any)._autoRenderRow)).toBe('function');
  await page.evaluate(() => {
    (0, eval)(`
      _autoTaskConversationPages.set('layout-history', {
        initialized: true, items: conversations.slice(0, 10), total: 11, nextOffset: 10,
      });
      document.getElementById('auto-list').replaceChildren(_autoRenderRow({
        id: 'layout-history', title: 'Execution history', content: 'Layout preview',
        enabled: false, schedule: { type: 'daily', hour: 3, minute: 0 },
      }, { expanded: true }));
      document.getElementById('auto-empty').style.display = 'none';
    `);
  });
  const historyMore = page.locator('#auto-list .conversation-list-load-more');
  await expect(historyMore).toBeVisible();
  const historyGeometry = await historyMore.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      gap: rect.top - button.previousElementSibling!.getBoundingClientRect().bottom,
      footprint: rect.height + parseFloat(style.marginTop) + parseFloat(style.marginBottom),
    };
  });
  expect(historyGeometry.gap).toBeGreaterThanOrEqual(0);
  expect(historyGeometry.gap).toBeLessThanOrEqual(6);
  expect(historyGeometry.footprint).toBeLessThanOrEqual(36);
  await page.locator('#panel-auto').screenshot({ path: info.outputPath('pagination-auto-history.png') });
});
