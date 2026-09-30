import * as path from 'node:path';
import { expect, test } from './fixtures/orkas';


test('authorization account selection binds an explicit choice and dismisses cancellation', async ({ orkas }) => {
  const page = orkas.page!;
  const electron = orkas.electronApp!;
  const root = path.resolve(__dirname, '../..');
  for (const mode of ['select', 'cancel', 'host-cancel']) {
    await electron.evaluate((_electron, { root }) => {
      const host = process as any;
      const load = host.mainModule.require.bind(host.mainModule);
      const gate = load(`${root}/src/main/features/connectors/account-choice.ts`);
      const users = load(`${root}/src/main/features/users.ts`);
      host.__accountChoiceController = new AbortController();
      host.__accountChoiceOutcome = null;
      void gate.requestAccountChoice(users.getActiveUserId(), 'tiktok-shop', [
        { id: '123', label: '<img src=x onerror=alert(1)> Shop A' },
        { id: '456', label: 'Shop B (456)' },
      ], host.__accountChoiceController.signal).then(
        (id: string) => { host.__accountChoiceOutcome = { id }; },
        (error: { code: string }) => { host.__accountChoiceOutcome = { code: error.code }; },
      );
    }, { root });
    const dialog = page.getByRole('dialog', { name: 'Choose the account to connect' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('img')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '<img src=x onerror=alert(1)> Shop A', exact: true })).toBeVisible();
    if (mode === 'select') await dialog.getByRole('button', { name: 'Shop B (456)', exact: true }).click();
    else if (mode === 'cancel') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    else await electron.evaluate(() => (process as any).__accountChoiceController.abort());
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => electron.evaluate(() => (process as any).__accountChoiceOutcome))
      .toEqual(mode === 'select' ? { id: '456' } : { code: 'user_cancelled' });
  }
});
