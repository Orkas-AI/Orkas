import { expect, test } from './fixtures/orkas';



test('cancel keeps a task streaming; confirming close also protects a task in the background', async ({ modelOrkas }) => {
  const page = modelOrkas.page!;
  const app = modelOrkas.electronApp!;
  modelOrkas.setModelMode('controlled-slow');
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill('Keep this task running while I close the window.');
  await page.locator('#new-chat-send-btn').click();
  await expect.poll(() => modelOrkas.modelRequests.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);

  // Exercise real native close events and task state; only the user's dialog
  // choice is supplied at the native-dialog boundary.
  await app.evaluate(({ dialog }) => {
    (globalThis as any).closeDialogCalls = [];
    dialog.showMessageBox = (async (_window: unknown, options: unknown) => {
      const calls = (globalThis as any).closeDialogCalls;
      calls.push(options);
      if (calls.length === 1) return { response: 0, checkboxChecked: false };
      return new Promise(resolve => { (globalThis as any).confirmWindowClose = resolve; });
    }) as typeof dialog.showMessageBox;
  });
  const native = await app.browserWindow(page);
  await native.evaluate(win => win.close());
  await expect.poll(() => app.evaluate(() => (globalThis as any).closeDialogCalls.length)).toBe(1);
  expect(page.isClosed()).toBe(false);
  modelOrkas.releaseControlledModelChunk();
  await expect(page.locator('#chat-history .chat-message.assistant'))
    .toContainText('Hello from the local E2E model.');
  await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);

  await page.locator('#new-chat-btn').click();
  await native.evaluate(win => win.close());
  await expect.poll(() => app.evaluate(() => (globalThis as any).closeDialogCalls.length)).toBe(2);
  expect(page.isClosed()).toBe(false);
  const closed = page.waitForEvent('close');
  await app.evaluate(() => {
    setTimeout(() => (globalThis as any).confirmWindowClose({ response: 1, checkboxChecked: false }), 0);
  });
  await closed;
});
