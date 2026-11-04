import { expect, test } from './fixtures/orkas';

test('recovers a durable queued user message and attachments after its live event was lost', async ({ modelOrkas: app }) => {
  const page = app.page!;
  app.setModelTextReplies(['Ready']);
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill('Start an isolated recovery task');
  await page.locator('#new-chat-send-btn').click();
  await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  const cid = await page.locator('#conversation-list .conv-item').first().getAttribute('data-cid');
  expect(cid).toBeTruthy();
  const before = app.modelRequests.length;
  app.setModelMode('controlled-slow');
  await page.locator('#chat-input').fill('@ContentWriter keep the preceding reply active.');
  await page.locator('#chat-input').press('Enter');
  await expect.poll(() => app.modelRequests.length).toBe(before + 1);
  const source = app.createFixtureFile('queued.txt', 'Preserve this source with the queued message.');
  await app.selectFilesOnNextDialog([source]);
  await page.locator('#chat-attach-btn').click();
  await expect(page.locator('#chat-attachments .chat-attach-label')).toHaveText(['queued.txt']);
  await expect(page.locator('#chat-attachments .is-uploading')).toHaveCount(0);
  await page.locator('#chat-input').fill('Keep the queued attachment in history.');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#chat-task-board-list .chat-queue-item', { hasText: 'Keep the queued attachment in history.' })).toBeVisible();
  app.setModelMode('success');
  app.releaseControlledModelChunk();
  app.finishControlledModelStream();
  await expect.poll(async () => {
    const result = await app.invoke<{ tasks: Array<{ instruction: string; status: string }> }>('groupChat.tasks.list', { cid });
    return result.tasks.find(row => row.instruction === 'Keep the queued attachment in history.')?.status;
  }).toBe('done');
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  await page.evaluate((id) => {
    const w = window as any;
    w._stopRuntimeActorRecovery(id);
    w._stopGroupEventObserver(id);
    if (typeof w.stopPolling === 'function') w.stopPolling(id);
    // Model the absent user row after live delivery was lost. The real bus,
    // canonical history and attachments remain intact and define the oracle.
    for (const row of document.querySelectorAll('#chat-history .chat-message.user')) {
      if (row.textContent?.includes('Keep the queued attachment in history.')) row.remove();
    }
  }, cid);
  const message = page.locator('#chat-history .chat-message.user', { hasText: 'Keep the queued attachment in history.' });
  await expect(message).toHaveCount(0);
  await page.evaluate(async (id) => { await (window as any)._recoverObservedConversationHistory(id); }, cid);
  await expect(message).toHaveCount(1);
  await expect(message.locator('.chat-msg-attach .chat-attach-label')).toHaveText(['queued.txt']);
  await page.evaluate(async (id) => { await (window as any)._recoverObservedConversationHistory(id); }, cid);
  await expect(message).toHaveCount(1);
});
