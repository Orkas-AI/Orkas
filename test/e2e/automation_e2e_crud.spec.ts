import type { Page } from '@playwright/test';
import { expect, OrkasTestApp, test as base } from './fixtures/orkas';

const test = base.extend<{ cliModelOrkas: OrkasTestApp }>({
  cliModelOrkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { cliStub: true, modelStub: true });
    try {
      await app.launch();
      await use(app);
    } finally {
      await app.dispose();
    }
  },
});

type AutoTask = {
  id: string;
  content: string;
  title?: string;
  enabled?: boolean;
  project_id?: string;
  schedule?: {
    type: string;
    interval_hours?: number;
    weekday?: number;
    day?: number;
    hour?: number;
    minute?: number;
    at?: string;
  };
  end_condition?:
    | { type: 'date'; date: string }
    | { type: 'count'; max_runs: number };
  scheduled_run_count?: number;
  last_run_at?: string;
};

async function openAutomation(page: Page): Promise<void> {
  await page.locator('#auto-btn').click();
  await expect(page.locator('#panel-auto')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#auto-add-btn')).toBeVisible();
}

async function selectAiOption(page: Page, mountId: string, label: string): Promise<void> {
  await page.locator(`${mountId} .ai-select-trigger`).click();
  const popover = page.locator('body > .ai-select-popover:not([hidden])');
  await expect(popover).toBeVisible();
  await popover.locator('.ai-select-item').filter({ hasText: label }).click();
}

test.describe('automation', () => {
  // Persistence and schedule-transition cases cross multiple complete
  // Electron lifecycles. Windows cold relaunches can exceed the ordinary
  // one-lifecycle budget even when each user-visible assertion is prompt.
  test.describe.configure({
    timeout: process.platform === 'win32' ? 120_000 : 60_000,
  });

  test('groups global automations first and follows sidebar project renames without losing expansion', async ({ orkas }, testInfo) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const project10 = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Automation 10' });
    const project2 = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Automation 2' });
    const at = '2099-12-31T09:00:00.000Z';
    const task10 = await orkas.invoke<{ task: AutoTask }>('autoTasks.create', {
      title: 'Release checks', content: 'Check the release plan',
      project_id: project10.project.project_id, schedule: { type: 'one_time', at },
    });
    const longContent = `Summarize project work. ${'Include the relevant details. '.repeat(10)}End of the complete instruction.`;
    const task2 = await orkas.invoke<{ task: AutoTask }>('autoTasks.create', {
      title: 'Project summary', content: longContent,
      project_id: project2.project.project_id, schedule: { type: 'one_time', at },
    });
    await orkas.invoke('autoTasks.create', {
      title: 'Global summary', content: 'Review work across projects', schedule: { type: 'one_time', at },
      recipient: { kind: 'agent', id: 'e2e-release-reviewer', name: 'Release reviewer' },
    });
    const page = await orkas.relaunch();
    await openAutomation(page);
    const groupNames = page.locator('#auto-list .auto-group-name');
    await expect(groupNames).toHaveText(['Global', 'Automation 2', 'Automation 10']);
    await expect(page.locator('#projects-list .project-name')).toHaveText(['Automation 2', 'Automation 10']);
    const globalGroup = page.locator('#auto-list .auto-group[data-project-id=""]');
    const globalFolder = globalGroup.locator('.auto-group-folder-icon');
    await expect(globalFolder).toHaveCount(1);
    await expect(globalFolder).toHaveClass(/\bis-folder-open\b/);
    await expect(globalGroup.locator('.auto-row-title')).toHaveText('Global summary');
    await expect(globalGroup.locator('.auto-row-chip.is-agent')).toHaveText('Release reviewer');
    await expect(globalGroup.locator('.auto-row-chip.is-device')).toHaveText('This device');
    await globalGroup.locator('.auto-group-toggle').click();
    await expect(globalGroup.locator('.auto-group-list')).toBeHidden();
    await expect(globalGroup.locator('.auto-group-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(globalFolder).toHaveClass(/\bis-folder(?:\s|$)/);
    await globalGroup.locator('.auto-group-toggle').click();
    await expect(globalGroup.locator('.auto-row-title')).toBeVisible();
    await expect(globalGroup.locator('.auto-group-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(globalFolder).toHaveClass(/\bis-folder-open\b/);
    const group2 = page.locator(`#auto-list .auto-group[data-project-id="${project2.project.project_id}"]`);
    const group10 = page.locator(`#auto-list .auto-group[data-project-id="${project10.project.project_id}"]`);
    const row2 = group2.locator(`.auto-row[data-task-id="${task2.task.id}"]`);
    await expect(row2.locator('.auto-row-chip.is-agent')).toHaveText('Commander');
    await expect(row2.locator('.auto-row-expand, .auto-row-expand-icon')).toHaveCount(0);
    await expect(page.locator('#auto-list .auto-group-chevron')).toHaveCount(0);
    await row2.click();
    await expect(row2.locator('.auto-row-content')).toHaveText(longContent);
    await expect(row2.locator('.auto-row-convs')).toBeVisible();
    await group10.locator('.auto-group-toggle').click();
    await expect(group10.locator('.auto-group-list')).toBeHidden();

    // Rename through the actual sidebar while Automation remains visible.
    const sidebar10 = page.locator(`#projects-list .project-row[data-pid="${project10.project.project_id}"]`);
    await sidebar10.hover();
    await sidebar10.locator('[data-project-menu]').click();
    await page.locator('#project-row-menu [data-action="rename"]').click();
    const rename = page.locator('input.project-rename-input');
    await rename.fill('Automation 1');
    await rename.press('Enter');
    await expect(groupNames).toHaveText(['Global', 'Automation 1', 'Automation 2']);
    await expect(page.locator('#projects-list .project-name')).toHaveText(['Automation 1', 'Automation 2']);
    await expect(group10.locator('.auto-group-list')).toBeHidden();
    await expect(row2.locator('.auto-row-convs')).toBeVisible();

    // The page-level create action assigns the selected project to its group.
    await page.locator('#auto-add-btn').click();
    await selectAiOption(page, '#auto-project-select', 'Automation 2');
    await page.locator('#auto-task-input').fill('Prepare a project follow-up');
    await page.locator('#auto-title-input').fill('Project follow-up');
    await page.locator('#auto-enabled-input').uncheck();
    await page.locator('#auto-submit-btn').click();
    await expect(page.locator('#auto-task-dialog-overlay')).toBeHidden();
    await expect(group2.locator('.auto-row-title')).toContainText(['Project follow-up', 'Project summary']);
    const listed = await orkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list', { projectId: project2.project.project_id });
    expect(listed.tasks.find(task => task.title === 'Project follow-up')).toMatchObject({
      project_id: project2.project.project_id, enabled: false,
    });
    await expect(group10.locator('.auto-group-list')).toBeHidden();
    await expect(row2.locator('.auto-row-convs')).toBeVisible();
    await page.evaluate(async () => (window as any).setLang('zh'));
    await expect(groupNames).toHaveText(['全局', 'Automation 1', 'Automation 2']);
    await expect(group10.locator('.auto-group-list')).toBeHidden();
    await expect(row2.locator('.auto-row-convs')).toBeVisible();
    await group10.locator('.auto-group-toggle').click();
    await expect(group10.locator(`.auto-row[data-task-id="${task10.task.id}"]`)).toBeVisible();
    await row2.click();
    await page.screenshot({ path: testInfo.outputPath('automation-project-groups.png') });
    await page.setViewportSize({ width: 800, height: 850 });
    await expect(row2).toBeVisible();
    const overflow = await page.locator('#auto-list').evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('automation-project-groups-narrow.png') });
  });

  test('creates a persistent automation from the Commander model protocol', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    let page = modelOrkas.page;
    modelOrkas.setModelTextReplies([[
      '<auto-task>',
      '<action>create</action>',
      '<title>E2E Daily Wrap-up</title>',
      '<content>Review unfinished work and choose tomorrow’s first task.</content>',
      '<schedule>{"type":"daily","hour":19,"minute":45}</schedule>',
      '<recipient>{"kind":"commander"}</recipient>',
      '</auto-task>',
      '将创建每日收尾提醒。',
    ].join('\n')]);

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill('每天晚上 7:45 提醒我复盘未完成事项，并选出明天第一件事。');
    await page.locator('#new-chat-send-btn').click();

    const final = page.locator('#chat-history .chat-message.assistant [data-role="final"]').last();
    await expect(final).toContainText('Automation created: E2E Daily Wrap-up', {
      timeout: 20_000,
    });
    await expect(final).not.toContainText('<auto-task>');
    expect(modelOrkas.modelRequests).toHaveLength(1);
    const requestText = JSON.stringify(modelOrkas.modelRequests[0]);
    expect(requestText).toContain('auto_tasks');
    expect(requestText).not.toContain('**auto-tasks**');

    let listed = await modelOrkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list');
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]).toMatchObject({
      title: 'E2E Daily Wrap-up',
      content: 'Review unfinished work and choose tomorrow’s first task.',
      enabled: true,
      schedule: { type: 'daily', hour: 19, minute: 45 },
    });

    page = await modelOrkas.relaunch();
    await openAutomation(page);
    await expect(page.locator('.auto-row', { hasText: 'E2E Daily Wrap-up' })).toBeVisible();
    listed = await modelOrkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list');
    expect(listed.tasks[0]).toMatchObject({
      title: 'E2E Daily Wrap-up',
      schedule: { type: 'daily', hour: 19, minute: 45 },
    });
    expect(modelOrkas.modelRequests).toHaveLength(1);
  });

  test('fires while the runnable app is locked or idle', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;

    await modelOrkas.setSystemIdleStateForTest('locked');
    const locked = await modelOrkas.invoke<{ task: AutoTask }>('autoTasks.create', {
      content: 'Run while the screen is locked but the app remains runnable',
      title: 'E2E Locked Automation',
      schedule: { type: 'one_time', at: new Date(Date.now() + 1_500).toISOString() },
    });

    let conversations = await modelOrkas.invoke<{
      conversations: Array<{ conversation_id: string; origin_auto_task_id?: string }>;
    }>('conversations.list');
    await expect.poll(async () => {
      conversations = await modelOrkas.invoke<{
        conversations: Array<{ conversation_id: string; origin_auto_task_id?: string }>;
      }>('conversations.list');
      return conversations.conversations.filter(
        (item) => item.origin_auto_task_id === locked.task.id,
      ).length;
    }).toBe(1);

    let listed = await modelOrkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list');
    expect(listed.tasks.find((task) => task.id === locked.task.id)).toMatchObject({
      enabled: false,
      last_run_at: expect.any(String),
    });

    await modelOrkas.setSystemIdleStateForTest('idle');
    const idle = await modelOrkas.invoke<{ task: AutoTask }>('autoTasks.create', {
      content: 'Run while the system is idle but awake',
      title: 'E2E Idle Automation',
      schedule: { type: 'one_time', at: new Date(Date.now() + 1_500).toISOString() },
    });

    await expect.poll(async () => {
      conversations = await modelOrkas.invoke<{
        conversations: Array<{ conversation_id: string; origin_auto_task_id?: string }>;
      }>('conversations.list');
      return conversations.conversations.filter(
        (item) => item.origin_auto_task_id === idle.task.id,
      ).length;
    }).toBe(1);
    const idleConversationId = conversations.conversations.find(
      (item) => item.origin_auto_task_id === idle.task.id,
    )?.conversation_id;
    expect(idleConversationId).toBeTruthy();
    await expect(page.locator(
      `#conversation-list .conv-item[data-cid="${idleConversationId}"]`,
    )).toBeVisible();

    listed = await modelOrkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list');
    expect(listed.tasks.find((task) => task.id === idle.task.id)).toMatchObject({
      enabled: false,
      last_run_at: expect.any(String),
    });
    expect(conversations.conversations.filter(
      (item) => item.origin_auto_task_id === locked.task.id,
    )).toHaveLength(1);
  });

  test('runs from the row menu, opens the conversation, and preserves the next scheduled run', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const created = await modelOrkas.invoke<{ task: AutoTask }>('autoTasks.create', {
      content: 'Run this automation on demand',
      title: 'E2E Manual Run',
      enabled: false,
      schedule: { type: 'one_time', at: '2099-12-31T09:00:00.000Z' },
    });
    const taskId = created.task.id;

    await openAutomation(page);
    const row = page.locator('.auto-row', { hasText: 'Run this automation on demand' });
    await expect(row).toHaveClass(/\bis-disabled\b/);
    const more = row.locator('.auto-row-more');
    await page.locator('#auto-add-btn').hover();
    await expect(more).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(more).toHaveCSS('opacity', '1');
    const side = row.locator('.auto-row-side');
    const [rowBox, moreBox, sideBox] = await Promise.all([
      row.boundingBox(),
      more.boundingBox(),
      side.boundingBox(),
    ]);
    expect(rowBox).not.toBeNull();
    expect(moreBox).not.toBeNull();
    expect(sideBox).not.toBeNull();
    expect(moreBox!.width).toBeLessThanOrEqual(22);
    expect(moreBox!.y - rowBox!.y).toBeLessThan(12);
    expect((rowBox!.x + rowBox!.width) - (moreBox!.x + moreBox!.width)).toBeLessThan(12);
    // Schedule metadata uses only the card's normal inset. The hover-only menu
    // overlays the corner instead of reserving a permanent blank column.
    expect((rowBox!.x + rowBox!.width) - (sideBox!.x + sideBox!.width)).toBeLessThanOrEqual(18);
    await expect(row.locator('.auto-row-head')).toHaveCSS('grid-template-columns', /^\S+\s+\S+$/);
    await more.click();
    const runItem = page.locator('.auto-row-menu .auto-row-menu-item[data-action="run-now"]');
    await expect(runItem).toHaveText('Run now');
    await runItem.click();

    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-history .chat-message.user')).toContainText(
      'Run this automation on demand',
    );

    await expect.poll(async () => {
      const result = await modelOrkas.invoke<{
        conversations: Array<{ origin_auto_task_id?: string }>;
      }>('conversations.list');
      return result.conversations.filter((item) => item.origin_auto_task_id === taskId).length;
    }).toBe(1);

    const listed = await modelOrkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list');
    expect(listed.tasks[0]).toMatchObject({
      id: taskId,
      enabled: false,
      schedule: { type: 'one_time', at: '2099-12-31T09:00:00.000Z' },
    });
    expect(listed.tasks[0].last_run_at).toBeUndefined();
  });

  test('keeps the first-message @Agent target through follow-ups, relaunch, and an explicit Commander reset', async ({ cliModelOrkas: cliOrkas }) => {
    // This case intentionally crosses two Electron lifecycles. Leave bounded
    // headroom for the fixture to close both processes after the assertions.
    test.setTimeout(120_000);
    if (!cliOrkas.page) throw new Error('Orkas renderer is unavailable');
    let page = cliOrkas.page;
    const agentName = 'AutomationStickyAgentE2E';
    const createdAgent = await cliOrkas.invoke<{ agent: { agent_id: string } }>('agents.create', {
      name: agentName,
      description: 'Deterministic automation recipient.',
      category: 'general',
      runtime: { kind: 'cli', cli: 'opencode' },
    });
    const created = await cliOrkas.invoke<{ task: AutoTask }>('autoTasks.create', {
      content: 'E2E automation stays with its selected agent',
      title: 'E2E Sticky Automation Agent',
      enabled: false,
      recipient: {
        kind: 'agent',
        id: createdAgent.agent.agent_id,
        name: agentName,
      },
      schedule: { type: 'one_time', at: '2099-12-31T09:00:00.000Z' },
    });

    const fired = await cliOrkas.invoke<{ cid: string }>('autoTasks.runNow', {
      taskId: created.task.id,
    });
    await page.evaluate(async () => (window as any).loadConversations());
    await page.locator(`#conversation-list .conv-item[data-cid="${fired.cid}"]`).click();

    await expect(page.locator('#chat-history .chat-message.user').first()).toContainText(
      `@${agentName}`,
    );
    await expect(page.locator('#chat-history .chat-message.assistant', {
      hasText: 'E2E_CLI_DEFAULT_OK',
    })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#chat-recipient-name')).toHaveText(agentName);
    await expect.poll(async () => {
      const runtime = await cliOrkas.invoke<{ active_recipient?: string }>('groupChat.runtimeStatus', {
        cid: fired.cid,
      });
      return runtime.active_recipient;
    }).toBe(createdAgent.agent.agent_id);

    let cliState = cliOrkas.readCliState();
    expect(cliState.invocations).toHaveLength(1);
    expect(cliState.invocations[0].prompt).toContain('E2E automation stays with its selected agent');
    expect(cliState.invocations[0].prompt).not.toContain('## Return control to commander');

    await page.locator('#chat-input').fill('E2E automation follow-up without another mention');
    await page.locator('#chat-input').press('Enter');
    await expect.poll(() => cliOrkas.readCliState().invocations.length, {
      timeout: 30_000,
    }).toBe(2);
    await expect(page.locator('#chat-history .chat-message.assistant', {
      hasText: 'E2E_CLI_DEFAULT_OK',
    })).toHaveCount(2);
    await expect(page.locator('#chat-recipient-name')).toHaveText(agentName);

    cliState = cliOrkas.readCliState();
    expect(cliState.invocations[1].prompt).toContain(
      'E2E automation follow-up without another mention',
    );
    expect(cliState.invocations[1].prompt).not.toContain('## Return control to commander');
    const runtime = await cliOrkas.invoke<{ active_recipient?: string }>('groupChat.runtimeStatus', {
      cid: fired.cid,
    });
    expect(runtime.active_recipient).toBe(createdAgent.agent.agent_id);

    page = await cliOrkas.relaunch();
    await page.locator(`#conversation-list .conv-item[data-cid="${fired.cid}"]`).click();
    await expect(page.locator('#chat-history .chat-message.assistant', {
      hasText: 'E2E_CLI_DEFAULT_OK',
    })).toHaveCount(2);
    await expect(page.locator('#chat-recipient-name')).toHaveText(agentName);

    await page.locator('#chat-input').fill('E2E post-relaunch follow-up without a mention');
    await page.locator('#chat-input').press('Enter');
    await expect.poll(() => cliOrkas.readCliState().invocations.length, {
      timeout: 30_000,
    }).toBe(3);
    await expect(page.locator('#chat-history .chat-message.assistant', {
      hasText: 'E2E_CLI_DEFAULT_OK',
    })).toHaveCount(3);
    await expect(page.locator('#chat-recipient-name')).toHaveText(agentName);
    cliState = cliOrkas.readCliState();
    expect(cliState.invocations[2].prompt).toContain(
      'E2E post-relaunch follow-up without a mention',
    );
    expect(cliState.invocations[2].resumeSessionId).toBe(cliState.invocations[0].sessionId);

    await page.locator('#chat-recipient-chip').click();
    const picker = page.locator('#agent-picker');
    await expect(picker).toBeVisible();
    await picker.locator('.skill-picker-item[data-id="__commander__"]').click();
    await expect(page.locator('#chat-recipient-name')).toHaveText('Commander');
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    const modelRequestsBeforeReset = cliOrkas.modelRequests.length;
    cliOrkas.setModelTextReplies(['E2E Commander resumed this conversation.']);
    await page.locator('#chat-input').fill('E2E explicitly return this conversation to Commander');
    await page.locator('#chat-input').press('Enter');
    await expect.poll(async () => {
      const afterReset = await cliOrkas.invoke<{ active_recipient?: string }>('groupChat.runtimeStatus', {
        cid: fired.cid,
      });
      return afterReset.active_recipient || '';
    }).toBe('');
    await expect(page.locator('#chat-history .chat-message.assistant', {
      hasText: 'E2E Commander resumed this conversation.',
    })).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => {
      const completed = await cliOrkas.invoke<{ processing: boolean }>('groupChat.runtimeStatus', { cid: fired.cid });
      return completed.processing;
    }).toBe(false);
    expect(cliOrkas.modelRequests).toHaveLength(modelRequestsBeforeReset + 1);
    expect(cliOrkas.readCliState().invocations).toHaveLength(3);
  });

  test('routes a real due automation by stable Agent id after the Agent is renamed', async ({ cliOrkas }) => {
    if (!cliOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = cliOrkas.page;
    const oldName = 'ScheduledAgentBeforeRenameE2E';
    const newName = 'ScheduledAgentAfterRenameE2E';
    const createdAgent = await cliOrkas.invoke<{ agent: { agent_id: string } }>('agents.create', {
      name: oldName,
      description: 'Deterministic scheduled automation recipient.',
      category: 'general',
      runtime: { kind: 'cli', cli: 'opencode' },
    });
    const created = await cliOrkas.invoke<{ task: AutoTask }>('autoTasks.create', {
      content: 'E2E real timer routes by the stable Agent id',
      title: 'E2E Renamed Scheduled Agent',
      recipient: {
        kind: 'agent',
        id: createdAgent.agent.agent_id,
        name: oldName,
      },
      schedule: { type: 'one_time', at: new Date(Date.now() + 2_500).toISOString() },
    });
    await cliOrkas.invoke('agents.update', {
      agent_id: createdAgent.agent.agent_id,
      updates: { name: newName },
    });

    let conversationId = '';
    await expect.poll(async () => {
      const result = await cliOrkas.invoke<{
        conversations: Array<{ conversation_id: string; origin_auto_task_id?: string }>;
      }>('conversations.list');
      conversationId = result.conversations.find(
        (item) => item.origin_auto_task_id === created.task.id,
      )?.conversation_id || '';
      return conversationId;
    }, { timeout: 30_000 }).not.toBe('');

    await page.evaluate(async () => (window as any).loadConversations());
    await page.locator(`#conversation-list .conv-item[data-cid="${conversationId}"]`).click();
    await expect(page.locator('#chat-history .chat-message.user').first()).toContainText(
      `@${newName}`,
    );
    await expect(page.locator('#chat-history .chat-message.assistant', {
      hasText: 'E2E_CLI_DEFAULT_OK',
    })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#chat-recipient-name')).toHaveText(newName);
    const runtime = await cliOrkas.invoke<{ active_recipient?: string }>('groupChat.runtimeStatus', {
      cid: conversationId,
    });
    expect(runtime.active_recipient).toBe(createdAgent.agent.agent_id);

    const cliState = cliOrkas.readCliState();
    expect(cliState.invocations).toHaveLength(1);
    expect(cliState.invocations[0].prompt).toContain(
      'E2E real timer routes by the stable Agent id',
    );
    expect(cliState.invocations[0].prompt).not.toContain('## Return control to commander');
  });

  test('supports project-bound hourly, weekly, monthly, and one-time schedules with optional ends', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const createdProject = await orkas.invoke<{ project: { project_id: string; name: string } }>('projects.create', {
      name: 'E2E Scheduled Project',
    });
    let page = await orkas.relaunch();
    const projectId = createdProject.project.project_id;
    await page.locator('.project-row', {
      has: page.locator('.project-name', { hasText: 'E2E Scheduled Project' }),
    }).click();
    await page.locator('[data-project-tab="auto"]').click();
    await expect(page.locator('[data-project-panel="auto"]')).toBeVisible();
    await page.locator('#project-auto-add-btn').click();
    const dialog = page.locator('#auto-task-dialog-overlay');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#auto-row-project')).toBeHidden();

    await page.locator('#auto-task-input').fill('Run the project release review');
    await page.locator('#auto-title-input').fill('E2E Project Schedule');
    await selectAiOption(page, '#auto-freq-select', 'Every x hours');
    await expect(page.locator('#auto-row-hourly-interval')).toBeVisible();
    await expect(page.locator('#auto-row-time')).toBeHidden();
    await page.locator('#auto-hourly-interval-input').fill('6');
    await selectAiOption(page, '#auto-end-select', 'After a number of runs');
    await expect(page.locator('#auto-row-end-count')).toBeVisible();
    await page.locator('#auto-end-count-input').fill('3');
    await expect(page.locator('#auto-row-weekday')).toBeHidden();
    await expect(page.locator('#auto-row-monthly-day')).toBeHidden();
    await page.locator('#auto-submit-btn').click();
    await expect(dialog).toBeHidden();

    let row = page.locator('#project-auto-list .auto-row', { hasText: 'Run the project release review' });
    await expect(row).toBeVisible();
    await expect(page.locator('#project-auto-tab-count')).toHaveText('1');
    let listed = await orkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list', { projectId });
    expect(listed.tasks[0]).toMatchObject({
      project_id: projectId,
      schedule: { type: 'hourly', interval_hours: 6 },
      end_condition: { type: 'count', max_runs: 3 },
      scheduled_run_count: 0,
    });

    await row.hover();
    await row.locator('.auto-row-more').click();
    await page.locator('.auto-row-menu .auto-row-menu-item[data-action="edit"]').click();
    await selectAiOption(page, '#auto-freq-select', 'Weekly');
    await expect(page.locator('#auto-row-weekday')).toBeVisible();
    await expect(page.locator('#auto-row-time')).toBeVisible();
    await selectAiOption(page, '#auto-weekday-select', 'Wed');
    await selectAiOption(page, '#auto-hour-select', '14');
    await selectAiOption(page, '#auto-minute-select', '30');
    await page.locator('#auto-submit-btn').click();
    await expect(dialog).toBeHidden();
    listed = await orkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list', { projectId });
    expect(listed.tasks[0]).toMatchObject({
      schedule: { type: 'weekly', weekday: 3, hour: 14, minute: 30 },
      end_condition: { type: 'count', max_runs: 3 },
      scheduled_run_count: 0,
    });

    row = page.locator('#project-auto-list .auto-row', { hasText: 'Run the project release review' });
    await row.hover();
    await row.locator('.auto-row-more').click();
    await page.locator('.auto-row-menu .auto-row-menu-item[data-action="edit"]').click();
    await selectAiOption(page, '#auto-freq-select', 'Monthly');
    await expect(page.locator('#auto-row-monthly-day')).toBeVisible();
    await expect(page.locator('#auto-row-weekday')).toBeHidden();
    await selectAiOption(page, '#auto-monthly-day-select', 'Last day');
    await selectAiOption(page, '#auto-end-select', 'On a date');
    await expect(page.locator('#auto-row-end-date')).toBeVisible();
    await page.locator('#auto-end-date-input').fill('2099-12-31');
    await page.locator('#auto-submit-btn').click();
    await expect(dialog).toBeHidden();
    listed = await orkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list', { projectId });
    expect(listed.tasks[0].schedule).toMatchObject({ type: 'monthly', day: 31, hour: 14, minute: 30 });
    expect(listed.tasks[0].end_condition).toEqual({ type: 'date', date: '2099-12-31' });
    expect(listed.tasks[0].scheduled_run_count).toBeUndefined();

    row = page.locator('#project-auto-list .auto-row', { hasText: 'Run the project release review' });
    await row.hover();
    await row.locator('.auto-row-more').click();
    await page.locator('.auto-row-menu .auto-row-menu-item[data-action="edit"]').click();
    await selectAiOption(page, '#auto-freq-select', 'Once');
    await expect(page.locator('#auto-row-date')).toBeVisible();
    await expect(page.locator('#auto-row-time')).toBeVisible();
    await expect(page.locator('#auto-row-end')).toBeHidden();
    await page.locator('#auto-date-input').fill('2099-12-31');
    await page.locator('#auto-submit-btn').click();
    await expect(dialog).toBeHidden();
    listed = await orkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list', { projectId });
    expect(listed.tasks[0].schedule?.type).toBe('one_time');
    expect(listed.tasks[0].schedule?.at).toMatch(/^2099-12-31T/);
    expect(listed.tasks[0].end_condition).toBeUndefined();
    expect(listed.tasks[0].scheduled_run_count).toBeUndefined();

    page = await orkas.relaunch();
    await openAutomation(page);
    row = page.locator('.auto-row', { hasText: 'Run the project release review' });
    await expect(row).toBeVisible();
    await expect(page.locator('.auto-group', { has: row }).locator('.auto-group-name')).toHaveText('E2E Scheduled Project');

    await row.hover();
    await row.locator('.auto-row-more').click();
    await page.locator('.auto-row-menu .auto-row-menu-item[data-action="edit"]').click();
    await expect(page.locator('#auto-row-project')).toBeVisible();
    await selectAiOption(page, '#auto-project-select', 'Global');
    await page.locator('#auto-submit-btn').click();
    await expect(page.locator('#auto-task-dialog-overlay')).toBeHidden();

    const projectTasks = await orkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list', { projectId });
    expect(projectTasks.tasks).toHaveLength(0);
    const globalTasks = await orkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list', { projectId: null });
    expect(globalTasks.tasks).toHaveLength(1);
    expect(globalTasks.tasks[0].project_id).toBeUndefined();

    page = await orkas.relaunch();
    await openAutomation(page);
    row = page.locator('.auto-row', { hasText: 'Run the project release review' });
    await expect(row).toBeVisible();
    await expect(page.locator('.auto-group', { has: row }).locator('.auto-group-name')).toHaveText('Global');
    const persistedGlobal = await orkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list', {
      projectId: null,
    });
    expect(persistedGlobal.tasks[0].project_id).toBeUndefined();
  });

  test('creates, edits, disables, persists, and deletes an automatic task', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    await openAutomation(page);

    await page.locator('#auto-add-btn').click();
    const dialog = page.locator('#auto-task-dialog-overlay');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#auto-freq-select')).toHaveAttribute('data-value', 'daily');
    await expect(page.locator('#auto-row-time')).toBeVisible();
    await expect(page.locator('#auto-row-weekday')).toBeHidden();

    await page.locator('#auto-task-input').fill('Review the E2E status every morning');
    await page.locator('#auto-title-input').fill('E2E Daily Review');
    await page.locator('#auto-submit-btn').click();
    await expect(dialog).toBeHidden();

    let row = page.locator('.auto-row', { hasText: 'Review the E2E status every morning' });
    await expect(row).toBeVisible();
    const created = await orkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list');
    expect(created.tasks).toHaveLength(1);
    expect(created.tasks[0]).toMatchObject({
      content: 'Review the E2E status every morning',
      title: 'E2E Daily Review',
      enabled: true,
    });

    await row.hover();
    await row.locator('.auto-row-more').click();
    await page.locator('.auto-row-menu .auto-row-menu-item[data-action="edit"]').click();
    await expect(dialog).toBeVisible();
    await page.locator('#auto-task-input').fill('Review the E2E status every weekday');
    await page.locator('#auto-title-input').fill('E2E Weekday Review');
    await page.locator('#auto-submit-btn').click();
    row = page.locator('.auto-row', { hasText: 'Review the E2E status every weekday' });
    await expect(row).toBeVisible();

    await row.hover();
    await row.locator('.auto-row-more').click();
    await page.locator('.auto-row-menu .auto-row-menu-item[data-action="toggle-enabled"]').click();
    await expect(row).toHaveClass(/\bis-disabled\b/);
    const disabled = await orkas.invoke<{ tasks: AutoTask[] }>('autoTasks.list');
    expect(disabled.tasks[0]?.enabled).toBe(false);

    const relaunchedPage = await orkas.relaunch();
    await openAutomation(relaunchedPage);
    row = relaunchedPage.locator('.auto-row', { hasText: 'Review the E2E status every weekday' });
    await expect(row).toHaveClass(/\bis-disabled\b/);
    await row.hover();
    await row.locator('.auto-row-more').click();
    await relaunchedPage.locator('.auto-row-menu .auto-row-menu-item[data-action="delete"]').click();
    await expect(relaunchedPage.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(row).toHaveCount(0);
    await expect(relaunchedPage.locator('#auto-empty')).toBeVisible();
  });
});
