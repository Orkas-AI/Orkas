import { openSidebarEntry, expect, test } from './fixtures/orkas';


test('keeps file and related resource glyphs readable within their shared icon box', async ({ orkas: app }, testInfo) => {
  const page = app.page!;
  const files = ['report.md', 'report.pdf', 'report.docx', 'report.xlsx', 'report.pptx',
    'photo.png', 'movie.mp4', 'sound.mp3', 'config.json', 'bundle.zip', 'worker.ts', 'other.bin'];
  const paths = files.map(name => app.createWorkspaceFile(name, 'Icon geometry fixture'));
  const glyphs = await page.evaluate(({ files, paths }) => {
    const runtime = window as any;
    const host = document.createElement('div');
    host.id = 'resource-icon-audit';
    host.className = 'chat-message assistant';
    host.style.cssText = 'position:fixed;inset:80px 40px auto 300px';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble markdown-body';
    bubble.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:20px';
    host.appendChild(bubble);
    files.forEach((name, index) => {
      const row = document.createElement('div');
      row.dataset.iconName = name;
      row.innerHTML = runtime._markdownFileLinkHtml(paths[index], name);
      bubble.appendChild(row);
    });
    for (const name of ['file', 'file-text', 'document-pencil', 'clipboard-list', 'clock']) {
      const row = document.createElement('div');
      row.dataset.iconName = name;
      row.innerHTML = `<span class="chat-task-reference"><span class="chat-task-reference-icon">${runtime.uiIconHtml(name)}</span><span>${name}</span></span>`;
      bubble.appendChild(row);
    }
    document.body.appendChild(host);
    return Array.from(host.querySelectorAll<SVGSVGElement>('svg')).map(svg => {
      const bounds = svg.getBBox();
      const box = svg.getBoundingClientRect();
      const view = svg.viewBox.baseVal;
      const stroke = Number(svg.getAttribute('stroke-width')) / 2;
      return { name: svg.closest<HTMLElement>('[data-icon-name]')!.dataset.iconName,
        box: [box.width, box.height], width: bounds.width,
        unclipped: bounds.x - stroke >= view.x && bounds.y - stroke >= view.y
          && bounds.x + bounds.width + stroke <= view.x + view.width
          && bounds.y + bounds.height + stroke <= view.y + view.height };
    });
  }, { files, paths });
  await testInfo.attach('resource-icon-geometry.json', { body: JSON.stringify(glyphs), contentType: 'application/json' });
  await page.locator('#resource-icon-audit').screenshot({ path: testInfo.outputPath('resource-icons.png') });
  expect(glyphs).toHaveLength(17);
  for (const glyph of glyphs) {
    expect(glyph.box, glyph.name).toEqual([16, 16]);
    expect(glyph.width, glyph.name).toBeGreaterThanOrEqual(14);
    expect(glyph.unclipped, glyph.name).toBe(true);
  }
});

