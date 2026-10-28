import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { killProcessTree } from '../../src/core-agent/src/sandbox/executor';
import { expect, test } from './fixtures/orkas';

test('recovers a running CLI process and elapsed time after a real application kill without replaying the task', async ({ cliOrkas }, info) => {
  test.setTimeout(120_000);
  const name = 'CodexCrashRecovery';
  const { agent } = await cliOrkas.invoke<{ agent: { agent_id: string } }>('agents.create', {
    name, description: 'Deterministic crash recovery', category: 'general', runtime: { kind: 'cli', cli: 'codex' },
  });
  const page = cliOrkas.page!;
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill(`@${name} E2E_CODEX_CRASH_PROCESS`);
  await page.locator('#new-chat-send-btn').click();
  await expect.poll(() => cliOrkas.readCliState().invocations.length, { timeout: 30_000 }).toBe(1);
  const cid = await page.evaluate<string>('currentCid');
  const account = path.join(cliOrkas.workspaceRoot, 'account-e2e');
  const historyFile = path.join(account, 'cloud', 'chats', `${cid}.jsonl`);
  const stateFile = path.join(account, 'cloud', 'chats', cid, 'state.json');
  const runs = path.join(account, 'local', 'file_cache', 'local-agent-runs');
  let run = '';
  await expect.poll(() => {
    for (const entry of readdirSync(runs)) {
      const directory = path.join(runs, entry);
      const meta = JSON.parse(readFileSync(path.join(directory, 'meta.json'), 'utf8'));
      if (meta.cid === cid && meta.agentId === agent.agent_id) {
        run = directory;
        return readFileSync(path.join(directory, 'events.jsonl'), 'utf8').includes('DURABLE_CRASH_RECEIPT');
      }
    }
    return false;
  }).toBe(true);
  const durable = JSON.parse(readFileSync(stateFile, 'utf8'));
  expect(durable.in_flight).toContain(agent.agent_id);
  expect(durable.in_flight_turns[agent.agent_id]).toMatchObject({ turn_id: expect.any(String), source_message_id: expect.any(String) });
  const meta = JSON.parse(readFileSync(path.join(run, 'meta.json'), 'utf8'));
  expect(meta.endedAt).toBeUndefined();
  const crashedApp = cliOrkas.electronApp!;
  await cliOrkas.prepareForNativeShutdown();
  const child = crashedApp.process();
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const killedAt = Date.now();
  killProcessTree(child, 'SIGKILL');
  await exited;
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBe('SIGKILL');

  for (let reopen = 0; reopen < 2; reopen++) {
    const reopened = reopen === 0
      ? await cliOrkas.launchAfterCrash(crashedApp)
      : await cliOrkas.relaunch();
    await reopened.locator(`#conversation-list .conv-item[data-cid="${cid}"]`).click();
    const notice = reopened.locator('#chat-history .chat-message.assistant[data-system-kind="reply_interrupted"]');
    await expect(notice).toHaveCount(1);
    const rail = notice.locator('.stream-process');
    await expect(rail.locator('.stream-process-runtime')).toBeVisible();
    await expect(rail.locator('.stream-process-runtime')).toHaveText(/^≈ /);
    await rail.locator('.stream-process-summary').click();
    await rail.locator('.stream-process-compact-summary').click();
    const tool = rail.locator('[data-process-call-id="cli:crash-tool"]');
    await expect(tool).toHaveCount(1);
    await tool.click();
    await expect(rail).toContainText('DURABLE_CRASH_RECEIPT');
    const { history } = await cliOrkas.invoke<{ history: any[] }>('conversations.history', { cid, limit: 20 });
    const receipt = history.find(row => row.system_kind === 'reply_interrupted');
    expect(receipt).toMatchObject({ from: agent.agent_id, ...durable.in_flight_turns[agent.agent_id] });
    const clock = receipt.process.find(item => item.event?.stream === 'runtime').event.data;
    expect(clock.phase).toBe('interrupted');
    expect(clock.duration_estimated).toBe(true);
    expect(clock.duration_ms).toBeGreaterThan(0);
    expect(clock.duration_ms).toBeLessThanOrEqual(killedAt - Date.parse(meta.startedAt));
    expect(history.filter(row => row.system_kind === 'reply_interrupted')).toHaveLength(1);
    expect(cliOrkas.readCliState().invocations).toHaveLength(1);
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).status).toBe('idle');
    await expect(reopened.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    if (!reopen) await reopened.screenshot({ path: info.outputPath('cli-crash-recovered.png') });
  }
  const canonical = readFileSync(historyFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(canonical.filter(row => row.system_kind === 'reply_interrupted')).toHaveLength(1);
});
