import path from 'node:path';
import { expect, test, type OrkasTestApp } from './fixtures/orkas';

const AUTH_URL = 'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=DING-42';

async function startDeviceAuthorization(app: OrkasTestApp, failOpen: boolean, authUrl = AUTH_URL) {
  if (!app.electronApp) throw new Error('Orkas main process is unavailable');
  return app.electronApp.evaluate(({ shell }, input) => {
    const root = globalThis as any;
    root.__cliAuthOpened = [];
    shell.openExternal = async (url: string) => {
      root.__cliAuthOpened.push(url);
      if (input.failOpen && root.__cliAuthOpened.length === 1) throw new Error('fixture browser unavailable');
    };
    const sessions = (process as any).mainModule.require(input.modulePath);
    // Provider-shaped output is split before the complete link. No external service or account
    // is used; the real child, push channel, renderer, IPC URL policy and cancel path all run.
    const script = [
      "process.stderr.write('Please enter the authorization code in your browser:\\n');",
      `setTimeout(() => process.stderr.write(${JSON.stringify(`https://login.dingtalk.com/oauth2/device/verify.htm\n${input.url}\n`)}), 100);`,
      "setInterval(() => process.stderr.write('Waiting for user authorization...\\n'), 150);",
      "process.stdin.once('data', () => { process.stderr.write('fixture private provider diagnostic\\n'); process.exit(1); });",
    ].join('');
    return sessions.startInteractiveCliSession({
      uid: 'account-e2e', purpose: 'Connect DingTalk', presentation: 'browser_auth',
      command: process.execPath, args: ['-e', script], cwd: input.cwd,
      sandboxEnv: { ELECTRON_RUN_AS_NODE: '1' },
    }).session_id as string;
  }, {
    modulePath: path.resolve(__dirname, '../../src/main/model/core-agent/interactive-cli-sessions.ts'),
    cwd: app.workspaceRoot, url: authUrl, failOpen,
  });
}

test('DingTalk browser authorization stays silent through prompts and repeated polling', async ({ connectorOrkas: orkas }) => {
  const appPage = orkas.page!;
  const sessionId = await startDeviceAuthorization(orkas, false);
  await expect.poll(() => orkas.electronApp!.evaluate(() => (globalThis as any).__cliAuthOpened)).toEqual([AUTH_URL]);
  await expect.poll(async () => {
    const result = await orkas.invoke<{ session: { output: string } }>('interactiveCli.read', { session_id: sessionId });
    return result.session.output.split('Waiting for user authorization...').length;
  }).toBeGreaterThan(2);
  await expect(appPage.locator('.interactive-cli-card')).toHaveCount(0);
  expect(await orkas.electronApp!.evaluate(() => (globalThis as any).__cliAuthOpened)).toEqual([AUTH_URL]);
  await orkas.invoke('interactiveCli.close', { session_id: sessionId });
  await expect(appPage.locator('.interactive-cli-card')).toHaveCount(0);
});

test('WeCom scan authorization opens the official QR page once without terminal output', async ({ connectorOrkas: orkas }) => {
  const url = 'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=WECOM-42';
  const sessionId = await startDeviceAuthorization(orkas, false, url);
  await expect.poll(() => orkas.electronApp!.evaluate(() => (globalThis as any).__cliAuthOpened)).toEqual([url]);
  await expect.poll(async () => {
    const result = await orkas.invoke<{ session: { output: string } }>('interactiveCli.read', { session_id: sessionId });
    return result.session.output.split('Waiting for user authorization...').length;
  }).toBeGreaterThan(2);
  await expect(orkas.page!.locator('.interactive-cli-card')).toHaveCount(0);
  await orkas.invoke('interactiveCli.close', { session_id: sessionId });
});

