import { expect, test } from './fixtures/orkas';

test.describe('shared dialog behavior', () => {
  test.describe('async actions', () => {


    test('keeps an async danger confirmation busy, shows failure inline, and closes only after a successful retry', async ({ appPage }, testInfo) => {
      await appPage.evaluate(async () => {
        const root = window as any;
        await root.setLang('zh');
        root.__dangerAttempts = 0;
        root.__dangerResult = null;
        root.uiConfirmDanger({
          title: root.t('project.action.delete'),
          message: root.t('project.delete_confirm_body_empty'),
          dangerLabel: root.t('project.action.delete'),
          errorMessage: root.t('project.delete_failed_generic'),
          onConfirm: () => {
            root.__dangerAttempts++;
            return new Promise((resolve, reject) => { root.__finishDanger = resolve; root.__failDanger = reject; });
          },
        }).then((result: boolean) => { root.__dangerResult = result; });
      });
      const dialog = appPage.getByRole('alertdialog');
      const ok = dialog.locator('[data-act="ok"]');
      const cancel = dialog.locator('[data-act="cancel"]');
      await ok.click();
      await expect(ok).toBeDisabled();
      await expect(ok).toHaveClass(/is-loading/);
      await expect(ok).toHaveText('处理中…');
      await expect(ok).toHaveAttribute('aria-busy', 'true');
      await expect(cancel).toBeDisabled();
      await appPage.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await dialog.screenshot({ path: testInfo.outputPath('project-delete-loading.png') });
      await appPage.evaluate(() => (window as any).__failDanger(new Error('network unavailable')));
      await expect(dialog.locator('.ui-dialog-error')).toHaveText('删除项目失败，请重试');
      await expect(ok).toBeEnabled();
      await expect(cancel).toBeEnabled();
      await expect(ok).toBeFocused();
      await ok.click();
      await expect(ok).toBeDisabled();
      expect(await appPage.evaluate(() => (window as any).__dangerAttempts)).toBe(2);
      await appPage.evaluate(() => (window as any).__finishDanger());
      await expect(dialog).toHaveCount(0);
      expect(await appPage.evaluate(() => (window as any).__dangerResult)).toBe(true);
    });
  });

  test('docks native questions above the execution panel without overlapping attachments and retracts at turn end', async ({ orkas: app }, testInfo) => {
    const appPage = app.page!;
    const created = await app.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Native question layout' });
    const cid = created.conversation.conversation_id;
    await appPage.evaluate((cid) => (window as any).setView('conversation', cid, { skipLoad: true }), cid);
    await appPage.evaluate((cid) => {
      const root = window as any;
      root.appendChatMessage({ role: 'assistant', content: '正在整理项目台账，接下来继续检查新的电商渠道。' }, false, { cid });
      root.CliAsyncInput.setActiveTurns(cid, [{ actor: 'commander', turn_id: 'original', steerable: true }]);
      root._handleGroupBusEvent(cid, null, { type: 'message', turn_end: false, msg: {
        id: 'question', from: 'commander', turn_id: 'original', text: 'Choose a scope.', ts: Date.now(),
        cli_question: { questions: [{ title: '需要使用哪份台账？', options: ['当前项目中的台账', '其他文件'] }] },
      } });
      for (const [index, status] of ['running', 'queued'].entries()) {
        root.TaskBoard.onEvent(cid, { type: 'task_state', task: {
          task_id: `question-task-${index}`, status, assignee: 'commander',
          instruction: index ? '继续整理下一批渠道' : '搜集并处理新的电商渠道', created_at: Date.now(),
        } });
      }
      root._chatAttachSet(cid, Array.from({ length: 6 }, (_, index) => ({
        name: `project-notes-${index + 1}.md`, kind: 'file', status: 'ready', reused: true,
      })));
      root._chatAttachRenderChips(cid);
    }, cid);
    const card = appPage.locator('#chat-cli-questions');
    const questionRows = appPage.locator('#chat-history [data-msg-id="question"], #chat-history [data-msg-id="question-answered"]');
    const send = card.getByRole('button', { name: 'Send answer', exact: true });
    await expect(send).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    await expect(questionRows).toHaveCount(0);
    await expect(appPage.locator('#chat-history')).not.toContainText('需要使用哪份台账？');
    await expect(card.locator('.form-title')).toHaveText('Commander · Question');
    await expect(appPage.locator('#chat-history .chat-input-form')).toHaveCount(0);
    await card.getByRole('button', { name: '当前项目中的台账', exact: true }).click();
    const input = card.getByRole('textbox', { name: '需要使用哪份台账？' });
    await expect(input).toHaveValue('当前项目中的台账');
    await expect(send).toBeEnabled();
    await input.fill('使用当前 Orkas 项目中的台账');
    await appPage.evaluate(() => (window as any).setLang('zh'));
    await expect(card.getByRole('button', { name: '发送回答', exact: true })).toBeEnabled();
    await expect(card.getByRole('button', { name: '取消', exact: true })).toBeEnabled();
    await expect(card.locator('.form-title')).toHaveText('Commander · 需要你回答');
    await expect(appPage.locator('#chat-task-board')).toBeVisible();
    await expect(appPage.locator('#chat-attachments .chat-attach-chip')).toHaveCount(6);
    for (const size of [{ width: 1440, height: 1000 }, { width: 900, height: 600 }]) {
      await appPage.setViewportSize(size);
      const measure = () => appPage.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const board = rect('#chat-task-board');
        const question = rect('#chat-cli-questions');
        const attachments = rect('#chat-attachments');
        const composer = rect('#panel-conversation .chat-input-area');
        const stack = rect('.chat-composer-panels');
        const history = rect('#chat-history');
        return {
          questionTaskGap: board.top - question.bottom,
          taskAttachmentsGap: attachments.top - board.bottom,
          stackComposerGap: composer.top - stack.bottom,
          historyStackGap: stack.top - history.bottom,
          stackTop: stack.top,
          composerBottomGap: innerHeight - composer.bottom,
          stackRightGap: innerWidth - stack.right,
        };
      });
      await expect.poll(async () => {
        const gaps = await measure();
        // Fractional-DPI DOMRect subtraction can put touching edges about
        // 0.000015 CSS px below zero. Still reject any meaningful overlap.
        return Object.entries(gaps).filter(([, value]) => value < -0.0001);
      }).toEqual([]);
      await input.scrollIntoViewIfNeeded();
      await input.fill('使用当前 Orkas 项目中的台账');
      await expect(input).toBeFocused();
      const answerButton = card.getByRole('button', { name: '发送回答', exact: true });
      await answerButton.scrollIntoViewIfNeeded();
      expect(await answerButton.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })).toBe(true);
      const cancelButton = card.getByRole('button', { name: '取消', exact: true });
      await cancelButton.scrollIntoViewIfNeeded();
      expect(await cancelButton.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })).toBe(true);
      const attachment = appPage.locator('#chat-attachments .chat-attach-preview').last();
      await attachment.scrollIntoViewIfNeeded();
      expect(await attachment.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })).toBe(true);
    }
    await appPage.setViewportSize({ width: 1440, height: 1000 });
    const screenshot = testInfo.outputPath('native-question-dock.png');
    await appPage.locator('#panel-conversation').screenshot({ path: screenshot });
    await testInfo.attach('native-question-dock', { path: screenshot, contentType: 'image/png' });
    await appPage.evaluate(() => (window as any).setLang('en'));
    await appPage.evaluate((cid) => {
      (window as any).CliAsyncInput.setActiveTurns(cid, [{ actor: 'commander', turn_id: 'replacement', steerable: true }]);
    }, cid);
    await expect(card).toBeHidden();
    await expect(questionRows).toHaveCount(0);
    await appPage.evaluate((cid) => {
      const root = window as any;
      const question = {
        id: 'question-answered', from: 'commander', turn_id: 'replacement', text: 'A second question.',
        cli_question: { questions: [{ title: 'Which source?', options: ['Current project'] }] },
      };
      root.__answeredQuestionFixture = question;
      root._handleGroupBusEvent(cid, null, { type: 'message', turn_end: false, msg: question });
    }, cid);
    await expect(card).toBeVisible();
    await appPage.evaluate((cid) => {
      const root = window as any;
      root._handleGroupBusEvent(cid, null, { type: 'message', msg: {
        id: 'question-answer', from: 'user', text: 'Current project',
        cli_answer: { message_id: 'question-answered', answers: ['Current project'] },
      } });
      // The same projection is used for persisted history, including older app records.
      root.appendChatMessage(root._groupMsgToLegacy(root.__answeredQuestionFixture), false, { cid, historyHydration: true });
      root.appendChatMessage(root._groupMsgToLegacy({ ...root.__answeredQuestionFixture, id: 'question', turn_id: 'original' }), false, { cid, historyHydration: true });
    }, cid);
    await expect(card).toBeHidden();
    await expect(questionRows).toHaveCount(0);
    await expect(appPage.locator('#chat-history .cli-question-record')).toHaveCount(0);
    await expect(appPage.locator('#chat-history')).toContainText('Current project');
    await appPage.evaluate((cid) => {
      (window as any).CliAsyncInput.forget(cid);
      (window as any).uiChoice({
        title: 'Which checks?', multiple: true,
        choices: [{ id: 'unit', label: 'Unit' }, { id: 'integration', label: 'Integration' }],
      }).then((answer: unknown) => { (window as any).__nativeQuestionAnswer = answer; });
    }, cid);
    const dialog = appPage.getByRole('dialog', { name: 'Which checks?' });
    const confirm = dialog.getByRole('button', { name: 'Confirm', exact: true });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('button', { name: 'Unit', exact: true }).click();
    await dialog.getByRole('button', { name: 'Integration', exact: true }).click();
    await expect(dialog).toBeVisible();
    expect(await appPage.evaluate(() => (window as any).__nativeQuestionAnswer)).toBeUndefined();
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    expect(await appPage.evaluate(() => (window as any).__nativeQuestionAnswer)).toEqual(['unit', 'integration']);
  });

  test('docks a blocking CLI question as the shared question card and answers it there', async ({ orkas: app }) => {
    // A CLI that pauses its turn for an answer (Codex requestUserInput, Claude
    // Code AskUserQuestion) uses the same card as an asynchronous question
    // instead of a modal: same place, same controls, and the app stays usable.
    const appPage = app.page!;
    const created = await app.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Blocking question' });
    const cid = created.conversation.conversation_id;
    await appPage.evaluate((cid) => (window as any).setView('conversation', cid, { skipLoad: true }), cid);
    await appPage.evaluate((cid) => {
      const root = window as any;
      root.__e2eBlockingAnswer = null;
      root.CliAsyncInput.showConversation(cid);
      root.__e2eBlockingClose = root.CliAsyncInput.showCliInputRequest({
        requestId: 'blocking-1',
        cid,
        actorLabel: 'Orkas Codex',
        questions: [{
          id: 'target',
          header: 'Push target',
          question: 'Which remote branch should this commit go to?',
          options: [
            { label: 'Create origin/release_2.0.0', description: 'A new release branch appears on the remote.' },
            { label: 'Advance origin/release_1.7.0' },
            { label: 'Hold the commit on this machine' },
          ],
        }],
        submit: async (values: string[]) => { root.__e2eBlockingAnswer = values; return true; },
        cancel: async () => { root.__e2eBlockingAnswer = 'cancelled'; },
      });
    }, cid);

    const card = appPage.locator('#chat-cli-questions .cli-question-panel');
    await expect(card).toBeVisible();
    await expect(card.locator('.form-title')).toHaveText('Orkas Codex · Question');
    await expect(card.locator('.form-field-label'))
      .toHaveText('Push target · Which remote branch should this commit go to?');
    const answer = card.getByRole('textbox', { name: 'Which remote branch should this commit go to?' });
    await expect(answer).toHaveValue('');
    const send = card.getByRole('button', { name: 'Send answer', exact: true });
    await expect(send).toBeDisabled();

    const layout = await card.evaluate((node: Element) => {
      const options = Array.from(node.querySelectorAll('.form-field-checkgroup .btn')) as HTMLElement[];
      const box = (element: HTMLElement) => element.getBoundingClientRect();
      return {
        count: options.length,
        clipped: options.filter((option) => option.scrollWidth > Math.ceil(box(option).width)).map((o) => o.textContent),
        tallest: Math.max(...options.map((option) => Math.round(box(option).height))),
        insideCard: options.every((option) => box(option).right <= Math.ceil(box(node as HTMLElement).right)),
        widerThanTheirLabel: options.every((option) => box(option).width >= option.scrollWidth),
      };
    });
    expect(layout.count).toBe(3);
    // Every option reads in full inside the card, one line each.
    expect(layout.clipped).toEqual([]);
    expect(layout.widerThanTheirLabel).toBe(true);
    expect(layout.insideCard).toBe(true);
    expect(layout.tallest).toBeLessThan(56);

    await card.getByRole('button', { name: 'Create origin/release_2.0.0', exact: true }).click();
    await expect(answer).toHaveValue('Create origin/release_2.0.0');
    await expect(send).toBeEnabled();
    await answer.fill('Use the current branch');
    await answer.press('Shift+Enter');
    await expect(answer).toHaveValue('Use the current branch\n');
    await answer.press('x');
    await answer.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await answer.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
    expect(await appPage.evaluate(() => (window as any).__e2eBlockingAnswer)).toBeNull();
    await answer.press('Enter');

    await expect.poll(() => appPage.evaluate(() => (window as any).__e2eBlockingAnswer))
      .toEqual(['Use the current branch\nx']);
    await expect(card).toHaveCount(0);
  });

  test('lays a native question out as a wrapping option group instead of squeezing the action row', async ({
    appPage,
  }) => {
    // Reported 2026-09-09: a Claude Code AskUserQuestion with prose options
    // rendered as five narrow columns of wrapped text, with the branch names
    // clipped. Real layout is the only oracle for that, so measure it.
    await appPage.evaluate(() => {
      (window as any).__e2eQuestion = (window as any).uiChoice({
        title: 'Needs your input',
        message: 'Push target\nWhich remote branch should this commit go to?',
        choiceLayout: 'group',
        choices: [
          { id: 'option-0', label: 'Create origin/release_2.0.0' },
          { id: 'option-1', label: 'Advance origin/release_1.7.0' },
          { id: 'option-2', label: 'Hold the commit on this machine' },
          { id: 'other', label: 'Other' },
        ],
      });
    });
    const dialog = appPage.getByRole('dialog', { name: 'Needs your input' });
    await expect(dialog).toBeVisible();

    const layout = await dialog.evaluate((node: Element) => {
      const group = node.querySelector('.ui-dialog-choices');
      const options = Array.from(node.querySelectorAll('[data-act="choice"]')) as HTMLElement[];
      const box = (element: HTMLElement) => element.getBoundingClientRect();
      return {
        grouped: !!group && options.every((option) => group.contains(option)),
        actionRow: Array.from(node.querySelectorAll('.modal-actions button'))
          .map((button) => (button as HTMLElement).dataset.act),
        clipped: options
          .filter((option) => option.scrollWidth > Math.ceil(box(option).width))
          .map((option) => option.textContent),
        widerThanTheirLabel: options.every((option) => box(option).width >= option.scrollWidth),
        tallest: Math.max(...options.map((option) => Math.round(box(option).height))),
        rows: new Set(options.map((option) => Math.round(box(option).top))).size,
        insideDialog: options.every((option) => box(option).right <= Math.ceil(box(node as HTMLElement).right)),
      };
    });

    expect(layout.grouped).toBe(true);
    expect(layout.actionRow).toEqual(['cancel']);
    // Every label reads in full: nothing is cut off at the button edge.
    expect(layout.clipped).toEqual([]);
    expect(layout.widerThanTheirLabel).toBe(true);
    expect(layout.insideDialog).toBe(true);
    // Options keep one line each and wrap onto a second row instead of
    // collapsing into columns (the reported failure was ~138px tall buttons).
    expect(layout.tallest).toBeLessThan(56);
    expect(layout.rows).toBeGreaterThan(1);

    await dialog.locator('[data-act="cancel"]').click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => appPage.evaluate(() => (window as any).__e2eQuestion)).toBeNull();
  });

  test('preserves keyboard intent, accessible names, focus, and stacked decisions', async ({
    appPage,
  }) => {
    await appPage.evaluate(() => {
      const background = document.createElement('button');
      background.id = 'e2e-dialog-background';
      background.textContent = 'Background action';
      document.body.appendChild(background);
      background.focus();
      (window as any).__e2eDialogResults = [];
      (window as any).uiConfirm('Keep this item?').then((value: boolean) => {
        (window as any).__e2eDialogResults.push(['single', value]);
      });
    });

    const singleDialog = appPage.getByRole('dialog', { name: 'Keep this item?' });
    await expect(singleDialog).toBeVisible();
    const ok = singleDialog.locator('[data-act="ok"]');
    const cancel = singleDialog.locator('[data-act="cancel"]');
    await expect(ok).toBeFocused();
    await appPage.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await appPage.keyboard.press('Shift+Tab');
    await expect(ok).toBeFocused();
    await cancel.focus();
    await appPage.keyboard.press('Enter');
    await expect(singleDialog).toHaveCount(0);
    await expect.poll(() => appPage.evaluate(
      () => (window as any).__e2eDialogResults,
    )).toEqual([['single', false]]);
    await expect(appPage.locator('#e2e-dialog-background')).toBeFocused();

    await appPage.evaluate(() => {
      (window as any).uiConfirm('First stacked decision').then((value: boolean) => {
        (window as any).__e2eDialogResults.push(['first', value]);
      });
      (window as any).uiConfirm('Second stacked decision').then((value: boolean) => {
        (window as any).__e2eDialogResults.push(['second', value]);
      });
    });
    const first = appPage.getByRole('dialog', { name: 'First stacked decision' });
    const second = appPage.getByRole('dialog', { name: 'Second stacked decision' });
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();

    await appPage.keyboard.press('Escape');
    await expect(second).toHaveCount(0);
    await expect(first).toBeVisible();
    await expect.poll(() => appPage.evaluate(
      () => (window as any).__e2eDialogResults,
    )).toEqual([
      ['single', false],
      ['second', false],
    ]);

    await appPage.keyboard.press('Escape');
    await expect(first).toHaveCount(0);
    await expect.poll(() => appPage.evaluate(
      () => (window as any).__e2eDialogResults,
    )).toEqual([
      ['single', false],
      ['second', false],
      ['first', false],
    ]);
    await expect(appPage.locator('#e2e-dialog-background')).toBeFocused();
  });

  test('keeps translated cloud-data choices readable and cancellable in a small window', async ({ appPage }, testInfo) => {
    await appPage.setViewportSize({ width: 760, height: 600 });
    for (const language of ['es', 'fr', 'ko', 'de', 'ru', 'it']) {
      await appPage.evaluate(async lang => {
        const root = window as any;
        await root.setLang(lang);
        root.__localizedChoice = 'pending';
        root.uiChoice({
          title: root.t('settings.sync.disable_title'),
          message: root.t('settings.sync.disable_message_with_cloud'),
          choices: [
            { id: 'purge', label: root.t('settings.sync.disable_purge_cloud'), style: 'danger' },
            { id: 'keep', label: root.t('settings.sync.disable_keep_cloud'), style: 'primary' },
          ],
        }).then((value: unknown) => { root.__localizedChoice = value; });
      }, language);
      const dialog = appPage.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('button')).toHaveCount(3);
      expect(await dialog.evaluate(host => {
        const panel = host.getBoundingClientRect();
        return panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0 && panel.bottom <= innerHeight
          && [...host.querySelectorAll('button, .ui-dialog-title, .ui-dialog-message')].every(element => {
            const rect = element.getBoundingClientRect();
            return rect.left >= panel.left && rect.right <= panel.right
              && rect.top >= panel.top && rect.bottom <= panel.bottom
              && element.scrollWidth <= element.clientWidth + 1;
          });
      }), language).toBe(true);
      await dialog.screenshot({ path: testInfo.outputPath(`sync-choice-${language}.png`) });
      await appPage.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      expect(await appPage.evaluate(() => (window as any).__localizedChoice)).toBe(null);
    }
  });

});


