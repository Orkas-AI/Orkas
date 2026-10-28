import { expect, test } from './fixtures/orkas';

declare const _settingsState: {
  orkasApiCredential: { configured: boolean; keyMasked: string };
};
declare function _settingsRenderOrkasApiCard(): void;

async function openSettingsTab(page: import('@playwright/test').Page, tabName: string): Promise<void> {
  await page.locator('#settings-btn').click();
  const tab = page.locator(`.settings-tab[data-settings-tab="${tabName}"]`);
  await tab.click();
  await expect(tab).toHaveClass(/\bis-active\b/);
  await expect(page.locator(`[data-settings-pane="${tabName}"]`)).toBeVisible();
}

// Since the settings redesign the provider / model pickers live in the
// "+ 添加模型" dialog (#settings-add-modal) instead of inline on the Models tab.
async function openAddModelDialog(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-settings-add="chat"]').click();
  await expect(page.locator('#settings-add-modal')).toHaveClass(/\bopen\b/);
  await expect(page.locator('#settings-add-modal [data-settings-add-form="chat"]')).toBeVisible();
}

test.describe('settings modules and model guard', () => {
  test('shows public image and video model details across languages and widths', async ({ orkas }, testInfo) => {
    const page = orkas.page!;
    expect(await orkas.invoke('orkasApi.configureAll', { apiKey: 'orkas-e2e-service-details-xxxxxxxx' }))
      .toMatchObject({ ok: true, configured: true });
    await openSettingsTab(page, 'credentials');
    for (const [language, width] of [['en', 1280], ['zh', 620]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async language => { await (window as any).setLang(language); }, language);
      for (const [kind, label, model] of [
        ['image', 'Orkas · Image', 'Seedream 5.0 Flash'],
        ['video', 'Orkas · Video', 'Seedance 2.0/2.5'],
      ] as const) {
        await page.locator(`[data-settings-model-tab="${kind}"]`).click();
        const row = page.locator(`#settings-${kind}-entries .entry-row`).filter({
          has: page.locator('.entry-provider', { hasText: label }),
        });
        await expect(row).toHaveCount(1);
        const detail = row.locator('.entry-media-model');
        await expect(detail).toHaveText(model);
        expect(await detail.evaluate(element => {
          const box = element.getBoundingClientRect();
          const row = element.closest('.entry-row')!;
          const bounds = row.getBoundingClientRect();
          const title = row.querySelector('.entry-primary')!.getBoundingClientRect();
          return box.top >= title.bottom && box.left >= bounds.left && box.right <= bounds.right
            && element.scrollWidth <= element.clientWidth + 1;
        })).toBe(true);
        await row.screenshot({ path: testInfo.outputPath(`${kind}-${language}-${width}.png`) });
      }
      for (const kind of ['search', 'tts']) {
        await page.locator(`[data-settings-model-tab="${kind}"]`).click();
        await expect(page.locator(`#settings-${kind}-entries .entry-media-model`)).toHaveCount(0);
      }
    }
    expect(orkas.modelRequests).toHaveLength(0);
  });

  test('keeps model savings readable beside the API-key title across languages and widths', async ({ appPage }, testInfo) => {
    await openSettingsTab(appPage, 'credentials');
    const card = appPage.locator('#settings-orkas-api-group');
    const saving = card.locator('[data-i18n="price_comparison.maximum"]');
    await expect(saving).toHaveText('Model costs up to 50% less than provider API pricing');
    await expect(card.locator('#settings-orkas-api-key-input')).toBeVisible();
    // A masked presentation fixture never saves or transmits a credential.
    await appPage.evaluate(() => {
      _settingsState.orkasApiCredential = { configured: true, keyMasked: 'sk-demo…1234' };
      _settingsRenderOrkasApiCard();
    });
    for (const [language, width] of [['en', 1280], ['zh', 1280], ['zh', 620], ['de', 620], ['ar', 620]] as const) {
      await appPage.setViewportSize({ width, height: 900 });
      await appPage.evaluate(async language => { await (window as any).setLang(language); }, language);
      await expect(saving).toBeVisible();
      if (language === 'zh') {
        await expect(saving).toHaveText('模型费用较厂商 API 最高省 50%');
        await expect(card.locator('[data-i18n="settings.orkas_api.sub"]'))
          .toHaveText('统一用于 Orkas 模型、搜索、图片、语音、视频和需要积分的连接器。密钥仅加密保存在本机。');
      }
      const geometry = await saving.evaluate(element => {
        const box = element.getBoundingClientRect();
        const card = element.closest('#settings-orkas-api-group')!;
        const bounds = card.getBoundingClientRect();
        return {
          containsLabel: box.left >= bounds.left && box.right <= bounds.right,
          noClip: element.scrollWidth <= element.clientWidth + 1,
          noCardOverflow: card.scrollWidth <= card.clientWidth + 1,
        };
      });
      expect(geometry).toEqual({ containsLabel: true, noClip: true, noCardOverflow: true });
      if (width === 620) {
        const copy = (await card.locator('.settings-group-head-main').boundingBox())!;
        const create = (await card.locator('#settings-orkas-api-create-key').boundingBox())!;
        expect(create.y).toBeGreaterThanOrEqual(copy.y + copy.height);
      }
      await expect(card.locator('#settings-orkas-api-key-masked')).toHaveText('sk-demo…1234');
      await expect(card.locator('#settings-orkas-api-edit')).toBeVisible();
      await expect(card.locator('#settings-orkas-api-delete')).toBeVisible();
      await card.screenshot({ path: testInfo.outputPath(`api-key-${language}-${width}.png`) });
    }
    await card.locator('#settings-orkas-api-edit').click();
    await expect(card.locator('#settings-orkas-api-key-input')).toBeVisible();
    await expect(card.locator('#settings-orkas-api-key-input')).toHaveValue('');
    await card.locator('#settings-orkas-api-cancel').click();
    await expect(card.locator('#settings-orkas-api-key-input')).toBeHidden();
  });

  test('Escape closes the model picker before the dialog and returns focus to Add', async ({ appPage }) => {
    await openSettingsTab(appPage, 'credentials');
    await openAddModelDialog(appPage);
    const trigger = appPage.locator('#settings-picker-provider .ai-select-trigger');
    await trigger.click();
    await expect(appPage.locator('.ai-select-popover:visible')).toBeVisible();
    await appPage.keyboard.press('Escape');
    await expect(appPage.locator('.ai-select-popover:visible')).toHaveCount(0);
    await expect(appPage.locator('#settings-add-modal')).toHaveClass(/\bopen\b/);
    await appPage.keyboard.press('Escape');
    await expect(appPage.locator('#settings-add-modal')).not.toHaveClass(/\bopen\b/);
    await expect(appPage.locator('[data-settings-add="chat"]')).toBeFocused();
  });

  test('renders data, recycle bin, and BYO credential settings', async ({ appPage }, testInfo) => {
    await openSettingsTab(appPage, 'data');
    await expect(appPage.locator('#settings-data-root-btn')).toBeVisible();
    await expect(appPage.locator('#settings-recycle-group')).toBeVisible();
    await expect(appPage.locator('#settings-recycle-body')).toBeVisible();
    const recycleViewport = appPage.locator('#settings-recycle-body .settings-recycle-scroll');
    await expect(recycleViewport).toBeVisible();
    await expect(recycleViewport).toHaveAttribute('data-recycle-source', 'local');
    await expect(appPage.locator('#settings-recycle-body [data-recycle-tab]')).toHaveCount(0);
    const recycleLayout = await recycleViewport.evaluate((element) => {
      const style = getComputedStyle(element);
      return { overflowY: style.overflowY, maxHeight: Number.parseFloat(style.maxHeight) };
    });
    expect(recycleLayout.overflowY).toBe('auto');
    expect(recycleLayout.maxHeight).toBeGreaterThan(0);
    expect(recycleLayout.maxHeight).toBeLessThanOrEqual(320);
    const clear = appPage.locator('#settings-recycle-body [data-recycle-clear]');
    for (const [language, width] of [['en', 1280], ['zh', 620]] as const) {
      await appPage.setViewportSize({ width, height: 900 });
      await appPage.evaluate(async language => { await (window as any).setLang(language); }, language);
      await expect(clear).toBeVisible();
      await expect(clear).toBeDisabled();
      expect(await clear.evaluate(element => {
        const button = element.getBoundingClientRect();
        const toolbar = element.closest('.settings-recycle-toolbar')!.getBoundingClientRect();
        return Math.abs(toolbar.right - button.right) <= 1 && button.left >= toolbar.left;
      })).toBe(true);
      await appPage.locator('#settings-recycle-group').screenshot({ path: testInfo.outputPath(`recycle-clear-${language}-${width}.png`) });
    }
    await appPage.setViewportSize({ width: 1280, height: 900 });
    await appPage.evaluate(async () => { await (window as any).setLang('en'); });

    await openSettingsTab(appPage, 'credentials');
    await expect(appPage.locator('[data-settings-add="chat"]')).toBeVisible();
    await expect(appPage.locator('#settings-entries .entry-row', {
      hasText: 'E2E-Local-Model',
    })).toBeVisible();
    await expect(appPage.locator('#settings-entries .settings-empty')).toHaveCount(0);
    const sort = appPage.locator('#settings-entries .entry-row').first().locator('.entry-sort');
    await expect(sort).toHaveCSS('display', 'flex');
    await expect(sort).toHaveCSS('flex-direction', 'column');
    await expect(sort.locator('button').first()).toHaveCSS('border-top-width', '0px');
    await appPage.screenshot({ path: testInfo.outputPath('settings-model-sort-actions.png') });
    await openAddModelDialog(appPage);
    await expect(appPage.locator('#settings-add-entry-btn')).toBeVisible();
    await appPage.locator('#settings-add-entry-btn').click();
    await expect(appPage.locator('#settings-picker-status')).not.toHaveText('');
    await expect(appPage.locator('#settings-add-modal')).toHaveClass(/\bopen\b/);
    await appPage.locator('#settings-add-modal [data-settings-add-cancel]:visible').click();
    await expect(appPage.locator('#settings-add-modal')).not.toHaveClass(/\bopen\b/);
  });

  test('persists a masked model credential entry and removes it from the UI', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    await openSettingsTab(orkas.page, 'credentials');
    await openAddModelDialog(orkas.page);
    await orkas.page.locator('#settings-picker-provider .ai-select-trigger').click();
    let popover = orkas.page.locator('.ai-select-popover:visible');
    await popover.locator('.ai-select-item', { hasText: 'Anthropic' }).click();
    await orkas.page.locator('#settings-picker-model .ai-select-trigger').click();
    popover = orkas.page.locator('.ai-select-popover:visible');
    await expect(popover.locator('.ai-select-item').first()).toBeVisible();
    await popover.locator('.ai-select-item').first().click();
    await orkas.page.locator('#settings-add-entry-btn').click();
    // The picker dialog hands over to the credential dialog; they never stack.
    await expect(orkas.page.locator('#settings-add-modal')).not.toHaveClass(/\bopen\b/);
    await orkas.page.locator('#add-account-modal .method-tile[data-method="api_key"]').click();
    await expect(orkas.page.locator('#add-account-modal .api-key-input')).toHaveAttribute('type', 'password');
    await orkas.page.locator('#add-account-modal .api-label-input').fill('E2E Model Account');
    await orkas.page.locator('#add-account-modal .api-key-input').fill('sk-e2e-placeholder-xxxxxxxx');
    await orkas.page.locator('#add-account-actions .btn-primary').click();

    let row = orkas.page.locator('#settings-entries .entry-row', { hasText: 'E2E-Model-Account' });
    await expect(row).toContainText('Anthropic');
    await expect(row).toContainText('E2E-Model-Account');
    await expect(row).not.toContainText('sk-e2e-placeholder-xxxxxxxx');
    const entryId = await row.getAttribute('data-entry-id');
    expect(entryId).toBeTruthy();

    const relaunchedPage = await orkas.relaunch();
    await openSettingsTab(relaunchedPage, 'credentials');
    row = relaunchedPage.locator(`.entry-row[data-entry-id="${entryId}"]`);
    await expect(row).toBeVisible();
    await row.locator('.entry-actions .danger').click();
    await expect(relaunchedPage.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(row).toHaveCount(0);
    await expect(relaunchedPage.locator('#settings-entries .entry-row', {
      hasText: 'E2E-Local-Model',
    })).toBeVisible();
  });

  for (const protocol of ['openai', 'responses', 'anthropic'] as const) {
    test(`configures a custom ${protocol} model without revealing its endpoint or key`, async ({ orkas }) => {
      if (!orkas.page) throw new Error('Orkas renderer is unavailable');
      const beforeSave = await orkas.invoke<{
        entries: Array<{ entryId: string; provider: string }>;
      }>('auth.listEntries', { includeUnavailable: true });
      const beforeCustomIds = beforeSave.entries
        .filter((entry) => entry.provider === 'custom')
        .map((entry) => entry.entryId)
        .sort();
      await openSettingsTab(orkas.page, 'credentials');
      await openAddModelDialog(orkas.page);
      await orkas.page.locator('#settings-picker-provider .ai-select-trigger').click();
      const popover = orkas.page.locator('.ai-select-popover:visible');
      await popover.locator('.ai-select-item', { hasText: 'Custom' }).click();
      await expect(orkas.page.locator('#settings-picker-model-row')).toBeHidden();
      await orkas.page.locator('#settings-add-entry-btn').click();

      const modal = orkas.page.locator('#add-account-modal');
      await expect(modal).toHaveClass(/\bopen\b/);
      await expect(orkas.page.locator('#settings-add-modal')).not.toHaveClass(/\bopen\b/);
      await expect(modal.locator('.custom-key-input')).toHaveAttribute('type', 'password');
      const protocolPicker = modal.locator('.custom-protocol-input');
      const protocolTrigger = protocolPicker.getByRole('combobox', { name: 'Protocol', exact: true });
      await expect(protocolPicker).toHaveAttribute('data-value', 'openai');
      await expect(protocolTrigger).toHaveText('OpenAI-compatible');
      await protocolTrigger.click();
      const protocolMenu = orkas.page.locator('.ai-select-popover:visible');
      await expect(protocolMenu.getByRole('option', { name: 'Anthropic-compatible', exact: true })).toBeVisible();
      await test.info().attach('custom-protocol-menu', {
        body: await modal.screenshot(), contentType: 'image/png',
      });
      await orkas.page.keyboard.press('Escape');
      await expect(protocolMenu).toHaveCount(0);
      await expect(modal).toHaveClass(/\bopen\b/);
      await protocolTrigger.click();
      if (protocol !== 'openai') {
        const option = protocolMenu.getByRole('option', { name: protocol === 'responses' ? 'OpenAI Responses' : 'Anthropic-compatible', exact: true });
        const optionId = await option.getAttribute('id');
        for (let index = 0; index < await protocolMenu.getByRole('option').count(); index += 1) {
          if (await protocolTrigger.getAttribute('aria-activedescendant') === optionId) break;
          await orkas.page.keyboard.press('ArrowDown');
        }
        await expect(protocolTrigger).toHaveAttribute('aria-activedescendant', optionId!);
      }
      await orkas.page.keyboard.press('Enter');
      await expect(protocolMenu).toHaveCount(0);
      await expect(protocolPicker).toHaveAttribute('data-value', protocol);
      await expect(protocolTrigger).toHaveText(protocol === 'anthropic'
        ? 'Anthropic-compatible' : protocol === 'responses' ? 'OpenAI Responses' : 'OpenAI-compatible');
      await orkas.page.keyboard.press('Tab');
      await expect(modal.locator('.custom-base-url-input')).toBeFocused();
      await expect(modal.locator('.custom-base-url-input')).toHaveAttribute('placeholder',
        protocol === 'anthropic' ? 'https://api.example.com' : 'https://api.example.com/v1');
      await modal.locator('.custom-label-input').fill('E2E Private Gateway');
      await modal.locator('.custom-base-url-input').fill(
        'https://embedded:credential@gateway.example.invalid/v1',
      );
      await modal.locator('.custom-model-input').fill('acme/private-reasoner');
      await modal.locator('.custom-key-input').fill('sk-custom-e2e-secret-xxxxxxxx');
      await orkas.page.locator('#add-account-actions .btn-primary').click();
      await expect(modal.locator('.form-msg')).toHaveClass(/\berror\b/);
      await expect(modal.locator('.form-msg')).not.toBeEmpty();
      await expect(modal).toHaveClass(/\bopen\b/);
      const afterRejectedSave = await orkas.invoke<{
        entries: Array<{ entryId: string; provider: string }>;
      }>('auth.listEntries', { includeUnavailable: true });
      expect(afterRejectedSave.entries
        .filter((entry) => entry.provider === 'custom')
        .map((entry) => entry.entryId)
        .sort()).toEqual(beforeCustomIds);

      await modal.locator('.custom-base-url-input').fill(
        protocol === 'anthropic' ? 'https://gateway.example.invalid/proxy/v1/v1/messages'
          : protocol === 'responses' ? 'https://gateway.example.invalid/v1/responses'
          : 'https://gateway.example.invalid/v1/chat/completions',
      );
      await orkas.page.locator('#add-account-actions .btn-primary').click();

      let row = orkas.page.locator('#settings-entries .entry-row', {
        hasText: 'acme/private-reasoner',
      });
      await expect(row).toContainText('Custom');
      await expect(row).toContainText('E2E-Private-Gateway');
      await expect(row).not.toContainText('sk-custom-e2e-secret-xxxxxxxx');
      await expect(row).not.toContainText('gateway.example.invalid');
      const entryId = await row.getAttribute('data-entry-id');
      expect(entryId).toBeTruthy();

      const listed = await orkas.invoke<{
        entries: Array<Record<string, unknown>>;
      }>('auth.listEntries', { includeUnavailable: true });
      const customEntry = listed.entries.find((entry) => entry.entryId === entryId);
      expect(customEntry).toMatchObject({
        provider: 'custom',
        model: 'acme/private-reasoner',
        profileLabel: 'E2E-Private-Gateway',
      });
      expect(customEntry).not.toHaveProperty('apiKey');
      expect(customEntry).not.toHaveProperty('baseUrl');

      const relaunchedPage = await orkas.relaunch();
      await openSettingsTab(relaunchedPage, 'credentials');
      row = relaunchedPage.locator(`.entry-row[data-entry-id="${entryId}"]`);
      await expect(row).toContainText('acme/private-reasoner');
      const storedRuntime = await orkas.electronApp!.evaluate(async () => {
        const auth = (process as any).mainModule.require(process.cwd() + '/src/main/features/auth.ts');
        const choices = await auth.pickChatEntryGroup();
        const choice = choices.find((value: { model: string }) => value.model === 'acme/private-reasoner');
        return { protocol: choice?.customConfig?.protocol, baseUrl: choice?.customConfig?.baseUrl };
      });
      expect(storedRuntime).toEqual({ protocol, baseUrl: protocol === 'anthropic'
        ? 'https://gateway.example.invalid/proxy/v1' : 'https://gateway.example.invalid/v1' });

      await expect(row).not.toContainText('gateway.example.invalid');
      await row.locator('.entry-actions .danger').click();
      await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
      await expect(row).toHaveCount(0);
    });

  }

  test('keeps an empty model state quiet until an LLM action needs configuration', async ({ appPage, orkas }) => {
    const listed = await orkas.invoke<{
      entries: Array<{ entryId: string }>;
    }>('auth.listEntries');
    for (const entry of listed.entries) {
      const removed = await orkas.invoke<{ ok: boolean; removed: boolean }>('auth.removeEntry', {
        entryId: entry.entryId,
      });
      expect(removed).toMatchObject({ ok: true, removed: true });
    }

    const silentResult = await appPage.evaluate(async () => {
      await (window as any).refreshModelGuard();
      return (window as any).ensureModelConfigured({ silent: true });
    });
    expect(silentResult).toBe(false);
    await expect(appPage.locator('#model-guard-banner')).toHaveCount(0);
    await expect(appPage.locator('#panel-new-chat')).toHaveClass(/\bactive\b/);

    await appPage.locator('#new-chat-input').fill('This request needs a configured model.');
    await appPage.locator('#new-chat-send-btn').click();

    await expect(appPage.locator('#panel-settings')).toHaveClass(/\bactive\b/);
    await expect(appPage.locator('.settings-tab[data-settings-tab="credentials"]')).toHaveClass(/\bis-active\b/);
    await expect(appPage.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await expect(appPage.locator('#conversation-list .conv-item')).toHaveCount(0);
  });

});

// Settings saves must remain local: a mistaken test/production dispatch cannot
// reach a real provider with even these synthetic keys.
async function denyExternalProviderRequests(app: import('./fixtures/orkas').OrkasTestApp): Promise<void> {
  await app.electronApp!.evaluate(() => {
    const state = globalThis as typeof globalThis & { __settingsExternalRequestCount?: number };
    state.__settingsExternalRequestCount = 0;
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        state.__settingsExternalRequestCount! += 1;
        return Promise.reject(new Error('E_E2E_UNEXPECTED_EXTERNAL_REQUEST'));
      }
      return original(input, init);
    }) as typeof fetch;
  });
}