test('unclassified or taskless background sessions cannot reveal terminal UI through prompts or failure', async ({ connectorOrkas: orkas }) => {
  const ids = await orkas.electronApp!.evaluate((_electron, input) => {
    const sessions = (process as any).mainModule.require(input.modulePath);
    return [undefined, 'unknown', 'agent_terminal'].map((presentation) => sessions.startInteractiveCliSession({
      uid: 'account-e2e', agentId: 'claimed-agent', purpose: 'Agent command', presentation,
      command: process.execPath,
      args: ['-e', "process.stdout.write('Enter password: '); process.stdin.once('data', () => process.exit(1));"],
      cwd: input.cwd, sandboxEnv: { ELECTRON_RUN_AS_NODE: '1' },
    }).session_id) as string[];
  }, {
    modulePath: path.resolve(__dirname, '../../src/main/model/core-agent/interactive-cli-sessions.ts'), cwd: orkas.workspaceRoot,
  });
  for (const sessionId of ids) {
    await expect.poll(async () => {
      const result = await orkas.invoke<{ session: { prompt_kind: string } }>('interactiveCli.read', { session_id: sessionId });
      return result.session.prompt_kind;
    }).toBe('secret');
    await expect(orkas.page!.locator('.interactive-cli-card')).toHaveCount(0);
    await orkas.invoke('interactiveCli.send', { session_id: sessionId, input: 'finish-fixture' });
    await expect.poll(async () => {
      const result = await orkas.invoke<{ session: { status: string } }>('interactiveCli.read', { session_id: sessionId });
      return result.session.status;
    }).toBe('error');
    await expect(orkas.page!.locator('.interactive-cli-card')).toHaveCount(0);
  }
});

test('connector setup collects client ID and pages organisation choices without exposing the CLI transcript', async ({ connectorOrkas: orkas }, testInfo) => {
  const sessionId = await orkas.electronApp!.evaluate((_electron, input) => {
    const sessions = (process as any).mainModule.require(input.modulePath);
    const script = [
      "process.stdout.write('provider private diagnostic\\n? Xero Client ID: ');",
      "process.stdin.once('data', value => {",
      "if (value.toString().trim() !== 'public-client-id') process.exit(2);",
      "process.stdout.write('\\n? Select a Xero organisation: (Use arrow keys)\\n❯ First company\\n  Second company');",
      "process.stdin.once('data', navigation => {",
      "if (navigation.toString() !== '\\x1b[B') process.exit(3);",
      "process.stdout.write('\\x1b[2K\\x1b[G? Select a Xero organisation:\\n❯ Second company\\n  Third company');",
      "process.stdin.once('data', selected => { process.stdout.write(selected.toString() === '\\x1b[B\\r' ? '\\nselected-third-company' : '\\nwrong-selection'); process.exit(0); });",
      "});",
      "});",
    ].join('');
    return sessions.startInteractiveCliSession({
      uid: 'account-e2e', purpose: 'Connect Xero', presentation: 'connector_input',
      command: process.execPath, args: ['-e', script], cwd: input.cwd,
      sandboxEnv: { ELECTRON_RUN_AS_NODE: '1' },
    }).session_id as string;
  }, {
    modulePath: path.resolve(__dirname, '../../src/main/model/core-agent/interactive-cli-sessions.ts'), cwd: orkas.workspaceRoot,
  });
  const card = orkas.page!.locator('.interactive-cli-card');
  await expect(card.locator('[data-icl-setup-prompt]')).toHaveText('Xero Client ID:');
  await expect(card.locator('pre, [data-icl-output], [data-icl-sensitive]')).toHaveCount(0);
  await expect(card).not.toContainText('provider private diagnostic');
  await card.locator('[data-icl-input]').fill('public-client-id');
  await card.locator('[data-icl-send]').click();
  const choices = card.locator('[data-icl-setup-choices]');
  await expect(choices).toBeVisible();
  await expect(choices.locator('option')).toHaveText(['First company', 'Second company']);
  await card.locator('[data-icl-choice-next]').click();
  await expect(choices.locator('option')).toHaveText(['Second company', 'Third company']);
  await testInfo.attach('connector-setup-form', { body: await card.screenshot(), contentType: 'image/png' });
  await choices.selectOption({ label: 'Third company' });
  await card.locator('[data-icl-send]').click();
  await expect(card.locator('[data-icl-status]')).toHaveText('Completed');
  const result = await orkas.invoke<{ session: { output: string } }>('interactiveCli.read', { session_id: sessionId });
  expect(result.session.output).toContain('selected-third-company');
  await expect(card).not.toContainText('selected-third-company');
});

