import { expect, openSidebarEntry, test } from './fixtures/orkas';


// The real form, IPC persistence and relaunch are the independent UI oracle.
// No selector-specific replacement markup is used.
test('calendar selections retain single-mode chrome and multi-mode right checks across relaunch', async ({ orkas }, testInfo) => {
  if (!orkas.page) throw new Error('Renderer unavailable');
  let page = orkas.page;
  await openSidebarEntry(page, '#auto-btn');
  await page.locator('#auto-add-btn').click();
  const choose = async (mount: string, value: string) => {
    await page.locator(`${mount} .ai-select-trigger`).click();
    await page.locator(`${mount}-listbox .ai-select-item[data-value="${value}"]`).click();
  };
  await choose('#auto-freq-select', 'weekly');
  await page.locator('#auto-weekday-select .ai-select-trigger').click();
  let popover = page.locator('#auto-weekday-select-listbox');
  await expect(popover.locator('.ai-select-multiple-toggle')).not.toBeChecked();
  await expect(popover.locator('.ai-select-check')).toHaveCount(0);
  await expect(popover.locator('[data-value="workdays"] .ai-select-item-hint')).toHaveCount(0);
  await popover.locator('.ai-select-item[data-value="workdays"]').click();
  await expect(popover).toBeHidden();
  await page.locator('#auto-weekday-select .ai-select-trigger').click();
  await popover.locator('.ai-select-multiple-toggle').check();
  await expect(popover.locator('[data-value="workdays"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(popover.locator('[aria-selected="true"] .ai-select-check')).toHaveCount(5);
  // Reduce the expanded workdays to Monday/Wednesday, without closing.
  for (const value of ['2', '4', '5']) await popover.locator(`[data-value="${value}"]`).click();
  await expect(popover).toBeVisible();
  await expect(page.locator('#auto-weekday-select .ai-select-label')).toHaveText('Mon, Wed');
  const row = await popover.locator('[data-value="3"]').boundingBox();
  const check = await popover.locator('[data-value="3"] .ai-select-check').boundingBox();
  expect(check!.x).toBeGreaterThan(row!.x + row!.width * 0.7);
  await page.screenshot({ path: testInfo.outputPath('weekly-multiple.png') });
  await page.keyboard.press('Escape');
  await page.locator('#auto-task-input').fill('Review the selected calendar days');
  await page.locator('#auto-title-input').fill('Calendar selection');
  await page.locator('#auto-enabled-input').uncheck();
  await page.locator('#auto-submit-btn').click();
  await expect(page.locator('#auto-task-dialog-overlay')).toBeHidden();
  const listed = await orkas.invoke<any>('autoTasks.list');
  const saved = listed.tasks.find((task: any) => task.title === 'Calendar selection');
  expect(saved.schedule).toEqual({ type: 'weekly', weekdays: [1, 3], hour: 9, minute: 0 });
  page = await orkas.relaunch();
  await openSidebarEntry(page, '#auto-btn');
  const rowEl = page.locator(`.auto-row[data-task-id="${saved.id}"]`);
  await rowEl.hover();await rowEl.locator('.auto-row-more').click();
  await page.locator('.auto-row-menu [data-action="edit"]').click();
  await expect(page.locator('#auto-weekday-select .ai-select-label')).toHaveText('Mon, Wed');
  await page.locator('#auto-weekday-select .ai-select-trigger').click();
  popover = page.locator('#auto-weekday-select-listbox');
  await expect(popover.locator('.ai-select-multiple-toggle')).toBeChecked();
  await popover.locator('.ai-select-multiple-toggle').uncheck();
  await expect(popover.locator('.ai-select-check')).toHaveCount(0);
  await expect(page.locator('#auto-weekday-select .ai-select-label')).not.toHaveText('Mon, Wed');
  await popover.locator('[data-value="5"]').click();
  await choose('#auto-freq-select', 'monthly');
  await page.locator('#auto-monthly-day-select .ai-select-trigger').click();
  const dates = page.locator('#auto-monthly-day-select-listbox');
  await dates.locator('.ai-select-multiple-toggle').check();
  for (const value of ['8', '19']) await dates.locator(`[data-value="${value}"]`).click();
  await page.keyboard.press('Escape');
  await page.locator('#auto-submit-btn').click();
  await expect(page.locator('#auto-task-dialog-overlay')).toBeHidden();
  expect((await orkas.invoke<any>('autoTasks.list')).tasks.find((task: any) => task.id === saved.id).schedule)
    .toEqual({ type: 'monthly', days: [1, 8, 19], hour: 9, minute: 0 });
  page = await orkas.relaunch();await openSidebarEntry(page, '#auto-btn');
  const monthlyRow = page.locator(`.auto-row[data-task-id="${saved.id}"]`);
  await monthlyRow.hover();await monthlyRow.locator('.auto-row-more').click();
  await page.locator('.auto-row-menu [data-action="edit"]').click();
  await page.locator('#auto-monthly-day-select .ai-select-trigger').click();
  await expect(page.locator('#auto-monthly-day-select-listbox .ai-select-multiple-toggle')).toBeChecked();
  for (const value of ['1', '8', '19']) await expect(page.locator(`#auto-monthly-day-select-listbox [data-value="${value}"]`)).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: testInfo.outputPath('monthly-multiple.png') });
});

