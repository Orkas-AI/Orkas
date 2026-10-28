import { expect, test } from './fixtures/orkas';
import { holdInvokeResponse } from './fixtures/held-invoke-response';

for (const update of ['newer-read', 'selection'] as const) {
  test(`keeps the chosen model after a delayed list response and ${update}`, async ({ orkas: app }, testInfo) => {
    const page = app.page!;
    const next = await app.invoke<any>('auth.addCustomModelEntry', {
      label: 'next-fixture', baseUrl: 'https://gateway.example.test/v1', model: 'fixture-next-model', apiKey: 'synthetic-next-key',
    });
    const old = await app.invoke<any>('auth.addCustomModelEntry', {
      label: 'old-fixture', baseUrl: 'https://gateway.example.test/v1', model: 'fixture-old-model', apiKey: 'synthetic-old-key',
    });
    expect(next.ok && old.ok).toBe(true);
    await page.evaluate(async () => { await (window as any)._refreshComposerModelEntries(); });
    const chip = page.locator('[data-composer-model-chip="new-chat"]');
    await expect(chip.locator('.composer-model-chip-name')).toHaveText('fixture-old-model');
    if (update === 'selection') {
      await chip.click();
      await expect(page.locator('#composer-model-menu')).toBeVisible();
    }
    await holdInvokeResponse(app.electronApp!, 'auth.listComposerEntries');
    try {
      await page.evaluate(() => { const host = window as any; host.__modelReadSettled = false; host.__pendingModelRead = host._refreshComposerModelEntries().then(() => { host.__modelReadSettled = true; }); });
      await expect.poll(() => app.electronApp!.evaluate(() => (globalThis as any).__heldInvokeResponse.ready)).toBe(true);
      expect((await app.electronApp!.evaluate(() => (globalThis as any).__heldInvokeResponse.entryIds))[0]).toBe(old.entryId);
      expect(await page.evaluate(() => (window as any).__modelReadSettled)).toBe(false);
      if (update === 'selection') {
        await page.locator('#composer-model-menu .composer-model-menu-select').filter({ hasText: 'next-fixture' }).click();
      } else {
        expect((await app.invoke<any>('auth.selectEntry', { entryId: next.entryId })).ok).toBe(true);
        await page.evaluate(async () => { await (window as any)._refreshComposerModelEntries(); });
      }
      await expect(chip.locator('.composer-model-chip-name')).toHaveText('fixture-next-model');
      expect((await app.invoke<any>('auth.listComposerEntries')).entries[0].entryId).toBe(next.entryId);
      expect(await page.evaluate(() => (window as any).__modelReadSettled)).toBe(false);
      await app.electronApp!.evaluate(() => (globalThis as any).__heldInvokeResponse.release());
      const afterOldRead = await page.evaluate(async () => {
        await (window as any).__pendingModelRead;
        return document.querySelector('[data-composer-model-chip="new-chat"] .composer-model-chip-name')?.textContent;
      });
      expect(afterOldRead).toBe('fixture-next-model');
      expect((await app.invoke<any>('auth.listComposerEntries')).entries[0].entryId).toBe(next.entryId);
      await chip.screenshot({ path: testInfo.outputPath('current-model-chip.png') });
    } finally {
      await app.electronApp!.evaluate(() => {
        const control = (globalThis as any).__heldInvokeResponse; control.release(); control.restore();
      });
    }
  });
}