async function expectSettingsOnly(app: import('./fixtures/orkas').OrkasTestApp): Promise<void> {
  expect(await app.electronApp!.evaluate(() => (globalThis as any).__settingsExternalRequestCount)).toBe(0);
  expect(app.modelRequests).toHaveLength(0);
  expect(app.imageGenerationRequests).toHaveLength(0);
  expect(app.videoGenerationRequests).toHaveLength(0);
}

type MediaModelChoice = readonly [option: string, provider: string, model: string];
const PUBLIC_MEDIA_CHOICES: Record<'image' | 'video', readonly MediaModelChoice[]> = {
  image: [
    ['openai:gpt-image-2', 'openai', 'gpt-image-2'],
    ['openai:gpt-image-2.5-flare', 'openai', 'gpt-image-2.5-flare'],
    ['openai:gpt-image-2.5-sunburst', 'openai', 'gpt-image-2.5-sunburst'],
    ['google:gemini-nano-banana-2.1', 'google', 'gemini-nano-banana-2.1'],
    ['google:gemini-3.1-flash-image-preview', 'google', 'gemini-3.1-flash-image-preview'],
    ['doubao:doubao-seedream-5-0-flash-260915', 'doubao', 'doubao-seedream-5-0-flash-260915'],
    ['doubao:doubao-seedream-5-0-pro-260628', 'doubao', 'doubao-seedream-5-0-pro-260628'],
  ],
  video: [
    ['doubao:doubao-seedance-2-0-260128', 'doubao', 'doubao-seedance-2-0-260128'],
    ['doubao:doubao-seedance-2-0-fast-260128', 'doubao', 'doubao-seedance-2-0-fast-260128'],
    ['doubao:doubao-seedance-2-0-mini', 'doubao', 'doubao-seedance-2-0-mini'],
    ['minimax', 'minimax', 'MiniMax-Hailuo-2.3'],
    ['vidu', 'vidu', 'viduq3-pro'],
    ['kling', 'kling', 'kling-v3-0-turbo'],
    ['google', 'google', 'veo-3.1-generate-preview'],
    ['runway', 'runway', 'gen4.5'],
  ],
};

