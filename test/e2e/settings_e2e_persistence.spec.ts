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

  test('switches tabs immediately while settings loads and preserves the choice after repeated loads', async ({ orkas }) => {
    const page = orkas.page!;
    await page.evaluate(() => {
      const root = window as any;
      const original = root.loadRendererFeature;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      root.__releaseSettingsFeature = release;
      root.__settingsFeatureHeld = false;
      root.loadRendererFeature = async (name: string) => {
        if (name === 'settings') { root.__settingsFeatureHeld = true; await gate; }
        return original(name);
      };
    });
    try {
      await page.locator('#settings-btn').click();
      const general = page.locator('.settings-tab[data-settings-tab="general"]');
      const models = page.locator('.settings-tab[data-settings-tab="credentials"]');
      await general.click();
      await expect(general).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[data-settings-pane="general"]')).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as any).__settingsFeatureHeld)).toBe(true);
      expect(await page.evaluate(() => typeof (window as any).loadSettings)).toBe('undefined');
      await general.press('ArrowLeft');
      await expect(models).toBeFocused();
      await expect(models).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[data-settings-pane="credentials"]')).toBeVisible();
      await models.press('End');
      await expect(general).toBeFocused();
      await expect(general).toHaveAttribute('aria-selected', 'true');
      await page.evaluate(async () => {
        const root = window as any;
        root.__releaseSettingsFeature();
        await root.loadRendererFeature('settings');
        await root.loadSettings();
        await root.loadSettings();
      });
      await expect(general).toHaveAttribute('aria-selected', 'true');
      await general.press('ArrowLeft');
      await expect(models).toBeFocused();
      await expect(models).toHaveAttribute('aria-selected', 'true');
    } finally {
      await page.evaluate(() => (window as any).__releaseSettingsFeature());
    }
  });


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

  for (const [code, label, htmlLang = code] of [
    ['es', 'Español'], ['fr', 'Français'], ['ko', '한국어'],
    ['de', 'Deutsch'], ['ru', 'Русский'], ['it', 'Italiano'],
    ["ar", "العربية", "ar"],
    ["zh-tw", "繁體中文", "zh-TW"],
    ["hi", "हिन्दी", "hi"],
    ["id", "Bahasa Indonesia", "id"],
    ["pt-pt", "Português (Portugal)", "pt-PT"],
    ["es-419", "Español (Latinoamérica)", "es-419"],
    ["th", "ไทย", "th"],
    ["tr", "Türkçe", "tr"],
    ["vi", "Tiếng Việt", "vi"],

  ]) {
    test(`selects ${code} from the language menu and restores it on first paint`, async ({ orkas }, testInfo) => {
      const page = orkas.page!;
      await openGeneralSettings(page);
      const select = page.locator('#settings-language-select');
      await select.locator('.ai-select-trigger').click();
      const option = page.locator('body > .ai-select-popover:not([hidden]) .ai-select-item').getByText(label, { exact: true });
      await option.click();
      await expect(page.locator('html')).toHaveAttribute('lang', htmlLang);
      await expect(select).toHaveAttribute('data-value', code);
      await expect(page.locator('html')).toHaveAttribute('dir', code === 'ar' ? 'rtl' : 'ltr');
      await page.locator('[data-settings-pane="general"]').screenshot({ path: testInfo.outputPath('settings-' + code + '.png') });
      const overflow = await page.locator('[data-settings-pane="general"]').evaluate((element) => {
        return element.scrollWidth > element.clientWidth + 1;
      });
      expect(overflow).toBe(false);
      const reopened = await orkas.relaunch();
      await expect(reopened.locator('html')).toHaveAttribute('lang', htmlLang);
      await openGeneralSettings(reopened);
      await expect(reopened.locator('#settings-language-select')).toHaveAttribute('data-value', code);
    });
  }

  test('changes all local execution modes in the UI and persists the selected mode', async ({ orkas }, testInfo) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    await openGeneralSettings(orkas.page);

    await orkas.page.locator('#settings-language-select .ai-select-trigger').click();
    await orkas.page.locator('body > .ai-select-popover:not([hidden]) .ai-select-item').filter({ hasText: '简体中文' }).click();
    await expect(orkas.page.locator('html')).toHaveAttribute('lang', 'zh-CN');

    for (const width of [1280, 600]) {
      await orkas.page.setViewportSize({ width, height: 900 });
      const layout = await orkas.page.locator('#settings-localexec-modes').evaluate(list => {
        const row = list.closest('.settings-row')!;
        const title = row.querySelector('.settings-row-title')!;
        const review = document.getElementById('settings-metacognition-title')!;
        const rect = (node: Element) => { const box = node.getBoundingClientRect(); return { x: box.x, right: box.right, width: box.width }; };
        return { title: rect(title), review: rect(review), list: rect(list), row: rect(row),
          padding: parseFloat(getComputedStyle(row).paddingLeft),
          options: Array.from(list.querySelectorAll('.settings-mode-opt'), rect) };
      });
      expect(Math.abs(layout.title.x - layout.review.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.list.x - layout.title.x)).toBeLessThanOrEqual(1);
      expect(layout.padding).toBe(width > 640 ? 18 : 16);
      expect(Math.abs(layout.list.width - (layout.row.width - 2 * layout.padding))).toBeLessThanOrEqual(1);
      for (const option of layout.options) {
        expect(Math.abs(option.x - layout.title.x)).toBeLessThanOrEqual(1);
        expect(option.right).toBeLessThanOrEqual(layout.row.right - layout.padding + 1);
      }
      await orkas.page.locator('.settings-section').filter({ has: orkas.page.locator('#settings-localexec-modes') })
        .screenshot({ path: testInfo.outputPath(`settings-agent-behavior-${width}.png`) });
    }
    await orkas.page.setViewportSize({ width: 1280, height: 900 });

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
