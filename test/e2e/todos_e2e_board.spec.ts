import { expect, test as base, OrkasTestApp } from './fixtures/orkas';

// The assignment journey exercises both account-scoped agents and execution.
const test = base.extend({
  modelOrkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { modelStub: true });
    try {
      await app.launch();
      await use(app);
    } finally {
      await app.dispose();
    }
  },
});

test('manages the same backlog from global and project boards with independent disclosures', async ({ connectorOrkas: orkas }, testInfo) => {
  const page = orkas.page!;
  await page.evaluate(() => (window as any).setLang('zh'));
  const alpha = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: '桌面应用' });
  const beta = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: '官网改版' });
  await orkas.invoke('projects.create', { name: '空项目' });
  const a = alpha.project.project_id;
  const b = beta.project.project_id;
  const availableAgents = await orkas.invoke<{ agents: Array<{ agent_id: string; name: string }> }>('agents.list', { summary: true });
  const agent = availableAgents.agents[0];
  expect(agent).toBeDefined();
  await orkas.invoke('projects.bindings.add', { projectId: a, kind: 'agent', id: agent.agent_id });
  for (const [projectId, title, status] of [
    [a, '设计项目看板', 'todo'], [a, '实现状态更新', 'progress'],
    [a, '检查空状态', 'review'], [a, '确认视觉规范', 'done'],
    [b, '整理首页文案', 'todo'], [b, '处理依赖阻塞', 'todo'], [b, '确认旧版页面', 'done'],
  ]) {
    await orkas.invoke('projects.tasks.create', { projectId, title, status, detail: '沿用现有项目机制，验证交付结果。' });
  }
  const alphaTasks = await orkas.invoke<{ tasks: Array<{ id: string; title: string }> }>('projects.tasks.list', { projectId: a });
  const assignedTask = alphaTasks.tasks.find((task) => task.title === '设计项目看板')!;
  const completedTask = alphaTasks.tasks.find((task) => task.title === '确认视觉规范')!;
  await orkas.invoke('projects.tasks.update', {
    projectId: a,
    taskId: assignedTask.id,
    owner_agent: agent.name,
    owner_agent_id: agent.agent_id,
  });
  await page.locator('#todos-btn').click();
  const content = page.locator('#todos-content');
  const header = page.locator('#panel-todos .project-detail-header');
  await expect(header.locator('.todo-page-actions')).toBeVisible();
  await expect(header.locator('.todo-page-description')).toHaveCount(0);
  await expect(page.locator('#todos-project-filter')).toHaveCount(0);
  await expect(page.locator('#todos-add-btn')).toHaveText('+创建');
  await expect(page.locator('#todos-add-btn')).not.toHaveClass(/btn-primary/);
  await expect(content.locator('.todo-project-group')).toHaveCount(2);
  await expect(content.getByText('空项目', { exact: true })).toHaveCount(0);
  await expect(content.getByText('查看项目', { exact: true })).toHaveCount(0);
  await expect(content.locator('.todo-project-head .todo-collapse')).toHaveCount(2);
  await expect(content.locator('.todo-project-head .todo-project-add')).toHaveCount(2);
  await expect(content.locator('.todo-project-head .todo-scope-driver-toggle')).toHaveCount(2);
  await expect(content.locator('.todo-column-head .project-todo-menu')).toHaveCount(0);
  await expect(content.locator('.project-todo-item [data-action="todo-menu"]')).toHaveCount(7);
  await expect(page.locator('#todos-btn')).toHaveText('待办');
  await expect(page.locator('[data-project-tab="todo"]')).toHaveText('待办 0');
  const alphaGroup = content.locator(`.todo-project-group[data-pid="${a}"]`);
  await expect(alphaGroup.locator('.todo-column-head .todo-collapse')).toHaveText(['待处理1', '处理中1', '待确认1', '已完成1']);
  await expect(alphaGroup.locator('.todo-project-head .auto-group-icon svg')).toHaveCount(1);
  await expect(alphaGroup.locator('.todo-project-head .todo-disclosure-chevron')).toHaveCount(0);
  await expect(alphaGroup.locator('.todo-column-head .todo-disclosure-chevron')).toHaveCount(4);
  for (const status of ['todo', 'progress', 'review']) {
    await expect(alphaGroup.locator(`.todo-column.is-${status} .todo-collapse`)).toHaveAttribute('aria-expanded', 'true');
  }
  const doneToggle = alphaGroup.locator('.todo-column.is-done .todo-collapse');
  await expect(doneToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(alphaGroup.getByText('确认视觉规范', { exact: true })).toBeHidden();
  await doneToggle.focus();
  await page.keyboard.press('Space');
  await expect(alphaGroup.getByText('确认视觉规范', { exact: true })).toBeVisible();
  const projectToggle = alphaGroup.locator('.todo-project-head .todo-collapse');
  await projectToggle.click();
  await expect(alphaGroup.locator('.todo-board')).toBeHidden();
  await expect(content.getByText('整理首页文案', { exact: true })).toBeVisible();
  await projectToggle.click();
  await expect(doneToggle).toHaveAttribute('aria-expanded', 'true');

  // One project-level + replaces the four status-level buttons and creates in
  // the project whose title owns it.
  await alphaGroup.locator('.todo-project-add').click();
  await expect(page.locator('#project-todo-project')).toHaveAttribute('data-value', a);
  await expect(page.locator('#project-todo-project .ai-select-trigger')).toBeDisabled();
  await page.locator('#project-todo-cancel').click();

  // Card controls follow reading order: Agent on the left, status on the right.
  const pendingCard = alphaGroup.locator('.project-todo-item', { hasText: '设计项目看板' });
  const [agentBox, statusBox] = await Promise.all([
    pendingCard.locator('.project-todo-assign').boundingBox(),
    pendingCard.locator('.project-todo-status-select').boundingBox(),
  ]);
  expect(agentBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  expect(agentBox!.x).toBeLessThan(statusBox!.x);
  const pendingCardMenu = pendingCard.locator('[data-action="todo-menu"]');
  await page.locator('#panel-todos .project-detail-title').hover();
  await expect(pendingCardMenu).toHaveCSS('opacity', '0');
  await pendingCard.hover();
  await expect(pendingCardMenu).toHaveCSS('opacity', '1');
  await pendingCardMenu.click();
  const cardMenuItems = page.locator('.context-menu-item');
  await expect(cardMenuItems).toHaveText(['立即处理', '编辑', '删除']);
  await expect(page.locator('.context-menu-icon, .context-menu-avatar, .context-menu-trailing-icon')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const assignedChip = pendingCard.locator('.project-todo-assignee');
  const clearAssignment = assignedChip.locator('[data-action="todo-unassign"]');
  await expect(clearAssignment).toHaveCSS('opacity', '0');
  await assignedChip.hover();
  await expect(clearAssignment).toHaveCSS('opacity', '1');
  await clearAssignment.click();
  await expect(pendingCard.locator('.project-todo-assign')).toHaveClass(/is-empty/);
  await pendingCard.locator('.project-todo-assign').click();
  const agentOption = page.locator('.context-menu-item', { hasText: agent.name });
  await expect(agentOption.locator('.context-menu-avatar')).toHaveCount(1);
  await expect(agentOption.locator('.context-menu-icon')).toHaveCount(0);
  await agentOption.click();
  await expect(pendingCard.locator('.project-todo-assign')).toContainText(agent.name);
  await pendingCard.locator('.project-todo-assign').click();
  const selectedAgentOption = page.locator('.context-menu-item', { hasText: agent.name });
  const selectedAgentCheck = selectedAgentOption.locator('.context-menu-trailing-icon');
  await expect(selectedAgentOption.locator('.context-menu-avatar')).toHaveCount(1);
  await expect(selectedAgentCheck).toHaveCount(1);
  const [selectedAgentLabelBox, selectedAgentCheckBox] = await Promise.all([
    selectedAgentOption.locator('.context-menu-label').boundingBox(),
    selectedAgentCheck.boundingBox(),
  ]);
  expect(selectedAgentLabelBox).not.toBeNull();
  expect(selectedAgentCheckBox).not.toBeNull();
  expect(selectedAgentLabelBox!.x).toBeLessThan(selectedAgentCheckBox!.x);
  const selectedAgentColors = await selectedAgentCheck.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--primary-text)';
    document.body.appendChild(probe);
    const result = { check: getComputedStyle(element).color, primary: getComputedStyle(probe).color };
    probe.remove();
    return result;
  });
  expect(selectedAgentColors.check).toBe(selectedAgentColors.primary);
  await page.keyboard.press('Escape');
  const processingDotAnimation = await alphaGroup.locator('.todo-column.is-progress .project-todo-item .project-todo-status-dot').evaluate(
    (element) => getComputedStyle(element).animationName,
  );
  expect(processingDotAnimation).toBe('none');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('todos-by-project.png') });
  // Narrow desktop windows keep the fourth column reachable within its group.
  await page.setViewportSize({ width: 1024, height: 768 });
  await alphaGroup.locator('.todo-board').evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect(alphaGroup.getByText('确认视觉规范', { exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 1440, height: 900 });

  // The global page defaults to an account-level to-do. Dropped files use the
  // same attachment path as the + button in the composer.
  await page.locator('#todos-add-btn').click();
  await expect(page.locator('#project-todo-project')).toHaveAttribute('data-value', '');
  await expect(page.locator('#project-todo-project .ai-select-label')).toHaveText('全局');
  await expect(page.locator('#project-todo-agent .ai-select-trigger')).toBeEnabled();
  await expect(page.locator('#project-todo-close')).toHaveCount(0);
  await expect(page.locator('.todo-editor-content-field > span')).toHaveText('具体内容');
  await expect(page.locator('#project-todo-detail')).toHaveCount(0);
  await expect(page.locator('#project-todo-attach-btn')).toHaveText('+');
  const [editorTitleBox, editorComposerBox] = await Promise.all([
    page.locator('#project-todo-editor-title').boundingBox(),
    page.locator('#project-todo-composer').boundingBox(),
  ]);
  expect(editorTitleBox).not.toBeNull();
  expect(editorComposerBox).not.toBeNull();
  expect(Math.abs(editorTitleBox!.x - editorComposerBox!.x)).toBeLessThan(1);
  await page.locator('#project-todo-composer').evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['global attachment'], 'global-notes.txt', { type: 'text/plain' }));
    for (const type of ['dragenter', 'dragover', 'drop']) {
      element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  });
  const droppedAttachment = page.locator('#project-todo-attachments .chat-attach-chip');
  await expect(droppedAttachment).toContainText('global-notes.txt');
  await expect(droppedAttachment).not.toHaveClass(/is-uploading/);
  await page.locator('#project-todo-input').fill('全局跟进发票');
  await page.locator('#project-todo-status .ai-select-trigger').click();
  await page.locator('#project-todo-status-listbox .ai-select-item[data-value="todo"]').click();
  await page.screenshot({ path: testInfo.outputPath('todo-editor.png') });
  await page.locator('#project-todo-save').click();
  await expect(page.locator('#todo-editor-modal')).not.toHaveClass(/\bopen\b/);
  const globalSaved = await orkas.invoke<{ tasks: Array<{ id: string; title: string; detail?: string; status: string; attachments?: string[] }> }>('projects.tasks.list', {});
  const globalTask = globalSaved.tasks.find((task) => task.title === '全局跟进发票')!;
  expect(globalTask).toMatchObject({
    status: 'todo',
    attachments: ['global-notes.txt'],
  });
  expect(globalTask.detail).toBeUndefined();
  await expect(content.locator('.todo-project-group')).toHaveCount(3);
  const globalGroup = content.locator('.todo-project-group[data-pid=""]');
  await expect(globalGroup).toContainText('全局跟进发票');
  await expect(globalGroup.locator('.todo-scope-driver-toggle')).toBeVisible();
  await expect(globalGroup.locator('.todo-column.is-progress .todo-column-empty')).toHaveCSS('text-align', 'center');
  const globalToggle = globalGroup.locator('.todo-project-head .todo-collapse');
  const globalFolder = globalToggle.locator('.auto-group-folder-icon');
  await expect(globalFolder).toHaveCount(1);
  await expect(globalFolder).toHaveClass(/\bis-folder-open\b/);
  await globalToggle.click();
  await expect(globalToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(globalGroup.locator('.todo-board')).toBeHidden();
  await expect(globalFolder).toHaveClass(/\bis-folder(?:\s|$)/);
  await expect(alphaGroup.locator('.todo-board')).toBeVisible();
  await globalToggle.click();
  await expect(globalToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(globalGroup.locator('.todo-board')).toBeVisible();
  await expect(globalFolder).toHaveClass(/\bis-folder-open\b/);

  // The same editor can still opt into a project explicitly.
  await page.locator('#todos-add-btn').click();
  await page.locator('#project-todo-project .ai-select-trigger').click();
  await page.locator(`#project-todo-project-listbox .ai-select-item[data-value="${b}"]`).click();
  await page.locator('#project-todo-input').fill('完善价格页');
  await page.locator('#project-todo-status .ai-select-trigger').click();
  await page.locator('#project-todo-status-listbox .ai-select-item[data-value="review"]').click();
  await page.locator('#project-todo-save').click();
  await expect(page.locator('#todo-editor-modal')).not.toHaveClass(/\bopen\b/);
  const saved = await orkas.invoke<{ tasks: Array<{ id: string; title: string; detail?: string; status: string }> }>('projects.tasks.list', { projectId: b });
  const created = saved.tasks.find((task) => task.title === '完善价格页')!;
  expect(created).toMatchObject({ status: 'review' });
  expect(created.detail).toBeUndefined();
  const otherProject = await orkas.invoke<{ tasks: Array<{ title: string }> }>('projects.tasks.list', { projectId: a });
  expect(otherProject.tasks.some((task) => task.title === '完善价格页')).toBe(false);
  expect(saved.tasks.some((task) => task.title === '全局跟进发票')).toBe(false);

  await page.locator('[data-todo-group="status"]').click();
  await expect(content.locator(':scope > .todo-board > .todo-column')).toHaveCount(4);
  await expect(content.locator('.todo-project-group')).toHaveCount(0);
  await expect(content.locator('.todo-driver-bar')).toBeVisible();
  await expect(content.locator('.todo-driver-bar .todo-scope-driver-toggle')).toHaveCount(3);
  await expect(content.locator('.todo-driver-bar .todo-scope-driver-toggle[data-pid=""] .todo-driver-scope-icon')).toHaveCount(1);
  const task = content.locator(`.project-todo-item[data-tid="${created.id}"]`);
  await expect(task.locator('.todo-card-project')).toHaveText('官网改版');
  await expect(task.locator('.todo-card-project-icon')).toHaveCount(1);
  const projectColor = await task.locator('.todo-card-project').evaluate((element) => getComputedStyle(element).color);
  const ordinaryMetaColor = await task.locator('.project-todo-status-select').evaluate((element) => getComputedStyle(element).color);
  expect(projectColor).toBe(ordinaryMetaColor);
  const completedCard = content.locator(`.project-todo-item[data-tid="${completedTask.id}"]`);
  const completedTitleColor = await completedCard.locator('.project-todo-title')
    .evaluate((element) => getComputedStyle(element).color);
  const activeTitleColor = await task.locator('.project-todo-title')
    .evaluate((element) => getComputedStyle(element).color);
  expect(completedTitleColor).toBe(activeTitleColor);
  const projectMeta = task.locator('.todo-card-project');
  const agentMeta = task.locator('.project-todo-assign');
  const statusMeta = task.locator('.project-todo-status-select');
  const [projectMetaBox, agentMetaBox, statusMetaBox] = await Promise.all([
    projectMeta.boundingBox(),
    agentMeta.boundingBox(),
    statusMeta.boundingBox(),
  ]);
  expect(projectMetaBox).not.toBeNull();
  expect(agentMetaBox).not.toBeNull();
  expect(statusMetaBox).not.toBeNull();
  expect(Math.abs((projectMetaBox!.y + projectMetaBox!.height / 2) - (agentMetaBox!.y + agentMetaBox!.height / 2))).toBeLessThan(4);
  expect(projectMetaBox!.x).toBeLessThan(agentMetaBox!.x);
  expect(agentMetaBox!.x).toBeLessThan(statusMetaBox!.x);
  const globalCard = content.locator(`.project-todo-item[data-tid="${globalTask.id}"]`);
  await expect(globalCard).toHaveAttribute('data-todo-scope', 'global');
  await expect(globalCard.locator('span.todo-card-project')).toHaveText('全局');
  await expect(globalCard.locator('.todo-card-project-icon')).toHaveCount(1);
  await expect(globalCard.locator('button.todo-card-project')).toHaveCount(0);
  await task.locator('[data-action="todo-status"]').click();
  const selectedStatusOption = page.locator('.context-menu-item', { hasText: '待确认' });
  const selectedStatusCheck = selectedStatusOption.locator('.context-menu-trailing-icon');
  await expect(selectedStatusOption.locator('.context-menu-icon')).toHaveCount(0);
  await expect(selectedStatusCheck).toHaveCount(1);
  const [selectedStatusLabelBox, selectedStatusCheckBox] = await Promise.all([
    selectedStatusOption.locator('.context-menu-label').boundingBox(),
    selectedStatusCheck.boundingBox(),
  ]);
  expect(selectedStatusLabelBox).not.toBeNull();
  expect(selectedStatusCheckBox).not.toBeNull();
  expect(selectedStatusLabelBox!.x).toBeLessThan(selectedStatusCheckBox!.x);
  expect(await selectedStatusCheck.evaluate((element) => getComputedStyle(element).color))
    .toBe(selectedAgentColors.primary);
  await page.locator('.context-menu-item', { hasText: '处理中' }).click();
  await expect(content.locator('.todo-column.is-progress').getByText('完善价格页', { exact: true })).toBeVisible();
  // The global completed group starts collapsed independently of project grouping.
  await expect(content.locator('.todo-column.is-done .todo-collapse')).toHaveAttribute('aria-expanded', 'false');
  await expect(content.getByText('处理依赖阻塞', { exact: true })).toBeVisible();
  await content.locator('.todo-column.is-done .todo-collapse').click();
  await expect(content.getByText('确认旧版页面', { exact: true })).toBeVisible();
  // A write from another entry point must reach the open page via the normal
  // tasks-changed push, without revisiting the tab or manually reloading.
  const pushed = await orkas.invoke<{ task: { id: string } }>('projects.tasks.create', {
    projectId: b, title: '后台同步待办', status: 'todo',
  });
  await expect(content.getByText('后台同步待办', { exact: true })).toBeVisible();
  await orkas.invoke('projects.tasks.delete', { projectId: b, taskId: pushed.task.id });
  await expect(content.getByText('后台同步待办', { exact: true })).toHaveCount(0);

  // Persist Auto-advance=on while this project has no actionable tasks, so the
  // project detail can prove it renders the actual project setting without
  // starting a model-backed run during this deterministic E2E.
  const beforeDriver = await orkas.invoke<{ tasks: Array<{ id: string; status: string }> }>('projects.tasks.list', { projectId: b });
  for (const item of beforeDriver.tasks.filter((candidate) => candidate.status === 'todo' || candidate.status === 'blocked')) {
    await orkas.invoke('projects.tasks.update', { projectId: b, taskId: item.id, status: 'review' });
  }
  const driver = await orkas.invoke<{ config: { enabled: boolean } }>('projects.driver.set', { projectId: b, enabled: true });
  expect(driver.config.enabled).toBe(true);
  await expect(content.locator(`.todo-driver-bar .todo-scope-driver-toggle[data-pid="${b}"]`)).toHaveAttribute('aria-pressed', 'true');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('global-todos.png') });
  const globalCardStyle = await task.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      padding: style.padding,
      borderRadius: style.borderRadius,
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
    };
  });
  await task.locator('.todo-card-project').click();
  await expect(page.locator('#project-detail-title')).toHaveText('官网改版');
  const todoTabCount = page.locator('[data-project-tab="todo"] .project-detail-tab-count');
  await expect(todoTabCount).toHaveText('4');
  await expect(page.locator('#project-chat-input')).toBeVisible();
  await expect(page.locator('.project-detail-side')).toBeVisible();
  await expect(page.locator('#project-todo-owner-filter')).toHaveCount(0);
  await expect(page.locator('#project-todo-add-btn')).toHaveText('+创建');
  await expect(page.locator('#project-todo-add-btn')).not.toHaveClass(/btn-primary/);
  await expect(page.locator('#project-driver-toggle')).toBeVisible();
  await expect(page.locator('#project-driver-toggle')).toHaveAttribute('aria-pressed', 'true');
  const projectList = page.locator('#project-todo-list');
  const projectCard = projectList.locator(`.project-todo-item[data-tid="${created.id}"]`);
  await expect(projectList.locator('.todo-column.is-progress').getByText('完善价格页', { exact: true })).toBeVisible();
  await expect(projectList.getByText('设计项目看板', { exact: true })).toHaveCount(0);
  const projectCardStyle = await projectCard.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      padding: style.padding,
      borderRadius: style.borderRadius,
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
    };
  });
  expect(projectCardStyle).toEqual(globalCardStyle);
  // Counts include completed/legacy tasks and reconcile external writes even
  // while the user is on a different project tab.
  await page.locator('[data-project-tab="tasks"]').click();
  const counted = await orkas.invoke<{ task: { id: string } }>('projects.tasks.create', {
    projectId: b, title: '核对待办总数', status: 'review',
  });
  await expect(todoTabCount).toHaveText('5');
  await orkas.invoke('projects.tasks.update', { projectId: b, taskId: counted.task.id, status: 'done' });
  await expect(todoTabCount).toHaveText('5');
  await orkas.invoke('projects.tasks.delete', { projectId: b, taskId: counted.task.id });
  await expect(todoTabCount).toHaveText('4');
  await page.locator('[data-project-tab="todo"]').click();
  await page.screenshot({ path: testInfo.outputPath('project-todos.png') });
  await projectList.getByText('完善价格页', { exact: true }).click();
  await page.locator('#project-todo-input').fill('完善价格页与导航');
  await page.locator('#project-todo-save').click();
  await page.locator('#todos-btn').click();
  await expect(content.getByText('完善价格页与导航', { exact: true })).toBeVisible();

  // Reopening the app reads persisted tasks and restores default disclosure states.
  const reloaded = await orkas.relaunch();
  await reloaded.locator('#todos-btn').click();
  await expect(reloaded.locator('#todos-content').getByText('完善价格页与导航', { exact: true })).toBeVisible();
  await expect(reloaded.locator('#todos-content').getByText('全局跟进发票', { exact: true })).toBeVisible();
  await expect(reloaded.locator('#todos-content .todo-column.is-done .todo-collapse').first()).toHaveAttribute('aria-expanded', 'false');
  await expect(reloaded.locator('#todos-project-filter')).toHaveCount(0);
  await expect(reloaded.locator('#todos-content').getByText('空项目', { exact: true })).toHaveCount(0);
  const removed = reloaded.locator(`#todos-content .project-todo-item[data-tid="${created.id}"]`);
  await orkas.invoke('projects.tasks.delete', { projectId: b, taskId: created.id });
  await expect(removed).toHaveCount(0);
  const final = await orkas.invoke<{ tasks: Array<{ id: string }> }>('projects.tasks.list', { projectId: b });
  expect(final.tasks.some((item) => item.id === created.id)).toBe(false);
});