test('shows clickable task content previews without changing code examples, links, or message copy', async ({ orkas: app }, testInfo) => {
  const page = app.page!;
  const todo = 't_e4fe5478466d';
  const automation = 'at_1234abcd';
  const todoContent = '整理本周客户反馈并汇总需要优先修复的问题';
  const autoTitle = '每天早上汇总最新行业资讯并发送到项目中';
  const report = app.createWorkspaceFile('report.md', 'Task reference alignment');
  await app.invoke('projects.tasks.create', { taskId: todo, content: todoContent });
  await app.invoke('autoTasks.create', { id: automation, title: autoTitle, content: 'Collect industry news',
    enabled: false, schedule: { type: 'daily', hour: 9, minute: 0 } });
  const content = [
    `Saved ${todo} and \`${automation}\`. 待办${todo}已保存。[查看报告](${report})`,
    '',
    '| Kind | Reference |', '| --- | --- |', `| To-do | \`${todo}\` |`,
    '',
    `Keep \`tasks/${todo}/task.json\`, \`task_id = "${todo}"\`, and [${todo}](https://example.com/${todo}) literal.`,
    '',
    `Invalid: t_e4fe5478466dx at_1234abc t_e4fe5478466d.txt prefix_${todo}. Missing: t_000000000000.`,
    '',
    '```json', `{"task_id":"${todo}","automation":"${automation}"}`, '```',
  ].join('\n');
  const { conversation } = await app.invoke<{ conversation: { conversation_id: string } }>(
    'conversations.create', { title: 'Task reference display' },
  );
  await page.evaluate(async ({ cid, content }) => {
    const runtime = window as any;
    runtime.setView('conversation', cid);
    await runtime.loadConversationHistory(cid);
    runtime.appendChatMessage({ role: 'assistant', content, time: 1000 }, false);
  }, { cid: conversation.conversation_id, content });
  const message = page.locator('#chat-history .chat-message.assistant').filter({ hasText: 'Invalid:' });
  const chips = message.locator('button.chat-task-reference');
  const expectInlineAlignment = async () => {
    const geometry = await chips.evaluateAll(elements => elements.map(element => {
      // Zero-size inline boxes expose the actual text baselines without
      // depending on the platform font's ascenders or a screenshot snapshot.
      const marker = () => {
        const span = document.createElement('span');
        span.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline';
        return span;
      };
      const surrounding = marker();
      const inside = marker();
      const label = element.querySelector('.chat-use-inline-name')!;
      const reference = element.closest('.markdown-body')!.querySelector('.chat-attach-chip.is-inline')!;
      const properties = ['fontSize', 'lineHeight', 'verticalAlign', 'padding', 'borderRadius',
        'borderColor', 'backgroundColor', 'marginInlineStart', 'marginInlineEnd'] as const;
      const style = getComputedStyle(element);
      const fileStyle = getComputedStyle(reference);
      const matchesFileStyle = properties.every(property => style[property] === fileStyle[property]);
      element.after(surrounding);
      label.prepend(inside);
      const baselineOffset = inside.getBoundingClientRect().top - surrounding.getBoundingClientRect().top;
      const icon = element.querySelector('svg')!.getBoundingClientRect();
      const fileIcon = reference.querySelector('svg')!.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      inside.remove();
      surrounding.remove();
      return { baselineOffset, matchesFileStyle, iconSize: [icon.width, icon.height],
        labelColor: getComputedStyle(label).color,
        fileLabelColor: getComputedStyle(reference.querySelector('.chat-attach-label')!).color,
        iconColor: getComputedStyle(element.querySelector('svg')!).color,
        fileIconColor: getComputedStyle(reference.querySelector('svg')!).color,
        fileIconSize: [fileIcon.width, fileIcon.height],
        iconCenterOffset: Math.abs((icon.top + icon.bottom - bounds.top - bounds.bottom) / 2),
        iconContained: icon.top >= bounds.top && icon.bottom <= bounds.bottom };
    }));
    expect(geometry).toHaveLength(4);
    for (const item of geometry) {
      expect(Math.abs(item.baselineOffset)).toBeLessThanOrEqual(0.5);
      expect(item.matchesFileStyle).toBe(true);
      expect(item.labelColor).toBe(item.fileLabelColor);
      expect(item.iconColor).toBe(item.fileIconColor);
      expect(item.iconSize).toEqual(item.fileIconSize);
      expect(item.iconSize).toEqual([16, 16]);
      expect(item.iconCenterOffset).toBeLessThanOrEqual(0.5);
      expect(item.iconContained).toBe(true);
    }
  };
  await expect(chips).toHaveCount(4);
  await expect(chips.first()).toHaveText('整理本周客户反馈并汇总需要优先…');
  await expect(chips.nth(1)).toHaveText('每天早上汇总最新行业资讯并发送…');
  await expect(chips.locator('svg')).toHaveCount(4);
  await expect(chips.first()).toHaveAttribute('title', todoContent);
  await expect(chips.nth(1)).toHaveAttribute('title', autoTitle);
  await expect(chips).not.toContainText([todo, automation, todo, todo]);
  await expect(message).toContainText('Missing: t_000000000000.');
  await expect(message.locator('pre code')).toHaveText(`{"task_id":"${todo}","automation":"${automation}"}`);
  await expect(message.locator('a')).toHaveText(todo);
  await expect(message.locator('.chat-attach-chip.is-inline')).toHaveText('查看报告');
  await expect(message.locator('code').filter({ hasText: 'tasks/' })).toHaveText(`tasks/${todo}/task.json`);
  await expect(message.locator('code').filter({ hasText: 'task_id =' })).toHaveText(`task_id = "${todo}"`);
  // The original Markdown remains the copy/retry source, including both IDs.
  expect(await message.evaluate((element, original) =>
    (window as any)._messageTextForActions(element, original), content)).toBe(content);
  expect(await page.evaluate(content => {
    const runtime = window as any;
    const cache = {};
    return runtime._renderMessageMarkdown(content, cache).join('') === runtime._renderMessageMarkdown(content);
  }, content)).toBe(true);
  await expectInlineAlignment();
  await page.screenshot({ path: testInfo.outputPath('task-references-en-wide.png') });
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.evaluate(() => (window as any).setLang('zh'));
  await expect(chips.first()).toHaveText('整理本周客户反馈并汇总需要优先…');
  await expect(chips.nth(1)).toHaveText('每天早上汇总最新行业资讯并发送…');
  expect(await chips.evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth))).toBe(true);
  await expectInlineAlignment();
  await page.screenshot({ path: testInfo.outputPath('task-references-zh-narrow.png') });
  await message.locator('.markdown-body > p').first().screenshot({ path: testInfo.outputPath('task-reference-preview.png') });
  await chips.first().click();
  await expect(page.locator(`#todos-content [data-tid="${todo}"]`)).toHaveClass(/\bis-highlighted\b/);
  await page.evaluate(async ({ cid, content }) => {
    const runtime = window as any;
    runtime.setView('conversation', cid);
    await runtime.loadConversationHistory(cid);
    runtime.appendChatMessage({ role: 'assistant', content, time: 1000 }, false);
  }, { cid: conversation.conversation_id, content });
  await message.locator('button.chat-task-reference').nth(1).click();
  await expect(page.locator(`#auto-list [data-task-id="${automation}"]`)).toHaveClass(/\bis-highlighted\b/);
});

