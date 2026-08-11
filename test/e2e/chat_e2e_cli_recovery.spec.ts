import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { expect, test, type OrkasTestApp } from './fixtures/orkas';

async function createCliAgent(
  app: OrkasTestApp,
  name: string,
  cli: 'opencode' | 'hermes' | 'codex' | 'claude',
): Promise<{ page: Page; agentId: string }> {
  const created = await app.invoke<{ agent: { agent_id: string } }>('agents.create', {
    name,
    description: `Deterministic ${cli} E2E agent`,
    category: 'general',
    runtime: { kind: 'cli', cli },
  });
  if (!app.page) throw new Error('Orkas renderer is unavailable');
  const page = app.page;
  await page.locator('#new-chat-btn').click();
  return { page, agentId: created.agent.agent_id };
}

async function sendNewChat(page: Page, text: string): Promise<string> {
  await page.locator('#new-chat-input').fill(text);
  await page.locator('#new-chat-send-btn').click();
  await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
  const conversationId = await page.locator('#conversation-list .conv-item').first().getAttribute('data-cid');
  if (!conversationId) throw new Error('New CLI conversation did not appear in the sidebar');
  return conversationId;
}

async function sendFollowUp(page: Page, text: string): Promise<void> {
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-input').press('Enter');
}

async function selectAiOption(page: Page, mountSelector: string, value: string): Promise<void> {
  await page.locator(`${mountSelector} .ai-select-trigger`).click();
  await page.locator(`.ai-select-popover:visible .ai-select-item[data-value="${value}"]`).click();
}

function cliSessionFile(app: OrkasTestApp, conversationId: string): string {
  return path.join(
    app.workspaceRoot,
    'account-e2e',
    'local',
    'cli-sessions',
    `${conversationId}.json`,
  );
}

