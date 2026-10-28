import { expect, test } from './fixtures/orkas';

for (const language of ['en', 'zh'] as const) {
  test.describe(`DeepSeek search settings (${language})`, () => {
    test('adds a user key, preserves it after restart, and removes only that provider', async ({ modelOrkas: orkas }, testInfo) => {
      const open = async (page: import('@playwright/test').Page) => {
        await page.locator('#settings-btn').click();
        await page.locator('.settings-tab[data-settings-tab="credentials"]').click();
        await page.locator('[data-settings-model-tab="search"]').click();
      };
      if (!orkas.page) throw new Error('Renderer unavailable');
      const installNetworkGuard = async () => {
        await orkas.electronApp!.evaluate(() => {
          const state = globalThis as typeof globalThis & { __deepseekSettingsExternalRequests?: number };
          state.__deepseekSettingsExternalRequests = 0;
          const original = globalThis.fetch;
          globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(raw).hostname)) {
              state.__deepseekSettingsExternalRequests! += 1;
              return Promise.reject(new Error('E_E2E_UNEXPECTED_EXTERNAL_REQUEST'));
            }
            return original(input, init);
          }) as typeof fetch;
        });
      };
      const expectLocalOnly = async () => {
        expect(await orkas.electronApp!.evaluate(() => (globalThis as any).__deepseekSettingsExternalRequests)).toBe(0);
        expect(orkas.modelRequests).toHaveLength(0);
        expect(orkas.imageGenerationRequests).toHaveLength(0);
        expect(orkas.videoGenerationRequests).toHaveLength(0);
      };
      await installNetworkGuard();
      expect(await orkas.invoke('orkasApi.configureAll', { apiKey: 'orkas-e2e-deepseek-public-row-xxxxxxxx' }))
        .toMatchObject({ ok: true, configured: true });
      const page = orkas.page;
      await page.evaluate(language => (window as any).setLang(language), language);
      await open(page);
      await expect(page.locator('[data-settings-add="search"]')).toHaveText(language === 'en' ? 'Add search service' : '添加搜索服务');
      await page.locator('[data-settings-add="search"]').click();
      const trigger = page.locator('#settings-search-provider .ai-select-trigger');
      await trigger.click();
      await page.locator('.ai-select-popover:visible .ai-select-item', { hasText: 'DeepSeek' }).click();
      await expect(page.locator('#settings-search-key-input')).toBeVisible();
      await expect(page.locator('#settings-search-key-input')).toHaveAttribute('type', 'password');
      await page.screenshot({ path: testInfo.outputPath('provider-selected.png') });
      await page.locator('#settings-search-key-input').fill('synthetic-deepseek-e2e-key');
      await page.locator('#settings-search-add-btn').click();
      const row = page.locator('#settings-search-entries .entry-row', { hasText: 'DeepSeek' });
      await expect(row).toBeVisible();
      await expect(row).not.toContainText('synthetic-deepseek-e2e-key');
      await expect(row).toHaveClass(/is-default/);
      const id = await row.getAttribute('data-profile-id');
      expect(id).toBeTruthy();
      await expectLocalOnly();
      const reopened = await orkas.relaunch();
      await installNetworkGuard();
      await open(reopened);
      await expect(reopened.locator('[data-settings-add="search"]')).toHaveText(language === 'en' ? 'Add search service' : '添加搜索服务');
      await expect(reopened.locator(`#settings-search-entries [data-profile-id="${id}"]`)).toContainText('DeepSeek');
      await reopened.setViewportSize({ width: 1024, height: 720 });
      await reopened.screenshot({ path: testInfo.outputPath('configured-narrow.png') });
      await reopened.locator(`#settings-search-entries [data-profile-id="${id}"] .entry-actions .btn-danger`).click();
      await reopened.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
      await expect(reopened.locator(`#settings-search-entries [data-profile-id="${id}"]`)).toHaveCount(0);
      await expect(reopened.locator('#settings-search-entries .entry-row', { hasText: 'Orkas · Search' })).toHaveCount(1);
      const listed = await orkas.invoke<{ profiles: Array<{ provider: string; apiKey?: string }> }>('searchAuth.list');
      expect(listed.profiles.map(profile => profile.provider)).toEqual(['orkas-api']);
      expect(listed.profiles[0]).not.toHaveProperty('apiKey');
      await expectLocalOnly();
    });
  });
}