test('failed browser opening offers one retry link and cancellation without terminal controls', async ({ connectorOrkas: orkas }, testInfo) => {
  const appPage = orkas.page!;
  const sessionId = await startDeviceAuthorization(orkas, true);
  const card = appPage.locator('.interactive-cli-card');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-icl-browser-hint]')).toContainText('Complete authorization in your browser');
  await expect(card.locator('pre, input, form, [data-icl-prompt]')).toHaveCount(0);
  await expect(card).not.toContainText('Waiting for user authorization');
  await expect(card.locator('[data-icl-links] button')).toHaveCount(1);
  await testInfo.attach('browser-authorization-fallback', { body: await card.screenshot(), contentType: 'image/png' });
  await card.locator('[data-icl-links] button').click();
  await expect.poll(() => orkas.electronApp!.evaluate(() => (globalThis as any).__cliAuthOpened)).toEqual([AUTH_URL, AUTH_URL]);
  await card.locator('[data-icl-stop]').click();
  await expect(card.locator('[data-icl-status]')).toHaveText('Closed');
  await expect(card.locator('[data-icl-links] button')).toHaveCount(0);
  const result = await orkas.invoke<{ session: { status: string } }>('interactiveCli.read', { session_id: sessionId });
  expect(result.session.status).toBe('closed');
});

test('authorization failure removes an existing browser retry panel', async ({ connectorOrkas: orkas }) => {
  const appPage = orkas.page!;
  const sessionId = await startDeviceAuthorization(orkas, true);
  await expect.poll(() => orkas.electronApp!.evaluate(() => (globalThis as any).__cliAuthOpened)).toEqual([AUTH_URL]);
  const card = appPage.locator('.interactive-cli-card');
  await expect(card).toBeVisible();
  await orkas.invoke('interactiveCli.send', { session_id: sessionId, input: 'finish-fixture' });
  await expect.poll(async () => {
    const result = await orkas.invoke<{ session: { status: string } }>('interactiveCli.read', { session_id: sessionId });
    return result.session.status;
  }).toBe('error');
  // A stale failure card used to disappear after seven seconds; that is still a visible bug.
  await expect(card).toHaveCount(0, { timeout: 1500 });
});

