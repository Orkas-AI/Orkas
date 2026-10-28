import { expect, test } from './fixtures/orkas';

test('shows the existing authorization failure copy without publishing a raw provider response', async ({ orkas: app }, testInfo) => {
  const page = app.page!;
  await app.electronApp!.evaluate(async ({ app }) => {
    const require = (process as any).mainModule.require;
    await require(`${app.getAppPath()}/test/e2e/fixtures/oauth-owner-main.cjs`)(app.getAppPath());
  });
  try {
    await page.evaluate(async () => {
      const host = window as any; await host.loadRendererFeature('settings');
      await host._settingsStartOAuthFlow({ id: 'e2e-auth-owner', label: 'Controlled OAuth fixture' }, 'fixture-model');
    });
    await expect.poll(() => app.electronApp!.evaluate(() => (globalThis as any).__oauthOwnerControl.calls)).toBe(1);
    await app.electronApp!.evaluate(() => {
      const control = (globalThis as any).__oauthOwnerControl;
      control.reject(new Error('Token exchange returned invalid JSON. url=https://provider.example.test/token; body={"access_token":"synthetic-native-private-marker","email":"fixture-person@example.test"}; details=SyntaxError'));
    });
    await expect(page.locator('#oauth-flow-body .oauth-flow-stage.error')).toHaveText('Authorization failed');
    const observation = await page.evaluate(() => ({
      text: document.querySelector('#oauth-flow-body')?.textContent,
      open: document.querySelector('#oauth-flow-modal')?.classList.contains('open'),
    }));
    expect(observation).toEqual({ text: 'Authorization failed', open: true });
    const unchanged = await app.electronApp!.evaluate(() => {
      const c = (globalThis as any).__oauthOwnerControl;
      return c.files.map((file: string, index: number) => c.fs.readFileSync(file).equals(c.before[index]));
    });
    expect(unchanged).toEqual([true, true]);
    await page.locator('#oauth-flow-modal').screenshot({ path: testInfo.outputPath('authorization-failed.png') });
  } finally {
    await page.locator('#oauth-flow-close-btn').click();
    await app.electronApp!.evaluate(async () => {
      const c = (globalThis as any).__oauthOwnerControl;
      c.users.activateUser(c.owner); c.release();
      await new Promise(resolve => setImmediate(resolve));
      c.oauth.unregisterOAuthProvider('e2e-auth-owner'); delete (globalThis as any).__oauthOwnerControl;
    });
  }
});
