import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Allow the installed browser to run this isolated renderer suite without downloads.
test.use({ launchOptions: { executablePath: process.env.ORKAS_E2E_BROWSER_PATH } });

const renderer = path.resolve(__dirname, '../../src/renderer');
const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="steelblue"/></svg>');
const picture = (id: string) => `<img id="${id}" class="chat-md-img" src="${svg}#${id}" alt="${id}">`;

const capturedLogs = new WeakMap<Page, Array<{ level: string; message: string }>>();
test.afterEach(async ({ page }, testInfo) => {
  const captured = capturedLogs.get(page) || [];
  await testInfo.attach('browser-log-audit.json', {
    body: JSON.stringify({ total: captured.length,
      unexpected: captured.map(log => ({ ...log, message: log.message.replace(/file:\/\/\/\S+/g, '[local-file]') })) }),
    contentType: 'application/json',
  });
  expect(captured).toEqual([]);
});

// Real renderer scripts and browser events; only IPC/history data is controlled.
// This suite owns gallery UI integration, not backend history or file permissions.
async function setup(page: Page, content: string) {
  const errors: string[] = [];
  const captured: Array<{ level: string; message: string }> = [];
  capturedLogs.set(page, captured);
  page.on('pageerror', (error) => {
    errors.push(error.message);
    captured.push({ level: 'error', message: error.message });
  });
  page.on('console', (message) => {
    captured.push({ level: message.type(), message: message.text() });
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  await page.setContent(`<textarea id="composer"></textarea><div id="chat-history" class="chat-history">${content}</div><div class="chat-history">${picture('other-task')}</div>`);
  await page.addStyleTag({ content: fs.readFileSync(path.join(renderer, 'style.css'), 'utf8') });
  await page.evaluate(() => {
    const w = window as any;
    w.currentCid = 'task-a';
    w.t = (key: string) => key;
    w.calls = [];
    w.toasts = [];
    w.uiToast = (message: string) => w.toasts.push(message);
    w.orkas = { invoke: async (channel: string, payload: any) => {
      w.calls.push([channel, payload]);
      if (channel === 'attachments.absPath') return { ok: true, path: '/fixtures/' + payload.name };
      return { ok: true, exists: true, isFile: true };
    } };
  });
  await page.addScriptTag({ path: path.join(renderer, 'modules/icons.js') });
  await page.addScriptTag({ path: path.join(renderer, 'modules/chat-lightbox.js') });
  await page.addScriptTag({ path: path.join(renderer, 'modules/chat-file-viewer.js') });
  return errors;
}

const preview = (page: Page) => page.locator('.chat-lightbox-img');

for (const nativePreview of [true, false]) {
  test(`zoom controls stay dim outside hover and zoom activity (${nativePreview ? 'preview window' : 'overlay'})`, async ({ page }, info) => {
    const errors = await setup(page, picture('controls'));
    if (nativePreview) {
      await page.addStyleTag({ path: path.join(renderer, 'preview.css') });
      await page.evaluate(() => document.body.classList.add('preview-window'));
    }
    await page.evaluate(src => (window as any).openChatImageLightbox(src, 'Image preview', { absPath: '/fixtures/controls.png', cid: 'task-a' }), svg);
    const zoom = page.locator('.chat-lightbox-zoom');
    const actions = page.locator('.chat-lightbox-actions');
    const into = page.locator('.chat-lightbox-zoom-in');
    await expect(preview(page)).toBeVisible();
    await expect(zoom).toHaveCSS('opacity', '0.5');
    if (nativePreview) {
      expect(await zoom.evaluate(el => getComputedStyle(el).backgroundColor))
        .toBe(await actions.evaluate(el => getComputedStyle(el).backgroundColor));
    }
    expect((await into.boundingBox())!.width).toBe(24);
    expect((await zoom.boundingBox())!.width).toBeLessThan(142);
    await page.mouse.move(400, 200);
    await preview(page).click();
    await preview(page).dispatchEvent('wheel', { deltaY: 80 });
    // Allow the opacity transition to settle so a transient wake cannot pass.
    await page.waitForTimeout(250);
    await expect(zoom).toHaveCSS('opacity', '0.5', { timeout: 500 });
    await zoom.hover();
    await expect(zoom).toHaveCSS('opacity', '1');
    // Hover must stay clear beyond the zoom activity timeout, without movement.
    await page.waitForTimeout(2300);
    await expect(zoom).toHaveCSS('opacity', '1');
    await page.mouse.move(400, 200);
    await expect(zoom).toHaveCSS('opacity', '0.5');
    await page.keyboard.press('+');
    await expect(page.locator('.chat-lightbox-zoom-level')).toHaveText('120%');
    await expect(zoom).toHaveCSS('opacity', '1');
    await expect(zoom).toHaveCSS('opacity', '0.5', { timeout: 4000 });
    // A clicked button stays clear while hovered, then dims after leaving.
    await into.click();
    await expect(zoom).toHaveCSS('opacity', '1');
    await page.mouse.move(400, 200);
    await expect(zoom).toHaveCSS('opacity', '0.5', { timeout: 4000 });
    // Panning the image does not wake the zoom group.
    await preview(page).dispatchEvent('wheel', { deltaX: 18, deltaY: 50 });
    await page.waitForTimeout(250);
    await expect(zoom).toHaveCSS('opacity', '0.5', { timeout: 500 });
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.chat-lightbox-zoom-reset')).toBeFocused();
    await expect(zoom).toHaveCSS('opacity', '1');
    await page.keyboard.press('Tab');
    await expect(into).toBeFocused();
    await page.keyboard.press('+');
    await expect(zoom).toHaveCSS('opacity', '1');
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect(zoom).toHaveCSS('opacity', '0.5', { timeout: 4000 });
    for (const [width, height] of [[1040, 760], [480, 320]]) {
      await page.setViewportSize({ width, height });
      await page.mouse.move(0, 0);
      await expect(zoom).toHaveCSS('opacity', '0.5', { timeout: 4000 });
      await page.screenshot({ path: info.outputPath(`zoom-idle-${width}.png`) });
      await zoom.hover();
      await expect(zoom).toHaveCSS('opacity', '1');
      await page.screenshot({ path: info.outputPath(`zoom-active-${width}.png`) });
    }
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await page.evaluate(src => (window as any).openChatImageLightbox(src, 'Reopened image'), svg);
    await expect(zoom).toHaveCSS('opacity', '0.5');
    expect(errors).toEqual([]);
  });
}

test('zooms inside the preview with buttons, pinch and pan without moving its controls', async ({ page }, info) => {
  const errors = await setup(page, picture('long-image'));
  await page.addStyleTag({ path: path.join(renderer, 'preview.css') });
  await page.evaluate(() => document.body.classList.add('preview-window'));
  const tall = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="2400"><rect width="600" height="2400" fill="steelblue"/><text x="40" y="120" fill="white" font-size="48">Long image</text></svg>');
  await page.evaluate(src => (window as any).openChatImageLightbox(src, 'Long image'), tall);
  const img = preview(page);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(2400);
  const zoom = page.locator('.chat-lightbox-zoom');
  await expect(zoom).toBeVisible();
  const controls = await zoom.boundingBox();
  const fitted = (await img.boundingBox())!;
  await page.locator('.chat-lightbox-zoom-in').click();
  await expect.poll(async () => (await img.boundingBox())!.height).toBeGreaterThan(fitted.height);
  await expect(page.locator('.chat-lightbox-zoom-level')).toHaveText('120%');
  await page.locator('.chat-lightbox-zoom-out').click();
  await expect(page.locator('.chat-lightbox-zoom-level')).toHaveText('100%');
  // Chromium delivers trackpad pinch as Ctrl+wheel. A jittering centroid must
  // not move the original focal image pixel during one continuous gesture.
  const anchor = { x: fitted.x + fitted.width * 0.7, y: fitted.y + fitted.height * 0.3 };
  await img.dispatchEvent('wheel', { ctrlKey: true, deltaY: -20, clientX: anchor.x, clientY: anchor.y });
  await img.dispatchEvent('wheel', { ctrlKey: true, deltaY: -20, clientX: anchor.x + 12, clientY: anchor.y - 8 });
  const pinched = (await img.boundingBox())!;
  expect(pinched.height / fitted.height).toBeGreaterThan(1.2);
  expect(pinched.x + pinched.width * 0.7).toBeCloseTo(anchor.x, 0);
  expect(pinched.y + pinched.height * 0.3).toBeCloseTo(anchor.y, 0);
  await img.dispatchEvent('wheel', { deltaX: 18, deltaY: 50 });
  const panned = (await img.boundingBox())!;
  expect(panned.y).toBeCloseTo(pinched.y - 50, 0);
  expect(panned.height).toBeCloseTo(pinched.height, 0);
  expect(await zoom.boundingBox()).toEqual(controls);
  expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1);
  await page.locator('.chat-lightbox-zoom-reset').click();
  await expect(img).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  for (const [width, height, locale] of [[1040, 760, 'zh'], [480, 320, 'en']] as const) {
    await page.setViewportSize({ width, height });
    const table = JSON.parse(fs.readFileSync(path.join(renderer, `locales/${locale}.json`), 'utf8'));
    await page.evaluate(table => { (window as any).t = (key: string) => table[key] || key; window.dispatchEvent(new Event('i18n-change')); }, table);
    await expect(page.locator('.chat-lightbox-zoom-reset')).toHaveAttribute('aria-label', table['chat.lightbox_zoom_reset']);
    const bounds = (await zoom.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: info.outputPath(`image-zoom-${locale}-${width}.png`) });
  }
  expect(errors).toEqual([]);
});

