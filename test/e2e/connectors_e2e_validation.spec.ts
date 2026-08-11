import { readFileSync } from 'node:fs';

import { expect, test } from './fixtures/orkas';

test.describe('connectors', () => {
  test('connects to a real local MCP server, calls a tool from chat, toggles it, and disconnects', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
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

    modelOrkas.setConnectorToolScenario(instance.id);
    await page.locator('#new-chat-input').type('Call the deterministic echo connector.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E connector tool round trip completed.',
    })).toBeVisible({ timeout: 20_000 });
    expect(modelOrkas.modelRequests).toHaveLength(3);
    expect(JSON.stringify(modelOrkas.modelRequests[0])).toContain('list_connector_tools');
    expect(JSON.parse(readFileSync(callStatePath, 'utf8'))).toEqual([{
      name: 'e2e_echo',
      arguments: { text: 'roundtrip' },
    }]);

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
    // Rich-steer turns retain stable connector schemas so a connector can be
    // enabled by a later active-turn message. Visibility is resolved live at
    // execution time; the disabled instance must still stay out of the prompt.
    expect(disabledToolNames).toContain('list_connector_tools');
    expect(disabledToolNames).toContain('call_connector_tool');
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