function appendCanonicalMessages(
  app: OrkasTestApp,
  conversationId: string,
  rows: Array<Record<string, unknown>>,
): void {
  const file = path.join(
    app.workspaceRoot,
    'account-e2e',
    'cloud',
    'chats',
    `${conversationId}.jsonl`,
  );
  appendFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

test.describe('CLI Agent runtime settings', () => {
  test.describe.configure({ timeout: 120_000 });

  test('persists overrides, resets model-specific thinking, and restores CLI defaults', async ({ cliOrkas }) => {
    const agentName = 'CodexRuntimeSettingsE2E';
    const { page, agentId } = await createCliAgent(cliOrkas, agentName, 'codex');
    await cliOrkas.invoke('agents.update', {
      agent_id: agentId,
      updates: { icon: 'code', color: 'lime' },
    });
    await page.locator('#agents-btn').click();
    const card = page.locator(`.agent-card[data-id="${agentId}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.click();

    const model = page.locator('#agents-detail-cli-settings [data-role="model"]');
    await expect(model.locator('.ai-select-trigger'))
      .toContainText('GPT E2E Default', { timeout: 30_000 });
    await expect(page.locator('#agents-detail-cli-settings-section .agents-detail-section-desc')).toHaveCount(0);
    await expect(page.locator('#agents-detail-cli-settings .agents-detail-cli-note')).toHaveCount(0);
    await expect(page.locator('#agents-detail-project-dir-section')).toBeVisible();
    await expect.poll(() => cliOrkas.readCliState().modelListResponses).toBe(1);

    await model.locator('.ai-select-trigger').click();
    const defaultModelOption = page.locator(
      '.ai-select-popover:visible .ai-select-item[data-value=""]',
    );
    await expect(defaultModelOption.locator('.ai-select-item-label')).toContainText('GPT E2E Default');
    await expect(defaultModelOption.locator('.ai-select-item-hint')).toHaveText('Default');
    await expect(page.locator('.ai-select-popover:visible')).not.toContainText('Resolved by');
    await page.locator('#agents-detail-cli-settings-section .agents-detail-label').click();

    const thinking = page.locator('#agents-detail-cli-settings [data-role="thinking"]');
    await expect(thinking.locator('.ai-select-trigger')).toContainText('low');
    await thinking.locator('.ai-select-trigger').click();
    const defaultThinkingOption = page.locator(
      '.ai-select-popover:visible .ai-select-item[data-value=""]',
    );
    await expect(defaultThinkingOption.locator('.ai-select-item-label')).toHaveText('low');
    await expect(defaultThinkingOption.locator('.ai-select-item-hint')).toHaveText('Default');
    await expect(page.locator('.ai-select-popover:visible')).not.toContainText('Resolved by');
    await page.locator('#agents-detail-cli-settings-section .agents-detail-label').click();

    await page.locator('#agents-back-btn').click();
    await expect(card).toBeVisible();
    await card.click();
    await expect(model.locator('.ai-select-trigger'))
      .toContainText('GPT E2E Default');
    await expect(page.locator('#agents-detail-cli-settings .agents-detail-cli-loading')).toHaveCount(0);
    // The second live response is deliberately delayed. Seeing the selector
    // while only the first response exists proves the cached catalog rendered
    // before the forced refresh completed.
    expect(cliOrkas.readCliState().modelListResponses).toBe(1);
    await expect.poll(() => cliOrkas.readCliState().modelListResponses, { timeout: 15_000 }).toBe(2);
    await model.locator('.ai-select-trigger').click();
    await expect(page.locator(
      '.ai-select-popover:visible .ai-select-item[data-value="gpt-e2e-fresh"]',
    )).toBeVisible();
    await page.locator('#agents-detail-cli-settings-section .agents-detail-label').click();

    await page.locator('#agents-back-btn').click();
    await expect(card).toBeVisible();
    await card.click();
    await expect.poll(() => cliOrkas.readCliState().modelListResponses).toBe(3);
    await model.locator('.ai-select-trigger').click();
    // The third live catalog is empty; the last successful cache must remain
    // usable instead of replacing the selector with a transient failure.
    await expect(page.locator(
      '.ai-select-popover:visible .ai-select-item[data-value="gpt-e2e-fresh"]',
    )).toBeVisible();
    await page.locator('#agents-detail-cli-settings-section .agents-detail-label').click();

    await selectAiOption(page, '#agents-detail-cli-settings [data-role="model"]', 'gpt-e2e-deep');
    await expect(page.locator('#agents-detail-cli-settings [data-role="model"]'))
      .toHaveAttribute('data-value', 'gpt-e2e-deep');

    await selectAiOption(page, '#agents-detail-cli-settings [data-role="thinking"]', 'low');
    await expect(page.locator('#agents-detail-cli-settings [data-role="thinking"]'))
      .toHaveAttribute('data-value', 'low');

    // Thinking levels are model-specific. Switching models must clear the old
    // override instead of silently carrying an incompatible value forward.
    await selectAiOption(page, '#agents-detail-cli-settings [data-role="model"]', '');
    await expect(page.locator('#agents-detail-cli-settings [data-role="model"]'))
      .toHaveAttribute('data-value', '');
    await expect(page.locator('#agents-detail-cli-settings [data-role="thinking"]'))
      .toHaveAttribute('data-value', '');
    const afterModelSwitch = await cliOrkas.invoke<{ agent: { runtime: Record<string, unknown> } }>(
      'agents.get', { agent_id: agentId },
    );
    expect(afterModelSwitch.agent.runtime).toEqual({ kind: 'cli', cli: 'codex' });
    expect(afterModelSwitch.agent.runtime).not.toHaveProperty('thinking_level');

    await selectAiOption(page, '#agents-detail-cli-settings [data-role="model"]', 'gpt-e2e-deep');
    await expect(page.locator('#agents-detail-cli-settings [data-role="model"]'))
      .toHaveAttribute('data-value', 'gpt-e2e-deep');
    await selectAiOption(page, '#agents-detail-cli-settings [data-role="thinking"]', 'low');
    await expect(page.locator('#agents-detail-cli-settings [data-role="thinking"]'))
      .toHaveAttribute('data-value', 'low');

    const relaunchedPage = await cliOrkas.relaunch();
    await relaunchedPage.locator('#agents-btn').click();
    await relaunchedPage.locator(`.agent-card[data-id="${agentId}"]`).click();
    await expect(relaunchedPage.locator('#agents-detail-cli-settings [data-role="model"]'))
      .toHaveAttribute('data-value', 'gpt-e2e-deep', { timeout: 30_000 });
    await expect(relaunchedPage.locator('#agents-detail-cli-settings [data-role="thinking"]'))
      .toHaveAttribute('data-value', 'low');

    await relaunchedPage.locator('#new-chat-btn').click();
    await sendNewChat(
      relaunchedPage,
      `@${agentName} E2E_CODEX_RUNTIME_SETTINGS`,
    );
    await expect(relaunchedPage.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_CODEX_DEFAULT_OK',
    })).toBeVisible({ timeout: 30_000 });
    const agentReplies = relaunchedPage.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${agentId}"]`,
    );
    await expect(agentReplies).toHaveCount(1);
    const firstAvatar = agentReplies.first().locator('.chat-msg-header .avatar-circle');
    await expect(firstAvatar).toHaveAttribute('style', /--avatar-bg:#bef264/);
    const avatarBeforeSettingsReset = await firstAvatar.evaluate((element) => ({
      style: element.getAttribute('style'),
      html: element.innerHTML,
    }));
    expect(cliOrkas.readCliState().invocations.at(-1)).toMatchObject({
      cli: 'codex',
      model: 'gpt-e2e-deep',
      effort: 'low',
    });

    // Clear each override through the real candidates tagged as defaults, then
    // prove the persisted runtime and the next native turn both omit the fields.
    await relaunchedPage.locator('#agents-btn').click();
    await relaunchedPage.locator(`.agent-card[data-id="${agentId}"]`).click();
    await expect(relaunchedPage.locator('#agents-detail-cli-settings [data-role="thinking"]'))
      .toHaveAttribute('data-value', 'low', { timeout: 30_000 });
    await selectAiOption(relaunchedPage, '#agents-detail-cli-settings [data-role="thinking"]', '');
    await expect(relaunchedPage.locator('#agents-detail-cli-settings [data-role="thinking"]'))
      .toHaveAttribute('data-value', '');
    const afterThinkingReset = await cliOrkas.invoke<{ agent: { runtime: Record<string, unknown> } }>(
      'agents.get', { agent_id: agentId },
    );
    expect(afterThinkingReset.agent.runtime).toMatchObject({ model_override: 'gpt-e2e-deep' });
    expect(afterThinkingReset.agent.runtime).not.toHaveProperty('thinking_level');

    await selectAiOption(relaunchedPage, '#agents-detail-cli-settings [data-role="model"]', '');
    await expect(relaunchedPage.locator('#agents-detail-cli-settings [data-role="model"]'))
      .toHaveAttribute('data-value', '');
    const afterDefaultReset = await cliOrkas.invoke<{ agent: { runtime: Record<string, unknown> } }>(
      'agents.get', { agent_id: agentId },
    );
    expect(afterDefaultReset.agent.runtime).toEqual({ kind: 'cli', cli: 'codex' });

    await relaunchedPage.locator('#agent-use-btn').click();
    await sendNewChat(relaunchedPage, 'E2E_CODEX_AVATAR_AFTER_RUNTIME_SETTINGS');
    const replyAfterSettingsReset = relaunchedPage.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${agentId}"]`,
    );
    await expect(replyAfterSettingsReset).toHaveCount(1, { timeout: 30_000 });
    const avatarAfterSettingsReset = await replyAfterSettingsReset.first()
      .locator('.chat-msg-header .avatar-circle')
      .evaluate((element) => ({
        style: element.getAttribute('style'),
        html: element.innerHTML,
      }));
    expect(avatarAfterSettingsReset).toEqual(avatarBeforeSettingsReset);

    const defaultPage = await cliOrkas.relaunch();
    await defaultPage.locator('#agents-btn').click();
    await defaultPage.locator(`.agent-card[data-id="${agentId}"]`).click();
    await expect(defaultPage.locator('#agents-detail-cli-settings [data-role="model"]'))
      .toHaveAttribute('data-value', '', { timeout: 30_000 });
    await expect(defaultPage.locator('#agents-detail-cli-settings [data-role="thinking"]'))
      .toHaveAttribute('data-value', '');

    await defaultPage.locator('#new-chat-btn').click();
    await sendNewChat(defaultPage, `@${agentName} E2E_CODEX_RUNTIME_DEFAULTS`);
    await expect(defaultPage.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_CODEX_DEFAULT_OK',
    })).toBeVisible({ timeout: 30_000 });
    const defaultInvocation = cliOrkas.readCliState().invocations.at(-1);
    expect(defaultInvocation).toMatchObject({ cli: 'codex' });
    expect(defaultInvocation?.model).toBeUndefined();
    expect(defaultInvocation?.effort).toBeUndefined();
  });

  test('labels Claude aliases and remembers only the matching concrete model', async ({ cliOrkas }) => {
    const agentName = 'ClaudeModelAliasE2E';
    const { page, agentId } = await createCliAgent(cliOrkas, agentName, 'claude');
    await cliOrkas.invoke('agents.update', {
      agent_id: agentId,
      updates: {
        runtime: { kind: 'cli', cli: 'claude', model_override: 'sonnet' },
      },
    });

    await page.locator('#agents-btn').click();
    await page.locator(`.agent-card[data-id="${agentId}"]`).click();
    const model = page.locator('#agents-detail-cli-settings [data-role="model"]');
    await expect(model.locator('.ai-select-trigger'))
      .toContainText('Sonnet · latest', { timeout: 30_000 });
    await model.locator('.ai-select-trigger').click();
    const sonnet = page.locator(
      '.ai-select-popover:visible .ai-select-item[data-value="sonnet"]',
    );
    await expect(sonnet.locator('.ai-select-item-hint'))
      .toHaveText('Automatically follows Claude Code updates');
    await page.locator('#agents-detail-cli-settings-section .agents-detail-label').click();

    await page.locator('#new-chat-btn').click();
    await sendNewChat(page, `@${agentName} E2E_CLAUDE_MODEL_ALIAS`);
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_CLAUDE_MODEL_RESOLVED',
    })).toBeVisible({ timeout: 30_000 });
    expect(cliOrkas.readCliState().invocations.at(-1)).toMatchObject({
      cli: 'claude',
      model: 'sonnet',
    });

    const relaunchedPage = await cliOrkas.relaunch();
    await relaunchedPage.locator('#agents-btn').click();
    await relaunchedPage.locator(`.agent-card[data-id="${agentId}"]`).click();
    const relaunchedModel = relaunchedPage.locator(
      '#agents-detail-cli-settings [data-role="model"]',
    );
    await expect(relaunchedModel.locator('.ai-select-trigger'))
      .toContainText('Sonnet · claude-sonnet-4-6', { timeout: 30_000 });

    await selectAiOption(
      relaunchedPage,
      '#agents-detail-cli-settings [data-role="model"]',
      'opus',
    );
    await expect(relaunchedModel).toHaveAttribute('data-value', 'opus');
    await expect(relaunchedModel.locator('.ai-select-trigger')).toContainText('Opus · latest');
    await expect(relaunchedModel.locator('.ai-select-trigger')).not.toContainText('claude-sonnet-4-6');
  });
});

