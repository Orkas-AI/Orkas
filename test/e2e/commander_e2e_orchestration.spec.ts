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

  test('hands a finished deliverable to a shipped agent without an empty Commander tail', async ({
    modelOrkas,
  }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    let page = modelOrkas.page;
    const delegatedTask = 'Write the final launch announcement with a concise title and two paragraphs.';
    const agentReply = 'E2E ContentWriter final delivery: Launch day is ready.';
    const commanderNarration = 'I am handing this launch announcement to ContentWriter now.';
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

      const runningConversationId = await page.locator('#conversation-list .conv-item').first()
        .getAttribute('data-cid');
      expect(runningConversationId).toBeTruthy();
      // Recreate the renderer while the delegated Agent is still running.
      // This exercises active-turn recovery plus history rendering together,
      // the path that a terminal-only assertion completely misses.
      await page.reload();
      await page.locator(`.conv-item[data-cid="${runningConversationId}"]`).click();
      await expect(page.locator(
        '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      )).toHaveCount(1);
      await expect(page.locator(
        '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      )).toContainText(commanderNarration);
      await expect(page.locator(
        `#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`,
      )).toHaveCount(1);
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
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect(commanderBubbles).toHaveCount(1);
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(2);
    expect(JSON.stringify(modelOrkas.modelRequests[1])).toContain(delegatedTask);

    const conversationId = await page.locator('#conversation-list .conv-item').first()
      .getAttribute('data-cid');
    expect(conversationId).toBeTruthy();
    const requestsBeforeRelaunch = modelOrkas.modelRequests.length;

    page = await modelOrkas.relaunch();
    await page.locator(`.conv-item[data-cid="${conversationId}"]`).click();
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
    expect(modelOrkas.modelRequests).toHaveLength(requestsBeforeRelaunch);
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
    await page.locator(`.conv-item[data-cid="${conversationId}"]`).click();
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
    await page.locator(`.conv-item[data-cid="${conversationId}"]`).click();
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
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(4);
    expect(JSON.stringify(modelOrkas.modelRequests)).toContain(writerTask);
    expect(JSON.stringify(modelOrkas.modelRequests)).toContain(designerTask);

    const conversationId = await page.locator('#conversation-list .conv-item').first()
      .getAttribute('data-cid');
    expect(conversationId).toBeTruthy();
    const requestsBeforeRelaunch = modelOrkas.modelRequests.length;
    page = await modelOrkas.relaunch();
    await page.locator(`.conv-item[data-cid="${conversationId}"]`).click();
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

  // Regression for the reported duplicate: Commander narrates, dispatches a
  // visible agent, and that narration is persisted as its own segment while it
  // is still the live streaming row. Both halves must resolve to ONE bubble.
  // Before render keys the persisted segment could not find the row its own
  // deltas had written to and appended a second identical bubble, which stayed
  // on screen for the whole dispatch (~28 minutes in the field report).
  test('renders a pre-dispatch Commander narration exactly once through dispatch and restart', async ({
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

    const narrationBubble = page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      { hasText: narration },
    );
    const agentBubble = page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${DEEP_RESEARCHER_ID}"]`,
      { hasText: agentReply },
    );
    const synthesisBubble = page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      { hasText: synthesis },
    );

    // The narration must already be a single settled bubble while the agent is
    // still running — the duplicate used to be visible during exactly this gap.
    await expect(narrationBubble).toHaveCount(1, { timeout: 20_000 });
    await expect(narrationBubble).toHaveAttribute('data-msg-id', /\S+/, { timeout: 20_000 });
    await expect(agentBubble).toBeVisible({ timeout: 20_000 });
    await expect(narrationBubble).toHaveCount(1);

    await expect(synthesisBubble).toBeVisible({ timeout: 20_000 });
    await expect(synthesisBubble).toHaveAttribute('data-msg-id', /\S+/, { timeout: 20_000 });
    await expect(narrationBubble).toHaveCount(1);
    await expect(synthesisBubble).toHaveCount(1);

    // Each row carries its own identity, and the two Commander segments are
    // distinct rows rather than one row rendered twice.
    const commanderKeys = await page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
    ).evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.renderKey || ''));
    expect(commanderKeys).toHaveLength(2);
    expect(new Set(commanderKeys).size).toBe(2);
    expect(commanderKeys.every((key) => key.startsWith('s:'))).toBe(true);

    // Segment order survives the dispatch: narration, agent reply, synthesis.
    const actorOrder = await page.locator(
      '#chat-history .chat-message.assistant[data-from-actor]',
    ).evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.fromActor || ''));
    expect(actorOrder.indexOf('commander')).toBeLessThan(actorOrder.indexOf(DEEP_RESEARCHER_ID));
    expect(actorOrder.lastIndexOf('commander')).toBeGreaterThan(actorOrder.indexOf(DEEP_RESEARCHER_ID));
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);

    // Reload from persisted jsonl: the transcript must match what was streamed,
    // with no extra copy of either segment.
    const conversationId = await page.locator('#conversation-list .conv-item').first()
      .getAttribute('data-cid');
    expect(conversationId).toBeTruthy();
    const requestsBeforeRelaunch = modelOrkas.modelRequests.length;
    page = await modelOrkas.relaunch();
    await page.locator(`.conv-item[data-cid="${conversationId}"]`).click();
    await expect(page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      { hasText: narration },
    )).toHaveCount(1);
    await expect(page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      { hasText: synthesis },
    )).toHaveCount(1);
    await expect(page.locator(
      `#chat-history .chat-message.assistant[data-from-actor="${DEEP_RESEARCHER_ID}"]`,
      { hasText: agentReply },
    )).toHaveCount(1);
    expect(modelOrkas.modelRequests).toHaveLength(requestsBeforeRelaunch);
  });
});
