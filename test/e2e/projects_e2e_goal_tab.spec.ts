import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type OrkasTestApp } from './fixtures/orkas';

// The project goal and what changed since the last visit, in the real renderer
// (Common/docs/plans/commander-project-continuity.md §3.6): the Goal tab of
// Goal · Rules · Memory with its editor's optional criteria, and the What's new
// workspace tab left of Tasks, recorded as seen once shown.
/** The isolated local identity seeded by the public native fixture. */
const UID = 'account-e2e';

/** Optional screenshots for visual acceptance; nothing is written without it. */
const SHOTS = process.env.ORKAS_GOAL_TAB_SHOTS || '';

async function shot(orkas: OrkasTestApp, name: string, selector = '.project-side-context'): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await orkas.page!.locator(selector).screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

type Work = [content: string, status: string, note?: string, kind?: string];

const NEWS: Work[] = [
  ['Q4 新品清单', 'review', '清单在资料库 q4-list.xlsx，共 38 款，其中 6 款缺主图', 'result'],
  ['店铺后台数据导出', 'progress', '需要店铺后台的登录授权', 'blocker'],
  ['竞品价格对比', 'done', '对比表在资料库 price.xlsx', 'result'],
];

/** Work done in another of the project's conversations, as an Agent leaves it,
 *  before the user comes back: a digest covers the whole seconds before it. */
async function seedNews(orkas: OrkasTestApp, projectId: string, elsewhere: string, items: Work[] = NEWS): Promise<void> {
  await orkas.electronApp!.evaluate(async (_electron, { uid, pid, cid, items }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const tasks = req('./src/main/features/project_tasks.ts');
    for (const [content, status, note, kind] of items) {
      const created = await tasks.createTask(uid, pid, { content, created_by: 'agent' });
      if (!created.ok) throw new Error(created.error);
      await tasks.recordTaskExecution(uid, pid, created.task.id, cid);
      const moved = await tasks.updateTask(uid, pid, created.task.id, { status, ...(note ? { note, note_kind: kind } : {}) });
      if (!moved.ok) throw new Error(moved.error);
    }
  }, { uid: UID, pid: projectId, cid: elsewhere, items });
  await new Promise((resolve) => setTimeout(resolve, 1020 - (Date.now() % 1000)));
}

async function openProject(orkas: OrkasTestApp, projectId: string): Promise<void> {
  const page = orkas.page!;
  // Projects made over IPC reach the sidebar on its next list load.
  await page.evaluate(async () => { await (window as any).loadProjects(true); });
  await page.locator(`#projects-list .project-row[data-pid="${projectId}"]`).click();
  await expect(page.locator('#project-detail-title')).toBeVisible();
}

