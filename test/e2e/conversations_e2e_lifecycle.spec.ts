import { expect, test } from './fixtures/orkas';

test.describe('conversations and resource picker', () => {
  test('keeps direct-agent routing mentions out of the task title after refresh', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const agentName = 'E2ETitleAgent';
    const taskText = 'Draft E2E launch summary';
    const created = await modelOrkas.invoke<{ agent: { agent_id: string } }>('agents.create', {
      name: agentName,
      description: 'Handles the deterministic title-routing regression.',
      category: 'general',
    });

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-recipient-chip').click();
    const picker = page.locator('#agent-picker');
    await picker.locator(
      `.skill-picker-item[data-kind="agent"][data-id="${created.agent.agent_id}"]`,
    ).click();
    await expect(page.locator('#new-chat-recipient-name')).toHaveText(agentName);
    await page.locator('#new-chat-input').fill(taskText);
    await page.locator('#new-chat-send-btn').click();

    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-header-title')).toHaveText(taskText);
    await expect(page.locator('#chat-history .chat-message.user')).toContainText(
      `@${agentName} ${taskText}`,
    );
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toBeVisible({
      timeout: 20_000,
    });

    const listed = await modelOrkas.invoke<{
      conversations: Array<{ conversation_id: string; title: string }>;
    }>('conversations.list');
    const conversation = listed.conversations.find((item) => item.title === taskText);
    expect(conversation).toBeDefined();
    expect(conversation?.title).not.toContain(`@${agentName}`);

    await page.evaluate(async (cid) => {
      const app = window as any;
      await app.loadConversations();
      app.setView('conversation', cid);
    }, conversation?.conversation_id);
    await expect(page.locator('#chat-header-title')).toHaveText(taskText);
    await expect(page.locator(`.conv-item[data-cid="${conversation?.conversation_id}"] .conv-item-title`))
      .toHaveText(taskText);
  });

  test('pins, renames, opens, persists, and deletes a conversation', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', {
      title: 'E2E Conversation Before Rename',
    });
    const cid = created.conversation.conversation_id;
    await page.evaluate(async () => (window as any).loadConversations());

    let row = page.locator(`.conv-item[data-cid="${cid}"]`);
    await expect(row).toContainText('E2E Conversation Before Rename');
    await row.hover();
    await row.locator('.conv-item-menu').click();
    await page.locator('#conversation-action-menu [data-action="pin"]').click();
    await expect(row).toHaveClass(/\bis-pinned\b/);

    await row.hover();
    await row.locator('.conv-item-menu').click();
    await page.locator('#conversation-action-menu [data-action="rename"]').click();
    const renameInput = page.locator(`input[data-conv-rename-cid="${cid}"]`);
    await renameInput.fill('E2E Conversation After Rename');
    await renameInput.press('Enter');
    row = page.locator(`.conv-item[data-cid="${cid}"]`);
    await expect(row).toContainText('E2E Conversation After Rename');

    await row.click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-header-title')).toContainText('E2E Conversation After Rename');

    const relaunchedPage = await orkas.relaunch();
    row = relaunchedPage.locator(`.conv-item[data-cid="${cid}"]`);
    await expect(row).toContainText('E2E Conversation After Rename');
    await expect(row).toHaveClass(/\bis-pinned\b/);
    await row.hover();
    await row.locator('.conv-item-menu').click();
    await relaunchedPage.locator('#conversation-action-menu [data-action="delete"]').click();
    await expect(relaunchedPage.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(row).toHaveCount(0);
    await expect(relaunchedPage.locator('#panel-new-chat')).toHaveClass(/\bactive\b/);
  });

  test('keeps a conversation visible when deletion fails and lets the user retry', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', {
      title: 'E2E Conversation Delete Retry',
    });
    const cid = created.conversation.conversation_id;
    await page.evaluate(async () => (window as any).loadConversations());

    let row = page.locator(`.conv-item[data-cid="${cid}"]`);
    await expect(row).toBeVisible();
    await page.evaluate(() => {
      const w = window as any;
      w.__e2eOriginalApiFetch = w.apiFetch;
      w.apiFetch = async (url: string, options: { method?: string } = {}) => {
        if (options.method === 'DELETE' && url.startsWith('/api/conversations/')) {
          return {
            ok: false,
            status: 500,
            async json() {
              return { ok: false, error: 'E2E simulated delete failure' };
            },
          };
        }
        return w.__e2eOriginalApiFetch(url, options);
      };
    });

    await row.hover();
    await row.locator('.conv-item-menu').click();
    await page.locator('#conversation-action-menu [data-action="delete"]').click();
    await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();

    await expect(row).toBeVisible();
    await expect(page.locator('.ui-dialog-overlay:visible .ui-dialog')).toContainText(
      'Delete failed: Unknown error',
    );
    const afterFailure = await orkas.invoke<{
      conversations: Array<{ conversation_id: string }>;
    }>('conversations.list');
    expect(afterFailure.conversations.some((item) => item.conversation_id === cid)).toBe(true);
    await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();

    await page.evaluate(() => {
      const w = window as any;
      w.apiFetch = w.__e2eOriginalApiFetch;
      delete w.__e2eOriginalApiFetch;
    });
    row = page.locator(`.conv-item[data-cid="${cid}"]`);
    await row.hover();
    await row.locator('.conv-item-menu').click();
    await page.locator('#conversation-action-menu [data-action="delete"]').click();
    await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(row).toHaveCount(0);
  });

  test('keeps fast-switch drafts isolated across conversations and relaunch', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const first = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', {
      title: 'E2E Draft Owner A',
    });
    const second = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', {
      title: 'E2E Draft Owner B',
    });
    const firstCid = first.conversation.conversation_id;
    const secondCid = second.conversation.conversation_id;
    await page.evaluate(async () => (window as any).loadConversations());

    await page.evaluate(({ firstCid, secondCid }) => {
      const w = window as any;
      const input = document.getElementById('chat-input') as HTMLTextAreaElement;
      w.setView('conversation', firstCid);
      input.value = 'draft owned by conversation A';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Switch before the 180 ms draft debounce fires, then type in B.
      w.setView('conversation', secondCid);
      input.value = 'draft owned by conversation B';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, { firstCid, secondCid });
    await page.waitForTimeout(250);

    await page.evaluate((cid) => (window as any).setView('conversation', cid), firstCid);
    await expect(page.locator('#chat-input')).toHaveValue('draft owned by conversation A');
    await page.evaluate((cid) => (window as any).setView('conversation', cid), secondCid);
    await expect(page.locator('#chat-input')).toHaveValue('draft owned by conversation B');

    const relaunchedPage = await orkas.relaunch();
    await relaunchedPage.evaluate((cid) => (window as any).setView('conversation', cid), firstCid);
    await expect(relaunchedPage.locator('#chat-input')).toHaveValue('draft owned by conversation A');
    await relaunchedPage.evaluate((cid) => (window as any).setView('conversation', cid), secondCid);
    await expect(relaunchedPage.locator('#chat-input')).toHaveValue('draft owned by conversation B');
  });

  test('selects a shipped agent, custom skills, and Library files from the composer picker', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    await orkas.invoke('skills.create', {
      name: 'picker-e2e-skill',
      description: 'Selectable E2E skill.',
      category: 'general',
    });
    await orkas.invoke('contexts.write', {
      path: 'picker-e2e-library.md',
      content: '# Picker Library\n',
    });
    await expect.poll(
      async () => {
        const result = await orkas.invoke<{ agents: Array<{ agent_id: string }> }>('agents.list');
        return result.agents.some((agent) => agent.agent_id === '173d4235a431');
      },
      {
        message: 'wait for the asynchronous builtin marketplace seed',
        timeout: 30_000,
      },
    ).toBe(true);

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-recipient-chip').click();
    const picker = page.locator('#agent-picker');
    await expect(picker).toBeVisible();
    await expect(
      picker.locator('.skill-picker-item[data-kind="agent"][data-id="173d4235a431"]'),
    ).toContainText('ContentWriter');

    await picker.locator('[data-agent-picker-tab="skills"]').click();
    await picker.locator('.skill-picker-item[data-kind="skill"]', { hasText: 'picker-e2e-skill' }).click();
    const composerInput = page.locator('#new-chat-input');
    await expect(composerInput).toHaveValue(/Skill: picker-e2e-skill/);
    await composerInput.fill('');
    await expect(composerInput).not.toHaveValue(/picker-e2e-skill/);

    await page.locator('#new-chat-recipient-chip').click();
    await picker.locator('[data-agent-picker-tab="library"]').click();
    await picker.locator('.skill-picker-item[data-kind="library"]', { hasText: 'picker-e2e-library.md' }).click();
    const libraryChip = page.locator('#new-chat-attachments .chat-attach-chip', {
      hasText: 'picker-e2e-library.md',
    });
    await expect(libraryChip).toBeVisible();
    await libraryChip.locator('.chat-attach-remove').click();
    await expect(libraryChip).toHaveCount(0);

    await page.locator('#new-chat-recipient-chip').click();
    await picker.locator('[data-agent-picker-tab="agents"]').click();
    await picker.locator('.skill-picker-item[data-kind="agent"][data-id="173d4235a431"]').click();
    await expect(page.locator('#new-chat-recipient-name')).toHaveText('ContentWriter');
    await expect(picker).toBeHidden();
  });
});