test('assigns global and project todos in the editor and keeps cards and saved owners in sync', async ({ modelOrkas: orkas }, testInfo) => {
  const page = orkas.page!;
  await page.evaluate(() => (window as any).setLang('zh'));
  const { agents } = await orkas.invoke<{ agents: Array<{ agent_id: string; name: string; enabled: boolean }> }>('agents.list', { summary: true });
  const agent = agents.find((a) => a.enabled !== false)!;
  expect(agent).toBeDefined();
  const { project } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Assignment project' });
  const pid = project.project_id;
  await orkas.invoke('projects.bindings.add', { projectId: pid, kind: 'agent', id: agent.agent_id });
  await page.locator('#todos-btn').click();
  const agentControl = page.locator('#project-todo-agent');
  const chooseAgent = async (value: string) => {
    await expect(agentControl.locator('.ai-select-trigger')).toBeEnabled();
    await agentControl.locator('.ai-select-trigger').click();
    await page.locator(`#project-todo-agent-listbox .ai-select-item[data-value="${value}"]`).click();
  };
  for (const scope of ['', pid]) {
    await page.locator('#todos-add-btn').click();
    if (scope) {
      await page.locator('#project-todo-project .ai-select-trigger').click();
      await page.locator(`#project-todo-project-listbox .ai-select-item[data-value="${scope}"]`).click();
    }
    await chooseAgent(agent.agent_id);
    const title = scope ? 'Project assigned task' : 'Global assigned task';
    await page.locator('#project-todo-input').fill(title);
    if (!scope) await page.screenshot({ path: testInfo.outputPath('todo-agent-editor.png') });
    await page.locator('#project-todo-save').click();
    await expect(page.locator('#todo-editor-modal')).not.toHaveClass(/open/);
    const card = page.locator('#todos-content .project-todo-item', { hasText: title });
    await expect(card.locator('.project-todo-assign')).toContainText(agent.name);
    let tasks = await orkas.invoke<{ tasks: any[] }>('projects.tasks.list', { projectId: scope });
    expect(tasks.tasks.find((t) => t.title === title)).toMatchObject({ owner_agent_id: agent.agent_id, owner_agent: agent.name });
    await card.locator('[data-action="todo-edit"]').click();
    await expect(agentControl).toHaveAttribute('data-value', agent.agent_id);
    await chooseAgent('');
    await page.locator('#project-todo-save').click();
    await expect(card.locator('.project-todo-assign')).toHaveClass(/is-empty/);
    tasks = await orkas.invoke<{ tasks: any[] }>('projects.tasks.list', { projectId: scope });
    expect(tasks.tasks.find((t) => t.title === title)).not.toHaveProperty('owner_agent_id');
    if (!scope) {
      await card.locator('.project-todo-assign').click();
      await page.locator('.context-menu-item', { hasText: agent.name }).click();
      await expect(card.locator('.project-todo-assign')).toContainText(agent.name);
      const assigned = await orkas.invoke<{ tasks: any[] }>('projects.tasks.list', { projectId: '' });
      const task = assigned.tasks.find((t) => t.title === title);
      orkas.setModelTextReplies(['Assignment received']);
      const result = await orkas.invoke<{ ok: boolean; cid: string }>('projects.tasks.run', { projectId: '', taskId: task.id });
      expect(result.ok).toBe(true);
      const history = await orkas.invoke<{ history: any[] }>('conversations.history', { cid: result.cid, limit: 20 });
      expect(history.history.find((message) => message.from === 'user')?.to).toEqual([agent.agent_id]);
      await expect.poll(async () => {
        const messages = await orkas.invoke<{ history: any[] }>('conversations.history', { cid: result.cid, limit: 20 });
        return messages.history.some((message) => message.from === agent.agent_id && message.text.includes('Assignment received'));
      }).toBe(true);
    }
  }
});

