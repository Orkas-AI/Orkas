import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { loadRetainedFilePage } from './fixtures/retained-file-page';

test.use({ launchOptions: { executablePath: process.env.ORKAS_E2E_BROWSER_PATH } });
const renderer = path.resolve(__dirname, '../../src/renderer');

for (const language of ['zh', 'en', 'ar']) test(`shared selector retains its anchor and lifecycle in ${language}`, async ({ page }, info) => {
  const diagnostics: string[] = [];
  page.on('console', message => diagnostics.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', error => diagnostics.push(`error: ${error.message}`));
  try {
    const file = info.outputPath('select.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `<!doctype html><html dir="${language === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
      <base href="${pathToFileURL(renderer + path.sep).href}"><link rel="stylesheet" href="style.css">
      <style>body{overflow:hidden}.modal-standard{width:440px;padding:32px}</style>
      <script>window.t=k=>k;window.createLogger=()=>console;</script>
      <script src="modules/icons.js"></script><script src="modules/dropdown-placement.js"></script>
      <script src="modules/utils.js"></script></head><body>
      <div class="modal-overlay open"><div class="modal-standard"><div id="select"></div><button id="outside">Outside</button></div></div>
      </body></html>`);
    await loadRetainedFilePage(page, file);
    await page.evaluate(language => {
      const w = window as any;
      w.selected = [];
      w.api = w._aiSelectMount(document.getElementById('select'), {
        ariaLabel: language === 'ar' ? 'اختيار' : language === 'zh' ? '选择' : 'Select',
        value: 'a', options: [{ value: 'a', label: 'Alpha' }, { value: 'blocked', label: 'Unavailable', disabled: true },
          { value: 'b', label: 'Beta' }], onChange: (value: string) => w.selected.push(value),
      });
    }, language);
    const trigger = page.locator('#select .ai-select-trigger');
    const menu = page.locator('body > .ai-select-popover:not([hidden])');
    const assertAnchor = async () => {
      await expect.poll(async () => {
        const a = await trigger.boundingBox(), b = await menu.boundingBox();
        return a && b ? Math.max(Math.abs(a.x - b.x), Math.abs(a.width - b.width)) : Infinity;
      }).toBeLessThanOrEqual(1);
      const anchor = await trigger.boundingBox(), popup = await menu.boundingBox();
      expect(anchor).not.toBeNull(); expect(popup).not.toBeNull();
      expect(Math.abs(anchor!.x - popup!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(anchor!.width - popup!.width)).toBeLessThanOrEqual(1);
      expect(popup!.y).toBeGreaterThanOrEqual(7);
      expect(popup!.y + popup!.height).toBeLessThanOrEqual(page.viewportSize()!.height - 7);
    };
    for (const width of [1024, 760]) {
      await page.setViewportSize({ width, height: 650 });
      await trigger.click(); await assertAnchor();
      await page.setViewportSize({ width: width - 30, height: 600 }); await assertAnchor();
      await page.screenshot({ path: info.outputPath(`menu-${language}-${width}.png`) });
      await page.locator('#outside').click(); await expect(menu).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).selected)).toEqual([]);
      expect(await page.locator('#select .ai-select-popover').evaluate(el => (el as HTMLElement).style.right)).toBe('');
    }
    await trigger.focus(); await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await trigger.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => (window as any).selected)).toEqual([]);
    await page.keyboard.press('Enter'); await expect(menu).toHaveCount(0);
    await expect(page.locator('#select')).toHaveAttribute('data-value', 'b');
    expect(await page.evaluate(() => (window as any).selected)).toEqual(['b']);
    // Removing an owner while open must detach its portal on close, without
    // retaining a body-level menu or a second selection side effect.
    await trigger.click();
    await page.evaluate(() => { const w = window as any; w.api.el.remove(); w.api.close(); });
    await expect(page.locator('.ai-select-popover')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).selected)).toEqual(['b']);
  } finally {
    fs.writeFileSync(info.outputPath('browser-log-audit.json'), JSON.stringify({ captured: diagnostics.length, diagnostics }));
    expect(diagnostics).toEqual([]);
  }
});
