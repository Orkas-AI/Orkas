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
  for (const [position, update] of [
    ['bottom', 'activity'], ['bottom', 'receipt'],
    ['reading', 'activity'], ['reading', 'receipt'],
  ] as const) {
    test(`keeps the viewport steady when an appended message moves upward (${position}, ${update})`, async ({ modelOrkas }, testInfo) => {
      if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
      const page = modelOrkas.page;
      if (position === 'reading') {
        await page.setViewportSize({ width: 1000, height: 700 });
        await page.evaluate(() => (window as typeof window & { setLang: (lang: string) => void }).setLang('zh'));
      }
      await page.locator('#new-chat-btn').click();
      await page.locator('#new-chat-input').fill('E2E establish the reorder scroll fixture.');
      await page.locator('#new-chat-send-btn').click();
      await expect(page.locator('#chat-history .chat-message.assistant .chat-bubble > :is(.markdown-body, [data-role="final"])')).toContainText(
        'Hello from the local E2E model.',
        { timeout: 20_000 },
      );
      await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);

      const before = await page.evaluate(async (position) => {
        const runtime = window as typeof window & {
          appendChatMessage: (message: object, autoScroll: boolean) => HTMLElement;
          _markEarlierLiveMessagesForUser: (history: HTMLElement, user: HTMLElement) => void;
        };
        const history = document.getElementById('chat-history')!;
        history.replaceChildren();
        const paragraphs = (label: string, count: number) => Array.from(
          { length: count }, (_, index) => `${label} paragraph ${index + 1}.`,
        ).join('\n\n');
        for (let index = 0; index < 6; index += 1) {
          runtime.appendChatMessage({ role: 'user', content: paragraphs('Earlier message', 3), time: 1000 + index }, false);
        }
        const assistant = runtime.appendChatMessage({
          role: 'assistant', content: paragraphs('Current reply', 10), time: 2000,
        }, false);
        assistant.dataset.placeholder = '1';
        assistant.dataset.reorderFixture = 'reply';
        const user = runtime.appendChatMessage({
          role: 'user', content: paragraphs('Appended message', 18), time: 3000,
        }, false);
        user.dataset.reorderFixture = 'user';
        runtime._markEarlierLiveMessagesForUser(history, user);
        history.style.scrollBehavior = 'auto';
        history.scrollTop = history.scrollHeight;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (position === 'reading') {
          history.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
          history.scrollTop -= 100;
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        history.style.removeProperty('scroll-behavior');
        return { top: history.scrollTop, userTop: user.getBoundingClientRect().top };
      }, position);

      const after = await page.evaluate(async (update) => {
        const runtime = window as typeof window & {
          _advanceStreamingMessageActivityPosition: (message: HTMLElement) => boolean;
          _syncRenderedGroupMessageIdentity: (message: HTMLElement, record: object) => void;
        };
        const history = document.getElementById('chat-history')!;
        const assistant = history.querySelector<HTMLElement>('[data-reorder-fixture="reply"]')!;
        const user = history.querySelector<HTMLElement>('[data-reorder-fixture="user"]')!;
        if (update === 'activity') runtime._advanceStreamingMessageActivityPosition(assistant);
        else runtime._syncRenderedGroupMessageIdentity(assistant, { id: 'received-reply', ts: 4000 });
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        return {
          userBeforeReply: user.nextElementSibling === assistant,
          top: history.scrollTop,
          userTop: user.getBoundingClientRect().top,
        };
      }, update);
      await testInfo.attach('scroll-geometry', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
      await page.screenshot({ path: testInfo.outputPath(`reorder-${position}-${update}.png`) });
      expect(after.userBeforeReply).toBe(true);
      expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
      expect(after.userTop).toBeLessThan(before.userTop - 100);
    });
  }

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
    await expect(page.locator('#chat-history .chat-message.assistant .chat-bubble > :is(.markdown-body, [data-role="final"])')).toContainText(
      'Hello from the local E2E model.',
      { timeout: 20_000 },
    );

    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    modelOrkas.setModelMode('controlled-slow');
    await page.locator('#chat-input').fill('E2E keep the second response streaming while I scroll the message list.');
    await page.locator('#chat-input').press('Enter');
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(2);
    modelOrkas.releaseControlledModelChunk();
    await expect.poll(async () => historyScrollState(page)).toMatchObject({
      pinActive: true,
      spacerCount: 1,
    });

    const history = page.locator('#chat-history');
    await history.hover({ position: { x: 40, y: 80 } });
    await page.mouse.wheel(0, 420);

    // Keep the terminal marker withheld so completion cannot remove the
    // spacer and masquerade as a successful user-scroll release.
    await expect.poll(() => historyScrollState(page)).toEqual({
      pinActive: false,
      stickyBound: true,
      spacerCount: 0,
    });
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
    modelOrkas.finishControlledModelStream();
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  });

  test('keeps a project-created task message list scrollable during streaming', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    await createProject(modelOrkas, 'E2E Streaming Scroll Project');

    await page.locator('#project-chat-input').fill('E2E establish the project-created task.');
    await page.locator('#project-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-history .chat-message.assistant .chat-bubble > :is(.markdown-body, [data-role="final"])')).toContainText(
      'Hello from the local E2E model.',
      { timeout: 20_000 },
    );

    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    modelOrkas.setModelMode('controlled-slow');
    await page.locator('#chat-input').fill('E2E stream the project follow-up while I scroll downward.');
    await page.locator('#chat-input').press('Enter');
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(2);
    modelOrkas.releaseControlledModelChunk();
    await expect.poll(async () => historyScrollState(page)).toMatchObject({
      pinActive: true,
      stickyBound: true,
      spacerCount: 1,
    });

    const history = page.locator('#chat-history');
    await history.hover({ position: { x: 40, y: 80 } });
    await page.mouse.wheel(0, 420);
    await expect.poll(() => historyScrollState(page)).toEqual({
      pinActive: false,
      stickyBound: true,
      spacerCount: 0,
    });
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
    modelOrkas.finishControlledModelStream();
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  });
});
