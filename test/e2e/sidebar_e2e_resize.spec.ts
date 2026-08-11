import { expect, test } from './fixtures/orkas';

test.describe('sidebar resizing', () => {
  test('is keyboard accessible, persists, and yields space back on narrow windows', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    let page = orkas.page;
    let handle = page.locator('#sidebar-resize-handle');
    const sidebar = page.locator('.sidebar');

    await expect(handle).toHaveAttribute('role', 'separator');
    await expect(handle).toHaveAttribute('tabindex', '0');
    await handle.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', '480');
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width || 0)).toBe(480);
    await expect.poll(() => page.evaluate(
      () => localStorage.getItem('orkas:sidebar-width'),
    )).toBe('480');

    page = await orkas.relaunch();
    handle = page.locator('#sidebar-resize-handle');
    await expect.poll(async () => Math.round(
      (await page.locator('.sidebar').boundingBox())?.width || 0,
    )).toBe(480);

    await page.setViewportSize({ width: 700, height: 800 });
    await expect(handle).toHaveAttribute('aria-valuemax', '380');
    await expect(handle).toHaveAttribute('aria-valuenow', '380');
    await expect.poll(async () => Math.round(
      (await page.locator('.sidebar').boundingBox())?.width || 0,
    )).toBe(380);
    expect(await page.evaluate(() => localStorage.getItem('orkas:sidebar-width'))).toBe('480');

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(handle).toHaveAttribute('aria-valuenow', '480');
    await handle.press('Home');
    await expect(handle).toHaveAttribute('aria-valuenow', '180');
  });
});
