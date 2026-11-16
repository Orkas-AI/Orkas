import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from './fixtures/orkas';


test('marks unseen canvas content while closed and clears the reminder when opened', async ({ orkas: app }, testInfo) => {
  const page = app.page!;
  const { conversation } = await app.invoke<any>('conversations.create', { title: 'Canvas updates' });
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
  await page.evaluate(async cid => {
    const runtime = window as any;
    await runtime.loadConversations({ fresh: true });
    runtime.setView('conversation', cid);
    await runtime.loadConversationHistory(cid);
    await runtime.VideoCanvas.probe(cid);
  }, cid);
  const toggle = page.locator('#video-canvas-toggle');
  const dot = toggle.locator('.task-unread-dot');
  const panel = page.locator('#video-canvas-panel');
  const refresh = () => page.evaluate(() => (window as any).VideoCanvas.refresh());
  await expect(toggle).toBeVisible();
  await expect(dot).toBeHidden();
  await refresh();
  await expect(dot).toBeHidden();

  const production = path.join(workspace, 'campaign');
  const video = path.join(production, 'videos', 'main');
  mkdirSync(video, { recursive: true });
  const writeVideo = (headline: string) => writeFileSync(path.join(video, 'manifest.json'), JSON.stringify({
    schema_version: 3, id: 'main', label: 'Campaign video',
    canvas: { width: 540, height: 960, fps: 30 },
    scenes: [{ id: 'opening', duration: 3, text: { headline: { value: headline } } }],
  }));
  writeVideo('First result');
  // The existing turn-completion refresh must reveal new work without opening the panel.
  await page.evaluate(cid => (window as any).VideoCanvas.notifyTurnEnd(cid), cid);
  await expect(dot).toBeVisible();
  await expect(panel).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('canvas-unseen.png') });
  await refresh();
  await expect(dot).toBeVisible();
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(dot).toBeHidden();
  await panel.locator('[data-action="scene-open"]').click();
  await expect(panel.locator('[data-commit="text"]')).toHaveValue('First result');

  writeVideo('Changed while open');
  await refresh();
  await expect(panel.locator('[data-commit="text"]')).toHaveValue('Changed while open');
  await expect(dot).toBeHidden();
  await page.locator('#video-canvas-close').click();
  await refresh();
  await expect(dot).toBeHidden();

  // Timestamps, layout preferences and busy state are not new content.
  writeVideo('Changed while open');
  writeFileSync(path.join(production, 'canvas.json'), JSON.stringify({ schema_version: 1, cards: { 'video:main': { x: 40, y: 20 } } }));
  await page.evaluate(async cid => {
    const runtime = window as any;
    runtime.VideoCanvas.notifyBusy(cid, true);
    runtime.VideoCanvas.notifyBusy(cid, false);
    await runtime.VideoCanvas.refresh();
  }, cid);
  await expect(dot).toBeHidden();

  writeVideo('Changed while closed');
  await refresh();
  await expect(dot).toBeVisible();
  await toggle.click();
  await expect(dot).toBeHidden();
  await expect(panel.locator('[data-commit="text"]')).toHaveValue('Changed while closed');
  await page.screenshot({ path: testInfo.outputPath('canvas-seen.png') });
  await page.locator('#video-canvas-close').click();
  await refresh();
  await expect(dot).toBeHidden();

  // A reminder belongs to its conversation, never the next task's toolbar.
  writeVideo('Another result');
  await refresh();
  await expect(dot).toBeVisible();
  const next = await app.invoke<any>('conversations.create', { title: 'Unrelated task' });
  await page.evaluate(async cid => {
    const runtime = window as any;
    runtime.setView('conversation', cid);
    await runtime.loadConversationHistory(cid);
    await runtime.VideoCanvas.probe(cid);
  }, next.conversation.conversation_id);
  await expect(toggle).toBeHidden();
  await expect(dot).toBeHidden();
});
