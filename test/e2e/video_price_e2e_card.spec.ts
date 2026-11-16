import { expect, test } from './fixtures/orkas';

const VIDEO_STUDIO_ID = '79df9cc89f5f';

test.describe('conversation input form continuity', () => {
  test.describe.configure({ timeout: process.platform === 'win32' ? 300_000 : 120_000 });

  test('keeps an answered card answered when a later card arrives in the same session', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const { page } = modelOrkas;
    const form = (id: string, label: string) => [
      `Which ${id}?`,
      '<agent-input-form>',
      JSON.stringify({ agent_id: VIDEO_STUDIO_ID, fields: [{ id, label, type: 'text', required: true, default: '' }] }),
      '</agent-input-form>',
      '<plan-interaction status="open" />',
    ].join('\n');
    modelOrkas.setModelTextReplies([form('first_answer', 'First question'), form('second_answer', 'Second question'), 'Done.']);
    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-recipient-chip').click();
    await page.locator(`#agent-picker [data-kind="agent"][data-id="${VIDEO_STUDIO_ID}"]`).click();
    await page.keyboard.press('Escape');
    const input = page.locator('#new-chat-input');
    await input.click();
    await page.keyboard.insertText('Ask me two things.');
    await page.locator('#new-chat-send-btn').click();

    const cards = page.locator('#chat-history .chat-input-form');
    await expect(cards).toHaveCount(1, { timeout: 30_000 });
    await cards.first().locator('input[type="text"], textarea').fill('An answer');
    await cards.first().locator('.form-actions .btn-primary').click();
    await expect(cards.first()).toHaveClass(/\bis-submitted\b/);

    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    await expect(cards.last()).not.toHaveClass(/\bis-(submitted|stale)\b/);
    await expect(cards.first()).toHaveClass(/\bis-submitted\b/);
    await expect(cards.first()).not.toHaveClass(/\bis-stale\b/);
  });

});
