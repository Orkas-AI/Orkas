import { expect, test } from './fixtures/orkas';

test.describe('shared dialog behavior', () => {
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
    await send.click();

    await expect.poll(() => appPage.evaluate(() => (window as any).__e2eBlockingAnswer))
      .toEqual(['Create origin/release_2.0.0']);
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
});
