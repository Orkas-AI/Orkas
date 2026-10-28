import { openSidebarEntry, expect, test } from './fixtures/orkas';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';

for (const scope of ['global', 'project'] as const) {
  test(`gives long ${scope} todo content room while keeping editor actions reachable`, async ({ orkas }, info) => {
    const page = orkas.page!;
    await page.evaluate(() => (window as any).setLang('en'));
    const project = scope === 'project' ? await orkas.invoke<any>('projects.create', { name: 'Editor layout' }) : null;
    const projectId = project?.project.project_id || '';
    const content = Array.from({ length: 30 }, (_, index) => `Checklist item ${index + 1}: preserve the original task content.`).join('\n');
    const created = await orkas.invoke<any>('projects.tasks.create', { projectId, content });
    const taskId = created.task.id;
    await orkas.invoke('projects.tasks.attachments.upload', {
      projectId, taskId, name: 'brief.txt', dataBase64: Buffer.from('Original attachment').toString('base64'),
    });
    const before = await orkas.invoke('projects.tasks.list', { projectId });
    if (projectId) {
      await page.evaluate(async (pid) => { await (window as any).setView('project', pid); }, projectId);
      await page.locator('[data-project-tab="todo"]').click();
    } else await page.locator('#todos-btn').click();
    const card = page.locator(`.project-todo-item[data-tid="${taskId}"]:visible`);
    await card.hover();
    await card.locator('[data-action="todo-menu"]').click();
    await page.locator('.context-menu-item').filter({ hasText: /^Edit$/ }).click();
    const field = page.locator('#project-todo-input');
    await expect(field).toHaveValue(content);
    await expect(page.locator('#project-todo-attachments')).toContainText('brief.txt');
    const editorRoom = () => page.evaluate(() => {
      const dialog = document.querySelector('#todo-editor-modal .todo-editor-dialog') as HTMLElement;
      const input = document.getElementById('project-todo-input') as HTMLTextAreaElement;
      return {
        lines: Math.floor(input.clientHeight / parseFloat(getComputedStyle(input).lineHeight)),
        fieldScrolls: input.scrollHeight > input.clientHeight,
        dialogScrolls: dialog.scrollHeight > dialog.clientHeight + 1,
      };
    });
    for (const [width, height, minimumLines] of [[1280, 800, 8], [1440, 900, 12]]) {
      await page.setViewportSize({ width, height });
      await expect.poll(async () => (await editorRoom()).lines).toBeGreaterThanOrEqual(minimumLines);
      expect(await editorRoom()).toMatchObject({ fieldScrolls: true, dialogScrolls: false });
      await expect(page.locator('#project-todo-save')).toBeInViewport();
      await field.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      expect(await field.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await page.screenshot({ path: info.outputPath(`todo-editor-${width}.png`) });
    }
    // Small windows may scroll the dialog; cancellation still reaches the action.
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.locator('#project-todo-cancel').scrollIntoViewIfNeeded();
    await expect(page.locator('#project-todo-cancel')).toBeInViewport();
    await page.locator('#project-todo-cancel').click();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator(projectId ? '#project-todo-add-btn' : '#todos-add-btn').click();
    await expect(field).toHaveValue('');
    expect(await editorRoom()).toEqual({ lines: 6, fieldScrolls: false, dialogScrolls: false });
    await field.fill('A short draft');
    expect(await editorRoom()).toEqual({ lines: 6, fieldScrolls: false, dialogScrolls: false });
    await page.locator('#project-todo-cancel').click();
    expect(await orkas.invoke('projects.tasks.list', { projectId })).toEqual(before);
  });
}

for (const language of ['en', 'zh']) {
test(`confirms red to-do deletion and preserves cancelled work across account and project boards (${language})`, async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  await page.evaluate(lang => (window as any).setLang(lang), language);
  await page.setViewportSize({ width: language === 'en' ? 1440 : 1024, height: language === 'en' ? 900 : 720 });
  const { project } = await orkas.invoke<any>('projects.create', { name: 'Release checks' });
  for (const entry of ['account', 'project']) {
    const projectId = entry === 'account' ? '' : project.project_id;
    const content = language === 'en'
      ? 'Review <release> & deployment notes before deleting this to-do\nKeep the remaining work intact.'
      : '删除前核对 <发布> & 部署说明，确认这是要删除的待办\n其他待办应当保留。';
    const { task } = await orkas.invoke<any>('projects.tasks.create', { projectId, content });
    const { task: retained } = await orkas.invoke<any>('projects.tasks.create', { projectId, content: 'Keep this work' });
    if (entry === 'account') await openSidebarEntry(page, '#todos-btn');
    else {
      await page.evaluate(async id => (window as any).setView('project', id), projectId);
      await page.locator('[data-project-tab="todo"]').click();
    }
    const host = page.locator(entry === 'account' ? '#todos-content' : '#project-todo-list');
    const card = host.locator(`.project-todo-item[data-tid="${task.id}"]`);
    const menuButton = card.locator('[data-action="todo-menu"]');
    const openDelete = async (keyboard = false) => {
      await card.hover();
      await menuButton.click();
      const remove = page.getByRole('menuitem', { name: language === 'en' ? 'Delete' : '删除', exact: true });
      await expect(remove).toHaveCSS('color', 'rgb(220, 38, 38)');
      await expect(page.getByRole('menuitem', { name: language === 'en' ? 'Edit' : '编辑', exact: true }))
        .not.toHaveCSS('color', 'rgb(220, 38, 38)');
      await page.locator('.context-menu').screenshot({ path: testInfo.outputPath(`todo-delete-menu-${entry}-${language}.png`) });
      if (keyboard) {
        await page.keyboard.press('End');
        await expect(remove).toBeFocused();
        await expect(remove).toHaveCSS('color', 'rgb(220, 38, 38)');
        await page.keyboard.press('Enter');
      } else {
        await remove.hover();
        await expect(remove).toHaveCSS('color', 'rgb(220, 38, 38)');
        await remove.click();
      }
    };
    const dialog = page.getByRole('alertdialog');
    const tasks = async () => (await orkas.invoke<any>('projects.tasks.list', { projectId })).tasks;
    await openDelete();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.ui-dialog-message')).toHaveText(content, { useInnerText: true });
    await expect(dialog.locator('[data-act="cancel"]')).toBeFocused();
    expect((await tasks()).map((item: any) => item.id)).toContain(task.id);
    await dialog.screenshot({ path: testInfo.outputPath(`todo-delete-confirm-${entry}-${language}.png`) });
    await dialog.locator('[data-act="cancel"]').click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toBeVisible();
    await expect(menuButton).toBeFocused();
    expect((await tasks()).map((item: any) => item.id)).toContain(task.id);

    await openDelete(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(menuButton).toBeFocused();
    expect((await tasks()).map((item: any) => item.id)).toContain(task.id);

    await openDelete(true);
    const cancel = dialog.locator('[data-act="cancel"]');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.locator('[data-act="ok"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(menuButton).toBeFocused();
    expect((await tasks()).map((item: any) => item.id)).toContain(task.id);

    await openDelete();
    const confirm = dialog.locator('[data-act="ok"]');
    await expect(confirm).toHaveCSS('color', 'rgb(220, 38, 38)');
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toHaveCount(0);
    const remainingIds = (await tasks()).map((item: any) => item.id);
    expect(remainingIds).not.toContain(task.id);
    expect(remainingIds).toContain(retained.id);
  }
});
}

// The assignment journey exercises both account-scoped agents and execution.

for (const language of ['en', 'zh']) {
test(`creates todos in the selected project and defaults status grouping to global (${language})`, async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  await page.evaluate(lang => (window as any).setLang(lang), language);
  const { project: alpha } = await orkas.invoke<any>('projects.create', { name: 'Alpha' });
  const { project: beta } = await orkas.invoke<any>('projects.create', { name: 'Beta' });
  for (const projectId of ['', alpha.project_id, beta.project_id]) {
    await orkas.invoke('projects.tasks.create', { projectId, content: `Existing ${projectId || 'global'}` });
  }
  await openSidebarEntry(page, '#todos-btn');
  const picker = page.locator('#project-todo-project');
  const input = page.locator('#project-todo-input');
  const modal = page.locator('#todo-editor-modal');
  const selectProject = async (pid: string) => {
    await picker.locator('.ai-select-trigger').click();
    await page.locator(`#project-todo-project-listbox .ai-select-item[data-value="${pid}"]`).click();
  };
  await page.locator(`#todos-content .todo-scope-chip[data-pid="${alpha.project_id}"]`).click();
  await page.locator('#todos-add-btn').click();
  await expect(picker).toHaveAttribute('data-value', alpha.project_id);
  await expect(picker.locator('.ai-select-trigger')).toBeEnabled();
  await selectProject(beta.project_id);
  await input.fill('Cancelled draft');
  await page.evaluate(async () => (window as any)._refreshGlobalTodos());
  await expect(picker).toHaveAttribute('data-value', beta.project_id);
  await expect(input).toHaveValue('Cancelled draft');
  await page.locator('#project-todo-cancel').click();

  await page.locator('#todos-add-btn').click();
  await expect(picker).toHaveAttribute('data-value', alpha.project_id);
  await expect(input).toHaveValue('');
  await input.fill('Default Alpha task');
  await page.setViewportSize({ width: language === 'en' ? 1440 : 1024, height: 900 });
  await modal.screenshot({ path: testInfo.outputPath(`todo-default-project-${language}.png`) });
  await page.locator('#project-todo-save').click();
  await expect(modal).not.toHaveClass(/\bopen\b/);
  const alphaTasks = await orkas.invoke<any>('projects.tasks.list', { projectId: alpha.project_id });
  expect(alphaTasks.tasks.filter((task: any) => task.content === 'Default Alpha task')).toHaveLength(1);

  await page.locator('[data-todo-group="status"]').click();
  await page.locator('#todos-add-btn').click();
  await expect(picker).toHaveAttribute('data-value', '');
  await input.fill('Default global task');
  await page.locator('#project-todo-save').click();
  await expect(modal).not.toHaveClass(/\bopen\b/);
  const globalTasks = await orkas.invoke<any>('projects.tasks.list', {});
  expect(globalTasks.tasks.filter((task: any) => task.content === 'Default global task')).toHaveLength(1);
  expect(globalTasks.tasks.some((task: any) => task.content === 'Default Alpha task')).toBe(false);

  await page.locator('[data-todo-group="project"]').click();
  await page.locator('#todos-add-btn').click();
  await expect(picker).toHaveAttribute('data-value', alpha.project_id);
  await selectProject(beta.project_id);
  await input.fill('Explicit Beta task');
  await page.locator('#project-todo-save').click();
  await expect(modal).not.toHaveClass(/\bopen\b/);
  const betaTasks = await orkas.invoke<any>('projects.tasks.list', { projectId: beta.project_id });
  expect(betaTasks.tasks.filter((task: any) => task.content === 'Explicit Beta task')).toHaveLength(1);
  await page.locator('#todos-content .todo-scope-chip[data-pid=""]').click();
  await page.locator('#todos-add-btn').click();
  await expect(picker).toHaveAttribute('data-value', '');
  await page.locator('#project-todo-cancel').click();
});
}

test('keeps todo card appearance and unfinished processing consistent across both entry points', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  await page.evaluate(() => (window as any).setLang('zh'));
  const project = await orkas.invoke<any>('projects.create', { name: 'Consistent cards' });
  const pid = project.project.project_id;
  const tasks = [];
  for (const status of ['todo', 'progress', 'review', 'done']) {
    const created = await orkas.invoke<any>('projects.tasks.create', {
      projectId: pid, content: `Check ${status} work\nKeep its full brief`, status,
    });
    tasks.push(created.task);
  }
  const before = await orkas.invoke<any>('projects.tasks.list', { projectId: pid });
  const appearance = (card: ReturnType<typeof page.locator>) => card.evaluate(element => {
    const properties = ['display', 'gap', 'padding', 'borderRadius', 'backgroundColor', 'fontSize',
      'fontWeight', 'lineHeight', 'opacity', 'order'];
    return ['.project-todo-title', '.todo-card-meta', '.project-todo-assign',
      '.project-todo-status-select'].map(selector => {
      const control = element.querySelector(selector)!;
      const style = getComputedStyle(control);
      return { text: control.textContent, style: Object.fromEntries(properties.map(key => [key, (style as any)[key]])) };
    });
  });
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const appearances = [];
    for (const entry of ['account', 'project']) {
      if (entry === 'account') {
        await openSidebarEntry(page, '#todos-btn');
        await page.locator(`#todos-content .todo-scope-chip[data-pid="${pid}"]`).click();
      } else {
        await page.evaluate(async id => (window as any).setView('project', id), pid);
        await page.locator('[data-project-tab="todo"]').click();
      }
      const host = page.locator(entry === 'account' ? '#todos-content' : '#project-todo-list');
      await host.locator('.todo-column.is-done .todo-collapse').click();
      for (const [index, task] of tasks.entries()) {
        const card = host.locator(`.project-todo-item[data-tid="${task.id}"]`);
        const statusControl = card.locator('[data-action="todo-status"]');
        await page.mouse.move(0, 0);
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await expect(card.locator('.todo-card-meta')).toHaveCount(1);
        // Both entry points reveal the status control only with the card's hover/focus controls.
        await expect(statusControl).toHaveCSS('opacity', '0');
        await expect(statusControl).toHaveCSS('pointer-events', 'none');
        const layout = () => card.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const status = element.querySelector('[data-action="todo-status"]')!.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height, statusX: status.x - bounds.x, statusY: status.y - bounds.y };
        });
        const restingLayout = await layout();
        await card.hover();
        await expect(statusControl).toHaveCSS('opacity', '1');
        await expect(statusControl).toHaveCSS('pointer-events', 'auto');
        // Narrow boards may scroll horizontally to reveal a hovered card.
        const hoveredLayout = await layout();
        // Scrolling can change floating-point subtraction without moving a control.
        for (const key of ['width', 'height', 'statusX', 'statusY'] as const) {
          expect(hoveredLayout[key]).toBeCloseTo(restingLayout[key], 2);
        }
        expect(await card.evaluate(element => {
          const footer = element.querySelector('.todo-card-meta')!.getBoundingClientRect();
          const status = element.querySelector('[data-action="todo-status"]')!.getBoundingClientRect();
          return Math.abs(footer.right - status.right);
        })).toBeLessThanOrEqual(1);
        if (entry === 'account') appearances[index] = await appearance(card);
        else expect(await appearance(card)).toEqual(appearances[index]);
        await card.locator('[data-action="todo-menu"]').click();
        await expect(page.locator('.context-menu-item', { hasText: '立即处理' })).toHaveCount(task.status === 'done' ? 0 : 1);
        await page.keyboard.press('Escape');
      }
      await host.screenshot({ path: testInfo.outputPath(`todo-cards-${entry}-${width}.png`) });
      const firstCard = host.locator(`.project-todo-item[data-tid="${tasks[0].id}"]`);
      const statusControl = firstCard.locator('[data-action="todo-status"]');
      for (const locale of ['zh', 'en']) {
        await page.evaluate(lang => (window as any).setLang(lang), locale);
        await page.mouse.move(0, 0);
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await expect(statusControl).toHaveCSS('opacity', '0');
        await expect.poll(() => host.locator('[data-action="todo-status"]').evaluateAll(elements =>
          elements.map(element => getComputedStyle(element).opacity)))
          .toEqual(tasks.map(() => '0'));
        await host.screenshot({ path: testInfo.outputPath(`todo-resting-${entry}-${width}-${locale}.png`) });
        await firstCard.locator('.project-todo-title').focus();
        // Tab through the card's real controls to the status menu.
        for (let step = 0; step < 5 && !(await statusControl.evaluate(el => el === document.activeElement)); step++) {
          await page.keyboard.press('Tab');
        }
        await expect(statusControl).toBeFocused();
        await expect(statusControl).toHaveCSS('opacity', '1');
        await page.keyboard.press('Enter');
        await expect(page.locator('.context-menu')).toBeVisible();
        await page.keyboard.press('Escape');
        await host.screenshot({ path: testInfo.outputPath(`todo-focused-${entry}-${width}-${locale}.png`) });
      }
      await page.evaluate(() => (window as any).setLang('zh'));
      // Restore the collapse preference before the next visit.
      await host.locator('.todo-column.is-done .todo-collapse').click();
    }
  }
  expect(await orkas.invoke('projects.tasks.list', { projectId: pid })).toEqual(before);
});

