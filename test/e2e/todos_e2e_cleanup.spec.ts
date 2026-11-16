import { openSidebarEntry, expect, test, type OrkasTestApp } from './fixtures/orkas';
import path from 'node:path';

// Seed through the real IPC contract, then age only the isolated fixture record.
async function oldCleanupTask(orkas: OrkasTestApp, content: string, projectId = '', status = 'done') {
  const { task } = await orkas.invoke<any>('projects.tasks.create', { projectId, content, status });
  await orkas.electronApp!.evaluate(async (_electron, input) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const fs = require('node:fs/promises'), paths = require(input.main + '/paths.ts');
    const uid = require(input.main + '/features/users.ts').getActiveUserId();
    const file = input.pid ? paths.projectTaskFile(uid, input.pid, input.id) : paths.userTaskFile(uid, input.id);
    const row = JSON.parse(await fs.readFile(file, 'utf8'));
    row.created_at = row.updated_at = '2020-01-01T00:00:00Z';
    if (row.status === 'done') row.done_at = row.updated_at;
    await fs.writeFile(file, JSON.stringify(row));
  }, { main: path.resolve(__dirname, '../../src/main'), pid: projectId, id: task.id });
  return task.id as string;
}

test('ignores an old preview response after canceling and reopening cleanup in a project', async ({ orkas }) => {
  const page = orkas.page!;
  const globalId = await oldCleanupTask(orkas, 'Keep work from the canceled account preview');
  const { project } = await orkas.invoke<any>('projects.create', { name: 'Current cleanup scope' });
  await oldCleanupTask(orkas, 'Remove only this project work', project.project_id);
  await openSidebarEntry(page, '#todos-btn');
  await expect(page.locator('#todos-content')).toContainText('Keep work from the canceled account preview');
  await orkas.electronApp!.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get('orkas.invoke'); let held = false;
    const gate = new Promise<void>(resolve => { (process as any).__cleanupRelease = resolve; });
    ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', async (event, request) => {
      const result = await original(event, request);
      if (!held && request.channel === 'projects.tasks.list' && !request.payload.projectId) {
        held = true; (process as any).__cleanupWaiting = true; await gate;
      }
      return result;
    });
  });
  await page.locator('#todos-cleanup-btn').click();
  await expect.poll(() => orkas.electronApp!.evaluate(() => !!(process as any).__cleanupWaiting)).toBe(true);
  await expect(page.locator('#cleanup-confirm')).toBeDisabled();
  await expect(page.locator('#match-count')).toHaveText('—');
  await page.locator('#cleanup-cancel').click();
  await page.evaluate(pid => (window as any).setView('project', pid), project.project_id);
  await page.locator('[data-project-tab="todo"]').click();
  await page.locator('#project-todo-cleanup-btn').click();
  await expect(page.locator('#match-count')).toHaveText('1');
  // Drain an IPC round trip after releasing the old response before checking
  // the new preview; checking before release would miss a stale-result race.
  await orkas.electronApp!.evaluate(() => (process as any).__cleanupRelease());
  await orkas.invoke('projects.list', {});
  await expect(page.locator('#cleanup-project button')).toBeDisabled();
  await expect(page.locator('#cleanup-list')).toContainText('Remove only this project work');
  await expect(page.locator('#cleanup-list')).not.toContainText('Keep work from the canceled account preview');
  await page.locator('#cleanup-confirm').click(); await page.getByRole('alertdialog').locator('[data-act="ok"]').click();
  await expect(page.locator('#match-count')).toHaveText('0');
  expect((await orkas.invoke<any>('projects.tasks.list', { projectId: project.project_id })).tasks).toEqual([]);
  expect((await orkas.invoke<any>('projects.tasks.list', {})).tasks.map((row: any) => row.id)).toEqual([globalId]);
});

