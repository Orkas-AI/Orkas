import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { expect, test } from './fixtures/orkas';



test('video controls share one translucent row and preserve playback, seeking and volume', async ({ orkas }, info) => {
  // Generate the seekable video and exercise all ten sizes across both surfaces.
  test.setTimeout(120_000);
  const file = path.join(orkas.userWorkspaceRoot, 'controls.webm');
  await orkas.electronApp!.evaluate(async (_electron, args) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const { ffmpeg } = req(args.module).bundledFfmpegPaths();
    await new Promise<void>((resolve, reject) => req('node:child_process').execFile(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=steelblue:s=1920x1080:r=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440', '-vf', 'scale=1920:1080', '-t', '94',
      '-c:v', 'libvpx', '-g', '1', '-pix_fmt', 'yuv420p', '-threads', '1', '-c:a', 'libvorbis', args.file,
    ], { timeout: 30000, windowsHide: true }, (error: Error | null) => error ? reject(error) : resolve()));
  }, { module: path.resolve(__dirname, '../../src/main/util/bundled-runtime.ts'), file });
  const page = orkas.page!;
  await page.evaluate(file => {
    const w = window as any;
    const host = document.createElement('div');
    host.id = 'video-controls-probe';
    host.className = 'markdown-body';
    Object.assign(host.style, { position: 'fixed', inset: '24px auto auto 24px', width: '640px', zIndex: '50' });
    host.innerHTML = w.renderMarkdownFull(`![Video](${w._chatMediaLocalUrl(file)})`);
    document.body.appendChild(host);
  }, file);
  const preview = await orkas.openPreview(() => page.evaluate(file =>
    (window as any).openChatVideoUrlViewer((window as any)._chatMediaLocalUrl(file), 'Video'), file));

  for (const [surface, target, selector] of [
    ['inline', page, '#video-controls-probe video'],
    ['preview', preview, '.chat-file-viewer-video'],
  ] as const) {
    const video = target.locator(selector);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
    const cdp = await target.context().newCDPSession(target);
    const control = async (pseudo: string) => {
      const { root } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: -1, pierce: true });
      const find = (n: any): any => {
        const attrs = n.attributes || [];
        if (attrs[attrs.indexOf('pseudo') + 1] === pseudo) return n;
        for (const child of [...(n.children || []), ...(n.shadowRoots || [])]) {
          const match = find(child);
          if (match) return match;
        }
      };
      const found = find(node);
      expect(found, pseudo).toBeTruthy();
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: found.backendNodeId });
      const { result } = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: `function() { const r = this.getBoundingClientRect(); const s = getComputedStyle(this);
          return { x: r.x, y: r.y, width: r.width, height: r.height, opacity: s.opacity, pointer: s.pointerEvents, background: s.backgroundColor, image: s.backgroundImage }; }`,
      });
      const border = ['-webkit-media-controls-play-button', '-webkit-media-controls-timeline', '-webkit-media-controls-mute-button'].includes(pseudo)
        ? (await cdp.send('DOM.getBoxModel', { backendNodeId: found.backendNodeId })).model.border : null;
      return { ...result.value, border };
    };
    // Cross Chromium's native 48px/64px control boundary in both directions.
    // A wide, short preview must use the video width, not the window width.
    const sizes = surface === 'inline' ? [[640, 360], [320, 180], [640, 360]]
      : [[1440, 900], [1441, 900], [1480, 900], [1480, 360], [640, 360], [480, 360], [1480, 900]];
    for (const [index, [width, height]] of sizes.entries()) {
      const view = `${surface}-${width}x${height}-${index}`;
      if (surface === 'inline') await page.locator('#video-controls-probe').evaluate((host, width) => host.style.width = `${width}px`, width);
      else {
        const win = await orkas.electronApp!.browserWindow(preview);
        await win.evaluate((win, size) => win.setContentSize(size.width, size.height), { width, height });
        const fittedWidth = Math.min(width, height * 16 / 9);
        // Windows rounds native bounds to physical pixels. Preserve the actual controls boundary.
        await expect.poll(() => video.evaluate((element, expectedWidth) => ({
          fitsRequestedWidth: Math.abs(element.getBoundingClientRect().width - expectedWidth) < 1,
          aboveControlBoundary: element.clientWidth > 1440,
        }), fittedWidth)).toEqual({ fitsRequestedWidth: true, aboveControlBoundary: fittedWidth > 1440 });
      }
      if (surface === 'preview' && index === sizes.length - 1) {
        await target.evaluate(() => (window as any).setLang('zh'));
      }
      await video.hover();
      await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 93; });
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
      const panel = await control('-webkit-media-controls-panel');
      expect(panel.image).toBe('none');
      expect(panel.background).toMatch(/^rgba\(0, 0, 0, 0\.[3456]\d*\)$/);
      expect(panel.height).toBeLessThanOrEqual(48);
      const play = await control('-webkit-media-controls-play-button');
      const timeline = await control('-webkit-media-controls-timeline');
      const remaining = await control('-webkit-media-controls-time-remaining-display');
      const muteBeforeSeek = await control('-webkit-media-controls-mute-button');
      const geometryPath = info.outputPath(`${view}-geometry.json`);
      writeFileSync(geometryPath, JSON.stringify({ panel, play, timeline, remaining, mute: muteBeforeSeek }, null, 2));
      await info.attach(`${view}-geometry`, { path: geometryPath, contentType: 'application/json' });
      await video.screenshot({ path: info.outputPath(`${view}-near-end.png`) });
      if (remaining.height > 0) expect(timeline.border[0], `${view}: timeline must clear the time`).toBeGreaterThanOrEqual(remaining.x + remaining.width);
      expect(timeline.border[2], `${view}: timeline must clear the volume control`).toBeLessThanOrEqual(muteBeforeSeek.border[0]);
      expect(timeline.width).toBeGreaterThan(24);
      const centerY = panel.y + panel.height / 2;
      for (const pseudo of ['-webkit-media-controls-play-button', '-webkit-media-controls-current-time-display',
        '-webkit-media-controls-time-remaining-display', '-webkit-media-controls-timeline',
        '-webkit-media-controls-mute-button', '-internal-media-controls-overflow-button']) {
        const item = await control(pseudo);
        if (item.height > 0) {
          expect(Math.abs(item.y + item.height / 2 - centerY),
            `${surface} ${width}: ${pseudo} must be centered inside the overlay`).toBeLessThanOrEqual(1);
        }
      }
      await target.mouse.click(play.x + play.width / 2, play.y + play.height / 2);
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
      await video.evaluate((v: HTMLVideoElement) => v.pause());
      await target.mouse.click(timeline.x + timeline.width / 2, timeline.y + timeline.height / 2);
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(30);
      expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(65);
      expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
      const mute = await control('-webkit-media-controls-mute-button');
      // Too narrow for the time: the timeline takes its room and stays clear of the buttons.
      if (surface === 'inline' && width === 320) {
        const geometryPath = info.outputPath('narrow-controls-geometry.json');
        writeFileSync(geometryPath, JSON.stringify({ surface, width, play, timeline, mute }, null, 2));
        await info.attach('narrow-controls-geometry', { contentType: 'application/json', path: geometryPath });
        expect((await control('-webkit-media-controls-current-time-display')).height).toBe(0);
        expect((await control('-webkit-media-controls-time-remaining-display')).height).toBe(0);
        expect(timeline.width).toBeGreaterThan(100);
        // Compare Chromium's border edges directly; adding rounded DOMRect fields can invent an overlap.
        expect(timeline.border[0]).toBeGreaterThanOrEqual(play.border[2]);
        expect(timeline.border[2]).toBeLessThanOrEqual(mute.border[0]);
      }
      // Compact players keep mute; larger media also expose a volume popup.
      if (width > 520) {
        await target.mouse.move(mute.x + mute.width / 2, mute.y + mute.height / 2);
        await expect.poll(async () => (await control('-webkit-media-controls-volume-slider')).opacity).toBe('1');
        const volume = await control('-webkit-media-controls-volume-slider');
        await expect.poll(async () => (await control('-webkit-media-controls-volume-slider')).pointer).toBe('auto');
        await target.mouse.click(volume.x + volume.width * 0.3, volume.y + volume.height / 2);
        await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.volume)).toBeLessThan(0.8);
        expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
      }
      await target.mouse.click(mute.x + mute.width / 2, mute.y + mute.height / 2);
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
      await video.evaluate((v: HTMLVideoElement) => { v.muted = false; v.currentTime = 0; v.volume = 1; v.blur(); });
      await video.hover();
      if (width > 520) await expect.poll(async () => (await control('-webkit-media-controls-volume-slider')).opacity).toBe('0');
      await video.screenshot({ path: info.outputPath(`${view}.png`) });
      if (surface === 'preview' && width > 640) {
        await target.screenshot({ path: info.outputPath('wide-controls.png'), clip: {
          x: panel.x - 12, y: panel.y - 12, width: panel.width + 24, height: panel.height + 24,
        } });
      }
    }
    await cdp.detach();
  }
});