test('binds auto-advance locally and lets another device disable then re-enable it', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  await page.evaluate(() => (window as any).setLang('zh'));
  // Completed backlog: this UI/IPC journey must not enqueue model work.
  const created = await orkas.invoke<any>('projects.create', { name: 'Auto-advance device' });
  const pid = created.project.project_id;
  await orkas.invoke('projects.tasks.create', { projectId: pid, content: 'Completed project work', status: 'done' });
  await orkas.invoke('projects.tasks.create', { content: 'Completed global work', status: 'done' });
  const writeCloudConfig = (config: Record<string, unknown>) => orkas.electronApp!.evaluate(async (_electron, input) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const fs = require('node:fs/promises'), path = require('node:path');
    const uid = require(path.join(input.main, 'features/users.ts')).getActiveUserId();
    const file = require(path.join(input.main, 'paths.ts')).projectDriverFile(uid, input.pid);
    await fs.writeFile(file, JSON.stringify(input.config));
  }, { main: path.resolve(__dirname, '../../src/main'), pid, config });
  // Upgrading an enabled legacy project must display off until the user enables it.
  await writeCloudConfig({ enabled: true, max_advances_per_day: 20 });
  expect((await orkas.invoke<any>('projects.driver.get', { projectId: pid })).config.enabled).toBe(false);
  await page.evaluate(async id => (window as any).setView('project', id), pid);
  await page.locator('[data-project-tab="todo"]').click();
  const toggle = page.locator('#project-driver-toggle');
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const local = await orkas.invoke<any>('projects.driver.get', { projectId: pid });
  await expect(toggle).toHaveText('自动推进 · 本机');
  expect(local.config).toMatchObject({ enabled: true, device_id: local.device.id, device_name: local.device.name });

  await openSidebarEntry(page, '#todos-btn');
  await page.locator(`#todos-content .todo-scope-chip[data-pid="${pid}"]`).click();
  const scopeToggle = page.locator(`#todos-content .todo-scope-driver-toggle[data-pid="${pid}"]`);
  await expect(scopeToggle).toHaveText('自动推进 · 本机');
  await page.locator('#todos-content .todo-scope-chip[data-pid=""]').click();
  const globalToggle = page.locator('#todos-content .todo-scope-driver-toggle[data-pid=""]');
  await globalToggle.click();
  await expect(globalToggle).toHaveText('自动推进 · 本机');
  await page.locator('[data-todo-group="status"]').click();
  await expect(scopeToggle).toHaveText('Auto-advance device · 本机');
  await expect(globalToggle).toHaveText('全局 · 本机');
  await page.evaluate(() => (window as any).setLang('en'));
  await expect(scopeToggle).toContainText(' · This device');
  await expect(globalToggle).toContainText(' · This device');
  await page.evaluate(() => (window as any).setLang('zh'));

  // A sync pull replaces the cloud config with another installation's opt-in.
  await writeCloudConfig({ enabled: true, max_advances_per_day: 20,
    device_id: 'another-installation', device_name: 'Office Mac' });
  await page.evaluate(async id => (window as any)._refreshGlobalTodos(id), pid);
  await expect(scopeToggle).toHaveText('Auto-advance device · Office Mac');
  await page.locator('[data-todo-group="project"]').click();
  await page.locator(`#todos-content .todo-scope-chip[data-pid="${pid}"]`).click();
  await expect(scopeToggle).toHaveText('自动推进 · Office Mac');
  await page.evaluate(async id => (window as any).setView('project', id), pid);
  await page.locator('[data-project-tab="todo"]').click();
  await expect(toggle).toHaveText('自动推进 · Office Mac');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.screenshot({ path: testInfo.outputPath('auto-advance-remote-device.png') });
  await page.evaluate(() => (window as any).setLang('en'));
  await expect(toggle).toContainText(' · Office Mac');
  await page.evaluate(() => (window as any).setLang('zh'));
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('自动推进');
  expect((await orkas.invoke<any>('projects.driver.get', { projectId: pid })).config.enabled).toBe(false);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveText('自动推进 · 本机');
  expect((await orkas.invoke<any>('projects.driver.get', { projectId: pid })).config.device_id).toBe(local.device.id);
  await toggle.screenshot({ path: testInfo.outputPath('auto-advance-local-device.png') });
});