test('recovers the completed reply without leaving the page when terminal delivery is lost', async ({ modelOrkas: app }) => {
  test.setTimeout(120_000);
  const page = app.page!;
  app.setModelMode('controlled-slow');
  // Drop only terminal bus delivery. Streaming, host execution, persistence,
  // and history reads remain real, so a cleanup that deletes the row fails.
  await page.evaluate(() => {
    const original = (window as any)._handleGroupBusEvent;
    (window as any).__droppedTerminalMessages = 0;
    (window as any)._handleGroupBusEvent = function(cid: string, row: unknown, event: any, opts: unknown) {
      if (event?.type === 'message' && event.msg?.from !== 'user') {
        (window as any).__droppedTerminalMessages++;
        return;
      }
      return original(cid, row, event, opts);
    };
  });
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill('Reply while I keep this page open.');
  await page.locator('#new-chat-send-btn').click();
  await expect.poll(() => app.modelRequests.length, { timeout: 30_000 }).toBe(1);
  app.releaseControlledModelChunk();
  const reply = page.locator('#chat-history .chat-message.assistant').filter({ hasText: 'Hello from the local E2E model.' });
  await expect(reply).toHaveCount(1);
  app.finishControlledModelStream();
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  await expect(reply).toHaveCount(1);
  await expect(reply).toHaveAttribute('data-msg-id', /.+/);
  expect(await page.evaluate(() => (window as any).__droppedTerminalMessages)).toBeGreaterThan(0);
  expect(app.modelRequests).toHaveLength(1);
});

