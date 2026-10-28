import { expect, test } from './fixtures/orkas';

test('saves a user-owned image service across language changes', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  await page.evaluate(async () => { await (window as any).setLang('en'); });
  await page.locator('#settings-btn').click();
  await page.locator('.settings-tab[data-settings-tab="credentials"]').click();
  await page.locator('#settings-model-tab-image').click();
  await page.locator('[data-settings-add="image"]').click();
  await page.locator('#settings-image-provider .ai-select-trigger').click();
  const choices = page.locator('.ai-select-popover [role="option"]');
  await expect(choices.filter({ hasText: 'DouBao · Seedream 5.0 Lite' })).toHaveCount(1);
  await expect(choices.filter({ hasText: 'DouBao · Seedream 5.0 Pro' })).toHaveCount(1);
  await expect(choices.filter({ hasText: 'DouBao · Seedream 5.0 Lite' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('image-service-picker-en.png') });
  await choices.filter({ hasText: 'DouBao · Seedream 5.0 Lite' }).click();
  await page.locator('#settings-image-key-input').fill('fixture-image-key');
  await page.locator('#settings-image-add-btn').click();
  await expect(page.locator('#settings-image-entries')).toContainText('DouBao · Seedream 5.0 Lite');
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.evaluate(async () => { await (window as any).setLang('zh'); });
  await expect(page.locator('#settings-image-entries')).toContainText('DouBao · Seedream 5.0 Lite');
  await page.screenshot({ path: testInfo.outputPath('image-service-saved-zh-short.png') });
});
