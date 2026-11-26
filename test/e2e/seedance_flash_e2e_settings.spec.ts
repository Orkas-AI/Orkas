import path from 'node:path';
import { expect, test } from './fixtures/orkas';

// Real settings/IPC/persistence; synthetic credentials never call a paid provider.

for (const language of ['en', 'zh'] as const) {
  test(`configures Flash and Wan, recovers Cloud input and retains selections after restart (${language})`, async ({ orkas }, info) => {
    const open = async (page: import('@playwright/test').Page) => {
      await page.locator('#settings-btn').click();
      await page.locator('.settings-tab[data-settings-tab="credentials"]').click();
      await page.locator('[data-settings-model-tab="video"]').click();
    };
    if (!orkas.page) throw new Error('Renderer unavailable');
    const page = orkas.page;
    const retiredId = 'video-retired-fixture';
    await orkas.electronApp!.evaluate(async (_electron, input) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const auth = require(input.auth);
      auth.saveVideoProfiles([{ id: input.id, provider: 'google', model: 'veo-3.1-generate-preview',
        apiKey: 'synthetic-retired-video-key', label: 'Retired video', createdAt: 1 }, ...auth.loadVideoProfiles()]);
    }, { auth: path.resolve(__dirname, '../../src/main/features/auth.ts'), id: retiredId });

    await page.evaluate(lang => (window as any).setLang(lang), language);
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    await page.locator('[data-settings-add="video"]').click();
    await page.locator('#settings-video-provider .ai-select-trigger').click();
    const option = page.locator('.ai-select-popover:visible .ai-select-item', { hasText: 'Seedance 2.5 Flash' });
    await expect(option).toBeVisible();
    await page.screenshot({ path: info.outputPath('flash-picker.png') });
    await option.click();
    await expect(page.locator('#settings-video-key-input')).toHaveAttribute('type', 'password');
    await page.locator('#settings-video-key-input').fill('synthetic-flash-e2e-key');
    await page.locator('#settings-video-add-btn').click();
    const row = page.locator('#settings-video-entries .entry-row', { hasText: 'Seedance 2.5 Flash' });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('synthetic-flash-e2e-key');
    const id = await row.getAttribute('data-profile-id');
    expect(id).toBeTruthy();
    await page.locator('[data-settings-add="video"]').click();
    await page.locator('#settings-video-provider .ai-select-trigger').click();
    await page.locator('.ai-select-popover:visible .ai-select-item[data-value="google-cloud:veo-3.1-fast-generate-001"]').click();
    await expect(page.locator('#settings-video-key-label')).not.toHaveText('API Key');
    await page.locator('#settings-video-key-input').fill('invalid-json');
    await page.locator('#settings-video-add-btn').click();
    await expect(page.locator('#settings-video-key-input')).toHaveValue('invalid-json');
    await expect(page.locator('#settings-video-status')).toHaveClass(/error/);
    await page.locator('#settings-video-provider .ai-select-trigger').click();
    await page.locator('.ai-select-popover:visible .ai-select-item[data-value="aliyun:wan3.0-video-prime"]').click();
    await expect(page.locator('#settings-video-workspace-row')).toBeVisible();
    await page.locator('#settings-video-key-input').fill('synthetic-wan-e2e-key');
    await page.locator('#settings-video-workspace-input').fill('workspace123');
    await page.locator('#settings-video-region .ai-select-trigger').click();
    await page.locator('.ai-select-popover:visible .ai-select-item[data-value="ap-southeast-1"]').click();
    await page.setViewportSize({ width: 820, height: 660 });
    await expect(page.locator('#settings-video-add-btn')).toBeInViewport();
    await page.screenshot({ path: info.outputPath('wan-fields-narrow.png') });
    await page.locator('#settings-video-add-btn').click();
    await expect(page.locator('#settings-video-entries .entry-row', { hasText: 'Wan 3.0 Prime' })).toBeVisible();
    await expect(page.locator('#settings-video-entries')).not.toContainText('synthetic-wan-e2e-key');
    const profiles = await orkas.invoke<{ profiles: Array<{ id: string; model: string }> }>('videoAuth.list');
    expect(profiles.profiles.find(profile => profile.id === id)?.model).toBe('doubao-seedance-2-5-flash');
    const reopened = await orkas.relaunch();
    await open(reopened);
    await reopened.setViewportSize({ width: 1024, height: 720 });
    await expect(reopened.locator(`#settings-video-entries [data-profile-id="${id}"]`)).toContainText('Seedance 2.5 Flash');
    await expect(reopened.locator('#settings-video-entries .entry-row', { hasText: 'Wan 3.0 Prime' })).toBeVisible();
    const after = await orkas.invoke<{ profiles: Array<{id:string;model:string}> }>('videoAuth.list');
    expect(after.profiles).toEqual(profiles.profiles);
    const retired = reopened.locator(`#settings-video-entries [data-profile-id="${retiredId}"]`);
    await expect(retired).toBeVisible();
    await expect(retired.locator('.entry-rank')).toHaveText(language === 'en' ? 'Unavailable' : '暂不可用');
    await expect(retired).not.toHaveClass(/is-default/);
    await expect(retired).toHaveJSProperty('draggable', false);
    await expect(reopened.locator('#settings-video-entries .entry-row').last()).toHaveAttribute('data-profile-id', retiredId);
    await retired.locator('.entry-actions button').click();
    await reopened.getByRole('dialog').locator('[data-act="ok"]').click();
    await expect(retired).toHaveCount(0);
    const remaining = await orkas.invoke<{ profiles: Array<{ id: string }> }>('videoAuth.list');
    expect(remaining.profiles.some(profile => profile.id === retiredId)).toBe(false);

    await reopened.screenshot({ path: info.outputPath('flash-configured-narrow.png') });
  });
}
