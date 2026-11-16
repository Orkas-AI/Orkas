import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/orkas';


// Presentation/reopen coverage; the bus integration cases own failure settlement and no replay.
for (const [language, width] of [['en', 1280], ['zh', 760]] as const) {
  test(`keeps the interrupted video explanation readable with its existing attachment (${language})`, async ({ orkas }, info) => {
    await orkas.invoke('config.setLanguage', { language });
    const { conversation } = await orkas.invoke<{ conversation: { conversation_id: string } }>(
      'conversations.create', { title: 'Interrupted video update' });
    const cid = conversation.conversation_id;
    const production = path.join(orkas.userWorkspaceRoot, 'delivery-notice');
    const sourceRoot = path.resolve(__dirname, '../../src/main');
    const { file, text } = await orkas.electronApp!.evaluate(async (_electron, args) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const fs = req('node:fs'), path = req('node:path');
      const video = path.join(args.production, 'videos', 'main');
      const file = path.join(args.production, 'versions', 'main-v1.mp4');
      fs.mkdirSync(video, { recursive: true }); fs.mkdirSync(path.dirname(file), { recursive: true });
      const { ffmpeg } = req(path.join(args.sourceRoot, 'util/bundled-runtime.ts')).bundledFfmpegPaths();
      await new Promise<void>((resolve, reject) => req('node:child_process').execFile(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=1',
        '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', file,
      ], { timeout: 30_000, windowsHide: true }, (error: Error | null) => error ? reject(error) : resolve()));
      fs.writeFileSync(path.join(args.production, 'versions.json'), JSON.stringify({ versions: [
        { id: 'v1', video_id: 'main', path: 'versions/main-v1.mp4' },
      ] }));
      const manifest = { schema_version: 3, id: 'main', label: 'Before',
        canvas: { width: 160, height: 90, fps: 5 }, scenes: [{ id: 'one', clips: [] }] };
      const manifestFile = path.join(video, 'manifest.json');
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      await req(path.join(args.sourceRoot, 'features/video_timeline_render.ts')).markTimelineDelivered(
        { productionDirAbs: args.production, videoDirAbs: video }, 'v1');
      fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, label: 'After' }));
      const note = await req(path.join(args.sourceRoot, 'features/video_delivery_notice.ts')).interruptedVideoDeliveryNotice({
        produced: [file], allowedRoots: [args.production], lang: args.language,
      });
      const { t } = req(path.join(args.sourceRoot, 'i18n.ts'));
      return { file, text: `${t('model.run_aborted', undefined, args.language)}\n\n${note}` };
    }, { production, sourceRoot, language });
    const history = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`);
    const saved = [
      { id: 'request', from: 'user', to: ['commander'], ts: '2026-11-14T05:00:00Z', text: 'Update the video.' },
      { id: 'interrupted-video', from: 'commander', to: ['user'], ts: '2026-11-14T05:01:00Z', text, produced: [file],
        turn_id: 'video-turn', turn_end: true, source_message_id: 'request', seg: 0 },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    writeFileSync(history, saved);
    const page = await orkas.relaunch();
    await page.setViewportSize({ width, height: 760 });
    await page.locator(`#conversation-list .conv-item[data-cid="${cid}"]`).click();
    const reply = page.locator('#chat-history .chat-message.assistant').filter({ hasText: language === 'zh' ? '已保留交付版本' : 'delivered version v1 is retained' });
    await expect(reply).toHaveCount(1);
    await expect(reply.locator('.chat-bubble > .markdown-body')).toContainText(language === 'zh'
      ? '后续修改尚未包含在该版本中。' : 'Later edits are not included in this version.');
    await expect(reply.getByRole('button', { name: 'main-v1.mp4', exact: true })).toBeVisible();
    await expect.poll(() => reply.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
    await reply.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await expect(reply.locator('.chat-bubble > .markdown-body')).toBeInViewport();
    expect(await reply.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`retained-video-${language}.png`) });
    expect(readFileSync(history, 'utf8')).toBe(saved);
  });
}