test('global requests show their source task across navigation, locales and narrow windows', async ({ orkas: app }, testInfo) => {
  const page = app.page!;
  const title = '发送每周进展给项目成员 · Review the weekly release progress';
  const created = await app.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title });
  const cid = created.conversation.conversation_id;
  await page.evaluate(() => (window as any).setView('settings'));
  await page.setViewportSize({ width: 760, height: 600 });
  // Deliver the same host push that a pending operation uses. Only UI and
  // read-only title lookup are exercised; no connector or shell action runs.
  const push = async (channel: string, payload: Record<string, unknown>) => {
    await app.electronApp!.evaluate(({ BrowserWindow }, { channel, payload }) => {
      BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))!
        .webContents.send(channel, payload);
    }, { channel, payload });
  };
  await page.evaluate(() => (window as any).setLang('zh'));
  await push('connectors:action-confirm', {
    request_id: 'context-connector', cid, connector_id: 'gmail', display_name: 'Gmail',
    account_label: 'work@example.test', tool_name: 'GMAIL_SEND_EMAIL', action_name: 'GMAIL_SEND_EMAIL',
    can_allow_run: true, risk: 'H', arguments_preview: '{"subject":"Weekly progress"}',
  });
  const approval = page.locator('.bash-permission-dialog');
  await expect(approval.locator('.ui-dialog-context')).toContainText(title);
  await expect(approval).toContainText('work@example.test');
  await expect(approval).toContainText('GMAIL_SEND_EMAIL');
  await expect(approval.locator('details')).not.toHaveAttribute('open');
  await approval.screenshot({ path: testInfo.outputPath('global-permission-context-zh.png') });
  await page.evaluate(() => (window as any).setLang('en'));
  await expect(approval.locator('.ui-dialog-context')).toHaveText(`Task: ${title}`);
  await approval.locator('summary').click();
  await expect(approval.locator('pre')).toBeVisible();
  await expect(approval.locator('pre')).toContainText('Weekly progress');
  expect(await approval.evaluate(node => {
    const box = node.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
      && [...node.querySelectorAll('button, .ui-dialog-context')].every(element => element.scrollWidth <= element.clientWidth + 1);
  })).toBe(true);
  await push('connectors:action-confirm-cancelled', { request_ids: ['context-connector'] });
  await expect(approval).toHaveCount(0);

  await push('connectors:install-confirm', {
    request_id: 'context-install', cid, display_name: 'Project documents', kind: 'streamable-http',
    target: 'https://example.test/mcp',
  });
  const install = page.getByRole('dialog');
  await expect(install.locator('.ui-dialog-context')).toContainText(title);
  await expect(install).toContainText('Project documents');
  await expect(install).toContainText('https://example.test/mcp');
  await push('connectors:install-confirm-cancelled', { request_ids: ['context-install'] });
  await expect(install).toHaveCount(0);

  await push('local-agent:user-input', {
    request_id: 'context-secret', cid, agent_name: 'Orkas Codex',
    questions: [{ id: 'token', question: 'Enter the deployment token', isSecret: true }],
  });
  const question = page.getByRole('dialog');
  await expect(question.locator('.ui-dialog-context')).toContainText(title);
  await expect(question.locator('.ui-dialog-context')).toContainText('Requested by: Orkas Codex');
  await expect(question.locator('input')).toHaveAttribute('type', 'password');
  await push('local-agent:user-input_cancelled', { request_ids: ['context-secret'] });
  await expect(question).toHaveCount(0);

  await push('bash:permission', {
    request_id: 'context-long', cid, conversation_title: title.repeat(12), agent_name: 'Reviewer',
    command: 'echo ready', reasons: ['network_egress'], can_allow_run: true,
  });
  await expect(approval).toBeVisible();
  const cancel = approval.locator('[data-act="cancel"]');
  await expect(cancel).toBeInViewport();
  expect(await approval.locator('.ui-dialog-context').evaluate(node =>
    node.scrollHeight > node.clientHeight && node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await approval.screenshot({ path: testInfo.outputPath('global-permission-context-long.png') });
  await push('bash:permission_cancelled', { request_ids: ['context-long'] });
  await expect(approval).toHaveCount(0);
});

