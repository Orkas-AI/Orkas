import { generateKeyPairSync } from 'node:crypto';
import { expect, test } from './fixtures/orkas';


for (const locale of ['en', 'zh'] as const) {
  test.describe(`video service configuration ${locale}`, () => {
    test('saves current Wan and Google Cloud tiers and reopens masked profiles', async ({ orkas }, testInfo) => {
      if (!orkas.page) throw new Error('Renderer unavailable');
      let page = orkas.page;
      await page.setViewportSize(locale === 'zh' ? { width: 960, height: 700 } : { width: 1280, height: 900 });
      if (locale === 'zh') {
        await page.locator('#settings-btn').click();
        await page.locator('[data-settings-tab="general"]').click();
        await page.locator('#settings-language-select .ai-select-trigger').click();
        await page.locator('.ai-select-popover:visible .ai-select-item[data-value="zh"]').click();
        await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
      }
      const openCredentials = async () => {
        await page.locator('#settings-btn').click();
        await page.locator('[data-settings-tab="credentials"]').click();
        await page.locator('[data-settings-model-tab="video"]').click();
      };
      const choose = async (label: string) => {
        await page.locator('[data-settings-add="video"]').click();
        await page.locator('#settings-video-provider .ai-select-trigger').click();
        const menu = page.locator('.ai-select-popover:visible');
        await expect(menu.locator('.ai-select-item[data-value="doubao:doubao-seedance-2-5-flash"] .ai-select-item-label'))
          .toHaveText('Doubao Seedance 2.5 Flash');
        await expect(menu).toContainText('Google Gemini Omni 1.1 Flash');
        await expect(menu).toContainText('MiniMax H3 Highspeed');
        await page.screenshot({ path: testInfo.outputPath(`video-model-names-${locale}.png`) });
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(page.locator('#settings-add-modal')).toHaveClass(/open/);
        await page.locator('#settings-video-provider .ai-select-trigger').click();
        await page.locator('.ai-select-popover:visible .ai-select-item').filter({ hasText: label }).click();
      };
      await openCredentials();
      await choose('Alibaba Cloud Wan 3.0 Prime');
      await expect(page.locator('#settings-video-workspace-input')).toBeVisible();
      await page.locator('#settings-video-workspace-input').fill('workspace123');
      await page.locator('#settings-video-key-input').fill('synthetic-wan-credential');
      await page.locator('#settings-video-region .ai-select-trigger').click();
      await page.locator('.ai-select-popover:visible .ai-select-item').filter({ hasText: 'ap-southeast-1' }).click();
      await page.screenshot({ path: testInfo.outputPath(`wan-${locale}.png`) });
      await page.locator('#settings-video-add-btn').click();
      await expect(page.locator('#settings-video-entries')).toContainText('Wan 3.0 Prime');
      await expect(page.locator('#settings-video-entries')).not.toContainText('synthetic-wan-credential');

      await choose('Google Cloud Veo 3.1 Fast');
      await expect(page.locator('#settings-video-key-label')).toHaveText(locale === 'zh' ? '服务账号 JSON' : 'Service account JSON');
      await expect(page.locator('#settings-video-workspace-row')).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath(`cloud-${locale}.png`) });
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const credentials = JSON.stringify({ type: 'service_account', project_id: 'video-project', client_email: 'video@video-project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
      await page.locator('#settings-video-key-input').fill(credentials);
      await page.locator('#settings-video-add-btn').click();
      await expect(page.locator('#settings-video-entries')).toContainText('Veo 3.1 Fast');
      await expect(page.locator('#settings-video-entries')).not.toContainText('PRIVATE KEY');
      await choose('MiniMax H3 Highspeed');
      await expect(page.locator('#settings-video-workspace-row')).toBeHidden();
      await page.locator('#settings-video-key-input').fill('synthetic-domestic-credential');
      await page.locator('#settings-video-add-btn').click();
      await expect(page.locator('#settings-video-entries')).toContainText('MiniMax H3 Highspeed');
      await expect(page.locator('#settings-video-entries')).not.toContainText('synthetic-domestic-credential');
      page = await orkas.relaunch();
      await openCredentials();
      await expect(page.locator('#settings-video-entries')).toContainText('Wan 3.0 Prime');
      await expect(page.locator('#settings-video-entries')).toContainText('Veo 3.1 Fast');
      await expect(page.locator('#settings-video-entries')).toContainText('MiniMax H3 Highspeed');
    });
  });
}
