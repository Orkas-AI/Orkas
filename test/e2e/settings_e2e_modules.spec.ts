import { expect, test } from './fixtures/orkas';

async function openSettingsTab(page: import('@playwright/test').Page, tabName: string): Promise<void> {
  await page.locator('#settings-btn').click();
  const tab = page.locator(`.settings-tab[data-settings-tab="${tabName}"]`);
  await tab.click();
  await expect(tab).toHaveClass(/\bis-active\b/);
  await expect(page.locator(`[data-settings-pane="${tabName}"]`)).toBeVisible();
}

test.describe('settings modules and model guard', () => {
  test('renders data, recycle bin, and BYO credential settings', async ({ appPage }) => {
    await openSettingsTab(appPage, 'data');
    await expect(appPage.locator('#settings-data-root-btn')).toBeVisible();
    await expect(appPage.locator('#settings-recycle-group')).toBeVisible();
    await expect(appPage.locator('#settings-recycle-body')).toBeVisible();

    await openSettingsTab(appPage, 'credentials');
    await expect(appPage.locator('#settings-add-entry-btn')).toBeVisible();
    await expect(appPage.locator('#settings-entries .entry-row', {
      hasText: 'E2E-Local-Model',
    })).toBeVisible();
    await expect(appPage.locator('#settings-entries .settings-empty')).toHaveCount(0);
    await appPage.locator('#settings-add-entry-btn').click();
    await expect(appPage.locator('#settings-picker-status')).not.toHaveText('');
  });

  test('persists a masked model credential entry and removes it from the UI', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    await openSettingsTab(orkas.page, 'credentials');
    await orkas.page.locator('#settings-picker-provider .ai-select-trigger').click();
    let popover = orkas.page.locator('.ai-select-popover:visible');
    await popover.locator('.ai-select-item', { hasText: 'Anthropic' }).click();
    await orkas.page.locator('#settings-picker-model .ai-select-trigger').click();
    popover = orkas.page.locator('.ai-select-popover:visible');
    await expect(popover.locator('.ai-select-item').first()).toBeVisible();
    await popover.locator('.ai-select-item').first().click();
    await orkas.page.locator('#settings-add-entry-btn').click();
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

  test('configures a custom endpoint without exposing its key or endpoint in Settings', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const beforeSave = await orkas.invoke<{
      entries: Array<{ entryId: string; provider: string }>;
    }>('auth.listEntries', { includeUnavailable: true });
    const beforeCustomIds = beforeSave.entries
      .filter((entry) => entry.provider === 'custom')
      .map((entry) => entry.entryId)
      .sort();
    await openSettingsTab(orkas.page, 'credentials');
    await orkas.page.locator('#settings-picker-provider .ai-select-trigger').click();
    const popover = orkas.page.locator('.ai-select-popover:visible');
    await popover.locator('.ai-select-item', { hasText: 'Custom' }).click();
    await expect(orkas.page.locator('#settings-picker-model-row')).toBeHidden();
    await orkas.page.locator('#settings-add-entry-btn').click();

    const modal = orkas.page.locator('#add-account-modal');
    await expect(modal).toHaveClass(/\bopen\b/);
    await expect(modal.locator('.custom-key-input')).toHaveAttribute('type', 'password');
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
      'https://gateway.example.invalid/v1/chat/completions',
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
    await expect(row).not.toContainText('gateway.example.invalid');
    await row.locator('.entry-actions .danger').click();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(row).toHaveCount(0);
  });

});