const permissionDialogTest = test;
permissionDialogTest('unknown shell approval shows decision facts before the bounded preview in a narrow window', async ({ orkas: app }, testInfo) => {
  const page = app.page!;
  await page.setViewportSize({ width: 760, height: 600 });
  await page.evaluate(() => (window as any).setLang('zh'));
  await app.electronApp!.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))!
      .webContents.send('bash:permission', {
        request_id: 'unknown-summary-ui', agent_name: 'Commander', reasons: ['sensitive_path'],
        unresolved_paths: true, can_allow_run: false,
        command: '# preparation\n'.repeat(55).slice(0, 800) + '…',
        working_directory: 'D:\\project with spaces',
        key_facts: [{ kind: 'write', operation: 'file write', target: '$out', unresolved: true,
          detail: "$out=Join-Path (Get-Location) 'result.txt'" }],
      });
  });
  const dialog = page.locator('.bash-permission-dialog');
  await expect(dialog).toContainText('Get-Location');
  await expect(dialog).toContainText('$out');
  await expect(dialog).toContainText('D:\\project with spaces');
  await expect(dialog.locator('[data-id="allow_run"]')).toHaveCount(0);
  await expect(dialog.locator('[data-id="allow_once"]')).toBeInViewport();
  const preview = dialog.locator('.bash-permission-details');
  await expect(preview).not.toHaveAttribute('open');
  await expect(preview.locator('pre')).toBeHidden();
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await dialog.screenshot({ path: testInfo.outputPath('unknown-shell-key-facts.png') });
  await preview.locator('summary').click();
  await expect(preview.locator('pre')).toBeVisible();
  expect((await preview.locator('pre').textContent())!.length).toBeLessThanOrEqual(801);
  await dialog.locator('[data-act="cancel"]').click();
  await expect(dialog).toHaveCount(0);
});
