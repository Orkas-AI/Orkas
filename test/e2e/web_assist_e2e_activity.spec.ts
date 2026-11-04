import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Real browser chrome, styles, layout and scrolling; task ledger IPC is the
// controlled boundary. Native page/attachment integration lives in panel E2E.
test.use({ launchOptions: { executablePath: process.env.ORKAS_E2E_BROWSER_PATH } });
const renderer = path.resolve(__dirname, '../../src/renderer');
const logs = new WeakMap<Page, Array<{ level: string; message: string }>>();

test.afterEach(async ({ page }, info) => {
  const captured = logs.get(page) || [];
  const auditPath = info.outputPath('browser-log-audit.json');
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, JSON.stringify({ total: captured.length,
    unexpected: captured.map(item => ({ level: item.level })) }));
  await info.attach('browser-log-audit.json', { path: auditPath, contentType: 'application/json' });
  expect(captured).toEqual([]);
});

async function setup(page: Page) {
  const captured: Array<{ level: string; message: string }> = [];
  logs.set(page, captured);
  page.on('console', message => captured.push({ level: message.type(), message: message.text() }));
  page.on('pageerror', error => captured.push({ level: 'error', message: error.message }));
  await page.setContent('<div id="conversation-info-panel" style="position:relative;width:600px;height:700px;display:flex"></div>');
  await page.addStyleTag({ content: fs.readFileSync(path.join(renderer, 'style.css'), 'utf8') });
  await page.evaluate(() => {
    const w = window as any;
    w.currentView = 'conversation';
    w.currentCid = 'task-a';
    w.t = (key: string) => key;
    w.createLogger = () => console;
    w.calls = [];
    w.handlers = new Map();
    w.visits = Array.from({ length: 200 }, (_,index) => ({ at: index * 2 + 2,
      url: `https://example.com/${index}?query=` + 'abcdefgh'.repeat(index % 4 === 0 ? 500 : 40) }));
    w.downloads = Array.from({ length: 200 }, (_, index) => ({ at: index * 2 + 1,
      filename: `report-${index}.csv`, origin: 'https://example.com', state: 'saved' }));
    w.openChatFileViewer = async (...args: unknown[]) => w.calls.push(['preview', ...args]);
    w.uiToast = (message: string) => w.calls.push(['toast', message]);
    w.orkas = {
      onPushEvent: (name: string, handler: unknown) => w.handlers.set(name, handler),
      invoke: async (channel: string, args: any) => {
        w.calls.push([channel, args]);
        if (channel === 'webAssist.navigations') return { ok: true, navigations: w.visits };
        if (channel === 'webAssist.downloads') return { ok: true, downloads: w.downloads };
        if (channel === 'attachments.absPath') return { ok: true, path: '/fixtures/' + args.name };
        return { ok: true, state: { tabs: [{ tab_id: 'tab-a', conversation_id: 'task-a' }], active_tab_id: 'tab-a' } };
      },
    };
  });
  await page.addScriptTag({ path: path.join(renderer, 'modules/icons.js') });
  await page.addScriptTag({ path: path.join(renderer, 'modules/overlay-manager.js') });
  await page.addScriptTag({ path: path.join(renderer, 'modules/web-assist.js') });
  await page.evaluate(() => (window as any).WebAssist.setPanelState(true, 'browser', 'task-a'));
  await page.locator('[data-act="activity"]').click();
  await expect(page.locator('.web-assist-trail-row')).toHaveCount(400);
  await expect(page.getByRole('listitem')).toHaveCount(400);
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
  });
}

async function geometry(page: Page) {
  return page.locator('.web-assist-trail-list').evaluate((list: HTMLElement) => ({
    height: list.scrollHeight, top: list.scrollTop,
    paintedRows: Array.from(list.querySelectorAll('.web-assist-trail-row'))
      .filter(row => row.checkVisibility({ contentVisibilityAuto: true })).length,
  }));
}

