import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/orkas';

async function openGeneralSettings(page: Page): Promise<void> {
  await page.locator('#settings-btn').click();
  await expect(page.locator('#panel-settings')).toHaveClass(/\bactive\b/);
  const tab = page.locator('.settings-tab[data-settings-tab="general"]');
  await tab.click();
  await expect(tab).toHaveClass(/\bis-active\b/);
  await expect(page.locator('[data-settings-pane="general"]')).toBeVisible();
}

test.describe('settings persistence', () => {
  test('persists the Agent self-evolution preference through the real settings UI', async ({ metacognitionOrkas }) => {
    if (!metacognitionOrkas.page) throw new Error('Orkas renderer is unavailable');
    await openGeneralSettings(metacognitionOrkas.page);

    const toggle = metacognitionOrkas.page.locator('#settings-metacognition-toggle');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect.poll(async () => {
      const state = await metacognitionOrkas.invoke<{ enabled: boolean }>('prefs.getMetacognition');
      return state.enabled;
    }).toBe(true);

    const relaunchedPage = await metacognitionOrkas.relaunch();
    await openGeneralSettings(relaunchedPage);
    await expect(relaunchedPage.locator('#settings-metacognition-toggle')).toBeChecked();
    const persisted = await metacognitionOrkas.invoke<{ enabled: boolean }>('prefs.getMetacognition');
    expect(persisted.enabled).toBe(true);
  });

  test('keeps language and notification preferences after relaunch', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    await openGeneralSettings(orkas.page);

    const languageSelect = orkas.page.locator('#settings-language-select');
    const notifications = orkas.page.locator('#settings-task-notifications-toggle');
    await expect(languageSelect).toHaveAttribute('data-value', 'en');
    await expect(notifications).toBeChecked();

    await languageSelect.locator('.ai-select-trigger').click();
    const japaneseOption = orkas.page
      .locator('body > .ai-select-popover:not([hidden]) .ai-select-item')
      .filter({ hasText: '日本語' });
    await expect(japaneseOption).toBeVisible();
    await japaneseOption.click();
    await notifications.uncheck();

    await expect.poll(async () => {
      return orkas.page?.evaluate(async () => {
        const language = await (window as any).orkas.invoke('config.getLanguage');
        const taskNotifications = await (window as any).orkas.invoke('prefs.getTaskNotifications');
        return {
          language: language.language,
          notifications: taskNotifications.enabled,
        };
      });
    }, {
      // The read includes the real OS notification-permission probe. On
      // Windows that bounded PowerShell process can be slow to tear down when
      // the complete desktop suite is under load.
      timeout: 30_000,
    }).toEqual({ language: 'ja', notifications: false });

    const relaunchedPage = await orkas.relaunch();
    await openGeneralSettings(relaunchedPage);
    await expect(relaunchedPage.locator('#settings-language-select')).toHaveAttribute('data-value', 'ja');
    await expect(relaunchedPage.locator('#settings-task-notifications-toggle')).not.toBeChecked();
  });

  test('changes all local execution modes in the UI and persists the selected mode', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    await openGeneralSettings(orkas.page);

    const mode = (value: string) => orkas.page!.locator(
      `#settings-localexec-modes input[name="localexec-mode"][value="${value}"]`,
    );
    await expect(mode('all_files_approval')).toBeChecked();

    await mode('workspace_approval').check();
    await expect.poll(async () => {
      const state = await orkas.invoke<{ mode: string }>('permissions.getLocalExec');
      return state.mode;
    }).toBe('workspace_approval');

    await mode('all_files_auto').check();
    await expect.poll(async () => {
      const state = await orkas.invoke<{ mode: string }>('permissions.getLocalExec');
      return state.mode;
    }).toBe('all_files_auto');

    const relaunchedPage = await orkas.relaunch();
    await openGeneralSettings(relaunchedPage);
    await expect(relaunchedPage.locator(
      '#settings-localexec-modes input[name="localexec-mode"][value="all_files_auto"]',
    )).toBeChecked();

    await relaunchedPage.locator(
      '#settings-localexec-modes input[name="localexec-mode"][value="all_files_approval"]',
    ).check();
    await expect.poll(async () => {
      const state = await orkas.invoke<{ mode: string }>('permissions.getLocalExec');
      return state.mode;
    }).toBe('all_files_approval');

    const secondRelaunch = await orkas.relaunch();
    await openGeneralSettings(secondRelaunch);
    await expect(secondRelaunch.locator(
      '#settings-localexec-modes input[name="localexec-mode"][value="all_files_approval"]',
    )).toBeChecked();
  });
});