test('keeps newly matching work outside a confirmed batch until a second review', async ({ orkas }) => {
  const page = orkas.page!;
  await oldCleanupTask(orkas, 'Originally reviewed work');
  await openSidebarEntry(page, '#todos-btn'); await page.locator('#todos-cleanup-btn').click();
  await expect(page.locator('#match-count')).toHaveText('1');
  await page.locator('#cleanup-confirm').click();
  const confirmation = page.getByRole('alertdialog'); await expect(confirmation).toBeVisible();
  const later = await oldCleanupTask(orkas, 'Arrived while confirmation was open');
  await expect(page.locator('#cleanup-project button')).toBeDisabled();
  
  await expect(page.locator('#cleanup-age button')).toBeDisabled();
  await expect(page.locator('#cleanup-status button')).toBeDisabled();
  await confirmation.locator('[data-act="ok"]').click();
  await expect(page.locator('#cleanup-feedback')).toBeVisible();
  await expect(page.locator('#cleanup-list')).toContainText('Arrived while confirmation was open');
  await expect(page.locator('#cleanup-list')).not.toContainText('Originally reviewed work');
  expect((await orkas.invoke<any>('projects.tasks.list', {})).tasks.map((row: any) => row.id)).toEqual([later]);
  await expect(page.locator('#cleanup-confirm')).toBeEnabled();
  await page.locator('#cleanup-confirm').click(); await confirmation.locator('[data-act="ok"]').click();
  await expect(page.locator('#match-count')).toHaveText('0');
  expect((await orkas.invoke<any>('projects.tasks.list', {})).tasks).toEqual([]);
});

test('cleans every selected status while keeping recent work and other project scopes', async ({ orkas }) => {
  const page = orkas.page!;
  const { project } = await orkas.invoke<any>('projects.create', { name: 'All stages cleanup' });
  const { project: other } = await orkas.invoke<any>('projects.create', { name: 'Keep this project' });
  const globalId = await oldCleanupTask(orkas, 'Keep global work');
  const otherId = await oldCleanupTask(orkas, 'Keep other project work', other.project_id);
  for (const status of ['todo', 'progress', 'review', 'done']) await oldCleanupTask(orkas, 'Old ' + status, project.project_id, status);
  const { task: recent } = await orkas.invoke<any>('projects.tasks.create', { projectId: project.project_id, content: 'Recent completed work', status: 'done' });
  await page.evaluate(pid => (window as any).setView('project', pid), project.project_id);
  await page.locator('[data-project-tab="todo"]').click(); await page.locator('#project-todo-cleanup-btn').click();
  await expect(page.locator('#match-count')).toHaveText('1');
  await expect(page.locator('#cleanup-project button')).toBeDisabled();
  
  await page.locator('#cleanup-status .ai-select-trigger').click();
  await page.locator('.ai-select-popover:not([hidden]) [role="option"][data-value="all"]').click();
  await expect(page.locator('#match-count')).toHaveText('4');
  await page.locator('#cleanup-confirm').click(); await page.getByRole('alertdialog').locator('[data-act="ok"]').click();
  await expect(page.locator('#match-count')).toHaveText('0');
  expect((await orkas.invoke<any>('projects.tasks.list', { projectId: project.project_id })).tasks.map((row: any) => row.id)).toEqual([recent.id]);
  expect((await orkas.invoke<any>('projects.tasks.list', { projectId: other.project_id })).tasks.map((row: any) => row.id)).toEqual([otherId]);
  expect((await orkas.invoke<any>('projects.tasks.list', {})).tasks.map((row: any) => row.id)).toEqual([globalId]);
});