// A status column can hold more to-dos than the board is tall. The board is a
// flex child of the scrolling panel, so such a column is shrunk to the panel
// instead of overflowing it, and without a scroller of its own it simply clipped
// the rest of the cards away with no way to reach them. The single card in a
// column that cannot overflow is the oracle for "kept its own height": a body
// that fits by squashing its cards would scroll too, and would be just as
// unusable.
test('reaches every to-do in a column taller than the board', async ({ connectorOrkas: orkas }, testInfo) => {
  const page = orkas.page!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => (window as any).setLang('zh'));
  const created = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: '滚动验证' });
  const pid = created.project.project_id;
  const detail = '一段足够长的说明文字，用来让卡片高度接近真实情况，从而让这一列超出看板高度。';
  for (let index = 1; index <= 15; index += 1) {
    await orkas.invoke('projects.tasks.create', { projectId: pid, title: `待办 ${index}`, status: 'todo', detail });
  }
  await orkas.invoke('projects.tasks.create', { projectId: pid, title: '对照待办', status: 'progress', detail });
  const measure = (sel: string, viewSel: string) => page.evaluate(({ sel, viewSel }) => {
    const column = document.querySelector(`${sel} .todo-column.is-todo`) as HTMLElement;
    const body = column.querySelector('.todo-column-body') as HTMLElement;
    const head = column.querySelector('.todo-column-head') as HTMLElement;
    const cards = Array.from(column.querySelectorAll('.project-todo-item')) as HTMLElement[];
    const reference = document.querySelector(`${sel} .todo-column.is-progress .project-todo-item`) as HTMLElement;
    const last = cards[cards.length - 1].getBoundingClientRect();
    const view = (document.querySelector(viewSel) as HTMLElement).getBoundingClientRect();
    return {
      cards: cards.length,
      cardHeight: Math.round(last.height),
      referenceHeight: Math.round(reference.getBoundingClientRect().height),
      hiddenInBody: body.scrollHeight - body.clientHeight,
      headTop: Math.round(head.getBoundingClientRect().top),
      lastVisible: last.bottom <= view.bottom + 1 && last.top >= view.top - 1,
    };
  }, { sel, viewSel });

  // The global page scrolls as one list, so a column there must not turn into a
  // second scroller nested inside it.
  await page.locator('#todos-btn').click();
  await page.locator('[data-todo-group="status"]').click();
  await expect(page.locator('#todos-content .todo-column.is-todo .project-todo-item')).toHaveCount(15);
  const globalBefore = await measure('#todos-content', '#todos-content');
  expect(globalBefore.hiddenInBody).toBeLessThanOrEqual(2);
  expect(globalBefore.cardHeight).toBeGreaterThanOrEqual(globalBefore.referenceHeight - 2);
  await page.evaluate(() => {
    const list = document.querySelector('#todos-content') as HTMLElement;
    list.scrollTop = list.scrollHeight;
  });
  expect((await measure('#todos-content', '#todos-content')).lastVisible).toBe(true);

  // The project board gives each column its own scroller instead.
  await page.locator('#todos-content .project-todo-item').first().locator('.todo-card-project').click();
  await expect(page.locator('#project-detail-title')).toHaveText('滚动验证');
  await page.locator('[data-project-tab="todo"]').click();
  const body = page.locator('#project-todo-list .todo-column.is-todo .todo-column-body');
  await expect(page.locator('#project-todo-list .todo-column.is-todo .project-todo-item')).toHaveCount(15);
  const before = await measure('#project-todo-list', '#project-todo-list .todo-column.is-todo');
  expect(before.cards).toBe(15);
  expect(before.cardHeight).toBeGreaterThanOrEqual(before.referenceHeight - 2);
  expect(before.hiddenInBody).toBeGreaterThan(100);
  expect(before.lastVisible).toBe(false);
  const box = (await body.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const after = await measure('#project-todo-list', '#project-todo-list .todo-column.is-todo');
  expect(after.lastVisible).toBe(true);
  expect(after.cardHeight).toBeGreaterThanOrEqual(after.referenceHeight - 2);
  expect(after.headTop).toBe(before.headTop);
  await page.screenshot({ path: testInfo.outputPath('todo-column-scroll.png') });
});