test('bounds zoom and resets gesture state when another image opens', async ({ page }) => {
  const errors = await setup(page, `${picture('first')}${picture('second')}`);
  await page.locator('#first').click();
  const img = preview(page);
  await expect(img).toBeVisible();
  await img.dispatchEvent('wheel', { ctrlKey: true, deltaY: -100000 });
  await expect(page.locator('.chat-lightbox-zoom-level')).toHaveText('800%');
  await expect(page.locator('.chat-lightbox-zoom-in')).toBeDisabled();
  await img.dispatchEvent('wheel', { ctrlKey: true, deltaY: 100000 });
  await expect(page.locator('.chat-lightbox-zoom-level')).toHaveText('50%');
  await expect(page.locator('.chat-lightbox-zoom-out')).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(img).toHaveAttribute('alt', 'second');
  await expect(page.locator('.chat-lightbox-zoom-level')).toHaveText('100%');
  await expect(page.locator('.chat-lightbox-zoom')).toHaveCSS('opacity', '0.5');
  await img.dispatchEvent('wheel', { deltaY: 80 });
  await expect(img).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await img.dblclick();
  await expect(page.locator('.chat-lightbox-zoom-level')).toHaveText('200%');
  await expect.poll(() => img.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)).toBe(2);
  const box = (await img.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 45, y + 60);
  await page.mouse.up();
  const dragged = (await img.boundingBox())!;
  expect(dragged.x).toBeCloseTo(box.x + 45, 0);
  expect(dragged.y).toBeCloseTo(box.y + 60, 0);
  await page.keyboard.press('Escape');
  await page.locator('#first').click();
  await expect(img).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  expect(errors).toEqual([]);
});