/** When the project page last showed the changes; Commander keeps its own time. */
function seenRecord(orkas: OrkasTestApp, projectId: string): string | null {
  const file = path.join(orkas.workspaceRoot, UID, 'local', 'projects', projectId, 'recap-state.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).page_seen_at ?? null : null;
}

test('keeps project news and the saved goal hidden by default, with Rules still available', async ({ orkas }) => {
  const { project } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Launch updates' });
  const pid = project.project_id;
  const savedGoal = 'Ship the launch checklist';
  await orkas.electronApp!.evaluate(async (_electron, { uid, pid, goal }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const goals = req('./src/main/features/project_goal.ts');
    const saved = await goals.saveProjectGoal(uid, pid, { goal }, 'commander');
    if (!saved.ok) throw new Error(saved.error);
  }, { uid: UID, pid, goal: savedGoal });
  const { conversation } = await orkas.invoke<{ conversation: { conversation_id: string } }>(
    'conversations.create', { title: 'Launch checklist', projectId: pid });
  await seedNews(orkas, pid, conversation.conversation_id, [NEWS[0]]);
  expect(await orkas.invoke('projects.recap.get', { projectId: pid })).toEqual({ ok: true, enabled: false });
  await openProject(orkas, pid);

  const page = orkas.page!;
  await expect(page.locator('#project-recap-tab')).toBeHidden();
  await expect(page.locator('[data-project-panel="recap"]')).toBeHidden();
  await expect(page.locator('[data-project-panel="tasks"]')).toBeVisible();
  expect(await orkas.invoke('projects.goal.get', { projectId: pid })).toEqual({ ok: true, enabled: false });
  await expect(page.locator('#project-goal-tab')).toBeHidden();
  await expect(page.locator('[data-project-side-panel="goal"]')).toBeHidden();
  await expect(page.locator('[data-project-side-panel="instructions"]')).toBeVisible();
  await page.locator('[data-project-side-tab="memory"]').click();
  await expect(page.locator('[data-project-side-panel="memory"]')).toBeVisible();
  await page.locator('[data-project-side-tab="instructions"]').click();
  await shot(orkas, 'project-goal-disabled');
  expect(await orkas.invoke('projects.goal.set', { projectId: pid, goal: 'Unexpected replacement' }))
    .toEqual({ ok: true, enabled: false });
  const stored = await orkas.electronApp!.evaluate(async (_electron, { uid, pid }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return (await req('./src/main/features/project_goal.ts').readProjectGoal(uid, pid))?.goal;
  }, { uid: UID, pid });
  expect(stored).toBe(savedGoal);
  await shot(orkas, 'project-news-disabled', '.project-detail-main');
  await page.locator('[data-project-tab="todo"]').click();
  await expect(page.locator('[data-project-panel="todo"]')).toContainText(NEWS[0][0]);
  expect(await orkas.invoke('projects.recap.markSeen', { projectId: pid,
    computedAt: new Date().toISOString(), counts: { review: 1 } })).toMatchObject({ seen: false });
  expect(seenRecord(orkas, pid)).toBeNull();
});

test.describe('project goal tab', () => {
  test.use({ projectRecapTabEnabled: true });

  test('does not create a seen file for an unknown project through IPC', async ({ orkas }) => {
    const pid = 'p_missing';
    expect(await orkas.invoke('projects.recap.markSeen', { projectId: pid,
      computedAt: new Date().toISOString(), counts: { stuck: 1 } })).toMatchObject({ seen: false });
    expect(seenRecord(orkas, pid)).toBeNull();
  });

  test('never saves an open goal editor into a different project after navigation', async ({ orkas }) => {
    const { project: first } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'First goal owner' });
    const { project: second } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Second goal owner' });
    await orkas.invoke('projects.goal.set', { projectId: first.project_id, goal: 'First original' });
    await orkas.invoke('projects.goal.set', { projectId: second.project_id, goal: 'Second original' });
    await openProject(orkas, first.project_id);
    const page = orkas.page!;
    await page.locator('#project-goal-edit-btn').click();
    await page.locator('#project-goal-input').fill('First project draft');
    // An external navigation can arrive while a form is open. The form still
    // belongs to the project from which it was opened.
    await page.evaluate((pid) => (window as any).setView('project', pid), second.project_id);
    await expect(page.locator('#project-detail-title')).toHaveText('Second goal owner');
    await expect(page.locator('#project-goal-text')).toHaveText('Second original');
    await page.locator('#project-goal-save-btn').click();
    await page.waitForFunction(() => !document.getElementById('project-goal-modal')?.classList.contains('open')
      || !!document.querySelector('.ui-dialog-overlay.open:not(#project-goal-modal)'));
    const read = (pid: string) => orkas.invoke<{ goal: { goal: string } }>('projects.goal.get', { projectId: pid });
    expect((await read(second.project_id)).goal.goal).toBe('Second original');
    expect((await read(first.project_id)).goal.goal).toBe('First original');
  });

  test("opens on What's new left of Tasks, records it seen, and edits the goal with optional criteria", async ({ orkas }) => {
    const page = orkas.page!;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async () => { await (window as any).setLang('zh'); });
    const { project } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Q4 店铺上新' });
    const pid = project.project_id;
    const elsewhere = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: '清单', projectId: pid })
      .then((result) => result.conversation.conversation_id);
    await orkas.invoke('projects.goal.set', {
      projectId: pid, goal: '三个月内把店铺月销做到 10 万', success_criteria: ['月销连续两个月不低于 10 万', '退货率不高于 5%'],
    });
    // Nothing new yet: no What's new tab; the user leaves the project on To-do.
    const whatsNew = page.locator('#project-recap-tab');
    await openProject(orkas, pid);
    await expect(whatsNew).toBeHidden();
    await page.locator('[data-project-tab="todo"]').click();
    await page.evaluate(() => (window as any).setView('new-chat'));
    await seedNews(orkas, pid, elsewhere);

    await openProject(orkas, pid);
    // What's new is the first workspace tab, selected, with the change count.
    await expect(page.locator('.project-detail-tab-group', { has: whatsNew }).locator('.project-detail-tab:not([hidden])'))
      .toHaveText([/新动态\s*3/, /任务/, /自动化/, /待办/]);
    await expect(whatsNew).toHaveClass(/is-active/);
    const panel = page.locator('[data-project-panel="recap"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.home-row-title')).toHaveText(['店铺后台数据导出', 'Q4 新品清单', '竞品价格对比']);
    await expect(panel.locator('.home-row-source')).toHaveText(['卡住了', '做完，等你确认', '已完成']);
    // Shown in front of the user, it is recorded as seen.
    await expect.poll(() => seenRecord(orkas, pid)).not.toBeNull();
    await shot(orkas, 'whats-new-zh', '.project-detail-main');

    // The Goal tab holds the goal only.
    const tab = page.locator('[data-project-side-tab="goal"]');
    await expect(tab).toHaveClass(/is-active/);
    const goalPanel = page.locator('[data-project-side-panel="goal"]');
    await expect(goalPanel.locator('#project-goal-status')).toHaveText('进行中');
    await expect(goalPanel.locator('#project-goal-text')).toHaveText('三个月内把店铺月销做到 10 万');
    await expect(goalPanel.locator('#project-goal-criteria li')).toHaveText(['月销连续两个月不低于 10 万', '退货率不高于 5%']);
    await expect(page.locator('[data-project-side-tab="instructions"]')).toHaveText(/规则/);
    await shot(orkas, 'goal-tab-zh');

    // Opening a row opens that to-do.
    await panel.locator('.project-recap-row').nth(1).click();
    await expect(page.locator('#todo-editor-modal')).toHaveClass(/open/);
    await expect(page.locator('#project-todo-input')).toHaveValue('Q4 新品清单');
    await page.locator('#project-todo-cancel').click();
    await expect(page.locator('#todo-editor-modal')).not.toHaveClass(/open/);

    // The editor: blank criteria rows are left out, and the goal saves.
    await goalPanel.locator('#project-goal-edit-btn').click();
    const dialog = page.locator('#project-goal-modal');
    await expect(dialog).toHaveClass(/open/);
    await expect(dialog.locator('#project-goal-save-btn')).toBeDisabled();
    await dialog.locator('#project-goal-criteria-add').click();
    await expect(dialog.locator('.project-goal-criterion-input')).toHaveCount(3);
    await expect(dialog.locator('#project-goal-save-btn')).toBeDisabled();
    await dialog.locator('.project-goal-criterion-input').nth(2).fill('好评率不低于 98%');
    await expect(dialog.locator('#project-goal-save-btn')).toBeEnabled();
    await shot(orkas, 'goal-editor-zh', '#project-goal-modal .modal');
    await dialog.locator('#project-goal-save-btn').click();
    await expect(dialog).not.toHaveClass(/open/);
    await expect(goalPanel.locator('#project-goal-criteria li')).toHaveCount(3);
    expect((await orkas.invoke<{ goal: { success_criteria: string[] } }>('projects.goal.get', { projectId: pid })).goal.success_criteria)
      .toEqual(['月销连续两个月不低于 10 万', '退货率不高于 5%', '好评率不低于 98%']);

    // Marking it achieved, then clearing it through the menu.
    await goalPanel.locator('#project-goal-menu-btn').click();
    await page.locator('.context-menu-item', { hasText: '标记为已达成' }).click();
    await expect(goalPanel.locator('#project-goal-status')).toHaveText('已达成');
    await shot(orkas, 'goal-achieved-zh');
    await goalPanel.locator('#project-goal-menu-btn').click();
    await page.locator('.context-menu-item', { hasText: '清除目标' }).click();
    await page.locator('.ui-dialog-overlay.open .btn-primary, .ui-dialog-overlay.open .btn-danger').last().click();
    await expect(goalPanel.locator('#project-goal-setup-btn')).toBeVisible();
    expect((await orkas.invoke<{ goal: unknown }>('projects.goal.get', { projectId: pid })).goal).toBeNull();
    await shot(orkas, 'goal-empty-zh');

    // Coming back with nothing new: no What's new tab, and To-do, which it
    // took over, comes back.
    await page.evaluate(() => (window as any).setView('new-chat'));
    await openProject(orkas, pid);
    await expect(whatsNew).toBeHidden();
    await expect(page.locator('[data-project-tab="todo"]')).toHaveClass(/is-active/);

    // A to-do's project link on the To-dos page opens the project on To-do
    // even with news; the news waits, unseen, until What's new is opened.
    await seedNews(orkas, pid, elsewhere, [['整理库存', 'review', '库存表在资料库 stock.xlsx', 'result']]);
    const seenBefore = seenRecord(orkas, pid);
    await page.evaluate(() => (window as any).setView('todos'));
    // Cards name their project when grouped by status.
    await page.locator('#panel-todos [data-todo-group="status"]').click();
    await page.locator(`#panel-todos .project-todo-item[data-pid="${pid}"] [data-action="todo-project"]`).first().click();
    await expect(page.locator('#project-detail-title')).toBeVisible();
    await expect(whatsNew).toBeVisible();
    await expect(whatsNew).toHaveText(/新动态\s*1/);
    await expect(page.locator('[data-project-tab="todo"]')).toHaveClass(/is-active/);
    expect(seenRecord(orkas, pid)).toBe(seenBefore);
    await whatsNew.click();
    await expect(page.locator('[data-project-panel="recap"] .home-row-title')).toHaveText(['整理库存']);
    await expect.poll(() => seenRecord(orkas, pid)).not.toBe(seenBefore);
  });

  test('opens a project without a goal or news on its rules, and fits long text in a narrow English window', async ({ orkas }) => {
    const page = orkas.page!;
    await page.evaluate(async () => { await (window as any).setLang('en'); });
    const { project: plain } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Client files' });
    await openProject(orkas, plain.project_id);
    await expect(page.locator('[data-project-side-tab="instructions"]')).toHaveClass(/is-active/);
    await expect(page.locator('#project-recap-tab')).toBeHidden();
    await expect(page.locator('[data-project-side-tab="goal"]')).toBeVisible();
    await page.locator('[data-project-side-tab="goal"]').click();
    await expect(page.locator('#project-goal-setup-btn')).toBeVisible();
    await shot(orkas, 'goal-empty-en');

    await page.setViewportSize({ width: 1024, height: 700 });
    const { project } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Launch' });
    const pid = project.project_id;
    const elsewhere = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'List', projectId: pid })
      .then((result) => result.conversation.conversation_id);
    await orkas.invoke('projects.goal.set', {
      projectId: pid,
      goal: 'Prepare every Q4 product for launch: final images, product copy, prices and stock levels checked against the warehouse export, so the store can list all of them in the first week of December without manual fixes.',
      success_criteria: ['All 38 Q4 products are listed with final images and copy', 'Returns stay under 5% for the first month after launch'],
    });
    await seedNews(orkas, pid, elsewhere);
    await openProject(orkas, pid);
    await expect(page.locator('[data-project-side-tab="goal"]')).toHaveClass(/is-active/);
    await expect(page.locator('#project-goal-status')).toHaveText('In progress');
    await expect(page.locator('#project-recap-tab')).toHaveClass(/is-active/);
    await expect(page.locator('#project-recap-tab')).toHaveText(/What's new\s*3/);
    // The tab row keeps one line, and long titles and notes stay on one line
    // each instead of widening the column.
    const main = await page.locator('.project-detail-main').boundingBox();
    const firstTab = await page.locator('#project-recap-tab').boundingBox();
    const lastTab = await page.locator('[data-project-tab="todo"]').boundingBox();
    expect(Math.abs(firstTab!.y - lastTab!.y)).toBeLessThan(4);
    expect(lastTab!.x + lastTab!.width).toBeLessThanOrEqual(main!.x + main!.width + 1);
    const row = await page.locator('.project-recap-row').first().boundingBox();
    expect(row!.width).toBeLessThanOrEqual(main!.width);
    const overflow = await page.locator('.project-detail-main').evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflow).toBe(false);
    await shot(orkas, 'whats-new-en-narrow', '.project-detail-main');
    await shot(orkas, 'goal-tab-en-narrow');

    // To-do's tools do not fit beside four tabs here: they take their own line
    // under the tab line, and no tab label wraps.
    const strip = page.locator('.project-detail-tab-group', { has: page.locator('#project-recap-tab') });
    await page.locator('[data-project-tab="todo"]').click();
    const stripBox = await strip.boundingBox();
    const tools = await page.locator('[data-project-tools="todo"]').boundingBox();
    expect(tools!.y).toBeGreaterThanOrEqual(stripBox!.y + stripBox!.height - 1);
    const labelHeights = await strip.locator('.project-detail-tab:not([hidden]) > span:first-child')
      .evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().height));
    for (const height of labelHeights) expect(height).toBeLessThan(24);
    await shot(orkas, 'todo-tools-en-narrow', '.project-detail-main');

    // Narrower still, the strip scrolls sideways and keeps the selected tab in view.
    await page.setViewportSize({ width: 990, height: 700 });
    await page.locator('[data-project-tab="tasks"]').evaluate((tab) => (tab as HTMLElement).click());
    await page.locator('[data-project-tab="todo"]').evaluate((tab) => (tab as HTMLElement).click());
    const { measurements, ...inStrip } = await page.locator('[data-project-tab="todo"]').evaluate((tab) => {
      const box = tab.getBoundingClientRect();
      const stripRect = tab.parentElement!.getBoundingClientRect();
      const strip = tab.parentElement!;
      const measurements = { tabLeft: box.left, tabRight: box.right, stripLeft: stripRect.left, stripRight: stripRect.right, scrollLeft: strip.scrollLeft, scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth, dpr: devicePixelRatio };
      return { measurements, scrolls: strip.scrollWidth > strip.clientWidth, inside: box.left >= stripRect.left - 0.5 && box.right <= stripRect.right + 0.5 };
    });
    await test.info().attach('goal-strip-measurements', { body: JSON.stringify(measurements), contentType: 'application/json' });
    expect(inStrip).toEqual({ scrolls: true, inside: true });
    await page.locator('[data-project-tab="todo"]').press('ArrowRight');
    await expect(page.locator('#project-recap-tab')).toHaveClass(/is-active/);
    await page.locator('#project-recap-tab').press('ArrowLeft');
    await expect(page.locator('[data-project-tab="todo"]')).toBeFocused();
    await shot(orkas, 'todo-strip-en-990-keyboard', '.project-detail-main');
  });

  // The changed tab strip and editor depend on text width and direction. Keep the
  // existing Chinese/English journeys, and cover the actual RTL renderer too.
  test('keeps long Arabic goal text and editor actions inside a narrow RTL window', async ({ orkas }) => {
    const page = orkas.page!;
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.evaluate(async () => { await (window as any).setLang('ar'); });
    const { project } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'إطلاق منتجات الربع الرابع' });
    const goal = 'تجهيز جميع منتجات الربع الرابع للإطلاق مع الصور النهائية والنصوص والأسعار والمخزون، ومراجعتها قبل بداية ديسمبر.';
    expect(await orkas.invoke('projects.goal.set', { projectId: project.project_id, goal, success_criteria: ['نشر جميع المنتجات مع الصور النهائية', 'مراجعة الأسعار والمخزون مع المستودع'] })).toMatchObject({ ok: true, goal: { goal } });
    await openProject(orkas, project.project_id);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const panel = page.locator('[data-project-side-panel="goal"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('#project-goal-text')).toHaveText(goal);
    await expect(panel.locator('#project-goal-criteria li')).toHaveCount(2);
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await shot(orkas, 'goal-tab-ar-narrow');
    await panel.locator('#project-goal-edit-btn').click();
    const dialog = page.locator('#project-goal-modal');
    await expect(dialog).toHaveClass(/open/);
    await expect(dialog.locator('#project-goal-input')).toHaveValue(goal);
    for (const id of ['project-goal-cancel-btn', 'project-goal-save-btn']) {
      const box = await dialog.locator(`#${id}`).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(1024);
      expect(box!.y + box!.height).toBeLessThanOrEqual(700);
    }
    await shot(orkas, 'goal-editor-ar-narrow', '#project-goal-modal .modal');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toHaveClass(/open/);
    await expect(panel.locator('#project-goal-edit-btn')).toBeFocused();
    expect((await orkas.invoke<{ goal: { goal: string } }>('projects.goal.get', { projectId: project.project_id })).goal.goal).toBe(goal);
  });
});
