import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from './fixtures/orkas';


test('aligns task side panels with the conversation header and keeps one width when switching', async ({ orkas: app }, testInfo) => {
  const page = app.page!;
  const { conversation } = await app.invoke<any>('conversations.create', {
    title: 'Review the video campaign and its detailed production requirements '.repeat(4),
  });
  const cid = conversation.conversation_id;
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
  const enter = () => page.evaluate(async cid => {
    const runtime = window as any;
    await runtime.loadConversations({ fresh: true });
    runtime.setView('conversation', cid);
    await runtime.loadConversationHistory(cid);
    await runtime.VideoCanvas.probe(cid);
  }, cid);
  const details = page.locator('#conversation-info-panel');
  const canvas = page.locator('#video-canvas-panel');
  const alignedHeader = async (bottomSelector: string, topSelector = bottomSelector) => {
    await expect.poll(() => page.evaluate(({ bottomSelector, topSelector }) => {
      const chat = document.getElementById('chat-header')!.getBoundingClientRect();
      const top = document.querySelector(topSelector)!.getBoundingClientRect().top;
      const bottom = document.querySelector(bottomSelector)!.getBoundingClientRect().bottom;
      return Math.max(Math.abs(chat.top - top), Math.abs(chat.bottom - bottom));
    }, { bottomSelector, topSelector })).toBeLessThanOrEqual(1);
  };
  const alignedDetails = () => alignedHeader('.conversation-info-tabs', '.conversation-info-header');
  const switchToCanvas = async () => {
    const before = (await details.boundingBox())!;
    if (page.viewportSize()!.width <= 920) await page.locator('#conversation-info-close').click();
    await page.locator('#video-canvas-toggle').click();
    await expect(details).toBeHidden();
    await expect(canvas).toBeVisible();
    const after = (await canvas.boundingBox())!;
    expect(Math.abs(before.x - after.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(before.width - after.width)).toBeLessThanOrEqual(1);
    await alignedHeader('.video-canvas-header');
  };

  await page.setViewportSize({ width: 1600, height: 900 });
  await enter();
  await page.locator('#conversation-info-toggle').click();
  await expect(details).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('details-default.png') });
  await alignedDetails();
  await switchToCanvas();
  await expect(page.locator('#video-canvas-empty')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('canvas-empty.png') });

  // Resizing either panel must carry over to the other, including after a reload.
  const handle = page.locator('#video-canvas-resize');
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  const resized = (await canvas.boundingBox())!;
  await page.locator('#conversation-info-toggle').click();
  expect((await details.boundingBox())!.width).toBe(resized.width);
  const drag = (await page.locator('#conversation-info-resize').boundingBox())!;
  await page.mouse.move(drag.x + drag.width / 2, drag.y + 100);
  await page.mouse.down();
  await page.mouse.move(drag.x - 80, drag.y + 100, { steps: 4 });
  await page.mouse.up();
  const savedWidth = (await details.boundingBox())!.width;
  await switchToCanvas();
  await page.evaluate(() => localStorage.setItem('orkas.videoCanvas.width', '900'));
  await page.reload();
  await enter();
  await page.evaluate(() => (window as any).ConversationInfo.open());
  expect((await details.boundingBox())!.width).toBe(savedWidth);
  await switchToCanvas();

  // Populated production cards use the same real renderer and IPC, without generating media.
  const video = path.join(workspace, 'campaign', 'videos', 'main');
  mkdirSync(video, { recursive: true });
  writeFileSync(path.join(video, 'manifest.json'), JSON.stringify({
    schema_version: 3, id: 'main', label: 'A long campaign video title '.repeat(8),
    canvas: { width: 540, height: 960, fps: 30 },
    scenes: [{ id: 'opening', duration: 3, text: { headline: { value: 'A bright idea' } } }],
  }));
  await page.evaluate(() => (window as any).VideoCanvas.refresh());
  await expect(page.locator('.video-canvas-card.is-video')).toHaveCount(1);

  for (const [width, height, locale] of [[1600, 900, 'en'], [1000, 640, 'zh'], [900, 600, 'en']] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(locale => (window as any).setLang(locale), locale);
    if (width <= 920) await page.locator('#video-canvas-close').click();
    await page.locator('#conversation-info-toggle').click();
    await alignedDetails();
    await page.screenshot({ path: testInfo.outputPath(`details-${width}-${locale}.png`) });
    await switchToCanvas();
    await expect(page.locator('#video-canvas-close')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`canvas-${width}-${locale}.png`) });
  }

  // Editing the title changes the chat header's natural height without a window resize.
  await page.evaluate(cid => (window as any)._startConversationHeaderRename(cid), cid);
  await expect(page.locator('#chat-header-title-input')).toBeVisible();
  await alignedHeader('.video-canvas-header');
  await page.keyboard.press('Escape');
  await alignedHeader('.video-canvas-header');
  await page.evaluate(() => (window as any).ConversationInfo.open());
  await alignedDetails();
  await page.evaluate(cid => (window as any)._startConversationHeaderRename(cid), cid);
  await alignedDetails();
  await page.keyboard.press('Escape');
  await alignedDetails();
  await switchToCanvas();

  // Multiple productions and the working-state label must still fit the shared top band.
  const secondVideo = path.join(workspace, 'another-campaign', 'videos', 'main');
  mkdirSync(secondVideo, { recursive: true });
  writeFileSync(path.join(secondVideo, 'manifest.json'), JSON.stringify({
    schema_version: 3, id: 'main', label: 'Another video',
    canvas: { width: 540, height: 960, fps: 30 }, scenes: [{ id: 'opening', duration: 3 }],
  }));
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.evaluate(async cid => {
    const runtime = window as any;
    runtime.setLang('zh');
    await runtime.VideoCanvas.refresh();
    runtime.VideoCanvas.notifyBusy(cid, true);
  }, cid);
  await alignedHeader('.video-canvas-header');
  await expect(page.locator('#video-canvas-production')).toBeVisible();
  await expect(page.locator('#video-canvas-status')).toBeVisible();
  expect(await page.locator('.video-canvas-header').evaluate(header => {
    const box = header.getBoundingClientRect();
    return Array.from(header.children).filter(child => !(child as HTMLElement).hidden).every(child => {
      const bounds = child.getBoundingClientRect();
      return bounds.top >= box.top && bounds.bottom <= box.bottom && bounds.right <= box.right;
    });
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('canvas-working-multiple.png') });
});
