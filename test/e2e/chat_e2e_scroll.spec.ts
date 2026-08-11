import { expect, test } from './fixtures/orkas';

async function createProject(
  app: import('./fixtures/orkas').OrkasTestApp,
  name: string,
): Promise<void> {
  if (!app.page) throw new Error('Orkas renderer is unavailable');
  const page = app.page;
  const input = page.locator('#project-create-input');
  if (!await input.isVisible()) await page.locator('#projects-add-btn').click();
  await input.fill(name);
  await input.focus();
  await page.keyboard.press('Enter');

  const row = page.locator('.project-row', {
    has: page.locator('.project-name', { hasText: name }),
  });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(page.locator('#project-detail-title')).toHaveText(name);
}

async function historyScrollState(page: import('@playwright/test').Page): Promise<{
  pinActive: boolean;
  stickyBound: boolean;
  spacerCount: number;
}> {
  return page.locator('#chat-history').evaluate((history: HTMLElement & {
    _scrollPinActive?: boolean;
    _stickyBound?: boolean;
  }) => ({
    pinActive: history._scrollPinActive === true,
    stickyBound: history._stickyBound === true,
    spacerCount: history.querySelectorAll(':scope > .chat-scroll-spacer').length,
  }));
}

test.describe('conversation message-list scrolling', () => {
  test('keeps the process rail pinned until the user explicitly scrolls it', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const result = await modelOrkas.page.evaluate(() => {
      const runtime = window as typeof window & {
        _bindProcessStickToBottom: (el: HTMLElement) => void;
        _stickProcessBottomIfPinned: (el: HTMLElement) => void;
      };
      const body = document.createElement('div');
      body.className = 'stream-process-body';
      body.style.position = 'fixed';
      body.style.left = '-10000px';
      body.style.width = '320px';
      document.body.appendChild(body);
      runtime._bindProcessStickToBottom(body);

      const appendRows = (count: number) => {
        for (let index = 0; index < count; index += 1) {
          const row = document.createElement('div');
          row.className = 'stream-process-line';
          row.textContent = `process row ${body.children.length + 1}`;
          body.appendChild(row);
        }
      };
      const gap = () => body.scrollHeight - body.scrollTop - body.clientHeight;

      appendRows(40);
      runtime._stickProcessBottomIfPinned(body);
      const initialGap = gap();

      appendRows(5);
      runtime._stickProcessBottomIfPinned(body);
      const layoutGrowthGap = gap();

      body.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
      body.scrollTop = Math.max(0, body.scrollTop - 80);
      body.dispatchEvent(new Event('scroll'));
      const pausedTop = body.scrollTop;
      appendRows(5);
      runtime._stickProcessBottomIfPinned(body);
      const stayedPaused = body.scrollTop === pausedTop;

      body.scrollTop = body.scrollHeight;
      body.dispatchEvent(new Event('scroll'));
      appendRows(5);
      runtime._stickProcessBottomIfPinned(body);
      const resumedGap = gap();
      body.remove();

      return { initialGap, layoutGrowthGap, stayedPaused, resumedGap };
    });

    expect(result.initialGap).toBeLessThanOrEqual(1);
    expect(result.layoutGrowthGap).toBeLessThanOrEqual(1);
    expect(result.stayedPaused).toBe(true);
    expect(result.resumedGap).toBeLessThanOrEqual(1);
  });

  test('releases the send-time pin when a fresh task is scrolled during streaming', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill('E2E establish a fresh task without history hydration.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#chat-history [data-role="final"]')).toContainText(
      'Hello from the local E2E model.',
      { timeout: 20_000 },
    );

    modelOrkas.setModelMode('slow');
    await page.locator('#chat-input').fill('E2E keep the second response streaming while I scroll the message list.');
    await page.locator('#chat-input').press('Enter');
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
    await expect.poll(async () => historyScrollState(page)).toMatchObject({
      pinActive: true,
      spacerCount: 1,
    });

    const history = page.locator('#chat-history');
    await history.hover({ position: { x: 40, y: 80 } });
    await page.mouse.wheel(0, 420);

    // Check before the deterministic slow stream reaches its 2.4s terminal
    // marker; terminal cleanup also removes the spacer and would mask a wheel
    // gesture that the message list never handled.
    await page.waitForTimeout(150);
    expect(await historyScrollState(page)).toEqual({
      pinActive: false,
      stickyBound: true,
      spacerCount: 0,
    });
  });

  test('keeps a project-created task message list scrollable during streaming', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    await createProject(modelOrkas, 'E2E Streaming Scroll Project');

    await page.locator('#project-chat-input').fill('E2E establish the project-created task.');
    await page.locator('#project-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-history [data-role="final"]')).toContainText(
      'Hello from the local E2E model.',
      { timeout: 20_000 },
    );

    modelOrkas.setModelMode('slow');
    await page.locator('#chat-input').fill('E2E stream the project follow-up while I scroll downward.');
    await page.locator('#chat-input').press('Enter');
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
    await expect.poll(async () => historyScrollState(page)).toMatchObject({
      pinActive: true,
      stickyBound: true,
      spacerCount: 1,
    });

    const history = page.locator('#chat-history');
    await history.hover({ position: { x: 40, y: 80 } });
    await page.mouse.wheel(0, 420);
    await page.waitForTimeout(150);

    expect(await historyScrollState(page)).toEqual({
      pinActive: false,
      stickyBound: true,
      spacerCount: 0,
    });
  });
});
