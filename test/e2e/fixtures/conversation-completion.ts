import { expect, type Page } from '@playwright/test';

/** Finish a completed task's real persisted navigation before closing its worker. */
export async function reopenCompletedConversation(page: Page, conversationId?: string): Promise<void> {
  const activeCid = await page.evaluate<string | null>('currentCid');
  const cid = conversationId || activeCid;
  expect(cid).toBeTruthy();
  const open = async () => {
    const navigationReady = page.waitForEvent('console', {
      predicate: message => message.text().includes('conversation detail turn navigation ready'),
    });
    await page.locator(`#conversation-list .conv-item[data-cid="${cid}"]`).click();
    await navigationReady;
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
  };
  // A hidden, cached send button does not receive the owning task's updates.
  if (activeCid !== cid) await open();
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  await page.locator('#new-chat-btn').click();
  await open();
}
