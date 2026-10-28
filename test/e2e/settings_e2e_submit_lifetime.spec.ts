import { expect, test } from './fixtures/orkas';


for (const method of ['api_key', 'custom'] as const) {
  test(`saves the ${method} credential once when Enter repeats during the actual Main write response`, async ({ orkas: app }) => {
    const page = app.page!;
    const provider = method === 'custom' ? 'custom' : 'openai';
    const channel = method === 'custom' ? 'addCustomModelEntry' : 'addApiKeyEntry';
    const before = await app.invoke<any>('auth.listEntries', { includeUnavailable: true });
    const previous = before.entries.filter((entry: any) => entry.provider === provider).length;
    // Hold delivery only after the real account-scoped encrypted write. No
    // profile, entry, validation result or persistence response is fabricated.
    await app.electronApp!.evaluate(({ ipcMain }, { channel }) => {
      // Electron exposes handler registration publicly but no public getter.
      // Inspect the pinned test runtime's map, fail explicitly if unavailable,
      // and forward every original sender/payload through the real handler.
      const handlers = (ipcMain as any)._invokeHandlers as Map<string, Function>;
      const original = handlers?.get('orkas.invoke');
      if (typeof original !== 'function') throw new Error('Native fixture IPC handler seam unavailable');
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const control = { calls: 0, release, restore: () => {
        if (handlers.get('orkas.invoke') !== wrapped) throw new Error('Native fixture handler owner changed');
        ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', original as any);
      } };
      const wrapped = async (event: unknown, request: any) => {
        if (request?.channel !== `auth.${channel}`) return original(event, request);
        const call = ++control.calls;
        const result = await original(event, request);
        if (call === 1) await gate;
        return result;
      };
      ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', wrapped as any);
      (globalThis as any).__settingsSubmitControl = control;
    }, { channel });
    try {
      await page.evaluate(async method => {
        const host = window as any;
        await host.loadRendererFeature('settings');
        // Form selection is fixture setup; the real dialog, keyboard handler,
        // preload, IPC, Main validation, encrypted store and UI result run.
        if (method === 'custom') host._settingsShowCustomModelForm({ id: 'custom', label: 'Custom' });
        else host._settingsShowApiKeyForm({ id: 'openai', label: 'OpenAI' }, 'gpt-5.6-sol');
      }, method);
      const modal = page.locator('#add-account-modal');
      await expect(modal).toHaveClass(/\bopen\b/);
      if (method === 'custom') {
        await modal.locator('.custom-base-url-input').fill('https://gateway.example.test/v1');
        await modal.locator('.custom-model-input').fill('fixture-model');
      }
      const input = modal.locator(method === 'custom' ? '.custom-key-input' : '.api-key-input');
      await input.fill('synthetic-native-submit-key');
      await input.press('Enter');
      const save = modal.locator('#add-account-actions .btn-primary');
      await expect(save).toBeDisabled();
      await expect.poll(() => app.electronApp!.evaluate(() => (globalThis as any).__settingsSubmitControl.calls)).toBe(1);
      await input.press('Enter'); await input.press('Enter');
      // Same-renderer IPC round trip follows the repeated keyboard events.
      const pending = await app.invoke<any>('auth.listEntries', { includeUnavailable: true });
      const calls = await app.electronApp!.evaluate(() => (globalThis as any).__settingsSubmitControl.calls);
      const persistedRows = pending.entries.filter((entry: any) => entry.provider === provider).length;
      expect({ calls, persistedRows }).toEqual({ calls: 1, persistedRows: previous + 1 });
      await app.electronApp!.evaluate(() => (globalThis as any).__settingsSubmitControl.release());
      await expect(modal).not.toHaveClass(/\bopen\b/);
      const after = await app.invoke<any>('auth.listEntries', { includeUnavailable: true });
      expect(after.entries.filter((entry: any) => entry.provider === provider)).toHaveLength(previous + 1);
    } finally {
      await app.electronApp!.evaluate(() => {
        const control = (globalThis as any).__settingsSubmitControl;
        control?.release(); control?.restore();
        delete (globalThis as any).__settingsSubmitControl;
      });
    }
  });
}
