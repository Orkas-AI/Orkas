import { expect, test } from './fixtures/orkas';


for (const scenario of ['cancelled', 'account-switch'] as const) {
  test(`discards a late OAuth credential after ${scenario} through actual IPC and encrypted stores`, async ({ orkas: app }) => {
    // The provider alone is controlled. Actual discovery, login orchestration,
    // preload/IPC, root activation, cancellation and encrypted files run.
    await app.electronApp!.evaluate(async ({ app }) => {
      const require = (process as any).mainModule.require;
      await require(`${app.getAppPath()}/test/e2e/fixtures/oauth-owner-main.cjs`)(app.getAppPath());
    });
    let flowId = '';
    try {
      const started = await app.invoke<any>('auth.startOAuth', { provider: 'e2e-auth-owner', label: 'native-owner' });
      expect(started).toMatchObject({ ok: true, flowId: expect.any(String) });
      flowId = started.flowId;
      expect(await app.electronApp!.evaluate(() => (globalThis as any).__oauthOwnerControl.calls)).toBe(1);
      if (scenario === 'cancelled') {
        expect(await app.invoke<any>('auth.cancelOAuthFlow', { flowId })).toMatchObject({ ok: true });
      } else {
        // Direct root activation is fixture setup, not whole login/logout UI.
        await app.electronApp!.evaluate(() => {
          const c = (globalThis as any).__oauthOwnerControl; c.users.activateUser(c.other);
        });
      }
      const result = await app.electronApp!.evaluate(async (_electron, flowId) => {
        const c = (globalThis as any).__oauthOwnerControl;
        c.release();
        // Drain the real login completion chain before observing files.
        await new Promise(resolve => setImmediate(resolve));
        return { unchanged: c.files.map((file: string, index: number) => c.fs.readFileSync(file).equals(c.before[index])) };
      }, flowId);
      expect(result).toEqual({ unchanged: [true, true] });
      expect(await app.invoke<any>('auth.pollOAuthFlow', { flowId })).toMatchObject({ status: { kind: 'error' } });
    } finally {
      await app.electronApp!.evaluate(async (_electron, flowId) => {
        const c = (globalThis as any).__oauthOwnerControl;
        c.users.activateUser(c.owner); c.auth.cancelOAuthFlow(flowId); c.release();
        await new Promise(resolve => setImmediate(resolve));
        c.oauth.unregisterOAuthProvider('e2e-auth-owner');
        delete (globalThis as any).__oauthOwnerControl;
      }, flowId);
    }
  });
}
