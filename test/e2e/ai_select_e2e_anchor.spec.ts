import { expect, test } from './fixtures/orkas';

for (const language of ['zh', 'en', 'ar']) test('keeps the shared language menu anchored in ' + language, async ({ orkas }, info) => {
  const page = orkas.page!;
  await page.evaluate(async lang => { await (window as any).setLang(lang); }, language);
  await page.locator('#settings-btn').click();
  await page.locator('[data-settings-tab="general"]').click();
  const trigger = page.locator('#settings-language-select .ai-select-trigger');
  const menu = page.locator('body > .ai-select-popover:not([hidden])');
  const assertAnchor = async () => {
    const anchor = await trigger.boundingBox(), popup = await menu.boundingBox();
    expect(anchor).not.toBeNull(); expect(popup).not.toBeNull();
    expect(Math.abs(anchor!.x - popup!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(anchor!.width - popup!.width)).toBeLessThanOrEqual(1);
    const viewport = page.viewportSize()!;
    expect(popup!.y).toBeGreaterThanOrEqual(7);
    expect(popup!.y + popup!.height).toBeLessThanOrEqual(viewport.height - 7);
  };
  for (const width of [1024, 760]) {
    await page.setViewportSize({ width, height: 740 });
    await trigger.click();
    await assertAnchor();
    await page.screenshot({ path: info.outputPath('language-menu-' + language + '-' + width + '.png') });
    // Escape and repeated opening must restore the original slot and leave the
    // persisted language unchanged. Selection remains a separate real action.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.locator('#settings-language-select .ai-select-popover')).toBeHidden();
    expect(await page.locator('#settings-language-select .ai-select-popover').evaluate(el => (el as HTMLElement).style.right)).toBe('');
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
    await expect(page.locator('#settings-language-select')).toHaveAttribute('data-value', language);
  }
  await trigger.focus();
  await page.keyboard.press('Enter');
  await assertAnchor();
  await page.keyboard.press(language === 'ar' ? 'ArrowUp' : 'ArrowDown');
  // An IME commit must not select a language or dismiss the menu.
  await trigger.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
  await expect(menu).toBeVisible();
  await expect(page.locator('#settings-language-select')).toHaveAttribute('data-value', language);
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  const saved = await orkas.invoke<{ language: string }>('config.getLanguage');
  expect(saved.language).not.toBe(language);
  const reopened = await orkas.relaunch();
  await expect(reopened.locator('html')).toHaveAttribute('lang', ({ zh: 'zh-CN', 'zh-tw': 'zh-TW', 'pt-pt': 'pt-PT' } as Record<string, string>)[saved.language] || saved.language);
});