test('supports touchscreen pinch and continues panning after one finger lifts', async ({ page }) => {
  const errors = await setup(page, picture('touch-image'));
  await page.locator('#touch-image').click();
  const img = preview(page);
  const fitted = (await img.boundingBox())!;
  const x = fitted.x + fitted.width / 2, y = fitted.y + fitted.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchEnd' | 'touchMove' | 'touchCancel', points: { id: number; x: number; y: number }[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  await touch('touchStart', [{ id: 1, x: x - 40, y }, { id: 2, x: x + 40, y }]);
  await touch('touchMove', [{ id: 1, x: x - 80, y }, { id: 2, x: x + 80, y }]);
  await expect.poll(async () => (await img.boundingBox())!.width).toBeCloseTo(fitted.width * 2, 0);
  await touch('touchEnd', [{ id: 2, x: x + 80, y }]);
  const before = (await img.boundingBox())!;
  await touch('touchMove', [{ id: 1, x: x - 50, y: y + 40 }]);
  await expect.poll(async () => (await img.boundingBox())!.x).toBeCloseTo(before.x + 30, 0);
  const after = (await img.boundingBox())!;
  expect(after.x).toBeCloseTo(before.x + 30, 0);
  expect(after.y).toBeCloseTo(before.y + 40, 0);
  await touch('touchCancel', []);
  await page.locator('.chat-lightbox-zoom-reset').click();
  await expect(img).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await cdp.detach();
  expect(errors).toEqual([]);
});

