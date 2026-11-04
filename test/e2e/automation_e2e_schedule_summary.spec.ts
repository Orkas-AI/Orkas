import type { Page } from '@playwright/test';
import { expect, openSidebarEntry, test } from './fixtures/orkas';


async function expectCardLayout(page: Page) {
  const rows = page.locator('#auto-list .auto-row');
  for (const row of await rows.all()) {
    await row.scrollIntoViewIfNeeded();
    await expect(row.locator('.auto-row-lastrun')).toHaveCount(0);
    const summary = row.locator('.auto-row-schedule');
    const before = await summary.boundingBox();
    await row.hover();
    const menu = row.locator('.auto-row-more');
    await expect(menu).toHaveCSS('opacity', '1');
    expect(await summary.boundingBox()).toEqual(before);
    const geometry = await row.evaluate(el => {
      const button = el.querySelector('.auto-row-more')!.getBoundingClientRect();
      const card = el.getBoundingClientRect();
      const main = el.querySelector('.auto-row-main')!.getBoundingClientRect();
      const primary = (el.querySelector('.auto-row-title') || el.querySelector('.auto-row-content'))!.getBoundingClientRect();
      const message = el.querySelector('.auto-row-content')!.getBoundingClientRect();
      const schedule = el.querySelector('.auto-row-schedule')!.getBoundingClientRect();
      const chips = el.querySelector('.auto-row-chips')!.getBoundingClientRect();
      const textBoxes: Array<{ left: number; right: number; top: number }> = [];
      const scheduleColors = new Set<string>();
      for (const selector of ['.auto-row-title', '.auto-row-content', '.auto-row-schedule', '.auto-row-chips']) {
        const target = el.querySelector(selector);
        if (!target) continue;
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim()) continue;
          if (selector === '.auto-row-schedule') scheduleColors.add(getComputedStyle(walker.currentNode.parentElement!).color);
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          for (const box of range.getClientRects()) textBoxes.push({ left: box.left, right: box.right, top: box.top });
        }
      }
      return {
        rtl: getComputedStyle(el).direction === 'rtl',
        topGap: primary.top - card.top,
        previewBottom: message.bottom,
        schedule: { top: schedule.top, bottom: schedule.bottom, width: schedule.width },
        footerTop: chips.top,
        mainWidth: main.width,
        scheduleColors: Array.from(scheduleColors),
        menu: { left: button.left, right: button.right, bottom: button.bottom },
        content: textBoxes,
      };
    });
    expect(geometry.topGap).toBeLessThanOrEqual(18);
    expect(geometry.schedule.top).toBeGreaterThanOrEqual(geometry.previewBottom + 8);
    expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.schedule.bottom + 8);
    expect(geometry.schedule.width).toBeGreaterThanOrEqual(geometry.mainWidth - 1);
    expect(geometry.scheduleColors).toHaveLength(1);
    for (const box of geometry.content) {
      const beside = geometry.rtl ? box.left >= geometry.menu.right + 4 : box.right <= geometry.menu.left - 4;
      expect(beside || box.top >= geometry.menu.bottom + 4).toBe(true);
    }
  }
  await rows.first().hover();
  await rows.first().locator('.auto-row-more').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.auto-row-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.auto-row-menu')).toBeHidden();
  await expect(rows.first().locator('.auto-row-more')).toHaveAttribute('aria-expanded', 'false');
  await expect(rows.first().locator('.auto-row-more')).toBeFocused();
}

test('calendar summaries remain readable across every locale and narrow windows', async ({ orkas }, testInfo) => {
  test.setTimeout(120_000);
  const page = orkas.page;
  if (!page) throw new Error('Renderer unavailable');
  const schedules = [
    { type: 'weekly', weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
    { type: 'monthly', days: [1, 4, 5, 9, 12, 18, 20, 22, 27, 29], hour: 9, minute: 0 },
    { type: 'monthly', days: [1, 2, 31], hour: 9, minute: 0 },
  ];
  const ids: string[] = [];
  for (const [index, schedule] of schedules.entries()) {
    const result = await orkas.invoke<any>('autoTasks.create', {
      title: index === 2 ? undefined : index === 0 ? 'Weekly review with a long title to check available space' : `Calendar review ${index}`,
      content: index === 2
        ? 'Review calendar selections and prepare a concise report of upcoming deadlines, completed work, and items that need attention.'
        : 'Review calendar selections',
      enabled: false, schedule,
    });
    expect(result.ok).toBe(true);
    ids.push(result.task.id);
  }
  await openSidebarEntry(page, '#auto-btn');
  const summaries = page.locator('#auto-list .auto-row-schedule');
  const { tables } = await orkas.invoke<{ tables: Record<string, object> }>('config.getLocales');
  for (const code of Object.keys(tables)) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(async lang => { await (window as any).setLang(lang); }, code);
    await expect.poll(() => page.evaluate(() => (window as any).getLang())).toBe(code);
    await expect(summaries).toHaveCount(3);
    const weekly = page.locator(`.auto-row[data-task-id="${ids[0]}"] .auto-row-schedule`);
    if (code === 'zh') await expect(weekly).toHaveText('每周一，二，三，四，五 09:00');
    if (code === 'en') await expect(weekly).toHaveText('Every Mon, Tue, Wed, Thu, Fri at 09:00');
    for (const summary of await summaries.all()) {
      await expect(summary).toContainText('09:00');
      await expect(summary).not.toContainText(/auto\.|\{\w+\}/);
    }
    await expectCardLayout(page);
    await page.screenshot({ path: testInfo.outputPath(`summary-${code}.png`) });
    if (code === 'zh') await page.locator('#auto-list .auto-scope-cards').screenshot({ path: testInfo.outputPath('cards-zh.png') });
    if (['zh', 'en', 'ar', 'de', 'ja', 'pt'].includes(code)) {
      await page.setViewportSize({ width: 900, height: 650 });
      await expectCardLayout(page);
      const geometry = await summaries.evaluateAll(elements => elements.map(el => ({
        client: el.clientWidth, scroll: el.scrollWidth, left: el.getBoundingClientRect().left,
        right: el.getBoundingClientRect().right,
      })));
      for (const box of geometry) {
        expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(900);
      }
      await page.screenshot({ path: testInfo.outputPath(`summary-${code}-narrow.png`) });
    }
  }
  const listed = await orkas.invoke<any>('autoTasks.list');
  for (const [index, id] of ids.entries()) {
    expect(listed.tasks.find((task: any) => task.id === id).schedule).toEqual(schedules[index]);
  }
});
