import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/orkas';
import { composerText } from './fixtures/composer';


test('keeps a visible unfocused window streaming before the task completes', async ({ modelOrkas }, testInfo) => {
  const page = modelOrkas.page!;
  const nativeWindow = await modelOrkas.electronApp!.browserWindow(page);
  await nativeWindow.evaluate(win => win.showInactive());
  modelOrkas.setModelMode('controlled-slow');
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill('Keep this task streaming while I use another window.');
  await page.locator('#new-chat-send-btn').click();
  await expect.poll(() => modelOrkas.modelRequests.length, { timeout: 30_000 }).toBe(1);
  const reply = page.locator('#chat-history .chat-message.assistant [data-role="final"]');
  await expect(reply).toContainText('Hello');
  // Drive the same native lifecycle event as switching apps, independently
  // of which window owns focus on the test host. No model or final event can
  // supply the missing paint: the controlled stream remains open below.
  await nativeWindow.evaluate(win => win.emit('blur'));
  modelOrkas.releaseControlledModelChunk();
  await expect(reply).toHaveText('Hello from the local E2E model.');
  await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
  expect(await page.evaluate<boolean>('_conversationWindowActive')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('visible-unfocused-stream.png') });
  modelOrkas.finishControlledModelStream();
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  expect(modelOrkas.modelRequests).toHaveLength(1);
});