test('browses the whole transcript in order using keys and both side buttons', async ({ page }, testInfo) => {
  const errors = await setup(page, `${picture('first')}<p>Another message</p>${picture('middle')}${picture('last')}`);
  await page.locator('#composer').focus();
  await page.locator('#middle').click();
  await expect(preview(page)).toHaveAttribute('alt', 'middle');
  await page.screenshot({ path: testInfo.outputPath('gallery.png') });
  await page.keyboard.press('+');
  await expect(preview(page)).not.toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await page.keyboard.press('ArrowRight');
  await expect(preview(page)).toHaveAttribute('alt', 'last');
  await expect(preview(page)).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect(page.locator('.chat-lightbox-next')).toBeDisabled();
  await page.locator('.chat-lightbox-previous').click();
  await expect(preview(page)).toHaveAttribute('alt', 'middle');
  await page.keyboard.press('ArrowLeft');
  await expect(preview(page)).toHaveAttribute('alt', 'first');
  await expect(page.locator('.chat-lightbox-previous')).toBeDisabled();
  await page.locator('.chat-lightbox-next').click();
  await expect(preview(page)).toHaveAttribute('alt', 'middle');
  await page.keyboard.press('Escape');
  await expect(page.locator('.chat-lightbox')).not.toBeVisible();
  await page.locator('#last').click();
  await expect(preview(page)).toHaveAttribute('alt', 'last');
  expect(errors).toEqual([]);
});

test('includes attachments and keeps actions scoped to the currently selected file', async ({ page }) => {
  const errors = await setup(page, `${picture('first')}<span id="attachment" class="chat-msg-attach" data-attach-cid="task-a" data-attach-name="reference.png"><img class="chat-attach-thumb" src="${svg}#attachment"></span>${picture('last')}`);
  await page.locator('#first').click();
  await page.keyboard.press('ArrowRight');
  await expect(preview(page)).toHaveAttribute('alt', 'reference.png');
  await expect(page.locator('.chat-lightbox-share')).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(preview(page)).toHaveAttribute('alt', 'last');
  await expect(page.locator('.chat-lightbox-share')).toBeHidden();
  await page.keyboard.press('Escape');
  // The file-viewer entry must preserve the source chip, despite using a local URL.
  await page.evaluate(() => {
    (window as any)._chatMediaLocalUrl = () => document.querySelector('#attachment img')!.getAttribute('src');
    return (window as any).openChatFileViewer('/fixtures/reference.png', 'reference.png', { cid: 'task-a', sourceElement: document.querySelector('#attachment') });
  });
  await expect(preview(page)).toHaveAttribute('alt', 'reference.png');
  await page.keyboard.press('ArrowLeft');
  await expect(preview(page)).toHaveAttribute('alt', 'first');
  expect(errors).toEqual([]);
});

