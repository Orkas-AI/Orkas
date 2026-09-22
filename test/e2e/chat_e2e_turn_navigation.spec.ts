import { expect, test } from './fixtures/orkas';

test('tracks the visible conversation turn at the top, in replies, and at the last message', async ({ orkas }) => {
  const page = orkas.page!;
  const { conversation } = await orkas.invoke<any>('conversations.create', { title: 'Turn position' });
  await page.evaluate(async (cid) => {
    const app = window as any;
    await app.loadConversations();
    app.setView('conversation', cid, { skipLoad: true });
    const history = document.getElementById('chat-history')!;
    history.replaceChildren();
    history.style.scrollBehavior = 'auto';
    history.style.overflowAnchor = 'none';
    // Deterministic message sizes exercise real Chromium layout and scrolling.
    for (let turn = 1; turn <= 6; turn++) {
      for (const role of ['user', 'assistant']) {
        const message = document.createElement('div');
        message.className = `chat-message ${role}`;
        message.dataset.msgId = `${role}-${turn}`;
        message.style.cssText = `min-height:${role === 'user' ? 80 : turn === 6 ? 120 : 600}px;flex-shrink:0`;
        message.innerHTML = `<div class="chat-bubble"><div class="markdown-body">${role} ${turn}</div></div>`;
        history.appendChild(message);
      }
    }
    const spacer = document.createElement('div');
    spacer.id = 'position-test-spacer';
    spacer.style.cssText = 'height:500px;flex-shrink:0';
    history.appendChild(spacer);
    app.ConversationTurnNav.prepare(cid);
    await app.ConversationTurnNav.open({ cid, loadPage: async () => ({
      total: 6, next_cursor: null,
      turns: Array.from({ length: 6 }, (_, index) => ({ turn_no: index + 1, message_id: `user-${index + 1}` })),
    }) });
  }, conversation.conversation_id);
  const active = page.locator('#chat-turn-nav [aria-current="location"]');
  const scrollMessage = async (id: string, viewportFraction: number) => {
    await page.evaluate(({ id, viewportFraction }) => {
      const history = document.getElementById('chat-history')!;
      const target = history.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)!;
      history.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
      history.scrollTop += target.getBoundingClientRect().top - history.getBoundingClientRect().top
        - history.clientHeight * viewportFraction;
    }, { id, viewportFraction });
  };

  await scrollMessage('user-3', 0.24);
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-3');
  // The final reply is visible below the reading line, before the scrollbar
  // reaches bottom. Its user prompt need not intersect the old narrow band.
  await scrollMessage('assistant-6', 0.6);
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-6');
  const beforeResize = await page.locator('#chat-history').evaluate((node) => node.scrollTop);
  // Streaming text or an image can grow an earlier reply without any scroll
  // event. Recompute the visible turn without moving the reader's position.
  await page.locator('[data-msg-id="assistant-5"]').evaluate((node: HTMLElement) => { node.style.minHeight = '1200px'; });
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-5');
  expect(await page.locator('#chat-history').evaluate((node) => node.scrollTop)).toBe(beforeResize);
  await page.locator('[data-msg-id="assistant-5"]').evaluate((node: HTMLElement) => { node.style.minHeight = '600px'; });
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-6');
  await scrollMessage('assistant-3', -0.1);
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-3');

  await page.locator('[data-turn-key="m:user-4"]').click();
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-4');
  // Wait across layout/observer frames: centering a clicked turn must not
  // immediately reselect the preceding reply at the reading line.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-4');

  // An explicit jump to bottom must resume tracking even without a wheel.
  await page.evaluate(() => {
    const history = document.getElementById('chat-history')!;
    history.scrollTop = history.scrollHeight;
  });
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-6');

  await scrollMessage('user-1', 0);
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-1');
  await page.evaluate(() => {
    const history = document.getElementById('chat-history')!;
    history.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    history.scrollTop = history.scrollHeight;
  });
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-6');
  // All messages fit: top wins even though the last message is also visible.
  await page.evaluate(() => {
    const history = document.getElementById('chat-history')!;
    history.querySelectorAll<HTMLElement>('.chat-message').forEach((node) => {
      node.style.minHeight = '0';
      node.style.height = '10px';
      node.style.margin = '0';
      node.style.overflow = 'hidden';
    });
    document.getElementById('position-test-spacer')!.remove();
    history.scrollTop = 0;
  });
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-1');
});

test('tracks an older transcript window and retries a failed rail page without treating it as the true beginning or end', async ({ orkas }) => {
  const page = orkas.page!;
  const { conversation } = await orkas.invoke<any>('conversations.create', { title: 'Paged turn position' });
  await page.evaluate(async (cid) => {
    const app = window as any;
    await app.loadConversations();
    app.setView('conversation', cid, { skipLoad: true });
    const history = document.getElementById('chat-history')!;
    history.replaceChildren();
    history.style.scrollBehavior = 'auto';
    for (let turn = 11; turn <= 16; turn++) {
      for (const role of ['user', 'assistant']) {
        const node = document.createElement('div');
        node.className = `chat-message ${role}`;
        node.dataset.msgId = `${role}-${turn}`;
        node.style.cssText = `height:${role === 'user' ? 80 : turn === 16 ? 100 : 600}px;flex-shrink:0`;
        node.innerHTML = `<div class="chat-bubble"><div class="markdown-body">${role} ${turn}</div></div>`;
        history.appendChild(node);
      }
    }
    const spacer = document.createElement('div');
    spacer.style.cssText = 'height:500px;flex-shrink:0';
    history.appendChild(spacer);
    app.turnPageAttempts = [];
    let failOnce = true;
    app.ConversationTurnNav.prepare(cid);
    await app.ConversationTurnNav.open({ cid, loadPage: async (cursor: number | null) => {
      app.turnPageAttempts.push(cursor);
      if (cursor !== null && failOnce) {
        failOnce = false;
        throw new Error('Injected turn page failure');
      }
      const end = cursor ?? 30;
      return {
        total: 30, next_cursor: end === 30 ? 15 : null,
        turns: Array.from({ length: 15 }, (_, index) => ({
          turn_no: end - 14 + index, message_id: `user-${end - 14 + index}`,
        })),
      };
    } });
    history.scrollTop = 0;
  }, conversation.conversation_id);
  const active = page.locator('#chat-turn-nav [aria-current="location"]');
  await expect.poll(() => page.evaluate(() => (window as any).turnPageAttempts)).toEqual([null, 15]);
  await expect(page.locator('#chat-turn-nav .chat-turn-nav-marker')).toHaveCount(15);
  await page.locator('#chat-history').dispatchEvent('wheel', { deltaY: -50 });
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-11');
  await expect.poll(() => page.evaluate(() => (window as any).turnPageAttempts)).toEqual([null, 15, 15]);
  // The last mounted reply is old history. Merely seeing it must not select
  // either that turn or the real newest turn while reading the previous reply.
  await page.evaluate(() => {
    const history = document.getElementById('chat-history')!;
    const target = history.querySelector<HTMLElement>('[data-msg-id="user-16"]')!;
    history.scrollTop += target.getBoundingClientRect().top - history.getBoundingClientRect().top
      - history.clientHeight * 0.55;
  });
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-15');
  // An anchored page may begin partway through a reply, without its question.
  await page.evaluate(() => {
    const history = document.getElementById('chat-history')!;
    history.querySelector('[data-msg-id="user-11"]')!.remove();
    history.scrollTop = 0;
  });
  await expect(active).toHaveAttribute('data-turn-key', 'm:user-11');
});
