import { expect, test, type OrkasTestApp } from './fixtures/orkas';

type TaskNotificationNavigation = {
  user_id: string;
  conversation_id: string;
  terminal_status: 'completed' | 'failed' | 'waiting_input';
};

async function sendTaskNotificationNavigation(
  orkas: OrkasTestApp,
  payload: TaskNotificationNavigation,
): Promise<void> {
  if (!orkas.electronApp) throw new Error('Orkas Electron app is unavailable');
  await orkas.electronApp.evaluate(({ BrowserWindow }, navigation) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!win) throw new Error('Orkas BrowserWindow is unavailable');
    win.webContents.send('conversations:open-from-notification', navigation);
  }, payload);
}

test.describe('task notification navigation', () => {
  test('rejects a stale account notification while opening one for the active account', async ({ orkas }) => {
    const accountAConversation = await orkas.invoke<{
      conversation: { conversation_id: string };
    }>('conversations.create', { title: 'E2E Account A Notification' });

    const page = await orkas.switchAccount('notification-account-b', {
      nickname: 'Notification User B',
      email: 'notification-b@example.invalid',
    });
    const accountBConversation = await orkas.invoke<{
      conversation: { conversation_id: string };
    }>('conversations.create', { title: 'E2E Account B Notification' });
    await page.evaluate(async () => (window as any).loadConversations());
    await page.locator('#new-chat-btn').click();
    await expect(page.locator('#panel-new-chat')).toHaveClass(/active/);

    await sendTaskNotificationNavigation(orkas, {
      user_id: 'account-e2e',
      conversation_id: accountAConversation.conversation.conversation_id,
      terminal_status: 'completed',
    });
    await expect(page.locator('#panel-new-chat')).toHaveClass(/active/);
    await expect(page.locator('#panel-conversation')).not.toHaveClass(/active/);

    await sendTaskNotificationNavigation(orkas, {
      user_id: 'notification-account-b',
      conversation_id: accountBConversation.conversation.conversation_id,
      terminal_status: 'failed',
    });
    await expect(page.locator('#panel-conversation')).toHaveClass(/active/);
    await expect(page.locator(
      `.conv-item[data-cid="${accountBConversation.conversation.conversation_id}"]`,
    )).toHaveClass(/active/);
  });
});
