import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/orkas';


for (const [language, width] of [['en', 1280], ['zh', 760]] as const) {
  test(`shows a cancelled CLI notice and same-second elapsed time after reopening (${language})`, async ({ orkas }, testInfo) => {
    test.setTimeout(120_000);
    await orkas.invoke('config.setLanguage', { language });
    const { conversation } = await orkas.invoke<{ conversation: { conversation_id: string } }>(
      'conversations.create', { title: 'Cancelled CLI reply' });
    const cid = conversation.conversation_id;
    const file = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`);
    const notice = language === 'zh' ? '上一次回复被中断，请发送消息继续。'
      : 'The previous reply was interrupted. Send a message to continue.';
    writeFileSync(file, [
      { id: 'source', from: 'user', to: ['codex-agent'], ts: '2026-10-26T06:31:11Z', text: 'Update the pricing.' },
      { id: 'interrupted', from: 'codex-agent', to: ['user'], ts: '2026-10-26T06:31:24Z', text: notice,
        system_kind: 'reply_interrupted', turn_id: 'cancelled-turn', source_message_id: 'source', seg: 0,
        process: [{ type: 'event', event: { stream: 'cli', data: { type: 'status', status: 'running' } } }] },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const archive = path.join(orkas.workspaceRoot, 'account-e2e', 'local', 'file_cache', 'local-agent-runs', '123456abcdef');
    mkdirSync(archive, { recursive: true });
    writeFileSync(path.join(archive, 'meta.json'), JSON.stringify({ cid, agentId: 'codex-agent', cli: 'codex',
      currentMessageId: 'source', startedAt: '2026-10-26T06:31:11.226Z', endedAt: '2026-10-26T06:31:24.602Z',
      durationMs: 13374, status: 'cancelled' }));
    writeFileSync(path.join(archive, 'events.jsonl'), JSON.stringify({ type: 'done', status: 'cancelled', durationMs: 13311 }) + '\n');
    const original = readFileSync(file, 'utf8');
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await orkas.relaunch();
      await page.setViewportSize({ width, height: 800 });
      await page.locator(`#conversation-list .conv-item[data-cid="${cid}"]`).click();
      const reply = page.locator('#chat-history .chat-message.assistant[data-system-kind="reply_interrupted"]');
      await expect(reply).toHaveCount(1);
      // The notice must be visible outside the collapsed process disclosure.
      await expect(reply.locator('.chat-bubble > .markdown-body')).toBeVisible();
      await expect(reply.locator('.chat-bubble > .markdown-body')).toHaveText(notice);
      await expect(reply.locator('.stream-process-runtime')).toBeVisible();
      await expect(reply.locator('.stream-process-runtime')).toHaveText(language === 'zh' ? '13秒' : '13s');
      await expect(reply.locator('.stream-process')).not.toHaveAttribute('open');
      await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
      if (!attempt) await page.screenshot({ path: testInfo.outputPath(`cancelled-reply-${language}.png`) });
    }
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
}

for (const [language, width, timing] of [['en', 1280, 'timestamps'], ['zh', 760, 'last-write'],
  ['en', 1280, 'done'], ['zh', 760, 'fallback-actor'], ['en', 1280, 'partial-process'],
  ['en', 1280, 'multiple-attempts']] as const) {
  test(`opens archived process details after an application interruption (${language}, ${timing})`, async ({ orkas }, testInfo) => {
    test.setTimeout(120_000);
    await orkas.invoke('config.setLanguage', { language });
    const { conversation } = await orkas.invoke<{ conversation: { conversation_id: string } }>(
      'conversations.create', { title: 'Interrupted submission task' });
    const cid = conversation.conversation_id;
    const actorId = timing === 'fallback-actor' ? 'codex-agent' : 'commander';
    const file = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`);
    const notice = language === 'zh'
      ? '应用退出时，上一次回复被中断。已完成的持久化进度仍会保留，请发送消息继续。'
      : 'The previous response was interrupted when the app exited. Durable progress was kept; send a message to continue.';
    writeFileSync(file, [
      { id: 'user-1', from: 'user', to: [actorId], ts: '2026-10-17T01:00:00Z', text: 'Continue the submissions.' },
      { id: 'async-question', from: actorId, to: ['user'], ts: '2026-10-17T02:02:00Z', text: 'Continue with the original target?',
        ...(timing === 'fallback-actor' ? { turn_id: 'active-turn', cli_question: { questions: [] } } : {}) },
      { id: 'steering-user', from: 'user', to: [actorId], ts: '2026-10-17T02:47:00Z', text: 'Continue the original target.' },
      ...(timing === 'fallback-actor' ? [{ id: 'second-question', from: actorId, to: ['user'],
        ts: '2026-10-17T03:00:00Z', turn_id: 'active-turn', cli_question: { questions: [] }, text: 'Continue reviewing?' }] : []),
      { id: 'interruption-1', from: 'commander', to: ['user'], ts: '2026-10-17T12:14:00Z', text: notice,
        system_kind: 'reply_interrupted', ...(timing === 'partial-process' ? {
          source_message_id: 'user-1', process: [
            { type: 'progress', text: 'Checking the saved submission records.' },
            ...[
              { type: 'tool-event', phase: 'use', tool: 'bash', callId: 'saved-check', input: { command: 'python submission_queue.py report' } },
              { type: 'tool-event', phase: 'result', tool: 'bash', callId: 'saved-check', output: 'Confirmed 15 of 50 submissions.' },
            ].map(data => ({ type: 'event', event: { stream: 'cli', data } })),
          ],
        } : {}) },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const archive = path.join(orkas.workspaceRoot, 'account-e2e', 'local', 'file_cache', 'local-agent-runs', '123456abcdef');
    mkdirSync(archive, { recursive: true });
    writeFileSync(path.join(archive, 'meta.json'), JSON.stringify({ runId: '123456abcdef', cid,
      agentId: actorId, cli: 'codex', currentMessageId: 'user-1',
      startedAt: '2026-10-17T01:00:03.973Z',
      ...(['timestamps', 'fallback-actor', 'partial-process', 'multiple-attempts'].includes(timing)
        ? { endedAt: '2026-10-17T12:13:55.849Z' } : {}) }));
    writeFileSync(path.join(archive, 'events.jsonl'), [
      { type: 'text-delta', phase: 'commentary', text: 'Checking the saved submission records.' },
      { type: 'tool-event', phase: 'use', tool: 'bash', callId: 'saved-check', input: { command: 'python submission_queue.py report' } },
      { type: 'tool-event', phase: 'result', tool: 'bash', callId: 'saved-check', output: 'Confirmed 15 of 50 submissions.' },
      { type: 'text-delta', phase: 'final_answer', text: 'UNFINISHED ANSWER' },
      ...(timing === 'done' ? [{ type: 'done', status: 'cancelled', durationMs: 40_430_000 }] : []),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    // Keep an hour between the last durable progress and the recovery notice:
    // reopening must never count that downtime as execution.
    const lastWrite = new Date('2026-10-17T11:13:55.849Z');
    utimesSync(path.join(archive, 'events.jsonl'), lastWrite, lastWrite);
    if (timing === 'multiple-attempts') {
      const second = path.join(path.dirname(archive), 'abcdef123456');
      mkdirSync(second, { recursive: true });
      writeFileSync(path.join(second, 'meta.json'), JSON.stringify({ cid, agentId: actorId, cli: 'codex',
        currentMessageId: 'user-1', startedAt: '2026-10-17T12:13:56Z', endedAt: '2026-10-17T12:13:59Z', durationMs: 3000 }));
      writeFileSync(path.join(second, 'events.jsonl'), JSON.stringify({ type: 'text-delta', phase: 'commentary', text: 'Verifying the final saved status.' }) + '\n');
    }
    const original = readFileSync(file, 'utf8');

    // Relaunch uses the real history worker, IPC and renderer with an old
    // interruption row. No model or CLI process is started by viewing history.
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await orkas.relaunch();
      await page.setViewportSize({ width, height: 800 });
      await page.locator(`#conversation-list .conv-item[data-cid="${cid}"]`).click();
      const reply = page.locator('#chat-history .chat-message.assistant[data-system-kind="reply_interrupted"]');
      await expect(reply).toHaveCount(1);
      await expect(reply).toContainText(notice);
      const rail = reply.locator('.stream-process');
      await expect(rail).toBeVisible();
      await expect(rail.locator('.stream-process-runtime')).toHaveText(timing === 'last-write'
        ? '≈ 10小时13分52秒' : timing === 'fallback-actor' ? '11小时13分52秒'
          : timing === 'done' ? '11h 13m 50s' : timing === 'multiple-attempts' ? '11h 13m 55s' : '11h 13m 52s');
      await rail.locator('.stream-process-summary').focus();
      await page.keyboard.press('Enter');
      await expect(rail).toHaveAttribute('open', '');
      await expect(rail).toContainText('Checking the saved submission records.');
      if (timing === 'multiple-attempts') {
        await rail.locator('.chat-process-load-more').click();
        await expect(rail).toContainText('Verifying the final saved status.');
      }
      // Tool operations use the shipped nested disclosure inside the rail.
      await rail.locator('.stream-process-compact-summary').click();
      const tool = rail.locator('[data-process-call-id="cli:saved-check"]');
      await expect(tool).toHaveCount(1);
      await expect(tool).toBeVisible();
      await expect(tool).toContainText('submission_queue.py report');
      await tool.press('Enter');
      await expect(tool).toHaveAttribute('aria-expanded', 'true');
      await expect(rail).toContainText('Confirmed 15 of 50 submissions.');
      await expect(reply).not.toContainText('UNFINISHED ANSWER');
      await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
      if (!attempt) await page.screenshot({ path: testInfo.outputPath(`interrupted-process-${language}.png`) });
    }
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
}