test('large activity stays fully readable and actionable while offscreen work is skipped, including after resize', async ({ page }, info) => {
  await setup(page);
  await settle(page);
  const first = await geometry(page);
  // The budget is about renderable content, not a timing threshold: most of
  // the 400 records must be skipped at this viewport without losing any data.
  expect(first.paintedRows).toBeLessThan(100);
  const fullLayout = await page.addStyleTag({ content: '.web-assist-trail-group { content-visibility: visible !important; }' });
  await settle(page);
  const control = await geometry(page);
  expect(control.paintedRows).toBe(400); // Negative control proves the signal.
  expect(first.height).toBe(control.height);
  await fullLayout.evaluate(element => (element as Element).remove());

  const list = page.locator('.web-assist-trail-list');
  const bounds = (await list.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 900);
  await expect.poll(async () => (await geometry(page)).top).toBeGreaterThan(0);
  expect((await geometry(page)).height).toBe(first.height);
  await list.evaluate((element: HTMLElement) => { element.scrollTop = 15000; });
  await settle(page);
  expect((await geometry(page)).height).toBe(first.height);
  expect((await geometry(page)).top).toBe(15000);

  // Changing the drawer width must remeasure long wrapped URLs rather than
  // retain stale heights, lose text, or move the scroll position on activation.
  await page.locator('#conversation-info-panel').evaluate((element: HTMLElement) => { element.style.width = '320px'; });
  await settle(page);
  const narrow = await geometry(page);
  expect(narrow.height).toBeGreaterThan(first.height);
  const narrowControl = await page.addStyleTag({ content: '.web-assist-trail-group { content-visibility: visible !important; }' });
  await settle(page);
  expect((await geometry(page)).height).toBe(narrow.height);
  await narrowControl.evaluate(element => (element as Element).remove());

  await list.evaluate((element: HTMLElement) => { element.scrollTop = element.scrollHeight; });
  await settle(page);
  const oldest = page.locator('.web-assist-trail-row').last();
  await expect(oldest.locator('.web-assist-trail-url')).toHaveText('report-0.csv');
  await expect(oldest.locator('[data-download-action="view"]')).toBeVisible();
  await oldest.locator('[data-download-action="view"]').click();
  expect(await page.evaluate(() => (window as any).calls)).toContainEqual(
    ['preview', '/fixtures/report-0.csv', 'report-0.csv', { cid: 'task-a' }]);
  // Focus can activate an offscreen batch for keyboard users.
  await page.locator('.web-assist-trail-row').nth(1).locator('[data-download-action="reveal"]').focus();
  await expect(page.locator('.web-assist-trail-row').nth(1).locator('[data-download-action="reveal"]')).toBeFocused();
  await expect(page.locator('.web-assist-trail-row').nth(1)).toBeInViewport();
  await expect(page.locator('.web-assist-trail-url').nth(398)).toHaveText('https://example.com/0?query=' + 'abcdefgh'.repeat(500));
  const budgetPath = info.outputPath('render-budget.json');
  fs.writeFileSync(budgetPath, JSON.stringify({ first, control, narrow }));
  await info.attach('render-budget.json', { path: budgetPath, contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('activity-narrow.png') });
});

test('large activity refresh retains scrolling and task switches invalidate its download actions', async ({ page }) => {
  await setup(page);
  const list = page.locator('.web-assist-trail-list');
  await list.evaluate((element: HTMLElement) => { element.scrollTop = 5000; });
  await page.evaluate(async () => {
    const w = window as any;
    w.visits.push({ at: 401, url: 'https://example.com/latest' });
    await w.handlers.get('web-assist:activity')({ conversation_id: 'task-a' });
  });
  await settle(page);
  await expect(page.locator('.web-assist-trail-row')).toHaveCount(401);
  await expect(page.locator('.web-assist-trail-url').first()).toHaveText('https://example.com/latest');
  expect((await geometry(page)).top).toBe(5000);
  const stale = await page.locator('[data-download-action="view"]').last().elementHandle();
  await page.evaluate(() => (window as any).WebAssist.setContext('conversation', 'task-b'));
  await expect(page.locator('.web-assist-activity-popover')).toBeHidden();
  await stale!.evaluate((button: HTMLButtonElement) => button.click());
  expect(await page.evaluate(() => (window as any).calls.filter(([name]: any[]) => name === 'attachments.absPath'))).toEqual([]);
});

