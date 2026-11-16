import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from './fixtures/orkas';


test('wrapped keyframes keep equal widths across rows and scene durations', async ({ orkas: app }, info) => {
  const page = app.page!;
  const { conversation } = await app.invoke<any>('conversations.create', { title: 'Keyframe layout with a long video title' });
  const cid = conversation.conversation_id as string;
  const workspace = await app.electronApp!.evaluate(async (_electron, args) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    await require(args.chats).bumpConversationActivity('account-e2e', args.cid, new Date().toISOString(), {
      senderKind: 'agent', senderId: '79df9cc89f5f',
    });
    return require(args.workspace).getConversationWorkspacePath('account-e2e', args.cid);
  }, {
    cid,
    chats: path.resolve(__dirname, '../../src/main/features/chats.ts'),
    workspace: path.resolve(__dirname, '../../src/main/features/group_chat/conv_workspace.ts'),
  });
  const folder = path.join(workspace, 'campaign', 'videos', 'main');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
    schema_version: 3, id: 'main', label: 'Keyframe layout with a long video title',
    canvas: { width: 540, height: 960, fps: 30 },
    scenes: [8, 17.2, 19.2, 19.2, 19.4, 11].map((duration, index) => ({
      id: `scene-${index + 1}`, duration, text: { headline: { value: `Scene ${index + 1}` } },
    })),
  }));
  await page.evaluate(async cid => {
    const runtime = window as any;
    await runtime.loadConversations({ fresh: true });
    runtime.setView('conversation', cid);
    await runtime.loadConversationHistory(cid);
    await runtime.VideoCanvas.probe(cid);
  }, cid);
  await page.locator('#video-canvas-toggle').click();
  const card = page.locator('.video-canvas-card.is-video');
  const chips = card.locator('.video-canvas-chip[data-scene]');
  await expect(chips).toHaveCount(6);
  const nativeWindow = await app.electronApp!.browserWindow(page);

  for (const [width, height, lang] of [[1600, 900, 'zh'], [900, 700, 'en'], [1280, 800, 'pt']] as const) {
    await nativeWindow.evaluate((win, size) => win.setContentSize(size[0], size[1]), [width, height]);
    await page.evaluate(lang => (window as any).setLang(lang), lang);
    await page.locator('#video-canvas-zoom-fit').click();
    await chips.last().click();
    await expect(chips.last()).toHaveAttribute('aria-pressed', 'true');
    const boxes = await chips.evaluateAll(elements => elements.map(el => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width };
    }));
    // The reported defect needs a partial second row; compare geometry, not CSS declarations.
    expect(boxes[5].y).toBeGreaterThan(boxes[0].y);
    expect(Math.max(...boxes.map(box => box.width)) - Math.min(...boxes.map(box => box.width))).toBeLessThan(0.5);
    expect(Math.abs(boxes[5].x - boxes[0].x)).toBeLessThan(0.5);
    await expect(card.locator('[data-action="scene-add"]')).toBeVisible();
    await card.screenshot({ path: info.outputPath(`keyframes-${lang}-${width}.png`) });
    await chips.last().click();
  }
});
