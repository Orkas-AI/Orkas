import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/orkas';

async function openDataSettings(page: Page): Promise<void> {
  await page.locator('#settings-btn').click();
  const dataTab = page.locator('.settings-tab[data-settings-tab="data"]');
  await dataTab.click();
  await expect(dataTab).toHaveClass(/\bis-active\b/);
  await expect(page.locator('[data-settings-pane="data"]')).toBeVisible();
}

async function openPersonalMemory(page: Page): Promise<void> {
  await openDataSettings(page);
  await page.locator('#memory-entry-card').click();
  await expect(page.locator('#panel-memory')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#memory-page .memory-section')).toHaveCount(2);
}

test.describe('secondary user surfaces', () => {
  test('imports reviewed memory into separate user and shared scopes', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    await openPersonalMemory(page);

    await page.locator('[data-mem-action="open-import"]').click();
    const importModal = page.locator('.memory-modal-overlay:visible');
    await expect(importModal).toBeVisible();
    await importModal.locator('#memory-import-text').fill([
      'E2E prefers release notes with a concise summary.',
      'The E2E release checklist is the durable source of truth.',
    ].join('\n'));
    await expect(importModal.locator('#memory-import-stat')).toContainText('2 lines');
    await importModal.locator('#memory-import-parse-btn').click();

    const reviewModal = page.locator('.memory-modal-overlay:visible');
    await expect(reviewModal.locator('.memory-modal-step')).toHaveText('2 / 2');
    const rows = reviewModal.locator('.memory-import-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).not.toHaveClass(/\bis-off\b/);
    await expect(rows.nth(1)).not.toHaveClass(/\bis-off\b/);
    await rows.nth(0).locator('[data-mem-action="set-target"][data-mem-target="user"]').click();
    await page.locator('.memory-modal-overlay:visible .memory-import-row').nth(1)
      .locator('[data-mem-action="set-target"][data-mem-target="shared"]').click();
    await page.locator('.memory-modal-overlay:visible #memory-review-merge').click();
    await expect(page.locator('.memory-modal-overlay:visible')).toHaveCount(0);

    const userSection = page.locator('.memory-section', {
      has: page.locator('[data-mem-action="add"][data-mem-target="user"]'),
    });
    const sharedSection = page.locator('.memory-section', {
      has: page.locator('[data-mem-action="add"][data-mem-target="shared"]'),
    });
    await expect(userSection).toContainText('E2E prefers release notes with a concise summary.');
    await expect(sharedSection).toContainText('The E2E release checklist is the durable source of truth.');

    const userMemory = await orkas.invoke<{ entries: string[] }>('memory.list', { target: 'user' });
    const sharedMemory = await orkas.invoke<{ entries: string[] }>('memory.list', { target: 'shared' });
    expect(userMemory.entries).toContain('E2E prefers release notes with a concise summary.');
    expect(sharedMemory.entries).toContain('The E2E release checklist is the durable source of truth.');
  });

  test('creates, edits, persists, exports, and deletes personal memory', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    let page = orkas.page;
    await openPersonalMemory(page);

    const userSection = page.locator('.memory-section', {
      has: page.locator('[data-mem-action="add"][data-mem-target="user"]'),
    });
    await userSection.locator('[data-mem-action="add"][data-mem-target="user"]').click();
    await userSection.locator('.memory-entry-textarea').fill('E2E prefers concise project updates.');
    await userSection.locator('[data-mem-action="save-edit"]').click();
    let memoryRow = userSection.locator('.memory-entry', { hasText: 'E2E prefers concise project updates.' });
    await expect(memoryRow).toBeVisible();

    await userSection.locator('[data-mem-action="add"][data-mem-target="user"]').click();
    await userSection.locator('.memory-entry-textarea').fill('E2E prefers concise project release updates.');
    await userSection.locator('[data-mem-action="save-edit"]').click();
    let overlappingRow = userSection.locator('.memory-entry', {
      hasText: 'E2E prefers concise project release updates.',
    });
    await expect(overlappingRow).toBeVisible();

    await memoryRow.locator('[data-mem-action="edit"]').click();
    await userSection.locator('.memory-entry-textarea').fill('E2E prefers concise verified project updates.');
    await userSection.locator('[data-mem-action="save-edit"]').click();
    memoryRow = userSection.locator('.memory-entry', { hasText: 'E2E prefers concise verified project updates.' });
    await expect(memoryRow).toBeVisible();
    await expect(overlappingRow).toBeVisible();

    await page.locator('[data-mem-action="open-export"]').click();
    const exportModal = page.locator('.memory-modal-overlay:visible');
    const userExport = exportModal.locator('[data-mem-export="user"]');
    await expect(exportModal).toBeVisible();
    await expect(userExport).toBeVisible();
    const exportInfo = await orkas.invoke<{
      files: { user: { raw: string; count: number } };
    }>('memory.exportInfo');
    expect(exportInfo.files.user.count).toBe(2);
    expect(exportInfo.files.user.raw).toContain('E2E prefers concise verified project updates.');
    expect(exportInfo.files.user.raw).toContain('E2E prefers concise project release updates.');
    await userExport.locator('[data-mem-action="copy"]').click();
    await expect(userExport.locator('[data-mem-action="copy"]')).toHaveClass(/\bis-copied\b/);
    const clipboardText = await orkas.electronApp?.evaluate(({ clipboard }) => clipboard.readText());
    expect(clipboardText).toContain('E2E prefers concise verified project updates.');
    await page.locator('.memory-modal-overlay:visible [data-mem-action="modal-close"]').click();

    page = await orkas.relaunch();
    await openPersonalMemory(page);
    const persistedSection = page.locator('.memory-section', {
      has: page.locator('[data-mem-action="add"][data-mem-target="user"]'),
    });
    const persistedRow = persistedSection.locator('.memory-entry', {
      hasText: 'E2E prefers concise verified project updates.',
    });
    await expect(persistedRow).toBeVisible();
    overlappingRow = persistedSection.locator('.memory-entry', {
      hasText: 'E2E prefers concise project release updates.',
    });
    await expect(overlappingRow).toBeVisible();
    await persistedRow.locator('[data-mem-action="delete"]').click();
    await expect(page.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(persistedRow).toHaveCount(0);
    await expect(overlappingRow).toBeVisible();

    await overlappingRow.locator('[data-mem-action="delete"]').click();
    await expect(page.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(overlappingRow).toHaveCount(0);
    await expect(persistedSection.locator('.memory-empty')).toBeVisible();
  });

  test('opens Marketplace from Agents and switches every catalog tab', async ({ appPage }) => {
    await appPage.locator('#agents-btn').click();
    await appPage.locator('#agents-more-btn').click();
    await expect(appPage.locator('#panel-marketplace')).toHaveClass(/\bactive\b/);

    const agentTab = appPage.locator('[data-mp-tab="agent"]');
    const skillTab = appPage.locator('[data-mp-tab="skill"]');
    const ossTab = appPage.locator('[data-mp-tab="oss"]');
    await expect(agentTab).toHaveClass(/\bis-active\b/);
    await expect(appPage.locator('[data-mp-body]')).not.toBeEmpty();

    await skillTab.click();
    await expect(skillTab).toHaveClass(/\bis-active\b/);
    await expect(agentTab).not.toHaveClass(/\bis-active\b/);

    await ossTab.click();
    await expect(ossTab).toHaveClass(/\bis-active\b/);
    await expect(appPage.locator('.mp-oss-hero')).toBeVisible();
    await expect(appPage.locator('#panel-marketplace')).toHaveClass(/\bmp-oss-mode\b/);

    await appPage.locator('[data-mp-close]').click();
    await expect(appPage.locator('#panel-agents')).toHaveClass(/\bactive\b/);
  });

});