// Local protocol responses drive real tools, persistence, and renderer navigation.
test('keeps saved automation and todo shortcuts usable live and after restart', async ({ modelOrkas: app }, testInfo) => {
  test.setTimeout(120_000);
  if (!app.page) throw new Error('Orkas renderer is unavailable');
  let page = app.page;
  const project = await app.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Release review' });
  app.setSavedTasksScenario('The tasks have been saved.');
  // Project to-dos belong to this conversation's project; a global chat cannot
  // select another backlog. Exercise the real project composer rather than
  // making the protocol fixture request cross-project permission.
  await page.evaluate(async projectId => {
    await (window as any).loadProjects(true);
    (window as any).setView('project', projectId);
  }, project.project.project_id);
  await expect(page.locator('#project-detail-title')).toHaveText('Release review');
  await page.locator('#project-chat-input').fill('Schedule a nightly review and add a release-note todo.');
  await page.locator('#project-chat-send-btn').click();
  await expect(page.locator('#chat-history .chat-message.assistant .chat-bubble > :is(.markdown-body, [data-role="final"])'))
    .toContainText('The tasks have been saved.', { timeout: 30_000 });
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  const { conversations } = await app.invoke<{
    conversations: Array<{ conversation_id: string; project_id?: string }>;
  }>('conversations.list');
  const cid = conversations.find(item => item.project_id === project.project.project_id)?.conversation_id;
  expect(cid).toBeTruthy();
  const { history } = await app.invoke<{ history: Array<{ saved_tasks?: Array<{ kind: string; task_id: string; title: string; project_id?: string }> }> }>(
    'conversations.history', { cid, limit: 20 },
  );
  const links = history.flatMap(row => row.saved_tasks || []);
  expect(links.map(link => [link.kind, link.title])).toEqual([
    ['automation', 'Nightly review'], ['todo', 'Review release notes'],
  ]);
  const automation = links.find(link => link.kind === 'automation')!;
  const todo = links.find(link => link.kind === 'todo')!;
  const storedAutomations = await app.invoke<{
    tasks: Array<{ id: string; title: string; project_id?: string; enabled: boolean }>;
  }>('autoTasks.list', { projectId: project.project.project_id });
  expect(storedAutomations.tasks).toEqual([
    expect.objectContaining({ id: automation.task_id, title: 'Nightly review',
      project_id: project.project.project_id, enabled: false }),
  ]);
  expect((await app.invoke<{ tasks: unknown[] }>('autoTasks.list', { projectId: null })).tasks).toEqual([]);
  expect(todo.project_id).toBe(project.project.project_id);
  const storedTodos = await app.invoke<{ tasks: Array<{ id: string; content: string }> }>(
    'projects.tasks.list', { projectId: project.project.project_id },
  );
  expect(storedTodos.tasks).toEqual([
    expect.objectContaining({ id: todo.task_id, content: 'Review release notes' }),
  ]);
  const globalTodos = await app.invoke<{ tasks: Array<{ id: string }> }>('projects.tasks.list');
  expect(globalTodos.tasks).toEqual([]);
  await app.invoke('projects.tasks.create', { projectId: project.project.project_id, content: 'Another release check' });
  await expect(page.locator('#chat-history [data-saved-task-key]')).toHaveCount(2);
  await page.evaluate(() => (window as any).setLang('zh'));
  await expect(page.locator('#chat-history [data-saved-task-key] .chat-msg-created-agent-label').first()).toContainText('打开');
  await page.evaluate(() => (window as any).setLang('en'));
  await expect(page.locator('#chat-history [data-saved-task-key] .chat-msg-created-agent-label').first()).toContainText('Open');
  await page.locator('#chat-history [data-saved-task-key]', { hasText: 'Nightly review' }).click();
  const autoCard = () => page.locator(`#auto-list .auto-row[data-task-id="${automation.task_id}"]`);
  const expectAutomationFocused = async () => {
    await expect(autoCard()).toBeInViewport();
    await expect(autoCard()).toHaveClass(/\bis-highlighted\b/);
    await expect(page.locator('#auto-list .auto-row.is-highlighted')).toHaveCount(1);
    await expect(page.locator('#auto-task-dialog-overlay')).toBeHidden();
    await expect(page.locator(`#auto-list .todo-scope-chip[data-project-id="${project.project.project_id}"]`))
      .toHaveAttribute('aria-pressed', 'true');
  };
  await expectAutomationFocused();
  const autoHighlight = await autoCard().evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, shadow: style.boxShadow };
  });
  await page.screenshot({ path: testInfo.outputPath('automation-shortcut-highlight-en.png') });
  await expect(autoCard()).not.toHaveClass(/\bis-highlighted\b/);
  await expect(autoCard()).not.toHaveCSS('background-color', autoHighlight.background);
  await expect(autoCard()).not.toHaveCSS('box-shadow', autoHighlight.shadow);
  // Editing remains an explicit action in the card's menu.
  await autoCard().hover();
  await autoCard().locator('.auto-row-more').click();
  await page.locator('.auto-row-menu-item[data-action="edit"]').click();
  await expect(page.locator('#auto-task-dialog-overlay')).toBeVisible();
  await expect(page.locator('#auto-title-input')).toHaveValue('Nightly review');
  await expect(page.locator(`#auto-list .todo-scope-chip[data-project-id="${project.project.project_id}"]`))
    .toHaveAttribute('aria-pressed', 'true');
  await page.locator('#auto-dialog-cancel-btn').click();
  await expect(page.locator(`#auto-list .auto-row[data-task-id="${automation.task_id}"]`)).toBeVisible();
  // Remember another scope and status grouping before following the shortcuts again.
  await page.locator('#auto-list .todo-scope-chip[data-project-id=""]').click();
  await openSidebarEntry(page, '#todos-btn');
  await page.locator('[data-todo-group="status"]').click();
  const todoCard = page.locator(`#todos-content [data-tid="${todo.task_id}"]`);
  await expect(todoCard).toBeVisible();
  const restingStyle = await todoCard.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, shadow: style.boxShadow };
  });
  await page.evaluate((id) => (window as any).setView('conversation', id), cid);
  await page.locator('#chat-history [data-saved-task-key]', { hasText: 'Review release notes' }).click();
  await expect(todoCard).toBeInViewport();
  await expect(todoCard).toHaveClass(/\bis-highlighted\b/);
  // A class alone misses board styles overriding the actual highlight.
  await expect(todoCard).not.toHaveCSS('background-color', restingStyle.background, { timeout: 1500 });
  await expect(todoCard).not.toHaveCSS('box-shadow', restingStyle.shadow, { timeout: 1500 });
  await expect(page.locator('#todos-content .is-highlighted')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('todo-shortcut-highlight-en.png') });
  await expect(todoCard).not.toHaveClass(/\bis-highlighted\b/);
  await expect(todoCard).toHaveCSS('background-color', restingStyle.background);
  await expect(todoCard).toHaveCSS('box-shadow', restingStyle.shadow);
  await expect(page.locator('[data-todo-group="project"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`#todos-content .todo-scope-chip[data-pid="${project.project.project_id}"]`))
    .toHaveAttribute('aria-pressed', 'true');
  // Reopening the shortcut should reveal the highlight again in a narrow window.
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.evaluate((id) => { (window as any).setLang('zh'); (window as any).setView('conversation', id); }, cid);
  await page.locator('#chat-history [data-saved-task-key]', { hasText: 'Review release notes' }).click();
  await expect(todoCard).toBeInViewport();
  await expect(todoCard).not.toHaveCSS('background-color', restingStyle.background, { timeout: 1500 });
  await page.screenshot({ path: testInfo.outputPath('todo-shortcut-highlight-zh-narrow.png') });
  await page.evaluate((id) => (window as any).setView('conversation', id), cid);
  await page.locator('#chat-history [data-saved-task-key]', { hasText: 'Nightly review' }).click();
  await expectAutomationFocused();
  await expect(autoCard()).toHaveCSS('background-color', autoHighlight.background);
  await page.screenshot({ path: testInfo.outputPath('automation-shortcut-highlight-zh-narrow.png') });
  page = await app.relaunch();
  const restored = await app.invoke<{
    conversations: Array<{ conversation_id: string; project_id?: string }>;
  }>('conversations.list');
  expect(restored.conversations.find(item => item.conversation_id === cid)?.project_id)
    .toBe(project.project.project_id);
  // Project conversations live in their project's sidebar, not the global
  // conversation list. Reopen through the same public route used above.
  await page.evaluate(id => (window as any).setView('conversation', id), cid);
  await expect(page.locator('#chat-history [data-saved-task-key]')).toHaveCount(2);
  await page.locator('#chat-history [data-saved-task-key]', { hasText: 'Nightly review' }).click();
  await expectAutomationFocused();
});