test('loads older pages through text-only gaps and allows retry after a failed page', async ({ page }) => {
  const errors = await setup(page, `<div class="chat-history-load-earlier" data-cursor="80"></div>${picture('recent')}`);
  await page.evaluate((oldImage) => {
    const w = window as any;
    w.pages = [];
    w._loadOlderConversationHistory = async (cid: string, cursor: number) => {
      w.pages.push([cid, cursor]);
      const row = document.querySelector('.chat-history-load-earlier') as HTMLElement;
      if (w.pages.length === 1) return; // Failed request leaves the cursor available for retry.
      if (cursor === 80) { row.dataset.cursor = '40'; row.insertAdjacentHTML('afterend', '<p>Text-only page</p>'); }
      else { row.insertAdjacentHTML('afterend', oldImage); row.remove(); }
    };
  }, picture('oldest'));
  await page.locator('#recent').click();
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => page.evaluate(() => (window as any).toasts.length)).toBe(1);
  await expect(preview(page)).toHaveAttribute('alt', 'recent');
  await expect(page.locator('.chat-lightbox-previous')).toBeEnabled();
  await page.keyboard.press('ArrowLeft');
  await expect(preview(page)).toHaveAttribute('alt', 'oldest');
  expect(await page.evaluate(() => (window as any).pages)).toEqual([['task-a', 80], ['task-a', 80], ['task-a', 40]]);
  await expect(page.locator('.chat-lightbox-previous')).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(preview(page)).toHaveAttribute('alt', 'recent');
  expect(errors).toEqual([]);
});

test('ignores pending history completion after closing and opening another preview', async ({ page }) => {
  const errors = await setup(page, `<div class="chat-history-load-earlier" data-cursor="40"></div>${picture('recent')}`);
  await page.evaluate(() => {
    (window as any)._loadOlderConversationHistory = () => new Promise<void>((resolve) => { (window as any).releaseHistory = resolve; });
  });
  await page.locator('#recent').click();
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.chat-lightbox')).toHaveClass(/is-loading/);
  await page.keyboard.press('Escape');
  await page.evaluate((src) => (window as any).openChatImageLightbox(src, 'separate preview'), svg);
  await page.evaluate(() => (window as any).releaseHistory());
  await expect(preview(page)).toHaveAttribute('alt', 'separate preview');
  await expect(page.locator('.chat-lightbox-previous')).toBeHidden();
  await expect(page.locator('.chat-lightbox-next')).toBeHidden();
  expect(errors).toEqual([]);
});

test('refreshes after streaming updates and ignores composing arrow keys', async ({ page }) => {
  const errors = await setup(page, picture('first'));
  await page.locator('#first').click();
  await expect(page.locator('.chat-lightbox-next')).toBeHidden();
  await page.evaluate((html) => document.querySelector('#chat-history')!.insertAdjacentHTML('beforeend', html), picture('new-result'));
  await expect(page.locator('.chat-lightbox-next')).toBeEnabled();
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', isComposing: true, bubbles: true })));
  await expect(preview(page)).toHaveAttribute('alt', 'first');
  await page.keyboard.press('ArrowRight');
  await expect(preview(page)).toHaveAttribute('alt', 'new-result');
  await page.evaluate(() => { (window as any).currentCid = 'task-b'; document.querySelector('#chat-history')!.replaceChildren(); });
  await expect(page.locator('.chat-lightbox')).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('does not apply an earlier file action completion to the next image', async ({ page }) => {
  const attachment = (name: string) => `<span id="${name}" class="chat-msg-attach" data-attach-cid="task-a" data-attach-name="${name}.png"><img class="chat-attach-thumb" src="${svg}#${name}"></span>`;
  const errors = await setup(page, `${picture('start')}${attachment('one')}${attachment('two')}`);
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.orkas.invoke;
    w.orkas.invoke = (channel: string, payload: any) => channel === 'library.importProduced'
      ? new Promise((resolve) => { w.finishImport = () => resolve({ ok: true }); })
      : invoke(channel, payload);
  });
  await page.locator('#start').click();
  await page.keyboard.press('ArrowRight');
  await expect(preview(page)).toHaveAttribute('alt', 'one.png');
  await page.locator('.chat-lightbox-add-library').click();
  await expect(page.locator('.chat-lightbox-add-library')).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(preview(page)).toHaveAttribute('alt', 'two.png');
  await expect(page.locator('.chat-lightbox-add-library')).toBeEnabled();
  await page.evaluate(() => (window as any).finishImport());
  await expect(page.locator('.chat-lightbox-add-library .is-database')).toBeVisible();
  await expect(page.locator('.chat-lightbox-add-library .is-check')).toHaveCount(0);
  expect(errors).toEqual([]);
});
