import { expect, test } from './fixtures/orkas';

type AgentSummary = { agent_id: string; name: string; enabled?: boolean };
type SkillSummary = { id: string; name: string; enabled?: boolean };
type RecycleBatch = {
  kind?: string;
  display_items?: Array<{ category: string; id?: string; title: string }>;
};

test.describe('agents and skills', () => {
  // Each CRUD case verifies persistence through a complete Electron relaunch.
  // Loading the resource catalog after a cold Windows restart can consume most
  // of the default test budget before the delete/recovery assertions run.
  test.describe.configure({
    timeout: process.platform === 'win32' ? 120_000 : 60_000,
  });

  test('renders the localized Commander profile and persists its color-only avatar choice', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    await orkas.invoke('config.setLanguage', { language: 'pt' });

    let page = await orkas.relaunch();
    await page.locator('#agents-btn').click();
    const card = page.locator('.agent-card[data-id="commander"]');
    await expect(card.locator('.agent-card-name')).toHaveText('Comandante');
    await expect(card.locator('.agent-card-desc')).toContainText('camada de orquestração');

    await card.click();
    await expect(page.locator('#agents-detail-name')).toHaveText('Comandante');
    await expect(page.locator('#agents-detail-desc')).toContainText('camada de orquestração');

    await page.locator('#agents-detail-avatar .avatar-circle').click();
    const picker = page.locator('#avatar-picker');
    await expect(picker).toBeVisible();
    await expect(picker.locator('[data-role="icon-section"]')).toBeHidden();
    await picker.locator('[data-color="sky"]').click();
    await expect.poll(async () => (
      await orkas.invoke<{ avatar: { icon: string; color: string } }>('prefs.getCommanderAvatar')
    ).avatar).toEqual({ icon: 'crown', color: 'sky' });

    page = await orkas.relaunch();
    await page.locator('#agents-btn').click();
    const relaunchedCard = page.locator('.agent-card[data-id="commander"]');
    await expect(relaunchedCard.locator('.agent-card-name')).toHaveText('Comandante');
    await expect(relaunchedCard.locator('.avatar-circle'))
      .toHaveAttribute('style', /--avatar-bg:#7dd3fc/);
  });

  test('creates an agent, persists its enabled state, and deletes it', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    await page.locator('#agents-btn').click();
    await expect(page.locator('#panel-agents')).toHaveClass(/\bactive\b/);
    await page.locator('#create-agent-btn').click();

    const modal = page.locator('#agent-modal');
    await expect(modal).toHaveClass(/\bopen\b/);
    await page.locator('#agent-name-input').fill('E2EAgent');
    await page.locator('#agent-desc-input').fill('Checks deterministic desktop user flows.');
    await page.locator('#agent-save-btn').click();

    await expect(page.locator('#agents-detail-name')).toHaveText('E2EAgent');
    await expect(page.locator('#agent-edit-btn')).toHaveText('Done');
    await page.locator('#agent-edit-btn').click();
    await expect(page.locator('#agent-enabled-btn')).toBeVisible();
    const created = await orkas.invoke<{ agents: AgentSummary[] }>('agents.list');
    const agent = created.agents.find((item) => item.name === 'E2EAgent');
    expect(agent).toBeTruthy();

    await page.locator('#agent-enabled-btn').click();
    await expect.poll(async () => {
      const result = await orkas.invoke<{ agents: AgentSummary[] }>('agents.list');
      return result.agents.find((item) => item.agent_id === agent?.agent_id)?.enabled;
    }).toBe(false);

    const relaunchedPage = await orkas.relaunch();
    await relaunchedPage.locator('#agents-btn').click();
    const card = relaunchedPage.locator(`.agent-card[data-id="${agent?.agent_id}"]`);
    await expect(card).toHaveClass(/\bis-disabled\b/, { timeout: 30_000 });
    await card.click();
    await expect(relaunchedPage.locator('#agents-detail-name')).toHaveText('E2EAgent');
    await relaunchedPage.locator('#agent-delete-btn').click();
    await expect(relaunchedPage.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(relaunchedPage.locator(`.agent-card[data-id="${agent?.agent_id}"]`)).toHaveCount(0);
    const recycle = await orkas.invoke<{ batches: RecycleBatch[] }>('recycle.list');
    expect(recycle.batches).toContainEqual(expect.objectContaining({
      kind: 'agent',
      display_items: expect.arrayContaining([
        expect.objectContaining({
          category: 'agent',
          id: agent?.agent_id,
          title: 'E2EAgent',
        }),
      ]),
    }));
  });

  test('creates a skill, persists its enabled state, and deletes it', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    await page.locator('#skills-btn').click();
    await expect(page.locator('#panel-skills')).toHaveClass(/\bactive\b/);
    await page.locator('#create-skill-btn').click();

    const modal = page.locator('#skill-modal');
    await expect(modal).toHaveClass(/\bopen\b/);
    await page.locator('#skill-name').fill('e2e-desktop-check');
    await page.locator('#skill-description').fill('Verifies deterministic desktop UI behavior.');
    await page.locator('#skill-save-btn').click();

    await expect(page.locator('#skills-detail-name')).toHaveText('e2e-desktop-check');
    await expect(page.locator('#skill-edit-btn')).toHaveText('Done');
    await page.locator('#skill-edit-btn').click();
    await expect(page.locator('#skill-enabled-btn')).toBeVisible();
    const created = await orkas.invoke<{ skills: SkillSummary[] }>('skills.list');
    const skill = created.skills.find((item) => item.name === 'e2e-desktop-check');
    expect(skill).toBeTruthy();

    await page.locator('#skill-enabled-btn').click();
    await expect.poll(async () => {
      const result = await orkas.invoke<{ skills: SkillSummary[] }>('skills.list');
      return result.skills.find((item) => item.id === skill?.id)?.enabled;
    }).toBe(false);

    const relaunchedPage = await orkas.relaunch();
    await relaunchedPage.locator('#skills-btn').click();
    const card = relaunchedPage.locator(`.skill-card[data-id="${skill?.id}"]`);
    await expect(card).toHaveClass(/\bis-disabled\b/, { timeout: 30_000 });
    await card.click();
    await expect(relaunchedPage.locator('#skills-detail-name')).toHaveText('e2e-desktop-check');
    await relaunchedPage.locator('#skill-delete-btn').click();
    await expect(relaunchedPage.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(relaunchedPage.locator(`.skill-card[data-id="${skill?.id}"]`)).toHaveCount(0);
    const recycle = await orkas.invoke<{ batches: RecycleBatch[] }>('recycle.list');
    expect(recycle.batches).toContainEqual(expect.objectContaining({
      kind: 'skill',
      display_items: expect.arrayContaining([
        expect.objectContaining({
          category: 'skill',
          id: skill?.id,
          title: 'e2e-desktop-check',
        }),
      ]),
    }));
  });
});
