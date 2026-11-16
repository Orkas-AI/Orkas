import { expect, OrkasTestApp, test as base } from './fixtures/orkas';

// History painting intentionally pauses in hidden native windows. This journey
// reopens the actual display and therefore needs an activatable window.
const test = base.extend({
  modelOrkas: async ({}, use, info) => {
    const app = new OrkasTestApp(info, { modelStub: true, nativeWindowVisible: true });
    try { await app.launch(); await use(app); }
    finally { await app.dispose(); }
  },
});

test('renders a visualization reply as an interactive sandboxed preview after streaming and reopening', async ({ modelOrkas: app }, info) => {
  let page = app.page!;
  const file = app.createWorkspaceFile('visualization/时间选择器 preview.html', `<!doctype html>
<meta charset="utf-8"><style>
body { margin: 0; padding: 20px; font: 16px system-ui; color: #161a26; background: #fff; }
button { font: inherit; padding: 8px 12px; } output { margin-left: 12px; }
</style><h1>时间选择器 / Time picker</h1>
<button onclick="document.querySelector('output').textContent = ++window.count">Add / 添加</button><output>0</output>
<script>window.count = 0;</script>`);
  const title = '时间选择器（中文）';
  const marker = `\uE200visualize\uE202${JSON.stringify({ path: file, mode: 'wide', title })}\uE201`;
  app.setModelTextReplies([`UI 已完成。\n\n${marker}\n\n检查结果：预览可以交互。`]);
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill('展示时间选择器的交互预览。');
  await page.locator('#new-chat-send-btn').click();
  let final = page.locator('#chat-history .chat-message.assistant [data-role="final"]').last();
  const frameSelector = '.chat-md-html-embed iframe';
  await expect(final).toContainText('检查结果：预览可以交互。', { timeout: 20_000 });
  await expect(final.locator(frameSelector)).toHaveCount(1);
  await expect(final).not.toContainText('\uE200visualize');
  await expect(final.locator(frameSelector)).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(final.locator(frameSelector)).toHaveAttribute('title', new RegExp(`${title}$`));
  let preview = final.locator(frameSelector).contentFrame();
  await preview.getByRole('button', { name: 'Add / 添加' }).press('Enter');
  await expect(preview.locator('output')).toHaveText('1');
  expect(await preview.locator('body').evaluate(() => ({
    ipc: typeof (window as any).orkas, node: typeof (window as any).require,
  }))).toEqual({ ipc: 'undefined', node: 'undefined' });

  // Inspect real production layout and localized preview labels at normal and
  // narrow sizes. The optional wide mode stays within the chat column.
  for (const [locale, width] of [['zh', 1280], ['en', 900]] as const) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(lang => (window as any).setLang(lang), locale);
    await expect(final.locator(frameSelector)).toBeVisible();
    const bounds = await final.evaluate(element => {
      const frame = element.querySelector('iframe')!.getBoundingClientRect();
      const bubble = element.closest('.chat-bubble')!.getBoundingClientRect();
      return { width: frame.width, height: frame.height, contained: frame.left >= bubble.left && frame.right <= bubble.right };
    });
    expect(bounds.width).toBeGreaterThan(200);
    expect(bounds.height).toBeGreaterThan(100);
    expect(bounds.contained).toBe(true);
    await final.screenshot({ path: info.outputPath(`preview-${locale}-${width}.png`) });
  }

  // currentCid is a classic-script lexical binding, not a window property.
  const cid = await page.evaluate('currentCid');
  expect(typeof cid).toBe('string');
  page = await app.relaunch();
  await page.evaluate(id => (window as any).setView('conversation', id, { forceEnter: true }), cid);
  final = page.locator('#chat-history .chat-message.assistant').filter({ hasText: 'UI 已完成。' }).last();
  await expect(final.locator(frameSelector)).toHaveCount(1);
  await expect(final).not.toContainText('\uE200visualize');
  await expect(final.locator(frameSelector)).toHaveAttribute('title', new RegExp(`${title}$`));
  preview = final.locator(frameSelector).contentFrame();
  await preview.getByRole('button', { name: 'Add / 添加' }).press('Enter');
  await expect(preview.locator('output')).toHaveText('1');
  expect(app.modelRequests).toHaveLength(1);
});
