import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, openSidebarEntry, test, type OrkasTestApp } from './fixtures/orkas';
import type { Page } from '@playwright/test';
// Substitute only the OS boundary. Real IPC, task storage, device marker and UI remain intact.
async function isolatedOS(orkas: OrkasTestApp) {
  await orkas.electronApp!.evaluate(({ app }) => {
    const load = (process as any).mainModule.require.bind((process as any).mainModule);
    const fs = load('node:fs'), path = load('node:path');
    const root = app.getAppPath();
    const startup = load(path.join(root, 'src/main/features/login_startup.ts'));
    const users = load(path.join(root, 'src/main/features/users.ts'));
    const auto = load(path.join(root, 'src/main/features/auto_tasks.ts'));
    const file = path.join(process.env.ORKAS_WORKSPACE_ROOT!, 'fixture-startup.json');
    const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { openAtLogin: false, status: 'not-registered' };
    startup.setLoginStartup(startup.createLoginStartup({
      platform: 'darwin', available: true, executable: 'test-only', get: read,
      set: (value: any) => {
        const old = read(); if (old.fail) throw new Error('controlled system refusal');
        fs.writeFileSync(file, JSON.stringify({ openAtLogin: value.openAtLogin, status: value.openAtLogin ? old.approval ? 'requires-approval' : 'enabled' : 'not-registered' }));
      },
      getUser: users.getActiveUserId,
      hasEnabledAutomations: async (uid: string) => (await auto.listTasks(uid)).some((task: any) => task.enabled === true),
    }));
  });
}
async function settings(page: Page) {
  await page.locator('#settings-btn').click();
  await page.locator('[data-settings-tab="general"]').click();
  // Switching settings does not create an OS registration.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
const dialog = (page: Page) => page.locator('.ui-dialog-overlay').filter({ has: page.locator('[data-id="enable-startup"]') });
const device = (orkas: OrkasTestApp) => path.join(orkas.workspaceRoot, 'device.json');
async function createTask(orkas: OrkasTestApp, enabled: boolean) {
  return orkas.invoke<{ task: { id: string } }>('autoTasks.create', { title: 'Startup guidance task', content: 'Prepare a report', enabled, schedule: { type: 'one_time', at: '2099-12-01T10:00:00.000Z' } });
}
test('startup setting starts off with the accepted copy and persists across direct quit', async ({ orkas }, info) => {
  const page = orkas.page!;
  expect((await orkas.invoke<any>('desktop.getStartup')).startup.available).toBe(false);
  await settings(page);
  await expect(page.locator('#settings-startup-toggle')).toBeDisabled();
  await expect(page.locator('#settings-startup-status')).toBeHidden();
  await page.screenshot({ path: info.outputPath('startup-settings-dev.png') });
  await isolatedOS(orkas);
  await orkas.invoke('config.setLanguage', { language: 'zh' }); await page.reload();
  await settings(page);
  await expect(page.locator('#settings-startup-title')).toHaveText('开机启动');
  await expect(page.locator('#settings-startup-description')).toHaveText('电脑开机后，自动启动 Orkas。');
  await expect(page.locator('#settings-startup-toggle')).not.toBeChecked();
  await expect(page.locator('#settings-background-row')).toHaveCount(0);
  await expect(page.locator('#settings-startup-toggle')).toBeEnabled();
  await expect(page.locator('#settings-startup-status')).toBeHidden();
  await expect(page.locator('#settings-startup-open-settings')).toBeHidden();
  await page.screenshot({ path: info.outputPath('startup-settings-zh.png') });
  await page.locator('#settings-startup-toggle').check();
  await expect.poll(async () => (await orkas.invoke<any>('desktop.getStartup')).startup.enabled).toBe(true);
  const reopened = await orkas.relaunch(); await isolatedOS(orkas); await settings(reopened);
  await expect(reopened.locator('#settings-startup-toggle')).toBeChecked();
  await reopened.locator('#settings-startup-toggle').uncheck();
  await expect.poll(async () => (await orkas.invoke<any>('desktop.getStartup')).startup.enabled).toBe(false);
  await expect(reopened.locator('#settings-background-row')).toHaveCount(0);
  expect(existsSync(device(orkas)) ? JSON.parse(readFileSync(device(orkas), 'utf8')).desktop?.background_enabled : undefined).toBeUndefined();
});
test('tab entry prompts only for enabled automation; Not now persists once without enabling or showing a native window', async ({ orkas }, info) => {
  const page = orkas.page!; await isolatedOS(orkas);
  await orkas.invoke('config.setLanguage', { language: 'zh' }); await page.reload();
  const native = await orkas.electronApp!.browserWindow(page);
  await native.evaluate(win => { (win as any).__startupShows = 0; win.on('show', () => { (win as any).__startupShows++; }); });
  await createTask(orkas, false); await openSidebarEntry(page, '#auto-btn');
  await expect(page.locator('.auto-row')).toHaveCount(1); await expect(dialog(page)).toHaveCount(0);
  expect(JSON.parse(readFileSync(device(orkas), 'utf8')).desktop?.startup_prompt_shown).not.toBe(true);
  await page.locator('#new-chat-btn').click(); await createTask(orkas, true);
  await openSidebarEntry(page, '#auto-btn'); await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.modal')).toHaveClass(/modal-standard/);
  await expect(dialog(page).locator('.modal-title')).toHaveText('开启开机启动？');
  await expect(dialog(page).locator('.ui-dialog-message')).toHaveText('你已开启自动化任务，建议开启开机启动，让任务按计划执行。可在「设置 → 通用」修改。');
  await expect(dialog(page).locator('.modal-actions button')).toHaveText(['暂不', '开启']);
  await expect(dialog(page).locator('[data-act="cancel"]')).toBeFocused();
  await page.setViewportSize({ width: 860, height: 640 });
  const buttons = await dialog(page).locator('.modal-actions button').evaluateAll(nodes => nodes.map(n => { const r=n.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom }; }));
  expect(buttons[1].x).toBeGreaterThan(buttons[0].x); expect(Math.abs(buttons[0].y-buttons[1].y)).toBeLessThan(2);
  expect(buttons.every(r => r.right <= 860 && r.bottom <= 640)).toBe(true);
  await page.screenshot({ path: info.outputPath('startup-prompt-zh-narrow.png') });
  await dialog(page).locator('[data-act="cancel"]').click();
  await expect.poll(() => JSON.parse(readFileSync(device(orkas), 'utf8')).desktop?.startup_prompt_shown).toBe(true);
  expect((await orkas.invoke<any>('desktop.getStartup')).startup.enabled).toBe(false);
  expect(existsSync(path.join(orkas.workspaceRoot, 'fixture-startup.json'))).toBe(false);
  expect(await native.evaluate(win => (win as any).__startupShows)).toBe(0);
  const reopened = await orkas.relaunch(); await isolatedOS(orkas); await openSidebarEntry(reopened, '#auto-btn');
  await expect(reopened.locator('.auto-row')).toHaveCount(2); await expect(dialog(reopened)).toHaveCount(0);
});
test('explicit consent reports system refusal in the same standard dialog and supports retry', async ({ orkas }, info) => {
  const page = orkas.page!; await isolatedOS(orkas); await createTask(orkas, true);
  const file = path.join(orkas.workspaceRoot, 'fixture-startup.json');
  writeFileSync(file, JSON.stringify({ openAtLogin: false, status: 'not-registered', fail: true }));
  await openSidebarEntry(page, '#auto-btn'); await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toBeVisible();
  await page.screenshot({ path: info.outputPath('startup-prompt-en.png') });
  await dialog(page).locator('[data-id="enable-startup"]').click();
  await expect(dialog(page).locator('.ui-dialog-error')).toHaveText('Could not change startup settings. Please try again.');
  expect((await orkas.invoke<any>('desktop.getStartup')).startup.enabled).toBe(false);
  writeFileSync(file, JSON.stringify({ openAtLogin: false, status: 'not-registered' }));
  await dialog(page).locator('[data-id="enable-startup"]').click(); await expect(dialog(page)).toHaveCount(0);
  await settings(page); await expect(page.locator('#settings-startup-toggle')).toBeChecked();
  await expect(page.locator('#settings-background-row')).toHaveCount(0);
});
test('pending OS approval and external disable remain authoritative and do not repeatedly offer guidance', async ({ orkas }, info) => {
  const page = orkas.page!; await isolatedOS(orkas); await createTask(orkas, true); await settings(page);
  const file = path.join(orkas.workspaceRoot, 'fixture-startup.json');
  writeFileSync(file, JSON.stringify({ openAtLogin: false, status: 'not-registered', approval: true }));
  // Pending system approval keeps the effective switch off after the click.
  await page.locator('#settings-startup-toggle').click();
  await expect(page.locator('#settings-startup-status')).toHaveText('Allow Orkas in your system startup settings.');
  await expect(page.locator('#settings-startup-open-settings')).toBeVisible();
  await expect(page.locator('#settings-startup-toggle')).not.toBeChecked();
  await page.screenshot({ path: info.outputPath('startup-approval-en.png') });
  await openSidebarEntry(page, '#auto-btn'); await expect(page.locator('.auto-row')).toHaveCount(1); await expect(dialog(page)).toHaveCount(0);
  writeFileSync(file, JSON.stringify({ openAtLogin: true, status: 'enabled' }));
  await settings(page); await expect(page.locator('#settings-startup-toggle')).toBeChecked();
  writeFileSync(file, JSON.stringify({ openAtLogin: false, status: 'not-registered' }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#settings-startup-toggle')).not.toBeChecked();
});
test('a failed settings write restores the OS switch state and supports explicit retry without adding obsolete background preferences', async ({ orkas }) => {
  const page = orkas.page!; await isolatedOS(orkas); await settings(page);
  const file = path.join(orkas.workspaceRoot, 'fixture-startup.json');
  writeFileSync(file, JSON.stringify({ openAtLogin: false, status: 'not-registered', fail: true }));
  await page.locator('#settings-startup-toggle').click();
  await expect(page.getByText('Could not change startup settings. Please try again.', { exact: true })).toBeVisible();
  await expect(page.locator('#settings-startup-toggle')).not.toBeChecked();
  await expect(page.locator('#settings-startup-toggle')).toBeEnabled();
  expect((await orkas.invoke<any>('desktop.getStartup')).startup.enabled).toBe(false);
  writeFileSync(file, JSON.stringify({ openAtLogin: false, status: 'not-registered' }));
  await page.locator('#settings-startup-toggle').check();
  await expect.poll(async () => (await orkas.invoke<any>('desktop.getStartup')).startup.enabled).toBe(true);
  await expect(page.locator('#settings-background-row')).toHaveCount(0);
});
test('already enabled startup suppresses guidance without consuming it; an external disable makes guidance eligible', async ({ orkas }) => {
  const page = orkas.page!; await isolatedOS(orkas); await createTask(orkas, true); await settings(page);
  await page.locator('#settings-startup-toggle').check();
  await expect.poll(async () => (await orkas.invoke<any>('desktop.getStartup')).startup.enabled).toBe(true);
  await openSidebarEntry(page, '#auto-btn'); await expect(page.locator('.auto-row')).toHaveCount(1);
  await expect(dialog(page)).toHaveCount(0);
  expect(JSON.parse(readFileSync(device(orkas), 'utf8')).desktop?.startup_prompt_shown).not.toBe(true);
  await page.locator('#new-chat-btn').click();
  writeFileSync(path.join(orkas.workspaceRoot, 'fixture-startup.json'), JSON.stringify({ openAtLogin: false, status: 'not-registered' }));
  await openSidebarEntry(page, '#auto-btn'); await expect(dialog(page)).toBeVisible();
  await dialog(page).locator('[data-act="cancel"]').click();
  expect((await orkas.invoke<any>('desktop.getStartup')).startup.enabled).toBe(false);
});