// Real Electron IPC, execution bus, persistence and renderer; the endpoint is
// the existing isolated local model fixture, with explicit stream barriers.
for (const surface of ['hidden-window', 'other-panel', 'other-task'] as const) {
  for (const completed of [false, true]) {
    test(`restores ${completed ? 'saved result' : 'latest live text'} after ${surface} without executing again`, async ({ modelOrkas }) => {
      const page = modelOrkas.page!;
      modelOrkas.setModelMode('controlled-slow');
      await page.locator('#new-chat-btn').click();
      await page.locator('#new-chat-input').fill('Keep this task running while I look elsewhere.');
      await page.locator('#new-chat-send-btn').click();
      // The first turn includes cold SDK imports on Windows before the local
      // endpoint receives its request; peer stream cases use this same bound.
      await expect.poll(() => modelOrkas.modelRequests.length, { timeout: 30_000 }).toBe(1);
      await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
      await expect(page.locator('#chat-history .chat-message.user')).toHaveCount(1);
      const cid = await page.evaluate<string>('currentCid');
      let hiddenText: string | null = null;
      const messageFile = path.join(modelOrkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`);
      const persisted = () => existsSync(messageFile)
        ? readFileSync(messageFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
      // Admission already saved the user input before it was rendered.
      expect(persisted().filter(row => row.from === 'user')).toHaveLength(1);

      if (surface === 'hidden-window') {
        const nativeWindow = await modelOrkas.electronApp!.browserWindow(page);
        // Chromium may retain visible for a hidden-at-launch document. Verify
        // the native lifecycle channel independently of that document state.
        await nativeWindow.evaluate(win => win.showInactive());
        // Establish a real native show-to-hide transition for this initially
        // hidden fixture before checking the renderer's lifecycle receipt.
        await expect.poll(() => nativeWindow.evaluate(win => win.isVisible())).toBe(true);
        await nativeWindow.evaluate(win => win.hide());
        await expect.poll(() => nativeWindow.evaluate(win => win.isVisible())).toBe(false);
        await expect.poll(() => page.evaluate<boolean>('_conversationWindowActive')).toBe(false);
        // Snapshot after the acknowledged hide. The first admitted prefix may
        // arrive between the earlier composer checks and the native transition.
        hiddenText = await page.locator('#chat-history [data-role="final"]').textContent();
      } else if (surface === 'other-panel') {
        await page.locator('#new-chat-btn').click();
      } else {
        const other = await modelOrkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Other task' });
        await page.evaluate(async (otherCid) => {
          await (window as any).loadConversations();
          (window as any).setView('conversation', otherCid);
        }, other.conversation.conversation_id);
        await expect(page.locator('#chat-header-title')).toHaveText('Other task');
      }

      modelOrkas.releaseControlledModelChunk();
      await expect.poll(async () => {
        const result = await modelOrkas.invoke<any>('conversations.history', { cid, live: '1' });
        return result.live_display.turns.at(-1)?.records.at(-1)?.text;
      }).toBe('Hello from the local E2E model.');
      if (surface === 'hidden-window') expect(await page.locator('#chat-history [data-role="final"]').textContent()).toBe(hiddenText);
      if (surface === 'other-task') await expect(page.locator('#chat-history')).not.toContainText('Hello from the local E2E model.');

      if (completed) {
        modelOrkas.finishControlledModelStream();
        await expect.poll(() => persisted().find(row => row.from === 'commander')?.text)
          .toBe('Hello from the local E2E model.');
        const reply = persisted().find(row => row.from === 'commander');
        expect(reply.process.length).toBeGreaterThan(0);
      }
      if (surface === 'hidden-window') {
        const nativeWindow = await modelOrkas.electronApp!.browserWindow(page);
        await nativeWindow.evaluate(win => win.showInactive());
        await expect.poll(() => page.evaluate<boolean>('_conversationWindowActive')).toBe(true);
      } else {
        await page.evaluate(cid => (window as any).setView('conversation', cid), cid);
      }
      // Recovery may reserve an actor-neutral, display:none row until the
      // terminal bus event drains. Only the delivered row is user-visible.
      const replies = page.locator('#chat-history .chat-message.assistant:visible');
      await expect(replies).toHaveCount(1);
      await expect(replies).toContainText('Hello from the local E2E model.');
      if (!completed) {
        await expect(replies.locator('[data-role="final"]')).toHaveText('Hello from the local E2E model.');
        await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
        modelOrkas.finishControlledModelStream();
      }
      await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
      await expect(page.locator('#chat-history .chat-message.assistant')).toHaveCount(1);
      expect(persisted().filter(row => row.from === 'commander')).toHaveLength(1);
      expect(modelOrkas.modelRequests).toHaveLength(1);
    });
  }
}

test('recovers a lost terminal notification while a queued follow-up remains live', async ({ modelOrkas }) => {
  const page = modelOrkas.page!;
  const { agent } = await modelOrkas.invoke<{ agent: { agent_id: string } }>('agents.create', {
    name: 'TerminalRecoveryAgent', description: 'Deterministic terminal recovery fixture.', category: 'general',
  });
  modelOrkas.setModelMode('controlled-slow');
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-recipient-chip').click();
  await page.locator(`#agent-picker [data-kind="agent"][data-id="${agent.agent_id}"]`).click();
  const input = page.locator('#new-chat-input');
  await input.fill(`${await composerText(input)}Complete the first task.`);
  await page.locator('#new-chat-send-btn').click();
  await expect.poll(() => modelOrkas.modelRequests.length, { timeout: 30_000 }).toBe(1);
  const cid = await page.evaluate<string>('currentCid');
  modelOrkas.releaseControlledModelChunk();
  const replies = page.locator('#chat-history .chat-message.assistant');
  await expect(replies.locator('[data-role="final"]')).toHaveText('Hello from the local E2E model.');
  const firstTurn = await replies.getAttribute('data-turn-id');
  expect(firstTurn).toBeTruthy();
  await expect(replies.locator('[data-role="process-loading"]')).toBeVisible();
  await page.evaluate(turnId => {
    const w = window as any;
    w.__terminalRecoveryHandler = w._handleGroupBusEvent;
    w.__terminalRecoveryDropped = 0;
    w._handleGroupBusEvent = function (cid: string, row: any, event: any, options: any) {
      if (event?.type === 'message' && event.turn_end === true && event.msg?.turn_id === turnId) {
        w.__terminalRecoveryDropped++;
        return;
      }
      return w.__terminalRecoveryHandler(cid, row, event, options);
    };
  }, firstTurn);
  try {
    await page.locator('#chat-input').fill('Complete a separate follow-up task.');
    await page.locator('#chat-input').press('Enter');
    modelOrkas.finishControlledModelStream();
    modelOrkas.setModelMode('controlled-slow');
    await expect.poll(() => modelOrkas.modelRequests.length, { timeout: 30_000 }).toBe(2);
    await expect.poll(() => page.evaluate<number>('window.__terminalRecoveryDropped')).toBeGreaterThan(0);
    await page.evaluate(cid => (window as any)._recoverObservedConversationHistory(cid), cid);
    const oldReply = replies.first();
    await expect(oldReply).toHaveAttribute('data-turn-id', firstTurn!);
    await expect(oldReply).toHaveAttribute('data-turn-end', '1');
    await expect(oldReply.locator('[data-role="process-loading"]')).toBeHidden();
    await expect(oldReply.locator('[data-role="final"]')).toHaveText('Hello from the local E2E model.');
    const oldDuration = await oldReply.locator('.stream-process-runtime').textContent();
    await expect(replies).toHaveCount(2);
    await expect(replies.nth(1).locator('[data-role="process-loading"]')).toBeVisible();
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
    const nextDuration = await replies.nth(1).locator('.stream-process-runtime').textContent();
    await expect.poll(() => replies.nth(1).locator('.stream-process-runtime').textContent()).not.toBe(nextDuration);
    // Replay the read and an old delta while the follow-up is still working.
    await page.evaluate(async ({ cid, turnId, actor }) => {
      const w = window as any;
      await w._recoverObservedConversationHistory(cid);
      w._handleGroupBusEvent(cid, null, { type: 'process', actor, turn_id: turnId, seg: 0,
        data: { type: 'delta', text: 'Stale first-turn text' } });
    }, { cid, turnId: firstTurn, actor: agent.agent_id });
    await expect(replies).toHaveCount(2);
    await expect(oldReply.locator('[data-role="process-loading"]')).toBeHidden();
    await expect(oldReply.locator('.stream-process-runtime')).toHaveText(oldDuration!);
    await expect(page.locator('#chat-history')).not.toContainText('Stale first-turn text');
    modelOrkas.releaseControlledModelChunk();
    modelOrkas.finishControlledModelStream();
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect(page.locator('#chat-history .stream-process-loading:visible')).toHaveCount(0);
    expect(modelOrkas.modelRequests).toHaveLength(2);
    const history = await modelOrkas.invoke<any>('conversations.history', { cid });
    expect(history.history.filter((record: any) => record.from === agent.agent_id)).toHaveLength(2);
  } finally {
    await page.evaluate(() => {
      const w = window as any;
      w._handleGroupBusEvent = w.__terminalRecoveryHandler;
      delete w.__terminalRecoveryHandler;
      delete w.__terminalRecoveryDropped;
    });
  }
});
