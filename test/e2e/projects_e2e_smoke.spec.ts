import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type OrkasTestApp } from './fixtures/orkas';

async function createProject(orkas: OrkasTestApp, name: string): Promise<void> {
  if (!orkas.page) throw new Error('Orkas renderer is unavailable');
  const page = orkas.page;
  const input = page.locator('#project-create-input');
  const row = page.locator('.project-row', {
    has: page.locator('.project-name', { hasText: name }),
  });
  const title = page.locator('#project-detail-title');
  const projectExists = async (): Promise<boolean> => {
    const result = await orkas.invoke<{ projects: Array<{ name: string }> }>('projects.list');
    return result.projects.some((project) => project.name === name);
  };
  // Project data can finish its initial refresh just after the shell becomes
  // ready. Retry the user action if that refresh replaces the inline editor,
  // but consult persisted state first so a delayed renderer update never turns
  // a successful attempt into a duplicate create.
  await expect(async () => {
    if (!await projectExists()) {
      if (!await input.isVisible()) await page.locator('#projects-add-btn').click();
      await input.fill(name);
      // Enter removes the inline editor synchronously after a successful create.
      // Send it through the page keyboard so Playwright does not keep waiting on
      // the locator action after its target has already been detached.
      await input.focus();
      await page.keyboard.press('Enter');
      await expect.poll(projectExists, { timeout: 3_000 }).toBe(true);
    }
    await expect(row).toHaveCount(1, { timeout: 3_000 });
    if (await title.textContent() !== name) {
      // Background project refresh can replace the row during the click.
      // Keep each attempt short so the outer result-based retry can reacquire it.
      await row.click({ timeout: 2_000 });
      await expect(title).toHaveText(name, { timeout: 3_000 });
    }
  }).toPass({ timeout: process.platform === 'win32' ? 30_000 : 20_000 });
  await expect(page.locator('#project-detail-title')).toHaveText(name);
  await expect(page.locator('.project-name', { hasText: name })).toHaveCount(1);
}

