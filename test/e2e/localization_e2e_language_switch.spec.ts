import { expect, test } from './fixtures/orkas';

test.describe('localization', () => {
  test('switches from the real Settings control and preserves the choice after relaunch', async ({
    appPage,
    orkas,
  }) => {
    await appPage.locator('#settings-btn').click();
    await appPage.locator('[data-settings-tab="general"]').click();
    const select = appPage.locator('#settings-language-select');
    await select.locator('.ai-select-trigger').click();
    const portuguese = appPage.locator(
      'body > .ai-select-popover .ai-select-item',
      { hasText: 'Português (Brasil)' },
    );
    await expect(portuguese).toBeVisible();
    await portuguese.click();

    await expect.poll(async () => (
      appPage.locator('html').getAttribute('lang')
    )).toBe('pt-BR');
    await expect(appPage.locator('#agents-btn')).toContainText('Equipe de IA');
    const portugueseFooter = await appPage.evaluate(() => {
      const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
      const settings = document.querySelector('#settings-btn .sidebar-footer-label') as HTMLElement | null;
      return {
        sidebarWidth: Math.round(sidebar?.getBoundingClientRect().width || 0),
        settingsFits: !!settings && settings.scrollWidth <= settings.clientWidth,
      };
    });
    expect(portugueseFooter).toEqual({
      sidebarWidth: 280,
      settingsFits: true,
    });
    await expect.poll(async () => (
      await orkas.invoke<{ language: string }>('config.getLanguage')
    ).language).toBe('pt');

    const relaunchedPage = await orkas.relaunch();
    await expect(relaunchedPage.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(relaunchedPage.locator('#agents-btn')).toContainText('Equipe de IA');
  });
});
