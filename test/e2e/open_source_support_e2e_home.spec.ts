import { expect, test } from './fixtures/orkas';

const STORAGE_KEY = 'orkas-open-source-support-v1';
const REPOSITORY = 'https://github.com/Orkas-AI/Orkas';

test('invites after two successful user rounds and respects local dismissal', async ({ orkas, appPage }, testInfo) => {
  const app = orkas.electronApp!;
  const native = await app.browserWindow(appPage);
  const send = async (runId: string, status = 'completed', kind = 'task') => {
    await native.evaluate((win, terminal) => {
      win.webContents.send('conversation:task_terminal', terminal);
    }, { type: 'terminal', run_id: runId, conversation_id: 'same-task', status, kind });
  };
  await appPage.evaluate(async () => { await (window as any).setLang('zh'); });
  await appPage.locator('#settings-btn').click();
  await appPage.locator('[data-settings-tab="general"]').click();
  const settings = appPage.locator('#settings-open-source');
  await expect(settings.locator('a')).toHaveAttribute('href', REPOSITORY);
  const card = appPage.locator('#home-open-source-support');
  await send('run-1');
  await send('run-1');
  await send('auto-run', 'completed', 'automation');
  await send('held-run', 'waiting_input');
  await send('failed-run', 'failed');
  await appPage.locator('#new-chat-btn').click();
  await expect(card).toBeHidden();
  await send('run-2');
  const state = () => appPage.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), STORAGE_KEY);
  await expect.poll(async () => (await state()).eligible).toBe(true);
  await expect(card).toBeHidden();
  await appPage.locator('#settings-btn').click();
  await appPage.locator('#new-chat-btn').click();
  await expect(card.getByRole('heading', { name: '支持开源' })).toBeVisible();
  await expect(card.locator('a')).toHaveAttribute('href', REPOSITORY);
  await appPage.locator('#settings-btn').click();
  await appPage.locator('#new-chat-btn').click();
  await expect(card).toBeVisible();
  await appPage.screenshot({ path: testInfo.outputPath('commander-home-star.png'), animations: 'disabled', scale: 'css' });
  await card.getByRole('button', { name: '不再提醒' }).click();
  await expect(card).toBeHidden();
  await appPage.locator('#settings-btn').click();
  await appPage.locator('#new-chat-btn').click();
  await expect(card).toBeHidden();
  expect((await state()).decision).toBe('dismissed');
});

test('opening GitHub from General suppresses the home invitation before eligibility', async ({ orkas, appPage }) => {
  const app = orkas.electronApp!;
  await app.evaluate(({ shell }) => {
    const state = globalThis as any;
    state.originalStarOpen = shell.openExternal;
    state.starOpened = [];
    shell.openExternal = async (url: string) => { state.starOpened.push(url); };
  });
  try {
    await appPage.locator('#settings-btn').click();
    await appPage.locator('[data-settings-tab="general"]').click();
    await appPage.locator('#settings-open-source a').press('Enter');
    await expect.poll(() => app.evaluate(() => (globalThis as any).starOpened)).toEqual([REPOSITORY]);
    const result = await appPage.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), STORAGE_KEY);
    expect(result.decision).toBe('opened');
    const native = await app.browserWindow(appPage);
    await native.evaluate(win => {
      for (const runId of ['a', 'b']) {
        win.webContents.send('conversation:task_terminal', { type: 'terminal', run_id: runId, status: 'completed', kind: 'task' });
      }
    });
    await appPage.locator('#new-chat-btn').click();
    await expect(appPage.locator('#home-open-source-support')).toBeHidden();
  } finally {
    await app.evaluate(({ shell }) => { shell.openExternal = (globalThis as any).originalStarOpen; });
  }
});

test('counts two actual successful rounds in the same task conversation', async ({ modelOrkas }) => {
  const page = modelOrkas.page!;
  const card = page.locator('#home-open-source-support');
  const state = () => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), STORAGE_KEY);
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill('Summarize the first example.');
  await page.locator('#new-chat-send-btn').click();
  await expect.poll(async () => (await state()).firstRun, { timeout: 30_000 }).toMatch(/^[a-z0-9]+$/i);
  const cid = await page.evaluate<string>('currentCid');
  expect(cid).toBeTruthy();
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  const followUp = page.locator('#chat-input');
  await followUp.fill('Summarize the second example.');
  await followUp.press('Enter');
  await expect.poll(() => modelOrkas.modelRequests.length).toBe(2);
  await expect.poll(async () => (await state()).eligible, { timeout: 30_000 }).toBe(true);
  expect(await page.evaluate<string>('currentCid')).toBe(cid);
  await expect(card).toBeHidden();
  await page.locator('#new-chat-btn').click();
  await expect(card.getByRole('heading', { name: 'Support open source' })).toBeVisible();
});