for (const language of ['zh', 'en', 'ar']) test(`cleans only previewed to-dos across scopes (${language})`, async ({ orkas }, testInfo) => {
  test.setTimeout(120_000);
  const page = orkas.page!;
  await page.evaluate(lang => (window as any).setLang(lang), language);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await orkas.electronApp!.evaluate(async (_electron, main) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const fs = require('node:fs/promises'), path = require('node:path');
    const projects = require(path.join(main, 'features/projects.ts')), paths = require(path.join(main, 'paths.ts'));
    const uid = require(path.join(main, 'features/users.ts')).getActiveUserId();
    const { project } = await projects.createProject(uid, 'Personal work');
    const { project: parallel } = await projects.createProject(uid, 'Parallel release planning with a long project name');
    const parallelId = parallel.project_id;
    const old = new Date(Math.floor((Date.now() - 45 * 86400000) / 1000) * 1000).toISOString(), recent = new Date().toISOString();
    const id = (n: number) => 't_' + n.toString(16).padStart(12, '0');
    const seed = async (pid: string, n: number, content: string, status = 'done', updated = old, extra = {}) => {
      const file = pid ? paths.projectTaskFile(uid, pid, id(n)) : paths.userTaskFile(uid, id(n));
      const row = { id: id(n), content, status, created_by: 'user', created_at: old, updated_at: updated,
        ...(status === 'done' ? { done_at: updated } : {}), ...extra };
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(row)); return row;
    };
    for (let n = 0; n < 55; n++) await seed('', n, n === 0 ? 'Long reviewed work · 待办标题很长也不能挤出日期、状态与底部的操作按钮，需要覆盖全局与两个本地项目。' : 'Completed global work ' + n);
    await seed('', 55, 'Keep pending work', 'todo'); await seed('', 56, 'Keep recent completed work', 'done', recent);
    await seed('', 57, 'Keep in-progress work', 'progress'); await seed('', 58, 'Keep work awaiting review', 'review');
    await seed(project.project_id, 0, 'Completed private work'); await seed(project.project_id, 1, 'Keep private pending work', 'todo');
    // Independent project with overlapping local task IDs exercises composite identity.
    for (let n = 0; n < 3; n++) await seed(parallelId, n, 'Parallel project work ' + n);
    const attachment = paths.userTaskAttachmentsDir(uid, id(3));
    await fs.mkdir(attachment, { recursive: true }); await fs.writeFile(path.join(attachment, 'notes.txt'), 'Fixture notes');
    return { uid, private: project.project_id, parallelId, id0: id(0), id1: id(1), attachment };
  }, path.resolve(__dirname, '../../src/main'));
  await openSidebarEntry(page, '#todos-btn');
  await page.locator('#todos-cleanup-btn').click();
  const overlay = page.locator('#cleanup-overlay'), count = page.locator('#match-count');
  const pick = async (id: string, value: string) => {
    await page.locator(`#${id} .ai-select-trigger`).click();
    await page.locator(`.ai-select-popover:not([hidden]) [role="option"][data-value="${value}"]`).click();
  };
  await expect(count).toHaveText('59');
  await expect(page.locator('#scope-lock')).toBeHidden(); await expect(page.locator('#cleanup-project button')).toBeEnabled();
  // Cleanup keeps the same neutral/selected project colors as the to-do editor,
  // including the body-portaled menu and the collapsed selected label.
  for (const [pid, glyph] of [[fixture.private, 'folder'], [fixture.parallelId, 'folder']]) {
    await page.locator('#cleanup-project .ai-select-trigger').click();
    const menu = page.locator('#cleanup-project-listbox');
    const option = menu.locator(`[data-value="${pid}"]`);
    await expect(option.locator(`.is-${glyph}`)).toHaveCSS('color', 'rgb(126, 133, 151)');
    await option.click();
    await expect(page.locator(`#cleanup-project .ai-select-trigger .is-${glyph}`)).toHaveCSS('color', 'rgb(126, 133, 151)');
    await page.locator('#cleanup-project .ai-select-trigger').click();
    await expect(option.locator(`.is-${glyph}`)).toHaveCSS('color', 'rgb(73, 69, 192)');
    await expect(menu.locator('.ai-select-item:not(.active) .ai-select-svg-icon')).toHaveCSS('color', 'rgb(126, 133, 151)');
    await page.screenshot({ path: testInfo.outputPath(`cleanup-project-${glyph}-${language}.png`) });
    await page.keyboard.press('Escape');
  }
  await pick('cleanup-project', 'all'); await expect(count).toHaveText('59');
  await expect(page.locator('#cleanup-list [role="listitem"]')).toHaveCount(50);
  await page.locator('#cleanup-more').click(); await expect(page.locator('#cleanup-list [role="listitem"]')).toHaveCount(59);
  expect(await page.locator('#cleanup-list').evaluate(el => el.scrollHeight > el.clientHeight && el.clientHeight <= 320)).toBe(true);
  await page.locator('#cleanup-list').evaluate(el => { el.scrollTop = 0; });
  await overlay.screenshot({ path: testInfo.outputPath(`cleanup-populated-${language}.png`) });
  await pick('cleanup-age', '60'); await expect(count).toHaveText('0');
  await expect(page.locator('#cleanup-confirm')).toBeDisabled();
  await pick('cleanup-age', '30'); await expect(count).toHaveText('59');
  await pick('cleanup-project', fixture.private);  await expect(count).toHaveText('1');
  await pick('cleanup-status', 'all'); await expect(count).toHaveText('2');
  await pick('cleanup-project', fixture.parallelId); 
  await expect(count).toHaveText('3');
  await page.locator('#cleanup-age button').click(); await page.keyboard.press('Escape');
  await expect(overlay).toBeVisible(); await expect(page.locator('.ai-select-popover:not([hidden])')).toHaveCount(0);
  await pick('cleanup-status', 'progress'); await expect(count).toHaveText('0'); await expect(page.locator('#cleanup-confirm')).toBeDisabled();
  await overlay.screenshot({ path: testInfo.outputPath(`cleanup-empty-${language}.png`) });
  await page.locator('#cleanup-cancel').click(); await expect(page.locator('#todos-cleanup-btn')).toBeFocused();
  for (const pid of [fixture.private, fixture.parallelId]) {
    await page.evaluate(pid => (window as any).setView('project', pid), pid); await page.locator('[data-project-tab="todo"]').click();
    await page.locator('#project-todo-cleanup-btn').click(); await expect(page.locator('#cleanup-project button')).toBeDisabled();
    await expect(page.locator('#scope-lock')).toBeVisible();
    await overlay.screenshot({ path: testInfo.outputPath(`cleanup-${pid === fixture.private ? 'private' : 'parallel'}-${language}.png`) });
    await page.locator('#cleanup-cancel').click();
  }
  await openSidebarEntry(page, '#todos-btn'); await page.locator('#todos-cleanup-btn').click(); await expect(count).toHaveText('59');
  for (const [width, height] of [[1024, 720], [760, 600]] as const) {
    await page.setViewportSize({ width, height });
    const bounds = await page.locator('.todo-cleanup-dialog').boundingBox(), footer = await overlay.locator('.modal-actions').boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
    await overlay.screenshot({ path: testInfo.outputPath(`cleanup-${language}-${width}.png`) });
    await page.locator('#cleanup-project .ai-select-trigger').click();
    const anchor = await page.locator('#cleanup-project .ai-select-trigger').boundingBox();
    const menu = await page.locator('#cleanup-project-listbox').boundingBox();
    expect(anchor).not.toBeNull(); expect(menu).not.toBeNull();
    expect(Math.abs(menu!.x - anchor!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(menu!.width - anchor!.width)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`cleanup-project-menu-${language}-${width}.png`) });
    await page.keyboard.press('Escape');
  }
  const confirmation = page.getByRole('alertdialog');
  await page.locator('#cleanup-confirm').click(); await confirmation.locator('[data-act="cancel"]').click();
  expect((await orkas.invoke<any>('projects.tasks.list', {})).tasks).toHaveLength(59);
  await page.locator('#cleanup-confirm').click();
  // An edit after preview must survive. An unrelated simulated transport failure
  // must not prevent the remaining reviewed deletions from finishing.
  await orkas.invoke('projects.tasks.update', { taskId: fixture.id0, content: 'Retain the later edit' });
  await orkas.electronApp!.evaluate(({ ipcMain }, tid) => {
    const original = (ipcMain as any)._invokeHandlers.get('orkas.invoke'); let failed = false;
    ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', async (event, request) => {
      if (!failed && request.channel === 'projects.tasks.delete' && request.payload.expectedTask && !request.payload.projectId && request.payload.taskId === tid) {
        failed = true; return { ok: false, error: 'synthetic_cleanup_failure' };
      }
      return original(event, request);
    });
  }, fixture.id1);
  await confirmation.locator('[data-act="ok"]').click();
  await expect(page.locator('#cleanup-feedback')).toContainText(await page.evaluate(() =>
    (window as any).t('todo.cleanup.result', { deleted: 57, skipped: 1, failed: 1 })));
  await expect(count).toHaveText('1');
  const remaining = (await orkas.invoke<any>('projects.tasks.list', {})).tasks;
  expect(remaining.map((task: any) => task.content).sort()).toEqual(['Completed global work 1', 'Keep pending work', 'Keep recent completed work', 'Keep in-progress work', 'Keep work awaiting review', 'Retain the later edit'].sort());
  expect((await orkas.invoke<any>('projects.tasks.list', { projectId: fixture.private })).tasks.map((task: any) => task.content)).toEqual(['Keep private pending work']);
  expect((await orkas.invoke<any>('projects.tasks.list', { projectId: fixture.parallelId })).tasks).toEqual([]);
  expect(await orkas.electronApp!.evaluate((_electron, attachment) => (process as any).mainModule.require('node:fs').existsSync(attachment), fixture.attachment)).toBe(false);
  await page.locator('#cleanup-confirm').click(); await confirmation.locator('[data-act="ok"]').click();
  await expect(count).toHaveText('0'); await expect(page.locator('#cleanup-confirm')).toBeDisabled();
  await page.locator('#cleanup-cancel').click();
  expect((await orkas.invoke<any>('projects.tasks.list', {})).tasks).toHaveLength(5);
  await expect(page.locator('#todos-content')).toContainText('Retain the later edit');
});

