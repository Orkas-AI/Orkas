import { expect, test } from './fixtures/orkas';

test.describe('shared dialog behavior', () => {
  test('preserves keyboard intent, accessible names, focus, and stacked decisions', async ({
    appPage,
  }) => {
    await appPage.evaluate(() => {
      const background = document.createElement('button');
      background.id = 'e2e-dialog-background';
      background.textContent = 'Background action';
      document.body.appendChild(background);
      background.focus();
      (window as any).__e2eDialogResults = [];
      (window as any).uiConfirm('Keep this item?').then((value: boolean) => {
        (window as any).__e2eDialogResults.push(['single', value]);
      });
    });

    const singleDialog = appPage.getByRole('dialog', { name: 'Keep this item?' });
    await expect(singleDialog).toBeVisible();
    const ok = singleDialog.locator('[data-act="ok"]');
    const cancel = singleDialog.locator('[data-act="cancel"]');
    await expect(ok).toBeFocused();
    await appPage.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await appPage.keyboard.press('Shift+Tab');
    await expect(ok).toBeFocused();
    await cancel.focus();
    await appPage.keyboard.press('Enter');
    await expect(singleDialog).toHaveCount(0);
    await expect.poll(() => appPage.evaluate(
      () => (window as any).__e2eDialogResults,
    )).toEqual([['single', false]]);
    await expect(appPage.locator('#e2e-dialog-background')).toBeFocused();

    await appPage.evaluate(() => {
      (window as any).uiConfirm('First stacked decision').then((value: boolean) => {
        (window as any).__e2eDialogResults.push(['first', value]);
      });
      (window as any).uiConfirm('Second stacked decision').then((value: boolean) => {
        (window as any).__e2eDialogResults.push(['second', value]);
      });
    });
    const first = appPage.getByRole('dialog', { name: 'First stacked decision' });
    const second = appPage.getByRole('dialog', { name: 'Second stacked decision' });
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();

    await appPage.keyboard.press('Escape');
    await expect(second).toHaveCount(0);
    await expect(first).toBeVisible();
    await expect.poll(() => appPage.evaluate(
      () => (window as any).__e2eDialogResults,
    )).toEqual([
      ['single', false],
      ['second', false],
    ]);

    await appPage.keyboard.press('Escape');
    await expect(first).toHaveCount(0);
    await expect.poll(() => appPage.evaluate(
      () => (window as any).__e2eDialogResults,
    )).toEqual([
      ['single', false],
      ['second', false],
      ['first', false],
    ]);
    await expect(appPage.locator('#e2e-dialog-background')).toBeFocused();
  });
});