test('hides human responsibility and keeps optional Agent assignment on both boards and in the editor', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  await page.evaluate(() => (window as any).setLang('zh'));
  const project = await orkas.invoke<any>('projects.create', { name: 'Private responsibility' });
  const pid = project.project.project_id;
  const created = await orkas.invoke<any>('projects.tasks.create', { projectId: pid, content: 'Review private work' });
  const global = await orkas.invoke<any>('projects.tasks.create', { content: 'Review global work' });
  await openSidebarEntry(page, '#todos-btn');
  for (const [scope, tid] of [['', global.task.id], [pid, created.task.id]]) {
    await page.locator(`#todos-content .todo-scope-chip[data-pid="${scope}"]`).click();
    const card = page.locator(`#todos-content .project-todo-item[data-tid="${tid}"]`);
    await expect(card.getByText('E2E Member', { exact: true })).toHaveCount(0);
    await expect(card.locator('.project-todo-assign')).toHaveText('未指定');
    await expect(card.locator('.project-todo-assign')).toBeVisible();
  }
  await page.evaluate(async id => (window as any).setView('project', id), pid);
  await page.locator('[data-project-tab="todo"]').click();
  const card = page.locator(`#project-todo-list .project-todo-item[data-tid="${created.task.id}"]`);
  await expect(card.getByText('E2E Member', { exact: true })).toHaveCount(0);
  await expect(card.locator('.project-todo-assign')).toHaveText('未指定');
  await card.screenshot({ path: testInfo.outputPath('private-todo-responsibility.png') });
  for (const editing of [false, true]) {
    if (editing) {
      await card.hover();
      await card.locator('[data-action="todo-menu"]').click();
      await page.locator('.context-menu-item', { hasText: '编辑' }).click();
    } else {
      await page.locator('#project-todo-add-btn').click();
    }
    await expect(page.locator('#todo-editor-modal').getByText('E2E Member', { exact: true })).toHaveCount(0);
    await expect(page.locator('#project-todo-agent .ai-select-trigger')).toContainText('未指定');
    await expect(page.locator('#project-todo-agent .ai-select-trigger')).toBeEnabled();
    await page.locator('#todo-editor-modal').screenshot({ path: testInfo.outputPath(`private-todo-${editing ? 'edit' : 'create'}.png`) });
    if (editing) {
      await page.setViewportSize({ width: 1024, height: 720 });
      await page.evaluate(() => (window as any).setLang('en'));
      await expect(page.locator('#todo-editor-modal').getByText('E2E Member', { exact: true })).toHaveCount(0);
      await page.locator('#todo-editor-modal').screenshot({ path: testInfo.outputPath('private-todo-edit-en-narrow.png') });
      await page.locator('#project-todo-input').fill('Reviewed private work');
      await page.locator('#project-todo-save').click();
    } else {
      await page.locator('#project-todo-cancel').click();
    }
  }
  const saved = await orkas.invoke<any>('projects.tasks.list', { projectId: pid });
  expect(saved.tasks).toHaveLength(1);
  expect(saved.tasks[0]).toMatchObject({ id: created.task.id, content: 'Reviewed private work' });
  for (const task of [created.task, global.task, saved.tasks[0]]) {
    expect(task).not.toHaveProperty('assignee_uid');
    expect(task).not.toHaveProperty('assignee_name');
  }
  expect(saved.tasks[0].owner_agent_id).toBeUndefined();
});