test('Chinese calendar selection supports keyboard, IME, empty-mode recovery and workday persistence', async ({}, testInfo) => {
  const { OrkasTestApp } = await import('./fixtures/orkas');
  const app = new OrkasTestApp(testInfo, { seedLanguage: 'zh' });
  try {
    await app.launch();
    let page = app.page;
    if (!page) throw new Error('Renderer unavailable');
    await page.setViewportSize({ width: 900, height: 650 });
    await openSidebarEntry(page, '#auto-btn');await page.locator('#auto-add-btn').click();
    await page.locator('#auto-freq-select .ai-select-trigger').click();
    await page.locator('#auto-freq-select-listbox [data-value="weekly"]').click();
    const trigger = page.locator('#auto-weekday-select .ai-select-trigger');
    await trigger.click();
    const list = page.locator('#auto-weekday-select-listbox');
    await list.locator('.ai-select-multiple-toggle').check();
    await page.keyboard.press('Escape');await trigger.click();
    await page.keyboard.press('ArrowDown');
    await trigger.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(page.locator('#auto-weekday-select .ai-select-label')).toHaveText('周一');
    await page.keyboard.press('Enter');
    await expect(page.locator('#auto-weekday-select .ai-select-label')).toHaveText('周一，周二');
    await page.screenshot({ path: testInfo.outputPath('chinese-narrow-multiple.png') });
    const bounds = await list.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650);
    await page.keyboard.press('Tab');
    await expect(list).toBeHidden();
    await expect(page.locator('#auto-hour-select .ai-select-trigger')).toBeFocused();
    await trigger.click();
    await list.locator('.ai-select-multiple-toggle').uncheck();
    await expect(list.locator('.ai-select-check')).toHaveCount(0);
    await expect(page.locator('#auto-submit-btn')).toBeDisabled();
    await list.locator('[data-value="workdays"]').click();
    await expect(list).toBeHidden();await expect(page.locator('#auto-submit-btn')).toBeEnabled();
    await page.locator('#auto-task-input').fill('工作日检查');await page.locator('#auto-enabled-input').uncheck();
    await page.locator('#auto-submit-btn').click();await expect(page.locator('#auto-task-dialog-overlay')).toBeHidden();
    page = await app.relaunch();
    const task = (await app.invoke<any>('autoTasks.list')).tasks[0];
    expect(task.schedule).toEqual({ type: 'weekly', weekday: 'workdays', hour: 9, minute: 0 });
    await openSidebarEntry(page, '#auto-btn');
    const row = page.locator(`.auto-row[data-task-id="${task.id}"]`);await row.hover();await row.locator('.auto-row-more').click();
    await page.locator('.auto-row-menu [data-action="edit"]').click();
    await expect(page.locator('#auto-weekday-select .ai-select-label')).toHaveText('工作日');
    await page.locator('#auto-weekday-select .ai-select-trigger').click();
    await expect(page.locator('#auto-weekday-select-listbox .ai-select-multiple-toggle')).not.toBeChecked();
    await expect(page.locator('#auto-weekday-select-listbox .ai-select-check')).toHaveCount(0);
  } finally { await app.dispose(); }
});
