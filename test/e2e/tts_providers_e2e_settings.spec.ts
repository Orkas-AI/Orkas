import { expect, test } from './fixtures/orkas';

test('configures six TTS providers with native model choices and preserves them on relaunch', async ({ modelOrkas: orkas }, testInfo) => {
  let page = orkas.page!;
  const installNetworkGuard = () => orkas.guardExternalFetches();
  await installNetworkGuard();
  const openSettings = async () => {
    await page.locator('#settings-btn').click();
    await page.locator('[data-settings-tab="credentials"]').click();
    await page.locator('[data-settings-model-tab="tts"]').click();
  };
  expect(await orkas.invoke('orkasApi.configureAll', { apiKey: 'orkas-e2e-tts-public-row-xxxxxxxx' })).toMatchObject({ ok: true, configured: true });
  await openSettings();
  for (const [provider, model, voice] of [
    ['DouBao', '', 'zh_female_vv_uranus_bigtts'], ['MiniMax', 'MiniMax Speech 2.8 Turbo', 'male-qn-qingse'],
    ['Alibaba Cloud', 'Alibaba CosyVoice 3.5 Plus', 'enrolled-voice'],
    ['Google', 'Google Gemini 3.8 Flash-Lite TTS', 'Kore'], ['ElevenLabs', 'ElevenLabs Eleven v4 Turbo', 'enrolled-voice'],
    ['OpenAI', 'OpenAI GPT-4o mini TTS', 'alloy'],
  ]) {
    await page.locator('[data-settings-add="tts"]').click();
    await page.locator('#settings-tts-provider .ai-select-trigger').click();
    await page.locator(`.ai-select-popover:visible .ai-select-item[data-value="${({ DouBao: 'doubao', MiniMax: 'minimax', 'Alibaba Cloud': 'aliyun', Google: 'google', ElevenLabs: 'elevenlabs', OpenAI: 'openai' } as Record<string, string>)[provider]}"]`).click();
    await page.locator('#settings-tts-key-input').fill('e2e-private-tts-key');
    if (model) {
      await page.locator('#settings-tts-model-select .ai-select-trigger').click();
      await page.locator('.ai-select-popover:visible .ai-select-item').filter({ hasText: model }).click();
    }
    await page.locator('#settings-tts-voice-input').fill(voice);
    if (provider === 'Alibaba Cloud') {
      await page.locator('#settings-tts-workspace-input').fill('workspace-123');
      await page.setViewportSize({ width: 820, height: 660 });
      await page.screenshot({ path: testInfo.outputPath('tts-settings-en-narrow.png') });
      const button = await page.locator('#settings-tts-add-btn').boundingBox();
      expect(button && button.y + button.height <= 660).toBeTruthy();
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await page.locator('#settings-tts-add-btn').click();
    await expect(page.locator('#settings-add-modal')).not.toHaveClass(/\bopen\b/);
  }
  const before = await orkas.invoke<any>('ttsAuth.list');
  expect(before.profiles.filter((p: any) => p.provider !== 'orkas-api')).toHaveLength(6);
  expect(before.profiles.find((p: any) => p.provider === 'orkas-api')).toBeTruthy();
  expect(before.profiles.find((p: any) => p.provider === 'aliyun').workspaceId).toBe('workspace-123');
  expect(JSON.stringify(before)).not.toContain('e2e-private-tts-key');
  expect(await orkas.externalFetchAttempts()).toBe(0);
  page = await orkas.relaunch(); await installNetworkGuard(); await openSettings();
  await expect(page.locator('#settings-tts-entries .entry-row')).toHaveCount(7);
  const after = await orkas.invoke<any>('ttsAuth.list');
  expect(after.profiles).toEqual(before.profiles);
  for (const profile of after.profiles.filter((item: any) => item.provider !== 'orkas-api')) {
    await expect(page.locator(`#settings-tts-entries [data-profile-id="${profile.id}"] .entry-primary`))
      .not.toContainText(profile.voice);
  }
  await page.setViewportSize({ width: 820, height: 660 });
  const rowWidths = await page.locator('#settings-tts-entries .entry-row').evaluateAll(rows =>
    rows.map(row => ({ client: row.clientWidth, scroll: row.scrollWidth })));
  expect(rowWidths.every(row => row.scroll <= row.client)).toBe(true);
  await page.locator('#settings-tts-entries').screenshot({ path: testInfo.outputPath('saved-voices-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.locator('[data-settings-add="tts"]').click();
  await page.locator('#settings-tts-provider .ai-select-trigger').click();
  await page.locator('.ai-select-popover:visible .ai-select-item').filter({ hasText: 'Alibaba Cloud' }).click();
  await page.screenshot({ path: testInfo.outputPath('tts-settings-en.png') });
  await page.locator('#settings-tts-model-select .ai-select-trigger').click();
  await expect(page.locator('.ai-select-popover:visible')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ai-select-popover:visible')).toHaveCount(0);
  await expect(page.locator('#settings-add-modal')).toHaveClass(/\bopen\b/);
  await page.evaluate(() => (window as any).setLang('zh'));
  await expect(page.locator('#settings-tts-workspace-row label')).toHaveText('Workspace ID');
  await expect(page.locator('#settings-tts-add-btn')).toHaveText('+ 添加语音合成 Key');
  await page.screenshot({ path: testInfo.outputPath('tts-settings-zh.png') });
  expect(orkas.modelRequests).toHaveLength(0);
  expect(orkas.apiRequests).toEqual([]);
  expect(await orkas.externalFetchAttempts()).toBe(0);
});