test('keeps cleanup and retained work after restarting the desktop', async ({ orkas }) => {
  const page = orkas.page!;
  const { task } = await orkas.invoke<any>('projects.tasks.create', { content: 'Old completed work', status: 'done' });
  await orkas.invoke('projects.tasks.create', { content: 'Keep unfinished work' });
  await orkas.electronApp!.evaluate(async (_electron, input) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const paths = require(input.main + '/paths.ts'), fs = require('node:fs/promises');
    const uid = require(input.main + '/features/users.ts').getActiveUserId();
    const file = paths.userTaskFile(uid, input.id), row = JSON.parse(await fs.readFile(file, 'utf8'));
    row.updated_at = '2020-01-01T00:00:00Z'; await fs.writeFile(file, JSON.stringify(row));
  }, { main: path.resolve(__dirname, '../../src/main'), id: task.id });
  await openSidebarEntry(page, '#todos-btn'); await page.locator('#todos-cleanup-btn').click();
  await expect(page.locator('#match-count')).toHaveText('1');
  await page.locator('#cleanup-confirm').click(); await page.getByRole('alertdialog').locator('[data-act="ok"]').click();
  await expect(page.locator('#match-count')).toHaveText('0');
  const reopened = await orkas.relaunch();
  expect((await orkas.invoke<any>('projects.tasks.list', {})).tasks.map((row: any) => row.content)).toEqual(['Keep unfinished work']);
  await openSidebarEntry(reopened, '#todos-btn'); await expect(reopened.locator('#todos-content')).toContainText('Keep unfinished work');
});