for (const kind of ['image', 'video'] as const) {
  test(`saves all public BYO ${kind} model choices and preserves them across restart`, async ({ modelOrkas: orkas }, testInfo) => {
    let page = orkas.page!;
    await denyExternalProviderRequests(orkas);
    await openSettingsTab(page, 'credentials');
    await page.locator(`[data-settings-model-tab="${kind}"]`).click();
    const choices = PUBLIC_MEDIA_CHOICES[kind];
    const secret = `sk-e2e-${kind}-no-provider-call-xxxxxxxx`;
    for (const [index, [option]] of choices.entries()) {
      await page.locator(`[data-settings-add="${kind}"]`).click();
      const modal = page.locator('#settings-add-modal');
      await expect(modal).toHaveClass(/\bopen\b/);
      await page.locator(`#settings-${kind}-provider .ai-select-trigger`).click();
      const menu = page.locator('.ai-select-popover:visible');
      await expect(menu.locator('.ai-select-item')).toHaveCount(choices.length + 1);
      expect(await menu.locator('.ai-select-item').evaluateAll(items => items.map(item => (item as HTMLElement).dataset.value)))
        .toEqual(['orkas-api', ...choices.map(choice => choice[0])]);
      if (index === 0) {
        await menu.screenshot({ path: testInfo.outputPath(`${kind}-public-picker-top.png`) });
        await menu.locator('.ai-select-item').last().scrollIntoViewIfNeeded();
        await menu.screenshot({ path: testInfo.outputPath(`${kind}-public-picker-bottom.png`) });
      }
      await menu.locator(`.ai-select-item[data-value="${option}"]`).click();
      await page.locator(`#settings-${kind}-key-input`).fill(secret);
      await page.locator(`#settings-${kind}-add-btn`).click();
      await expect(modal).not.toHaveClass(/\bopen\b/);
      await expect(page.locator(`#settings-${kind}-entries .entry-row`)).toHaveCount(index + 1);
      await expect(page.locator(`#settings-${kind}-entries`)).not.toContainText(secret);
    }
    type Listed = { profiles: Array<{ id: string; provider: string; model: string; apiKey?: string; apiKeyMasked: string }> };
    const before = await orkas.invoke<Listed>(`${kind}Auth.list`);
    expect(before.profiles.map(profile => [profile.provider, profile.model]).sort())
      .toEqual(choices.map(([, provider, model]) => [provider, model]).sort());
    for (const profile of before.profiles) {
      expect(profile).not.toHaveProperty('apiKey');
      expect(profile.apiKeyMasked).not.toBe(secret);
    }
    await expectSettingsOnly(orkas);
    page = await orkas.relaunch();
    await denyExternalProviderRequests(orkas);
    await openSettingsTab(page, 'credentials');
    await page.locator(`[data-settings-model-tab="${kind}"]`).click();
    const after = await orkas.invoke<Listed>(`${kind}Auth.list`);
    expect(after.profiles).toEqual(before.profiles);
    await expect(page.locator(`#settings-${kind}-entries .entry-row`)).toHaveCount(choices.length);
    await page.setViewportSize({ width: 620, height: 900 });
    await page.evaluate(async () => { await (window as any).setLang('zh'); });
    await page.locator(`#settings-${kind}-entries`).screenshot({ path: testInfo.outputPath(`${kind}-saved-models-zh-620.png`) });
    for (const profile of after.profiles) {
      const row = page.locator(`#settings-${kind}-entries .entry-row[data-profile-id="${profile.id}"]`);
      await row.locator('.entry-actions .btn-danger').click();
      await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
      await expect(row).toHaveCount(0);
    }
    expect((await orkas.invoke<Listed>(`${kind}Auth.list`)).profiles).toEqual([]);
    await expectSettingsOnly(orkas);
  });
}