test('reads full todo card text with repeatable mouse and keyboard disclosure on both boards', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  await page.evaluate(() => (window as any).setLang('zh'));
  const project = await orkas.invoke<any>('projects.create', { name: '阅读待办' });
  const pid = project.project.project_id;
  // An expanded card must exceed the project viewport to exercise the header
  // and scrolling boundary, rather than only checking text inside the button.
  const text = '核对完整说明\n第一段：保留换行，说明详细目标。\n第二段：' + '长文本'.repeat(1000) + '\n最后一行：<literal> & 保留原文';
  const created = await orkas.invoke<any>('projects.tasks.create', { projectId: pid, content: text });
  const global = await orkas.invoke<any>('projects.tasks.create', { content: text });
  const before = await orkas.invoke<any>('projects.tasks.list', { projectId: pid });
  await openSidebarEntry(page, '#todos-btn');
  for (const [scope, tid] of [['', global.task.id], [pid, created.task.id]]) {
    await page.locator(`#todos-content .todo-scope-chip[data-pid="${scope}"]`).click();
    const card = page.locator(`#todos-content .project-todo-item[data-tid="${tid}"]`);
    const title = card.locator('.project-todo-title');
    await expect(title).toHaveAttribute('aria-expanded', 'false');
    const collapsedHeight = await title.evaluate(element => element.clientHeight);
    await title.click();
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    expect(await title.textContent()).toBe(text);
    expect(await title.evaluate(element => element.clientHeight >= element.scrollHeight)).toBe(true);
    expect(await title.evaluate(element => element.clientHeight)).toBeGreaterThan(collapsedHeight);
    await expect(page.locator('#todo-editor-modal')).not.toHaveClass(/\bopen\b/);
    // The footer control keeps its original action without closing the content.
    const status = card.locator('[data-action="todo-status"]');
    await status.scrollIntoViewIfNeeded();
    // Let the scroll event dismiss existing popups before the next gesture,
    // as when a reader scrolls down to the footer and then opens its menu.
    await status.evaluate(() => new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await status.click();
    await expect(page.locator('.context-menu-item')).toHaveCount(4);
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await title.press('Space');
    await expect(title).toHaveAttribute('aria-expanded', 'false');
    await title.press('Enter');
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    await page.evaluate(async () => (window as any)._refreshGlobalTodos(''));
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    // Clicking the card padding is also a disclosure gesture.
    await card.click({ position: { x: 3, y: 3 } });
    await expect(title).toHaveAttribute('aria-expanded', 'false');
  }
  await page.evaluate(async (id) => (window as any).setView('project', id), pid);
  await page.locator('[data-project-tab="todo"]').click();
  const card = page.locator(`#project-todo-list .project-todo-item[data-tid="${created.task.id}"]`);
  const title = card.locator('.project-todo-title');
  const column = page.locator('#project-todo-list .todo-column.is-todo');
  const header = column.locator('.todo-column-head');
  const headerHeight = (await header.boundingBox())!.height;
  await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  expect((await header.boundingBox())!.height).toBeGreaterThanOrEqual(headerHeight - 1);
  const body = card.locator('..');
  await body.evaluate(element => { element.scrollTop = 0; });
  const [headerBox, bodyStart, cardStart] = await Promise.all([
    header.boundingBox(), body.boundingBox(), card.boundingBox(),
  ]);
  expect(bodyStart!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1);
  expect(cardStart!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
  expect(await title.evaluate(element => element.clientHeight >= element.scrollHeight)).toBe(true);
  await page.evaluate(async (id) => (window as any)._loadProjectTodos(id), pid);
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: testInfo.outputPath('expanded-todo-card.png') });
  await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const [titleBox, bodyBox] = await Promise.all([title.boundingBox(), body.boundingBox()]);
  expect(titleBox!.y + titleBox!.height).toBeLessThanOrEqual(bodyBox!.y + bodyBox!.height + 1);
  expect(titleBox!.y + titleBox!.height).toBeGreaterThan(bodyBox!.y);
  await page.screenshot({ path: testInfo.outputPath('expanded-todo-card-end.png') });
  await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await card.hover();
  await card.locator('[data-action="todo-menu"]').click();
  await page.locator('.context-menu-item', { hasText: '编辑' }).click();
  await expect(page.locator('#project-todo-input')).toHaveValue(text);
  // Long content gets the room the dialog has: the field grows to the dialog's
  // height cap and scrolls inside, while the dialog itself does not scroll.
  const editorRoom = () => page.evaluate(() => {
    const dialog = document.querySelector('#todo-editor-modal .todo-editor-dialog') as HTMLElement;
    const field = document.getElementById('project-todo-input') as HTMLTextAreaElement;
    return {
      lines: Math.floor(field.clientHeight / parseFloat(getComputedStyle(field).lineHeight)),
      fieldScrolls: field.scrollHeight > field.clientHeight,
      dialogScrolls: dialog.scrollHeight > dialog.clientHeight + 1,
    };
  });
  const longRoom = await editorRoom();
  // The date/member fields consume real space; grow to the actual dialog cap
  // rather than assuming the previous form always had room for eight lines.
  expect(longRoom.lines).toBeGreaterThan(6);
  expect(await page.locator('#todo-editor-modal .todo-editor-dialog').evaluate(element =>
    Math.abs(element.getBoundingClientRect().height - parseFloat(getComputedStyle(element).maxHeight)) < 2,
  )).toBe(true);
  expect(longRoom).toMatchObject({ fieldScrolls: true, dialogScrolls: false });
  await expect(page.locator('#project-todo-cancel')).toBeInViewport();
  await expect(page.locator('#project-todo-save')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('todo-editor-long.png') });
  await page.locator('#project-todo-cancel').click();
  // An empty field still offers six lines.
  await page.locator('#project-todo-add-btn').click();
  await expect(page.locator('#project-todo-input')).toHaveValue('');
  expect(await editorRoom()).toEqual({ lines: 6, fieldScrolls: false, dialogScrolls: false });
  await page.screenshot({ path: testInfo.outputPath('todo-editor-empty.png') });
  for (const width of [1024, 480]) {
    await page.setViewportSize({ width, height: 600 });
    expect((await editorRoom()).lines).toBeGreaterThanOrEqual(6);
    const inputBox = (await page.locator('#project-todo-composer').boundingBox())!;
    const fieldsBox = (await page.locator('#todo-editor-modal .todo-editor-field-grid').boundingBox())!;
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(fieldsBox.y);
    await page.locator('#project-todo-cancel').scrollIntoViewIfNeeded();
    await expect(page.locator('#project-todo-cancel')).toBeInViewport();
    await expect(page.locator('#project-todo-save')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`todo-editor-short-${width}.png`) });
  }
  await page.locator('#project-todo-cancel').click();
  expect(await orkas.invoke('projects.tasks.list', { projectId: pid })).toEqual(before);
});