test('stops after the in-flight deletion and preserves remaining reviewed work', async ({ orkas }) => {
  const page = orkas.page!;
  const ids = await orkas.electronApp!.evaluate(async ({ ipcMain }, main) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const fs = require('node:fs/promises'), paths = require(main + '/paths.ts');
    const uid = require(main + '/features/users.ts').getActiveUserId();
    const tasks = require(main + '/features/project_tasks.ts');
    const ids: string[] = [];
    for (const content of ['First reviewed deletion', 'Keep after stopping']) {
      const created = await tasks.createTask(uid, '', { content, status: 'done' });
      ids.push(created.task.id);
      const file = paths.userTaskFile(uid, created.task.id), row = JSON.parse(await fs.readFile(file, 'utf8'));
      row.updated_at = '2020-01-01T00:00:00Z'; await fs.writeFile(file, JSON.stringify(row));
    }
    const gate = new Promise<void>(resolve => { (process as any).__cleanupRelease = resolve; });
    const original = (ipcMain as any)._invokeHandlers.get('orkas.invoke');
    ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', async (event, request) => {
      if (request.channel === 'projects.tasks.delete' && request.payload.expectedTask) {
        (process as any).__cleanupWaiting = true;
        (process as any).__cleanupInFlight = request.payload.taskId; await gate;
      }
      return original(event, request);
    });
    return ids;
  }, path.resolve(__dirname, '../../src/main'));
  await openSidebarEntry(page, '#todos-btn'); await page.locator('#todos-cleanup-btn').click();
  await expect(page.locator('#match-count')).toHaveText('2');
  await page.locator('#cleanup-confirm').click(); await page.getByRole('alertdialog').locator('[data-act="ok"]').click();
  await expect.poll(() => orkas.electronApp!.evaluate(() => !!(process as any).__cleanupWaiting)).toBe(true);
  await expect(page.locator('#cleanup-project button')).toBeDisabled();
  await page.locator('#cleanup-cancel').click(); await expect(page.locator('#cleanup-cancel')).toBeDisabled();
  await orkas.electronApp!.evaluate(() => (process as any).__cleanupRelease());
  await expect(page.locator('#match-count')).toHaveText('1');
  await expect(page.locator('#cleanup-cancel')).toBeEnabled();
  const inFlight = await orkas.electronApp!.evaluate(() => (process as any).__cleanupInFlight as string);
  expect(ids).toContain(inFlight);
  expect((await orkas.invoke<any>('projects.tasks.list', {})).tasks.map((row: any) => row.id))
    .toEqual(ids.filter(id => id !== inFlight));
});

