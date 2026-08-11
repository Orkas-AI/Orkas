import { expect, test } from './fixtures/orkas';

test.describe('My Apps', () => {
  test('opens safely, renames, prepares an edit, persists, and deletes a saved app', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const indexPath = orkas.createWorkspaceFile(
      'e2e-app/index.html',
      '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 id="app-title">E2E App Running</h1></body></html>',
    );
    orkas.createWorkspaceFile('e2e-app/style.css', 'body { color: rgb(12, 34, 56); }');
    const saved = await orkas.invoke<{ ok: boolean; id: string; title: string }>('savedApps.saveFromPath', {
      path: indexPath,
      title: 'E2E Saved App',
    });
    expect(saved.ok).toBe(true);

    await page.locator('#apps-btn').click();
    await expect(page.locator('#panel-apps')).toHaveClass(/\bactive\b/);
    let card = page.locator(`.app-card[data-app-id="${saved.id}"]`);
    await expect(card).toContainText('E2E Saved App');
    await expect(page.locator('#apps-page-header-count')).toHaveText('1');

    await card.click();
    const viewer = page.locator('.saved-app-viewer');
    await expect(viewer).toHaveClass(/\bis-open\b/);
    await expect(viewer.locator('.saved-app-viewer-title')).toHaveText('E2E Saved App');
    const appFrame = viewer.locator('.saved-app-viewer-frame');
    await expect(appFrame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    await expect(appFrame.contentFrame().locator('#app-title')).toHaveText('E2E App Running');
    expect(await appFrame.contentFrame().locator('body').evaluate(() => typeof (window as any).orkas)).toBe('undefined');
    await viewer.locator('.saved-app-viewer-close').click();
    await expect(viewer).not.toHaveClass(/\bis-open\b/);

    await card.hover();
    await card.locator('[data-app-more]').click();
    await page.locator('.app-row-menu-item[data-action="rename"]').click();
    const prompt = page.locator('.ui-dialog-overlay:visible');
    await prompt.locator('.ui-dialog-input').fill('E2E Renamed App');
    await prompt.locator('[data-act="ok"]').click();
    card = page.locator(`.app-card[data-app-id="${saved.id}"]`);
    await expect(card).toContainText('E2E Renamed App');

    await card.hover();
    await card.locator('[data-app-more]').click();
    await page.locator('.app-row-menu-item[data-action="edit"]').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-input')).toHaveValue(/E2E Renamed App/);
    await expect(page.locator('#chat-attachments')).toContainText('app-source.md');

    const relaunchedPage = await orkas.relaunch();
    await relaunchedPage.locator('#apps-btn').click();
    card = relaunchedPage.locator(`.app-card[data-app-id="${saved.id}"]`);
    await expect(card).toContainText('E2E Renamed App');
    await card.hover();
    await card.locator('[data-app-more]').click();
    await relaunchedPage.locator('.app-row-menu-item[data-action="delete"]').click();
    await expect(relaunchedPage.locator('.ui-dialog-overlay:visible .ui-dialog-danger')).toBeVisible();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(card).toHaveCount(0);
    await expect(relaunchedPage.locator('#apps-empty')).toBeVisible();
    await expect(relaunchedPage.locator('#apps-page-header-count')).toHaveText('');
  });
});