test.describe('projects', () => {
  test('creates a project and keeps it after an app relaunch', async ({ orkas }) => {
    const projectName = 'E2E Persistent Project';
    await createProject(orkas, projectName);

    const relaunchedPage = await orkas.relaunch();
    const projectRow = relaunchedPage.locator('.project-row', {
      has: relaunchedPage.locator('.project-name', { hasText: projectName }),
    });
    await expect(projectRow).toHaveCount(1);
    await projectRow.click();
    await expect(relaunchedPage.locator('#panel-project')).toHaveClass(/\bactive\b/);
    await expect(relaunchedPage.locator('#project-detail-title')).toHaveText(projectName);
  });

  test('persists project instructions, memory, and to-do state across a relaunch', async ({ orkas }) => {
    const projectName = 'E2E Project Context';
    await createProject(orkas, projectName);
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    let page = orkas.page;

    const instructions = page.locator('#project-instructions-input');
    await expect(instructions).toBeEnabled();
    await instructions.fill('Always verify generated artifacts before reporting completion.');
    await page.locator('#project-instructions-save-btn').click();
    await expect(page.locator('#project-instructions-save-btn')).toBeDisabled();

    await page.locator('[data-project-side-tabs="context"] [data-project-side-tab="memory"]').click();
    await expect(page.locator('[data-project-side-panel="memory"]')).toBeVisible();
    await page.locator('#project-memory-add-btn').click();
    await page.locator('#project-memory-editor-input').fill('The release checklist is the source of truth.');
    await page.locator('#project-memory-editor-save').click();
    await expect(page.locator('.project-memory-item', { hasText: 'The release checklist is the source of truth.' })).toBeVisible();

    await page.locator('#project-todo-add-btn').click();
    await page.locator('#project-todo-input').fill('Run the desktop E2E regression');
    await page.locator('#project-todo-save').click();
    let todo = page.locator('.project-todo-item', { hasText: 'Run the desktop E2E regression' });
    await expect(todo).toHaveAttribute('data-status', 'todo');
    await todo.locator('.project-todo-status').click();
    await expect(todo).toHaveAttribute('data-status', 'done');

    page = await orkas.relaunch();
    const projectRow = page.locator('.project-row', {
      has: page.locator('.project-name', { hasText: projectName }),
    });
    await projectRow.click();
    await expect(page.locator('#project-instructions-input')).toHaveValue(
      'Always verify generated artifacts before reporting completion.',
    );
    await page.locator('[data-project-side-tabs="context"] [data-project-side-tab="memory"]').click();
    const memory = page.locator('.project-memory-item', { hasText: 'The release checklist is the source of truth.' });
    await expect(memory).toBeVisible();
    todo = page.locator('.project-todo-item', { hasText: 'Run the desktop E2E regression' });
    await expect(todo).toHaveAttribute('data-status', 'done');

    await todo.locator('[data-action="todo-delete"]').click();
    await expect(todo).toHaveCount(0);
    await memory.locator('[data-action="project-memory-delete"]').click();
    await expect(page.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(memory).toHaveCount(0);
  });

  test('uploads, previews, persists, and deletes a project Library file', async ({ orkas }) => {
    const projectName = 'E2E Project Library';
    const fileName = 'E2E project source.md';
    const source = orkas.createFixtureFile(fileName, '# Project Library\n\nUnique project-only preview body.\n');
    await createProject(orkas, projectName);
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    let page = orkas.page;

    await page.locator('[data-project-side-tabs="resources"] [data-project-side-tab="files"]').click();
    await expect(page.locator('[data-project-side-panel="files"]')).toBeVisible();
    await orkas.selectFilesOnNextDialog([source]);
    await page.locator('#project-library-root-menu-btn').click();
    await page.locator('#project-file-row-menu [data-action="upload"]').click();

    let row = page.locator(`.project-file-row[data-project-file="${fileName}"]`);
    await expect(row).toBeVisible();
    await expect(page.locator('#project-detail-files-count')).toHaveText('1');
    await row.locator(':scope > .skill-tree-node').click();
    const viewer = page.locator('#project-library-viewer-modal');
    await expect(viewer).toHaveClass(/\bopen\b/);
    await expect(page.locator('#project-library-editor-path')).toHaveText(fileName);
    await expect(page.locator('#project-library-viewer-body')).toContainText('Unique project-only preview body.');
    await viewer.locator('[data-action="project-library-viewer-close"]').click();
    await expect(viewer).not.toHaveClass(/\bopen\b/);

    page = await orkas.relaunch();
    await page.locator('.project-row', {
      has: page.locator('.project-name', { hasText: projectName }),
    }).click();
    await page.locator('[data-project-side-tabs="resources"] [data-project-side-tab="files"]').click();
    row = page.locator(`.project-file-row[data-project-file="${fileName}"]`);
    await expect(row).toBeVisible();
    await row.hover();
    await row.locator('[data-action="project-file-menu"]').click();
    await page.locator('#project-file-row-menu [data-action="delete"]').click();
    await expect(page.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('#project-detail-files-count')).toBeEmpty();
  });

  test('adds an attachment from the project composer and adopts it into the new conversation', async ({
    modelOrkas,
  }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const projectName = 'E2E Project Composer Attachment';
    const fileName = 'E2E project conversation brief.md';
    const sourcePath = modelOrkas.createFixtureFile(
      fileName,
      '# Project conversation attachment\n\nUnique project attachment body.\n',
    );
    await createProject(modelOrkas, projectName);
    const projects = await modelOrkas.invoke<{
      projects: Array<{ project_id: string; name: string }>;
    }>('projects.list');
    const projectId = projects.projects.find((item) => item.name === projectName)?.project_id;
    expect(projectId).toBeTruthy();

    await modelOrkas.selectFilesOnNextDialog([sourcePath]);
    await page.locator('#project-chat-attach-btn').click();
    const attachment = page.locator('#project-chat-attachments .chat-attach-chip', {
      hasText: fileName,
    });
    await expect(attachment).toBeVisible();
    await expect(attachment).not.toHaveClass(/\bis-uploading\b/);
    await expect.poll(async () => {
      const result = await modelOrkas.invoke<{
        items: Array<{ name: string }>;
      }>('conversations.attachments.list', {
        cid: `projchat-${projectId}`,
      });
      return result.items.map((item) => item.name);
    }).toEqual([fileName]);
    const projectFiles = await modelOrkas.invoke<{ files: Array<{ name: string }> }>(
      'projects.files.list',
      { projectId },
    );
    expect(projectFiles.files.map((file) => file.name)).not.toContain(fileName);

    modelOrkas.setModelTextReplies(['E2E project attachment received.']);
    await page.locator('#project-chat-input').fill('Use the attached project brief.');
    await page.locator('#project-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText(
      'E2E project attachment received.',
      { timeout: 20_000 },
    );
    const userMessage = page.locator('#chat-history .chat-message.user');
    await expect(userMessage).toContainText(fileName);
    expect(JSON.stringify(modelOrkas.modelRequests[0])).toContain(fileName);

    const conversations = await modelOrkas.invoke<{
      conversations: Array<{ conversation_id: string; project_id?: string }>;
    }>('conversations.list');
    const conversation = conversations.conversations.find((item) => item.project_id === projectId);
    expect(conversation?.conversation_id).toBeTruthy();
    const remainingDraft = await modelOrkas.invoke<{ items: unknown[] }>(
      'conversations.attachments.list',
      { cid: `projchat-${projectId}` },
    );
    expect(remainingDraft.items).toHaveLength(0);
  });

  test('adds a produced file to the owning Project Library and confirms the destination', async ({
    modelOrkas,
  }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const fileName = 'produced-project-library-e2e.png';
    const projectName = 'E2E Produced Project Library';
    const taskText = 'Create an image deliverable for the Project Library regression.';
    await createProject(modelOrkas, projectName);
    const projects = await modelOrkas.invoke<{
      projects: Array<{ project_id: string; name: string }>;
    }>('projects.list');
    const projectId = projects.projects.find((item) => item.name === projectName)?.project_id;
    expect(projectId).toBeTruthy();
    modelOrkas.setModelTextReplies(['E2E image deliverable is ready.']);
    await page.locator('#project-chat-input').fill(taskText);
    await page.locator('#project-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText(
      'E2E image deliverable is ready.',
      { timeout: 20_000 },
    );
    const conversations = await modelOrkas.invoke<{
      conversations: Array<{ conversation_id: string; project_id?: string }>;
    }>('conversations.list');
    const cid = conversations.conversations.find((item) => item.project_id === projectId)?.conversation_id;
    expect(cid).toBeTruthy();
    const workspace = await modelOrkas.invoke<{ root: string }>('conversations.files.list', { cid });
    mkdirSync(workspace.root, { recursive: true });
    writeFileSync(
      path.join(workspace.root, fileName),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );

    await page.locator('#conversation-info-toggle').click();
    const row = page.locator('.conversation-info-file', { hasText: fileName });
    await expect(row).toBeVisible();
    await row.hover();
    await row.locator('.conversation-info-file-menu-btn').click();
    const addAction = page.locator('#conversation-info-file-menu [data-action="add-to-library"]');
    await expect(addAction).toHaveCount(1);
    // The live workspace refresh can close this transient menu between
    // Playwright's actionability checks. Dispatch the already-bound DOM action
    // so this E2E remains about the full renderer → IPC → persisted-result
    // contract instead of timing the hover-only menu surface.
    await addAction.dispatchEvent('click');

    await expect(page.locator('.ui-toast.is-success')).toContainText('Added to Project Library');
    await expect.poll(async () => {
      const result = await modelOrkas.invoke<{
        files: Array<{ name: string }>;
      }>('projects.files.list', { projectId });
      return result.files.map((file) => file.name);
    }).toContain(fileName);
    const globalTree = await modelOrkas.invoke<{ tree: unknown }>('contexts.tree');
    expect(JSON.stringify(globalTree.tree)).not.toContain(fileName);
  });

  test('injects project context into a self-contained model conversation and keeps its assignment', async ({
    modelOrkas,
  }) => {
    const projectName = 'E2E Project Conversation';
    const projectInstructions = 'E2E_PROJECT_POLICY: report release status with an explicit verification note.';
    const projectMemory = 'E2E_PROJECT_MEMORY: the desktop regression is the release source of truth.';
    const modelReply = 'E2E project context reached the model without a history lookup.';
    await createProject(modelOrkas, projectName);
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const project = await modelOrkas.invoke<{ projects: Array<{ project_id: string; name: string }> }>('projects.list');
    const projectId = project.projects.find((item) => item.name === projectName)?.project_id;
    expect(projectId).toBeTruthy();
    await modelOrkas.invoke('projects.instructions.set', {
      projectId,
      content: projectInstructions,
    });
    await modelOrkas.invoke('memory.add', {
      target: 'project',
      projectId,
      content: projectMemory,
    });
    modelOrkas.setModelTextReplies([modelReply]);

    await page.locator('#project-chat-input').fill('Give a self-contained status update for this project.');
    await page.locator('#project-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-history .chat-message.user')).toContainText(
      'Give a self-contained status update for this project.',
    );
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText(
      modelReply,
      { timeout: 20_000 },
    );
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(1);
    const modelRequest = JSON.stringify(modelOrkas.modelRequests[0]);
    expect(modelRequest).toContain(projectInstructions);
    expect(modelRequest).toContain(projectMemory);
    expect(modelRequest).toContain('Project context policy');

    const conversations = await modelOrkas.invoke<{
      conversations: Array<{ conversation_id: string; project_id?: string }>;
    }>('conversations.list');
    const projectConversation = conversations.conversations.find((item) => item.project_id === projectId);
    expect(projectConversation).toBeTruthy();
    const conversationId = projectConversation?.conversation_id;

    await page.locator('.project-row', {
      has: page.locator('.project-name', { hasText: projectName }),
    }).click();
    await expect(page.locator('#panel-project')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#project-tasks-count')).toHaveText('1');
    await expect(page.locator(`#project-tasks-list .conv-item[data-cid="${conversationId}"]`)).toBeVisible();
  });

  test('lets Commander replace project instructions and injects the saved result on the next turn', async ({
    modelOrkas,
  }) => {
    const projectName = 'E2E Commander Instructions';
    const original = 'Keep release links without www.';
    const replacement = `${original}\nAll customer copy must be English.`;
    const toolReply = 'E2E project instructions were updated through Commander.';
    const nextTurnReply = 'E2E refreshed project instructions reached the next turn.';
    await createProject(modelOrkas, projectName);
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const listed = await modelOrkas.invoke<{
      projects: Array<{ project_id: string; name: string }>;
    }>('projects.list');
    const projectId = listed.projects.find((item) => item.name === projectName)?.project_id;
    expect(projectId).toBeTruthy();
    await modelOrkas.invoke('projects.instructions.set', {
      projectId,
      content: original,
    });
    modelOrkas.setProjectInstructionsScenario(replacement, toolReply);

    await page.locator('#project-chat-input').fill(
      'Keep the existing project instructions and add that all customer copy must be English.',
    );
    await page.locator('#project-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText(
      toolReply,
      { timeout: 20_000 },
    );
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(2);
    expect(JSON.stringify(modelOrkas.modelRequests[0])).toContain(original);
    expect(JSON.stringify(modelOrkas.modelRequests[1])).toMatch(/ok\\?":true/);
    await expect.poll(async () => (
      await modelOrkas.invoke<{ content: string }>('projects.instructions.get', { projectId })
    ).content).toBe(replacement);

    modelOrkas.clearModelToolScenario();
    modelOrkas.setModelTextReplies([nextTurnReply]);
    await page.locator('#chat-input').fill('Confirm the current project rules.');
    await page.locator('#chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: nextTurnReply,
    })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(3);
    const nextTurnRequest = JSON.stringify(modelOrkas.modelRequests[2]);
    expect(nextTurnRequest).toContain(original);
    expect(nextTurnRequest).toContain('All customer copy must be English.');

    const concurrentUiEdit = `${replacement}\nUse the July launch checklist.`;
    const staleModelReplacement = `${replacement}\nPublish on Friday.`;
    const conflictReply = 'E2E stale project-instructions replacement was rejected.';
    modelOrkas.setProjectInstructionsScenario(staleModelReplacement, conflictReply, {
      toolDelayMs: 750,
    });
    await page.locator('#chat-input').fill('Also add that publishing happens on Friday.');
    await page.locator('#chat-send-btn').click();
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(4);
    await modelOrkas.invoke('projects.instructions.set', {
      projectId,
      content: concurrentUiEdit,
    });
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', {
      hasText: conflictReply,
    })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(5);
    expect(JSON.stringify(modelOrkas.modelRequests[4])).toContain(
      'conflict: project instructions changed after this turn started',
    );
    expect(await modelOrkas.invoke<{ content: string }>(
      'projects.instructions.get',
      { projectId },
    )).toMatchObject({ content: concurrentUiEdit });
  });

  test('finds an earlier project conversation, reads the evidence, and keeps the continuation after relaunch', async ({
    modelOrkas,
  }) => {
    const projectName = 'E2E Project History';
    const historyQuery = 'E2E_NIMBUS_PAYMENTS';
    const sourceReply = [
      `${historyQuery}: use AcmePay as the provider.`,
      'Keep RMB settlement and make refunds idempotent.',
    ].join(' ');
    const finalReply = 'Continued with AcmePay, RMB settlement, and idempotent refunds—no restatement needed.';
    await createProject(modelOrkas, projectName);
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    let page = modelOrkas.page;
    const projects = await modelOrkas.invoke<{ projects: Array<{ project_id: string; name: string }> }>('projects.list');
    const projectId = projects.projects.find((item) => item.name === projectName)?.project_id;
    expect(projectId).toBeTruthy();

    modelOrkas.setModelTextReplies([sourceReply]);
    await page.locator('#project-chat-input').fill('Record the Nimbus payments decision for this project.');
    await page.locator('#project-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText(
      sourceReply,
      { timeout: 20_000 },
    );
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(1);
    const sourceConversations = await modelOrkas.invoke<{
      conversations: Array<{ conversation_id: string; project_id?: string }>;
    }>('conversations.list');
    const sourceCid = sourceConversations.conversations.find(
      (item) => item.project_id === projectId,
    )?.conversation_id;
    expect(sourceCid).toBeTruthy();

    await page.locator('.project-row', {
      has: page.locator('.project-name', { hasText: projectName }),
    }).click();
    modelOrkas.setProjectHistoryScenario(historyQuery, sourceCid!, finalReply);
    await page.locator('#project-chat-input').fill(
      'Continue the earlier Nimbus payments plan from this project. Do not make me repeat its constraints.',
    );
    await page.locator('#project-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText(
      finalReply,
      { timeout: 20_000 },
    );
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(4);

    const searchFollowUp = JSON.stringify(modelOrkas.modelRequests[2]);
    const readFollowUp = JSON.stringify(modelOrkas.modelRequests[3]);
    expect(searchFollowUp).toContain(sourceCid);
    expect(searchFollowUp).toContain(historyQuery);
    expect(searchFollowUp).toMatch(new RegExp(`cid=${sourceCid} msg=\\d+`));
    expect(readFollowUp).toContain(`<chat-history cid=\\"${sourceCid}\\"`);
    expect(readFollowUp).toContain(sourceReply);
    await expect(page.locator('#chat-history .chat-message.assistant')).not.toContainText(
      /please.{0,20}(?:repeat|restate)|请.{0,20}(?:重复|重述)/i,
    );
    await expect(
      page.locator('#chat-history .chat-message.assistant [data-role="final"]'),
    ).not.toContainText(/chat_search|chat_read|<chat-history/i);

    const allConversations = await modelOrkas.invoke<{
      conversations: Array<{ conversation_id: string; project_id?: string }>;
    }>('conversations.list');
    const continuationCid = allConversations.conversations.find(
      (item) => item.project_id === projectId && item.conversation_id !== sourceCid,
    )?.conversation_id;
    expect(continuationCid).toBeTruthy();
    const requestsBeforeRelaunch = modelOrkas.modelRequests.length;

    page = await modelOrkas.relaunch();
    await page.locator('.project-row', {
      has: page.locator('.project-name', { hasText: projectName }),
    }).click();
    await page.locator(`#project-tasks-list .conv-item[data-cid="${continuationCid}"]`).click();
    await expect(page.locator('#chat-history .chat-message.assistant', {
      hasText: finalReply,
    })).toHaveCount(1);
    expect(modelOrkas.modelRequests).toHaveLength(requestsBeforeRelaunch);
  });

  test('binds a project agent, selects it as recipient, and removes it', async ({ orkas }) => {
    const createdAgent = await orkas.invoke<{ agent: { agent_id: string } }>('agents.create', {
      name: 'E2EProjectAgent',
      description: 'A project-scoped test agent.',
      category: 'general',
    });
    await createProject(orkas, 'E2E Agent Binding Project');
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;

    await page.locator('#project-add-agent-btn').click();
    const picker = page.locator('#project-binding-picker-overlay');
    await expect(picker).toBeVisible();
    const pickerDialog = picker.locator('.project-binding-picker-modal');
    const searchInput = picker.locator('#project-binding-picker-search-input');
    const initialPickerHeight = await pickerDialog.evaluate((element) => element.getBoundingClientRect().height);
    await expect(searchInput).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await searchInput.fill('E2E-no-such-project-agent');
    await expect(picker.locator('#project-binding-picker-empty')).toBeVisible();
    const emptyPickerHeight = await pickerDialog.evaluate((element) => element.getBoundingClientRect().height);
    expect(emptyPickerHeight).toBeCloseTo(initialPickerHeight, 1);
    await searchInput.fill('E2EProjectAgent');
    const candidate = picker.locator('.project-binding-picker-item', { hasText: 'E2EProjectAgent' });
    await expect(candidate).toBeVisible();
    const filteredPickerHeight = await pickerDialog.evaluate((element) => element.getBoundingClientRect().height);
    expect(filteredPickerHeight).toBeCloseTo(initialPickerHeight, 1);
    await candidate.locator('[data-action="pick"]').click();
    await picker.locator('[data-action="close"]').click();

    const bound = page.locator(`.project-agent-row[data-project-agent-id="${createdAgent.agent.agent_id}"]`);
    await expect(bound).toContainText('E2EProjectAgent');
    const projects = await orkas.invoke<{ projects: Array<{ project_id: string; name: string }> }>('projects.list');
    const projectId = projects.projects.find((item) => item.name === 'E2E Agent Binding Project')?.project_id;
    const bindings = await orkas.invoke<{ bindings: { agents: string[] } }>('projects.bindings.list', { projectId });
    expect(bindings.bindings.agents).toContain(createdAgent.agent.agent_id);

    await bound.hover();
    await bound.locator('[data-project-agent-run]').click();
    await expect(page.locator('#project-chat-recipient-name')).toHaveText('E2EProjectAgent');
    await bound.hover();
    await bound.locator('[data-project-agent-remove]').click();
    await expect(bound).toHaveCount(0);
    const removed = await orkas.invoke<{ bindings: { agents: string[] } }>('projects.bindings.list', { projectId });
    expect(removed.bindings.agents).not.toContain(createdAgent.agent.agent_id);
  });

  test('rejects a duplicate project name without losing the editor', async ({ orkas }) => {
    const projectName = 'E2E Unique Project';
    await createProject(orkas, projectName);
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');

    await orkas.page.locator('#projects-add-btn').click();
    const input = orkas.page.locator('#project-create-input');
    await input.fill(projectName);
    await input.press('Enter');

    await expect(input).toHaveValue(projectName);
    await expect(input).toHaveClass(/\bis-error\b/);
    await expect(input.locator('xpath=..').locator('.project-inline-error')).toBeVisible();
    await expect(input).toBeFocused();
    await expect(orkas.page.locator('.project-name', { hasText: projectName })).toHaveCount(1);

    const correctedName = 'E2E Unique Project Retry';
    await input.fill(correctedName);
    await input.press('Enter');
    const projectNames = orkas.page.locator('.project-name');
    await expect.poll(async () => (
      await projectNames.allTextContents()
    ).filter((name) => name === correctedName).length).toBe(1);
    await expect.poll(async () => (
      await projectNames.allTextContents()
    ).filter((name) => name === projectName).length).toBe(1);
  });

  test('keeps an unsaved project draft focused without creating it during a background refresh', async ({
    orkas,
  }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const draftName = 'E2E Unsaved Project Draft';
    await orkas.page.locator('#projects-add-btn').click();
    let input = orkas.page.locator('#project-create-input');
    await input.fill(draftName);
    await expect(input).toBeFocused();

    await orkas.page.evaluate(async () => {
      await (window as any).loadProjects(true);
    });

    input = orkas.page.locator('#project-create-input');
    await expect(input).toHaveValue(draftName);
    await expect(input).toBeFocused();
    const listed = await orkas.invoke<{ projects: Array<{ name: string }> }>('projects.list');
    expect(listed.projects.some((project) => project.name === draftName)).toBe(false);
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    const afterCancel = await orkas.invoke<{ projects: Array<{ name: string }> }>('projects.list');
    expect(afterCancel.projects.some((project) => project.name === draftName)).toBe(false);
  });

  test('renames a project and keeps the new name after relaunch', async ({ orkas }) => {
    const originalName = 'E2E Project Before Rename';
    const renamedName = 'E2E Project After Rename';
    await createProject(orkas, originalName);
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');

    const originalRow = orkas.page.locator('.project-row', {
      has: orkas.page.locator('.project-name', { hasText: originalName }),
    });
    await originalRow.hover();
    const renameMenuButton = originalRow.locator('[data-project-menu]');
    await expect(renameMenuButton).toBeVisible();
    await renameMenuButton.click();
    await orkas.page.locator('#project-row-menu [data-action="rename"]').click();
    const renameInput = orkas.page.locator('input.project-rename-input[data-rename-pid]');
    await expect(renameInput).toBeFocused();
    await renameInput.fill(renamedName);
    await renameInput.press('Enter');

    await expect(orkas.page.locator('.project-name', { hasText: originalName })).toHaveCount(0);
    await expect(orkas.page.locator('.project-name', { hasText: renamedName })).toHaveCount(1);

    const relaunchedPage = await orkas.relaunch();
    const renamedRow = relaunchedPage.locator('.project-row', {
      has: relaunchedPage.locator('.project-name', { hasText: renamedName }),
    });
    await expect(renamedRow).toHaveCount(1);
    await renamedRow.click();
    await expect(relaunchedPage.locator('#project-detail-title')).toHaveText(renamedName);
  });

  test('keeps an unsaved rename draft without applying it during a background refresh', async ({
    orkas,
  }) => {
    const originalName = 'E2E Rename Refresh Original';
    const draftName = 'E2E Rename Refresh Draft';
    await createProject(orkas, originalName);
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');

    const originalRow = orkas.page.locator('.project-row', {
      has: orkas.page.locator('.project-name', { hasText: originalName }),
    });
    await originalRow.hover();
    await originalRow.locator('[data-project-menu]').click();
    await orkas.page.locator('#project-row-menu [data-action="rename"]').click();
    let input = orkas.page.locator('input.project-rename-input[data-rename-pid]');
    await input.fill(draftName);
    await expect(input).toBeFocused();

    await orkas.page.evaluate(async () => {
      await (window as any).loadProjects(true);
    });

    input = orkas.page.locator('input.project-rename-input[data-rename-pid]');
    await expect(input).toHaveValue(draftName);
    await expect(input).toBeFocused();
    const listed = await orkas.invoke<{ projects: Array<{ name: string }> }>('projects.list');
    expect(listed.projects.some((project) => project.name === originalName)).toBe(true);
    expect(listed.projects.some((project) => project.name === draftName)).toBe(false);
    await input.press('Escape');
    await expect(orkas.page.locator('.project-name', { hasText: originalName })).toHaveCount(1);
    await expect(orkas.page.locator('.project-name', { hasText: draftName })).toHaveCount(0);
  });

  test('cancels deletion, then deletes and restores a project from the recycle bin', async ({ orkas }) => {
    const projectName = 'E2E Recyclable Project';
    await createProject(orkas, projectName);
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const projectNameLocator = page.locator('.project-name', { hasText: projectName });
    const listed = await orkas.invoke<{
      projects: Array<{ project_id: string; name: string }>;
    }>('projects.list');
    const projectId = listed.projects.find((project) => project.name === projectName)?.project_id;
    expect(projectId).toBeTruthy();
    const sourceName = 'recyclable-source.md';
    await orkas.invoke('projects.files.upload', {
      projectId,
      name: sourceName,
      data: Buffer.from('Project deletion must remove derived vectors.').toString('base64'),
    });
    await expect.poll(async () => {
      const status = await orkas.invoke<{
        files: Array<{ path: string; status: string }>;
      }>('projects.files.status', { projectId });
      return status.files.find((file) => file.path === sourceName)?.status;
    }).toBe('ready');
    const localProjectDir = path.join(
      orkas.workspaceRoot,
      'account-e2e',
      'local',
      'projects',
      projectId!,
    );
    expect(existsSync(localProjectDir)).toBe(true);

    const openDeleteDialog = async (): Promise<void> => {
      const row = page.locator('.project-row', { has: projectNameLocator });
      await row.hover();
      const menuButton = row.locator('[data-project-menu]');
      await expect(menuButton).toBeVisible();
      await menuButton.click();
      await page.locator('#project-row-menu [data-action="delete"]').click();
      await expect(page.locator('.ui-dialog-overlay:visible .ui-dialog-danger')).toBeVisible();
    };

    await openDeleteDialog();
    await page.locator('.ui-dialog-overlay:visible [data-act="cancel"]').click();
    await expect(page.locator('.ui-dialog-overlay:visible')).toHaveCount(0);
    await expect(projectNameLocator).toHaveCount(1);
    expect(existsSync(localProjectDir)).toBe(true);

    await openDeleteDialog();
    await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(projectNameLocator).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('#panel-new-chat')).toHaveClass(/\bactive\b/);
    await expect.poll(() => existsSync(localProjectDir)).toBe(false);

    await page.locator('#settings-btn').click();
    await page.locator('.settings-tab[data-settings-tab="data"]').click();
    const recycleRow = page.locator('.settings-recycle-row', { hasText: projectName });
    const restoreButton = recycleRow.locator('[data-recycle-restore]');
    await expect(restoreButton).toBeVisible();
    await restoreButton.click();
    await expect(page.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();

    await expect(projectNameLocator).toHaveCount(1);
    await expect(recycleRow).toBeVisible();
    await expect(restoreButton).toBeEnabled();
    await expect.poll(async () => {
      const status = await orkas.invoke<{
        files: Array<{ path: string; status: string }>;
      }>('projects.files.status', { projectId });
      return status.files.find((file) => file.path === sourceName)?.status;
    }).toBe('ready');
    const relaunchedPage = await orkas.relaunch();
    await expect(relaunchedPage.locator('.project-name', { hasText: projectName })).toHaveCount(1);
  });
});
