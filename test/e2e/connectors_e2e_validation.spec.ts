import { readFileSync, writeFileSync } from 'node:fs';

import { expect, test } from './fixtures/orkas';

test.describe('connectors', () => {
  test('browses available connectors by category with localized chips and a narrow layout', async ({ connectorOrkas }, testInfo) => {
    // A local catalog fixture keeps this browse journey independent of network recovery.
    const appPage = connectorOrkas.page!;
    await appPage.locator('#connectors-btn').click();
    const categories = appPage.locator('#connectors-categories');
    const available = appPage.locator('#connectors-grid-available');
    await expect(categories.locator('[data-connectors-cat="rnd"]')).toBeVisible();
    expect(await categories.locator('button').evaluateAll((buttons) => buttons.slice(0, 3).map((button) => button.getAttribute('data-connectors-cat'))))
      .toEqual(['', 'ecommerce', 'office']);
    await categories.locator('[data-connectors-cat="general"]').click();
    for (const id of ['stripe', 'paypal', 'gmail', 'gdrive', 'dropbox', 'typeform', 'exist']) {
      await expect(available.locator(`[data-id="${id}"]`)).toHaveCount(1);
    }
    // Standalone Gmail and Drive use Composio; the legacy Google bundle remains disabled.
    await expect(available.locator('[data-id="google-workspace"]')).toHaveCount(0);
    await expect(available.locator('[data-id="shopify-admin"]')).toHaveCount(0);
    await categories.locator('[data-connectors-cat="office"]').click();
    for (const id of ['feishu', 'asana', 'fathom', 'miro', 'zoom']) {
      await expect(available.locator(`[data-id="${id}"]`)).toHaveCount(1);
    }
    await expect(available.locator('[data-id="gsheets"]')).toHaveCount(0);
    await expect(available.locator('[data-id="stripe"]')).toHaveCount(0);
    await categories.locator('[data-connectors-cat="rnd"]').click();
    await expect(available.locator('[data-id="github"]')).toBeVisible();
    await expect(available.locator('[data-id="linear"]')).toBeVisible();
    await expect(available.locator('[data-id="figma"]')).toHaveCount(1);
    await expect(available.locator('[data-id="wakatime"]')).toHaveCount(1);
    await expect(available.locator('[data-id="notion"]')).toHaveCount(0);
    await categories.locator('[data-connectors-cat="data"]').click();
    await expect(available.locator('[data-id="google-bigquery"]')).toHaveCount(1);
    await expect(available.locator('[data-id="wakatime"]')).toHaveCount(0);
    await expect(available.locator('[data-id="exist"]')).toHaveCount(0);
    await categories.locator('[data-connectors-cat="education"]').click();
    await expect(available.locator('.connector-card')).toHaveCount(1);
    await expect(available.locator('[data-id="google-classroom"]')).toBeVisible();
    await categories.locator('[data-connectors-cat="creation"]').click();
    await expect(available.locator('[data-id="webflow"]')).toBeVisible();
    await expect(available.locator('[data-id="canva"]')).toHaveCount(1);
    await expect(available.locator('[data-id="youtube"]')).toHaveCount(1);
    await expect(available.locator('[data-id="github"]')).toHaveCount(0);
    for (const [lang, label] of [['zh', '创作'], ['en', 'Creation'], ['ja', '創作'], ['pt', 'Criação']]) {
      await appPage.evaluate((next) => (window as any).setLang(next), lang);
      await expect(categories.locator('[aria-pressed="true"]')).toHaveText(label);
    }
    await appPage.evaluate(() => (window as any).setLang('zh'));
    await categories.locator('[data-connectors-cat=""]').click();
    // Setup and credit labels remain compact metadata, with the action at the opposite edge.
    // Read the shipped stylesheet through Chromium so missing CSS cannot pass on markup alone.
    const checkCardBadges = async () => {
      for (const variant of ['is-setup', 'is-credit']) {
        const badge = available.locator(`.connector-card-credit-badge.${variant}`).first();
        await expect(badge).toHaveCSS('font-size', '11px');
        await expect(badge).toHaveCSS('border-radius', '6px');
        // Query and measure in the same browser turn; language updates replace cards.
        const layout = await badge.evaluateAll(([element]) => {
          const footer = element.closest('.connector-card-foot')!;
          const action = footer.querySelector('button')!;
          const labelRect = element.getBoundingClientRect();
          const actionRect = action.getBoundingClientRect();
          const footerRect = footer.getBoundingClientRect();
          return {
            leftInset: labelRect.left - footerRect.left,
            gap: actionRect.left - labelRect.right,
            centerDifference: Math.abs((labelRect.top + labelRect.bottom - actionRect.top - actionRect.bottom) / 2),
            actionOverflow: actionRect.right - footerRect.right,
          };
        });
        expect(layout.leftInset).toBeLessThanOrEqual(1);
        expect(layout.gap).toBeGreaterThanOrEqual(7);
        expect(layout.centerDifference).toBeLessThanOrEqual(1);
        expect(layout.actionOverflow).toBeLessThanOrEqual(1);
      }
      await expect(available.locator('.connector-card-credit-badge.is-credit').first())
        .toHaveCSS('background-color', 'rgb(255, 248, 225)');
    };
    for (const lang of ['zh', 'en', 'ja', 'pt']) {
      await appPage.evaluate((next) => (window as any).setLang(next), lang);
      await checkCardBadges();
    }
    await appPage.evaluate(() => (window as any).setLang('zh'));
    await appPage.locator('#panel-connectors').screenshot({ path: testInfo.outputPath('connector-categories-desktop.png') });
    await appPage.setViewportSize({ width: 760, height: 820 });
    await expect(categories.locator('[data-connectors-cat="office"]')).toBeVisible();
    await checkCardBadges();
    expect(await categories.evaluate((host) => [...host.querySelectorAll('button')].every((button) => {
      const rect = button.getBoundingClientRect();
      const bounds = host.getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right;
    }))).toBe(true);
    await categories.screenshot({ path: testInfo.outputPath('connector-categories-narrow.png') });
    await appPage.locator('#connectors-search-input').fill('webflow');
    await expect(categories.locator('button')).toHaveText(['全部', '创作']);
    await expect(available.locator('.connector-card')).toHaveCount(1);
    await appPage.locator('#connectors-search-input').fill('');
    await expect(categories.locator('[data-connectors-cat="office"]')).toBeVisible();
  });

  test('shows all remaining merchant forms in four languages with production-only setup and callback ownership', async ({ appPage, orkas }, testInfo) => {
    const logs: string[] = [];
    const child = orkas.electronApp?.process();
    const stdout = (data: Buffer) => logs.push(`[main:stdout] ${String(data).trimEnd()}`);
    const stderr = (data: Buffer) => logs.push(`[main:stderr] ${String(data).trimEnd()}`);
    const renderer = (message: { type(): string; text(): string }) => logs.push(`[renderer:${message.type()}] ${message.text()}`);
    child?.stdout?.on('data', stdout); child?.stderr?.on('data', stderr); appPage.on('console', renderer);
    try {
      await appPage.locator('#connectors-btn').click();
      for (const [id, inputs, choices, callback] of [
        ['magento', 5, 0, false], ['temu-seller', 3, 1, false], ['lazada-seller', 3, 1, true],
        ['shein-seller', 3, 0, true], ['alibaba-com-seller', 3, 0, true], ['aliexpress-seller', 3, 0, true],
      ] as const) {
        await appPage.locator('#connectors-search-input').fill(id);
        const card = appPage.locator(`.connector-card[data-id="${id}"]`);
        await expect(card).toBeVisible();
        await expect(card.locator('svg')).not.toHaveCount(0);
        await card.screenshot({ path: testInfo.outputPath(`${id}-card.png`) });
        await card.locator('[data-act="connect"]').click();
        const setup = appPage.locator('#connectors-connect-modal');
        await expect(setup).toBeVisible();
        await expect(setup.locator('input')).toHaveCount(inputs);
        await expect(setup.locator('select')).toHaveCount(choices);
        await expect(setup.locator('[data-act="copy-setup-callback"]')).toHaveCount(callback ? 1 : 0);
        await setup.locator('input[type="password"]').first().fill('merchant-ui-private-canary');
        let englishInstructions = '';
        for (const lang of ['en', 'zh', 'ja', 'pt']) {
          await appPage.evaluate(async locale => { await (window as any).setLang(locale); }, lang);
          const instructions = await setup.locator('.connectors-setup-instructions').innerText();
          expect(instructions.trim()).not.toBe('');
          if (lang === 'en') englishInstructions = instructions;
          else expect(instructions).not.toBe(englishInstructions);
          await expect(setup.locator('input[type="password"]').first()).toHaveValue('merchant-ui-private-canary');
          await expect(setup).not.toContainText('connectors.setup.');
          await expect(setup.locator('option[value="sandbox"]')).toHaveCount(0);
          if (callback) await expect(setup.locator('input[readonly]')).toHaveValue('https://orkas.ai/api/connectors/oauth/dcr-callback');
        }
        await appPage.evaluate(async () => { await (window as any).setLang('zh'); });
        await setup.screenshot({ path: testInfo.outputPath(`${id}-setup.png`) });
        expect(await setup.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        // Never submit dummy credentials to a live merchant API.
        await setup.locator('[data-act="cancel"]').click();
        await expect(setup).toHaveCount(0);
      }
    } finally {
      child?.stdout?.off('data', stdout); child?.stderr?.off('data', stderr); appPage.off('console', renderer);
      const logPath = testInfo.outputPath('merchant-runtime.log');
      writeFileSync(logPath, logs.join('\n'), 'utf8');
      await testInfo.attach('merchant-runtime.log', { path: logPath, contentType: 'text/plain' });
    }
    expect(logs.join('\n')).not.toContain('merchant-ui-private-canary');
    expect(logs.filter(line => line.startsWith('[renderer:error]'))).toEqual([]);
  });

  test('shows storefront setup in one localized panel with real icons and no callback or environment selector', async ({ appPage, orkas }, testInfo) => {
    const logs: string[] = [];
    const child = orkas.electronApp?.process();
    const stdout = (data: Buffer) => logs.push(`[main:stdout] ${String(data).trimEnd()}`);
    const stderr = (data: Buffer) => logs.push(`[main:stderr] ${String(data).trimEnd()}`);
    const renderer = (message: { type(): string; text(): string }) => logs.push(`[renderer:${message.type()}] ${message.text()}`);
    child?.stdout?.on('data', stdout);
    child?.stderr?.on('data', stderr);
    appPage.on('console', renderer);
    try {
      await appPage.locator('#connectors-btn').click();
      for (const id of ['bigcommerce', 'shopline', 'shoplazza']) {
        await appPage.locator('#connectors-search-input').fill(id);
        const card = appPage.locator(`.connector-card[data-id="${id}"]`);
        await expect(card).toBeVisible();
        await expect(card.locator('svg')).not.toHaveCount(0);
        await card.locator('[data-act="connect"]').click();
        const setup = appPage.locator('#connectors-connect-modal');
        await expect(setup).toBeVisible();
        await expect(setup.locator('input')).toHaveCount(2);
        await expect(setup.locator('select, input[readonly], [data-act="copy-setup-callback"]')).toHaveCount(0);
        await setup.locator('#connector-setup-field-0').fill(id === 'bigcommerce' ? 'abc123' : 'fixture');
        await setup.locator('#connector-setup-field-1').fill('test-only-store-token');
        for (const [lang, tokenLabel] of [['zh', 'Admin API 访问令牌'], ['ja', 'Admin API アクセストークン'], ['pt', 'Token de acesso da Admin API'], ['en', 'Admin API access token']]) {
          await appPage.evaluate(async locale => { await (window as any).setLang(locale); }, lang);
          await expect(setup.locator('label[for="connector-setup-field-1"]')).toContainText(tokenLabel);
          await expect(setup.locator('#connector-setup-field-1')).toHaveAttribute('type', 'password');
          await expect(setup.locator('#connector-setup-field-1')).toHaveValue('test-only-store-token');
          await expect(setup.locator('.connectors-setup-instructions')).not.toBeEmpty();
          await expect(setup).not.toContainText('connectors.setup.');
        }
        await setup.screenshot({ path: testInfo.outputPath(`${id}-setup.png`) });
        const fits = await setup.evaluate(el => el.scrollWidth <= el.clientWidth + 1);
        expect(fits).toBe(true);
        // Do not submit fixture credentials to real merchant APIs.
        await setup.locator('[data-act="cancel"]').click();
        await expect(setup).toHaveCount(0);
      }
      await appPage.locator('#connectors-search-input').fill('');
    } finally {
      child?.stdout?.off('data', stdout);
      child?.stderr?.off('data', stderr);
      appPage.off('console', renderer);
      const logPath = testInfo.outputPath('storefront-runtime.log');
      writeFileSync(logPath, logs.join('\n'), 'utf8');
      await testInfo.attach('storefront-runtime.log', { path: logPath, contentType: 'text/plain' });
    }
    expect(logs.join('\n')).not.toContain('test-only-store-token');
    expect(logs.filter(line => line.startsWith('[renderer:error]'))).toEqual([]);
  });

  test('switches four locales in open connector forms without losing credentials or selected region', async ({ appPage }) => {
    await appPage.locator('#connectors-btn').click();
    const shopee = appPage.locator('.connector-card[data-id="shopee"]');
    await shopee.locator('[data-act="connect"]').click();
    const setup = appPage.locator('#connectors-connect-modal');
    await expect(setup).toBeVisible();
    await setup.locator('#connector-setup-field-0').selectOption('cn');
    await setup.locator('#connector-setup-field-1').fill('12345');
    await setup.locator('#connector-setup-field-2').fill('987654');
    await setup.locator('#connector-setup-field-3').fill('test-only-secret');
    // Isolate the clipboard boundary; never overwrite the developer's real clipboard.
    await appPage.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { (window as any).__copiedCallback = value; },
    } }));
    await setup.locator('[data-act="copy-setup-callback"]').click();
    expect(await appPage.evaluate(() => (window as any).__copiedCallback)).toBe('https://orkas.ai/api/connectors/oauth/dcr-callback');
    for (const [lang, label, copied] of [['ja', 'ショップ ID', 'コピーしました'], ['pt', 'ID da loja', 'Copiado'], ['zh', '店铺 ID', '已复制'], ['en', 'Shop ID', 'Copied']]) {
      await appPage.evaluate(async locale => { await (window as any).setLang(locale); }, lang);
      await expect(setup.locator('label[for="connector-setup-field-1"]')).toContainText(label);
      await expect(setup.locator('[data-act="callback-copy-status"]')).toHaveText(copied);
      await expect(setup.locator('#connector-setup-field-0')).toHaveValue('cn');
      await expect(setup.locator('#connector-setup-field-1')).toHaveValue('12345');
      await expect(setup.locator('#connector-setup-field-2')).toHaveValue('987654');
      await expect(setup.locator('#connector-setup-field-3')).toHaveValue('test-only-secret');
      await expect(setup.locator('#connector-setup-field-3')).toHaveAttribute('type', 'password');
      await expect(setup.locator('input[readonly]')).toHaveValue('https://orkas.ai/api/connectors/oauth/dcr-callback');
      await expect(setup).not.toContainText('connectors.setup.');
    }
    await setup.locator('[data-act="cancel"]').click();
    await expect(setup).toHaveCount(0);
    await appPage.locator('#connectors-add-custom-btn').click();
    const custom = appPage.locator('.connector-custom-dialog');
    await custom.locator('[data-f="name"]').fill('我的 MCP');
    await custom.locator('[data-f="kind"]').selectOption('stdio');
    await custom.locator('[data-f="command"]').fill('node');
    await custom.locator('[data-f="env"]').fill('TEST_SECRET=test-only-secret');
    for (const [lang, nameLabel] of [['ja', '名前'], ['pt', 'Nome'], ['zh', '名称'], ['en', 'Name']]) {
      await appPage.evaluate(async locale => { await (window as any).setLang(locale); }, lang);
      await expect(custom.locator('.form-row').first().locator('label')).toHaveText(nameLabel);
      await expect(custom.locator('[data-f="name"]')).toHaveValue('我的 MCP');
      await expect(custom.locator('[data-f="kind"]')).toHaveValue('stdio');
      await expect(custom.locator('[data-f="command"]')).toHaveValue('node');
      await expect(custom.locator('[data-f="env"]')).toHaveValue('TEST_SECRET=test-only-secret');
      await expect(custom.locator('[data-sec="stdio"]')).toBeVisible();
      await expect(custom).not.toContainText('connectors.custom.');
    }
    await custom.locator('[data-act="cancel"]').click();
    await expect(custom).toHaveCount(0);
  });

  test('connects to a real local MCP server, approves once, changes operation trust, toggles it, and disconnects', async ({ modelOrkas }, testInfo) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    expect(await modelOrkas.invoke('permissions.setLocalExecMode', { mode: 'all_files_approval' }))
      .toMatchObject({ ok: true, mode: 'all_files_approval' });
    const callStatePath = modelOrkas.createFixtureFile('e2e-mcp-call-state.json', '[]\n');
    const serverPath = modelOrkas.createFixtureFile('e2e-mcp-server.cjs', String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'orkas-e2e-mcp', version: '1.0.0' },
    });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [{
      name: 'e2e_echo',
      description: 'Returns deterministic E2E text.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    }] });
  } else if (msg.method === 'tools/call') {
    let calls = [];
    try { calls = JSON.parse(fs.readFileSync(process.env.E2E_MCP_STATE, 'utf8')); } catch {}
    calls.push({ name: msg.params.name, arguments: msg.params.arguments });
    fs.writeFileSync(process.env.E2E_MCP_STATE, JSON.stringify(calls, null, 2));
    reply(msg.id, { content: [{ type: 'text', text: 'echo:' + String(msg.params.arguments.text || '') }] });
  } else if (msg.method === 'ping') {
    reply(msg.id, {});
  }
});
`);

    await page.locator('#connectors-btn').click();
    await expect(page.locator('#panel-connectors')).toHaveClass(/\bactive\b/);
    await page.locator('#connectors-add-custom-btn').click();
    const dialog = page.locator('.connector-custom-dialog');
    await dialog.locator('[data-f="name"]').fill('E2E Local MCP');
    await dialog.locator('[data-f="kind"]').selectOption('stdio');
    await dialog.locator('[data-f="command"]').fill(process.execPath);
    await dialog.locator('[data-f="args"]').fill(serverPath);
    await dialog.locator('[data-f="env"]').fill([
      'E2E_SECRET=must-not-reach-renderer',
      `E2E_MCP_STATE=${callStatePath}`,
    ].join('\n'));
    await dialog.locator('[data-act="ok"]').click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });

    const listed = await modelOrkas.invoke<{
      instances: Array<{
        id: string;
        display_name: string;
        enabled?: boolean;
        status: { kind: string };
        transport?: { kind: string; summary: string };
        tools_cache: Array<{ name: string }>;
      }>;
    }>('connectors.list');
    const instance = listed.instances.find((item) => item.display_name === 'E2E Local MCP');
    expect(instance).toMatchObject({
      enabled: true,
      status: { kind: 'connected' },
      transport: { kind: 'stdio' },
    });
    expect(instance?.tools_cache.map((tool) => tool.name)).toContain('e2e_echo');
    expect(JSON.stringify(instance)).not.toContain('must-not-reach-renderer');

    const card = page.locator(`.connector-card[data-id="${instance?.id}"]`);
    await expect(card).toContainText('E2E Local MCP');
    await expect(card).not.toHaveClass(/\bis-disabled\b/);

    if (!instance?.id) throw new Error('Connected E2E MCP instance was not returned');
    const startConnectorChat = async () => {
      await page.locator('#new-chat-btn').click();
      await page.locator('#new-chat-recipient-chip').click();
      const picker = page.locator('#agent-picker');
      await picker.locator('[data-agent-picker-tab="connectors"]').click();
      const connectorOption = picker.locator(
        `.skill-picker-item[data-kind="connector"][data-id="${instance.id}"]`,
      );
      await expect(connectorOption).toContainText('E2E Local MCP');
      await connectorOption.click();
      await expect(page.locator('#new-chat-input')).toHaveValue(/Connector: E2E Local MCP/);
    };
    await startConnectorChat();

    modelOrkas.setConnectorToolScenario(instance.id);
    await page.locator('#new-chat-input').type('Call the deterministic echo connector.');
    await page.locator('#new-chat-send-btn').click();
    // Custom tool claims do not grant read-only trust. Complete the account's
    // normal approval flow and prove that the local peer sees no early call.
    const actionConfirmation = page.getByRole('dialog', { name: 'Allow this sensitive action?' });
    await expect(actionConfirmation).toBeVisible();
    await expect(actionConfirmation).toContainText('e2e_echo');
    await expect(actionConfirmation).toContainText('roundtrip');
    expect(JSON.parse(readFileSync(callStatePath, 'utf8'))).toEqual([]);
    await expect(actionConfirmation.getByRole('button', { name: "Don't run", exact: true })).toBeVisible();
    // Like other external mutations, this grant covers one exact operation.
    await expect(actionConfirmation.locator('[data-id="allow_run"]')).toHaveCount(0);
    await actionConfirmation.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(actionConfirmation).toHaveCount(0);
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E connector tool round trip completed.',
    })).toBeVisible({ timeout: 20_000 });
    expect(modelOrkas.modelRequests).toHaveLength(3);
    expect(JSON.stringify(modelOrkas.modelRequests[0])).toContain('list_connector_tools');
    expect(JSON.parse(readFileSync(callStatePath, 'utf8'))).toEqual([{
      name: 'e2e_echo',
      arguments: { text: 'roundtrip' },
    }]);
    // Allow once leaves the account in approval mode. A later action offers the
    // same local permission menu and persists Trusted only on approval.
    expect(await modelOrkas.invoke('permissions.getLocalExec')).toMatchObject({ mode: 'all_files_approval' });
    await startConnectorChat();
    modelOrkas.setConnectorToolScenario(instance.id);
    await page.locator('#new-chat-input').type('Call the echo connector again.');
    await page.locator('#new-chat-send-btn').click();
    await expect(actionConfirmation).toBeVisible();
    expect(JSON.parse(readFileSync(callStatePath, 'utf8'))).toHaveLength(1);
    await actionConfirmation.locator('.bash-permission-mode-trigger').click();
    const modeMenu = page.getByRole('listbox').filter({ has: page.locator('[data-mode="all_files_auto"]') });
    await expect(modeMenu).toBeVisible();
    await expect(modeMenu.getByRole('option')).toHaveCount(3);
    await expect(modeMenu.locator('[data-mode="all_files_approval"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('.ui-dialog-overlay').filter({ has: actionConfirmation }).screenshot({
      path: testInfo.outputPath('connector-operation-permission.png'),
    });
    await modeMenu.locator('[data-mode="all_files_auto"]').click();
    await actionConfirmation.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(actionConfirmation).toHaveCount(0);
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E connector tool round trip completed.',
    })).toBeVisible({ timeout: 20_000 });
    expect(await modelOrkas.invoke('permissions.getLocalExec')).toMatchObject({ mode: 'all_files_auto' });
    expect(JSON.parse(readFileSync(callStatePath, 'utf8'))).toHaveLength(2);

    await startConnectorChat();
    modelOrkas.setConnectorToolScenario(instance.id);
    await page.locator('#new-chat-input').type('Use the echo connector once more.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E connector tool round trip completed.',
    })).toBeVisible({ timeout: 20_000 });
    await expect(actionConfirmation).toHaveCount(0);
    expect(JSON.parse(readFileSync(callStatePath, 'utf8'))).toEqual(Array.from({ length: 3 }, () => ({
      name: 'e2e_echo', arguments: { text: 'roundtrip' },
    })));
    await page.locator('#connectors-btn').click();
    await card.hover();
    await card.locator('.connector-card-menu-btn').click();
    await page.locator('.connector-card-menu-popover [data-act="toggle-enabled"]').click();
    await expect(card).toHaveClass(/\bis-disabled\b/);
    await expect.poll(async () => {
      const result = await modelOrkas.invoke<{ instances: Array<{ id: string; enabled?: boolean }> }>('connectors.list');
      return result.instances.find((item) => item.id === instance?.id)?.enabled;
    }).toBe(false);

    const disabledRequestStart = modelOrkas.modelRequests.length;
    modelOrkas.clearModelToolScenario();
    modelOrkas.setModelTextReplies(['E2E disabled connector stayed unavailable.']);
    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill('Answer without using any connector.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E disabled connector stayed unavailable.',
    })).toBeVisible({ timeout: 20_000 });
    const disabledRequest = modelOrkas.modelRequests[disabledRequestStart];
    expect(disabledRequest).toBeTruthy();
    const disabledRequestPayload = disabledRequest as {
      tools?: Array<{ function?: { name?: string } }>;
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const disabledToolNames = (disabledRequestPayload.tools || [])
      .map((tool) => tool.function?.name)
      .filter(Boolean);
    // A disabled Connector is neither active nor advertised. Commander keeps
    // only the separately reviewed installation surface when no Connector is
    // visible; a later turn can discover list/call after visibility is restored.
    expect(disabledToolNames).not.toContain('list_connector_tools');
    expect(disabledToolNames).not.toContain('call_connector_tool');
    const disabledSystemPrompt = (disabledRequestPayload.messages || [])
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content || ''))
      .join('\n');
    expect(disabledSystemPrompt).not.toContain(`**${instance.id}**`);

    await page.locator('#connectors-btn').click();
    await card.hover();
    await card.locator('.connector-card-menu-btn').click();
    await page.locator('.connector-card-menu-popover [data-act="toggle-enabled"]').click();
    await expect(card).not.toHaveClass(/\bis-disabled\b/);
    await card.hover();
    await card.locator('.connector-card-menu-btn').click();
    await page.locator('.connector-card-menu-popover [data-act="disconnect"]').click();
    await expect(page.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(card).toHaveCount(0);
    const removed = await modelOrkas.invoke<{ instances: Array<{ id: string }> }>('connectors.list');
    expect(removed.instances.some((item) => item.id === instance?.id)).toBe(false);
  });

  test('loads the connector catalog and rejects malformed custom MCP configuration', async ({ appPage }) => {
    await appPage.locator('#connectors-btn').click();
    await expect(appPage.locator('#panel-connectors')).toHaveClass(/\bactive\b/);
    await expect(appPage.locator('#connectors-add-custom-btn')).toBeVisible();
    await expect(
      appPage.locator('#connectors-group-available, #connectors-group-connected, #connectors-empty')
        .filter({ visible: true }),
    ).not.toHaveCount(0);

    await appPage.locator('#connectors-add-custom-btn').click();
    const dialog = appPage.locator('.connector-custom-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-f="name"]').fill('E2E Invalid MCP');
    await dialog.locator('[data-f="kind"]').selectOption('stdio');
    await expect(dialog.locator('[data-sec="stdio"]')).toBeVisible();
    await dialog.locator('[data-f="command"]').fill('node');
    await dialog.locator('[data-f="env"]').fill('MALFORMED_ENV_LINE');
    await dialog.locator('[data-act="ok"]').click();

    const alert = appPage.locator('.ui-dialog-overlay:visible .ui-dialog').last();
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText('connectors.custom.bad_env');
    await alert.locator('[data-act="ok"]').click();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-act="cancel"]').click();
    await expect(dialog).toHaveCount(0);
  });
});