for (const locale of ['en', 'zh']) {
  test(`activity follows its button through drawer resize and full screen (${locale})`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page);
    const copy = JSON.parse(fs.readFileSync(path.join(renderer, `locales/${locale}.json`), 'utf8'));
    await page.evaluate(translations => {
      const w = window as any;
      w.t = (key: string) => translations[key] || key;
      window.dispatchEvent(new Event('i18n-change'));
      const panel = document.getElementById('conversation-info-panel')!;
      panel.classList.add('task-side-panel');
      panel.style.cssText = 'width:600px;height:100%;min-width:0;flex:1 1 auto';
      const frame = document.createElement('div');
      frame.style.cssText = 'position:fixed;right:24px;top:80px;width:600px;height:500px;display:flex';
      panel.before(frame);
      frame.append(panel);
    }, copy);
    const popover = page.locator('.web-assist-activity-popover');
    const button = page.locator('[data-act="activity"]');
    const checkPosition = async () => {
      await settle(page);
      const anchor = (await button.boundingBox())!;
      const popup = (await popover.boundingBox())!;
      const shell = (await page.locator('.web-assist-shell').boundingBox())!;
      // The trigger owns placement; the browser edges constrain the surface.
      expect(popup.y - (anchor.y + anchor.height)).toBeCloseTo(4, 0);
      expect(popup.x).toBeGreaterThanOrEqual(shell.x + 7);
      expect(popup.x + popup.width).toBeLessThanOrEqual(shell.x + shell.width - 7);
      expect(popup.y + popup.height).toBeLessThanOrEqual(shell.y + shell.height - 7);
      if (anchor.x + anchor.width - shell.x >= popup.width + 8) {
        expect(popup.x + popup.width).toBeCloseTo(anchor.x + anchor.width, 0);
      }
      await expect(popover.locator('[data-act="close-activity"]')).toBeInViewport();
    };
    await checkPosition();
    await page.screenshot({ path: info.outputPath(`activity-${locale}-drawer.png`) });
    // Resize the host while the menu stays open; no window resize event fires.
    await page.locator('#conversation-info-panel').evaluate(panel => {
      panel.parentElement!.style.width = '340px';
      panel.parentElement!.style.height = '260px';
      panel.style.width = '340px';
    });
    await checkPosition();
    await page.setViewportSize({ width: 640, height: 420 });
    await checkPosition();
    await page.screenshot({ path: info.outputPath(`activity-${locale}-narrow.png`) });
    // Keyboard expansion keeps the menu open; Escape dismisses it first.
    await page.locator('[data-act="expand"]').focus();
    await page.keyboard.press('Enter');
    await checkPosition();
    await page.screenshot({ path: info.outputPath(`activity-${locale}-expanded.png`) });
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(button).toBeFocused();
    await page.keyboard.press('Escape');
    await button.click();
    await checkPosition();
    await popover.locator('[data-act="close-activity"]').click();
    await expect(button).toBeFocused();
    await page.evaluate(() => { (window as any).visits = []; (window as any).downloads = []; });
    await button.click();
    await expect(popover.locator('.web-assist-trail-row')).toHaveCount(0);
    await checkPosition();
    await page.screenshot({ path: info.outputPath(`activity-${locale}-empty.png`) });
    await page.mouse.click(10, 10);
    await expect(popover).toBeHidden();
  });
}
