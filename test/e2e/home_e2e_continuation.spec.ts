import { expect, test } from './fixtures/orkas';
import path from 'node:path';

// Commander home (PATTERNS.md P15): an open to-do or a finished run the user
// has not opened turns the New task view into its populated state. The
// greeting and composer keep their place at the top in both states; the work
// to pick up is listed below them. Opening a run takes the user to it and it
// leaves the home; opening a to-do lands on the To-dos page on that to-do.
// The empty state's layout is covered by the landing case in
// composer_e2e_interactions.spec.ts.
test.describe('Commander home continuation', () => {

  test('expands all remaining work with accurate counts and preserves expansion on refresh', async ({ orkas, appPage }, testInfo) => {
    await appPage.setViewportSize({ width: 1280, height: 720 });
    for (let i = 0; i < 11; i += 1) {
      await orkas.invoke('projects.tasks.create', { content: `Follow-up ${i + 1}: ${'Review the customer feedback and confirm the next step. '.repeat(3)}` });
    }
    const records: Array<{ cid: string; entryPoint: string }> = [];
    for (const [entryPoint, total] of [['automation', 46], ['chat_send', 4]] as const) {
      for (let i = 0; i < total; i += 1) {
        const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: `${entryPoint} result ${i + 1}` });
        records.push({ cid: created.conversation.conversation_id, entryPoint });
      }
    }
    await appPage.evaluate((rows) => {
      for (const [i, row] of rows.entries()) (window as any)._markConversationUnread(row.cid, {
        // Legacy unread records have no stored outcome or result body.
        finishedAt: Date.now() - i * 1000, ...(i < 3 ? { status: 'completed' } : {}), entryPoint: row.entryPoint,
      });
    }, records);

    for (const [section, total] of [['todos', 11], ['automations', 46], ['tasks', 4]] as const) {
      const group = appPage.locator(`.home-group[data-section="${section}"]`);
      await expect(group.locator('.home-group-count')).toHaveText(String(total));
      await expect(group.locator('.home-row:visible')).toHaveCount(3);
      const toggle = group.locator('[data-home-toggle]');
      await expect(toggle).toHaveText(`Show ${total - 3} more`);
      await toggle.focus();
      await appPage.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(group.locator('.home-row:visible')).toHaveCount(total);
      if (section !== 'todos') {
        await expect(group.locator('.home-row-status.is-completed')).toHaveCount(total);
        await expect(group.locator('.home-row-status.is-unknown')).toHaveCount(0);
      }
      await group.locator('.home-row').last().scrollIntoViewIfNeeded();
      await expect(group.locator('.home-row').last()).toBeInViewport();
      if (section === 'automations') await appPage.screenshot({ path: testInfo.outputPath('home-legacy-results-completed-en.png') });
      await toggle.click();
      await expect(group.locator('.home-row:visible')).toHaveCount(3);
      await expect(toggle).toHaveText(`Show ${total - 3} more`);
    }

    const todos = appPage.locator('.home-group[data-section="todos"]');
    await todos.locator('[data-home-toggle]').click();
    await orkas.invoke('projects.tasks.create', { content: 'A follow-up added while the list is expanded' });
    await expect(todos.locator('.home-group-count')).toHaveText('12');
    await expect(todos.locator('[data-home-toggle]')).toHaveAttribute('aria-expanded', 'true');
    await expect(todos.locator('.home-row:visible')).toHaveCount(12);
    await todos.locator('[data-home-toggle]').click();
    await todos.scrollIntoViewIfNeeded();
    await appPage.screenshot({ path: testInfo.outputPath('home-folded-en-1280.png') });

    await appPage.evaluate(async () => (window as any).setLang('zh'));
    await appPage.setViewportSize({ width: 960, height: 640 });
    await expect(todos.locator('[data-home-toggle]')).toHaveText('展开其余 9 条');
    await todos.locator('[data-home-toggle]').click();
    await todos.scrollIntoViewIfNeeded();
    await appPage.screenshot({ path: testInfo.outputPath('home-expanded-zh-960.png') });
    await todos.locator('.home-row').last().scrollIntoViewIfNeeded();
    await appPage.screenshot({ path: testInfo.outputPath('home-expanded-zh-footer.png') });
    await todos.locator('[data-home-toggle]').click();
    await expect(todos.locator('.home-row:visible')).toHaveCount(3);
  });

  test('lists open work below a composer that keeps its place, and drops a run once it is opened', async ({ orkas, appPage }) => {
    await appPage.setViewportSize({ width: 1280, height: 720 });
    const panel = appPage.locator('#panel-new-chat');
    await expect(panel).toHaveAttribute('data-home-state', 'empty');
    await expect(appPage.locator('.home-paths')).toBeVisible();
    await expect(appPage.locator('#home-work')).toBeHidden();
    // Layout position, so the composer's focus lift transition does not count.
    const composerTop = () => panel.locator('.new-chat-input-area').evaluate((element) => (element as HTMLElement).offsetTop);
    const emptyComposerTop = await composerTop();

    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', {
      title: 'Weekly competitor brief',
    });
    const cid = created.conversation.conversation_id;
    await orkas.invoke('projects.tasks.create', { content: 'Confirm the pricing table\nDetails in the brief' });
    // What the sidebar records when a run finishes while the user is elsewhere.
    await appPage.evaluate((id) => (window as any)._markConversationUnread(id, {
      finishedAt: Date.now(), status: 'failed', entryPoint: 'chat_send',
    }), cid);

    await expect(panel).toHaveAttribute('data-home-state', 'populated');
    const todos = appPage.locator('.home-group[data-section="todos"]');
    const tasks = appPage.locator('.home-group[data-section="tasks"]');
    await expect(todos.locator('.home-row-title')).toHaveText(['Confirm the pricing table']);
    await expect(tasks.locator('.home-row-title')).toHaveText(['Weekly competitor brief']);
    await expect(tasks.locator('.home-row-action')).toHaveText('See why');
    await expect(appPage.locator('.home-group[data-section="automations"]')).toHaveCount(0);
    await expect(appPage.locator('#new-chat-scenarios')).toBeHidden();
    await expect(appPage.locator('.home-paths')).toBeHidden();

    const layout = await appPage.evaluate(() => {
      const landing = document.querySelector('#panel-new-chat .new-chat-center')!.getBoundingClientRect();
      const greeting = document.querySelector('#panel-new-chat .new-chat-header')!.getBoundingClientRect();
      const composer = document.querySelector('#panel-new-chat .new-chat-input-area')!.getBoundingClientRect();
      const send = document.getElementById('new-chat-send-btn')!.getBoundingClientRect();
      const work = document.getElementById('home-work')!.getBoundingClientRect();
      return {
        greetingOnScreen: greeting.height > 0 && greeting.top >= landing.top,
        composerOnScreen: composer.top >= landing.top && composer.bottom <= landing.bottom,
        sendOnScreen: send.bottom <= landing.bottom,
        workBelowComposer: work.top >= composer.bottom,
      };
    });
    expect(layout).toEqual({ greetingOnScreen: true, composerOnScreen: true, sendOnScreen: true, workBelowComposer: true });
    // The state change did not move the composer.
    expect(await composerTop()).toBe(emptyComposerTop);

    await tasks.locator('.home-row').click();
    await expect(appPage.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await appPage.locator('#new-chat-btn').click();
    await expect(panel).toHaveClass(/\bactive\b/);
    // Opened means read: it is gone from the home, the to-do stays.
    await expect(appPage.locator('.home-group[data-section="tasks"]')).toHaveCount(0);
    await expect(todos.locator('.home-row')).toHaveCount(1);
    await expect(panel).toHaveAttribute('data-home-state', 'populated');

    await todos.locator('.home-row').click();
    await expect(appPage.locator('#panel-todos')).toHaveClass(/\bactive\b/);
    await expect(appPage.locator('#todos-content .project-todo-item.is-highlighted')).toHaveCount(1);
  });

  for (const language of ['en', 'zh']) {
    test(`opens linked to-dos on their cards and keeps the conversation as a card action (${language})`, async ({ orkas }, testInfo) => {
      const page = orkas.page!;
      await page.evaluate(lang => (window as any).setLang(lang), language);
      await page.setViewportSize({ width: language === 'en' ? 1440 : 1024, height: language === 'en' ? 900 : 720 });
      const { project } = await orkas.invoke<any>('projects.create', { name: language === 'en' ? 'Release checks' : '发布核对' });
      const linked: Array<{ pid: string; tid: string; cid: string; title: string }> = [];
      for (const pid of ['', project.project_id]) {
        const title = pid ? 'Project execution history' : 'Global execution history';
        const { conversation } = await orkas.invoke<any>('conversations.create', { title, projectId: pid });
        const { task } = await orkas.invoke<any>('projects.tasks.create', { projectId: pid, status: 'progress',
          content: language === 'en'
            ? 'Review installation and cross-device synchronization before completing the release checklist'
            : '核对安装流程与多设备同步状态，确认发布检查清单中的问题已处理完成' });
        linked.push({ pid, tid: task.id, cid: conversation.conversation_id, title });
      }
      // Represent prior successful executions without running an agent. The
      // actual task module saves these facts in the isolated installation.
      await orkas.electronApp!.evaluate(async (_electron, input) => {
        const load = (process as any).mainModule.require.bind((process as any).mainModule);
        const path = load('node:path');
        const uid = load(path.join(input.sourceRoot, 'features/users.ts')).getActiveUserId();
        const { updateTask } = load(path.join(input.sourceRoot, 'features/project_tasks.ts'));
        for (const row of input.linked) {
          const result = await updateTask(uid, row.pid, row.tid, { origin_cid: row.cid });
          if (!result.ok) throw new Error('Could not seed the prior execution link');
        }
      }, { sourceRoot: path.resolve(__dirname, '../../src/main'), linked });

      for (const row of linked) {
        await page.locator('#new-chat-btn').click();
        // The page focuses its composer shortly after entry. Start keyboard
        // navigation after that transition rather than racing its focus.
        await expect(page.locator('#new-chat-input')).toBeFocused();
        const shortcut = page.locator(`[data-home-todo="${row.tid}"]`);
        await expect(shortcut).toBeVisible();
        if (row.pid) await page.screenshot({ path: testInfo.outputPath(`home-linked-todos-${language}.png`) });
        await shortcut.press('Enter');
        await expect(page.locator('#panel-todos')).toHaveClass(/\bactive\b/);
        const card = page.locator(`#todos-content .project-todo-item[data-tid="${row.tid}"]`);
        await expect(card).toHaveClass(/\bis-highlighted\b/);
        await expect(card).toBeInViewport();
        if (row.pid) await page.screenshot({ path: testInfo.outputPath(`home-todo-card-${language}.png`) });

        // A collapsed column must still reveal the target after a repeat visit.
        await page.locator('#todos-content .todo-column.is-progress .todo-collapse').click();
        await expect(card).toBeHidden();
        await page.locator('#new-chat-btn').click();
        await shortcut.click();
        await expect(card).toBeVisible();
        await expect(card).toHaveClass(/\bis-highlighted\b/);
        const conversation = card.locator('[data-action="todo-conversation"]');
        await expect(conversation).toBeVisible();
        await conversation.press('Enter');
        await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
        await expect(page.locator('#chat-header-title')).toHaveText(row.title);
      }
    });
  }
});
