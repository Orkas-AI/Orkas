/**
 * Conversation task-board scheduling — real app, real bus, stubbed model.
 *
 * Scenario value (D18, plan conversation-task-board.md): a user writing
 * "@A do X. @B do Y from it." in ONE message gets serial execution with a
 * visible dependency and a real hand-off. Multi-task coordination and the
 * blocked/run-anyway recovery path stay visible on the board, then the board
 * retracts when only an ordinary single run remains.
 * The cases here reproduce live-app defects: the invisible chain handover
 * (quiescence latch) and the invisible blocked/run-anyway path (blocked
 * publication + observer attach), both found by the 2026-08-23 scheduling
 * probe, plus the new-chat landing page silently collapsing a two-agent
 * request to one (2026-08-26).
 */
import { expect, test as base } from './fixtures/orkas';
import type { Page } from '@playwright/test';

// Opening an existing-conversation fixture includes the app's cold feature
// imports and a seed turn. Give setup its own bounded budget so it cannot
// consume the assertions' time on a loaded test host. Landing-page coverage
// below deliberately does not request this fixture.
const test = base.extend<{ boardPage: Page }>({
  boardPage: [async ({ modelOrkas }, use) => {
    await use(await openConversation(modelOrkas, 'task board'));
  }, { timeout: 60_000 }],
});

async function openConversation(
  app: import('./fixtures/orkas').OrkasTestApp,
  label: string,
): Promise<import('@playwright/test').Page> {
  if (!app.page) throw new Error('Orkas renderer is unavailable');
  const page = app.page;
  app.setModelTextReplies([`ok ${label}`]);
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill(`hello ${label}`);
  await page.locator('#new-chat-send-btn').click();
  await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/, { timeout: 20_000 });
  return page;
}

async function sendMultiMention(
  page: import('@playwright/test').Page,
  text: string,
): Promise<void> {
  const input = page.locator('#chat-input');
  await input.fill(text);
  await input.dispatchEvent('input');
  // D18 UI: a two-group composer text surfaces the serial/parallel toggle.
  await expect(page.locator('#chat-seq-toggle')).toBeVisible();
  await page.locator('#chat-send-btn').click();
}

