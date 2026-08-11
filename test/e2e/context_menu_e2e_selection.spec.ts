import { expect, test } from './fixtures/orkas';

async function selectContents(
  locator: import('@playwright/test').Locator,
): Promise<void> {
  await locator.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

test.describe('chat selection context menu', () => {
  test('owns only chat selections and exposes keyboard scratch-edit and copy failure results', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const prompt = 'E2E context menu selection text.';
    modelOrkas.setModelTextReplies(['E2E context menu reply.']);
    await page.locator('#new-chat-input').fill(prompt);
    await page.locator('#new-chat-send-btn').click();
    const bubble = page.locator('#chat-history .chat-message.user').last();
    await expect(bubble).toContainText(prompt);
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText(
      'E2E context menu reply.',
    );
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);

    await selectContents(page.locator('#sidebar-search-btn'));
    await bubble.click({ button: 'right' });
    await expect(page.locator('.context-menu')).toHaveCount(0);

    await selectContents(bubble.locator('.markdown-body'));
    await bubble.click({ button: 'right' });
    const menu = page.locator('.context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.context-menu-item').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('.context-menu-item').nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#chat-md-drawer-panel')).toHaveClass(/\bis-open\b/);
    await expect(page.locator('#chat-md-drawer-body textarea')).toHaveValue(prompt);
    await page.locator('#chat-md-drawer-close').click();

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new Error('clipboard unavailable'); } },
      });
    });
    await selectContents(bubble.locator('.markdown-body'));
    await bubble.click({ button: 'right' });
    await page.locator('.context-menu-item').first().click();
    await expect(page.locator('.ui-toast.is-error')).toContainText('Copy failed');
  });
});