test.describe('CLI failed-turn recovery', () => {
  // These tests include Electron shutdown/startup plus a real child-process
  // handshake. Loaded CI hosts can spend most of the global 60s default in
  // app lifecycle work even though each product assertion has a tighter
  // bounded wait below.
  test.describe.configure({ timeout: 120_000 });

  test('persists tool-state provenance across app relaunch and resumes the same native session', async ({ cliOrkas }) => {
    const { page } = await createCliAgent(cliOrkas, 'OpenCodeResumeE2E', 'opencode');
    const conversationId = await sendNewChat(page, '@OpenCodeResumeE2E E2E_CLI_RESUME_AFTER_RELAUNCH');

    await expect(page.locator('#chat-history .bubble-retry-btn').last()).toBeVisible({ timeout: 30_000 });
    const beforeRelaunch = cliOrkas.readCliState();
    expect(beforeRelaunch.invocations).toHaveLength(1);
    expect(beforeRelaunch.invocations[0]).toMatchObject({
      cli: 'opencode',
      resumeSessionId: null,
      toolExecuted: true,
    });
    expect(beforeRelaunch.toolExecutions).toBe(1);

    const bindingBefore = JSON.parse(readFileSync(cliSessionFile(cliOrkas, conversationId), 'utf8')) as Record<
      string,
      { sessionId: string; sourceMessageId?: string; terminalStatus?: string }
    >;
    const persisted = Object.values(bindingBefore)[0];
    expect(persisted).toMatchObject({
      sessionId: beforeRelaunch.invocations[0].sessionId,
      terminalStatus: 'failed',
    });
    expect(persisted.sourceMessageId).toBeTruthy();

    const relaunchedPage = await cliOrkas.relaunch();
    const conversation = relaunchedPage.locator(`.conv-item[data-cid="${conversationId}"]`);
    await expect(conversation).toBeVisible();
    await conversation.click();
    const retry = relaunchedPage.locator('#chat-history .bubble-retry-btn').last();
    await expect(retry).toBeVisible();
    await retry.locator('xpath=ancestor::*[contains(@class, "chat-message")]').hover();
    await retry.click();

    await expect(relaunchedPage.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_CLI_RESUMED_WITHOUT_DUPLICATE_TOOL',
    })).toBeVisible({ timeout: 30_000 });
    const recovered = cliOrkas.readCliState();
    expect(recovered.invocations).toHaveLength(2);
    expect(recovered.invocations[1].resumeSessionId).toBe(recovered.invocations[0].sessionId);
    expect(recovered.invocations[1].sessionId).toBe(recovered.invocations[0].sessionId);
    expect(recovered.toolExecutions).toBe(1);
  });

  test('drops a stale binding and starts fresh when the failed attempt never established a session', async ({ cliOrkas }) => {
    const { page } = await createCliAgent(cliOrkas, 'OpenCodeRestartE2E', 'opencode');
    const conversationId = await sendNewChat(page, '@OpenCodeRestartE2E E2E_CLI_ESTABLISH_SESSION');
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_CLI_SESSION_ESTABLISHED',
    })).toBeVisible({ timeout: 30_000 });

    await sendFollowUp(page, '@OpenCodeRestartE2E E2E_CLI_RESTART_STALE_BINDING');
    const retry = page.locator('#chat-history .bubble-retry-btn').last();
    await expect(retry).toBeVisible({ timeout: 30_000 });
    const failed = cliOrkas.readCliState();
    expect(failed.invocations).toHaveLength(2);
    expect(failed.invocations[1].resumeSessionId).toBe(failed.invocations[0].sessionId);

    await retry.locator('xpath=ancestor::*[contains(@class, "chat-message")]').hover();
    await retry.click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_CLI_FRESH_RESTART_OK',
    })).toBeVisible({ timeout: 30_000 });

    const restarted = cliOrkas.readCliState();
    expect(restarted.invocations).toHaveLength(3);
    expect(restarted.invocations[2].resumeSessionId).toBeNull();
    expect(restarted.invocations[2].sessionId).not.toBe(restarted.invocations[0].sessionId);
    const bindingAfter = JSON.parse(readFileSync(cliSessionFile(cliOrkas, conversationId), 'utf8')) as Record<
      string,
      { sessionId: string; terminalStatus?: string }
    >;
    expect(Object.values(bindingAfter)[0]).toMatchObject({
      sessionId: restarted.invocations[2].sessionId,
      terminalStatus: 'completed',
    });
  });

  test('Hermes always creates a fresh ACP session and receives bridged visible history', async ({ cliOrkas }) => {
    const { page } = await createCliAgent(cliOrkas, 'HermesHistoryE2E', 'hermes');
    const conversationId = await sendNewChat(page, '@HermesHistoryE2E Remember E2E_HERMES_PRIOR_FACT=blue-orbit');
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_HERMES_FIRST_OK',
    })).toBeVisible({ timeout: 30_000 });

    await sendFollowUp(page, '@HermesHistoryE2E E2E_HERMES_CONTINUE and use the prior fact');
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_HERMES_HISTORY_BRIDGED',
    })).toBeVisible({ timeout: 30_000 });

    const state = cliOrkas.readCliState();
    const hermesRuns = state.invocations.filter((item) => item.cli === 'hermes');
    expect(hermesRuns).toHaveLength(2);
    expect(hermesRuns[0].sessionId).not.toBe(hermesRuns[1].sessionId);
    expect(hermesRuns.every((item) => item.resumeSessionId === null)).toBe(true);
    expect(hermesRuns.every((item) => item.args.join(' ') === 'acp')).toBe(true);
    expect(hermesRuns.every((item) => !item.prompt.includes('## Sexual safety boundary'))).toBe(true);
    expect(hermesRuns[1].prompt).toContain('E2E_HERMES_PRIOR_FACT');
    expect(existsSync(cliSessionFile(cliOrkas, conversationId))).toBe(false);
  });

  test('sends production-bounded long history through the real Hermes child-process boundary', async ({ cliOrkas }) => {
    const agentName = 'HermesBoundedHistoryE2E';
    const { page } = await createCliAgent(cliOrkas, agentName, 'hermes');
    const conversationId = await sendNewChat(
      page,
      `@${agentName} E2E_HERMES_LIMITS_BOOTSTRAP`,
    );
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_HERMES_FIRST_OK',
    })).toBeVisible({ timeout: 30_000 });

    const rows = Array.from({ length: 25 }, (_, index) => {
      const turn = index + 1;
      const id = String(turn).padStart(2, '0');
      const userText = turn === 25
        ? `E2E_HISTORY_NEWEST_FACT=violet-orbit\n${'界'.repeat(6_000)}`
        : `E2E_HISTORY_OLD_${id} ${'x'.repeat(900)}`;
      return [
        {
          id: `e2e-history-user-${id}`,
          ts: `2026-08-05T02:${id}:00.000Z`,
          from: 'user',
          to: ['commander'],
          text: userText,
        },
        {
          id: `e2e-history-commander-${id}`,
          ts: `2026-08-05T02:${id}:01.000Z`,
          from: 'commander',
          to: ['user'],
          text: `E2E_HISTORY_REPLY_${id} ${'y'.repeat(400)}`,
        },
      ];
    }).flat();
    appendCanonicalMessages(cliOrkas, conversationId, rows);

    await sendFollowUp(page, `@${agentName} E2E_HERMES_LIMITS_CURRENT_TASK`);
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_HERMES_LIMITS_OK',
    })).toBeVisible({ timeout: 30_000 });

    const hermesRuns = cliOrkas.readCliState().invocations.filter((item) => item.cli === 'hermes');
    expect(hermesRuns).toHaveLength(2);
    const prompt = hermesRuns[1].prompt;
    const historyStart = prompt.indexOf('## Conversation context recovered by Orkas');
    const taskStart = prompt.lastIndexOf('E2E_HERMES_LIMITS_CURRENT_TASK');
    expect(historyStart).toBeGreaterThanOrEqual(0);
    expect(taskStart).toBeGreaterThan(historyStart);
    const historyBlock = prompt.slice(historyStart, taskStart).trim();
    expect(Buffer.byteLength(historyBlock, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect((historyBlock.match(/^### Turn /gm) || []).length).toBeLessThanOrEqual(20);
    expect(historyBlock).toContain('E2E_HISTORY_NEWEST_FACT=violet-orbit');
    expect(historyBlock).toContain('message truncated by Orkas');
    expect(historyBlock).toMatch(/older turns? omitted/);
    expect(historyBlock).not.toContain('E2E_HISTORY_OLD_01');
    expect(prompt).toContain('E2E_HERMES_LIMITS_CURRENT_TASK');
  });

  test('sends only the post-reply canonical delta through a resumed Codex child process', async ({ cliOrkas }) => {
    const agentName = 'CodexCanonicalDeltaE2E';
    const { page } = await createCliAgent(cliOrkas, agentName, 'codex');
    const conversationId = await sendNewChat(
      page,
      `@${agentName} E2E_CODEX_CONTEXT_FIRST_TASK`,
    );
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_CODEX_DEFAULT_OK',
    })).toBeVisible({ timeout: 30_000 });

    // The rendered final can become visible just before the canonical JSONL
    // append completes. Wait for that durable boundary before simulating rows
    // written by another participant, or the late first-turn write can race
    // with and replace the fixture rows.
    await expect.poll(async () => {
      const result = await cliOrkas.invoke<{ history: Array<Record<string, unknown>> }>(
        'conversations.history',
        { cid: conversationId, limit: 20 },
      );
      return JSON.stringify(result.history).includes('E2E_CODEX_DEFAULT_OK');
    }, { timeout: 30_000 }).toBe(true);

    appendCanonicalMessages(cliOrkas, conversationId, [
      {
        id: 'e2e-codex-delta-user',
        ts: '2026-08-05T03:00:00.000Z',
        from: 'user',
        to: ['commander'],
        text: 'E2E_CODEX_INTERPOSED_USER_FACT=amber-field',
      },
      {
        id: 'e2e-codex-delta-commander',
        ts: '2026-08-05T03:00:01.000Z',
        from: 'commander',
        to: ['user'],
        text: 'E2E_CODEX_INTERPOSED_COMMANDER_FACT=blue-river',
      },
    ]);
    await expect.poll(async () => {
      const result = await cliOrkas.invoke<{ history: Array<Record<string, unknown>> }>(
        'conversations.history',
        { cid: conversationId, limit: 20 },
      );
      return JSON.stringify(result.history);
    }).toContain('E2E_CODEX_INTERPOSED_COMMANDER_FACT=blue-river');

    await sendFollowUp(page, `@${agentName} E2E_CODEX_CONTEXT_SECOND_TASK`);
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_CODEX_DEFAULT_OK',
    })).toHaveCount(2, { timeout: 30_000 });

    const codexRuns = cliOrkas.readCliState().invocations.filter((item) => item.cli === 'codex');
    expect(codexRuns).toHaveLength(2);
    expect(codexRuns[1].resumeSessionId).toBe(codexRuns[0].sessionId);
    expect(codexRuns[1].prompt).toContain('## Conversation updates since the previous CLI turn');
    expect(codexRuns[1].prompt).toContain('E2E_CODEX_INTERPOSED_USER_FACT=amber-field');
    expect(codexRuns[1].prompt).toContain('E2E_CODEX_INTERPOSED_COMMANDER_FACT=blue-river');
    expect(codexRuns[1].prompt).toContain('E2E_CODEX_CONTEXT_SECOND_TASK');
    expect(codexRuns[1].prompt).not.toContain('E2E_CODEX_CONTEXT_FIRST_TASK');
    expect(codexRuns[1].prompt).not.toContain('E2E_CODEX_DEFAULT_OK');
  });

  test('sends a queued update into the active Codex App Server turn without starting another CLI run', async ({ cliOrkas }) => {
    const agentName = 'CodexSendNowE2E';
    const { page } = await createCliAgent(cliOrkas, agentName, 'codex');
    await sendNewChat(page, `@${agentName} E2E_CODEX_SEND_NOW_ACTIVE`);
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);

    await sendFollowUp(page, `@${agentName} E2E_CODEX_SEND_NOW_UPDATE`);
    const queuedRow = page.locator('#chat-queue-list .chat-queue-item', {
      hasText: 'E2E_CODEX_SEND_NOW_UPDATE',
    });
    await expect(queuedRow).toBeVisible();
    const sendNow = queuedRow.locator('[data-act="send"]');
    await expect(sendNow).toBeVisible();
    await sendNow.click();

    await expect(page.locator('#chat-history .chat-message.user', {
      hasText: 'E2E_CODEX_SEND_NOW_UPDATE',
    })).toBeVisible();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_CODEX_STEER_APPLIED',
    })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#chat-queue')).toBeHidden();

    const state = cliOrkas.readCliState();
    const codexRuns = state.invocations.filter((item) => item.cli === 'codex');
    expect(codexRuns).toHaveLength(1);
    expect(codexRuns[0].steers).toHaveLength(1);
    expect(codexRuns[0].steers?.[0].text).toContain('E2E_CODEX_SEND_NOW_UPDATE');
  });

  test('hides active-turn Send for an unsupported one-shot CLI and executes the queue head as the next native turn', async ({ cliOrkas }) => {
    const agentName = 'OpenCodeSendNowE2E';
    const { page } = await createCliAgent(cliOrkas, agentName, 'opencode');
    await sendNewChat(page, `@${agentName} E2E_CLI_SEND_NOW_ACTIVE`);
    await expect.poll(() => cliOrkas.readCliState().invocations.length).toBe(1);
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);

    await sendFollowUp(page, `@${agentName} E2E_CLI_SEND_NOW_FOLLOWUP`);
    const queuedRow = page.locator('#chat-queue-list .chat-queue-item', {
      hasText: 'E2E_CLI_SEND_NOW_FOLLOWUP',
    });
    await expect(queuedRow).toBeVisible();
    await expect(queuedRow.locator('[data-act="send"]')).toHaveCount(0);
    await expect(queuedRow.locator('[data-act="edit"]')).toBeVisible();
    await expect(page.locator('#chat-queue')).toBeVisible();
    await expect(page.locator('#chat-history .chat-message.user')).toHaveCount(1);
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
    // OpenCode's current one-shot adapter has no active-turn ingress, so the
    // queued message remains local and no second child starts before exit.
    expect(cliOrkas.readCliState().invocations).toHaveLength(1);

    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_CLI_SEND_NOW_ACTIVE_OK',
    })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: 'E2E_CLI_SEND_NOW_FOLLOWUP_OK',
    })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#chat-queue')).toBeHidden();
    const users = page.locator('#chat-history .chat-message.user');
    await expect(users).toHaveCount(2);
    await expect(users.nth(1)).toContainText('E2E_CLI_SEND_NOW_FOLLOWUP');

    const state = cliOrkas.readCliState();
    expect(state.invocations).toHaveLength(2);
    expect(state.invocations[1]).toMatchObject({
      cli: 'opencode',
      resumeSessionId: state.invocations[0].sessionId,
      sessionId: state.invocations[0].sessionId,
    });
    expect(state.invocations[1].prompt).toContain('E2E_CLI_SEND_NOW_FOLLOWUP');
  });
});