test('keeps a failed preview distinct from an empty result and recovers without deleting work', async ({ orkas }) => {
  const page = orkas.page!;
  await orkas.invoke('projects.tasks.create', { content: 'Keep the work while preview fails' });
  await openSidebarEntry(page, '#todos-btn');
  await expect(page.locator('#todos-content')).toContainText('Keep the work while preview fails');
  await orkas.electronApp!.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get('orkas.invoke'); let failed = false;
    ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', async (event, request) => {
      if (!failed && request.channel === 'projects.tasks.list') { failed = true; return { ok: false, error: 'synthetic_preview_failure' }; }
      return original(event, request);
    });
  });
  await page.locator('#todos-cleanup-btn').click();
  await expect(page.locator('#match-count')).toHaveText('—');
  await expect(page.locator('#cleanup-confirm')).toBeDisabled();
  await expect(page.locator('#cleanup-retry')).toBeVisible();
  expect((await orkas.invoke<any>('projects.tasks.list', {})).tasks).toHaveLength(1);
  await page.locator('#cleanup-retry').click();
  await expect(page.locator('#match-count')).toHaveText('0');
  await expect(page.locator('#cleanup-retry')).toHaveCount(0);
  expect((await orkas.invoke<any>('projects.tasks.list', {})).tasks).toHaveLength(1);
});
