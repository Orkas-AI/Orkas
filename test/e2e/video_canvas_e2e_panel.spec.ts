import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Locator } from '@playwright/test';

import { composerText, expectComposerText } from './fixtures/composer';
import { expect, OrkasTestApp, test } from './fixtures/orkas';

// The video canvas in the real app: a conversation made through the composer, a production on
// disk where the tools would write it, the real IPC and workspace mapping, media served over
// chat-media://local, and changes that come back as new versions from the real renderer.

const LONG_TITLE = 'A portable desk lamp with a very long campaign name that will not fit on one line of its card';

const PAGE = `<!doctype html>
<html><head><meta charset="UTF-8">
<style>
html, body { width: 540px; height: 960px; margin: 0; overflow: hidden; background: #123; color: #fff; font: 700 48px sans-serif; }
section { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; }
</style></head>
<body><main data-composition-id="main" style="position: relative; width: 100%; height: 100%; overflow: hidden">
  <section data-scene-id="hook"><h1 data-slot="headline">placeholder</h1></section>
  <section data-scene-id="price"><h1 data-slot="amount">placeholder</h1></section>
  <section data-scene-id="close"></section>
</main></body></html>
`;

type Seed = { production: string; versionsDir: string };

function seedProduction(workspace: string): Seed {
  const production = path.join(workspace, 'ad');
  const video = path.join(production, 'videos', 'main');
  mkdirSync(video, { recursive: true });
  mkdirSync(path.join(production, 'media'), { recursive: true });
  mkdirSync(path.join(production, 'gen'), { recursive: true });
  mkdirSync(path.join(production, 'versions'), { recursive: true });
  writeFileSync(path.join(video, 'index.html'), PAGE);
  writeFileSync(path.join(video, 'manifest.json'), JSON.stringify({
    schema_version: 3,
    id: 'main',
    label: LONG_TITLE,
    canvas: { width: 540, height: 960, fps: 30 },
    scenes: [
      { id: 'hook', clips: [{ id: 'hook-clip', asset: 'pour-2', in: 0, dur: 1 }], text: { headline: { value: 'A bright idea' } } },
      { id: 'price', duration: 1, text: { amount: { fact_id: 'price' } } },
      { id: 'close', clips: [{ id: 'close-clip', asset: 'photo', in: 0, dur: 1 }] },
    ],
  }));
  writeFileSync(path.join(production, 'assets.json'), JSON.stringify({ assets: [
    { id: 'photo', kind: 'image', label: 'Front photo.png', path: 'media/photo.png', origin: 'upload' },
    { id: 'spare', kind: 'image', label: 'Side photo.png', path: 'media/spare.png', origin: 'upload' },
    { id: 'phone', kind: 'video', label: 'Phone clip.mp4', path: 'media/phone.mp4', origin: 'upload' },
    { id: 'pour-1', kind: 'video', label: 'Lamp turning on', path: 'gen/pour-1.mp4', origin: 'generated', shot: 'pour', prompt: 'first take', refs: [{ asset: 'photo', role: 'reference' }] },
    { id: 'pour-2', kind: 'video', label: 'Lamp turning on', path: 'gen/pour-2.mp4', origin: 'generated', shot: 'pour', prompt: 'second take', refs: [{ asset: 'photo', role: 'reference' }], model: 'doubao/doubao-seedance-2-0-260128', request: { prompt: 'second take', duration: 5 } },
  ] }));
  writeFileSync(path.join(production, 'product.json'), JSON.stringify({
    name: 'Desk lamp',
    facts: [
      { id: 'price', text: '$29', source: 'page' },
      { id: 'claim', text: 'Lasts ten years', source: 'unverified' },
    ],
    images: ['photo'],
  }));
  writeFileSync(path.join(production, 'versions.json'), JSON.stringify({ versions: [{
    id: 'v1',
    video_id: 'main',
    path: 'versions/main-v1.mp4',
    sha256: 'e2e',
    duration_sec: 3,
    canvas: '540x960',
    fps: 30,
    integrated_lufs: null,
    shipped_at: '2026-11-05T00:00:00Z',
    warnings: [],
  }] }));
  return { production, versionsDir: path.join(production, 'versions') };
}

