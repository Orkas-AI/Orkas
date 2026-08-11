import { expect, test } from './fixtures/orkas';

type SkillSummary = {
  id: string;
  name: string;
  source?: string;
};

type MarketplaceCategory = {
  code: string;
  name_en: string;
  sort_order: number;
};

test.describe('Marketplace install lifecycle', () => {
  test('installs and uninstalls a catalog skill through the desktop UI', async ({ marketplaceOrkas }) => {
    if (!marketplaceOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = marketplaceOrkas.page;

    const categories = await marketplaceOrkas.invoke<{ list: MarketplaceCategory[] }>(
      'marketplace.categories',
      { force_refresh: true },
    );
    expect(categories.list).toEqual([expect.objectContaining({
      code: 'general',
      name_en: 'General',
      sort_order: 10,
    })]);

    await page.locator('#agents-btn').click();
    await page.locator('#agents-more-btn').click();
    await expect(page.locator('#panel-marketplace')).toHaveClass(/\bactive\b/);
    await expect(page.locator('.marketplace-chip[data-mp-cat="general"]')).toHaveText('General');
    await page.locator('[data-mp-tab="skill"]').click();

    const card = page.locator('.marketplace-card[data-id="marketplace-e2e-skill"]');
    await expect(card).toBeVisible();
    const installButton = card.locator('[data-mp-install="skill"]');
    await expect(installButton).toHaveText('Install');
    await installButton.click();
    await expect(card.locator('button')).toHaveText('Installed');
    await expect(card.locator('button')).toBeDisabled();

    await expect.poll(async () => {
      const result = await marketplaceOrkas.invoke<{ skills: SkillSummary[] }>('skills.list', { force: true });
      return result.skills.find((skill) => skill.id === 'marketplace-e2e-skill');
    }).toMatchObject({
      id: 'marketplace-e2e-skill',
      name: 'marketplace-e2e-skill',
      source: 'marketplace',
    });

    await card.locator('.marketplace-card-name').click();
    await expect(page.locator('#marketplace-detail-view')).toBeVisible();
    const detailButton = page.locator('[data-mp-detail-install]');
    await expect(detailButton).toHaveText('Uninstall');
    await detailButton.click();
    await expect(detailButton).toHaveText('Install');

    await expect.poll(async () => {
      const result = await marketplaceOrkas.invoke<{ skills: SkillSummary[] }>('skills.list', { force: true });
      return result.skills.some((skill) => skill.id === 'marketplace-e2e-skill');
    }).toBe(false);

    expect(marketplaceOrkas.marketplaceRequests.map((request) => request.path)).toEqual(
      expect.arrayContaining([
        '/marketplace/categories',
        '/marketplace/skills/list',
        '/marketplace/skills/bundle',
      ]),
    );
  });

  test('shows a structured quality rejection and honors keyboard override', async ({
    marketplaceOrkas,
  }) => {
    if (!marketplaceOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = marketplaceOrkas.page;

    await page.locator('#agents-btn').click();
    await page.locator('#agents-more-btn').click();
    await page.locator('[data-mp-tab="skill"]').click();

    const card = page.locator('.marketplace-card[data-id="marketplace-e2e-unsafe-skill"]');
    await expect(card).toBeVisible();
    await card.locator('[data-mp-install="skill"]').click();

    const report = page.locator('.quality-report-dialog');
    await expect(report).toBeVisible();
    await expect(report.locator('.ui-dialog-title')).toContainText(
      'Unsafe Marketplace E2E Skill',
    );
    await expect(report.locator('.quality-violation')).toHaveCount(1);
    await expect(report).toContainText('no_spec_self_modification');
    await expect(report).toContainText(
      'Skill or agent code must not modify its own spec or another skill',
    );
    const blockedResult = await marketplaceOrkas.invoke<{ skills: SkillSummary[] }>(
      'skills.list',
      { force: true },
    );
    expect(blockedResult.skills.some(
      (skill) => skill.id === 'marketplace-e2e-unsafe-skill',
    )).toBe(false);
    const persistedReport = await page.evaluate(async () => (
      (window as any).orkas.quality.readSkillReport('marketplace-e2e-unsafe-skill')
    ));
    expect(persistedReport).toMatchObject({ ok: true, report: { ok: false } });
    expect(persistedReport.report.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'no_spec_self_modification', level: 'EXTREME' }),
    ]));
    const traversalAttempt = await page.evaluate(async () => (
      (window as any).orkas.quality.readSkillReport('../../config/auth-profiles')
    ));
    expect(traversalAttempt).toMatchObject({
      ok: false,
      error: 'invalid id',
    });

    const forceButton = report.locator('[data-act="force"]');
    await forceButton.focus();
    await page.keyboard.press('Enter');

    await expect(report).toHaveCount(0);
    await expect(card.locator('button')).toHaveText('Installed');
    await expect(card.locator('button')).toBeDisabled();
    await expect.poll(async () => {
      const result = await marketplaceOrkas.invoke<{ skills: SkillSummary[] }>(
        'skills.list',
        { force: true },
      );
      return result.skills.find((skill) => skill.id === 'marketplace-e2e-unsafe-skill');
    }).toMatchObject({
      id: 'marketplace-e2e-unsafe-skill',
      source: 'marketplace',
    });

    const unsafeBundleRequests = marketplaceOrkas.marketplaceRequests.filter(
      (request) => (
        request.path === '/marketplace/skills/bundle'
        && request.body.id === 'marketplace-e2e-unsafe-skill'
      ),
    );
    expect(unsafeBundleRequests).toHaveLength(2);
  });
});
