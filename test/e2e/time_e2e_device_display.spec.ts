import { expect, test } from './fixtures/orkas';

test('renders device-local message dates in the real app', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  const cdp = await page.context().newCDPSession(page);
  const instant = '2030-01-01T00:30:00Z';
  const created = await orkas.invoke<{ conversation: { conversation_id: string } }>(
    'conversations.create', { title: 'Device time display' },
  );
  await page.evaluate(async () => (window as any).loadConversations());
  await page.locator(`#conversation-list .conv-item[data-cid="${created.conversation.conversation_id}"]`).click();

  for (const [zone, wall, lang, width] of [
    ['America/New_York', '2029-12-31 19:30', 'en', 1440],
    ['Asia/Kathmandu', '2030-01-01 06:15', 'zh', 1024],
  ] as const) {
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: zone });
    await page.setViewportSize({ width, height: 720 });
    await page.evaluate(async ({ lang, instant }) => {
      await (window as any).setLang(lang);
      (window as any).setView('chat');
      document.getElementById('chat-history')!.replaceChildren();
      for (const role of ['user', 'assistant']) {
        (window as any).appendChatMessage({ role, content: 'Device-local time verification', time: instant }, false, { archive: false });
      }
    }, { lang, instant });
    await expect(page.locator('#chat-history .chat-msg-time')).toHaveText([wall, wall]);
    await page.screenshot({ path: testInfo.outputPath(`messages-${lang}.png`) });

  }
  await cdp.detach();
});
