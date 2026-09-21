import { expect, test } from './fixtures/orkas';

function expectAppCreationContext(request: Record<string, unknown>) {
  const messages = request.messages as Array<{ role: string; content: unknown }>;
  const userContext = JSON.stringify(messages.filter(message => message.role === 'user'));
  const tools = request.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
  const artifacts = tools.filter(tool => tool.function.name === 'create_artifact');
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0].function.parameters).toMatchObject({
    type: 'object', required: expect.arrayContaining(['files']), properties: { files: { type: 'array' } },
  });
  expect(userContext).toContain('## App creation');
  expect(userContext).toContain('workspace.artifact with tool_load');
  expect(userContext).toContain('call create_artifact');
  expect(JSON.stringify(messages.filter(message => message.role === 'system'))).not.toContain('## App creation');
}

test.describe('My Apps', () => {
  for (const existingTaskCount of [0, 2]) {
    test(`creates a separate task once with ${existingTaskCount} existing tasks and records bounded actions`, async ({ modelOrkas: orkas }) => {
      const page = orkas.page!;
      orkas.setModelTextReplies(['APP_CREATE_ACK']);
      // Existing history must remain usable when a new app task is inserted
      // and sorted, before the first model request is sent.
      for (let i = 0; i < existingTaskCount; i += 1) {
        await orkas.invoke('conversations.create', { title: `Existing task ${i + 1}` });
      }
      await page.evaluate(() => (window as any).loadConversations());
      await expect(page.locator('#conversation-list .conv-item')).toHaveCount(existingTaskCount);
      await page.locator('.chat-rich-editor[data-rich-input-id="new-chat-input"]').fill('Unrelated home draft');
      await page.evaluate(() => {
        const w = window as any;
        w.__appCreateEvents = [];
        for (const kind of ['click', 'event']) {
          const original = w.Monitor[kind];
          w.Monitor[kind] = function(name: string, payload: unknown) {
            if (name.startsWith('saved_app_create')) w.__appCreateEvents.push({ kind, name, payload });
            return original.call(this, name, payload);
          };
        }
      });
      await page.locator('#apps-btn').click();
      const opener = page.locator('#apps-create-btn');
      await opener.click();
      const panel = page.getByRole('dialog', { name: 'Create app', exact: true });
      const idea = panel.getByRole('textbox', { name: 'Describe your idea' });
      const submit = panel.getByRole('button', { name: 'Create', exact: true });
      const cancel = panel.getByRole('button', { name: 'Cancel', exact: true });
      await expect(panel.locator('[data-app-template]')).toHaveCount(4);
      await expect(panel).not.toContainText('Next:');
      await expect(idea).toBeFocused();
      await idea.fill('   ');
      await expect(submit).toBeDisabled();
      await page.keyboard.press('Shift+Tab');
      await expect(cancel).toBeFocused();
      await idea.focus();
      await idea.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
      await expect(panel).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(opener).toBeFocused();
      await opener.click();
      for (const [id, topic] of [
        ['products', /product inventory/i], ['converter', /unit converter/i],
        ['flashcards', /vocabulary flashcard/i], ['game', /snake game/i],
      ] as const) {
        await panel.locator(`[data-app-template="${id}"]`).click();
        await expect(idea).toHaveValue(topic);
        await expect(idea).toBeFocused();
      }
      expect(orkas.modelRequests).toHaveLength(0);
      await cancel.click();
      await expect(opener).toBeFocused();
      await opener.click();
      await idea.fill('Create an app to plan family meals');
      await idea.press('Enter');
      await idea.pressSequentially('Include a shopping list');
      const prompt = await idea.inputValue();
      expect(prompt).toContain('\n');
      // Two synchronous clicks cover a fast repeat before IPC returns.
      await submit.evaluate((el: HTMLButtonElement) => { el.click(); el.click(); });
      await expect(panel).toHaveCount(0);
      await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
      await expect(page.locator('#chat-history .chat-message.user')).toHaveCount(1);
      await expect(page.locator('#chat-history .chat-message.user')).toContainText(prompt);
      await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', { hasText: 'APP_CREATE_ACK' })).toBeVisible({ timeout: 20_000 });
      expect(orkas.modelRequests).toHaveLength(1);
      expectAppCreationContext(orkas.modelRequests[0]);
      await expect(page.locator('#chat-history .chat-message.user')).not.toContainText('## App creation');
      const listed = await orkas.invoke<{ conversations: unknown[] }>('conversations.list');
      expect(listed.conversations).toHaveLength(existingTaskCount + 1);
      expect(listed.conversations.filter((conversation: any) => conversation.assistance?.kind === 'app_creation')).toHaveLength(1);
      await expect(page.locator('#conversation-list .conv-item')).toHaveCount(existingTaskCount + 1);
      await expect(page.locator('#conversation-list .conv-item').first()).toHaveClass(/\bactive\b/);
      for (let i = 0; i < existingTaskCount; i += 1) {
        await expect(page.locator('#conversation-list')).toContainText(`Existing task ${i + 1}`);
      }
      expect(JSON.stringify(orkas.modelRequests)).not.toContain('Unrelated home draft');
      const events = await page.evaluate(() => (window as any).__appCreateEvents);
      expect(events.filter((e: any) => e.name === 'saved_app_create_result')).toEqual([{
        kind: 'event', name: 'saved_app_create_result', payload: { result: 'success', template: 'custom', stage: 'send', duration_ms: expect.any(Number) },
      }]);
      expect(events.filter((e: any) => e.name === 'saved_app_create').map((e: any) => e.payload.action)).toEqual([
        'open', 'cancel', 'open', 'template', 'template', 'template', 'template', 'cancel', 'open', 'submit',
      ]);
      expect(JSON.stringify(events)).not.toContain('family meals');
      await page.locator('#new-chat-btn').click();
      await expect(page.locator('#new-chat-input')).toHaveValue('Unrelated home draft');
    });
  }

  test('keeps the description in the new task when sending is rejected and supports retry', async ({ modelOrkas: orkas }) => {
    const page = orkas.page!;
    orkas.setModelTextReplies(['APP_RETRY_ACK']);
    await page.locator('#apps-btn').click();
    await page.locator('#apps-create-btn').click();
    const panel = page.locator('.apps-create-panel');
    await panel.locator('[data-app-template="products"]').click();
    const description = await panel.locator('textarea').inputValue();
    await page.evaluate(() => {
      const w = window as any;
      w.__createRecoveryNotifications = [];
      window.addEventListener('error', event => {
        w.__createRecoveryNotifications.push({ message: event.message, hasException: event.error != null });
      });
      const fetch = w.apiFetch;
      w.apiFetch = (...args: any[]) => {
        if (String(args[0]).endsWith('/send/stream')) {
          w.apiFetch = fetch;
          return Promise.resolve({ ok: false, status: 503 });
        }
        return fetch(...args);
      };
      w.__creationResults = [];
      const original = w.Monitor.event;
      w.Monitor.event = function(name: string, payload: unknown) {
        if (name === 'saved_app_create_result') w.__creationResults.push(payload);
        return original.call(this, name, payload);
      };
    });
    await panel.locator('[data-create-submit]').click();
    const alert = page.locator('.ui-dialog-overlay:visible').last();
    await expect(alert).toContainText('Could not start app creation');
    await alert.locator('[data-act="ok"]').click();
    await expect(page.locator('#chat-input')).toHaveValue(description);
    expect(orkas.modelRequests).toHaveLength(0);
    expect((await orkas.invoke<{ conversations: unknown[] }>('conversations.list')).conversations).toHaveLength(1);
    expect(await page.evaluate(() => (window as any).__creationResults)).toEqual([{
      result: 'failure', template: 'products', stage: 'send', duration_ms: expect.any(Number), error_code: 'send_not_started',
    }]);
    await page.locator('#chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', { hasText: 'APP_RETRY_ACK' })).toBeVisible({ timeout: 20_000 });
    expect((await orkas.invoke<{ conversations: unknown[] }>('conversations.list')).conversations).toHaveLength(1);
    expect(orkas.modelRequests).toHaveLength(1);
    expectAppCreationContext(orkas.modelRequests[0]);
    await expect(page.locator('#chat-history .chat-message.user')).not.toContainText('## App creation');
    // Composer resize delivery notices also occur in the pre-existing edit
    // flow. Keep them visible, reject exceptions, and verify recovery above.
    for (const notification of await page.evaluate(() => (window as any).__createRecoveryNotifications)) {
      expect(notification).toEqual({ message: 'ResizeObserver loop completed with undelivered notifications.', hasException: false });
    }
  });

  test('keeps cards and the idea draft usable across sizes and languages', async ({ modelOrkas: orkas }, testInfo) => {
    const page = orkas.page!;
    const entry = orkas.createWorkspaceFile('app-gallery/index.html', '<!doctype html><h1>My app</h1>');
    for (const title of ['Orkas · SDK 能力体验馆', '像素贪吃蛇', '霓虹贪吃蛇', '指挥官 · 智能体详情', '计算器应用', 'ROI 计算器', '长标题应用 <img src=x onerror=alert(1)> '.repeat(5)]) {
      await orkas.invoke('savedApps.saveFromPath', { path: entry, title });
    }
    await page.locator('#apps-btn').click();
    await expect(page.locator('.app-card')).toHaveCount(7);
    await expect(page.locator('.app-card img')).toHaveCount(0);
    const scrollArea = page.locator('#panel-apps .agents-grid-scroll');
    expect(await scrollArea.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.evaluate(() => (window as any).setLang('zh'));
    await page.locator('#panel-apps').screenshot({ path: testInfo.outputPath('apps-grid.png') });
    await page.locator('#apps-create-btn').click();
    const panel = page.locator('.apps-create-panel');
    const idea = panel.locator('textarea');
    await expect(panel.getByRole('heading', { name: '创建应用', exact: true })).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath('apps-create.png') });
    const draft = '家庭菜单 <img src=x onerror=alert(1)> & shopping list';
    await idea.fill(draft);
    await expect(panel.getByRole('button', { name: '取消', exact: true })).toBeVisible();
    for (const [lang, title, topic, cancelLabel] of [
      ['en', 'Create app', 'Unit converter', 'Cancel'],
      ['ja', 'アプリを作成', '単位換算', 'キャンセル'],
      ['pt', 'Criar aplicativo', 'Conversor de unidades', 'Cancelar'],
    ]) {
      await page.evaluate((language) => (window as any).setLang(language), lang);
      await expect(panel.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(panel).toContainText(topic);
      await expect(panel.getByRole('button', { name: cancelLabel, exact: true })).toBeVisible();
      await expect(panel).not.toContainText('apps.template_');
      await expect(idea).toHaveValue(draft);
      await expect(panel.locator('img')).toHaveCount(0);
    }
    await page.setViewportSize({ width: 560, height: 720 });
    await expect(panel.locator('[data-app-template="game"]')).toBeVisible();
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await panel.screenshot({ path: testInfo.outputPath('apps-create-narrow.png') });
    await panel.locator('[data-app-template="converter"]').click();
    await expect(idea).toHaveValue(/Crie um conversor de unidades/);
    await panel.locator('[data-create-cancel]').click();
    await expect(panel).toHaveCount(0);
    expect(orkas.modelRequests.length).toBe(0);
    await page.locator('#apps-btn').click();
    const grid = page.locator('#apps-grid');
    expect(await grid.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await scrollArea.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.locator('#apps-create-btn').click();
    await page.locator('.apps-create-overlay').click({ position: { x: 2, y: 2 } });
    await expect(panel).toHaveCount(0);
    await expect(page.locator('#apps-create-btn')).toBeFocused();
  });

  test('opens safely, renames, prepares an edit, persists, and deletes a saved app', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const indexPath = orkas.createWorkspaceFile(
      'e2e-app/index.html',
      '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 id="app-title">E2E App Running</h1></body></html>',
    );
    orkas.createWorkspaceFile('e2e-app/style.css', 'body { color: rgb(12, 34, 56); }');
    const saved = await orkas.invoke<{ ok: boolean; id: string; title: string }>('savedApps.saveFromPath', {
      path: indexPath,
      title: 'E2E Saved App',
    });
    expect(saved.ok).toBe(true);

    await page.locator('#apps-btn').click();
    await expect(page.locator('#panel-apps')).toHaveClass(/\bactive\b/);
    let card = page.locator(`.app-card[data-app-id="${saved.id}"]`);
    await expect(card).toContainText('E2E Saved App');
    await expect(page.locator('#apps-page-header-count')).toHaveText('1');

    const moreButton = card.locator('[data-app-more]');
    await expect(moreButton).toHaveCSS('position', 'absolute');
    await expect(moreButton).toHaveCSS('top', '12px');
    await expect(moreButton).toHaveCSS('right', '12px');
    await expect(moreButton).toBeHidden();
    await card.hover();
    await expect(moreButton).toBeVisible();
    await page.locator('.apps-page-header-title').hover();
    await expect(moreButton).toBeHidden();
    await card.focus();
    await expect(moreButton).toBeVisible();
    await page.locator('#apps-create-btn').focus();
    await expect(moreButton).toBeHidden();

    const opened = orkas.electronApp!.waitForEvent('window');
    await card.click();
    const preview = await opened;
    await preview.waitForLoadState('domcontentloaded');
    const viewer = preview.locator('.saved-app-viewer');
    await expect(viewer).toHaveClass(/\bis-open\b/);
    await expect(viewer.locator('.saved-app-viewer-title')).toHaveText('E2E Saved App');
    const appFrame = viewer.locator('.saved-app-viewer-frame');
    await expect(appFrame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    await expect(appFrame.contentFrame().locator('#app-title')).toHaveText('E2E App Running');
    expect(await appFrame.contentFrame().locator('body').evaluate(() => typeof (window as any).orkas)).toBe('undefined');
    await page.locator('#new-chat-btn').click();
    await expect(appFrame.contentFrame().locator('#app-title')).toHaveText('E2E App Running');
    await page.locator('#apps-btn').click();
    await card.click();
    expect(orkas.electronApp!.windows().filter(p => p.url().endsWith('/preview.html'))).toHaveLength(1);
    await orkas.closePreview(preview);
    await expect.poll(() => preview.isClosed()).toBe(true);

    await card.hover();
    await card.locator('[data-app-more]').click();
    await page.locator('.app-row-menu-item[data-action="rename"]').click();
    const prompt = page.locator('.ui-dialog-overlay:visible');
    await prompt.locator('.ui-dialog-input').fill('E2E Renamed App');
    await prompt.locator('[data-act="ok"]').click();
    card = page.locator(`.app-card[data-app-id="${saved.id}"]`);
    await expect(card).toContainText('E2E Renamed App');

    await card.hover();
    await card.locator('[data-app-more]').click();
    // The pre-change edit flow also emits Chromium's delivery-limit notice
    // during composer layout. Distinguish that notification from an exception
    // and verify the editable composer and source attachment still recover.
    await page.evaluate(() => {
      (window as any).__savedAppEditNotifications = [];
      window.addEventListener('error', event => {
        (window as any).__savedAppEditNotifications.push({ message: event.message, hasException: event.error != null });
      });
    });
    await page.locator('.app-row-menu-item[data-action="edit"]').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-input')).toHaveValue(/E2E Renamed App/);
    await expect(page.locator('#chat-attachments')).toContainText('app-source.md');
    const editComposer = page.locator('.chat-rich-editor[data-rich-input-id="chat-input"]');
    await expect(editComposer).toBeFocused();
    await editComposer.fill('Change the app background to blue');
    await expect(page.locator('#chat-input')).toHaveValue('Change the app background to blue');
    const notifications = await page.evaluate(() => (window as any).__savedAppEditNotifications);
    for (const notification of notifications) {
      expect(notification).toEqual({
        message: 'ResizeObserver loop completed with undelivered notifications.',
        hasException: false,
      });
    }

    const relaunchedPage = await orkas.relaunch();
    await relaunchedPage.locator('#apps-btn').click();
    card = relaunchedPage.locator(`.app-card[data-app-id="${saved.id}"]`);
    await expect(card).toContainText('E2E Renamed App');
    await card.hover();
    await card.locator('[data-app-more]').click();
    await relaunchedPage.locator('.app-row-menu-item[data-action="delete"]').click();
    await expect(relaunchedPage.locator('.ui-dialog-overlay:visible .ui-dialog-danger')).toBeVisible();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(card).toHaveCount(0);
    await expect(relaunchedPage.locator('#apps-empty')).toBeVisible();
    await expect(relaunchedPage.locator('#apps-page-header-count')).toHaveText('');
  });
});