test('manages the same backlog from global and project boards without a duplicate project disclosure', async ({ orkas }, testInfo) => {
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
    await orkas.invoke('projects.tasks.create', { projectId, content: title, status });
  }
  const alphaTasks = await orkas.invoke<{ tasks: Array<{ id: string; content: string }> }>('projects.tasks.list', { projectId: a });
  const assignedTask = alphaTasks.tasks.find((task) => task.content === '设计项目看板')!;
  const completedTask = alphaTasks.tasks.find((task) => task.content === '确认视觉规范')!;
  await orkas.invoke('projects.tasks.update', {
    projectId: a,
    taskId: assignedTask.id,
    owner_agent: agent.name,
    owner_agent_id: agent.agent_id,
  });
  await openSidebarEntry(page, '#todos-btn');
  const content = page.locator('#todos-content');
  const header = page.locator('#panel-todos .project-detail-header');
  await expect(header.locator('.todo-page-actions')).toBeVisible();
  await expect(header.locator('.todo-page-description')).toHaveCount(0);
  await expect(page.locator('#todos-project-filter')).toHaveCount(0);
  await expect(page.locator('#todos-add-btn')).toHaveText('+创建');
  await expect(page.locator('#todos-add-btn')).not.toHaveClass(/btn-primary/);
  // Every scope with tasks gets a switcher chip; only the picked one paints a board.
  await expect(content.locator('.todo-scope-chip')).toHaveCount(2);
  await expect(content.locator('.todo-scope-chip[aria-pressed="true"]')).toHaveCount(1);
  await expect(content.getByText('空项目', { exact: true })).toHaveCount(0);
  await expect(content.getByText('查看项目', { exact: true })).toHaveCount(0);
  await content.locator(`.todo-scope-chip[data-pid="${a}"]`).click();
  await expect(content.locator('.todo-project-group')).toHaveCount(1);
  await expect(content.locator('.todo-project-group')).toHaveAttribute('data-pid', a);
  await expect(content.locator('.todo-project-head')).toHaveCount(0);
  await expect(content.locator('.todo-scope-actions .todo-project-add')).toHaveCount(0);
  await expect(content.locator('.todo-scope-actions .todo-scope-driver-toggle')).toHaveCount(1);
  await expect(content.locator('.todo-column-head .project-todo-menu')).toHaveCount(0);
  await expect(content.locator('.project-todo-item [data-action="todo-menu"]')).toHaveCount(4);
  await expect(content.getByText('整理首页文案', { exact: true })).toHaveCount(0);
  await expect(page.locator('#todos-btn')).toHaveText('待办');
  await expect(page.locator('[data-project-tab="todo"]')).toHaveText('待办 0');
  const alphaGroup = content.locator(`.todo-project-group[data-pid="${a}"]`);
  await expect(alphaGroup.locator('.todo-column-head .todo-collapse')).toHaveText(['待处理1', '处理中1', '待确认1', '已完成1']);
  await expect(alphaGroup.locator('.todo-board')).toBeVisible();
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
  await content.locator(`.todo-scope-chip[data-pid="${b}"]`).click();
  await expect(content.getByText('整理首页文案', { exact: true })).toBeVisible();
  await content.locator(`.todo-scope-chip[data-pid="${a}"]`).click();
  await expect(alphaGroup.locator('.todo-board')).toBeVisible();
  await expect(doneToggle).toHaveAttribute('aria-expanded', 'true');

  // The single page-level Create entry lets the user choose the target scope.
  await page.locator('#todos-add-btn').click();
  await page.locator('#project-todo-project .ai-select-trigger').click();
  await page.locator(`#project-todo-project-listbox .ai-select-item[data-value="${a}"]`).click();
  await expect(page.locator('#project-todo-project')).toHaveAttribute('data-value', a);
  await expect(page.locator('#project-todo-project .ai-select-trigger')).toBeEnabled();
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

  // Status grouping defaults to an account-level to-do even after selecting a
  // project. Dropped files use the same path as the composer's + button.
  await page.locator('[data-todo-group="status"]').click();
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
  const globalSaved = await orkas.invoke<{ tasks: Array<{ id: string; content: string; detail?: string; status: string; attachments?: string[] }> }>('projects.tasks.list', {});
  const globalTask = globalSaved.tasks.find((task) => task.content === '全局跟进发票')!;
  expect(globalTask).toMatchObject({
    status: 'todo',
    attachments: ['global-notes.txt'],
  });
  expect(globalTask.detail).toBeUndefined();
  await page.locator('[data-todo-group="project"]').click();
  await expect(content.locator('.todo-scope-chip')).toHaveCount(3);
  await content.locator('.todo-scope-chip[data-pid=""]').click();
  await expect(content.locator('.todo-project-group')).toHaveCount(1);
  const globalGroup = content.locator('.todo-project-group[data-pid=""]');
  await expect(globalGroup).toContainText('全局跟进发票');
  await expect(content.locator('.todo-scope-row .todo-scope-driver-toggle[data-pid=""]')).toBeVisible();
  await expect(globalGroup.locator('.todo-column.is-progress .todo-column-empty')).toHaveCSS('text-align', 'center');
  await expect(globalGroup.locator('.todo-board')).toBeVisible();
  await content.locator(`.todo-scope-chip[data-pid="${a}"]`).click();
  await expect(alphaGroup.locator('.todo-board')).toBeVisible();
  await content.locator('.todo-scope-chip[data-pid=""]').click();
  await expect(globalGroup.locator('.todo-board')).toBeVisible();

  // The same editor can still opt into a project explicitly.
  await page.locator('#todos-add-btn').click();
  await page.locator('#project-todo-project .ai-select-trigger').click();
  await page.locator(`#project-todo-project-listbox .ai-select-item[data-value="${b}"]`).click();
  await page.locator('#project-todo-input').fill('完善价格页');
  await page.locator('#project-todo-status .ai-select-trigger').click();
  await page.locator('#project-todo-status-listbox .ai-select-item[data-value="review"]').click();
  await page.locator('#project-todo-save').click();
  await expect(page.locator('#todo-editor-modal')).not.toHaveClass(/\bopen\b/);
  const saved = await orkas.invoke<{ tasks: Array<{ id: string; content: string; detail?: string; status: string }> }>('projects.tasks.list', { projectId: b });
  const created = saved.tasks.find((task) => task.content === '完善价格页')!;
  expect(created).toMatchObject({ status: 'review' });
  expect(created.detail).toBeUndefined();
  const otherProject = await orkas.invoke<{ tasks: Array<{ content: string }> }>('projects.tasks.list', { projectId: a });
  expect(otherProject.tasks.some((task) => task.content === '完善价格页')).toBe(false);
  expect(saved.tasks.some((task) => task.content === '全局跟进发票')).toBe(false);

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
  // Flex wrapping retains the public project, optional Agent and status reading order.
  const metadata = await task.locator('.todo-card-meta').evaluate((element) => {
    const box = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, height: rect.height };
    };
    return {
      bounds: box(element),
      controls: Array.from(element.querySelectorAll('.todo-card-project, .project-todo-assign, .project-todo-status-select')).map(box),
    };
  });
  expect(metadata.controls).toHaveLength(3);
  for (const control of metadata.controls) {
    expect(control.height).toBeGreaterThan(0);
    expect(control.x).toBeGreaterThanOrEqual(metadata.bounds.x - 1);
    expect(control.right).toBeLessThanOrEqual(metadata.bounds.right + 1);
    expect(control.y).toBeGreaterThanOrEqual(metadata.bounds.y - 1);
    expect(control.bottom).toBeLessThanOrEqual(metadata.bounds.bottom + 1);
  }
  expect(metadata.bounds.height).toBeLessThanOrEqual(3 * Math.max(...metadata.controls.map(control => control.height)) + 24);
  for (let index = 1; index < metadata.controls.length; index++) {
    const previous = metadata.controls[index - 1], current = metadata.controls[index];
    if (Math.abs(current.y - previous.y) < 4) expect(current.x).toBeGreaterThanOrEqual(previous.right);
    else expect(current.y).toBeGreaterThanOrEqual(previous.bottom);
  }
  const globalCard = content.locator(`.project-todo-item[data-tid="${globalTask.id}"]`);
  await expect(globalCard).toHaveAttribute('data-todo-scope', 'global');
  await expect(globalCard.locator('span.todo-card-project')).toHaveText('全局');
  await expect(globalCard.locator('.todo-card-project-icon')).toHaveCount(1);
  await expect(globalCard.locator('button.todo-card-project')).toHaveCount(0);
  await task.hover();
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
    projectId: b, content: '后台同步待办', status: 'todo',
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
  const projectBoard = projectList.locator(':scope > .todo-board');
  const [listBox, boardBox] = await Promise.all([projectList.boundingBox(), projectBoard.boundingBox()]);
  expect(listBox).not.toBeNull();
  expect(boardBox).not.toBeNull();
  expect(boardBox!.x).toBeGreaterThanOrEqual(listBox!.x - 1);
  expect(boardBox!.x + boardBox!.width).toBeLessThanOrEqual(listBox!.x + listBox!.width + 1);
  // Four lanes in one row; the collapsed Completed lane narrows to a strip
  // and the open lanes share the rest.
  const projectLanes = await projectBoard.evaluate((board) => Array.from(board.children).map((lane) => {
    const box = lane.getBoundingClientRect();
    return { status: (lane as HTMLElement).dataset.status, top: Math.round(box.top), width: Math.round(box.width) };
  }));
  expect(projectLanes.map((lane) => lane.status)).toEqual(['todo', 'progress', 'review', 'done']);
  expect(new Set(projectLanes.map((lane) => lane.top)).size).toBe(1);
  expect(projectLanes[3].width).toBe(40);
  expect(Math.min(...projectLanes.slice(0, 3).map((lane) => lane.width))).toBeGreaterThanOrEqual(190);
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
  await page.setViewportSize({ width: 1024, height: 768 });
  const narrowGeometry = await projectBoard.evaluate((board) => {
    const list = board.parentElement!;
    const last = board.lastElementChild!;
    board.scrollLeft = board.scrollWidth;
    return {
      listRight: list.getBoundingClientRect().right,
      boardRight: board.getBoundingClientRect().right,
      lastRight: last.getBoundingClientRect().right,
      rows: new Set(Array.from(board.children).map((lane) => Math.round(lane.getBoundingClientRect().top))).size,
      boardOverflow: board.scrollWidth - board.clientWidth,
    };
  });
  expect(narrowGeometry.boardRight).toBeLessThanOrEqual(narrowGeometry.listRight + 1);
  expect(narrowGeometry.lastRight).toBeLessThanOrEqual(narrowGeometry.boardRight + 1);
  expect(narrowGeometry.rows).toBe(1);
  expect(narrowGeometry.boardOverflow).toBeGreaterThan(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Counts include completed/legacy tasks and reconcile external writes even
  // while the user is on a different project tab.
  await page.locator('[data-project-tab="tasks"]').click();
  const counted = await orkas.invoke<{ task: { id: string } }>('projects.tasks.create', {
    projectId: b, content: '核对待办总数', status: 'review',
  });
  await expect(todoTabCount).toHaveText('5');
  await orkas.invoke('projects.tasks.update', { projectId: b, taskId: counted.task.id, status: 'done' });
  await expect(todoTabCount).toHaveText('5');
  await orkas.invoke('projects.tasks.delete', { projectId: b, taskId: counted.task.id });
  await expect(todoTabCount).toHaveText('4');
  await page.locator('[data-project-tab="todo"]').click();
  await page.screenshot({ path: testInfo.outputPath('project-todos.png') });
  const editedCard = projectList.locator('.project-todo-item', { hasText: '完善价格页' });
  await editedCard.hover();
  await editedCard.locator('[data-action="todo-menu"]').click();
  await page.locator('.context-menu-item', { hasText: '编辑' }).click();
  await page.locator('#project-todo-input').fill('完善价格页与导航');
  await page.locator('#project-todo-save').click();
  await openSidebarEntry(page, '#todos-btn');
  await expect(content.getByText('完善价格页与导航', { exact: true })).toBeVisible();

  // Reopening the app reads persisted tasks and restores default disclosure states.
  const reloaded = await orkas.relaunch();
  await openSidebarEntry(reloaded, '#todos-btn');
  // A fresh launch focuses the first scope; the rest stay one chip away.
  await expect(reloaded.locator('#todos-content').getByText('全局跟进发票', { exact: true })).toBeVisible();
  await reloaded.locator(`#todos-content .todo-scope-chip[data-pid="${b}"]`).click();
  await expect(reloaded.locator('#todos-content').getByText('完善价格页与导航', { exact: true })).toBeVisible();
  await expect(reloaded.locator('#todos-content .todo-column.is-done .todo-collapse').first()).toHaveAttribute('aria-expanded', 'false');
  await expect(reloaded.locator('#todos-project-filter')).toHaveCount(0);
  await expect(reloaded.locator('#todos-content').getByText('空项目', { exact: true })).toHaveCount(0);
  const removed = reloaded.locator(`#todos-content .project-todo-item[data-tid="${created.id}"]`);
  await orkas.invoke('projects.tasks.delete', { projectId: b, taskId: created.id });
  await expect(removed).toHaveCount(0);
  const final = await orkas.invoke<{ tasks: Array<{ id: string }> }>('projects.tasks.list', { projectId: b });
  expect(final.tasks.some((item) => item.id === created.id)).toBe(false);
});

