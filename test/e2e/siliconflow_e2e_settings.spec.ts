import { expect, test } from './fixtures/orkas';

for (const language of ['en', 'zh'] as const) {
  test(`adds and reopens a SiliconFlow model without custom endpoint fields (${language})`, async ({ orkas: app }, testInfo) => {
    const page = app.page!;
    const guard = async () => app.electronApp!.evaluate(() => {
      (globalThis as any).__siliconFlowCalls = 0;
      const original = globalThis.fetch;
      globalThis.fetch = ((input: any, init: any) => {
        const url = typeof input === 'string' ? input : input.url || input.href;
        if (new URL(url).hostname === 'api.siliconflow.cn') {
          (globalThis as any).__siliconFlowCalls++;
          throw new Error('Unexpected live SiliconFlow request');
        }
        return original(input, init);
      }) as typeof fetch;
    });
    const openSettings = async (current: typeof page) => {
      await current.locator('#settings-btn').click();
      await current.locator('.settings-tab[data-settings-tab="credentials"]').click();
    };
    await guard();
    await page.evaluate(language => (window as any).setLang(language), language);
    await openSettings(page);
    await page.locator('[data-settings-add="chat"]').click();
    await page.locator('#settings-picker-provider .ai-select-trigger').click();
    await page.locator('.ai-select-popover:visible .ai-select-item', { hasText: 'SiliconFlow' }).click();
    await page.locator('#settings-picker-model .ai-select-trigger').click();
    await expect(page.locator('.ai-select-popover:visible')).toContainText('Qwen3.8 27B');
    await page.locator('.ai-select-popover:visible .ai-select-item', { hasText: 'DeepSeek V4 Flash' }).click();
    await page.screenshot({ path: testInfo.outputPath('provider-selected.png') });
    await page.locator('#settings-add-entry-btn').click();
    const modal = page.locator('#add-account-modal');
    await expect(modal.locator('.api-key-input')).toBeVisible();
    await expect(modal.locator('.custom-base-url-input')).toHaveCount(0);
    await modal.locator('.api-key-input').fill('synthetic-siliconflow-native-key');
    await modal.locator('#add-account-actions .btn-primary').click();
    await expect(modal).not.toHaveClass(/\bopen\b/);
    const listed = await app.invoke<any>('auth.listEntries');
    expect(listed.entries).toContainEqual(expect.objectContaining({
      provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Flash', modelAvailable: true,
    }));
    expect(await app.electronApp!.evaluate(() => (globalThis as any).__siliconFlowCalls)).toBe(0);
    const reopened = await app.relaunch();
    await guard();
    await openSettings(reopened);
    await reopened.setViewportSize({ width: 1024, height: 720 });
    await expect(reopened.locator('#settings-entries')).toContainText('SiliconFlow');
    await expect(reopened.locator('#settings-entries')).not.toContainText('synthetic-siliconflow-native-key');
    await reopened.screenshot({ path: testInfo.outputPath('configured-narrow.png') });
    expect(await app.electronApp!.evaluate(() => (globalThis as any).__siliconFlowCalls)).toBe(0);
  });
}
