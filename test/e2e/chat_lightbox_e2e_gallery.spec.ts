import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Allow the installed browser to run this isolated renderer suite without downloads.
test.use({ launchOptions: { executablePath: process.env.ORKAS_E2E_BROWSER_PATH } });

const renderer = path.resolve(__dirname, '../../src/renderer');
const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="steelblue"/></svg>');
const picture = (id: string) => `<img id="${id}" class="chat-md-img" src="${svg}#${id}" alt="${id}">`;

// Real renderer scripts and browser events; only IPC/history data is controlled.
// This suite owns gallery UI integration, not backend history or file permissions.
async function setup(page: Page, content: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
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
