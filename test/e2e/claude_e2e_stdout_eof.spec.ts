import fs from 'node:fs';
import path from 'node:path';
import { expect, OrkasTestApp, test } from './fixtures/orkas';

test('preserves the final Claude result at EOF through persistence, relaunch and resume', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const app = new OrkasTestApp(testInfo, { cliStub: true, modelStub: true, marketplaceStub: true });
  const launcher = app.fakeClaudePath;
  if (!launcher) throw new Error('Missing native CLI fixture');
  const script = path.join(path.dirname(launcher), 'claude-e2e.js');
  const original = fs.readFileSync(script, 'utf8');
  const send = "const send = value => process.stdout.write(JSON.stringify(value) + '\\n');";
  if (!original.includes(send)) throw new Error('Native fixture output seam changed');
  // The independent child producer writes an actual final record without LF.
  // It keeps the production adapter, bridge, bus, history and renderer intact.
  fs.writeFileSync(script, original.replace(send, "let ending = false;\nconst send = value => {\n  if (ending) return;\n  if (value.type === 'result') {\n    ending = true;\n    process.stdout.end(JSON.stringify(value), () => process.exit(0));\n  } else process.stdout.write(JSON.stringify(value) + '\\n');\n};"));
  try {
    await app.launch();
    const created = await app.invoke<any>('agents.create', {
      name: 'claudeEofFixture', description: 'Deterministic final stream record', category: 'general',
      runtime: { kind: 'cli', cli: 'claude' },
    });
    const agentId = created.agent.agent_id;
    let page = app.page!;
    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill('@claudeEofFixture Complete the local fixture.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    const cid = await page.locator('#conversation-list .conv-item').first().getAttribute('data-cid');
    if (!cid) throw new Error('Missing conversation');
    const stored = async () => (await app.invoke<any>('conversations.history', { cid })).history
      .filter((row: any) => row.from === agentId).map((row: any) => row.text);
    await expect.poll(stored, { timeout: 30_000 }).toEqual(['E2E_CLAUDE_MODEL_RESOLVED']);
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect(page.locator('#chat-history .bubble-retry-btn')).toHaveCount(0);
    page = await app.relaunch();
    await page.locator('#conversation-list .conv-item[data-cid="' + cid + '"]').click();
    await expect(page.locator('#chat-history .chat-message.assistant')).toContainText('E2E_CLAUDE_MODEL_RESOLVED');
    await page.locator('#chat-input').fill('@claudeEofFixture Continue the local fixture.');
    await page.locator('#chat-input').press('Enter');
    await expect.poll(stored, { timeout: 30_000 }).toEqual(['E2E_CLAUDE_MODEL_RESOLVED', 'E2E_CLAUDE_MODEL_RESOLVED']);
    const runs = app.readCliState().invocations.filter(run => run.cli === 'claude');
    expect(runs).toHaveLength(2);
    expect(runs[1].resumeSessionId).toBe(runs[0].sessionId);
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect(page.locator('#chat-history .bubble-retry-btn')).toHaveCount(0);
  } finally { await app.dispose(); }
});