test('keeps a legacy small-context model visible for removal without ranking it', async ({ modelOrkas: orkas }, testInfo) => {
  await denyExternalProviderRequests(orkas);
  const good = await orkas.invoke<{ entryId: string; profileId: string }>('auth.addCustomModelEntry', {
    label: 'E2E Capacity Good', model: 'e2e-capacity-good',
    baseUrl: 'https://capacity-fixture.invalid/v1', apiKey: 'synthetic-capacity-key',
    contextWindow: 32000, maxTokens: 8192,
  });
  expect(good).toMatchObject({ entryId: expect.any(String), profileId: expect.any(String) });
  // Reproduce a real older encrypted profile through the existing storage seam,
  // exactly as the owning auth compatibility case does. No real user data.
  await orkas.electronApp!.evaluate((_electron, input) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const fs = req('node:fs');
    const paths = req(process.cwd() + '/src/main/paths.ts');
    const secrets = req(process.cwd() + '/src/main/util/local-secret-store.ts');
    const users = req(process.cwd() + '/src/main/features/users.ts');
    const uid = users.getActiveUserId();
    const file = paths.userAuthProfilesFile(uid);
    const context = { namespace: 'auth.profiles', ownerId: uid, recordId: 'auth-profiles.json' };
    const store = JSON.parse(secrets.decryptLocalSecret(context, fs.readFileSync(file, 'utf8')));
    const entry = store.entries.find((entry: { entryId: string }) => entry.entryId === input.entryId);
    store.profiles['custom:e2e-legacy-small'] = { ...store.profiles[input.profileId], label: 'E2E Legacy Small', contextWindow: 31999 };
    store.entries.unshift({ ...entry, entryId: 'e2e-legacy-small', profileId: 'custom:e2e-legacy-small' });
    fs.writeFileSync(file, secrets.encryptLocalSecret(context, JSON.stringify(store)));
  }, good);
  const page = orkas.page!;
  await openSettingsTab(page, 'credentials');
  const row = page.locator('#settings-entries [data-entry-id="e2e-legacy-small"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.entry-status.error')).toContainText(/32[,. ]?000/);
  await expect(row).toHaveAttribute('draggable', 'false');
  await expect(row.locator('.entry-rank')).toBeEmpty();
  await expect(row.locator('.entry-sort')).toHaveCount(0);
  const composer = await orkas.invoke<{ entries: Array<{ entryId: string }> }>('auth.listComposerEntries');
  expect(composer.entries.map(entry => entry.entryId)).toContain(good.entryId);
  expect(composer.entries.map(entry => entry.entryId)).not.toContain('e2e-legacy-small');
  await page.setViewportSize({ width: 620, height: 900 });
  await row.screenshot({ path: testInfo.outputPath('legacy-small-context-remediation.png') });
  await row.locator('.entry-actions .danger').click();
  await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
  await expect(row).toHaveCount(0);
  const after = await orkas.invoke<{ entries: Array<{ entryId: string }> }>('auth.listEntries', { includeUnavailable: true });
  expect(after.entries.map(entry => entry.entryId)).toContain(good.entryId);
  expect(after.entries.map(entry => entry.entryId)).not.toContain('e2e-legacy-small');
  await expectSettingsOnly(orkas);
});
