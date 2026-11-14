import { Jimp } from 'jimp';
import { expect, test } from './fixtures/orkas';
import { expectComposerText } from './fixtures/composer';

for (const entry of ['new-chat', 'chat'] as const) {
  test(`pastes images once throughout loading and completion in ${entry}`, async ({ orkas }, info) => {
    const page = orkas.page!;
    let cid = 'main_chat';
    if (entry === 'chat') {
      const created = await orkas.invoke<{ conversation: { conversation_id: string } }>(
        'conversations.create', { title: 'Image paste regression' },
      );
      cid = created.conversation.conversation_id;
      await page.evaluate(async () => (window as any).loadConversations());
      await page.locator(`#conversation-list .conv-item[data-cid="${cid}"]`).click();
    } else {
      await page.locator('#new-chat-btn').click();
    }

    const input = page.locator(`#${entry}-input`);
    const chips = page.locator(`#${entry}-attachments .chat-attach-chip`);
    await input.fill('Keep this draft.');
    // Gate only upload dispatch. Real clipboard events, hashing, chips, IPC,
    // persistence and completion still run through the shipped implementation.
    await page.evaluate(() => {
      const host = window as any;
      const original = host.apiFetch;
      host.__pasteUploads = [];
      host.apiFetch = async (url: string, options: unknown) => {
        if (url.endsWith('/attachments/upload')) {
          await new Promise<void>(resolve => host.__pasteUploads.push(resolve));
        }
        return original(url, options);
      };
      host.__restorePasteUploads = () => {
        host.apiFetch = original;
        for (const release of host.__pasteUploads.splice(0)) release();
      };
    });

    try {
      for (const [batch, colors] of [[0xff3333ff], [0x33aa33ff, 0x3333ffff]].entries()) {
        const images = await Promise.all(colors.map(async color =>
          (await new Jimp({ width: 32, height: 32, color }).getBuffer('image/png')).toString('base64')));
        await input.evaluate((element, payload) => {
          const clipboardData = new DataTransfer();
          payload.images.forEach((bytes, index) => {
            const body = Uint8Array.from(atob(bytes), char => char.charCodeAt(0));
            clipboardData.items.add(new File([body], `pasted-${payload.batch}-${index}.png`, { type: 'image/png' }));
          });
          element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
        }, { images, batch });

        await expect(chips).toHaveCount(colors.length);
        await expect(page.locator(`#${entry}-attachments .chat-attach-chip.is-uploading`)).toHaveCount(colors.length);
        await expect.poll(() => page.evaluate(() => (window as any).__pasteUploads.length)).toBe(colors.length);
        await expectComposerText(input, 'Keep this draft.');
        if (batch === 0) await page.screenshot({ path: info.outputPath(`${entry}-paste-loading.png`) });

        await page.evaluate(() => {
          for (const release of (window as any).__pasteUploads.splice(0)) release();
        });
        await expect(page.locator(`#${entry}-attachments .chat-attach-chip.is-uploading`)).toHaveCount(0);
        await expect(chips).toHaveCount(colors.length);
        const pending = await orkas.invoke<{ items: unknown[] }>('conversations.attachments.list', { cid });
        expect(pending.items).toHaveLength(colors.length);

        for (let remaining = colors.length; remaining > 0; remaining--) {
          await chips.first().locator('.chat-attach-remove').click();
          await expect(chips).toHaveCount(remaining - 1);
        }
        await expect.poll(async () => (await orkas.invoke<{ items: unknown[] }>(
          'conversations.attachments.list', { cid },
        )).items.length).toBe(0);
      }

      await input.press('End');
      await input.evaluate(element => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', ' Plain text still pastes.');
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
      await expectComposerText(input, 'Keep this draft. Plain text still pastes.');
      await expect(chips).toHaveCount(0);
    } finally {
      await page.evaluate(() => (window as any).__restorePasteUploads());
    }
  });
}
