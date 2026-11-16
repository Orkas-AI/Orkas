import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from './fixtures/orkas';

// The real task browser saves the video a local page plays: the response
// capture, the claimed download and the fixed playing-video read run in
// Electron against pages that stand in for stream players, direct players, a
// site that refuses other requests, and a sign-in wall.
test('saves the video a page plays through the task browser, and leaves a page without one open', async ({ orkas }) => {
  test.setTimeout(240_000);
  const root = path.resolve(__dirname, '../../');
  const media = path.join(orkas.root, 'page-media');
  fs.mkdirSync(media, { recursive: true });
  await orkas.electronApp!.evaluate(async (_electron, args) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const { ffmpeg } = require(args.module).bundledFfmpegPaths();
    if (!ffmpeg) throw new Error('Bundled FFmpeg is required for this fixture');
    const encode = (argv: string[]) => new Promise<void>((resolve, reject) => {
      require('node:child_process').execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...argv],
        { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 }, (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(error);
          else if (stdout || stderr) reject(new Error('FFmpeg fixture setup emitted unexpected output'));
          else resolve();
        });
    });
    const picture = (seconds: number) => ['-f', 'lavfi', '-i', `testsrc=s=320x180:r=25:d=${seconds}`];
    const sound = (seconds: number) => ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`];
    const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-threads', '1'];
    await encode([...picture(3), ...sound(3), ...h264, '-c:a', 'aac', '-shortest', '-movflags', '+faststart', `${args.dir}/both.mp4`]);
    await encode([...picture(3), ...h264, '-movflags', '+faststart', `${args.dir}/picture.mp4`]);
    await encode([...sound(3), '-c:a', 'aac', `${args.dir}/sound.m4a`]);
    await encode([...picture(1), ...sound(1), ...h264, '-c:a', 'aac', '-shortest', `${args.dir}/effect.mp4`]);
  }, { module: path.join(root, 'src/main/util/bundled-runtime.ts'), dir: media.split(path.sep).join('/') });

  const types: Record<string, string> = { '.mp4': 'video/mp4', '.m4a': 'audio/mp4' };
  const hostRequests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname.startsWith('/media/')) {
      const name = path.basename(url.pathname);
      const player = req.headers['x-player'] === '1';
      // The host's save names the page as Referer. Playwright's trace snapshots also
      // fetch these addresses, with neither header, so they are not counted.
      if (!player && req.headers.referer) hostRequests.push(name);
      // A site that serves its player and refuses every other request.
      if (name === 'guarded.mp4' && !player) { res.writeHead(403).end(); return; }
      // A live preview: a stream that never ends and never states a size.
      if (name === 'live.flv') {
        res.writeHead(200, { 'Content-Type': 'video/x-flv' });
        const tick = setInterval(() => res.write(Buffer.alloc(1024)), 200);
        res.on('close', () => clearInterval(tick));
        return;
      }
      const file = path.join(media, ['guarded.mp4', 'stalled.mp4'].includes(name) ? 'both.mp4' : name);
      if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
      const bytes = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Content-Length': bytes.length });
      // A connection that goes quiet partway through the host's save and never closes.
      if (name === 'stalled.mp4' && !player) { res.write(bytes.subarray(0, 1024)); return; }
      res.end(bytes);
      return;
    }
    // Stream players fetch the file and play a blob: address, as Douyin's does.
    // Their requests carry X-Player, so the server can tell them from the host's.
    const load = (src: string) => `fetch('${src}', { headers: { 'X-Player': '1' } }).then(r => r.blob()).then(b => URL.createObjectURL(b))`;
    const big = 'muted autoplay playsinline style="width:640px;height:360px"';
    const pages: Record<string, string> = {
      '/single': `<video id="v" ${big}></video><video id="fx" muted style="width:40px;height:40px"></video><script>
        ${load('/media/both.mp4')}.then(u => { v.src = u; });
        ${load('/media/effect.mp4')}.then(u => { fx.src = u; });</script>`,
      '/split': `<video id="v" ${big}></video><audio id="a"></audio><script>
        ${load('/media/picture.mp4')}.then(u => { v.src = u; });
        ${load('/media/sound.m4a')}.then(u => { a.src = u; });</script>`,
      '/direct': `<video src="/media/both.mp4" ${big}></video>`,
      '/guarded': `<video id="v" ${big}></video><script>${load('/media/guarded.mp4')}.then(u => { v.src = u; });</script>`,
      '/stalled': `<video id="v" ${big}></video><script>${load('/media/stalled.mp4')}.then(u => { v.src = u; });</script>`,
      '/live': `<video id="v" ${big}></video><script>
        fetch('/media/live.flv', { headers: { 'X-Player': '1' } }).then(r => r.body.getReader()).then(reader => { const pump = () => reader.read().then(c => { if (!c.done) pump(); }); pump(); });
        ${load('/media/both.mp4')}.then(u => { v.src = u; });</script>`,
      '/login': '<h1>Sign in to watch</h1>',
    };
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>Reference ${url.pathname}</title>${pages[url.pathname] ?? ''}`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cid = (await orkas.invoke<any>('conversations.create', { title: 'Reference link' })).conversation.conversation_id as string;
  await orkas.page!.evaluate(async id => {
    await (window as any).loadConversations();
    (window as any).setView('conversation', id);
    (window as any).ConversationInfo.openAndSetTab('browser');
  }, cid);
  await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
    await new Promise<void>(resolve => setImmediate(resolve));
    const require = (process as any).mainModule.require;
    require(args.root + '/src/main/features/web_assist.ts').bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
    require(args.root + '/src/main/features/web_assist_lifecycle.ts').beginBrowserTaskRun('account-e2e', args.cid, 'reference-page-e2e');
  }, { root, cid });

  const save = (pagePath: string) => orkas.electronApp!.evaluate(async (_electron, args) => {
    const require = (process as any).mainModule.require;
    const nodeFs = require('node:fs');
    const nodePath = require('node:path');
    const browser = require(args.root + '/src/main/features/web_assist.ts').createModelPageVideoBrowser('account-e2e', args.cid, {});
    const { savePageVideo } = require(args.root + '/src/main/features/web_assist_page_video.ts');
    const dir = nodeFs.mkdtempSync(nodePath.join(args.out, 'save-'));
    const saved = await savePageVideo(browser, { url: args.url, targetDir: dir, videoWaitMs: 8000 });
    let probe = null;
    if (saved.ok) {
      const { ffprobe } = require(args.root + '/src/main/util/bundled-runtime.ts').bundledFfmpegPaths();
      const out = require('node:child_process').execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', saved.path]).toString();
      const parsed = JSON.parse(out);
      probe = { duration: Number(parsed.format.duration), streams: parsed.streams.map((s: any) => s.codec_type).sort(),
        sha256: require('node:crypto').createHash('sha256').update(nodeFs.readFileSync(saved.path)).digest('hex') };
    }
    return { saved, files: nodeFs.readdirSync(dir), probe };
  }, { root, cid, url: origin + pagePath, out: orkas.root });
  const sha = (name: string) => createHash('sha256').update(fs.readFileSync(path.join(media, name))).digest('hex');
  const openTabs = async () => ((await orkas.invoke<any>('webAssist.state', {})).state.tabs as any[]).map(tab => String(tab.address_url || ''));

  try {
    await test.step('a stream player: the file it plays, not the short clip beside it', async () => {
      const single = await save('/single');
      expect(single.saved).toMatchObject({ ok: true, host: '127.0.0.1', silent: false });
      expect(single.probe!.sha256).toBe(sha('both.mp4'));
      expect(single.files).toEqual(['reference.mp4']);
      expect(hostRequests).toEqual(['both.mp4']);
      expect((await openTabs()).some(url => url.endsWith('/single'))).toBe(false);
    });
    await test.step('picture and sound loaded as separate files are joined', async () => {
      const split = await save('/split');
      expect(split.saved).toMatchObject({ ok: true, silent: false });
      expect(split.probe!.streams).toEqual(['audio', 'video']);
      expect(Math.abs(split.probe!.duration - 3)).toBeLessThan(0.2);
      expect(split.files).toEqual(['reference.mp4']);
    });
    await test.step('a player that names its file', async () => {
      const direct = await save('/direct');
      expect(direct.saved).toMatchObject({ ok: true, silent: false });
      expect(direct.probe!.sha256).toBe(sha('both.mp4'));
    });
    await test.step('a site that refuses anything but its own player', async () => {
      const guarded = await save('/guarded');
      expect(guarded.saved).toEqual({ ok: false, code: 'not_saved', host: '127.0.0.1', reason: 'refused' });
      expect(guarded.files).toEqual([]);
    });
    await test.step('a live preview beside the video is never fetched', async () => {
      const live = await save('/live');
      expect(live.saved).toMatchObject({ ok: true, silent: false });
      expect(live.probe!.sha256).toBe(sha('both.mp4'));
      expect(hostRequests).not.toContain('live.flv');
    });
    await test.step('a save that stops receiving gives up instead of holding the call', async () => {
      const started = Date.now();
      const stalled = await save('/stalled');
      expect(stalled.saved).toEqual({ ok: false, code: 'not_saved', host: '127.0.0.1', reason: 'refused' });
      expect(stalled.files).toEqual([]);
      expect(Date.now() - started).toBeLessThan(90_000);
    });
    await test.step('a sign-in wall stays open for the user', async () => {
      const login = await save('/login');
      expect(login.saved).toEqual({ ok: false, code: 'no_video', host: '127.0.0.1' });
      expect((await openTabs()).some(url => url.endsWith('/login'))).toBe(true);
    });
    // Saved for the production, not delivered to the conversation as a browser download.
    expect((await orkas.invoke<any>('webAssist.downloads', { conversation_id: cid })).downloads).toEqual([]);
  } finally {
    await orkas.electronApp!.evaluate(async (_electron, args) => {
      (process as any).mainModule.require(args.root + '/src/main/features/web_assist_lifecycle.ts').finishBrowserTaskRun('account-e2e', args.cid, 'reference-page-e2e');
    }, { root, cid });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('product capture rejects an unreachable page without files and recovers with full navigation diagnostics', async ({ orkas }) => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const dir = path.join(orkas.root, 'product-capture-failure');
  fs.mkdirSync(dir);
  const checkpoint = orkas.rendererDiagnosticCheckpoint();
  const capture = (input: { url?: string; inputAbsPath?: string }) => orkas.electronApp!.evaluate(async (_electron, args) => {
    const require = (process as any).mainModule.require;
    return require(args.root + '/src/main/features/video_studio_product_capture.ts').captureProductSource({
      ...args.input, compositionDirAbs: args.dir, readRoots: [args.out], writeRoots: [args.out],
    });
  }, { input, root: path.resolve(__dirname, '../..'), dir, out: orkas.root });

  expect(await capture({ url })).toMatchObject({ ok: false, errorCode: 'E_PRODUCT_CAPTURE_LOAD' });
  expect(fs.readdirSync(dir)).toEqual([]);
  const entry = path.join(orkas.root, 'recovery.html');
  fs.writeFileSync(entry, '<!doctype html><title>Recovered product</title><h1>Recovered product</h1>');
  const recovered = await capture({ inputAbsPath: entry });
  expect(recovered).toMatchObject({ ok: true, page: { title: 'Recovered product' } });
  expect(fs.readdirSync(path.join(dir, 'assets', 'product')).length).toBeGreaterThan(0);
  await orkas.acknowledgeNavigationFailure(url, 'ERR_CONNECTION_REFUSED', checkpoint);
});