for (const scenario of [
  { id: 'dingtalk', format: 'json', reason: '该组织尚未开启 CLI 数据访问权限，请联系管理员开启' },
  { id: 'wecom', format: 'text', reason: 'Workspace policy version 47 requires a new administrator review.' },
]) {
test(`${scenario.id} ${scenario.format} failure reaches the connection alert without credential echo`, async ({ connectorOrkas: orkas }, testInfo) => {
  // Replace only the provider subprocess. The real helper (including its exit handling),
  // Connect click, install check, session, manager event and error dialog all execute.
  await orkas.electronApp!.evaluate((_electron, input) => {
    const req = (process as any).mainModule.require;
    const fs = req('node:fs');
    const path = req('node:path');
    const cp = req('node:child_process');
    const cli = req(path.join(input.pc, 'src/main/features/connectors/local-cli.ts'));
    const catalog = req(path.join(input.pc, 'src/main/features/connectors/catalog.ts'));
    const entry = catalog.findCatalogEntry(input.id);
    const config = entry.local_cli;
    const runtime = cli.localCliRuntimeDir('account-e2e', input.id);
    const packageDir = path.join(runtime, 'npm-cache/_npx/fixture/node_modules', ...config.package_name.split('/'));
    fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'bin', `${config.executable}.js`), '// Provider fixture');
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: config.package_name, version: config.package_version,
      bin: { [config.executable]: `bin/${config.executable}.js` },
    }));
    fs.writeFileSync(path.join(runtime, '.orkas-cli-integrity.json'), JSON.stringify({
      package: `${config.package_name}@${config.package_version}`, integrity: config.package_integrity,
    }));
    const output = input.format === 'text'
      ? `${input.reason}; access_token=fixture-secret-canary`
      : JSON.stringify({ error: {
      category: 'auth', code: 2,
      message: `device authorization failed: ${input.reason}; access_token=fixture-secret-canary`,
      details: { private: 'fixture-private-envelope' },
    } }, null, 2);
    const stream = input.format === 'text' ? 'stdout' : 'stderr';
    const script = `process.stderr.write('Consent completed\\n');
      setTimeout(() => process.${stream}.write(${JSON.stringify(output.slice(0, 50))}), 30);
      setTimeout(() => { process.${stream}.write(${JSON.stringify(output.slice(50) + '\n')}); process.exitCode = 2; }, 80);`;
    const hook = path.join(runtime, 'work/provider-fixture.cjs');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `
      const cp = require('node:child_process');
      const spawn = cp.spawn;
      const spawnSync = cp.spawnSync;
      cp.spawn = (command, args, options) => args[0] === process.env.ORKAS_LOCAL_CLI_NPX_CLI
        ? spawn(command, ['-e', ${JSON.stringify(script)}], options) : spawn(command, args, options);
      cp.spawnSync = (command, args, options) => args[0] === process.env.ORKAS_LOCAL_CLI_NPX_CLI
        ? { status: 0, stdout: '{}', stderr: '' } : spawnSync(command, args, options);
    `);
    const original = cp.spawn;
    cp.spawn = (command: string, args: string[], options: unknown) => {
      if (args?.[0] === path.join(input.pc, 'bin/local-cli-auth.cjs')) {
        return original(command, ['--require', hook, ...args], options);
      }
      return original(command, args, options);
    };
    (globalThis as any).__restoreAuthorizationSpawn = () => { cp.spawn = original; };
  }, { pc: path.resolve(__dirname, '../..'), ...scenario });
  try {
    const page = orkas.page!;
    await page.evaluate(async () => { await (window as any).setLang('zh'); });
    await page.locator('#connectors-btn').click();
    await page.locator('#connectors-search-input').fill(scenario.id);
    const card = page.locator(`.connector-card[data-id="${scenario.id}"]`);
    await card.locator('[data-act="connect"]').click();
    const alert = page.getByRole('alertdialog');
    await expect(alert).toContainText('授权失败：');
    await expect(alert).toContainText(scenario.reason);
    await expect(alert).not.toContainText('fixture-secret-canary');
    await expect(alert).not.toContainText('fixture-private-envelope');
    await expect(alert).not.toContainText('[Orkas]');
    await expect(alert).not.toContainText('请重新连接，并在官方页面完成登录和授权');
    // The result dialog is already visible, so a duplicate panel must be absent now.
    expect(await page.locator('.interactive-cli-card').count()).toBe(0);
    const result = await orkas.invoke<{ instances: Array<{ id: string }> }>('connectors.list', {});
    expect(result.instances.some(instance => instance.id === scenario.id)).toBe(false);
    await testInfo.attach('specific-authorization-error', { body: await alert.screenshot(), contentType: 'image/png' });
    await alert.getByRole('button', { name: '确认', exact: true }).click();
    await expect(alert).toHaveCount(0);
  } finally {
    await orkas.electronApp!.evaluate(() => { (globalThis as any).__restoreAuthorizationSpawn?.(); });
  }
});
}