test('processes an assigned Codex todo from its card with one execution and no Commander panel', async ({ cliOrkas: orkas }) => {
  const page = orkas.page!;
  await page.evaluate(() => (window as any).setLang('en'));
  const { agent } = await orkas.invoke<{ agent: { agent_id: string } }>('agents.create', {
    name: 'AssignedCodex', category: 'general', runtime: { kind: 'cli', cli: 'codex' },
  });
  const { project } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Codex assignment' });
  const pid = project.project_id;
  await orkas.invoke('projects.bindings.add', { projectId: pid, kind: 'agent', id: agent.agent_id });

  for (const running of [false, true]) {
    // The existing CLI fixture holds this second turn open until stopped,
    // allowing us to inspect the panel while execution is actually running.
    const content = running ? 'E2E_CODEX_SEND_NOW_ACTIVE assigned todo' : 'Inspect the assigned project';
    const { task } = await orkas.invoke<{ task: { id: string } }>('projects.tasks.create', {
      projectId: pid, content, owner_agent_id: agent.agent_id,
    });
    await openSidebarEntry(page, '#todos-btn');
    const card = page.locator('#todos-content .project-todo-item', { hasText: content });
    await card.hover();
    await card.locator('[data-action="todo-menu"]').click();
    await page.locator('.context-menu-item', { hasText: 'Process now' }).click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect.poll(() => orkas.readCliState().invocations.filter((item) => item.prompt.includes(content)).length).toBe(1);
    const { tasks } = await orkas.invoke<{ tasks: Array<{ id: string; origin_cid?: string; status: string }> }>('projects.tasks.list', { projectId: pid });
    const started = tasks.find((item) => item.id === task.id)!;
    expect(started.status).toBe('progress');
    expect(started.origin_cid).toBeTruthy();
    const cid = started.origin_cid!;
    const execution = await orkas.invoke<{ tasks: Array<{ assignee: string; created_by: string; status: string; parent_task_id?: string }> }>('groupChat.tasks.list', { cid });
    expect(execution.tasks).toHaveLength(1);
    expect(execution.tasks[0]).toMatchObject({ assignee: agent.agent_id, created_by: 'user' });
    expect(execution.tasks[0].parent_task_id).toBeFalsy();
    await expect(page.locator('#chat-task-board')).toBeHidden();
    const invocation = orkas.readCliState().invocations.find((item) => item.prompt.includes(content))!;
    expect(invocation.cli).toBe('codex');
    expect(invocation.prompt).toContain('Complete and verify the work');
    expect(invocation.prompt).not.toContain('Act as the project Commander');
    if (running) {
      expect(execution.tasks[0].status).toBe('running');
      await orkas.invoke('groupChat.abort', { cid });
      await expect.poll(async () => {
        const current = await orkas.invoke<{ tasks: Array<{ status: string }> }>('groupChat.tasks.list', { cid });
        return current.tasks.every((item) => item.status !== 'running' && item.status !== 'queued');
      }).toBe(true);
    } else {
      await expect(page.locator('#chat-history')).toContainText('E2E_CODEX_DEFAULT_OK');
    }
    const history = await orkas.invoke<{ history: Array<{ from: string; to?: string[] }> }>('conversations.history', { cid, limit: 20 });
    expect(history.history.find((message) => message.from === 'user')?.to).toEqual([agent.agent_id]);
    expect(history.history.some((message) => message.from === 'commander')).toBe(false);
  }
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
  await openSidebarEntry(page, '#todos-btn');
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
    // The by-project view paints one scope at a time; focus the one just written to.
    await page.locator(`#todos-content .todo-scope-chip[data-pid="${scope}"]`).click();
    const card = page.locator('#todos-content .project-todo-item', { hasText: title });
    await expect(card.locator('.project-todo-assign')).toContainText(agent.name);
    let tasks = await orkas.invoke<{ tasks: any[] }>('projects.tasks.list', { projectId: scope });
    expect(tasks.tasks.find((t) => t.content === title)).toMatchObject({ owner_agent_id: agent.agent_id, owner_agent: agent.name });
    await card.hover();
    await card.locator('[data-action="todo-menu"]').click();
    await page.locator('.context-menu-item', { hasText: '编辑' }).click();
    await expect(agentControl).toHaveAttribute('data-value', agent.agent_id);
    await chooseAgent('');
    await page.locator('#project-todo-save').click();
    await expect(card.locator('.project-todo-assign')).toHaveClass(/is-empty/);
    tasks = await orkas.invoke<{ tasks: any[] }>('projects.tasks.list', { projectId: scope });
    expect(tasks.tasks.find((t) => t.content === title)).not.toHaveProperty('owner_agent_id');
    {
      await card.locator('.project-todo-assign').click();
      await page.locator('.context-menu-item', { hasText: agent.name }).click();
      await expect(card.locator('.project-todo-assign')).toContainText(agent.name);
      const assigned = await orkas.invoke<{ tasks: any[] }>('projects.tasks.list', { projectId: scope });
      const task = assigned.tasks.find((t) => t.content === title);
      orkas.setModelTextReplies(['Assignment received']);
      const result = await orkas.invoke<{ ok: boolean; cid: string }>('projects.tasks.run', { projectId: scope, taskId: task.id });
      expect(result.ok).toBe(true);
      const history = await orkas.invoke<{ history: any[] }>('conversations.history', { cid: result.cid, limit: 20 });
      expect(history.history.find((message) => message.from === 'user')?.to).toEqual([agent.agent_id]);
      await expect.poll(async () => {
        const messages = await orkas.invoke<{ history: any[] }>('conversations.history', { cid: result.cid, limit: 20 });
        return messages.history.some((message) => message.from === agent.agent_id && message.text.includes('Assignment received'));
      }).toBe(true);
      const finished = await orkas.invoke<{ history: any[] }>('conversations.history', { cid: result.cid, limit: 20 });
      expect(finished.history.some((message) => message.from === 'commander')).toBe(false);
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
test('reaches every to-do and keeps reading positions through background refreshes', async ({ connectorOrkas: orkas }, testInfo) => {
  const page = orkas.page!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => (window as any).setLang('zh'));
  const created = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: '滚动验证' });
  const pid = created.project.project_id;
  const detail = '一段足够长的说明文字，用来让卡片高度接近真实情况，从而让这一列超出看板高度。';
  for (let index = 1; index <= 15; index += 1) {
    await orkas.invoke('projects.tasks.create', { projectId: pid, title: `待办 ${index}`, status: 'todo', detail });
  }
  const referenceTask = await orkas.invoke<any>('projects.tasks.create', { projectId: pid, title: '对照待办', status: 'progress', detail });
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
  await openSidebarEntry(page, '#todos-btn');
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
  const globalList = page.locator('#todos-content');
  const globalTop = await globalList.evaluate(element => element.scrollTop);
  expect(globalTop).toBeGreaterThan(100);
  // A sync reload and a real task-change push both update data while the
  // reader stays at the same place in the account-wide list.
  await page.evaluate(async () => (window as any)._refreshGlobalTodos());
  expect(await globalList.evaluate(element => element.scrollTop)).toBeCloseTo(globalTop, 0);
  await orkas.invoke('projects.tasks.update', {
    projectId: pid, taskId: referenceTask.task.id, content: '同步后的对照待办\n' + detail,
  });
  await expect(globalList.locator('.todo-column.is-progress .project-todo-title')).toContainText('同步后的对照待办');
  expect(await globalList.evaluate(element => element.scrollTop)).toBeCloseTo(globalTop, 0);

  // The project board gives each column its own scroller instead.
  await page.locator('#todos-content .project-todo-item').first().locator('.todo-card-project').click();
  await expect(page.locator('#project-detail-title')).toHaveText('滚动验证');
  await page.locator('[data-project-tab="todo"]').click();
  const body = page.locator('#project-todo-list .todo-column.is-todo .todo-column-body');
  await expect(page.locator('#project-todo-list .todo-column.is-todo .project-todo-item')).toHaveCount(15);
  // Completed starts as a narrow strip and the board fits; with every lane
  // open the board also scrolls sideways.
  await page.locator('#project-todo-list .todo-column.is-done .todo-collapse').click();
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
  const projectTop = await body.evaluate(element => element.scrollTop);
  const board = page.locator('#project-todo-list .todo-board');
  await board.evaluate(element => { element.scrollLeft = 60; });
  const boardLeft = await board.evaluate(element => element.scrollLeft);
  expect(boardLeft).toBeGreaterThan(0);
  await orkas.invoke('projects.tasks.update', {
    projectId: pid, taskId: referenceTask.task.id, content: '再次更新的对照待办\n' + detail,
  });
  await expect(page.locator('#project-todo-list .todo-column.is-progress .project-todo-title')).toContainText('再次更新的对照待办');
  expect(await body.evaluate(element => element.scrollTop)).toBeCloseTo(projectTop, 0);
  expect(await board.evaluate(element => element.scrollLeft)).toBeCloseTo(boardLeft, 0);
  await page.evaluate(async id => (window as any)._loadProjectTodos(id), pid);
  expect(await body.evaluate(element => element.scrollTop)).toBeCloseTo(projectTop, 0);
  expect(await board.evaluate(element => element.scrollLeft)).toBeCloseTo(boardLeft, 0);
  await page.screenshot({ path: testInfo.outputPath('todo-column-scroll.png') });
});

