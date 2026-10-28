import { expect, test } from './fixtures/orkas';
import { holdInvokeResponse } from './fixtures/held-invoke-response';


for (const method of ['api_key', 'custom'] as const) {
  test(`keeps the next credential form open when the previous ${method} write response arrives`, async ({ orkas: app }, testInfo) => {
    const page = app.page!;
    const channel = method === 'custom' ? 'auth.addCustomModelEntry' : 'auth.addApiKeyEntry';
    const provider = method === 'custom' ? 'custom' : 'openai';
    const previous = (await app.invoke<any>('auth.listEntries', { includeUnavailable: true })).entries.filter((entry: any) => entry.provider === provider).length;
    await holdInvokeResponse(app.electronApp!, channel);
    try {
      await page.evaluate(async method => {
        const host = window as any; await host.loadRendererFeature('settings');
        const reload = host._settingsReload;
        host.__modalSaveSettled = false;
        host._settingsReload = async (...args: any[]) => {
          try { return await reload(...args); }
          finally { host.__modalSaveSettled = true; }
        };
        host.restoreModalReload = () => { host._settingsReload = reload; };
        if (method === 'custom') host._settingsShowCustomModelForm({ id: 'custom', label: 'Custom' });
        else host._settingsShowApiKeyForm({ id: 'openai', label: 'OpenAI' }, 'gpt-5.6-sol');
      }, method);
      const modal = page.locator('#add-account-modal');
      if (method === 'custom') {
        await modal.locator('.custom-base-url-input').fill('https://gateway.example.test/v1');
        await modal.locator('.custom-model-input').fill('fixture-model');
      }
      await modal.locator(method === 'custom' ? '.custom-key-input' : '.api-key-input').fill('synthetic-old-form-key');
      await modal.locator('#add-account-actions .btn-primary').click();
      await expect(modal.locator('#add-account-actions .btn-primary')).toBeDisabled();
      await expect.poll(() => app.electronApp!.evaluate(() => (globalThis as any).__heldInvokeResponse.calls)).toBe(1);
      await modal.locator('#add-account-actions .btn:not(.btn-primary)').click();
      await expect(modal).not.toHaveClass(/\bopen\b/);
      await page.evaluate(method => {
        const host = window as any;
        if (method === 'custom') host._settingsShowApiKeyForm({ id: 'openai', label: 'OpenAI' }, 'gpt-5.6-sol');
        else host._settingsShowCustomModelForm({ id: 'custom', label: 'Custom' });
      }, method);
      const input = modal.locator(method === 'custom' ? '.api-key-input' : '.custom-key-input');
      await input.fill('synthetic-unsaved-new-form-key');
      await app.electronApp!.evaluate(() => (globalThis as any).__heldInvokeResponse.release());
      // Wait for the real old operation's post-response refresh before observing UI.
      await expect.poll(() => page.evaluate(() => (window as any).__modalSaveSettled)).toBe(true);
      await expect.poll(async () => (await app.invoke<any>('auth.listEntries', { includeUnavailable: true })).entries.filter((entry: any) => entry.provider === provider).length).toBe(previous + 1);
      await expect(modal).toHaveClass(/\bopen\b/);
      await expect(input).toHaveValue('synthetic-unsaved-new-form-key');
      await expect(modal.locator('#add-account-actions .btn-primary')).toBeEnabled();
      await modal.screenshot({ path: testInfo.outputPath(`new-${method}-dialog.png`) });
    } finally {
      await page.evaluate(() => (window as any).restoreModalReload?.());
      await app.electronApp!.evaluate(() => {
        const control = (globalThis as any).__heldInvokeResponse; control.release(); control.restore();
      });
    }
  });
}

test('cancels a delayed real OAuth start after the dialog closes without polling or persisting late credentials', async ({ orkas: app }) => {
  const page = app.page!;
  await app.electronApp!.evaluate(async ({ app }) => {
    const require = (process as any).mainModule.require;
    await require(`${app.getAppPath()}/test/e2e/fixtures/oauth-owner-main.cjs`)(app.getAppPath());
  });
  await holdInvokeResponse(app.electronApp!, 'auth.startOAuth');
  try {
    await page.evaluate(async () => {
      const host = window as any; await host.loadRendererFeature('settings');
      host.__pendingOAuthStart = host._settingsStartOAuthFlow({ id: 'e2e-auth-owner', label: 'Controlled OAuth fixture' }, 'fixture-model');
    });
    await expect.poll(() => app.electronApp!.evaluate(() => (globalThis as any).__oauthOwnerControl.calls)).toBe(1);
    await page.locator('#oauth-flow-close-btn').click();
    await expect(page.locator('#oauth-flow-modal')).not.toHaveClass(/\bopen\b/);
    await app.electronApp!.evaluate(() => (globalThis as any).__heldInvokeResponse.release());
    await page.evaluate(async () => { await (window as any).__pendingOAuthStart; });
    // Observe two existing400ms poll intervals while the provider stays held.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 900)));
    const state = await app.electronApp!.evaluate(async () => {
      const c = (globalThis as any).__oauthOwnerControl;
      const aborted = c.callbacks.signal.aborted;
      c.release(); await new Promise(resolve => setImmediate(resolve));
      return { aborted, polls: (globalThis as any).__heldInvokeResponse.polls,
        unchanged: c.files.map((file: string, index: number) => c.fs.readFileSync(file).equals(c.before[index])) };
    });
    expect(state).toEqual({ aborted: true, polls: 0, unchanged: [true, true] });
    await expect(page.locator('#oauth-flow-modal')).not.toHaveClass(/\bopen\b/);
  } finally {
    await app.electronApp!.evaluate(async () => {
      const c = (globalThis as any).__oauthOwnerControl;
      const held = (globalThis as any).__heldInvokeResponse;
      c.users.activateUser(c.owner); c.auth.cancelOAuthFlow(held.flowId); c.release(); held.release();
      await new Promise(resolve => setImmediate(resolve));
      c.oauth.unregisterOAuthProvider('e2e-auth-owner'); held.restore(); delete (globalThis as any).__oauthOwnerControl;
    });
  }
});
