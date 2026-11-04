import { expect, test } from './fixtures/orkas';


test('refuses a foreign encrypted store through IPC and recovers only the selected owner', async ({ orkas: app }) => {
  await app.electronApp!.evaluate(async ({ app }) => {
    const require = (process as any).mainModule.require;
    await require(`${app.getAppPath()}/test/e2e/fixtures/oauth-owner-main.cjs`)(app.getAppPath());
  });
  try {
    await app.electronApp!.evaluate(({ app }) => {
      const require = (process as any).mainModule.require;
      const paths = require(`${app.getAppPath()}/src/main/paths`);
      const path = require('node:path');
      const c = (globalThis as any).__oauthOwnerControl;
      c.accountFile = path.join(paths.userLocalConfigDir(c.owner), 'account.json');
      c.accountBefore = c.fs.existsSync(c.accountFile) ? c.fs.readFileSync(c.accountFile) : null;
      // Fault injection is limited to this fixture's disposable owner root.
      c.fs.writeFileSync(c.accountFile, JSON.stringify({ user_id: c.other }));
      c.fs.writeFileSync(c.files[0], c.before[1]);
    });
    const refused = await app.invoke<any>('auth.listProviders');
    expect(refused.providers.flatMap((provider: any) => provider.profiles)).toEqual([]);
    expect(await app.electronApp!.evaluate(() => {
      const c = (globalThis as any).__oauthOwnerControl;
      return {
        unchanged: c.files.every((file: string) => c.fs.readFileSync(file).equals(c.before[1])),
        metadataStillConflicting: JSON.parse(c.fs.readFileSync(c.accountFile, 'utf8')).user_id === c.other,
      };
    })).toEqual({ unchanged: true, metadataStillConflicting: true });

    await app.electronApp!.evaluate(() => {
      const c = (globalThis as any).__oauthOwnerControl;
      if (c.accountBefore) c.fs.writeFileSync(c.accountFile, c.accountBefore);
      else c.fs.rmSync(c.accountFile, { force: true });
      c.fs.writeFileSync(c.files[0], c.before[0]);
    });
    const recovered = await app.invoke<any>('auth.listProviders');
    expect(recovered.providers.find((provider: any) => provider.id === 'openai')?.profiles)
      .toHaveLength(1);
    expect(await app.electronApp!.evaluate(() => {
      const c = (globalThis as any).__oauthOwnerControl;
      return c.files.map((file: string, index: number) => c.fs.readFileSync(file).equals(c.before[index]));
    })).toEqual([true, true]);
  } finally {
    await app.electronApp!.evaluate(() => {
      const c = (globalThis as any).__oauthOwnerControl;
      if (c.accountBefore) c.fs.writeFileSync(c.accountFile, c.accountBefore);
      else c.fs.rmSync(c.accountFile, { force: true });
      c.fs.writeFileSync(c.files[0], c.before[0]);
      c.users.activateUser(c.owner);
      c.oauth.unregisterOAuthProvider('e2e-auth-owner');
      c.release();
      delete (globalThis as any).__oauthOwnerControl;
    });
  }
});

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
