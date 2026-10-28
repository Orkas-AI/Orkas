import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures/orkas';


test('reports a native picker failure, keeps cancellation neutral, and lets the user retry', async ({ orkas }, info) => {
  const page = orkas.page!;
  await page.locator('#new-chat-btn').click();

  for (const [locale, width, height] of [['en', 1440, 900], ['zh', 800, 600]] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(lang => (window as any).setLang(lang), locale);
    await orkas.cancelNextFileDialog();
    await orkas.electronApp!.evaluate(({ dialog }) => {
      const cancel = dialog.showOpenDialog;
      (globalThis as any).__attachmentPickerSettled = false;
      (dialog as any).showOpenDialog = async (...args: any[]) => {
        try { return await (cancel as any)(...args); }
        finally { (globalThis as any).__attachmentPickerSettled = true; }
      };
    });
    await page.locator('#new-chat-attach-btn').click();
    await expect.poll(() => orkas.electronApp!.evaluate(() => (globalThis as any).__attachmentPickerSettled)).toBe(true);
    await expect(page.locator('#new-chat-attachments .chat-attach-chip')).toHaveCount(0);
    await expect(page.locator('.ui-dialog-overlay.open')).toHaveCount(0);

    // Fault only the OS picker boundary; the actual IPC failure envelope,
    // renderer result, localized shared dialog and recovery remain real.
    await orkas.electronApp!.evaluate(({ dialog }) => {
      const original = dialog.showOpenDialog;
      (dialog as any).showOpenDialog = async () => {
        dialog.showOpenDialog = original;
        throw new Error('fixture_picker_unavailable');
      };
    });
    await page.locator('#new-chat-attach-btn').click();
    const alert = page.locator('.ui-dialog-overlay.open');
    await expect(alert.locator('[role="alertdialog"]')).toBeVisible();
    await expect(alert.locator('.ui-dialog-message')).toHaveText(locale === 'en' ? 'Upload failed' : '上传失败');
    await expect(alert.locator('[data-act="ok"]')).toBeFocused();
    await page.screenshot({ path: info.outputPath(`picker-failure-${locale}.png`) });
    await page.keyboard.press('Escape');
    await expect(alert).toHaveCount(0);
    await expect(page.locator('#new-chat-attach-btn')).toBeFocused();

    const body = `Intact retry bytes ${locale}`;
    const file = orkas.createFixtureFile(`retry-${locale}.txt`, body);
    await orkas.selectFilesOnNextDialog([file]);
    await page.locator('#new-chat-attach-btn').click();
    await expect(page.locator('#new-chat-attachments .chat-attach-label')).toContainText([`retry-${locale}.txt`]);
    const pending = await orkas.invoke<any>('conversations.attachments.list', { cid: 'main_chat' });
    const stored = pending.items.find((item: any) => item.name === `retry-${locale}.txt`);
    expect(stored?.bytes).toBe(Buffer.byteLength(body));
    expect(readFileSync(file, 'utf8')).toBe(body);
    await page.locator('#new-chat-attachments .chat-attach-remove').click();
    await expect(page.locator('#new-chat-attachments .chat-attach-chip')).toHaveCount(0);
  }
});
