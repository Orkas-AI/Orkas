import path from 'node:path';
import { expect, test } from './fixtures/orkas';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

function interactiveCommand(): string {
  const script = [
    "process.stdout.write('Enter password: ');",
    "let input = '';",
    'let settle = null;',
    "process.stdin.on('data', chunk => {",
    '  input += chunk.toString();',
    '  if (settle) clearTimeout(settle);',
    '  settle = setTimeout(() => {',
    "    const lines = input.split(/\\r?\\n/).filter(Boolean);",
    "    process.stdout.write('\\nreceived-lines:' + lines.length + ';echo:' + lines.join('|'));",
    '    process.exit(0);',
    '  }, 150);',
    '});',
  ].join('');
  if (process.platform === 'win32') {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    return `& ${quote(TEST_NODE)} -e ${quote(script)}`;
  }
  return `${JSON.stringify(TEST_NODE)} -e ${JSON.stringify(script)}`;
}

test.describe('interactive CLI lifecycle', () => {
  test('keeps a model-started prompt in its task across navigation, submits once and redacts input', async ({
    modelOrkas,
  }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const other = await modelOrkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', {
      title: 'Unrelated E2E task',
    });
    await page.evaluate(async () => (window as any).loadConversations());
    modelOrkas.setInteractiveCliScenario(
      interactiveCommand(),
      'Authorize deterministic E2E CLI',
    );

    await page.locator('#new-chat-input').fill('Start the deterministic interactive CLI.');
    await page.locator('#new-chat-send-btn').click();

    const card = page.locator('.interactive-cli-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('[data-icl-title]')).toHaveText(
      'Authorize deterministic E2E CLI',
    );
    await expect(card.locator('[data-icl-output]')).toContainText('Enter password:');
    const sensitive = card.locator('[data-icl-sensitive]');
    const input = card.locator('[data-icl-input]');
    await expect(sensitive).toBeChecked();
    await expect(input).toHaveAttribute('type', 'password');
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect(page.locator('#chat-history .chat-message.assistant[data-failure-kind]')).toHaveCount(0);
    await input.fill('secret-code-42');

    const cid = await page.locator('#conversation-list .conv-item.active').getAttribute('data-cid');
    expect(cid).toBeTruthy();
    await page.locator('#new-chat-btn').click();
    await expect(card).toHaveCount(0);
    await page.locator(`#conversation-list .conv-item[data-cid="${other.conversation.conversation_id}"]`).click();
    await expect(page.locator('#chat-header-title')).toHaveText('Unrelated E2E task');
    await expect(card).toHaveCount(0);
    const waiting = await modelOrkas.invoke<{ sessions: Array<{ status: string }> }>('interactiveCli.list');
    expect(waiting.sessions).toHaveLength(1);
    expect(waiting.sessions[0].status).toBe('running');
    await page.locator(`#conversation-list .conv-item[data-cid="${cid}"]`).click();
    await expect(card).toBeVisible();
    await expect(input).toHaveValue('secret-code-42');
    await expect(input).toHaveAttribute('type', 'password');

    await card.locator('[data-icl-form]').evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await expect(card.locator('[data-icl-output]')).toContainText(
      'received-lines:1',
      { timeout: 10_000 },
    );
    await expect(card.locator('[data-icl-output]')).toContainText('[redacted]');
    await expect(card).not.toContainText('secret-code-42');
    await expect(card.locator('[data-icl-status]')).toHaveAttribute('data-status', 'exited');

    const sessions = await modelOrkas.invoke<{
      sessions: Array<{ status: string; output: string }>;
    }>('interactiveCli.list');
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0].status).toBe('exited');
    expect(sessions.sessions[0].output).toContain('received-lines:1');
    expect(sessions.sessions[0].output).toContain('[redacted]');
    expect(sessions.sessions[0].output).not.toContain('secret-code-42');
    // The user-input boundary ends inference mechanically without a synthesis.
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    expect(modelOrkas.modelRequests).toHaveLength(2);
    const interactiveTool = expect.objectContaining({
      function: expect.objectContaining({ name: 'interactive_cli' }),
    });
    // The dormant-tool directory may name this capability before loading it;
    // only the request's SDK definitions determine whether it is exposed.
    expect(modelOrkas.modelRequests[0].tools).not.toEqual(expect.arrayContaining([interactiveTool]));
    expect(modelOrkas.modelRequests[1].tools).toEqual(expect.arrayContaining([interactiveTool]));
    expect(JSON.stringify(modelOrkas.modelRequests)).not.toContain('secret-code-42');
  });

  test('reveals pending prompts and late failures only when their owning task opens', async ({ connectorOrkas: orkas }) => {
    const page = orkas.page!;
    const cids: string[] = [];
    for (const title of ['Scoped CLI task A', 'Scoped CLI task B']) {
      const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title });
      cids.push(created.conversation.conversation_id);
    }
    await page.evaluate(async () => (window as any).loadConversations());
    // The child boundary supplies prompts and a later failure; real host scope,
    // push delivery, navigation, UI state and stop handling remain in use.
    const ids = await orkas.electronApp!.evaluate((_electron, input) => {
      const sessions = (process as any).mainModule.require(input.modulePath);
      return input.cids.map((cid, index) => sessions.startInteractiveCliSession({
        uid: 'account-e2e', cid, presentation: 'agent_terminal', purpose: `Scoped command ${index + 1}`,
        command: process.execPath,
        args: ['-e', "process.stdout.write('Enter password: '); process.stdin.once('data', () => { process.stderr.write('scope-fixture-failure'); process.exit(2); });"],
        cwd: input.cwd, sandboxEnv: { ELECTRON_RUN_AS_NODE: '1' },
      }).session_id) as string[];
    }, {
      cids, modulePath: path.resolve(__dirname, '../../src/main/model/core-agent/interactive-cli-sessions.ts'), cwd: orkas.workspaceRoot,
    });
    for (const sessionId of ids) {
      await expect.poll(async () => {
        const result = await orkas.invoke<{ session: { prompt_kind: string } }>('interactiveCli.read', { session_id: sessionId });
        return result.session.prompt_kind;
      }).toBe('secret');
    }
    const card = page.locator('.interactive-cli-card');
    expect(await card.count()).toBe(0);
    await page.locator(`#conversation-list .conv-item[data-cid="${cids[0]}"]`).click();
    await expect(card).toHaveCount(1);
    await expect(card.locator('[data-icl-title]')).toHaveText('Scoped command 1');
    await page.locator(`#conversation-list .conv-item[data-cid="${cids[1]}"]`).click();
    await expect(card).toHaveCount(1);
    await expect(card.locator('[data-icl-title]')).toHaveText('Scoped command 2');
    await card.locator('[data-icl-input]').fill('pending-draft');
    await orkas.invoke('interactiveCli.send', { session_id: ids[0], input: 'finish-fixture' });
    await expect.poll(async () => {
      const result = await orkas.invoke<{ session: { status: string } }>('interactiveCli.read', { session_id: ids[0] });
      return result.session.status;
    }).toBe('error');
    expect(await card.count()).toBe(1);
    await expect(card.locator('[data-icl-title]')).toHaveText('Scoped command 2');
    await expect(card).not.toContainText('scope-fixture-failure');
    await expect(card.locator('[data-icl-input]')).toHaveValue('pending-draft');
    await page.locator(`#conversation-list .conv-item[data-cid="${cids[0]}"]`).click();
    await expect(card).toHaveCount(1);
    await expect(card.locator('[data-icl-status]')).toHaveAttribute('data-status', 'error');
    await expect(card.locator('[data-icl-output]')).toContainText('scope-fixture-failure');
    await page.locator('#new-chat-btn').click();
    expect(await card.count()).toBe(0);
    await page.locator(`#conversation-list .conv-item[data-cid="${cids[1]}"]`).click();
    await expect(card.locator('[data-icl-input]')).toHaveValue('pending-draft');
    await card.locator('[data-icl-stop]').click();
    await expect(card.locator('[data-icl-status]')).toHaveAttribute('data-status', 'closed');
  });
});
