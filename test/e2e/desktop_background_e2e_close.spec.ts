import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/orkas';
import { trayMenu, selectTrayItem } from './fixtures/desktop-tray';
import type { Page } from '@playwright/test';
async function settings(page: Page) {
  await page.locator('#settings-btn').click();
  await page.locator('[data-settings-tab="general"]').click();
  await expect(page.locator('#settings-startup-row')).toBeVisible();
  await expect(page.locator('#settings-background-row')).toHaveCount(0);
}
test('first and repeated closes preserve the same renderer and draft; legacy settings cannot disable background running', async ({ orkas }, info) => {
  const page = orkas.page!, electron = orkas.electronApp!;
  await page.locator('#new-chat-input').fill('Preserve this unsent draft');
  await settings(page);
  await page.screenshot({ path: info.outputPath('settings-en.png') });
  const file = path.join(orkas.workspaceRoot, 'device.json');
  const original = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (!original.device_id) original.device_id = 'preserved-legacy-device';
  const legacy = { ...original, future: { preserved: true }, desktop: { ...original.desktop,
    background_enabled: false, close_choice_made: false, startup_prompt_shown: true, future: 'preserved' } };
  writeFileSync(file, JSON.stringify(legacy));
  const native = await electron.browserWindow(page);
  await native.evaluate(win => { (win as any).__shows = 0; win.on('show', () => { (win as any).__shows++; }); });
  for (let i = 0; i < 2; i++) {
    await native.evaluate(win => win.close());
    await expect(page.locator('.ui-dialog-overlay.open')).toHaveCount(0);
    expect(await native.evaluate(win => ({ destroyed: win.isDestroyed(), visible: win.isVisible(), shows: (win as any).__shows })))
      .toEqual({ destroyed: false, visible: false, shows: 0 });
    expect(await trayMenu(electron, i === 0 ? 'click' : 'right-click')).toEqual([
      { label: 'Open', type: 'normal', enabled: true }, { label: 'Quit', type: 'normal', enabled: true }]);
    await selectTrayItem(electron, 0);
    await expect(page.locator('#new-chat-input')).toHaveText('Preserve this unsent draft');
  }
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(legacy);
  await orkas.invoke('config.setLanguage', { language: 'zh' }); await page.reload(); await settings(page);
  expect((await trayMenu(electron)).map(item => item.label)).toEqual(['打开', '退出']);
  await page.setViewportSize({ width: 860, height: 640 });
  await expect(page.locator('#settings-startup-description')).toHaveText('电脑开机后，自动启动 Orkas。');
  const bounds = await page.locator('#settings-startup-row').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(860);
  await page.screenshot({ path: info.outputPath('settings-zh-narrow.png') });
  expect(await native.evaluate(win => (win as any).__shows)).toBe(0);
  const reopened = await orkas.relaunch(); await settings(reopened);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(legacy);
});
test('corrupt legacy preferences cannot prevent closing to background or create a warning', async ({ orkas }) => {
  const file = path.join(orkas.workspaceRoot, 'device.json');
  const original = existsSync(file) ? readFileSync(file, 'utf8') : null;
  try {
    writeFileSync(file, '{invalid');
    const native = await orkas.electronApp!.browserWindow(orkas.page!);
    await native.evaluate(win => win.close());
    expect(await native.evaluate(win => ({ alive: !win.isDestroyed(), hidden: !win.isVisible() }))).toEqual({ alive: true, hidden: true });
    await expect(orkas.page!.locator('.ui-dialog-overlay.open')).toHaveCount(0);
    expect(readFileSync(file, 'utf8')).toBe('{invalid');
  } finally { if (original === null) unlinkSync(file); else writeFileSync(file, original); }
});
