import { Jimp } from 'jimp';
import { expect, test } from './fixtures/orkas';


test('keeps image selection, bubble, persisted history and model pixels in order for new and existing chats', async ({ modelOrkas }, info) => {
  let page = modelOrkas.page!;
  await page.evaluate(() => (window as any).setLang('en'));
  await page.locator('#new-chat-btn').click();
  const colors = [0xDC2020FF, 0x20B040FF, 0x2040DCFF];
  for (const [turn, prefix] of ['new-chat', 'chat'].entries()) {
    const names = [`z-first-${turn}.png`, `a-second-${turn}.png`, `m-third-${turn}.png`];
    const paths = [];
    for (let index = 0; index < names.length; index += 1) {
      paths.push(modelOrkas.createFixtureFile(names[index], await new Jimp({ width: 32, height: 32, color: colors[index] }).getBuffer('image/png')));
    }
    await modelOrkas.selectFilesOnNextDialog(paths);
    await page.locator(`#${prefix}-attach-btn`).click();
    await expect(page.locator(`#${prefix}-attachments .chat-attach-label`)).toHaveText(names);
    await page.locator(`#${prefix}-input`).fill('Compare the three images in the order I added them.');
    await page.locator(`#${prefix}-send-btn`).click();
    const bubbles = page.locator('#chat-history .chat-message.user');
    await expect(bubbles).toHaveCount(turn + 1);
    await expect(bubbles.nth(turn).locator('.chat-msg-attach .chat-attach-label')).toHaveText(names);
    // Completed history uses the regular message body after hydration, while
    // live replies use a streaming final slot. Count the visible replies in both.
    await expect(page.locator('#chat-history .chat-message.assistant', {
      hasText: 'Hello from the local E2E model.',
    })).toHaveCount(turn + 1);
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(turn + 1);
    const request = modelOrkas.modelRequests[turn] as any;
    // The fixture also projects Responses requests into text-only messages for
    // legacy tests. Inspect the original wire input to verify image bytes.
    const user = [...(request.input || request.messages)].reverse().find((message: any) => message.role === 'user');
    const parts = Array.isArray(user.content) ? user.content : [{ type: 'text', text: user.content }];
    const text = parts.filter((part: any) => ['text', 'input_text'].includes(part.type)).map((part: any) => part.text).join('\n');
    const files = [...text.matchAll(/<file name="([^"]+)"[^>]*image_order="(\d+)"/g)];
    expect(files.map((match) => [match[1], Number(match[2])])).toEqual(names.map((name, index) => [name, index + 1]));
    const images = parts.filter((part: any) => ['image_url', 'input_image'].includes(part.type));
    expect(images).toHaveLength(3);
    for (let index = 0; index < images.length; index += 1) {
      const url = typeof images[index].image_url === 'string' ? images[index].image_url : images[index].image_url.url;
      const decoded = await Jimp.read(Buffer.from(url.split(',')[1], 'base64'));
      const pixel = decoded.getPixelColor(0, 0);
      for (const shift of [24, 16, 8]) expect(Math.abs(((pixel >>> shift) & 255) - ((colors[index] >>> shift) & 255))).toBeLessThan(15);
    }
    await bubbles.nth(turn).screenshot({ path: info.outputPath(`${prefix}-attachment-order.png`) });
  }
  const cid = await page.locator('#conversation-list .conv-item.active').getAttribute('data-cid');
  expect(cid).toBeTruthy();
  page = await modelOrkas.relaunch();
  await page.locator(`#conversation-list .conv-item[data-cid="${cid}"]`).click();
  for (const turn of [0, 1]) {
    await expect(page.locator('#chat-history .chat-message.user').nth(turn).locator('.chat-msg-attach .chat-attach-label'))
      .toHaveText([`z-first-${turn}.png`, `a-second-${turn}.png`, `m-third-${turn}.png`]);
  }
});