for (const scope of ['global', 'project'] as const) {
  test(`preserves unchanged ${scope} todos through IPC and editor saves, then persists a real edit`, async ({ orkas }) => {
    let page = orkas.page!;
    await page.evaluate(() => (window as any).setLang('en'));
    const project = scope === 'project' ? await orkas.invoke<any>('projects.create', { name: 'Unchanged task' }) : null;
    const projectId = project?.project.project_id || '';
    const { task } = await orkas.invoke<any>('projects.tasks.create', { projectId, content: 'Preserve this requirement' });
    const taskId = task.id;
    const uid = JSON.parse(readFileSync(path.join(orkas.workspaceRoot, 'open-users.json'), 'utf8')).open_current_user_id;
    const file = path.join(orkas.workspaceRoot, uid, 'cloud', ...(projectId ? ['projects', projectId] : []), 'tasks', taskId + '.json');
    const bytes = readFileSync(file, 'utf8');
    const before = statSync(file);
    const repeated = await orkas.invoke<any>('projects.tasks.update', { projectId, taskId, status: 'todo' });
    expect(repeated).toMatchObject({ ok: true, task });
    await openSidebarEntry(page, '#todos-btn');
    if (projectId) await page.locator(`#todos-content .todo-scope-chip[data-pid="${projectId}"]`).click();
    const edit = async () => {
      const card = page.locator(`#todos-content .project-todo-item[data-tid="${taskId}"]`);
      await card.hover();
      await card.locator('[data-action="todo-menu"]').click();
      await page.locator('.context-menu-item').filter({ hasText: /^Edit$/ }).click();
      await expect(page.locator('#project-todo-input')).toHaveValue('Preserve this requirement');
    };
    await edit();
    await page.locator('#project-todo-save').click();
    await expect(page.locator('#todo-editor-modal')).not.toHaveClass(/open/);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(file).ino).toBe(before.ino);
    await edit();
    await page.locator('#project-todo-input').fill('Authorized revised requirement');
    await page.locator('#project-todo-save').click();
    await expect(page.locator('#todo-editor-modal')).not.toHaveClass(/open/);
    await expect(page.locator(`#todos-content .project-todo-item[data-tid="${taskId}"]`)).toContainText('Authorized revised requirement');
    page = await orkas.relaunch();
    const { tasks } = await orkas.invoke<any>('projects.tasks.list', { projectId });
    expect(tasks.find((item: any) => item.id === taskId)).toMatchObject({ content: 'Authorized revised requirement', status: 'todo' });
    await openSidebarEntry(page, '#todos-btn');
    if (projectId) await page.locator(`#todos-content .todo-scope-chip[data-pid="${projectId}"]`).click();
    await expect(page.locator(`#todos-content .project-todo-item[data-tid="${taskId}"]`)).toContainText('Authorized revised requirement');
  });
}
