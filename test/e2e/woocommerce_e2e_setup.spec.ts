import { expect, test } from './fixtures/orkas';


test('WooCommerce setup accepts a store URL without keys and retains manual fields across locales', async ({ orkas }) => {
  const page = orkas.page!;
  await page.locator('#connectors-btn').click();
  await page.locator('#connectors-search-input').fill('woocommerce');
  await page.locator('.connector-card[data-id="woocommerce"] [data-act="connect"]').click();
  const dialog = page.locator('#connectors-connect-modal');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-connector-field][required]')).toHaveCount(1);
  await dialog.locator('#connector-setup-field-0').fill('https://shop.example.com/wordpress');
  expect(await dialog.locator('form').evaluate(form => (form as HTMLFormElement).checkValidity())).toBe(true);
  await expect(dialog.locator('#connector-setup-field-1')).toHaveValue('');
  await expect(dialog.locator('#connector-setup-field-2')).toHaveValue('');
  for (const lang of ['en', 'zh', 'ja', 'pt', 'es', 'fr', 'ko', 'de', 'ru', 'it']) {
    await page.evaluate(async locale => { await (window as any).setLang(locale); }, lang);
    await expect(dialog.locator('.connectors-setup-instructions')).not.toBeEmpty();
    await expect(dialog).not.toContainText('connectors.setup.');
    await expect(dialog.locator('#connector-setup-field-0')).toHaveValue('https://shop.example.com/wordpress');
    await expect(dialog.locator('#connector-setup-field-2')).toHaveAttribute('type', 'password');
  }
  await dialog.locator('[data-act="cancel"]').click();
  await expect(dialog).toHaveCount(0);
  const state = await orkas.invoke<{ instances: Array<{ id: string }> }>('connectors.list');
  expect(state.instances.some(instance => instance.id === 'woocommerce')).toBe(false);
});