test.describe('task board scheduling (D18 serial chain)', () => {
  test.describe.configure({
    timeout: process.platform === 'win32' ? 120_000 : 60_000,
  });

  test('retracts when a serial multi-task run drains to one task', async ({
    modelOrkas, boardPage,
  }) => {
    const app = modelOrkas;
    const page = boardPage;
    const board = page.locator('#chat-task-board');
    const rows = page.locator('#chat-task-board-list .chat-queue-item');
    const before = app.modelRequests.length;

    app.setModelMode('controlled-slow');
    await sendMultiMention(page, '@ContentWriter write the intro piece. @UIDesigner build the deck from it.');
    await expect.poll(() => app.modelRequests.length, { timeout: 15_000 }).toBe(before + 1);

    // While the predecessor runs: the successor is queued and NAMES its
    // dependency on the board (not a second silent parallel run).
    await expect(board).toBeVisible({ timeout: 5_000 });
    await expect(rows).toHaveCount(2);
    await expect(page.locator('#chat-task-board-list .chat-queue-dep')).toHaveCount(1);
    // Assignment and dependency order are fixed when the task enters the
    // queue. The queued row keeps both facts visible, but exposes no selector
    // that could silently change who runs it or which result it waits for.
    const queuedRow = rows.nth(1);
    await expect(queuedRow.locator('xpath=ancestor::section[contains(@class, "chat-queue-agent-group")][1]').locator('.chat-queue-agent-name')).toHaveText('UIDesigner');
    await expect(queuedRow.locator('[data-act="task-reassign"]')).toHaveCount(0);
    await expect(queuedRow.locator('[data-act="task-after"]')).toHaveCount(0);

    // The header still supports a compact view while multiple tasks need the
    // board; expanding it restores both actionable rows.
    const header = page.locator('#chat-task-board .chat-queue-header');
    await header.click();
    await expect(page.locator('#chat-task-board-list')).toBeHidden();
    await expect(board).toBeVisible();
    await header.click();
    await expect(rows).toHaveCount(2);

    // Successor releases automatically and its turn input carries the
    // predecessor's persisted result.
    app.setModelMode('success');
    app.releaseControlledModelChunk();
    app.finishControlledModelStream();
    app.setModelTextReplies(['E2E deck built from the intro.']);
    await expect.poll(() => app.modelRequests.length, { timeout: 20_000 }).toBe(before + 2);
    const successorRequest = JSON.stringify(app.modelRequests[app.modelRequests.length - 1]);
    expect(successorRequest).toContain('predecessor-task-result');
    // Once the predecessor is terminal, the remaining ordinary running task
    // is represented by its conversation bubble and no longer needs a board.
    await expect(board).toBeHidden({ timeout: 10_000 });

    // Both replies still land in history, which remains the durable outcome
    // surface after the transient multi-task controls retract.
    await expect(page.locator('#chat-history')).toContainText('E2E deck built from the intro.', { timeout: 20_000 });
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/, { timeout: 20_000 });
    await expect(board).toBeHidden();

  });

  test('keeps ordinary admission hidden despite delayed prior-turn events and surfaces a real queue', async ({ modelOrkas, boardPage }) => {
    const app = modelOrkas;
    const page = boardPage;
    const board = page.locator('#chat-task-board');
    const rows = page.locator('#chat-task-board-list .chat-queue-item');
    const afterFirstBatch = app.modelRequests.length;
    app.setModelMode('controlled-slow');
    const input = page.locator('#chat-input');
    // Observe the whole admission interval, not just its final DOM state. A
    // normal send is born `queued` before the scheduler claims it; rendering
    // that internal transition briefly flashed the task board even though the
    // assertion below eventually saw the correct hidden state.
    await page.evaluate(() => {
      const board = document.getElementById('chat-task-board');
      if (!board) throw new Error('missing task board');
      const probe = { becameVisible: false, observer: null as MutationObserver | null };
      const inspect = () => {
        if (window.getComputedStyle(board).display !== 'none') probe.becameVisible = true;
      };
      probe.observer = new MutationObserver(inspect);
      probe.observer.observe(board, { attributes: true, attributeFilter: ['style', 'class'] });
      inspect();
      (window as any).__orkasTaskBoardFlashProbe = probe;
      const taskBoard = (window as any).TaskBoard;
      const original = taskBoard.onEvent;
      const captured: Array<{ cid: string; event: any }> = [];
      taskBoard.onEvent = (cid: string, event: any) => {
        if (event.task?.status === 'running') captured.push({ cid, event: JSON.parse(JSON.stringify(event)) });
        return original(cid, event);
      };
      (window as any).__orkasTaskBoardEventProbe = { original, captured };
    });
    await input.fill('@ContentWriter start a later long draft.');
    await input.dispatchEvent('input');
    await page.locator('#chat-send-btn').click();
    await expect.poll(() => app.modelRequests.length, { timeout: 15_000 }).toBe(afterFirstBatch + 1);
    app.setModelMode('success');
    app.releaseControlledModelChunk();
    app.finishControlledModelStream();
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/, { timeout: 20_000 });
    const priorCid = await page.locator('#conversation-list .conv-item').first().getAttribute('data-cid');
    const priorTaskId = await page.evaluate(() => (
      (window as any).__orkasTaskBoardEventProbe.captured[0]?.event.task.task_id
    ));
    expect(priorTaskId).toBeTruthy();
    await expect.poll(async () => {
      const data = await app.invoke<{ tasks: Array<{ task_id: string; status: string }> }>('groupChat.tasks.list', { cid: priorCid });
      return data.tasks.find((task) => task.task_id === priorTaskId)?.status;
    }).toBe('done');
    // Replay the actual running snapshot from a completed turn, as a slow
    // redundant observer can do after the primary stream or list has settled
    // it. The next ordinary send must not see a phantom concurrent task.
    await page.evaluate(() => {
      const probe = (window as any).__orkasTaskBoardEventProbe;
      const delayed = probe.captured[0];
      if (!delayed) throw new Error('missing captured running task event');
      // Deliver immediately before the new task event, after any reconnect
      // resync. Otherwise resync could repair the injected defect before the
      // assertion ever exercises the competing event streams.
      (window as any).TaskBoard.onEvent = (cid: string, event: any) => {
        if (cid === delayed.cid && event.type === 'task_created'
          && event.task?.task_id !== delayed.event.task.task_id) {
          (window as any).TaskBoard.onEvent = probe.original;
          probe.original(delayed.cid, delayed.event);
          probe.replayed = true;
        }
        return probe.original(cid, event);
      };
    });
    app.setModelMode('controlled-slow');
    await input.fill('@ContentWriter start the next independent draft.');
    await input.press('Enter');
    await expect.poll(() => app.modelRequests.length, { timeout: 15_000 }).toBe(afterFirstBatch + 2);
    const admissionProbe = await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const probe = (window as any).__orkasTaskBoardFlashProbe;
      probe?.observer?.disconnect();
      delete (window as any).__orkasTaskBoardFlashProbe;
      const eventProbe = (window as any).__orkasTaskBoardEventProbe;
      (window as any).TaskBoard.onEvent = eventProbe.original;
      delete (window as any).__orkasTaskBoardEventProbe;
      return { flashed: probe?.becameVisible === true, replayed: eventProbe.replayed === true };
    });
    expect(admissionProbe).toEqual({ flashed: false, replayed: true });
    await expect(board).toBeHidden();

    await input.fill('@ContentWriter queue a later revision.');
    await input.press('Enter');
    await expect(board).toBeVisible({ timeout: 5_000 });
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText('queue a later revision');

    app.setModelMode('success');
    app.releaseControlledModelChunk();
    app.finishControlledModelStream();
    await expect.poll(() => app.modelRequests.length, { timeout: 20_000 }).toBe(afterFirstBatch + 3);
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/, { timeout: 20_000 });
    await expect(board).toBeHidden({ timeout: 10_000 });
  });

  test('a two-mention message written on the new-chat landing page dispatches both agents', async ({
    modelOrkas,
  }) => {
    // Scenario value: the landing page is where most tasks start. It used to
    // be able to address exactly ONE agent — picking from the `@` list ate the
    // typed `@` and only moved the recipient chip — so a deliberate two-agent
    // request silently became a one-agent run (on-device 2026-08-26).
    const app = modelOrkas;
    if (!app.page) throw new Error('Orkas renderer is unavailable');
    const page = app.page;
    const before = app.modelRequests.length;

    await page.locator('#new-chat-btn').click();
    // The chip preview resolves names against the Agent summary cache.
    await page.evaluate(async () => {
      await (window as any).loadRendererFeature('agents');
      await (window as any).loadAgents(true, { summary: true });
    });
    app.setModelMode('slow');
    app.setModelTextReplies(['E2E intro written.', 'E2E deck built from the intro.']);

    const input = page.locator('#new-chat-input');
    await input.fill('@ContentWriter write the intro piece. @UIDesigner build the deck from it.');
    await input.dispatchEvent('input');
    // The chip is this surface's only routing preview: it must name BOTH
    // assignees rather than a single picked recipient — and the landing page
    // now surfaces the serial/parallel order choice too (D23), defaulting to
    // the adjudicated written-order chain for a two-group text.
    await expect(page.locator('#new-chat-recipient-name')).toHaveText('ContentWriter, UIDesigner');
    await expect(page.locator('#new-chat-seq-toggle')).toBeVisible();
    await expect(page.locator('#new-chat-seq-toggle')).toHaveText('Run in order');

    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);

    // Both assignees reach the board of the conversation this send created,
    // and the second one depends on the first (serial default, D18).
    const rows = page.locator('#chat-task-board-list .chat-queue-item');
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator('#chat-task-board-list .chat-queue-dep')).toHaveCount(1);

    // Both turns really ran — a single-agent regression leaves the second
    // reply (and its model request) missing.
    app.setModelMode('success');
    await expect(page.locator('#chat-history')).toContainText('E2E deck built from the intro.', { timeout: 30_000 });
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/, { timeout: 20_000 });
    expect(app.modelRequests.length).toBeGreaterThanOrEqual(before + 2);
  });

  test('runs a substantive preamble through Commander before the mentioned Agent (D22)', async ({
    modelOrkas, boardPage,
  }) => {
    const app = modelOrkas;
    const page = boardPage;
    const before = app.modelRequests.length;
    app.setModelMode('controlled-slow');

    const input = page.locator('#chat-input');
    await input.fill('写一个大纲 @ContentWriter 基于大纲写正文');
    await input.dispatchEvent('input');
    await expect(page.locator('#chat-recipient-name')).toHaveText('Commander, ContentWriter');
    await expect(page.locator('#chat-seq-toggle')).toBeVisible();
    await page.locator('#chat-send-btn').click();
    await expect.poll(() => app.modelRequests.length, { timeout: 15_000 }).toBe(before + 1);

    // Commander owns the preamble; the addressed Agent waits for its result.
    const board = page.locator('#chat-task-board');
    const rows = page.locator('#chat-task-board-list .chat-queue-item');
    await expect(board).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('写一个大纲');
    await expect(rows.nth(1)).toContainText('基于大纲写正文');
    await expect(page.locator('#chat-task-board-list .chat-queue-dep')).toHaveCount(1);

    app.setModelTextReplies(['E2E article written from the outline.']);
    app.setModelMode('success');
    app.releaseControlledModelChunk();
    app.finishControlledModelStream();
    await expect.poll(() => app.modelRequests.length, { timeout: 20_000 }).toBe(before + 2);
    const agentRequest = JSON.stringify(app.modelRequests.at(-1));
    expect(agentRequest).toContain('predecessor-task-result');
    expect(agentRequest).toContain('基于大纲写正文');
    await expect(page.locator('#chat-history')).toContainText('E2E article written from the outline.', { timeout: 30_000 });
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/, { timeout: 20_000 });
    await expect(board).toBeHidden();
  });

  test('stopping the running predecessor blocks the successor visibly; run-anyway releases it visibly', async ({
    modelOrkas, boardPage,
  }) => {
    const app = modelOrkas;
    const page = boardPage;
    const board = page.locator('#chat-task-board');
    const rows = page.locator('#chat-task-board-list .chat-queue-item');
    const before = app.modelRequests.length;

    app.setModelMode('very-slow');
    await sendMultiMention(page, '@ContentWriter slow research task. @UIDesigner deck after research.');
    await expect.poll(() => app.modelRequests.length, { timeout: 15_000 }).toBe(before + 1);
    await expect(rows).toHaveCount(2, { timeout: 5_000 });

    // Per-task Stop on the RUNNING row (first row) — §4.8: the dependent
    // successor must surface as blocked with the run-anyway decision, never
    // silently cancel and never stay painted queued.
    await rows.first().locator('[data-act="task-cancel"]').click();
    const runAnyway = page.locator('#chat-task-board-list [data-act="task-run-anyway"]');
    await expect(runAnyway).toBeVisible({ timeout: 10_000 });

    // Run anyway: the released turn is a full visible execution — reply in
    // the chat, board cleared — even though no send stream was open when the
    // user clicked (the click itself must re-attach event delivery).
    app.setModelMode('success');
    app.setModelTextReplies(['ran anyway fine.']);
    await runAnyway.click();
    await expect.poll(() => app.modelRequests.length, { timeout: 15_000 }).toBe(before + 2);
    await expect(page.locator('#chat-history')).toContainText('ran anyway fine.', { timeout: 15_000 });
    // The lone blocked row remained visible long enough to recover. Once it
    // is released into an ordinary single run, the board retracts and the
    // final result remains in chat history.
    await expect(board).toBeHidden({ timeout: 10_000 });
  });

  test('groups by agent, drags queued messages only within that agent, and removes cancelled sends', async ({ modelOrkas, boardPage }, testInfo) => {
    const app = modelOrkas;
    const page = boardPage;
    const before = app.modelRequests.length;
    const input = page.locator('#chat-input');
    const rows = page.locator('#chat-task-board-list .chat-queue-item');
    const groups = page.locator('#chat-task-board-list .chat-queue-agent-group');
    const send = async (text: string) => {
      await input.fill(text);
      await input.press('Enter');
      // This scenario prepares distinct accepted sends before testing drag
      // order. A key event alone does not await the async send: filling the
      // next draft early lets the previous acknowledgement clear that draft.
      await expect(input).toHaveValue('');
    };
    const row = (text: string) => rows.filter({ hasText: text });
    app.setModelMode('controlled-slow');
    await send('@ContentWriter draft the article.');
    await expect.poll(() => app.modelRequests.length).toBe(before + 1);
    await send('@UIDesigner draft the layout.');
    await expect.poll(() => app.modelRequests.length).toBe(before + 2);
    // Two actual unfinished tasks still surface the execution controls even
    // without queued work; stale event protection must preserve this rule.
    await expect(page.locator('#chat-task-board')).toBeVisible();
    await expect(rows).toHaveCount(2);
    await send('@ContentWriter queued first revision.');
    await send('@UIDesigner queued layout revision.');
    await send('@ContentWriter queued second revision.');
    await send('@ContentWriter discard this unsent revision.');
    await expect(rows).toHaveCount(6);
    await expect(groups.locator('.chat-queue-agent-name')).toHaveText(['ContentWriter', 'UIDesigner']);
    await expect(groups.nth(0).locator('.chat-queue-item')).toHaveCount(4);
    await expect(groups.nth(1).locator('.chat-queue-item')).toHaveCount(2);
    await expect(row('draft the article.')).toHaveAttribute('draggable', 'false');
    await expect(row('queued first revision.')).toHaveAttribute('draggable', 'true');
    await expect(row('queued first revision.').locator('.chat-queue-drag svg')).toBeVisible();
    await expect(row('draft the article.').locator('.chat-queue-drag')).toHaveCount(0);
    await expect(groups.nth(0).locator('.chat-queue-agent-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(groups.nth(1).locator('.chat-queue-agent-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(rows.locator('[data-act="task-move-up"], [data-act="task-move-down"]')).toHaveCount(0);

    const cid = await page.locator('#conversation-list .conv-item').first().getAttribute('data-cid');
    expect(cid).toBeTruthy();
    const readTasks = async () => (await app.invoke<{ tasks: Array<{ task_id: string; instruction: string; assignee: string; status: string; order?: number }> }>(
      'groupChat.tasks.list', { cid },
    )).tasks;
    const cancelledId = await row('discard this unsent revision.').getAttribute('data-task-id');
    await row('discard this unsent revision.').locator('[data-act="task-cancel"]').click();
    await expect(rows).toHaveCount(5);
    await expect(row('discard this unsent revision.')).toHaveCount(0);
    await expect(page.locator('#chat-task-board-count')).toHaveText('5');
    await page.evaluate(async (conversationId) => {
      (window as any).TaskBoard.resync(conversationId);
      await (window as any).TaskBoard.sync(conversationId);
    }, cid);
    await expect(row('discard this unsent revision.')).toHaveCount(0);
    expect((await readTasks()).find((task) => task.task_id === cancelledId)?.status).toBe('cancelled');

    // Native mouse drag exercises the actual Chromium gesture and IPC path.
    await row('queued second revision.').locator('.chat-queue-drag').dragTo(row('queued first revision.'), {
      sourcePosition: { x: 8, y: 8 }, targetPosition: { x: 130, y: 3 },
    });
    await expect(groups.nth(0).locator('.chat-queue-item')).toHaveText([
      /draft the article/, /queued second revision/, /queued first revision/,
    ]);
    const queueOrder = async () => (await readTasks()).filter((task) => task.status === 'queued')
      .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity)).map((task) => task.instruction);
    await expect.poll(queueOrder).toEqual([
      expect.stringContaining('queued second revision'),
      expect.stringContaining('queued layout revision'),
      expect.stringContaining('queued first revision'),
    ]);
    const savedOrder = await queueOrder();

    // Cross-agent and running-row drop attempts leave persisted order intact.
    await row('queued first revision.').dragTo(row('queued layout revision.'), {
      sourcePosition: { x: 130, y: 12 }, targetPosition: { x: 130, y: 3 },
    });
    await row('queued first revision.').dragTo(row('draft the article.'), {
      sourcePosition: { x: 130, y: 12 }, targetPosition: { x: 130, y: 3 },
    });
    expect(await queueOrder()).toEqual(savedOrder);
    const tasks = await readTasks();
    const first = tasks.find((task) => task.instruction.includes('queued first revision'))!;
    const other = tasks.find((task) => task.instruction.includes('queued layout revision'))!;
    expect(await app.invoke('groupChat.tasks.reorder', {
      cid, task_id: first.task_id, before_task_id: other.task_id,
    })).toMatchObject({ ok: false, error: 'different_assignee' });
    expect(await queueOrder()).toEqual(savedOrder);

    // Finish both initial turns, then hold their successors. Completed rows
    // must leave a still-visible multi-agent board, including after resync.
    app.releaseControlledModelChunk();
    app.finishControlledModelStream();
    app.setModelMode('controlled-slow');
    await expect.poll(() => app.modelRequests.length).toBe(before + 4);
    await expect(row('draft the article.')).toHaveCount(0);
    await expect(row('draft the layout.')).toHaveCount(0);
    await expect(rows).toHaveCount(3);
    await expect(page.locator('#chat-task-board-count')).toHaveText('3');
    await expect(row('queued second revision.')).toHaveAttribute('draggable', 'false');
    await expect(row('queued second revision.').locator('.chat-queue-drag')).toHaveCount(0);
    await expect(row('queued first revision.').locator('.chat-queue-drag')).toBeVisible();

    const firstToggle = groups.nth(0).locator('.chat-queue-agent-toggle');
    const secondToggle = groups.nth(1).locator('.chat-queue-agent-toggle');
    await firstToggle.click();
    await expect(firstToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(groups.nth(0).locator('.chat-queue-agent-items')).toBeHidden();
    await expect(groups.nth(1).locator('.chat-queue-agent-items')).toBeVisible();
    await expect(page.locator('#chat-task-board-count')).toHaveText('3');
    await page.evaluate((conversationId) => {
      (window as any).TaskBoard.resync(conversationId);
      (window as any).TaskBoard.render(conversationId);
    }, cid);
    await expect(firstToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(row('draft the article.')).toHaveCount(0);
    await firstToggle.focus();
    await firstToggle.press('Enter');
    await expect(groups.nth(0).locator('.chat-queue-agent-items')).toBeVisible();

    // Capture the actual renderer in the user's language, with both groups
    // visible and then one folded. Locale rerenders must preserve that choice.
    await page.evaluate(async (conversationId) => {
      await (window as any).setLang('zh');
      (window as any).TaskBoard.render(conversationId);
    }, cid);
    await input.focus();
    await page.mouse.move(0, 0);
    await page.locator('#chat-task-board-list').evaluate((list) => { list.scrollTop = 0; });
    await page.locator('#chat-task-board').screenshot({ path: testInfo.outputPath('agent-groups-expanded.png') });
    await secondToggle.click();
    await expect(groups.nth(1).locator('.chat-queue-agent-items')).toBeHidden();
    await expect(groups.nth(0).locator('.chat-queue-agent-items')).toBeVisible();
    await page.evaluate((conversationId) => { (window as any).TaskBoard.render(conversationId); }, cid);
    await expect(secondToggle).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.move(0, 0);
    await page.locator('#chat-task-board').screenshot({ path: testInfo.outputPath('agent-groups-collapsed.png') });
    await secondToggle.focus();
    // A task event can replace the group between Space down and up. Keep
    // keyboard ownership and activate once even across that live repaint.
    await page.keyboard.down('Space');
    await page.evaluate((conversationId) => { (window as any).TaskBoard.render(conversationId); }, cid);
    await expect(secondToggle).toBeFocused();
    await page.keyboard.down('Space'); // Holding the key must not toggle twice.
    await page.keyboard.up('Space');
    await expect(groups.nth(1).locator('.chat-queue-agent-items')).toBeVisible();
    await secondToggle.press('Space');
    await expect(groups.nth(1).locator('.chat-queue-agent-items')).toBeHidden();
    await secondToggle.press('Enter');
    await expect(groups.nth(1).locator('.chat-queue-agent-items')).toBeVisible();
    await expect(groups.nth(0).locator('.chat-queue-agent-items')).toBeVisible();

    app.setModelMode('success');
    app.releaseControlledModelChunk();
    app.finishControlledModelStream();
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/, { timeout: 20_000 });
    const calls = app.modelRequests.slice(before).map((request) => JSON.stringify(request));
    const firstIndex = calls.findIndex((request) => request.includes('queued first revision'));
    const secondIndex = calls.findIndex((request) => request.includes('queued second revision'));
    expect(secondIndex).toBeGreaterThanOrEqual(2);
    expect(firstIndex).toBeGreaterThan(secondIndex);
    expect(calls.some((request) => request.includes('discard this unsent revision'))).toBe(false);
    await expect(page.locator('#chat-history')).not.toContainText('discard this unsent revision');
    await expect(page.locator('#chat-task-board')).toBeHidden();
  });

  test('sends an already-queued task into its matching active turn', async ({ modelOrkas, boardPage }) => {
    const app = modelOrkas;
    const page = boardPage;
    const rows = page.locator('#chat-task-board-list .chat-queue-item');
    const before = app.modelRequests.length;

    app.setModelMode('very-slow');
    const input = page.locator('#chat-input');
    await input.fill('@ContentWriter keep working on the long draft.');
    await input.dispatchEvent('input');
    await page.locator('#chat-send-btn').click();
    await expect.poll(() => app.modelRequests.length, { timeout: 15_000 }).toBe(before + 1);
    // The pre-send composer shortcut was removed: ordinary sends queue first,
    // and only the durable queue row may offer the explicit promotion action.
    await expect(page.locator('#chat-steer-btn')).toHaveCount(0);

    // Use the ordinary composer send path so the second message first becomes a
    // durable backend queue task. The row must then restore the explicit
    // Send-now choice instead of forcing cancel + duplicate resend.
    await input.fill('@ContentWriter include the new headline immediately.');
    await input.press('Enter');
    const queuedRow = page.locator('#chat-task-board-list .chat-queue-item', {
      hasText: 'include the new headline immediately',
    });
    await expect(queuedRow).toBeVisible({ timeout: 5_000 });
    // Screenshot regression: an ordinary same-Agent queued row used to show
    // both an assignee dropdown and a "No dependency" dropdown. It now keeps
    // the send-time assignee as text, has no dependency chip, and offers only
    // actions that do not rewrite either fact.
    await expect(queuedRow.locator('xpath=ancestor::section[contains(@class, "chat-queue-agent-group")][1]').locator('.chat-queue-agent-name')).toHaveText('ContentWriter');
    await expect(queuedRow.locator('.chat-queue-dep')).toHaveCount(0);
    await expect(queuedRow.locator('[data-act="task-reassign"]')).toHaveCount(0);
    await expect(queuedRow.locator('[data-act="task-after"]')).toHaveCount(0);
    await expect(queuedRow.locator('[data-act="task-cancel"]')).toBeVisible();
    const sendNow = queuedRow.locator('[data-act="task-send-now"]');
    await expect(sendNow).toBeVisible();

    app.setModelMode('success');
    app.setModelTextReplies(['E2E queued update absorbed into the active turn.']);
    await sendNow.click();
    await expect(page.locator('#chat-history')).toContainText(
      'E2E queued update absorbed into the active turn.',
      { timeout: 20_000 },
    );
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/, { timeout: 20_000 });

    // The promoted row shares the active turn's result and is not painted as
    // a fake second execution. With no multi-task controls left, the board
    // retracts instead of keeping the original task as a permanent row.
    await expect(page.locator('#chat-task-board')).toBeHidden({ timeout: 10_000 });
  });
});
