import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { openSidebarEntry, expect, test as base, OrkasTestApp } from './fixtures/orkas';
import { analyzeWebAppLogs } from './fixtures/web-app-log-analysis';

const test = base.extend({
  orkas: async ({}, use, info) => {
    const previous = process.env.ORKAS_E2E_KEEP_LOGS;
    process.env.ORKAS_E2E_KEEP_LOGS = '1';
    const app = new OrkasTestApp(info);
    try {
      await app.launch();
      await use(app);
    } finally {
      try { await app.dispose(); }
      finally {
        if (previous === undefined) delete process.env.ORKAS_E2E_KEEP_LOGS;
        else process.env.ORKAS_E2E_KEEP_LOGS = previous;
        const retainedLog = info.outputPath('electron-main.log');
        // Checkpoint failures retain an immutable, uniquely named snapshot.
        const log = existsSync(retainedLog) ? retainedLog : info.attachments
          .find(attachment => attachment.name === 'electron-logs' && attachment.path && existsSync(attachment.path))?.path;
        expect(!!log, 'Retain complete Electron logs on passing runs too').toBe(true);
        const analysis = analyzeWebAppLogs(readFileSync(log!, 'utf8'));
        writeFileSync(info.outputPath('log-analysis.json'), JSON.stringify(analysis, null, 2));
        expect(analysis.passed, 'Review log-analysis.json for errors or incomplete coverage').toBe(true);
        if (analysis.requiresReview) console.warn('Due date E2E log warnings:', JSON.stringify(analysis.findings));
      }
    }
  },
});