/** The seeded production's pictures and clips, made by the bundled FFmpeg the renderer also uses. */
async function encodeSeedMedia(app: OrkasTestApp, production: string): Promise<void> {
  await app.electronApp!.evaluate(async (_electron, args) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const { ffmpeg } = require(args.module).bundledFfmpegPaths();
    if (!ffmpeg) throw new Error('Bundled FFmpeg is required for this fixture');
    const encode = (argv: string[]) => new Promise<void>((resolve, reject) => {
      require('node:child_process').execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...argv],
        { windowsHide: true, timeout: 60000 }, (error: Error | null) => error ? reject(error) : resolve());
    });
    const clip = (file: string, source: string, seconds: number) => encode([
      '-f', 'lavfi', '-i', `${source}=s=540x960:r=30:d=${seconds}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-threads', '1', file,
    ]);
    const still = (file: string, source: string) => encode(['-f', 'lavfi', '-i', `${source}=s=540x720:r=1:d=1`, '-frames:v', '1', file]);
    await still(`${args.dir}/media/photo.png`, 'testsrc2');
    await still(`${args.dir}/media/spare.png`, 'smptebars');
    await clip(`${args.dir}/media/phone.mp4`, 'testsrc', 2);
    await clip(`${args.dir}/gen/pour-1.mp4`, 'testsrc2', 1);
    await clip(`${args.dir}/gen/pour-2.mp4`, 'smptehdbars', 1);
    await clip(`${args.dir}/versions/main-v1.mp4`, 'testsrc2', 3);
  }, { module: path.resolve(__dirname, '../../src/main/util/bundled-runtime.ts'), dir: production.split(path.sep).join('/') });
}

test.describe('video canvas', () => {
  test.describe.configure({ timeout: process.platform === 'win32' ? 300_000 : 180_000 });

  test('shows a production as cards, and changes it without a model', async ({ modelOrkas }, testInfo) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const { page } = modelOrkas;
    const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

    // A real conversation through the composer and the local model.
    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill('Prepare the video canvas e2e conversation.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]'))
      .toBeVisible({ timeout: 30_000 });
    const cid = String(await page.evaluate('currentCid'));
    await expect(page.locator('#video-canvas-toggle')).toBeHidden();

    // Freeze the workspace so the seeded production lands where this conversation looks.
    const stateFile = path.join(modelOrkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', cid, 'state.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    state.workspace_dir = 'e2e-video-canvas';
    writeFileSync(stateFile, JSON.stringify(state), 'utf8');
    const workspace = path.join(modelOrkas.workspaceRoot, '..', 'userWorkSpace', 'e2e-video-canvas');
    const { production } = seedProduction(workspace);
    await encodeSeedMedia(modelOrkas, production);

    // The toggle appears once there is something to show, and opens the canvas.
    // Files alone are not enough: a chat VideoStudio never joined shows nothing, because a
    // workspace folder can repeat between conversations that have produced nothing yet.
    await page.evaluate('VideoCanvas.probe(currentCid)');
    const toggle = page.locator('#video-canvas-toggle');
    await expect(toggle).toBeHidden();
    await modelOrkas.electronApp!.evaluate(async (_electron, args) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      await require(args.module).bumpConversationActivity(args.uid, args.cid, new Date().toISOString(), { senderKind: 'agent', senderId: '79df9cc89f5f' });
    }, { module: path.resolve(__dirname, '../../src/main/features/chats.ts'), uid: 'account-e2e', cid });
    await page.evaluate('VideoCanvas.probe(currentCid)');
    await expect(toggle).toBeVisible();
    await page.setViewportSize({ width: 1600, height: 960 });
    await toggle.click();
    const panel = page.locator('#video-canvas-panel');
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveClass(/\bis-active\b/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#conversation-info-panel')).toBeHidden();

    // Footage, shots and videos, in columns, with audio on no card.
    const assetCards = page.locator('.video-canvas-card.is-asset');
    const shotCards = page.locator('.video-canvas-card.is-shot');
    const videoCard = page.locator('.video-canvas-card.is-video');
    await expect(assetCards).toHaveCount(3);
    await expect(shotCards).toHaveCount(1);
    await expect(videoCard).toHaveCount(1);
    // Each card names its kind; the columns have no caption that a moved card would leave behind.
    await expect(assetCards.first().locator('.video-canvas-card-kind')).toHaveText('Reference');
    await expect(shotCards.first().locator('.video-canvas-card-kind')).toHaveText('Shot 01');
    await expect(videoCard.locator('.video-canvas-card-kind')).toHaveText('Final video');
    await expect(page.locator('.video-canvas-column-caption')).toHaveCount(0);
    const columnsLeftToRight = async () => {
      const asset = (await assetCards.first().boundingBox())!;
      const one = (await shotCards.first().boundingBox())!;
      const video = (await videoCard.boundingBox())!;
      return asset.x < one.x && one.x < video.x;
    };
    expect(await columnsLeftToRight()).toBe(true);

    // Media really loads: a broken URL leaves an <img> visible with no picture.
    await expect.poll(() => assetCards.first().locator('img').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const player = videoCard.locator('video.video-canvas-player');
    await expect(player).toHaveAttribute('src', /main-v1\.mp4/);
    await expect.poll(() => player.evaluate((el) => (el as HTMLVideoElement).readyState)).toBeGreaterThan(0);
    // The header offers no menu for making another video.
    await expect(page.locator('.video-canvas-header').getByRole('button', { name: 'Make another' })).toHaveCount(0);
    await shot('canvas-populated');

    // Selecting a card draws what it was made from and what uses it, and nothing is stored.
    await page.keyboard.press('Escape');
    await expect(page.locator('#video-canvas-lines path')).toHaveCount(0);
    await shotCards.first().locator('.video-canvas-card-title').click();
    await expect(shotCards.first()).toHaveClass(/\bis-selected\b/);
    await expect(page.locator('#video-canvas-lines path')).toHaveCount(2);
    await expect(videoCard).toHaveClass(/\bis-related\b/);
    await shot('canvas-selected');

    // A shot flips through its results.
    await expect(shotCards.first().locator('.video-canvas-shot-pager')).toContainText('2/2');
    await shotCards.first().locator('[data-action="shot-page"]').first().click();
    await expect(shotCards.first().locator('.video-canvas-shot-pager')).toContainText('1/2');
    await shotCards.first().locator('[data-action="shot-page"]').last().click();

    // Selected, a shot shows how the result on its card was made, under the card (decided
    // 2026-11-09): what it was made from, its words, and the button that makes it again.
    const manifestFile = path.join(production, 'videos', 'main', 'manifest.json');
    const manifest = () => JSON.parse(readFileSync(manifestFile, 'utf8'));
    const versionCount = () => (JSON.parse(readFileSync(path.join(production, 'versions.json'), 'utf8')).versions as unknown[]).length;
    const takePanel = page.locator('.video-canvas-take-panel');
    await expect(takePanel).toBeVisible();
    const cardBox = (await shotCards.first().boundingBox())!;
    const panelBox = (await takePanel.boundingBox())!;
    expect(panelBox.y).toBeGreaterThan(cardBox.y + cardBox.height - 2);
    await expect(takePanel.locator('.video-canvas-take-ref')).toHaveCount(1);
    await expect(takePanel.locator('textarea')).toHaveValue('second take');
    await expect(takePanel.locator('[data-action="take-generate"]')).toBeVisible();
    await expect(takePanel).toContainText('This result is in the videos');
    await shot('canvas-take-panel');
    // An older result has no call on record: its words show, and it can go back into the video,
    // which then waits for the user's Update instead of rendering.
    await shotCards.first().locator('[data-action="shot-page"]').first().click();
    await expect(takePanel.locator('textarea')).toHaveValue('first take');
    await expect(takePanel.locator('[data-action="take-generate"]')).toHaveCount(0);
    await expect(takePanel).toContainText('no recorded request');
    await takePanel.locator('[data-action="take-use"]').click();
    await expect.poll(() => manifest().scenes[0].clips[0].asset).toBe('pour-1');
    await expect(videoCard.locator('[data-action="render"]')).toBeVisible();
    expect(versionCount()).toBe(1);
    await shotCards.first().locator('[data-action="shot-page"]').last().click();
    await takePanel.locator('[data-action="take-use"]').click();
    await expect.poll(() => manifest().scenes[0].clips[0].asset).toBe('pour-2');
    expect(versionCount()).toBe(1);
    // Back on the take it went out with, it is the video that went out: Update, always on its
    // card, renders nothing and says so (decided 2026-11-11).
    await expect(videoCard.locator('.video-canvas-status-row')).toHaveCount(0);
    await videoCard.locator('[data-action="render"]').click();
    await expect(page.locator('.ui-toast', { hasText: 'This video is already up to date.' })).toBeVisible();
    await shot('canvas-video-up-to-date');
    expect(versionCount()).toBe(1);
    // A reference selects its card, and the panel goes with the shot's selection.
    await takePanel.locator('.video-canvas-take-ref').first().click();
    await expect(page.locator('.video-canvas-card[data-card="asset:photo"]')).toHaveClass(/\bis-selected\b/);
    await expect(takePanel).toBeHidden();

    // Pan and zoom move the view, not the cards.
    const worldTransform = () => page.locator('#video-canvas-world').evaluate((el) => (el as HTMLElement).style.transform);
    const before = await worldTransform();
    const viewportBox = (await page.locator('#video-canvas-viewport').boundingBox())!;
    await page.mouse.move(viewportBox.x + viewportBox.width - 60, viewportBox.y + 40);
    await page.mouse.wheel(0, 60);
    await expect.poll(worldTransform).not.toBe(before);
    await page.locator('#video-canvas-zoom-in').click();
    await expect(page.locator('#video-canvas-zoom-label')).not.toHaveText('100%');
    await page.locator('#video-canvas-zoom-fit').click();

    // Dragging a card moves it, and the position survives closing the panel.
    const dragged = assetCards.nth(1);
    const from = (await dragged.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 30, from.y + from.height / 2 + 200, { steps: 5 });
    await page.mouse.up();
    const canvasFile = path.join(production, 'canvas.json');
    await expect.poll(() => existsSync(canvasFile)).toBe(true);
    const saved = JSON.parse(readFileSync(canvasFile, 'utf8')) as { cards: Record<string, { x: number; y: number }> };
    expect(Object.keys(saved.cards)).toEqual([await dragged.getAttribute('data-card')]);
    await page.locator('#video-canvas-close').click();
    await expect(panel).toBeHidden();
    await toggle.click();
    await expect(panel).toBeVisible();
    const moved = (await dragged.boundingBox())!;
    expect(Math.abs(moved.y - (from.y + 200))).toBeLessThan(40);

    // Opening a scene shows a form for its words, and the change lands on disk with no
    // confirmation. The page itself is never written.
    const pageBefore = readFileSync(path.join(production, 'videos', 'main', 'index.html'), 'utf8');
    /** The change came back from the real renderer as one more version, now on the card. */
    const expectNewVersion = async (count: number) => {
      await expect.poll(versionCount, { timeout: 120_000 }).toBe(count);
      await expect(player).toHaveAttribute('src', new RegExp(`main-v${count}\\.mp4`), { timeout: 10_000 });
    };
    const chips = videoCard.locator('.video-canvas-chip[data-scene]');
    await expect(chips).toHaveCount(3);
    const openScene = async (index: number) => {
      // Opening refreshes asynchronously; hidden chips still describe the previous visit.
      await expect(panel).toBeVisible();
      if (await chips.nth(index).getAttribute('aria-pressed') !== 'true') await chips.nth(index).click();
    };
    await openScene(0);
    const editor = videoCard.locator('.video-canvas-editor');
    await expect(editor).toBeVisible();
    await shot('canvas-editor');

    // From a scene, "Generate again" opens its shot's panel at the result the scene shows. Generate
    // waits for the words to change, and Escape puts them back (2026-11-12: unchanged words made
    // the same request again). With no price to show, generating says so rather than guessing, and
    // asks for nothing.
    await editor.locator('[data-action="scene-regenerate"]').click();
    await expect(shotCards.first()).toHaveClass(/\bis-selected\b/);
    await expect(takePanel).toBeVisible();
    await expect(takePanel.locator('textarea')).toBeFocused();
    const generateAgain = takePanel.locator('[data-action="take-generate"]');
    await expect(generateAgain).toBeDisabled();
    await page.keyboard.type(' warmer');
    await expect(generateAgain).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(takePanel.locator('textarea')).toHaveValue('second take');
    await expect(generateAgain).toBeDisabled();
    await takePanel.locator('textarea').focus();
    await page.keyboard.type(' warmer');
    await generateAgain.click();
    await expect(page.locator('.ui-toast', { hasText: 'That model is no longer available' })).toBeVisible();
    await expect(page.locator('.ui-dialog-overlay.open')).toHaveCount(0);

    // A configured-service confirmation belongs to its original task. Only the services, availability and
    // dispatch are stubbed; navigation, dialog, model menu and canvas are real.
    const otherDuringPrice = await modelOrkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Unrelated pricing task' });
    await modelOrkas.electronApp!.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers?.get('orkas.invoke');
      if (typeof original !== 'function') throw new Error('Native IPC fixture seam unavailable');
      const control = { pending: false, calls: [] as unknown[], restore: () => {
        ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', original);
      } };
      ipcMain.removeHandler('orkas.invoke');
      ipcMain.handle('orkas.invoke', (event, request) => {
        if (request?.channel === 'videoCanvas.redoOptions') {
          return { ok: true, current: 'doubao', choices: [
            { id: 'doubao', name: 'Doubao Seedance 2.0', params: { duration: 5, audio: true } },
            { id: 'h3', name: 'MiniMax H3 Lite', params: { resolution: '768p', duration: 5, audio: true } },
            { id: 'vidu', name: 'Vidu Q3 Turbo', params: { duration: 5, audio: true }, unavailable: { code: 'images', max: 0 } },
            // A take that opens or ends on given frames (decided 2026-11-10).
            { id: 'omni', name: 'Google Gemini Omni 1.1 Flash', params: { audio: true }, unavailable: { code: 'frames' } },
            { id: 'runway', name: 'Runway Gen-4.5', params: { duration: 5, audio: true }, unavailable: { code: 'last_frame' } },
            { id: 'wan', name: 'Alibaba Cloud Wan 3.0', params: { duration: 5, audio: true }, unavailable: { code: 'frames_with_references' } },
          ] };
        }
        if (request?.channel === 'videoCanvas.quoteRedo') return control.pending ? {ok:false,code:'in_progress'} : {ok:true,sufficient:true,own_key:true,external_billing_estimate_available:false};
        if (request?.channel === 'videoCanvas.redo') { control.calls.push(request); return { ok: true }; }
        return original(event, request);
      });
      (globalThis as any).__canvasPriceControl = control;
    });
    const pickModel = async (name: string) => {
      await takePanel.locator('.video-canvas-take-model .ai-select-trigger').click();
      await page.locator('.ai-select-item', { hasText: name }).click();
    };
    const openTake = async () => {
      await page.evaluate(id => (window as any).setView('conversation', id), cid);
      if (!await panel.isVisible()) await toggle.click();
      await expect(panel).toBeVisible();
      await shotCards.first().locator('.video-canvas-card-title').click();
      await expect(takePanel.locator('.video-canvas-take-model .ai-select-trigger')).toContainText('Doubao Seedance 2.0');
    };
    try {
      await modelOrkas.electronApp!.evaluate(()=>{(globalThis as any).__canvasPriceControl.pending=true;});
      await page.evaluate(id=>(window as any).setView('conversation',id),otherDuringPrice.conversation.conversation_id);
      await openTake();
      await expect(takePanel).toContainText('The last request has no confirmed result yet');
      await expect(takePanel.locator('textarea')).toHaveAttribute('readonly','');
      await expect(takePanel.locator('[data-action="take-generate"]')).toBeDisabled();
      expect(await modelOrkas.electronApp!.evaluate(()=>(globalThis as any).__canvasPriceControl.calls)).toEqual([]);
      await modelOrkas.electronApp!.evaluate(()=>{(globalThis as any).__canvasPriceControl.pending=false;});

      // Leaving and coming back forgets what the panel learned, so the stubbed services show.
      await page.evaluate(id => (window as any).setView('conversation', id), otherDuringPrice.conversation.conversation_id);
      await openTake();
      await expect(takePanel).toContainText('5s · Sound');
      // Generate names no price (2026-11-12), and with nothing changed there is nothing to make.
      await expect(takePanel.locator('[data-action="take-generate"]')).toHaveText('Generate');
      await expect(takePanel.locator('[data-action="take-generate"]')).toBeDisabled();
      await takePanel.locator('.video-canvas-take-model .ai-select-trigger').click();
      await expect(page.locator('.ai-select-item', { hasText: 'Vidu Q3 Turbo' })).toContainText("can't use reference images");
      await expect(page.locator('.ai-select-item', { hasText: 'Google Gemini Omni 1.1 Flash' })).toContainText("This model can't use first or last frames");
      await expect(page.locator('.ai-select-item', { hasText: 'Runway Gen-4.5' })).toContainText('This model takes a first frame only');
      await expect(page.locator('.ai-select-item', { hasText: 'Alibaba Cloud Wan 3.0' })).toContainText("This model can't use frames with references");
      await shot('canvas-take-models');
      // An open menu outlives the panel redrawing around it, as when an Agent starts and stops.
      // While it works the service locks with the rest of the panel (2026-11-10: it stayed open).
      await page.evaluate('VideoCanvas.notifyBusy(currentCid, true)');
      await expect(takePanel.locator('.video-canvas-take-model .ai-select-trigger')).toBeDisabled();
      await expect(takePanel.locator('[data-action="gen-settings"]')).toBeDisabled();
      await page.evaluate('VideoCanvas.notifyBusy(currentCid, false)');
      await expect(page.locator('.ai-select-item', { hasText: 'MiniMax H3 Lite' })).toBeVisible();
      await page.locator('.ai-select-item', { hasText: 'MiniMax H3 Lite' }).click();
      await expect(takePanel).toContainText('768p · 5s · Sound');
      await takePanel.locator('textarea').fill('third take, closer');
      await takePanel.locator('[data-action="take-generate"]').click();
      const dialog = page.locator('.ui-dialog-overlay.open');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('your own service account');
      await expect(dialog).toContainText('replaces this one in the videos');
      await page.evaluate(id => (window as any).setView('conversation', id), otherDuringPrice.conversation.conversation_id);
      await page.locator('.ui-dialog-overlay.open [data-act="ok"]').click();
      await expect(page.locator('.ui-dialog-overlay.open')).toHaveCount(0);
      expect(await modelOrkas.electronApp!.evaluate(() => (globalThis as any).__canvasPriceControl.calls)).toEqual([]);
      // A fresh confirmation in the original task sends the words and service shown, once.
      await openTake();
      await pickModel('MiniMax H3 Lite');
      await takePanel.locator('textarea').fill('third take, closer');
      await takePanel.locator('[data-action="take-generate"]').click();
      await expect(page.locator('.ui-dialog-overlay.open')).toBeVisible();
      await page.locator('.ui-dialog-overlay.open [data-act="ok"]').click();
      const dispatched = await modelOrkas.electronApp!.evaluate(() => (globalThis as any).__canvasPriceControl.calls);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].payload).toEqual({ cid, dir: 'ad', asset: 'pour-2', prompt: 'third take, closer', choice: 'h3' });
      // So it does while the take is being made.
      const takeEvent = { cid: String(await page.evaluate('currentCid')), dir: 'ad', kind: 'redo', shot: await shotCards.first().getAttribute('data-card'), phase: 'generate' };
      const pushTake = (status: string) => modelOrkas.electronApp!.evaluate(({ BrowserWindow }, event) => {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('conversations:video-canvas-job', event);
      }, { ...takeEvent, status });
      const takeModel = takePanel.locator('.video-canvas-take-model .ai-select-trigger');
      await expect(takeModel).toBeEnabled();
      await pushTake('running');
      await expect(takeModel).toBeDisabled();
      await expect(takePanel.locator('[data-action="gen-settings"]')).toBeDisabled();
      await pushTake('stopped');
      await expect(takeModel).toBeEnabled();
    } finally {
      await modelOrkas.electronApp!.evaluate(() => (globalThis as any).__canvasPriceControl.restore());
    }
    await page.locator('#video-canvas-viewport').focus();
    await page.keyboard.press('Escape');
    await expect(takePanel).toBeHidden();
    await openScene(0);

    const words = editor.locator('input[data-commit="text"]');
    await expect(words).toHaveValue('A bright idea');
    await words.fill('Light your desk');
    await page.keyboard.press('Enter');
    await expect.poll(() => manifest().scenes[0].text.headline.value).toBe('Light your desk');

    // The change waits for the user's Update, as a product fact does (decided 2026-11-09), and
    // nothing says the video is behind: Update stays on its card (decided 2026-11-11).
    const update = videoCard.locator('[data-action="render"]');
    const waiting = async (versions: number) => {
      // Nothing on the card waits for the change's own read, so read once more: an older read
      // landing later would otherwise undo what the next step sets up.
      await page.evaluate('VideoCanvas.refresh()');
      await expect(videoCard.locator('.video-canvas-status-row')).toHaveCount(0);
      await expect(update).toBeEnabled();
      expect(versionCount()).toBe(versions);
    };
    await waiting(1);
    await update.click();
    await expect(videoCard.locator('.video-canvas-status-row .video-canvas-pill.is-running')).toBeVisible();
    await expect(update).toBeDisabled();
    await shot('canvas-updating');
    await expectNewVersion(2);
    // Updated again with nothing changed since, it renders nothing. A toast stays a few seconds,
    // so an earlier one with the same words has to go before the next can be told apart.
    const upToDate = page.locator('.ui-toast', { hasText: 'This video is already up to date.' });
    const updateUnchanged = async (versions: number) => {
      await expect(upToDate).toHaveCount(0);
      await expect(update).toBeEnabled();
      await update.click();
      await expect(upToDate).toBeVisible();
      expect(versionCount()).toBe(versions);
    };
    await updateUnchanged(2);
    expect(existsSync(path.join(production, 'versions', 'main-v2.mp4'))).toBe(true);
    expect(readFileSync(path.join(production, 'videos', 'main', 'index.html'), 'utf8')).toBe(pageBefore);

    // Scene frames from the delivered video now stand in for the scenes.
    await expect.poll(() => chips.nth(1).locator('img').count()).toBe(1);
    await expect.poll(() => chips.nth(1).locator('img').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    // Reordering from the keyboard path, by dragging a chip, and new footage on a scene all wait,
    // and one Update puts them in one version.
    await editor.locator('[data-action="scene-move"]').nth(1).click();
    await expect.poll(() => manifest().scenes.map((scene: { id: string }) => scene.id)).toEqual(['price', 'hook', 'close']);
    await waiting(2);

    // Reordering by dragging a chip.
    const lastChip = (await chips.last().boundingBox())!;
    const firstChip = (await chips.first().boundingBox())!;
    await page.mouse.move(lastChip.x + lastChip.width / 2, lastChip.y + lastChip.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstChip.x + 2, firstChip.y + firstChip.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => manifest().scenes.map((scene: { id: string }) => scene.id)).toEqual(['close', 'price', 'hook']);
    await waiting(2);

    // Dragging footage onto a scene changes its picture; the card goes back where it was.
    const source = page.locator('.video-canvas-card[data-card="asset:spare"]');
    const sourceBox = (await source.boundingBox())!;
    const target = (await chips.first().boundingBox())!;
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    await expect(chips.first()).toHaveClass(/\bis-drop-target\b/);
    await shot('canvas-drop-target');
    await page.mouse.up();
    await expect.poll(() => manifest().scenes[0].clips[0].asset).toBe('spare');
    expect(manifest().scenes[0].clips[0].id).toBe('close-clip');
    const after = (await source.boundingBox())!;
    expect(Math.abs(after.x - sourceBox.x)).toBeLessThan(2);
    expect(Math.abs(after.y - sourceBox.y)).toBeLessThan(2);
    await waiting(2);
    await update.click();
    await expectNewVersion(3);

    // Removing a scene with a page section renders with that section hidden, once updated.
    await openScene(2);
    await editor.locator('[data-action="scene-remove"]').click();
    await expect.poll(() => manifest().scenes.map((scene: { id: string }) => scene.id)).toEqual(['close', 'price']);
    await expect(chips).toHaveCount(2);
    await waiting(3);

    // A scene taken out goes back as it was from the "+" at the end (decided 2026-11-11). The
    // video is then the one that went out, so Update has nothing to render.
    await videoCard.locator('[data-action="scene-add"]').click();
    const putBack = page.locator('.context-menu-item').first();
    await expect(putBack).toHaveText('Put back: scene 3 · 1s · Light your desk');
    await expect(putBack.locator('.ui-icon.is-undo')).toHaveCount(1);
    await shot('canvas-put-back');
    await putBack.click();
    await expect.poll(() => manifest().scenes.map((scene: { id: string }) => scene.id)).toEqual(['close', 'price', 'hook']);
    await expect(chips).toHaveCount(3);
    await waiting(3);
    await updateUnchanged(3);
    await videoCard.locator('[data-action="scene-add"]').click();
    await expect(page.locator('.context-menu-item', { hasText: 'Put back' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    // Taken out again for what follows.
    await openScene(2);
    await editor.locator('[data-action="scene-remove"]').click();
    await expect.poll(() => manifest().scenes.map((scene: { id: string }) => scene.id)).toEqual(['close', 'price']);
    await expect(chips).toHaveCount(2);

    // Adding a scene from the ledger.
    await videoCard.locator('[data-action="scene-add"]').click();
    await page.locator('.context-menu-item', { hasText: 'Phone clip.mp4' }).click();
    await expect.poll(() => manifest().scenes.at(-1).clips?.[0]?.asset).toBe('phone');
    await expect(chips).toHaveCount(3);
    await waiting(3);
    await update.click();
    await expectNewVersion(4);

    // The product is a card among the footage (decided 2026-11-09): what the Agent writes the
    // videos from. Every fact is changed there, and a change waits until the user updates a
    // video, which the Agent then does, since only it can say the new facts in its own words.
    const productCard = page.locator('.video-canvas-card[data-card="product"]');
    const productFile = path.join(production, 'product.json');
    const factFields = productCard.locator('.video-canvas-fact input');
    const priceField = factFields.first();
    await expect(productCard).toBeVisible();
    await expect(productCard.locator('.video-canvas-card-title')).toHaveText('Desk lamp');
    await expect(factFields).toHaveCount(2);
    await expect(priceField).toHaveValue('$29');
    await expect(factFields.nth(1)).toHaveValue('Lasts ten years');
    await expect(productCard.locator('.video-canvas-pill')).toHaveCount(1);
    await expect(productCard).toContainText('the Agent changes the parts that mention it');
    await expect(productCard.locator('[data-action="fact-add"]')).toHaveCount(0);
    await shot('canvas-product');
    await page.keyboard.press('Escape');
    await productCard.locator('.video-canvas-card-title').click();
    await expect(productCard).toHaveClass(/\bis-selected\b/);
    await expect(page.locator('#video-canvas-lines path')).toHaveCount(2);
    await expect(videoCard).toHaveClass(/\bis-related\b/);
    await expect(page.locator('.video-canvas-card[data-card="asset:photo"]')).toHaveClass(/\bis-related\b/);
    // A fact no scene quotes changes like one that is quoted, and both wait for an update.
    await factFields.nth(1).fill('Lasts twelve years');
    await page.keyboard.press('Enter');
    await expect.poll(() => JSON.parse(readFileSync(productFile, 'utf8')).facts[1].text).toBe('Lasts twelve years');
    await priceField.fill('$19');
    await page.keyboard.press('Enter');
    await expect.poll(() => JSON.parse(readFileSync(productFile, 'utf8')).facts[0].text).toBe('$19');
    await waiting(4);

    // Its update goes to VideoStudio as the user's message, naming what changed; nothing renders.
    await page.evaluate(() => {
      const w = window as any;
      const send = w.sendInConversation;
      w.__canvasSends = [];
      w.sendInConversation = (target: string, content: string, ...rest: unknown[]) => {
        w.__canvasSends.push(content);
        return send(target, content, ...rest);
      };
    });
    const sentToAgent = async () => (await page.evaluate(() => (window as any).__canvasSends)) as string[];
    await update.click();
    await expect.poll(async () => (await sentToAgent()).length).toBe(1);
    expect((await sentToAgent())[0]).toBe([
      `@VideoStudio The product info changed. Please update the video "${LONG_TITLE}":`,
      '- "$29" is now "$19"',
      '- "Lasts ten years" is now "Lasts twelve years"',
      "Where the on-screen text or narration says these, change it in the video's own wording and format, adding or changing only what changed; leave everything else as it is.",
    ].join('\n'));
    await expect(page.locator('#chat-history .chat-message.user').last()).toContainText('The product info changed');
    // This model only says hello; the Agent's delivery is what takes the change in.
    await expect.poll(async()=> (await modelOrkas.invoke<{busy:boolean}>('videoCanvas.read',{cid})).busy,{timeout:30000}).toBe(false);
    await expect(page.locator('#chat-history .chat-message.assistant', { hasText: 'Hello from the local E2E model' }).last()).toBeVisible();
    await expect(panel).not.toHaveClass(/\bis-read-only\b/, { timeout: 30_000 });
    expect(versionCount()).toBe(4);
    await modelOrkas.electronApp!.evaluate(async (_electron, args) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      await require(args.module).markTimelineDelivered({ productionDirAbs: args.production, videoDirAbs: args.video });
    }, {
      module: path.resolve(__dirname, '../../src/main/features/video_timeline_render.ts'),
      production,
      video: path.join(production, 'videos', 'main'),
    });
    await page.evaluate('VideoCanvas.refresh()');
    await expect(videoCard.locator('.video-canvas-status-row')).toHaveCount(0);

    // A change made during an update stops it: the card lets go of the progress, the stopped
    // update leaves no outcome of its own, and the next one is timed from its own start.
    const canvasCid = String(await page.evaluate('currentCid'));
    const pushJob = (status: string) => modelOrkas.electronApp!.evaluate(({ BrowserWindow }, event) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('conversations:video-canvas-job', event);
    }, { cid: canvasCid, dir: 'ad', video_id: 'main', kind: 'render', status, phase: 'render' });
    await pushJob('running');
    await expect(videoCard.locator('.video-canvas-status-row .video-canvas-pill.is-running')).toBeVisible();
    await page.waitForTimeout(1500);
    await pushJob('stopped');
    await expect(videoCard.locator('.video-canvas-status-row')).toHaveCount(0);
    await pushJob('running');
    await pushJob('done');
    await expect(videoCard.locator('.video-canvas-status-row')).toHaveCount(0);

    // In a scene, words that quote the product change there like any others (decided 2026-11-11):
    // they become that scene's own words, the product card keeps its fact, and the video waits.
    await openScene(1);
    const quoted = editor.locator('input[data-commit="text"]');
    await expect(quoted).toHaveValue('$19');
    await expect(editor.locator('[data-action="product-show"]')).toHaveCount(0);
    await quoted.fill('Only $19');
    await page.keyboard.press('Enter');
    await expect.poll(() => manifest().scenes.find((scene: { id: string }) => scene.id === 'price').text.amount).toEqual({ value: 'Only $19' });
    expect(JSON.parse(readFileSync(productFile, 'utf8')).facts[0].text).toBe('$19');
    await expect(priceField).toHaveValue('$19');
    await waiting(4);
    await shot('canvas-editor-quoted');

    // Hold an actual turn: an authoritative read must also see it running.
    // A renderer-only busy event is cleared by the next Main read when no Agent works.
    const requestsBeforeBusy = modelOrkas.modelRequests.length;
    modelOrkas.setModelMode('controlled-slow');
    await page.evaluate(cid => { void (window as any).sendInConversation(cid,
      'Keep this local fixture turn running while the canvas is inspected.'); }, cid);
    try {
      await expect.poll(sentToAgent).toEqual([
        (await sentToAgent())[0],
        'Keep this local fixture turn running while the canvas is inspected.',
      ]);
      await expect.poll(() => modelOrkas.modelRequests.length, { timeout: 30_000 }).toBe(requestsBeforeBusy + 1);
      await expect.poll(async () => (await modelOrkas.invoke<{ busy: boolean }>('videoCanvas.read', { cid })).busy).toBe(true);
      await expect(panel).toHaveClass(/\bis-read-only\b/);
      await expect(page.locator('#video-canvas-status')).toBeVisible();
      await expect(priceField).toBeDisabled();
      await expect(factFields.nth(1)).toBeDisabled();
      await shot('canvas-read-only');
      // A canonical refresh must preserve the restriction for the still-running task.
      await page.evaluate('VideoCanvas.refresh()');
      await shotCards.first().locator('.video-canvas-card-title').click();
      await expect(takePanel.locator('[data-action="take-generate"]')).toBeDisabled();
      await expect(takePanel.locator('textarea')).toHaveAttribute('readonly', '');
      await page.keyboard.press('Escape');
    } finally {
      modelOrkas.releaseControlledModelChunk();
      modelOrkas.finishControlledModelStream();
      modelOrkas.setModelMode('success');
    }
    await expect.poll(async () => (await modelOrkas.invoke<{ busy: boolean }>('videoCanvas.read', { cid })).busy).toBe(false);
    await expect(panel).not.toHaveClass(/\bis-read-only\b/);
    expect(modelOrkas.modelRequests).toHaveLength(requestsBeforeBusy + 1);

    // Telling the Agent fills the composer and sends nothing.
    const messagesBefore = await page.locator('#chat-history .chat-message').count();
    await openScene(0);
    await editor.locator('[data-action="scene-say"]').click();
    const composer = page.locator('#chat-input');
    await expectComposerText(composer, /close/);
    await expectComposerText(composer, new RegExp(LONG_TITLE.slice(0, 20)));
    // Another version is one ask, written by the user in the composer, with the canvas's footage
    // and shots listed under it, one per line, to delete what should not be used (decided
    // 2026-11-11). The caret waits on the ask.
    const askedLines = async () => (await composerText(composer)).split('\n').filter((line) => line.trim());
    await videoCard.locator('.video-canvas-card-menu').click();
    await expect(page.locator('.context-menu-item')).toHaveText(['Another version', 'Tell the Agent']);
    await page.locator('.context-menu-item', { hasText: 'Another version' }).click();
    const listed = [
      'Use this footage and these shots:',
      '- Footage "Front photo.png"',
      '- Footage "Side photo.png"',
      '- Footage "Phone clip.mp4"',
      '- Shot "Lamp turning on"',
    ];
    expect((await askedLines()).slice(1)).toEqual([`Make another version of "${LONG_TITLE}":`, ...listed]);
    await expect(composer).toBeFocused();
    await page.keyboard.type(' shorter');
    expect((await askedLines()).slice(1, 3)).toEqual([`Make another version of "${LONG_TITLE}": shorter`, listed[0]]);
    expect(await page.locator('#chat-history .chat-message').count()).toBe(messagesBefore);

    // An older version plays without changing anything, and the newest comes back.
    const versionSelect = videoCard.locator('[data-version-select] .ai-select-trigger');
    await versionSelect.click();
    await page.locator('.ai-select-item', { hasText: /^v1$/ }).click();
    await expect(player).toHaveAttribute('src', /main-v1\.mp4/);
    await versionSelect.click();
    await page.locator('.ai-select-item').first().click();
    await expect(player).toHaveAttribute('src', /main-v4\.mp4/);

    // Download saves a copy where the user chooses.
    const savedCopy = path.join(workspace, 'saved-copy.mp4');
    await modelOrkas.electronApp!.evaluate(({ dialog }, file) => {
      (dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, savedCopy);
    await videoCard.locator('[data-action="version-save"]').click();
    await expect.poll(() => existsSync(savedCopy)).toBe(true);
    expect(readFileSync(savedCopy).equals(readFileSync(path.join(production, 'versions', 'main-v4.mp4')))).toBe(true);

    // A card opens in the shared viewer.
    const preview = await modelOrkas.openPreview(() => page.locator('.video-canvas-card[data-card="asset:phone"] .video-canvas-media').dblclick());
    await expect(preview.locator('.chat-file-viewer-video')).toHaveAttribute('src', /phone\.mp4/);
    await modelOrkas.closePreview(preview);

    // Replacing footage from a file changes every scene using it and drops the old row.
    const replacement = path.join(workspace, 'new-photo.png');
    writeFileSync(replacement, readFileSync(path.join(production, 'media', 'spare.png')));
    await page.locator('.video-canvas-card[data-card="asset:phone"]').hover();
    await page.locator('.video-canvas-card[data-card="asset:phone"] .video-canvas-card-menu').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.context-menu-item', { hasText: 'Replace' }).click();
    await (await chooser).setFiles(replacement);
    await expect.poll(() => manifest().scenes.at(-1).clips?.[0]?.asset).toBe('new-photo');
    await expect(page.locator('.video-canvas-card[data-card="asset:phone"]')).toHaveCount(0);
    await expect(page.locator('.video-canvas-card[data-card="asset:new-photo"]')).toHaveCount(1);
    await waiting(4);
    await update.click();
    await expectNewVersion(5);

    // A used asset refuses to go, and says why.
    await page.locator('.video-canvas-card[data-card="asset:new-photo"]').hover();
    await page.locator('.video-canvas-card[data-card="asset:new-photo"] .video-canvas-card-menu').click();
    await page.locator('.context-menu-item.is-danger').click();
    await expect(page.locator('.ui-toast', { hasText: 'still uses' })).toBeVisible();
    await expect(page.locator('.video-canvas-card[data-card="asset:new-photo"]')).toHaveCount(1);

    // An unused one goes, and its file stays.
    await page.locator('.video-canvas-card[data-card="asset:photo"]').hover();
    await page.locator('.video-canvas-card[data-card="asset:photo"] .video-canvas-card-menu').click();
    await page.locator('.context-menu-item.is-danger').click();
    await expect(page.locator('.video-canvas-card[data-card="asset:photo"]')).toHaveCount(0);
    expect(existsSync(path.join(production, 'media', 'photo.png'))).toBe(true);

    // Removing a generated result asks first. Cancelled, it stays.
    const shotCard = page.locator('.video-canvas-card[data-card="shot:pour"]');
    await shotCard.locator('[data-action="shot-page"]').first().click();
    await shotCard.hover();
    await shotCard.locator('.video-canvas-card-menu').click();
    await page.locator('.context-menu-item.is-danger').click();
    const dialog = page.locator('.ui-dialog-danger');
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-act="cancel"]').click();
    await expect(shotCard.locator('.video-canvas-shot-pager')).toContainText('1/2');
    await shotCard.locator('[data-action="shot-page"]').last().click();

    // In another language the words follow, and a long title stays on its card.
    await page.evaluate(() => (window as any).setLang('zh'));
    await expect(assetCards.first().locator('.video-canvas-card-kind')).toHaveText('参考素材');
    await expect(page.locator('#video-canvas-title')).toHaveText('视频画布');
    await expect(productCard.locator('.video-canvas-card-kind')).toHaveText('商品');
    await expect(productCard).toContainText('改了以后，在视频上点「更新视频」，智能体会改视频里相关的地方');
    await openScene(1);
    await shot('canvas-chinese');
    await shotCards.first().locator('.video-canvas-card-title').click();
    await expect(takePanel.locator('[data-action="take-generate"]')).toContainText('生成');
    await expect(takePanel).toContainText('提示词');
    await shot('canvas-take-panel-chinese');
    await page.keyboard.press('Escape');
    await expect(page.locator('.video-canvas-header').getByRole('button', { name: '再做一条' })).toHaveCount(0);
    await videoCard.hover();
    await videoCard.locator('.video-canvas-card-menu').click();
    await expect(page.locator('.context-menu-item')).toHaveText(['再做一版', '告诉智能体']);
    await page.keyboard.press('Escape');
    await expect(page.locator('.context-menu-item')).toHaveCount(0);
    await page.evaluate(() => (window as any).setLang('en'));
    await expect(assetCards.first().locator('.video-canvas-card-kind')).toHaveText('Reference');

    // A short and narrow window still works, with nothing cut off from reach.
    await page.setViewportSize({ width: 1000, height: 640 });
    await page.locator('#video-canvas-zoom-fit').click();
    await shot('canvas-narrow');
    await page.setViewportSize({ width: 1600, height: 960 });

    // Another conversation never shows this one's canvas.
    const nextTask = await modelOrkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Another task' });
    await page.evaluate((id) => (window as any).setView('conversation', id), nextTask.conversation.conversation_id);
    await expect(panel).toBeHidden();
    await expect(toggle).toBeHidden();

    // With nothing made yet it offers a place to start, and a template only fills the composer.
    await page.evaluate('VideoCanvas.open(currentCid)');
    await expect(panel).toBeVisible();
    const empty = page.locator('#video-canvas-empty');
    await expect(empty).toBeVisible();
    await expect(page.locator('.video-canvas-card[data-card="product"]')).toHaveCount(0);
    await expect(page.locator('#video-canvas-zoom')).toBeHidden();
    await page.evaluate(() => (window as any).setLang('zh'));
    await expect(panel).toBeVisible();
    await expect(empty).toBeVisible();
    await page.evaluate(() => (window as any).setLang('en'));
    await expect(panel).toBeVisible();
    await shot('canvas-empty');
    await empty.locator('[data-action="template"]').first().click();
    await expectComposerText(page.locator('#chat-input'), /unboxing/i);

    // Back on the first task, a fact changed on the card drawn on the earlier visit still saves,
    // and its update goes to the Agent.
    await page.evaluate((id) => (window as any).setView('conversation', id), cid);
    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveClass(/\bis-read-only\b/);
    await priceField.fill('$17');
    await page.keyboard.press('Enter');
    await expect.poll(() => JSON.parse(readFileSync(productFile, 'utf8')).facts[0].text).toBe('$17');
    await waiting(5);
    await update.click();
    await expect.poll(async () => (await sentToAgent()).length).toBe(3);
    expect((await sentToAgent())[2].split('\n').slice(1, -1)).toEqual(['- "$19" is now "$17"']);
    expect(versionCount()).toBe(5);
    // Wait for this handoff to finish before opening a menu that snapshots read-only state.
    await expect.poll(async()=> (await modelOrkas.invoke<{busy:boolean}>('videoCanvas.read',{cid})).busy,{timeout:30000}).toBe(false);

    // A right-click on open board uploads footage as a drop would (decided 2026-11-11); a card
    // keeps its own right-click, and while an Agent works the upload is off.
    await expect(panel).not.toHaveClass(/\bis-read-only\b/, { timeout: 30_000 });
    // A spot on the board with no card, panel or control over it.
    const openBoardPoint = () => page.evaluate(() => {
      const board = document.getElementById('video-canvas-viewport')!.getBoundingClientRect();
      for (let y = board.top + 24; y < board.bottom - 64; y += 24) {
        for (let x = board.left + 24; x < board.right - 24; x += 24) {
          if (document.elementFromPoint(x, y)?.id === 'video-canvas-viewport') return { x, y };
        }
      }
      throw new Error('no open board');
    });
    const uploads = ['top-view.png', 'back-view.png'].map((name) => path.join(workspace, name));
    for (const file of uploads) writeFileSync(file, readFileSync(path.join(production, 'media', 'spare.png')));
    const footageBefore = await assetCards.count();
    let spot = await openBoardPoint();
    await page.mouse.click(spot.x, spot.y, { button: 'right' });
    const uploadChooser = page.waitForEvent('filechooser');
    await page.locator('.context-menu-item', { hasText: 'Upload footage' }).click();
    const picker = await uploadChooser;
    expect(picker.isMultiple()).toBe(true);
    await picker.setFiles(uploads);
    await expect(assetCards).toHaveCount(footageBefore + 2);
    await expect(assetCards.filter({ hasText: 'top-view.png' })).toHaveCount(1);
    await expect(assetCards.filter({ hasText: 'back-view.png' })).toHaveCount(1);
    await assetCards.filter({ hasText: 'top-view.png' }).click({ button: 'right' });
    await expect(page.locator('.context-menu')).toHaveCount(0);
    // Open board also asks for another version, as a video's menu does, and the footage just
    // uploaded is listed with the rest (decided 2026-11-11).
    await page.evaluate(() => {
      const input = document.getElementById('chat-input');
      (window as any).composerSetText(input, '');
      (window as any).composerNotify(input);
    });
    spot = await openBoardPoint();
    await page.mouse.click(spot.x, spot.y, { button: 'right' });
    await expect(page.locator('.context-menu-item')).toHaveText(['Upload footage', 'Another version of the video']);
    await shot('canvas-board-menu');
    await page.locator('.context-menu-item', { hasText: 'Another version of the video' }).click();
    await expect(composer).toBeFocused();
    await shot('canvas-another-version');
    const fromBoard = await askedLines();
    expect(fromBoard.slice(0, 2)).toEqual([`Make another version of "${LONG_TITLE}":`, 'Use this footage and these shots:']);
    expect(fromBoard).toEqual(expect.arrayContaining(['- Footage "top-view.png"', '- Footage "back-view.png"', '- Shot "Lamp turning on"']));
    expect(fromBoard.filter((line) => line.startsWith('- Footage ')).length).toBe(await assetCards.count());
    expect(fromBoard.filter((line) => line.startsWith('- Shot ')).length).toBe(await shotCards.count());
    await page.evaluate('VideoCanvas.notifyBusy(currentCid, true)');
    await expect(panel).toHaveClass(/\bis-read-only\b/);
    spot = await openBoardPoint();
    await page.mouse.click(spot.x, spot.y, { button: 'right' });
    // While an Agent works, asking for another version only fills the composer, so it stays.
    await expect(page.locator('.context-menu-item')).toHaveText(['Upload footage', 'Another version of the video']);
    await expect(page.locator('.context-menu-item').first()).toBeDisabled();
    await expect(page.locator('.context-menu-item').last()).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page.locator('.context-menu')).toHaveCount(0);
    await page.evaluate('VideoCanvas.notifyBusy(currentCid, false)');
  });

  // Decided 2026-11-10 (plan 27.20), as TapNow does: footage joins a shot in its panel, by
  // reference or as the frames it opens and ends on, and a line drawn from a card's "+" makes a
  // new shot. Only the services, availability and dispatch are stubbed: the new shots are saved
  // through the real IPC to canvas.json, and a finished one leaves the real ledger row and layout.
  test('adds footage to a shot in its panel, and draws a new shot from a card', async ({ modelOrkas }, testInfo) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const { page } = modelOrkas;
    const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill('Prepare the new shot canvas e2e conversation.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]'))
      .toBeVisible({ timeout: 30_000 });
    const cid = String(await page.evaluate('currentCid'));
    const stateFile = path.join(modelOrkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', cid, 'state.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    state.workspace_dir = 'e2e-video-canvas-new-shot';
    writeFileSync(stateFile, JSON.stringify(state), 'utf8');
    const { production } = seedProduction(path.join(modelOrkas.workspaceRoot, '..', 'userWorkSpace', 'e2e-video-canvas-new-shot'));
    await encodeSeedMedia(modelOrkas, production);
    await modelOrkas.electronApp!.evaluate(async (_electron, args) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      await require(args.module).bumpConversationActivity(args.uid, args.cid, new Date().toISOString(), { senderKind: 'agent', senderId: '79df9cc89f5f' });
    }, { module: path.resolve(__dirname, '../../src/main/features/chats.ts'), uid: 'account-e2e', cid });
    await page.evaluate('VideoCanvas.probe(currentCid)');
    await page.setViewportSize({ width: 1600, height: 960 });
    const toggle = page.locator('#video-canvas-toggle');
    await toggle.click();
    const panel = page.locator('#video-canvas-panel');
    await expect(panel).toBeVisible();

    const canvasFile = path.join(production, 'canvas.json');
    const drafts = () => (existsSync(canvasFile)
      ? Object.entries((JSON.parse(readFileSync(canvasFile, 'utf8')) as { drafts?: Record<string, Record<string, unknown>> }).drafts ?? {})
      : []);
    await modelOrkas.electronApp!.evaluate(({ ipcMain }, args) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const fs = require('node:fs');
      const nodePath = require('node:path');
      const original = (ipcMain as any)._invokeHandlers?.get('orkas.invoke');
      if (typeof original !== 'function') throw new Error('Native IPC fixture seam unavailable');
      // A channel can be held, so the test sees what the panel shows while it waits.
      const held = new Map<string, { wait: Promise<void>; release: () => void }>();
      const control = {
        calls: [] as unknown[],
        restore: () => {
          ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', original);
        },
        hold: (channel: string) => {
          let release = () => {};
          const wait = new Promise<void>((resolve) => { release = resolve; });
          held.set(channel, { wait, release });
        },
        release: (channel: string) => {
          held.get(channel)?.release();
          held.delete(channel);
        },
      };
      const pass = async (channel: string) => { await held.get(channel)?.wait; };
      const doubao = (extra: Record<string, unknown>) => ({ id: 'doubao', name: 'Doubao Seedance 2.0', frames: 'first_last', ...extra });
      const omni = (extra: Record<string, unknown>) => ({ id: 'omni', name: 'Google Gemini Omni 1.1 Flash', frames: 'none', ...extra });
      const price = {ok:true,sufficient:true,own_key:true,external_billing_estimate_available:false};
      ipcMain.removeHandler('orkas.invoke');
      ipcMain.handle('orkas.invoke', async (event, request) => {
        const channel = request?.channel;
        const payload = request?.payload ?? {};
        if (channel === 'videoCanvas.redoOptions') {
          control.calls.push(request);
          const added: string[] = payload.inputs?.added ?? [];
          const method = payload.inputs?.method ?? 'references';
          const fit = 1 + added.length <= 2 && !added.includes('phone');
          // What each service makes, at the settings asked (plan 27.21); Omni cannot leave sound out.
          const asked = payload.settings ?? {};
          return { ok: true, current: 'doubao', method, frames_fit: fit, choices: [
            doubao({
              ratios: ['16:9', '9:16'], resolutions: ['720p', '1080p'], durations: [5, 10], silent: true,
              params: { ratio: asked.ratio ?? '9:16', resolution: asked.resolution ?? '720p', duration: asked.duration ?? 5, audio: asked.audio ?? true },
              ...(method === 'frames' && !fit ? { unavailable: { code: 'frames_inputs' } } : {}),
            }),
            omni({
              ratios: ['16:9', '9:16'], resolutions: ['720p'], durations: [], silent: false,
              params: { ratio: asked.ratio ?? '9:16', resolution: '720p', audio: true },
              ...(method === 'frames' ? { unavailable: { code: 'frames' } } : {}),
            }),
          ] };
        }
        if (channel === 'videoCanvas.quoteRedo' || channel === 'videoCanvas.quoteDraft') {
          await pass(channel);
          return price;
        }
        if (channel === 'videoCanvas.redo') {
          control.calls.push(request);
          await pass(channel);
          return { ok: true };
        }
        if (channel === 'videoCanvas.draftOptions') {
          const draft = JSON.parse(fs.readFileSync(nodePath.join(args.production, 'canvas.json'), 'utf8')).drafts?.[payload.id];
          if (!draft) return { ok: false, code: 'not_found' };
          if (draft.kind === 'image') return { ok: true, kind: 'image', choices: [], current: '' };
          const framed = draft.method === 'frames';
          const ratios = framed ? ['adaptive', '16:9', '9:16'] : ['16:9', '9:16'];
          const ratio = ratios.includes(draft.ratio) ? draft.ratio : framed ? 'adaptive' : '9:16';
          const duration = draft.duration === 10 ? 10 : 5;
          const resolution = draft.resolution === '1080p' ? '1080p' : '720p';
          return { ok: true, kind: 'video', method: draft.method, frames_fit: true, current: 'doubao', choices: [
            doubao({ ratios, resolutions: ['720p', '1080p'], durations: [5, 10], silent: true, params: { ratio, resolution, duration, audio: draft.audio === true } }),
          ] };
        }
        if (channel === 'videoCanvas.generateDraft') {
          control.calls.push(request);
          await pass(channel);
          // What a finished new shot leaves: its shot on the ledger, and its card in the new shot's place.
          const ledgerFile = nodePath.join(args.production, 'assets.json');
          const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
          ledger.assets.push({ id: 'made', kind: 'video', label: 'A lamp slowly tur', path: 'gen/pour-1.mp4', origin: 'generated', shot: payload.id, request: { prompt: 'A lamp slowly turns on' } });
          fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
          await require(args.canvas).settleVideoCanvasDraft(args.production, payload.id);
          require(args.ipc).broadcastToRenderer('conversations:video-canvas-job', {
            dir: 'ad', kind: 'new_shot', status: 'done', shot: `draft:${payload.id}`, added_refs: 2, cid: payload.cid, asset_id: 'made',
          });
          return { ok: true };
        }
        return original(event, request);
      });
      (globalThis as any).__canvasInputsControl = control;
    }, {
      production,
      canvas: path.resolve(__dirname, '../../src/main/features/video_canvas.ts'),
      ipc: path.resolve(__dirname, '../../src/main/ipc/index.ts'),
    });
    const calls = async (channel: string) => (await modelOrkas.electronApp!.evaluate(() => (globalThis as any).__canvasInputsControl.calls) as Array<{ channel: string; payload: Record<string, unknown> }>)
      .filter((call) => call.channel === channel);
    const hold = (channel: string) => modelOrkas.electronApp!.evaluate((_electron, name) => (globalThis as any).__canvasInputsControl.hold(name), channel);
    const release = (channel: string) => modelOrkas.electronApp!.evaluate((_electron, name) => (globalThis as any).__canvasInputsControl.release(name), channel);
    // Where a button sits, to see that a new label does not move it to another row.
    const rowOf = async (locator: Locator) => Math.round((await locator.boundingBox())!.y);

    try {
      // A shot's own footage stays; what the user adds can be taken out again.
      const shotCard = page.locator('.video-canvas-card.is-shot').first();
      const takePanel = page.locator('.video-canvas-take-panel');
      await shotCard.locator('.video-canvas-card-title').click();
      await expect(takePanel.locator('.video-canvas-take-model .ai-select-trigger')).toContainText('Doubao Seedance 2.0');
      await expect(takePanel.locator('.video-canvas-take-ref')).toHaveCount(1);
      await expect(takePanel.locator('.video-canvas-take-remove')).toHaveCount(0);
      // How it is made sums up on the bar's settings button, which opens the settings (plan 27.21).
      const settings = takePanel.locator('[data-action="gen-settings"]');
      const popover = page.locator('#video-canvas-settings');
      const pick = (setting: string, value: string) => popover.locator(`[data-setting="${setting}"][data-value="${value}"]`);
      await expect(settings).toHaveText('References · 9:16 · 720p · 5s · Sound');
      await expect(settings).toHaveAttribute('aria-label', 'Generation settings');
      // In full, on a row of its own above the model, with Generate at the end of the model's row
      // (2026-11-10: beside the model, both were cut short).
      const shownInFull = () => settings.locator('.ai-select-label').evaluate((el) => el.scrollWidth <= el.clientWidth);
      expect(await shownInFull()).toBe(true);
      const settingsBox = (await settings.boundingBox())!;
      const modelBox = (await takePanel.locator('.video-canvas-take-model').boundingBox())!;
      const generateBox = (await takePanel.locator('[data-action="take-generate"]').boundingBox())!;
      expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(modelBox.y);
      expect(Math.abs((generateBox.y + generateBox.height / 2) - (modelBox.y + modelBox.height / 2))).toBeLessThanOrEqual(2);
      expect(generateBox.x).toBeGreaterThan(modelBox.x + modelBox.width);
      const add = takePanel.locator('[data-action="input-add"]');
      await expect(add).toHaveAttribute('aria-label', 'Add references');
      await add.click();
      // The canvas's pictures not used yet, images and videos alike.
      await expect(page.locator('.context-menu-item')).toHaveText(['Side photo.png', 'Phone clip.mp4']);
      await page.locator('.context-menu-item', { hasText: 'Side photo.png' }).click();
      await expect(takePanel.locator('.video-canvas-take-ref')).toHaveCount(2);
      await expect(takePanel.locator('.video-canvas-take-remove')).toHaveCount(1);
      await expect(takePanel.locator('.video-canvas-take-remove')).toHaveAttribute('aria-label', 'Remove Side photo.png');

      // Frames open and end the video on its inputs, by order, and two fill it.
      await settings.click();
      await expect(popover).toBeVisible();
      await expect(settings).toHaveAttribute('aria-expanded', 'true');
      await expect(popover.locator('.video-canvas-settings-title > span')).toHaveText(['Generation method', 'Aspect ratio', 'Resolution', 'Duration', 'Sound']);
      await pick('method', 'frames').click();
      await expect(takePanel.locator('.video-canvas-take-ref-role')).toHaveText(['First frame', 'Last frame']);
      await expect(pick('method', 'frames')).toHaveAttribute('aria-pressed', 'true');
      await expect(add).toHaveCount(0);
      // Escape closes the settings first, and the panel stays.
      await page.keyboard.press('Escape');
      await expect(popover).toBeHidden();
      await expect(takePanel).toBeVisible();
      await expect(settings).toBeFocused();
      await expect(takePanel.locator('.video-canvas-take-model .ai-select-trigger')).toContainText('Doubao Seedance 2.0');
      await takePanel.locator('.video-canvas-take-model .ai-select-trigger').click();
      await expect(page.locator('.ai-select-item', { hasText: 'Google Gemini Omni 1.1 Flash' })).toContainText("This model can't use first or last frames");
      await page.keyboard.press('Escape');
      await shot('canvas-take-frames');

      // A video among the inputs leaves frames out of reach, and says why.
      await settings.click();
      await pick('method', 'references').click();
      await expect(takePanel.locator('.video-canvas-take-ref-role')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await add.click();
      await page.locator('.context-menu-item', { hasText: 'Phone clip.mp4' }).click();
      await expect(takePanel.locator('.video-canvas-take-ref')).toHaveCount(3);
      await settings.click();
      await expect(pick('method', 'frames')).toBeDisabled();
      await expect(popover.locator('.video-canvas-settings-note')).toHaveText(['Frames take one or two images']);
      // Its explanation shows on hover, over the settings; Escape takes it first.
      await popover.locator('[data-hint="method"]').hover();
      const hint = page.locator('#video-canvas-hint');
      await expect(hint).toHaveText('References: the footage guides the shot and the model composes it. First and last frames: the video opens on the first image and ends on the second.');
      await shot('canvas-take-settings');
      await page.keyboard.press('Escape');
      await expect(hint).toBeHidden();
      await expect(popover).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(popover).toBeHidden();
      await takePanel.locator('.video-canvas-take-remove[aria-label="Remove Phone clip.mp4"]').click();
      await expect(takePanel.locator('.video-canvas-take-ref')).toHaveCount(2);

      // Its length and sound change before it is made again, and are asked of the services.
      await settings.click();
      await pick('duration', '10').click();
      await expect(settings).toHaveText('References · 9:16 · 720p · 10s · Sound');
      await pick('audio', 'false').click();
      await expect(settings).toHaveText('References · 9:16 · 720p · 10s · Silent');
      await expect(pick('audio', 'false')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => (await calls('videoCanvas.redoOptions')).at(-1)?.payload.settings).toEqual({ duration: 10, audio: false });
      await page.keyboard.press('Escape');
      // A service that cannot leave sound out has it, and says why silence is out of reach.
      await takePanel.locator('.video-canvas-take-model .ai-select-trigger').click();
      await page.locator('.ai-select-item', { hasText: 'Google Gemini Omni 1.1 Flash' }).click();
      await expect(settings).toHaveText('References · 9:16 · 720p · Sound');
      await settings.click();
      await expect(pick('audio', 'false')).toBeDisabled();
      await expect(popover.locator('.video-canvas-settings-note')).toHaveText(["This model can't use first or last frames", 'This model always makes sound']);
      await expect(popover.locator('[data-setting="duration"]')).toHaveCount(0);
      await shot('canvas-take-settings-omni');
      await page.keyboard.press('Escape');
      await takePanel.locator('.video-canvas-take-model .ai-select-trigger').click();
      await page.locator('.ai-select-item', { hasText: 'Doubao Seedance 2.0' }).click();
      await expect(settings).toHaveText('References · 9:16 · 720p · 10s · Silent');

      // Generating sends what was added and how the take is made, once, after confirmation. While it
      // is checked and then sent, the button says so and nothing in the panel can change it
      // (2026-11-10: it only greyed out, for about 20 seconds in all).
      const generate = takePanel.locator('[data-action="take-generate"]');
      await expect(generate).toHaveText('Generate');
      await expect(generate).toBeEnabled();
      const generateRow = await rowOf(generate);
      await hold('videoCanvas.quoteRedo');
      await generate.click();
      await expect(generate).toHaveText('Loading…');
      expect(Math.abs(await rowOf(generate) - generateRow)).toBeLessThanOrEqual(1);
      await expect(generate).toBeDisabled();
      await expect(takePanel.locator('textarea')).toHaveAttribute('readonly', '');
      await expect(settings).toBeDisabled();
      await expect(takePanel.locator('.video-canvas-take-model .ai-select-trigger')).toBeDisabled();
      await expect(takePanel.locator('.video-canvas-take-remove')).toBeDisabled();
      await expect(add).toBeDisabled();
      await shot('canvas-take-pricing');
      await hold('videoCanvas.redo');
      await release('videoCanvas.quoteRedo');
      await expect(page.locator('.ui-dialog-overlay.open')).toBeVisible();
      await page.locator('.ui-dialog-overlay.open [data-act="ok"]').click();
      await expect(generate).toHaveText('Submitting…');
      expect(Math.abs(await rowOf(generate) - generateRow)).toBeLessThanOrEqual(1);
      await expect(takePanel.locator('textarea')).toHaveAttribute('readonly', '');
      await shot('canvas-take-submitting');
      await release('videoCanvas.redo');
      await expect.poll(async () => (await calls('videoCanvas.redo')).length).toBe(1);
      expect((await calls('videoCanvas.redo'))[0].payload).toEqual({
        cid,
        dir: 'ad',
        asset: 'pour-2',
        prompt: 'second take',
        choice: 'doubao',
        inputs: { method: 'references', added: ['spare'] },
        settings: { duration: 10, audio: false },
      });
      await page.locator('#video-canvas-viewport').focus();
      await page.keyboard.press('Escape');
      await expect(takePanel).toBeHidden();

      // A selected card's "+" makes a new shot from it, to its right, with its words in focus.
      const photo = page.locator('.video-canvas-card[data-card="asset:photo"]');
      const plus = photo.locator('.video-canvas-connector');
      await expect(plus).toBeHidden();
      await photo.locator('.video-canvas-card-title').click();
      await expect(plus).toBeVisible();
      await expect(plus).toHaveAttribute('aria-label', 'New shot from this');
      await plus.click();
      await expect(page.locator('.context-menu-item')).toHaveText(['Video shot', 'Image']);
      await page.locator('.context-menu-item', { hasText: 'Video shot' }).click();
      const draftCards = page.locator('.video-canvas-card.is-draft');
      await expect(draftCards).toHaveCount(1);
      const draftCard = draftCards.first();
      await expect(draftCard).toHaveClass(/\bis-selected\b/);
      await expect(draftCard).toContainText('New shot');
      await expect(takePanel.locator('textarea')).toBeFocused();
      expect((await draftCard.boundingBox())!.x).toBeGreaterThan((await photo.boundingBox())!.x + (await photo.boundingBox())!.width);
      // Joined to the photo by a line, as everything is to what it is made from.
      await expect(page.locator('#video-canvas-lines path')).toHaveCount(1);
      expect(drafts().map(([, draft]) => [draft.kind, draft.inputs])).toEqual([['video', ['photo']]]);

      // Its words and choices are saved as they are made, and are still there after closing.
      await takePanel.locator('textarea').fill('A lamp slowly turns on');
      await expect.poll(() => drafts()[0]?.[1].prompt).toBe('A lamp slowly turns on');
      await expect(settings).toHaveText('References · 9:16 · 720p · 5s · Silent');
      await settings.click();
      await pick('duration', '10').click();
      await expect.poll(() => drafts()[0]?.[1].duration).toBe(10);
      await pick('resolution', '1080p').click();
      await expect.poll(() => drafts()[0]?.[1].resolution).toBe('1080p');
      await pick('audio', 'true').click();
      await expect.poll(() => drafts()[0]?.[1].audio).toBe(true);
      await expect(settings).toHaveText('References · 9:16 · 1080p · 10s · Sound');
      await shot('canvas-new-shot-settings');
      await page.keyboard.press('Escape');
      await shot('canvas-new-shot');
      await page.locator('#video-canvas-close').click();
      await expect(panel).toBeHidden();
      await toggle.click();
      await draftCard.locator('.video-canvas-card-title').click();
      await expect(takePanel.locator('textarea')).toHaveValue('A lamp slowly turns on');
      await expect(settings).toHaveText('References · 9:16 · 1080p · 10s · Sound');
      // Opening on frames, the shape follows the first frame.
      await settings.click();
      await pick('method', 'frames').click();
      await expect(settings).toHaveText('First and last frames · Match first frame · 1080p · 10s · Sound');
      await expect(pick('ratio', 'adaptive')).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape');
      await expect(takePanel.locator('.video-canvas-take-ref-role')).toHaveText(['First frame']);
      await expect(takePanel.locator('[data-action="input-add"]')).toHaveAttribute('aria-label', 'Add a last frame');

      // A line from another card's "+" to the new shot gives it that footage too.
      // Close the floating editor first: it can cover nearby cards on the shared narrow panel.
      await page.locator('#video-canvas-viewport').focus();
      await page.keyboard.press('Escape');
      await expect(takePanel).toBeHidden();
      const spare = page.locator('.video-canvas-card[data-card="asset:spare"]');
      await spare.locator('.video-canvas-card-title').click();
      const from = (await spare.locator('.video-canvas-connector').boundingBox())!;
      const to = (await draftCard.boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
      await expect(draftCard).toHaveClass(/\bis-drop-target\b/);
      await expect(page.locator('#video-canvas-lines path.is-pending')).toHaveCount(1);
      await page.mouse.up();
      await expect.poll(() => drafts()[0]?.[1].inputs).toEqual(['photo', 'spare']);
      await expect(draftCard).toHaveClass(/\bis-selected\b/);
      await expect(takePanel.locator('.video-canvas-take-ref-role')).toHaveText(['First frame', 'Last frame']);
      await expect(page.locator('#video-canvas-lines path.is-pending')).toHaveCount(0);

      // A line to open board makes a new shot there; a video makes no image.
      await page.locator('#video-canvas-viewport').focus();
      await page.keyboard.press('Escape');
      await expect(takePanel).toBeHidden();
      const phone = page.locator('.video-canvas-card[data-card="asset:phone"]');
      await phone.locator('.video-canvas-card-title').click();
      const phonePlus = (await phone.locator('.video-canvas-connector').boundingBox())!;
      const board = (await page.locator('#video-canvas-viewport').boundingBox())!;
      const open = { x: board.x + 60, y: board.y + board.height - 60 };
      expect(await page.evaluate(([x, y]) => !document.elementFromPoint(x, y)?.closest('.video-canvas-card, .video-canvas-take-panel, .video-canvas-zoom'), [open.x, open.y])).toBe(true);
      // Where the line ends on the board, before the view moves to show the new shot's panel.
      const transform = await page.locator('#video-canvas-world').evaluate((el) => (el as HTMLElement).style.transform);
      const [viewX, viewY, zoom] = (/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(transform) ?? []).slice(1).map(Number);
      const ended = { x: (open.x - board.x - viewX) / zoom, y: (open.y - board.y - viewY) / zoom };
      await page.mouse.move(phonePlus.x + phonePlus.width / 2, phonePlus.y + phonePlus.height / 2);
      await page.mouse.down();
      await page.mouse.move(open.x, open.y, { steps: 8 });
      await page.mouse.up();
      await expect(page.locator('.context-menu-item')).toHaveText(['Video shot', 'Image']);
      await expect(page.locator('.context-menu-item', { hasText: 'Image' })).toBeDisabled();
      await page.locator('.context-menu-item', { hasText: 'Video shot' }).click();
      await expect(draftCards).toHaveCount(2);
      const [[firstId], [secondId, secondDraft]] = drafts();
      expect(secondDraft.inputs).toEqual(['phone']);
      const placed = (JSON.parse(readFileSync(canvasFile, 'utf8')) as { cards: Record<string, { x: number; y: number }> }).cards[`draft:${secondId}`];
      // Its card hangs from where the line ended.
      expect(Math.abs(placed.x - ended.x)).toBeLessThanOrEqual(1);
      expect(ended.y - placed.y).toBeGreaterThan(0);
      expect(ended.y - placed.y).toBeLessThanOrEqual(41);
      await expect(page.locator(`.video-canvas-card[data-card="draft:${secondId}"]`)).toHaveClass(/\bis-selected\b/);
      expect(firstId).not.toBe(secondId);
      // Its panel opens in full view, this low on the board too, once its choices have made it
      // taller (2026-11-10: most of it stayed below the edge).
      await expect(takePanel.locator('[data-action="gen-settings"]')).toBeVisible();
      await expect.poll(async () => {
        const box = (await takePanel.boundingBox())!;
        return box.y >= board.y - 1 && box.y + box.height <= board.y + board.height + 1
          && box.x >= board.x - 1 && box.x + box.width <= board.x + board.width + 1;
      }).toBe(true);
      // Above the zoom controls and the hint at the board's foot, and Generate under nothing
      // (2026-11-10: it stopped 16px from the edge, and the zoom controls covered half of Generate).
      await expect.poll(() => takePanel.evaluate((el) => {
        const foot = ['video-canvas-zoom', 'video-canvas-board-hint'].map((id) => document.getElementById(id) as HTMLElement)
          .filter((item) => !item.hidden).map((item) => item.getBoundingClientRect().top);
        const button = (el.querySelector('[data-action="draft-generate"]') as HTMLElement).getBoundingClientRect();
        const hit = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
        return foot.length === 2 && el.getBoundingClientRect().bottom <= Math.min(...foot) && !!hit?.closest('[data-action="draft-generate"]');
      })).toBe(true);
      await shot('canvas-new-shot-low');
      // No request was sent for it, so it goes without asking.
      const second = page.locator('.video-canvas-card.is-draft.is-selected');
      await second.hover();
      await second.locator('.video-canvas-card-menu').click();
      await expect(page.locator('.context-menu-item')).toHaveText(['Delete']);
      await page.locator('.context-menu-item.is-danger').click();
      await expect(page.locator('.ui-dialog-overlay.open')).toHaveCount(0);
      await expect(draftCards).toHaveCount(1);
      expect(drafts()).toHaveLength(1);

      // From the keyboard, a card's menu does what its "+" does. Made from the same photo as the
      // first, the new shot goes clear of it (2026-11-10: it landed exactly on top and hid it).
      await page.locator('#video-canvas-zoom-fit').click();
      await photo.hover();
      await photo.locator('.video-canvas-card-menu').click();
      await page.locator('.context-menu-item', { hasText: 'New shot from this' }).click();
      await page.locator('.context-menu-item', { hasText: 'Video shot' }).click();
      await expect(draftCards).toHaveCount(2);
      const [againId] = drafts().map(([draftId]) => draftId).filter((draftId) => draftId !== firstId);
      const boxes = await page.locator('#video-canvas-world > .video-canvas-card').evaluateAll((els) => els.map((el) => {
        const card = el as HTMLElement;
        return { key: card.dataset.card, x: card.offsetLeft, y: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight };
      }));
      const again = boxes.find((box) => box.key === `draft:${againId}`)!;
      for (const other of boxes.filter((box) => box !== again)) {
        expect(again.x >= other.x + other.width || other.x >= again.x + again.width
          || again.y >= other.y + other.height || other.y >= again.y + again.height, `${other.key} under the new shot`).toBe(true);
      }
      expect((JSON.parse(readFileSync(canvasFile, 'utf8')) as { cards: Record<string, { x: number; y: number }> }).cards[`draft:${againId}`])
        .toEqual({ x: again.x, y: again.y });
      const againCard = page.locator(`.video-canvas-card[data-card="draft:${againId}"]`);
      await againCard.hover();
      await againCard.locator('.video-canvas-card-menu').click();
      await page.locator('.context-menu-item.is-danger').click();
      await expect(draftCards).toHaveCount(1);

      // Generated, it becomes a shot card where it stood, and goes into no video.
      await draftCard.locator('.video-canvas-card-title').click();
      const before = (await draftCard.boundingBox())!;
      const [[id]] = drafts();
      const make = takePanel.locator('[data-action="draft-generate"]');
      await expect(make).toHaveText('Generate');
      await page.evaluate(() => (window as any).setLang('zh'));
      await expect(settings).toHaveText('首尾帧 · 跟首帧 · 1080p · 10 秒 · 有声');
      expect(await shownInFull()).toBe(true);
      await expect(settings).toHaveAttribute('aria-label', '生成设置');
      await shot('canvas-new-shot-chinese');
      // Checked and then cancelled, the panel takes changes again and nothing was sent.
      const makeRow = await rowOf(make);
      await hold('videoCanvas.quoteDraft');
      await make.click();
      await expect(make).toHaveText('加载中…');
      expect(Math.abs(await rowOf(make) - makeRow)).toBeLessThanOrEqual(1);
      await expect(takePanel.locator('textarea')).toHaveAttribute('readonly', '');
      await expect(settings).toBeDisabled();
      await shot('canvas-new-shot-pricing-chinese');
      await release('videoCanvas.quoteDraft');
      const dialog = page.locator('.ui-dialog-overlay.open');
      await expect(dialog).toContainText('自己的服务账号');
      await page.locator('.ui-dialog-overlay.open [data-act="cancel"]').click();
      await expect(make).toHaveText('生成');
      await expect(make).toBeEnabled();
      // Focus is back on Generate, which was redrawn while it was checked (2026-11-10: it was lost).
      await expect(make).toBeFocused();
      await expect(takePanel.locator('textarea')).not.toHaveAttribute('readonly');
      await expect(settings).toBeEnabled();
      expect(await calls('videoCanvas.generateDraft')).toEqual([]);
      await page.evaluate(() => (window as any).setLang('en'));
      await expect(make).toHaveText('Generate');
      const makeRowEnglish = await rowOf(make);
      await hold('videoCanvas.generateDraft');
      await make.click();
      await expect(dialog).toContainText('your own service account');
      await page.locator('.ui-dialog-overlay.open [data-act="ok"]').click();
      await expect(make).toHaveText('Submitting…');
      expect(Math.abs(await rowOf(make) - makeRowEnglish)).toBeLessThanOrEqual(1);
      await shot('canvas-new-shot-submitting');
      await release('videoCanvas.generateDraft');
      await expect.poll(async () => (await calls('videoCanvas.generateDraft')).length).toBe(1);
      expect((await calls('videoCanvas.generateDraft'))[0].payload).toEqual({ cid, dir: 'ad', id });
      await expect(draftCards).toHaveCount(0);
      const made = page.locator(`.video-canvas-card[data-card="shot:${id}"]`);
      await expect(made).toHaveCount(1);
      await expect(made).toHaveClass(/\bis-selected\b/);
      await expect(made.locator('.video-canvas-card-kind')).toHaveText('Shot 02');
      const after = (await made.boundingBox())!;
      expect(Math.abs(after.x - before.x)).toBeLessThan(2);
      expect(Math.abs(after.y - before.y)).toBeLessThan(2);
      await expect(page.locator('.ui-toast', { hasText: "The new shot is on its card. The videos haven't changed." })).toBeVisible();
      expect(drafts()).toEqual([]);
      await shot('canvas-new-shot-made');
    } finally {
      await modelOrkas.electronApp!.evaluate(() => (globalThis as any).__canvasInputsControl.restore());
    }

  });

  // On 2026-11-07 a launch video showed two site screenshots through the page's own <img src>
  // instead of clips, and the canvas drew no line to them.
  // Decided 2026-11-11: narration voiced here changes in its scene like words, and the video's one
  // voice in the select under it; Update hands both to VideoStudio in the words the product owner
  // confirmed, and nothing is voiced on the canvas itself.
  test('changes narration and the voice, and asks VideoStudio to voice them again', async ({}, testInfo) => {
    const speechEnv = ['ORKAS_TTS_BASE_URL', 'ORKAS_TTS_API_KEY', 'ORKAS_TTS_MODEL', 'ORKAS_TTS_VOICE'];
    const previous = Object.fromEntries(speechEnv.map((key) => [key, process.env[key]]));
    // One speech service, with one voice the narration does not have. Nothing calls it here.
    process.env.ORKAS_TTS_BASE_URL = 'http://127.0.0.1:9/v1';
    process.env.ORKAS_TTS_API_KEY = 'e2e-speech-secret';
    process.env.ORKAS_TTS_MODEL = 'e2e-speech-model';
    process.env.ORKAS_TTS_VOICE = 'e2e-bright-voice';
    const app = new OrkasTestApp(testInfo, { modelStub: true });
    try {
      await app.launch();
      if (!app.page) throw new Error('Orkas renderer is unavailable');
      const { page } = app;
      await page.locator('#new-chat-btn').click();
      await page.locator('#new-chat-input').fill('Prepare the narration canvas e2e conversation.');
      await page.locator('#new-chat-send-btn').click();
      await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toBeVisible({ timeout: 30_000 });
      const cid = String(await page.evaluate('currentCid'));
      const stateFile = path.join(app.workspaceRoot, 'account-e2e', 'cloud', 'chats', cid, 'state.json');
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
      state.workspace_dir = 'e2e-video-canvas-voice';
      writeFileSync(stateFile, JSON.stringify(state), 'utf8');

      const production = path.join(app.workspaceRoot, '..', 'userWorkSpace', 'e2e-video-canvas-voice', 'ad');
      const manifestFile = path.join(production, 'videos', 'main', 'manifest.json');
      mkdirSync(path.dirname(manifestFile), { recursive: true });
      mkdirSync(path.join(production, 'voice'), { recursive: true });
      const said = { hook: 'Bright light for late nights.', light: 'It charges in an hour.' };
      writeFileSync(manifestFile, JSON.stringify({
        schema_version: 3,
        id: 'main',
        label: 'Launch',
        canvas: { width: 540, height: 960, fps: 30 },
        scenes: [
          { id: 'hook', duration: 2, text: { headline: { value: 'Meet the lamp' } }, narration: { text: said.hook, asset: 'voice-hook' } },
          { id: 'light', duration: 2, narration: { text: said.light, asset: 'voice-light' } },
        ],
      }));
      const voiced = (id: string, words: string) => ({
        id,
        kind: 'audio',
        label: words,
        path: `voice/${id}.mp3`,
        origin: 'generated',
        prompt: words,
        request: { route_ref: 'configured:old-voice', voice_ref: 'configured:old-voice:warm', language: 'en-US' },
      });
      for (const id of ['voice-hook', 'voice-light']) writeFileSync(path.join(production, 'voice', `${id}.mp3`), 'bytes');
      writeFileSync(path.join(production, 'assets.json'), JSON.stringify({ assets: [voiced('voice-hook', said.hook), voiced('voice-light', said.light)] }));
      await app.electronApp!.evaluate(async (_electron, args) => {
        const require = (process as any).mainModule.require.bind((process as any).mainModule);
        await require(args.module).bumpConversationActivity(args.uid, args.cid, new Date().toISOString(), { senderKind: 'agent', senderId: '79df9cc89f5f' });
      }, { module: path.resolve(__dirname, '../../src/main/features/chats.ts'), uid: 'account-e2e', cid });
      await page.evaluate('VideoCanvas.probe(currentCid)');
      await page.setViewportSize({ width: 1600, height: 960 });
      await page.locator('#video-canvas-toggle').click();
      const panel = page.locator('#video-canvas-panel');
      const videoCard = page.locator('.video-canvas-card.is-video');
      await expect(videoCard).toHaveCount(1);
      // The video's one voice is set on a row of its own under its scenes, with no scene open
      // (decided 2026-11-12).
      const voices = videoCard.locator('[data-voice-select]');
      const voice = voices.locator('.ai-select-trigger');
      await expect(voices).toHaveCount(1);
      // The voice it has is no service's here, so it shows as the current one, and can change.
      await expect(voice).toHaveText(/Current voice/);
      await expect(voice).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath('canvas-voice.png') });
      const editor = videoCard.locator('.video-canvas-editor');
      const words = editor.locator('input[data-commit="narration"]');
      for (const [scene, line] of [['light', said.light], ['hook', said.hook]]) {
        await videoCard.locator(`.video-canvas-chip[data-scene="${scene}"]`).click();
        await expect(words).toHaveValue(line);
        // Whichever scene is open, the voice stays the one row between the scenes and its editor.
        await expect(editor.locator('[data-voice-select]')).toHaveCount(0);
        await expect(voices).toHaveCount(1);
        const [scenes, row, open] = await Promise.all([videoCard.locator('.video-canvas-bar').boundingBox(), voices.boundingBox(), editor.boundingBox()]);
        expect(row!.y).toBeGreaterThanOrEqual(scenes!.y + scenes!.height);
        expect(row!.y + row!.height).toBeLessThanOrEqual(open!.y);
      }
      await page.screenshot({ path: testInfo.outputPath('canvas-narration.png') });

      await page.evaluate(() => {
        const w = window as any;
        const send = w.sendInConversation;
        w.__canvasSends = [];
        w.sendInConversation = (target: string, content: string, ...rest: unknown[]) => {
          w.__canvasSends.push(content);
          return send(target, content, ...rest);
        };
      });
      const sent = async () => (await page.evaluate(() => (window as any).__canvasSends)) as string[];
      const update = videoCard.locator('[data-action="render"]');
      const manifest = () => JSON.parse(readFileSync(manifestFile, 'utf8'));

      // New words wait for Update, keep their audio, and go to VideoStudio to be voiced again.
      await words.fill('Warm light for late nights.');
      await page.keyboard.press('Enter');
      await expect.poll(() => manifest().scenes[0].narration).toEqual({ text: 'Warm light for late nights.', asset: 'voice-hook' });
      await update.click();
      await expect.poll(async () => (await sent()).length).toBe(1);
      expect((await sent())[0]).toBe([
        '@VideoStudio The narration changed. Please update the video "Launch":',
        '- Scene 1 (hook): the narration now says "Warm light for late nights."',
        "Voice these lines again in the voice they have; where one no longer fits its scene, change that scene's length. Leave everything else as it is.",
      ].join('\n'));
      await expect(panel).not.toHaveClass(/\bis-read-only\b/, { timeout: 30_000 });

      // The video's voice changes for all its narration, and goes with the words still unvoiced.
      await voice.click();
      await page.locator('.ai-select-item', { hasText: 'e2e-bright-voice' }).click();
      await expect(voice).toHaveText(/e2e-bright-voice/);
      const listed = await app.invoke<{ ok: boolean; voices: Array<{ route_ref: string; voice_ref: string; name: string }> }>(
        'videoCanvas.voices', { cid, dir: 'ad', video: 'main' });
      const bright = listed.voices.find((item) => item.name === 'e2e-bright-voice')!;
      // Held so the canvas can be seen while VideoStudio works.
      app.setModelMode('controlled-slow');
      try {
        await update.click();
        await expect.poll(async () => (await sent()).length).toBe(2);
        expect((await sent())[1]).toBe([
          '@VideoStudio The narration changed. Please update the video "Launch":',
          '- Scene 1 (hook): the narration now says "Warm light for late nights."',
          `- Change the voice to "e2e-bright-voice" (route_ref ${bright.route_ref}, voice_ref ${bright.voice_ref})`,
          "Voice all of the video's narration again in the new voice; where a line no longer fits its scene, change that scene's length. Leave everything else as it is.",
        ].join('\n'));
        // While it works, neither the words nor the voice can change.
        await expect(panel).toHaveClass(/\bis-read-only\b/);
        await expect(words).toBeDisabled();
        await expect(voice).toBeDisabled();
        await page.screenshot({ path: testInfo.outputPath('canvas-voice-locked.png') });
      } finally {
        app.releaseControlledModelChunk();
        app.finishControlledModelStream();
        app.setModelMode('success');
      }
      await expect(panel).not.toHaveClass(/\bis-read-only\b/, { timeout: 30_000 });
      expect(JSON.stringify(manifest())).not.toContain('e2e-bright-voice');

      // Rows that name the voice some other way, as Luna once wrote them, keep the words open to
      // change and offer no voice to choose.
      const ownWay = (id: string, words: string) => ({ ...voiced(id, words), request: { voice: 'warm', route: 'orkas' } });
      writeFileSync(path.join(production, 'assets.json'), JSON.stringify({ assets: [ownWay('voice-hook', said.hook), ownWay('voice-light', said.light)] }));
      await page.evaluate('VideoCanvas.refresh()');
      await expect(voices).toHaveCount(0);
      await expect(words).toBeEnabled();
    } finally {
      await app.dispose();
      for (const key of speechEnv) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test('draws a line to a picture the page shows by file, and keeps it from being swapped', async ({ modelOrkas }, testInfo) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const { page } = modelOrkas;
    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill('Prepare the page picture canvas e2e conversation.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]'))
      .toBeVisible({ timeout: 30_000 });
    const cid = String(await page.evaluate('currentCid'));
    const stateFile = path.join(modelOrkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', cid, 'state.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    state.workspace_dir = 'e2e-video-canvas-page';
    writeFileSync(stateFile, JSON.stringify(state), 'utf8');

    const production = path.join(modelOrkas.workspaceRoot, '..', 'userWorkSpace', 'e2e-video-canvas-page', 'launch');
    const video = path.join(production, 'videos', 'main');
    mkdirSync(path.join(video, 'assets'), { recursive: true });
    mkdirSync(path.join(production, 'media'), { recursive: true });
    writeFileSync(path.join(video, 'index.html'), PAGE.replace(
      '<section data-scene-id="price"><h1 data-slot="amount">placeholder</h1></section>',
      '<section data-scene-id="price"><img src="assets/site.png"><h1 data-slot="amount">placeholder</h1></section>',
    ));
    writeFileSync(path.join(video, 'manifest.json'), JSON.stringify({
      schema_version: 3,
      id: 'main',
      label: 'Launch',
      canvas: { width: 540, height: 960, fps: 30 },
      scenes: [
        { id: 'hook', clips: [{ id: 'hook-clip', asset: 'photo', in: 0, dur: 1 }], text: { headline: { value: 'Meet it' } } },
        { id: 'price', duration: 1, text: { amount: { value: '$29' } } },
      ],
    }));
    const ledger = JSON.stringify({ assets: [
      { id: 'photo', kind: 'image', label: 'Front photo.png', path: 'media/photo.png', origin: 'upload' },
      { id: 'site', kind: 'image', label: 'Site screenshot.png', path: 'videos/main/assets/site.png', origin: 'page' },
      { id: 'character', kind: 'image', label: 'Character still', path: 'media/character.png', origin: 'generated', shot: 'character' },
    ] });
    writeFileSync(path.join(production, 'assets.json'), ledger);
    await modelOrkas.electronApp!.evaluate(async (_electron, args) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const { ffmpeg } = require(args.module).bundledFfmpegPaths();
      if (!ffmpeg) throw new Error('Bundled FFmpeg is required for this fixture');
      const still = (file: string, source: string) => new Promise<void>((resolve, reject) => {
        require('node:child_process').execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${source}=s=540x720:r=1:d=1`, '-frames:v', '1', file],
          { windowsHide: true, timeout: 60000 }, (error: Error | null) => error ? reject(error) : resolve());
      });
      await still(`${args.dir}/media/photo.png`, 'testsrc2');
      await still(`${args.dir}/videos/main/assets/site.png`, 'smptebars');
      await still(`${args.dir}/media/character.png`, 'testsrc2');
    }, { module: path.resolve(__dirname, '../../src/main/util/bundled-runtime.ts'), dir: production.split(path.sep).join('/') });
    await modelOrkas.electronApp!.evaluate(async (_electron, args) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      await require(args.module).bumpConversationActivity(args.uid, args.cid, new Date().toISOString(), { senderKind: 'agent', senderId: '79df9cc89f5f' });
    }, { module: path.resolve(__dirname, '../../src/main/features/chats.ts'), uid: 'account-e2e', cid });
    await page.evaluate('VideoCanvas.probe(currentCid)');
    await page.setViewportSize({ width: 1600, height: 960 });
    await page.locator('#video-canvas-toggle').click();
    const siteCard = page.locator('.video-canvas-card[data-card="asset:site"]');
    await expect(siteCard).toHaveCount(1);
    // A generated still is an image, not a shot (2026-11-12: a character still headed "Shot 01").
    await expect(page.locator('.video-canvas-card[data-card="shot:character"] .video-canvas-card-kind')).toHaveText('Image 01');

    // The video's lines reach the clip's picture and the one its page shows.
    await page.keyboard.press('Escape');
    await page.locator('.video-canvas-card.is-video .video-canvas-card-title').click();
    await expect(page.locator('#video-canvas-lines path')).toHaveCount(2);
    await expect(siteCard).toHaveClass(/\bis-related\b/);
    await page.screenshot({ path: testInfo.outputPath('canvas-page-picture-line.png') });

    // Replace says why before any file is picked; delete keeps the card.
    let chosen = 0;
    page.on('filechooser', () => { chosen += 1; });
    await siteCard.hover();
    await siteCard.locator('.video-canvas-card-menu').click();
    await page.locator('.context-menu-item', { hasText: 'Replace' }).click();
    await expect(page.locator('.ui-toast', { hasText: 'places this picture itself' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('canvas-page-picture-replace.png') });
    expect(chosen).toBe(0);
    await siteCard.hover();
    await siteCard.locator('.video-canvas-card-menu').click();
    await page.locator('.context-menu-item.is-danger').click();
    await expect(page.locator('.ui-toast', { hasText: 'still uses' })).toBeVisible();
    await expect(siteCard).toHaveCount(1);
    expect(readFileSync(path.join(production, 'assets.json'), 'utf8')).toBe(ledger);
  });
});
