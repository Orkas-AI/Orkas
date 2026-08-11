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
  test('hands a model-started secret prompt to the user exactly once and redacts echoed input', async ({
    modelOrkas,
  }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
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
    await input.fill('secret-code-42');

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
    expect(modelOrkas.modelRequests).toHaveLength(1);
    expect(JSON.stringify(modelOrkas.modelRequests[0])).toContain('interactive_cli_start');
  });
});
