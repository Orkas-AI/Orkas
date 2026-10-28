import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/orkas';

const CONTENT_WRITER_ID = '173d4235a431';
const DEEP_RESEARCHER_ID = '78900d8758bc';
const UI_DESIGNER_ID = 'bcfcb4921dce';

const deepResearcher = JSON.parse(readFileSync(
  path.resolve(
    __dirname,
    '../../resources/builtin/marketplace/agents/78900d8758bc/agent.json',
  ),
  'utf8',
)) as { inputs: Array<Record<string, unknown>> };

test.describe('Commander orchestration', () => {
  // These persistence cases intentionally exercise a complete second Electron
  // lifecycle. A cold Windows relaunch can take ~20 seconds after the first
  // orchestration has already completed, so retain the assertions and allow
  // enough total time for the durable-state check.
  test.describe.configure({
    timeout: process.platform === 'win32' ? 120_000 : 60_000,
  });

  for (const protocol of ['responses', 'chat'] as const) {
  test(`hands a finished deliverable to a shipped agent without an empty Commander tail (${protocol})`, async ({
    modelOrkas,
  }, testInfo) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    let page = modelOrkas.page;
    const delegatedTask = 'Write the final launch announcement with a concise title and two paragraphs.';
    const agentReply = 'E2E ContentWriter final delivery: Launch day is ready.';
    const commanderNarration = 'I am handing this launch announcement to ContentWriter now.';
    if (protocol === 'chat') {
      await modelOrkas.setChatCommentaryScenario({ reads: [], finalText: '' });
    }
    modelOrkas.setAgentHandoffScenario(CONTENT_WRITER_ID, delegatedTask, agentReply, {
      commanderNarration,
      // Hold the nested Agent at a deterministic gate so assertions cannot
      // accidentally run after the terminal cleanup and miss the live bug.
      holdAgentReply: true,
    });

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill(
      'Ask ContentWriter to produce the finished launch announcement and deliver its answer directly.',
    );
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);

    const commanderBubbles = page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
    );
    try {
      await expect(commanderBubbles.filter({ hasText: commanderNarration })).toHaveCount(1, {
        timeout: 20_000,
      });
      await expect.poll(
        () => modelOrkas.modelRequests.length,
        { timeout: 30_000 },
      ).toBe(2);
      await expect.poll(
        () => modelOrkas.hasPendingAgentHandoffReply(),
        { timeout: 30_000 },
      ).toBe(true);
      // While ContentWriter's request is deliberately still pending, the
      // narrated segment is the only Commander bubble. A process replay or
      // active-turn snapshot must not recreate the duplicate live placeholder.
      await expect(commanderBubbles).toHaveCount(1);
      await expect(page.locator('#chat-recipient-name')).toHaveText('ContentWriter');
      const process = commanderBubbles.locator('.stream-process');
      if (!(await process.evaluate((element) => (element as HTMLDetailsElement).open))) {
        await process.locator(':scope > summary').click();
      }
      await expect(commanderBubbles.locator('.stream-process-body')).toBeVisible();
      await expect(commanderBubbles.locator('.stream-process-body')).toContainText('ContentWriter');
      await expect(commanderBubbles.locator('.stream-process-body')).not.toContainText(CONTENT_WRITER_ID);
      await process.locator('.stream-process-compact-summary').click();
      await expect(process.locator('.stream-process-compact-body').getByText(/Call agent.*ContentWriter/)).toBeVisible();
      await commanderBubbles.screenshot({ path: testInfo.outputPath('delegation-agent-name.png') });

      const runningConversationId = await page.locator('#conversation-list .conv-item').first()
        .getAttribute('data-cid');
      expect(runningConversationId).toBeTruthy();
      // Switch away and back WITHOUT recreating the renderer. Unlike reload,
      // this preserves pendingConvs.loadingEl — exactly the field report where
      // the settled Commander row used to be reattached beside its canonical
      // history row while ContentWriter was still the active turn.
      await page.locator('#new-chat-btn').click();
      await page.locator(`#conversation-list .conv-item[data-cid="${runningConversationId}"]`).click();
      await expect(page.locator(
        '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      )).toHaveCount(1);
      await expect(page.locator(
        '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      )).toContainText(commanderNarration);
      await expect(page.locator(
        `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`,
      )).toHaveCount(1);

      // Recreate the renderer while the delegated Agent is still running.
      // This exercises active-turn recovery plus history rendering together,
      // the path that a terminal-only assertion completely misses.
      await page.reload();
      await page.locator(`#conversation-list .conv-item[data-cid="${runningConversationId}"]`).click();
      await expect(page.locator(
        '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      )).toHaveCount(1);
      await expect(page.locator(
        '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      )).toContainText(commanderNarration);
      await expect(page.locator(
        `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`,
      )).toHaveCount(1);
      await expect(page.locator('#chat-recipient-name')).toHaveText('ContentWriter');
    } finally {
      modelOrkas.releaseAgentHandoffReply();
    }

    const agentBubble = page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`,
    );
    await expect(agentBubble.locator('[data-role="from-chip"]')).toContainText('ContentWriter', {
      timeout: 20_000,
    });
    await expect(agentBubble.locator('[data-role="final"]')).toContainText(agentReply);
    await expect(page.locator('#chat-recipient-name')).toHaveText('Commander');
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect(commanderBubbles).toHaveCount(1);
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(2);
    expect(JSON.stringify(modelOrkas.modelRequests[1])).toContain(delegatedTask);

    const conversationId = await page.locator('#conversation-list .conv-item').first()
      .getAttribute('data-cid');
    expect(conversationId).toBeTruthy();
    const requestsBeforeRelaunch = modelOrkas.modelRequests.length;

    page = await modelOrkas.relaunch();
    await page.locator(`#conversation-list .conv-item[data-cid="${conversationId}"]`).click();
    const restoredAgentBubble = page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`,
    );
    await expect(restoredAgentBubble).toHaveCount(1);
    await expect(restoredAgentBubble).toContainText(agentReply);
    const restoredCommanderBubble = page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
    );
    await expect(restoredCommanderBubble).toHaveCount(1);
    await expect(restoredCommanderBubble).toContainText(commanderNarration);
    const restoredProcess = restoredCommanderBubble.locator('.stream-process');
    if (!(await restoredProcess.evaluate(element => (element as HTMLDetailsElement).open))) {
      await restoredProcess.locator(':scope > summary').click();
    }
    await expect(restoredCommanderBubble.locator('.stream-process-body')).toContainText('ContentWriter');
    await expect(restoredCommanderBubble.locator('.stream-process-body')).not.toContainText(CONTENT_WRITER_ID);
    await restoredCommanderBubble.locator('.stream-process-compact-summary').click();
    await expect(restoredCommanderBubble.locator('.stream-process-compact-body').getByText(/Call agent.*ContentWriter/)).toBeVisible();
    expect(modelOrkas.modelRequests).toHaveLength(requestsBeforeRelaunch);
  });
  }

  test('sends a queued correction into the same handed-off Agent turn', async ({ modelOrkas }, testInfo) => {
    const app = modelOrkas;
    if (!app.page) throw new Error('Orkas renderer is unavailable');
    const page = app.page;
    const correction = 'Include the revised launch headline.';
    app.setAgentHandoffScenario(CONTENT_WRITER_ID, 'Write the launch announcement.',
      'E2E hand-off correction delivered.', { holdAgentReply: true });
    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill('Hand the launch announcement to ContentWriter.');
    await page.locator('#new-chat-send-btn').click();
    await expect.poll(() => app.hasPendingAgentHandoffReply(), { timeout: 30_000 }).toBe(true);
    await expect(page.locator('#chat-recipient-name')).toHaveText('ContentWriter');
    const cid = await page.locator('#conversation-list .conv-item').first().getAttribute('data-cid');
    expect(cid).toBeTruthy();
    const tasks = async () => (await app.invoke<{ tasks: Array<{
      task_id: string; status: string; assignee: string; created_by: string;
      turn_id: string; result_msg_id?: string; absorbed_into_task_id?: string;
    }> }>('groupChat.tasks.list', { cid })).tasks;
    const original = (await tasks()).find(task => task.assignee === CONTENT_WRITER_ID && task.status === 'running')!;
    expect(original).toBeTruthy();
    await page.locator('#chat-input').fill(correction);
    await page.locator('#chat-input').press('Enter');
    const row = page.locator('#chat-task-board-list .chat-queue-item', { hasText: correction });
    await expect(row).toBeVisible();
    const sendNow = row.locator('[data-act="task-send-now"]');
    await expect(sendNow).toBeVisible();
    expect((await tasks()).some(task => task.status === 'queued' && task.created_by === 'user')).toBe(true);
    await page.locator('#chat-task-board').screenshot({ path: testInfo.outputPath('handoff-send-now.png') });
    await sendNow.click();
    // Sending is a persisted chat action, not a model acknowledgement. Keep
    // the provider held while checking the bubble and queue on both sides of
    // a renderer reload; the existing inference boundary stays unchanged.
    const bubble = page.locator('#chat-history .chat-message.user', { hasText: correction });
    await expect(bubble).toHaveCount(1);
    await expect(row).toHaveCount(0);
    expect(app.hasPendingAgentHandoffReply()).toBe(true);
    expect(app.modelRequests).toHaveLength(2);
    await page.screenshot({ path: testInfo.outputPath('send-now-before-model-acceptance.png') });
    await page.reload();
    await expect(bubble).toHaveCount(1);
    await expect(page.locator('#chat-task-board')).toBeHidden();
    expect(app.hasPendingAgentHandoffReply()).toBe(true);
    app.releaseAgentHandoffReply();
    await expect.poll(() => app.modelRequests.length, { timeout: 20_000 }).toBe(3);
    expect(JSON.stringify(app.modelRequests[2])).toContain(correction);
    await expect.poll(() => app.hasPendingAgentHandoffReply()).toBe(true);
    app.releaseAgentHandoffReply();
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/, { timeout: 20_000 });
    await expect(page.locator('#chat-history')).toContainText('E2E hand-off correction delivered.');
    const settled = await tasks();
    const primary = settled.find(task => task.task_id === original.task_id)!;
    const update = settled.find(task => task.absorbed_into_task_id === original.task_id)!;
    expect(primary).toMatchObject({ status: 'done', turn_id: original.turn_id });
    expect(primary.result_msg_id).toBeTruthy();
    expect(update).toMatchObject({ status: 'done', result_msg_id: primary.result_msg_id });
    await expect(page.locator('#chat-task-board')).toBeHidden();
    expect(app.modelRequests).toHaveLength(3);
  });

  test('keeps a narration-free hand-off free of Commander placeholders while the Agent runs', async ({
    modelOrkas,
  }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const delegatedTask = 'Return the final narration-free launch note.';
    const agentReply = 'E2E ContentWriter delivered the narration-free launch note.';
    modelOrkas.setAgentHandoffScenario(CONTENT_WRITER_ID, delegatedTask, agentReply, {
      holdAgentReply: true,
    });

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill(
      'Hand this directly to ContentWriter without a separate Commander announcement.',
    );
    await page.locator('#new-chat-send-btn').click();

    const commanderBubbles = page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
    );
    try {
      await expect.poll(
        () => modelOrkas.modelRequests.length,
        { timeout: 30_000 },
      ).toBe(2);
      await expect.poll(
        () => modelOrkas.hasPendingAgentHandoffReply(),
        { timeout: 30_000 },
      ).toBe(true);
      await expect(page.locator(
        `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`,
      )).toHaveCount(1);
      await expect(commanderBubbles).toHaveCount(0);

      const runningConversationId = await page.locator('#conversation-list .conv-item').first()
        .getAttribute('data-cid');
      expect(runningConversationId).toBeTruthy();
      await page.locator('#new-chat-btn').click();
      await page.locator(`#conversation-list .conv-item[data-cid="${runningConversationId}"]`).click();
      await expect(page.locator(
        `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`,
      )).toHaveCount(1);
      await expect(commanderBubbles).toHaveCount(0);
    } finally {
      modelOrkas.releaseAgentHandoffReply();
    }

    await expect(page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`,
      { hasText: agentReply },
    )).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect(commanderBubbles).toHaveCount(0);
  });

  test('resumes Commander after an interactive agent form is submitted and handed back', async ({
    modelOrkas,
  }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    let page = modelOrkas.page;
    const delegatedTask = 'Collect the research scope, then return a bounded research plan.';
    const resume = 'After the research scope is confirmed, summarize the plan for the user.';
    const researchQuestion = 'Compare enterprise AI note-taking adoption risks in 2025 and 2026.';
    const agentReply = 'E2E DeepResearcher confirmed the scope and returned a bounded plan.';
    const commanderReply = 'E2E Commander resumed and summarized the confirmed research plan.';
    const formText = [
      'I need the research question before planning.',
      '<agent-input-form>',
      JSON.stringify({ agent_id: DEEP_RESEARCHER_ID, fields: deepResearcher.inputs }),
      '</agent-input-form>',
      '<plan-interaction status="open" />',
    ].join('\n');
    modelOrkas.setInteractiveAgentResumeScenario({
      agentId: DEEP_RESEARCHER_ID,
      task: delegatedTask,
      resume,
      formText,
      handbackText: `${agentReply}\n<handback reason="completed_handoff" />`,
      commanderFinalText: commanderReply,
    });

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill(
      'Use DeepResearcher to confirm the scope, prepare a plan, and then summarize it for me.',
    );
    await page.locator('#new-chat-send-btn').click();

    const form = page.locator('#chat-history .chat-input-form');
    await expect(form).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#chat-recipient-name')).toHaveText('DeepResearcher');
    const pendingConversationId = await page.locator('#conversation-list .conv-item').first().getAttribute('data-cid');
    const callsBeforeReload = modelOrkas.modelRequests.length;
    await page.reload();
    await page.locator(`#conversation-list .conv-item[data-cid="${pendingConversationId}"]`).click();
    await expect(form).toBeVisible();
    await expect(page.locator('#chat-recipient-name')).toHaveText('DeepResearcher');
    expect(modelOrkas.modelRequests).toHaveLength(callsBeforeReload);
    const questionField = form.locator('.form-field', { hasText: 'Research question' });
    await questionField.locator('.form-field-textarea').fill(researchQuestion);
    await form.locator('.form-actions .btn-primary').click();

    await expect(form).toHaveClass(/\bis-submitted\b/);
    const researcherReply = page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${DEEP_RESEARCHER_ID}"]`,
      { hasText: agentReply },
    );
    await expect(researcherReply).toBeVisible({ timeout: 20_000 });
    const commanderBubble = page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      { hasText: commanderReply },
    );
    await expect(commanderBubble).toHaveCount(1, { timeout: 20_000 });
    await expect(commanderBubble).toBeVisible();
    await expect(page.locator('#chat-recipient-name')).toHaveText('Commander');
    await expect(page.locator('#chat-history')).not.toContainText('<handback');
    await expect(page.locator('#chat-history')).not.toContainText('<orchestration-resume');
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(4);
    expect(JSON.stringify(modelOrkas.modelRequests[2])).toContain('<agent-input-submission');
    expect(JSON.stringify(modelOrkas.modelRequests[2])).toContain(researchQuestion);
    expect(JSON.stringify(modelOrkas.modelRequests[3])).toContain('<orchestration-resume>');
    expect(JSON.stringify(modelOrkas.modelRequests[3])).toContain(resume);

    const conversationId = await page.locator('#conversation-list .conv-item').first()
      .getAttribute('data-cid');
    expect(conversationId).toBeTruthy();
    const requestsBeforeRelaunch = modelOrkas.modelRequests.length;

    page = await modelOrkas.relaunch();
    await page.locator(`#conversation-list .conv-item[data-cid="${conversationId}"]`).click();
    await expect(page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${DEEP_RESEARCHER_ID}"]`,
      { hasText: agentReply },
    )).toHaveCount(1);
    await expect(page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      { hasText: commanderReply },
    )).toHaveCount(1);
    expect(modelOrkas.modelRequests).toHaveLength(requestsBeforeRelaunch);
  });

  test('recovers a failed delegated agent from the visible retry action', async ({
    modelOrkas,
  }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    let page = modelOrkas.page;
    const delegatedTask = 'Draft the launch note and return the finished copy.';
    const recoveredReply = 'E2E ContentWriter recovered and delivered the launch note.';
    modelOrkas.setAgentHandoffRetryScenario(
      CONTENT_WRITER_ID,
      delegatedTask,
      recoveredReply,
    );

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill(
      'Ask ContentWriter for the launch note, and let me recover if its run fails.',
    );
    await page.locator('#new-chat-send-btn').click();

    const failedAgentBubble = page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"][data-failed="1"]`,
    );
    const retry = failedAgentBubble.locator('.bubble-retry-btn');
    await expect(retry).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect(
      page.locator('#chat-history .chat-message.assistant[data-from-actor="commander"]'),
    ).toHaveCount(0);
    const requestsBeforeRetry = modelOrkas.modelRequests.length;
    expect(requestsBeforeRetry).toBeGreaterThan(2);
    // After the successful Commander request, this fixture deliberately fails
    // every Agent attempt until the user invokes recovery.
    for (let index = 1; index < requestsBeforeRetry; index++) {
      modelOrkas.expectApiFailure('POST', '/api/v1/chat/completions', 500);
    }

    modelOrkas.allowAgentHandoffRetryRecovery();
    await failedAgentBubble.hover();
    await retry.click();
    const recoveredAgentBubble = page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`,
      { hasText: recoveredReply },
    );
    await expect(recoveredAgentBubble).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(requestsBeforeRetry + 1);
    await expect(
      page.locator('#chat-history .chat-message.assistant[data-from-actor="commander"]'),
    ).toHaveCount(0);

    const conversationId = await page.locator('#conversation-list .conv-item').first()
      .getAttribute('data-cid');
    expect(conversationId).toBeTruthy();
    const requestsBeforeRelaunch = modelOrkas.modelRequests.length;
    page = await modelOrkas.relaunch();
    await page.locator(`#conversation-list .conv-item[data-cid="${conversationId}"]`).click();
    await expect(page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`,
      { hasText: recoveredReply },
    )).toHaveCount(1);
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    expect(modelOrkas.modelRequests).toHaveLength(requestsBeforeRelaunch);
  });

  test('shows two dispatched agent results before Commander synthesis and restores them once', async ({
    modelOrkas,
  }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    let page = modelOrkas.page;
    const writerTask = 'Draft concise launch copy for the new onboarding flow.';
    const designerTask = 'Define the UI direction for the new onboarding flow.';
    const writerReply = 'E2E ContentWriter supplied concise onboarding launch copy.';
    const designerReply = 'E2E UIDesigner supplied an accessible onboarding UI direction.';
    const commanderReply = 'E2E Commander synthesized the copy and UI direction.';
    modelOrkas.setAgentFanoutScenario([
      {
        agentId: CONTENT_WRITER_ID,
        task: writerTask,
        finalText: writerReply,
      },
      {
        agentId: UI_DESIGNER_ID,
        task: designerTask,
        finalText: designerReply,
      },
    ], commanderReply);

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill(
      'Have ContentWriter and UIDesigner work independently, then synthesize their onboarding proposal.',
    );
    await page.locator('#new-chat-send-btn').click();

    const writerBubble = page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`,
      { hasText: writerReply },
    );
    const designerBubble = page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${UI_DESIGNER_ID}"]`,
      { hasText: designerReply },
    );
    const commanderBubble = page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      { hasText: commanderReply },
    );
    await expect(writerBubble).toBeVisible({ timeout: 20_000 });
    await expect(designerBubble).toBeVisible({ timeout: 20_000 });
    await expect(commanderBubble).toBeVisible({ timeout: 20_000 });
    // A streamed placeholder can already contain the final text a few
    // milliseconds before the bus attaches its persisted message identity.
    // Relaunch only after that durable boundary, then verify exact restoration.
    await expect(commanderBubble).toHaveAttribute('data-msg-id', /\S+/, {
      timeout: 20_000,
    });
    const actorOrder = await page.locator(
      '#chat-history .chat-message.assistant[data-from-actor]',
    ).evaluateAll((messages) => messages.map((message) => (
      (message as HTMLElement).dataset.fromActor || ''
    )));
    expect(actorOrder.lastIndexOf('commander')).toBeGreaterThan(
      actorOrder.lastIndexOf(CONTENT_WRITER_ID),
    );
    expect(actorOrder.lastIndexOf('commander')).toBeGreaterThan(
      actorOrder.lastIndexOf(UI_DESIGNER_ID),
    );
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect(page.locator('#chat-recipient-name')).toHaveText('Commander');
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(4);
    expect(JSON.stringify(modelOrkas.modelRequests)).toContain(writerTask);
    expect(JSON.stringify(modelOrkas.modelRequests)).toContain(designerTask);

    const conversationId = await page.locator('#conversation-list .conv-item').first()
      .getAttribute('data-cid');
    expect(conversationId).toBeTruthy();
    const requestsBeforeRelaunch = modelOrkas.modelRequests.length;
    page = await modelOrkas.relaunch();
    await page.locator(`#conversation-list .conv-item[data-cid="${conversationId}"]`).click();
    await expect(page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`,
      { hasText: writerReply },
    )).toHaveCount(1);
    await expect(page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${UI_DESIGNER_ID}"]`,
      { hasText: designerReply },
    )).toHaveCount(1);
    await expect(page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      { hasText: commanderReply },
    )).toHaveCount(1);
    expect(modelOrkas.modelRequests).toHaveLength(requestsBeforeRelaunch);
  });

  // Regression for the reported duplicate: working commentary before a
  // dispatch belongs to the synthesis row's process history, not a standalone
  // answer. The temporary Commander row must retire while the Agent runs and
  // must not reappear as a duplicate after settlement or restart.
  test('keeps pre-dispatch Commander commentary before Agent results and synthesis through restart', async ({
    modelOrkas,
  }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    let page = modelOrkas.page;
    const narration = 'E2E Commander is handing this to DeepResearcher for evidence work.';
    const task = 'Research the competitive landscape and report with sources.';
    const agentReply = 'E2E DeepResearcher returned the sourced competitive summary.';
    const synthesis = 'E2E Commander summarized the research into a recommendation.';
    modelOrkas.setCommanderSegmentScenario({
      narration,
      agentId: DEEP_RESEARCHER_ID,
      task,
      agentFinalText: agentReply,
      synthesis,
    });

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill(
      'Have DeepResearcher investigate the competitive landscape, then summarize it for me.',
    );
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);

    const agentBubble = page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${DEEP_RESEARCHER_ID}"]`,
      { hasText: agentReply },
    );
    const synthesisBubble = page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      { hasText: synthesis },
    );

    await expect(agentBubble).toBeVisible({ timeout: 20_000 });

    await expect(synthesisBubble).toBeVisible({ timeout: 20_000 });
    await expect(synthesisBubble).toHaveAttribute('data-msg-id', /\S+/, { timeout: 20_000 });
    const narrationBubble = page.locator('#chat-history .chat-message.assistant[data-from-actor="commander"]', { hasText: narration });
    await expect(narrationBubble).toHaveCount(1);
    await expect(narrationBubble.locator('.stream-process-body')).toBeVisible();
    await synthesisBubble.locator('.stream-process-summary').click();
    await expect(synthesisBubble.locator('.stream-process-body')).not.toContainText(narration);
    await expect(synthesisBubble).toHaveCount(1);

    // Commander keeps distinct visible dispatch segments: the narration
    // precedes the Agent; the final answer follows it without repeating text.
    const commanderKeys = await page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
    ).evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.renderKey || ''));
    expect(commanderKeys).toHaveLength(2);
    expect(commanderKeys.every((key) => key.startsWith('s:'))).toBe(true);

    // The Agent reply remains before the final Commander synthesis.
    const actorOrder = await page.locator(
      '#chat-history .chat-message.assistant[data-from-actor]',
    ).evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.fromActor || ''));
    expect(actorOrder).toEqual(['commander', DEEP_RESEARCHER_ID, 'commander']);
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);

    // Reload from persisted jsonl: the transcript must match what was streamed,
    // with no extra copy of either segment.
    const conversationId = await page.locator('#conversation-list .conv-item').first()
      .getAttribute('data-cid');
    expect(conversationId).toBeTruthy();
    const requestsBeforeRelaunch = modelOrkas.modelRequests.length;
    page = await modelOrkas.relaunch();
    await page.locator(`#conversation-list .conv-item[data-cid="${conversationId}"]`).click();
    const persistedSynthesis = page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      { hasText: synthesis },
    );
    await expect(persistedSynthesis).toHaveCount(1);
    await persistedSynthesis.locator('.stream-process-summary').click();
    await expect(persistedSynthesis.locator('.stream-process-body')).not.toContainText(narration);
    const restoredNarration = page.locator('#chat-history .chat-message.assistant[data-from-actor="commander"]', { hasText: narration });
    await expect(restoredNarration).toHaveCount(1);
    await expect(restoredNarration.locator('.stream-process-body')).toBeVisible();
    await expect(page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${DEEP_RESEARCHER_ID}"]`,
      { hasText: agentReply },
    )).toHaveCount(1);
    expect(modelOrkas.modelRequests).toHaveLength(requestsBeforeRelaunch);
  });
});
