import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, OrkasTestApp, test } from './fixtures/orkas';

test.describe('desktop shell', () => {
  test('restores moved and resized window bounds across a real relaunch', async ({}, testInfo) => {
    const app = new OrkasTestApp(testInfo, { setDefaultViewport: false });
    try {
      await app.launch();
      if (!app.electronApp) throw new Error('Orkas main process is unavailable');
      const savedBounds = await app.electronApp.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
        if (!win) throw new Error('Orkas BrowserWindow is unavailable');
        const area = screen.getPrimaryDisplay().workArea;
        const width = Math.max(640, Math.min(960, area.width));
        const height = Math.max(480, Math.min(680, area.height));
        const bounds = {
          x: area.x + Math.max(0, Math.floor((area.width - width) / 3)),
          y: area.y + Math.max(0, Math.floor((area.height - height) / 3)),
          width,
          height,
        };
        win.setBounds(bounds);
        return win.getBounds();
      });
      const statePath = path.join(app.workspaceRoot, 'window-state.json');
      await expect.poll(() => {
        try {
          return JSON.parse(readFileSync(statePath, 'utf8'));
        } catch {
          return null;
        }
      }).toMatchObject({ ...savedBounds, isMaximized: false });

      await app.relaunch();
      if (!app.electronApp) throw new Error('Orkas main process is unavailable after relaunch');
      const restoredBounds = await app.electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
        if (!win) throw new Error('Restored Orkas BrowserWindow is unavailable');
        return win.getBounds();
      });

      expect(restoredBounds).toEqual(savedBounds);
    } finally {
      await app.dispose();
    }
  });

  test('launches the hidden real renderer and preload bridge', async ({ appPage, orkas }) => {
    await expect(appPage).toHaveURL(/src\/renderer\/index\.html$/);
    await expect(appPage.locator('#panel-new-chat')).toHaveClass(/\bactive\b/);
    await expect(appPage.locator('#new-chat-input')).toBeVisible();

    const result = await appPage.evaluate(async () => {
      return (window as any).orkas.ping();
    });
    expect(result).toMatchObject({ ok: true, pong: 'pong' });
    expect(result.ts).toEqual(expect.any(String));
    expect(orkas.lastLaunchReadyMs).not.toBeNull();
    expect(orkas.lastLaunchReadyMs as number).toBeLessThanOrEqual(30_000);
    const [agents, skills] = await Promise.all([
      orkas.invoke<{ agents: Array<{ agent_id: string }> }>('agents.list'),
      orkas.invoke<{ skills: Array<{ id: string }> }>('skills.list'),
    ]);
    expect(agents.agents.map((agent) => agent.agent_id)).toContain('79df9cc89f5f');
    expect(skills.skills.map((skill) => skill.id)).toContain('ee99fbb42964');
    // The open build intentionally has no account surface. Resolve the active local
    // user from the workspace registry while still proving that first-window
    // publication completed before the renderer became ready.
    const usersRegistry = JSON.parse(readFileSync(
      path.join(orkas.workspaceRoot, 'open-users.json'),
      'utf8',
    )) as { open_current_user_id?: string };
    expect(usersRegistry.open_current_user_id).toEqual(expect.any(String));
    expect(existsSync(path.join(
      orkas.workspaceRoot,
      usersRegistry.open_current_user_id!,
      'local',
      'system',
      'skills',
      'agent-creator',
      'SKILL.md',
    ))).toBe(true);
    const model = await orkas.invoke<{ configured: boolean }>('auth.hasConfiguredModel');
    expect(model.configured).toBe(true);
    await expect(appPage.locator('#model-guard-banner')).toHaveCount(0);

    const openBuildEnvironment = await appPage.evaluate(async () => {
      const env = await (window as any).orkas.env();
      return {
        isE2E: env.isE2E,
        appLanguage: env.appLanguage,
        systemLanguage: env.systemLanguage,
        taskNotificationsEnabled: env.taskNotificationsEnabled,
        transportScripts: document.querySelectorAll('script[data-website-id]').length,
      };
    });
    expect(openBuildEnvironment).toMatchObject({
      isE2E: true,
      taskNotificationsEnabled: true,
      transportScripts: 0,
    });
    expect(['zh', 'en', 'ja', 'pt']).toContain(openBuildEnvironment.appLanguage);
    expect(Intl.getCanonicalLocales(openBuildEnvironment.systemLanguage)[0])
      .toBe(openBuildEnvironment.systemLanguage);

    if (process.env.PWDEBUG !== '1' && process.env.ORKAS_E2E_SHOW_WINDOW !== '1') {
      const visible = await orkas.electronApp?.evaluate(({ BrowserWindow }) => {
        return BrowserWindow.getAllWindows().some((window) => window.isVisible());
      });
      expect(visible).toBe(false);
    }
  });

  test('opens the selected project and agent details', async ({ appPage, orkas }) => {
    await orkas.invoke('projects.create', { name: 'E2E Visual Project' });
    await orkas.invoke('agents.create', {
      name: 'E2EVisualAgent',
      description: 'Agent detail used to verify navigation.',
      category: 'general',
    });
    await appPage.evaluate(async () => (window as any).loadProjects(true));
    await appPage.locator('.project-row', {
      has: appPage.locator('.project-name', { hasText: 'E2E Visual Project' }),
    }).click();
    await expect(appPage.locator('#project-detail-title')).toHaveText('E2E Visual Project');

    await appPage.locator('#agents-btn').click();
    const agentCard = appPage.locator('.agent-card', { hasText: 'E2EVisualAgent' });
    await expect(agentCard).toBeVisible();
    await agentCard.click();
    await expect(appPage.locator('#agents-detail-name')).toHaveText('E2EVisualAgent');
  });

  test('selects a one-time automation date with the keyboard', async ({ appPage }) => {
    await appPage.locator('#auto-btn').click();
    await appPage.locator('#auto-add-btn').click();

    await expect(appPage.locator('input[type="date"]')).toHaveCount(0);
    await appPage.locator('#auto-freq-select .ai-select-trigger').click();
    await appPage.locator('body > .ai-select-popover .ai-select-item[data-value="one_time"]').click();
    await appPage.locator('#auto-date-input').fill('2099-08-29');
    await appPage.locator('#auto-date-input').press('Escape');
    await appPage.locator('#auto-date-picker .auto-date-picker-toggle').click();
    const calendar = appPage.locator('body > #auto-date-picker-popover');
    await expect(calendar).toBeVisible();
    await expect(calendar.locator('.auto-date-picker-day')).toHaveCount(42);

    await appPage.keyboard.press('ArrowRight');
    await appPage.keyboard.press('Enter');
    await expect(calendar).toBeHidden();
    await expect(appPage.locator('#auto-date-input')).toHaveValue('2099-08-30');
  });

  test('navigates every primary sidebar view and settings tab', async ({ appPage }) => {
    const destinations = [
      ['auto-btn', 'panel-auto'],
      ['agents-btn', 'panel-agents'],
      ['skills-btn', 'panel-skills'],
      ['connectors-btn', 'panel-connectors'],
      ['contexts-btn', 'panel-contexts'],
      ['apps-btn', 'panel-apps'],
    ] as const;

    for (const [buttonId, panelId] of destinations) {
      await appPage.locator(`#${buttonId}`).click();
      await expect(appPage.locator(`#${buttonId}`)).toHaveClass(/\bactive\b/);
      await expect(appPage.locator(`#${panelId}`)).toHaveClass(/\bactive\b/);
      await expect(appPage.locator(`#${panelId}`)).toBeVisible();
    }

    await appPage.locator('#settings-btn').click();
    await expect(appPage.locator('#settings-btn')).toHaveClass(/\bactive\b/);
    await expect(appPage.locator('#panel-settings')).toHaveClass(/\bactive\b/);
    await expect(appPage.locator('#panel-settings')).toBeVisible();

    const generalTab = appPage.locator('.settings-tab[data-settings-tab="general"]');
    await generalTab.click();
    await expect(generalTab).toHaveClass(/\bis-active\b/);
    await expect(appPage.locator('[data-settings-pane="general"]')).toBeVisible();
    await expect(appPage.locator('[data-settings-pane="account"]')).toBeHidden();
  });

});