for (const scope of ['global', 'project'] as const) {
  test(`enters, picks, reopens and clears a due day from a fresh ${scope} entry`, async ({ orkas }, info) => {
    const page = orkas.page!;
    await page.evaluate(() => (window as any).setLang('zh'));
    const project = scope === 'project' ? await orkas.invoke<any>('projects.create', { name: '日期验证项目' }) : null;
    const pid = project?.project.project_id || '';
    const open = async () => {
      if (pid) {
        await page.evaluate(async id => (window as any).setView('project', id), pid);
        await page.locator('[data-project-tab="todo"]').click();
        await page.locator('#project-todo-add-btn').click();
      } else {
        await openSidebarEntry(page, '#todos-btn');
        await page.locator('#todos-add-btn').click();
      }
    };
    await open();
    const modal = page.locator('#todo-editor-modal');
    const input = page.locator('#project-todo-due');
    const toggle = page.locator('#project-todo-due-picker .auto-date-picker-toggle');
    const calendar = page.locator('#project-todo-due-popover');
    await modal.screenshot({ path: info.outputPath('due-empty-zh.png') });
    // Direct entry must work before Automation has ever been opened.
    await expect(toggle.locator('svg')).toBeVisible();
    const geometry = await input.evaluate(element => {
      const box = element.getBoundingClientRect();
      const parent = element.parentElement!.getBoundingClientRect();
      return { width: box.width, height: box.height, available: parent.width, radius: parseFloat(getComputedStyle(element).borderRadius) };
    });
    expect(geometry.height).toBeGreaterThanOrEqual(32);
    expect(geometry.radius).toBeGreaterThan(0);
    expect(geometry.width).toBeLessThanOrEqual(geometry.available + 1);
    expect(await input.evaluate(element => Math.abs(element.getBoundingClientRect().width
      - document.getElementById('project-todo-due-field')!.getBoundingClientRect().width))).toBeLessThanOrEqual(1);

    await page.locator('#project-todo-input').fill('准备发布材料，确认文档与附件均已更新。'.repeat(12));
    await input.fill('2099-02-28');
    await toggle.click();
    await expect(calendar).toBeVisible();
    await expect(calendar.locator('[data-date="2099-02-28"]')).toHaveAttribute('aria-selected', 'true');
    await calendar.locator('[data-date="2099-03-01"]').click();
    await expect(input).toHaveValue('2099-03-01');
    await expect(calendar).toBeHidden();
    await expect(input).toBeFocused();
    await input.press('Alt+ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('2099-03-02');
    await input.press('Alt+ArrowDown');
    await page.keyboard.press('Escape');
    await expect(calendar).toBeHidden();
    await expect(modal).toHaveClass(/\bopen\b/);
    await modal.screenshot({ path: info.outputPath('due-filled-zh.png') });
    await toggle.click();
    await page.screenshot({ path: info.outputPath('due-calendar-zh.png') });
    await page.keyboard.press('Escape');
    await page.locator('#project-todo-save').click();
    await expect(modal).not.toHaveClass(/\bopen\b/);
    let tasks = await orkas.invoke<any>('projects.tasks.list', { projectId: pid });
    const saved = tasks.tasks.find((task: any) => task.due_at === '2099-03-02');
    expect(saved).toBeTruthy();
    const edit = async (task: any) => {
      const card = page.locator(`${pid ? '#project-todo-list' : '#todos-content'} .project-todo-item[data-tid="${task.id}"]`);
      await card.hover();
      await card.locator('[data-action="todo-menu"]').click();
      await page.locator('.context-menu-item', { hasText: '编辑' }).click();
    };
    await edit(saved);
    await expect(input).toHaveValue('2099-03-02');
    // Invalid calendar days keep the draft and can be corrected before saving.
    await input.fill('2099-02-30');
    await page.locator('#project-todo-save').click();
    await expect(modal).toHaveClass(/\bopen\b/);
    await expect(page.locator('.ui-dialog-overlay.open').last()).toContainText('YYYY-MM-DD');
    await page.locator('.ui-dialog-overlay.open').last().locator('button').last().click();
    await input.fill('2099-12-31');
    await page.locator('#project-todo-save').click();
    await expect(modal).not.toHaveClass(/\bopen\b/);
    tasks = await orkas.invoke<any>('projects.tasks.list', { projectId: pid });
    expect(tasks.tasks.find((task: any) => task.id === saved.id).due_at).toBe('2099-12-31');
    await edit({ id: saved.id });
    await expect(input).toHaveValue('2099-12-31');

    // The supported small window and a live language change retain the draft.
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.evaluate(() => (window as any).setLang('en'));
    await expect(input).toHaveAccessibleName('Due date');
    await expect(page.locator('#project-todo-status .ai-select-trigger')).toHaveText('Pending');
    await expect(page.locator('#project-todo-status .ai-select-trigger')).toHaveAccessibleName('Status');
    await expect(page.locator('#project-todo-project .ai-select-trigger')).toHaveText(pid ? '日期验证项目' : 'Global');
    await expect(page.locator('#project-todo-project .ai-select-trigger')).toHaveAccessibleName('Project');
    await expect(input).toHaveValue('2099-12-31');
    await input.press('Alt+ArrowDown');
    await expect(calendar).toBeVisible();
    await expect(calendar).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('due-calendar-en-1024.png') });
    await page.keyboard.press('Escape');
    // Edge-aligned native scrolling can leave fractional clipping in the dialog.
    // Center the action before requiring complete visibility; keep the strict oracle.
    await page.locator('#project-todo-save').evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await info.attach('save-button-geometry', {
      contentType: 'application/json',
      body: JSON.stringify(await page.locator('#project-todo-save').evaluate(element => {
        const ancestors = [];
        for (let node: HTMLElement | null = element as HTMLElement; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          ancestors.push({ id: node.id, className: node.className, rect: node.getBoundingClientRect().toJSON(),
            scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
            overflowY: style.overflowY, paddingBottom: style.paddingBottom, flexShrink: style.flexShrink });
        }
        return { viewport: { width: innerWidth, height: innerHeight }, ancestors };
      })),
    });
    await expect(page.locator('#project-todo-save')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('due-form-en-1024.png') });
    await input.fill('');
    await page.locator('#project-todo-save').click();
    await expect(modal).not.toHaveClass(/\bopen\b/);
    tasks = await orkas.invoke<any>('projects.tasks.list', { projectId: pid });
    expect(tasks.tasks.find((task: any) => task.id === saved.id)).not.toHaveProperty('due_at');
    await open();
    await input.press('Alt+ArrowDown');
    await page.locator('#project-todo-cancel').click();
    await expect(calendar).toBeHidden();
    await open();
    await expect(input).toHaveValue('');
    await page.locator('#project-todo-cancel').click();
    expect((await orkas.invoke<any>('projects.tasks.list', { projectId: pid })).tasks).toHaveLength(1);
    // Loading Automation afterwards must reuse the calendar without redeclaring it.
    await openSidebarEntry(page, '#auto-btn');
    await page.locator('#auto-add-btn').click();
    await page.locator('#auto-freq-select .ai-select-trigger').click();
    await page.locator('body > .ai-select-popover .ai-select-item[data-value="one_time"]').click();
    await page.locator('#auto-date-input').fill('2099-08-29');
    await page.locator('#auto-date-picker .auto-date-picker-toggle').click();
    const autoCalendar = page.locator('#auto-date-picker-popover');
    await expect(autoCalendar).toBeVisible();
    await autoCalendar.locator('[data-date="2099-08-30"]').click();
    await expect(page.locator('#auto-date-input')).toHaveValue('2099-08-30');
    await page.screenshot({ path: info.outputPath('automation-shared-calendar.png') });
  });
}
