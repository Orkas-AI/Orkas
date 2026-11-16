/**
 * Timeline render canary: the real window, the real capture and the real encoder.
 *
 * Every source clip carries its frame number as a row of black and white blocks.
 * The oracle decodes those blocks from the delivered mp4, so "the right picture on
 * the right frame" is read from the output and is independent of the code that put
 * it there. Footage placed one frame late is the negative control: the same oracle
 * has to see it fail, or a pass here would mean nothing.
 *
 * Deterministic and offline. `--perf` (see run-video-timeline-canary.mjs) adds a
 * 60 second 1080x1920 measurement for comparing machines.
 *
 * Exit codes: 0 pass, 1 a case failed, 2 this host has no usable window.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { nativeImage } from 'electron';

type Result = Record<string, unknown> & { ok: boolean; errorCode?: string; message?: string };
type Timeline = {
  renderVideoTimeline: (p: Record<string, unknown>) => Promise<Result>;
  sheetVideoTimeline: (p: Record<string, unknown>) => Promise<Result>;
  checkVideoTimeline: (p: Record<string, unknown>) => Promise<Result>;
};
type Runtime = { bundledFfmpegPaths: () => { ffmpeg?: string; ffprobe?: string } };

let timelineApi: Timeline;
let ffmpeg = '';
let ffprobe = '';

const BLOCKS = 12;
const WIDTH = 540;
const HEIGHT = 960;
const FPS = 30;
const SOURCE_FRAMES = 120;

function run(bin: string, args: string[], input?: Buffer): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr }));
    child.stdin.on('error', () => { /* ffmpeg may close early */ });
    child.stdin.end(input);
  });
}

function numberedFrame(index: number, width: number, height: number): Buffer {
  const frame = Buffer.alloc(width * height, 0x40);
  const blockWidth = Math.floor(width / BLOCKS);
  const blockHeight = Math.floor(height / 8);
  for (let bit = 0; bit < BLOCKS; bit += 1) {
    const value = (index >> bit) & 1 ? 0xff : 0x00;
    for (let y = 0; y < blockHeight; y += 1) {
      frame.fill(value, y * width + bit * blockWidth, y * width + (bit + 1) * blockWidth);
    }
  }
  return frame;
}

async function numberedClip(file: string, frames: number, width = WIDTH, height = HEIGHT, fps = FPS, withTone = false): Promise<void> {
  const raw = Buffer.concat(Array.from({ length: frames }, (_item, index) => numberedFrame(index, width, height)));
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0'];
  if (withTone) args.push('-f', 'lavfi', '-t', String(frames / fps), '-i', 'sine=frequency=440:sample_rate=48000');
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', '-preset', 'veryfast', '-g', '12');
  if (withTone) args.push('-c:a', 'aac');
  args.push(file);
  const encoded = await run(ffmpeg, args, raw);
  if (encoded.code !== 0) throw new Error(`fixture encode failed: ${encoded.stderr.slice(-300)}`);
}

/** Frame numbers shown in a video, read from its pixels. */
async function decodeFrameNumbers(file: string, width = WIDTH, height = HEIGHT): Promise<number[]> {
  const scaledWidth = 120;
  const scaledHeight = Math.round((height / width) * scaledWidth / 2) * 2;
  const decoded = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-vf', `scale=${scaledWidth}:${scaledHeight}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1']);
  if (decoded.code !== 0) throw new Error(`decode failed: ${decoded.stderr.slice(-300)}`);
  const frameBytes = scaledWidth * scaledHeight;
  const numbers: number[] = [];
  const row = Math.floor(scaledHeight / 16);
  for (let offset = 0; offset + frameBytes <= decoded.stdout.length; offset += frameBytes) {
    let value = 0;
    for (let bit = 0; bit < BLOCKS; bit += 1) {
      const x = Math.floor((bit + 0.5) * (scaledWidth / BLOCKS));
      if (decoded.stdout[offset + row * scaledWidth + x] > 128) value |= 1 << bit;
    }
    numbers.push(value);
  }
  return numbers;
}

function readNumberFromPng(bytes: Buffer, width = WIDTH, height = HEIGHT): number {
  const image = nativeImage.createFromBuffer(bytes);
  const bitmap = image.toBitmap();
  const size = image.getSize();
  const row = Math.floor((height / 16) * (size.height / height));
  let value = 0;
  for (let bit = 0; bit < BLOCKS; bit += 1) {
    const x = Math.floor((bit + 0.5) * (width / BLOCKS) * (size.width / width));
    const blue = bitmap[(row * size.width + x) * 4];
    if (blue > 128) value |= 1 << bit;
  }
  return value;
}

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_item, index) => start + index);
}

type Project = {
  production: string;
  video: string;
  cache: string;
  out: string;
  writeManifest: (manifest: unknown) => Promise<void>;
  writePage: (html: string) => Promise<void>;
  renderOptions: (output?: string) => Record<string, unknown>;
};

async function project(root: string, label: string, assets: unknown[]): Promise<Project> {
  const production = path.join(root, label);
  const video = path.join(production, 'videos', 'main');
  const cache = path.join(root, label, '.cache');
  await fs.mkdir(video, { recursive: true });
  await fs.writeFile(path.join(production, 'assets.json'), JSON.stringify({ assets }), 'utf8');
  const out = path.join(production, 'render', 'out.mp4');
  return {
    production,
    video,
    cache,
    out,
    writeManifest: (manifest) => fs.writeFile(path.join(video, 'manifest.json'), JSON.stringify(manifest), 'utf8'),
    writePage: (html) => fs.writeFile(path.join(video, 'index.html'), html, 'utf8'),
    renderOptions: (output = out) => ({
      productionDirAbs: production,
      videoDirAbs: video,
      allowedRoots: [root],
      outputAbsPath: output,
      segmentCacheDirAbs: cache,
      quality: 'standard',
    }),
  };
}

function page(sectionsHtml: string, script = '', head = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
${head}
<style>
html, body { width: ${WIDTH}px; height: ${HEIGHT}px; margin: 0; overflow: hidden; background: #123; color: #fff; }
main { position: relative; width: 100%; height: 100%; overflow: hidden; }
section { position: absolute; inset: 0; }
h1 { position: absolute; left: 40px; right: 40px; top: 45%; margin: 0; font: 700 44px sans-serif; }
</style>
</head>
<body>
<main data-composition-id="main">
${sectionsHtml}
</main>
<script>window.__timelines = {};${script}</script>
</body>
</html>`;
}

function manifest(scenes: unknown[], extra: Record<string, unknown> = {}) {
  return {
    schema_version: 3,
    id: 'main',
    label: 'Canary',
    canvas: { width: WIDTH, height: HEIGHT, fps: FPS },
    scenes,
    ...extra,
  };
}

function diff(actual: number[], expected: number[]): string[] {
  const failures: string[] = [];
  if (actual.length !== expected.length) failures.push(`expected ${expected.length} frames, got ${actual.length}`);
  const wrong = expected.flatMap((value, index) => (actual[index] === value ? [] : [`#${index}: ${actual[index]} != ${value}`]));
  if (wrong.length) failures.push(`${wrong.length} wrong frames, first: ${wrong.slice(0, 5).join(', ')}`);
  return failures;
}

async function fileBytes(file: string): Promise<Buffer> {
  return fs.readFile(file);
}

type Case = { name: string; run: () => Promise<string[]> };

class NoWindow extends Error {}

function assertWindow(result: Result): void {
  const text = `${result.errorCode || ''} ${result.message || ''}`;
  if (/BrowserWindow unavailable/.test(text)) throw new NoWindow(text);
}

function buildCases(root: string, clipFile: string): Case[] {
  const clipAssets = [{ id: 'clip', kind: 'video', label: 'Numbered', path: clipFile, origin: 'generated' }];
  return [
    {
      name: 'every delivered frame shows the source frame the timeline asked for',
      run: async () => {
        const p = await project(root, 'accuracy', clipAssets);
        await p.writeManifest(manifest([
          { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 1 }] },
          { id: 'b', clips: [{ id: 'c2', asset: 'clip', in: 1.4, dur: 0.5 }, { id: 'c3', asset: 'clip', in: 0.4, dur: 0.5 }] },
          // Thirds of a second land between microseconds: the seek must not round down a frame.
          { id: 'c', clips: [{ id: 'c4', asset: 'clip', in: 1 / 3, dur: 1 / 3 }] },
        ]));
        const result = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(result);
        if (!result.ok) return [`render failed: ${result.errorCode} ${result.message}`];
        const expected = [...range(0, 30), ...range(42, 15), ...range(12, 15), ...range(10, 10)];
        return diff(await decodeFrameNumbers(p.out), expected);
      },
    },
    {
      name: 'negative control: the oracle catches footage one frame off',
      run: async () => {
        const p = await project(root, 'negative-control', clipAssets);
        await p.writeManifest(manifest([{ id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 1 / FPS, dur: 1 }] }]));
        const result = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(result);
        if (!result.ok) return [`render failed: ${result.errorCode} ${result.message}`];
        const wrong = diff(await decodeFrameNumbers(p.out), range(0, FPS));
        return wrong.length ? [] : ['footage one frame late read as correct, so this oracle proves nothing'];
      },
    },
    {
      name: 'reordering scenes re-renders nothing and moves the pictures',
      run: async () => {
        const p = await project(root, 'reorder', clipAssets);
        const a = { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 0.5 }] };
        const b = { id: 'b', clips: [{ id: 'c2', asset: 'clip', in: 2, dur: 0.5 }] };
        await p.writeManifest(manifest([a, b]));
        const first = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(first);
        if (!first.ok) return [`first render failed: ${first.errorCode} ${first.message}`];
        await p.writeManifest(manifest([b, a]));
        const second = await timelineApi.renderVideoTimeline(p.renderOptions());
        if (!second.ok) return [`second render failed: ${second.errorCode} ${second.message}`];
        const failures = diff(await decodeFrameNumbers(p.out), [...range(60, 15), ...range(0, 15)]);
        const counts = second.scene_segments as { rendered: number; reused: number };
        if (counts.rendered !== 0 || counts.reused !== 2) failures.push(`expected 0 rendered and 2 reused, got ${JSON.stringify(counts)}`);
        return failures;
      },
    },
    {
      name: 'changing one scene\'s words re-renders that scene alone and shows the new words',
      run: async () => {
        const p = await project(root, 'text-edit', clipAssets);
        await p.writePage(page(`
<section data-scene-id="a"><h1 data-slot="line">x</h1></section>
<section data-scene-id="b"><h1 data-slot="line">x</h1></section>`));
        const write = (line: string) => p.writeManifest(manifest([
          { id: 'a', duration: 0.5, text: { line: { value: 'Same words' } } },
          { id: 'b', duration: 0.5, text: { line: { value: line } } },
        ]));
        await write('WWWWWW');
        const first = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(first);
        if (!first.ok) return [`first render failed: ${first.errorCode} ${first.message}`];
        const firstFrames = path.join(p.production, 'first');
        await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '0.75', '-i', p.out, '-frames:v', '1', `${firstFrames}.png`]);
        await write('i');
        const second = await timelineApi.renderVideoTimeline(p.renderOptions());
        if (!second.ok) return [`second render failed: ${second.errorCode} ${second.message}`];
        const failures: string[] = [];
        const counts = second.scene_segments as { rendered: number; reused: number };
        if (counts.rendered !== 1 || counts.reused !== 1) failures.push(`expected 1 rendered and 1 reused, got ${JSON.stringify(counts)}`);
        await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '0.75', '-i', p.out, '-frames:v', '1', `${firstFrames}-b.png`]);
        const before = await fileBytes(`${firstFrames}.png`);
        const after = await fileBytes(`${firstFrames}-b.png`);
        if (before.equals(after)) failures.push('scene b looks the same after its words changed');
        return failures;
      },
    },
    {
      name: 'a scene taken off the timeline re-renders nothing and never shows, with its section and motion still in the page',
      run: async () => {
        const p = await project(root, 'removed-scene', clipAssets);
        await p.writePage(page(`
<section data-scene-id="a" style="background:#000"></section>
<section data-scene-id="b" style="background:#fff"></section>
<section data-scene-id="c" style="background:#000"></section>`, `
window.__timelines = window.__timelines || {};
// ORKAS-SCENE-MOTION-BEGIN:b
window.__timelines.b = { pause() {}, seek() {}, time() { return 0; }, duration() { return 0.5; } };
// ORKAS-SCENE-MOTION-END:b
`));
        const a = { id: 'a', duration: 0.5 };
        const b = { id: 'b', duration: 0.5 };
        const c = { id: 'c', duration: 0.5 };
        await p.writeManifest(manifest([a, b, c]));
        const first = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(first);
        if (!first.ok) return [`first render failed: ${first.errorCode} ${first.message}`];
        await p.writeManifest(manifest([a, c]));
        const failures: string[] = [];
        const checked = await timelineApi.checkVideoTimeline({
          productionDirAbs: p.production,
          videoDirAbs: p.video,
          allowedRoots: [root],
          segmentCacheDirAbs: p.cache,
        });
        const blocking = (checked.issues ?? []) as Array<{ code: string; severity: string }>;
        if (blocking.some((issue) => issue.severity === 'error')) failures.push(`the check refused it: ${JSON.stringify(blocking)}`);
        const second = await timelineApi.renderVideoTimeline(p.renderOptions());
        if (!second.ok) return [...failures, `second render failed: ${second.errorCode} ${second.message}`];
        const counts = second.scene_segments as { rendered: number; reused: number };
        if (counts.rendered !== 0 || counts.reused !== 2) failures.push(`expected 0 rendered and 2 reused, got ${JSON.stringify(counts)}`);
        const sheet = await timelineApi.sheetVideoTimeline({
          productionDirAbs: p.production,
          videoDirAbs: p.video,
          allowedRoots: [root],
          segmentCacheDirAbs: p.cache,
          outputDirAbs: path.join(p.production, 'sheet'),
          times: [0.25, 0.75],
        });
        if (!sheet.ok) return [...failures, `sheet failed: ${sheet.errorCode} ${sheet.message}`];
        for (const [index, sample] of (sheet.samples as Array<{ brightness: number }>).entries()) {
          if (sample.brightness > 60) failures.push(`the removed white scene shows in sample ${index} (brightness ${sample.brightness})`);
        }
        return failures;
      },
    },
    {
      name: 'an interrupted render finishes only what is missing',
      run: async () => {
        const p = await project(root, 'resume', clipAssets);
        await p.writeManifest(manifest([
          { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 0.5 }] },
          { id: 'b', clips: [{ id: 'c2', asset: 'clip', in: 1, dur: 0.5 }] },
          { id: 'c', clips: [{ id: 'c3', asset: 'clip', in: 2, dur: 0.5 }] },
        ]));
        const controller = new AbortController();
        let sawSecond = false;
        const aborted = await timelineApi.renderVideoTimeline({
          ...p.renderOptions(),
          signal: controller.signal,
          onProgress: (event: { data?: { sceneId?: string } }) => {
            if (event.data?.sceneId === 'b' && !sawSecond) {
              sawSecond = true;
              controller.abort();
            }
          },
        });
        assertWindow(aborted);
        const failures: string[] = [];
        if (aborted.ok || aborted.errorCode !== 'E_RENDER_ABORTED') failures.push(`expected an abort, got ${aborted.errorCode}`);
        if (await fs.stat(p.out).then(() => true, () => false)) failures.push('an aborted render published a file');
        const resumed = await timelineApi.renderVideoTimeline(p.renderOptions());
        if (!resumed.ok) return [...failures, `resume failed: ${resumed.errorCode} ${resumed.message}`];
        const counts = resumed.scene_segments as { rendered: number; reused: number };
        if (counts.reused !== 1 || counts.rendered !== 2) failures.push(`expected 2 rendered and 1 reused, got ${JSON.stringify(counts)}`);
        failures.push(...diff(await decodeFrameNumbers(p.out), [...range(0, 15), ...range(30, 15), ...range(60, 15)]));
        return failures;
      },
    },
    {
      name: 'a frame preview shows the same picture the render does, in any order',
      run: async () => {
        const p = await project(root, 'sheet', clipAssets);
        await p.writeManifest(manifest([
          { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 1 }] },
          { id: 'b', clips: [{ id: 'c2', asset: 'clip', in: 2, dur: 1 }] },
        ]));
        const outputDirAbs = path.join(p.production, 'sheet');
        const sheet = await timelineApi.sheetVideoTimeline({
          productionDirAbs: p.production,
          videoDirAbs: p.video,
          allowedRoots: [root],
          segmentCacheDirAbs: p.cache,
          outputDirAbs,
          times: [1.5, 0.2, 1.9, 0],
        });
        assertWindow(sheet);
        if (!sheet.ok) return [`sheet failed: ${sheet.errorCode} ${sheet.message}`];
        const samples = sheet.samples as Array<{ path: string }>;
        const failures: string[] = [];
        // 1.5s is frame 15 of scene b from source frame 60; 0.2s is source frame 6.
        const expected = [75, 6, 87, 0];
        for (const [index, sample] of samples.entries()) {
          const shown = readNumberFromPng(await fileBytes(sample.path));
          if (shown !== expected[index]) failures.push(`sample ${index} shows ${shown}, expected ${expected[index]}`);
        }
        if (!(sheet.contact_sheet && await fs.stat(String(sheet.contact_sheet)).then(() => true, () => false))) failures.push('no contact sheet was written');
        return failures;
      },
    },
    {
      name: 'relative images, stylesheets and scene-local GSAP motion all work from the compiled page',
      run: async () => {
        const p = await project(root, 'resources', []);
        const vendor = path.join(p.video, 'assets');
        await fs.mkdir(vendor, { recursive: true });
        const png = nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 0xff), { width: 16, height: 16 }).toPNG();
        await fs.writeFile(path.join(vendor, 'white.png'), png);
        await fs.writeFile(path.join(p.video, 'style.css'), 'h1 { color: #fff; } .bar { position: absolute; left: 0; top: 0; width: 100px; height: 100px; background: url(./assets/white.png); }', 'utf8');
        await p.writePage(page(`
<section data-scene-id="moving"><div class="bar"></div><img src="./assets/white.png" style="position:absolute;right:0;bottom:0;width:60px;height:60px" alt=""></section>`, `
// ORKAS-SCENE-MOTION-BEGIN:moving
window.__timelines.moving = gsap.timeline({ paused: true }).to('.bar', { x: ${WIDTH - 100}, duration: 1, ease: 'none' }, 0);
// ORKAS-SCENE-MOTION-END:moving
`, '<script src="./assets/vendor/gsap.min.js"></script><link rel="stylesheet" href="./style.css">'));
        await p.writeManifest(manifest([{ id: 'moving', duration: 1 }]));
        const sheet = await timelineApi.sheetVideoTimeline({
          productionDirAbs: p.production,
          videoDirAbs: p.video,
          allowedRoots: [root],
          segmentCacheDirAbs: p.cache,
          outputDirAbs: path.join(p.production, 'sheet'),
          times: [0, 0.5],
        });
        assertWindow(sheet);
        if (!sheet.ok) return [`sheet failed: ${sheet.errorCode} ${sheet.message}`];
        const samples = sheet.samples as Array<{ path: string }>;
        const pixel = async (index: number, x: number, y: number) => {
          const image = nativeImage.createFromBuffer(await fileBytes(samples[index].path));
          const bitmap = image.toBitmap();
          const size = image.getSize();
          return bitmap[(y * size.width + x) * 4];
        };
        const failures: string[] = [];
        if (await pixel(0, 50, 50) < 200) failures.push('the stylesheet background is missing at the start');
        if (await pixel(1, 50, 50) > 200) failures.push('the bar did not move off its start position');
        if (await pixel(1, Math.floor(WIDTH / 2) - 20, 50) < 200) failures.push('the bar is not at the middle at 0.5s');
        if (await pixel(0, WIDTH - 30, HEIGHT - 30) < 200) failures.push('the relative <img> did not load');
        return failures;
      },
    },
    {
      name: 'a slot in a stacked scene never leaks into another scene\'s frames',
      run: async () => {
        const p = await project(root, 'isolation', clipAssets);
        await p.writePage(page(`
<section data-scene-id="a"><h1 data-slot="line">x</h1></section>
<section data-scene-id="b" style="background:#fff"></section>`));
        await p.writeManifest(manifest([
          { id: 'a', duration: 0.2, text: { line: { value: 'Hello' } } },
          { id: 'b', duration: 0.2 },
        ]));
        const sheet = await timelineApi.sheetVideoTimeline({
          productionDirAbs: p.production,
          videoDirAbs: p.video,
          allowedRoots: [root],
          segmentCacheDirAbs: p.cache,
          outputDirAbs: path.join(p.production, 'sheet'),
          times: [0.1, 0.3],
        });
        assertWindow(sheet);
        if (!sheet.ok) return [`sheet failed: ${sheet.errorCode} ${sheet.message}`];
        const [first, second] = sheet.samples as Array<{ brightness: number; contrast: number }>;
        const failures: string[] = [];
        if (first.brightness > 120) failures.push(`scene a shows scene b's white background (brightness ${first.brightness})`);
        if (second.brightness < 200) failures.push(`scene b is not fully visible (brightness ${second.brightness})`);
        return failures;
      },
    },
    {
      name: 'the current scene shows even when the page hides its sections by default',
      run: async () => {
        const p = await project(root, 'hidden-sections', clipAssets);
        await p.writePage(page(`
<section data-scene-id="a" style="background:#fff"></section>
<section data-scene-id="b"></section>`, '', '<style>section { display: none; }</style>'));
        await p.writeManifest(manifest([{ id: 'a', duration: 0.2 }, { id: 'b', duration: 0.2 }]));
        const sheet = await timelineApi.sheetVideoTimeline({
          productionDirAbs: p.production,
          videoDirAbs: p.video,
          allowedRoots: [root],
          segmentCacheDirAbs: p.cache,
          outputDirAbs: path.join(p.production, 'sheet'),
          times: [0.1, 0.3],
        });
        assertWindow(sheet);
        if (!sheet.ok) return [`sheet failed: ${sheet.errorCode} ${sheet.message}`];
        const [first, second] = sheet.samples as Array<{ brightness: number }>;
        const failures: string[] = [];
        if (first.brightness < 200) failures.push(`scene a stayed hidden (brightness ${first.brightness})`);
        if (second.brightness > 120) failures.push(`scene a showed through scene b (brightness ${second.brightness})`);
        return failures;
      },
    },
    {
      name: 'an overlay clip plays its own frames over the sequence, without lengthening the scene',
      run: async () => {
        const p = await project(root, 'overlay', clipAssets);
        await p.writePage(page(`
<section data-scene-id="a">
  <img data-clip="under" style="position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover" alt="">
  <img data-clip="corner" style="position:absolute;left:0;top:${HEIGHT / 2}px;width:100%;height:${HEIGHT / 2}px;object-fit:fill" alt="">
</section>`));
        await p.writeManifest(manifest([{
          id: 'a',
          clips: [
            { id: 'under', asset: 'clip', in: 0, dur: 1 },
            { id: 'corner', asset: 'clip', in: 2, dur: 0.5, at: 0.25 },
          ],
        }]));
        const result = await timelineApi.sheetVideoTimeline({
          productionDirAbs: p.production,
          videoDirAbs: p.video,
          allowedRoots: [root],
          segmentCacheDirAbs: p.cache,
          outputDirAbs: path.join(p.production, 'sheet'),
          times: [0.1, 0.5, 0.9],
        });
        assertWindow(result);
        if (!result.ok) return [`sheet failed: ${result.errorCode} ${result.message}`];
        const failures: string[] = [];
        const samples = result.samples as Array<{ path: string }>;
        const lowerRow = (bytes: Buffer) => {
          const image = nativeImage.createFromBuffer(bytes);
          const size = image.getSize();
          const bitmap = image.toBitmap();
          // The overlay squeezes the clip into the lower half, so its blocks sit
          // in the top sixteenth of that half.
          const row = Math.floor(size.height / 2 + (size.height / 2) / 16);
          let value = 0;
          for (let bit = 0; bit < BLOCKS; bit += 1) {
            const x = Math.floor((bit + 0.5) * (size.width / BLOCKS));
            if (bitmap[(row * size.width + x) * 4] > 128) value |= 1 << bit;
          }
          return value;
        };
        const at = await Promise.all(samples.map(async (sample) => fileBytes(sample.path)));
        if (readNumberFromPng(at[1]) !== 15) failures.push(`the sequence shows ${readNumberFromPng(at[1])} at 0.5s, expected 15`);
        // 0.5s is 0.25s into the overlay, which starts at source frame 60.
        if (lowerRow(at[1]) !== 67) failures.push(`the overlay shows ${lowerRow(at[1])} at 0.5s, expected 67`);
        const blank = 0x40;
        const image = nativeImage.createFromBuffer(at[2]);
        const size = image.getSize();
        const pixel = image.toBitmap()[(Math.floor(size.height * 0.75) * size.width + 10) * 4];
        if (Math.abs(pixel - blank) > 24) failures.push(`the overlay should be gone at 0.9s; the lower half reads ${pixel}`);
        return failures;
      },
    },
    {
      name: 'words on a marked product are asked off it, measured on the glyphs rather than the element box',
      run: async () => {
        const p = await project(root, 'product-cover', [
          // The product is the right half of the picture.
          { id: 'photo', kind: 'image', label: 'Lamp', path: 'media/photo.png', origin: 'upload', subject: [0.5, 0, 1, 1] },
        ]);
        await fs.mkdir(path.join(p.production, 'media'), { recursive: true });
        await fs.writeFile(path.join(p.production, 'media', 'photo.png'), nativeImage.createFromBitmap(Buffer.alloc(300 * 200 * 4, 0x80), { width: 300, height: 200 }).toPNG());
        const cover = 'style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"';
        // Covering the 540x960 canvas, the 300x200 picture is drawn 1440 wide and centred, so its
        // right half fills x 270 and beyond. The heading box spans 40 to 500; its short word does not.
        await p.writePage(page(`
<section data-scene-id="on"><img data-clip="a" ${cover} alt=""><span style="position:absolute;left:330px;top:120px;font:700 40px sans-serif">On the lamp</span></section>
<section data-scene-id="beside"><img data-clip="b" ${cover} alt=""><h1>Lamp</h1></section>`));
        await p.writeManifest(manifest([
          { id: 'on', clips: [{ id: 'a', asset: 'photo', in: 0, dur: 0.5 }] },
          { id: 'beside', clips: [{ id: 'b', asset: 'photo', in: 0, dur: 0.5 }] },
        ]));
        const checked = await timelineApi.checkVideoTimeline({
          productionDirAbs: p.production,
          videoDirAbs: p.video,
          allowedRoots: [root],
          segmentCacheDirAbs: p.cache,
        });
        assertWindow(checked);
        if (!checked.ok) return [`check failed: ${checked.errorCode} ${checked.message}`];
        const message = String(checked.message || '');
        const failures: string[] = [];
        if (!message.includes('Words cover the product in "On the lamp" (on).')) failures.push(`no request for the words on the product: ${message}`);
        if (message.includes('(beside)')) failures.push(`the short heading beside the product was counted: ${message}`);
        return failures;
      },
    },
    {
      name: 'captions appear on narrated scenes only, and follow the words',
      run: async () => {
        const p = await project(root, 'captions', []);
        await p.writePage(page(`
<section data-scene-id="talk" style="background:#000"></section>
<section data-scene-id="quiet" style="background:#000"></section>`));
        await p.writeManifest(manifest([
          { id: 'talk', duration: 2, narration: { text: 'First sentence here. Second sentence here.' } },
          { id: 'quiet', duration: 1 },
        ], { captions: { enabled: true } }));
        const result = await timelineApi.sheetVideoTimeline({
          productionDirAbs: p.production,
          videoDirAbs: p.video,
          allowedRoots: [root],
          segmentCacheDirAbs: p.cache,
          outputDirAbs: path.join(p.production, 'sheet'),
          times: [0.2, 1.8, 2.5],
        });
        assertWindow(result);
        if (!result.ok) return [`sheet failed: ${result.errorCode} ${result.message}`];
        const samples = result.samples as Array<{ path: string; hash: string }>;
        const brightPixels = async (file: string) => {
          const image = nativeImage.createFromBuffer(await fileBytes(file));
          const size = image.getSize();
          const bitmap = image.toBitmap();
          let count = 0;
          for (let y = Math.floor(size.height * 0.6); y < size.height; y += 1) {
            for (let x = 0; x < size.width; x += 1) {
              if (bitmap[(y * size.width + x) * 4] > 200) count += 1;
            }
          }
          return count;
        };
        const failures: string[] = [];
        if (await brightPixels(samples[0].path) < 50) failures.push('no caption on the narrated scene');
        if (samples[0].hash === samples[1].hash) failures.push('the caption did not change between sentences');
        if (await brightPixels(samples[2].path) > 0) failures.push('a caption leaked onto the scene with no narration');
        return failures;
      },
    },
    {
      name: 'an upgraded page plays each scene from its old position on its one timeline, in any order',
      run: async () => {
        const p = await project(root, 'absolute-page', []);
        // One timeline across the whole film, the way an older page was written: a bar
        // that crosses the frame over two seconds shows which moment each frame came from.
        await p.writePage(page(
          '<section data-scene-id="a"><div class="bar"></div></section><section data-scene-id="b"><div class="bar"></div></section>',
          `window.__timelines.old = gsap.timeline({ paused: true }).to('.bar', { x: ${WIDTH}, duration: 2, ease: 'none' }, 0);`,
          `<script src="./assets/vendor/gsap.min.js"></script><style>.bar { position: absolute; left: 0; top: 0; width: 40px; height: 40px; background: #fff; }</style>`,
        ));
        const upgraded = { absolute_page: { timeline_key: 'old', scene_starts: { a: 0, b: 1 } }, upgraded_from: 'project/composition' };
        const a = { id: 'a', duration: 1 };
        const b = { id: 'b', duration: 1 };
        await p.writeManifest(manifest([a, b], upgraded));
        const first = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(first);
        if (!first.ok) return [`first render failed: ${first.errorCode} ${first.message}`];
        // Where the bar's left edge sits in the frame, as a share of the width.
        const barAt = async (seconds: number): Promise<number> => {
          const frame = await run(ffmpeg, [
            '-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', p.out, '-frames:v', '1',
            '-vf', `crop=${WIDTH}:2:0:10,scale=${WIDTH}:1`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
          ]);
          const left = frame.stdout.findIndex((value) => value > 128);
          return left / WIDTH;
        };
        const near = (actual: number, expected: number) => Math.abs(actual - expected) < 0.06;
        const failures: string[] = [];
        for (const [seconds, expected] of [[0.1, 0.05], [0.9, 0.45], [1.1, 0.55], [1.9, 0.95]] as const) {
          const at = await barAt(seconds);
          if (!near(at, expected)) failures.push(`at ${seconds}s the bar is at ${at.toFixed(2)}, expected about ${expected}`);
        }
        await p.writeManifest(manifest([b, a], upgraded));
        const second = await timelineApi.renderVideoTimeline(p.renderOptions());
        if (!second.ok) return [...failures, `reordered render failed: ${second.errorCode} ${second.message}`];
        const counts = second.scene_segments as { rendered: number; reused: number };
        if (counts.rendered !== 0 || counts.reused !== 2) failures.push(`expected 0 rendered and 2 reused, got ${JSON.stringify(counts)}`);
        for (const [seconds, expected] of [[0.1, 0.55], [0.9, 0.95], [1.1, 0.05], [1.9, 0.45]] as const) {
          const at = await barAt(seconds);
          if (!near(at, expected)) failures.push(`after reordering, at ${seconds}s the bar is at ${at.toFixed(2)}, expected about ${expected}`);
        }
        return failures;
      },
    },
    {
      name: 'an upgraded page that reveals its first scene at position 0 shows it on frame 0',
      run: async () => {
        const p = await project(root, 'absolute-frame-zero', []);
        // The old scaffold hides every scene and the timeline reveals each with a set.
        await p.writePage(page(
          '<section class="clip" id="s-a" data-scene-id="a" data-start="0" data-duration="1" style="background:#fff"></section>'
            + '<section class="clip" id="s-b" data-scene-id="b" data-start="1" data-duration="1" style="background:#fff"></section>',
          `const tl = gsap.timeline({ paused: true }); window.__timelines.old = tl;
tl.set('#s-a', { opacity: 1 }, 0).set('#s-a', { opacity: 0 }, 1);
tl.set('#s-b', { opacity: 1 }, 1).set('#s-b', { opacity: 0 }, 2);`,
          '<script src="./assets/vendor/gsap.min.js"></script><style>.clip { opacity: 0; }</style>',
        ));
        const upgraded = { absolute_page: { timeline_key: 'old', scene_starts: { a: 0, b: 1 } }, upgraded_from: 'project/composition' };
        await p.writeManifest(manifest([{ id: 'a', duration: 1 }, { id: 'b', duration: 1 }], upgraded));
        const result = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(result);
        if (!result.ok) return [`render failed: ${result.errorCode} ${result.message}`];
        const decoded = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', p.out, '-map', '0:v:0', '-vf', 'scale=4:4', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
        const frames: number[] = [];
        for (let offset = 0; offset + 16 <= decoded.stdout.length; offset += 16) frames.push(decoded.stdout[offset + 5]);
        const dark = frames.flatMap((value, index) => (value < 128 ? [index] : []));
        return dark.length ? [`${dark.length} of ${frames.length} frames are blank, first: ${dark.slice(0, 8).join(', ')}`] : [];
      },
    },
    {
      name: 'an upgraded page shows what its own timeline shows, even where the scene list disagrees',
      run: async () => {
        const p = await project(root, 'absolute-own-visibility', []);
        // Narration moved the scene list but not the page: the delivered video switched
        // pictures at 1.2s, when the timeline says, not at 1s. Scene c was rewritten after the
        // upgrade with its own timeline, so nothing on the old timeline knows about it.
        await p.writePage(page(
          '<section class="clip" id="s-a" data-scene-id="a" style="background:#fff"></section>'
            + '<section class="clip" id="s-b" data-scene-id="b" style="background:#808080"></section>'
            + '<section id="s-c" data-scene-id="c" style="background:#404040"></section>',
          `const tl = gsap.timeline({ paused: true }); window.__timelines.old = tl;
tl.set('#s-a', { opacity: 1 }, 0).set('#s-a', { opacity: 0 }, 1.2);
tl.set('#s-b', { opacity: 1 }, 1.2).set('#s-b', { opacity: 0 }, 2);
window.__timelines.c = gsap.timeline({ paused: true });`,
          '<script src="./assets/vendor/gsap.min.js"></script><style>.clip { opacity: 0; }</style>',
        ));
        const upgraded = { absolute_page: { timeline_key: 'old', scene_starts: { a: 0, b: 1 } }, upgraded_from: 'project/composition' };
        await p.writeManifest(manifest([{ id: 'a', duration: 1 }, { id: 'b', duration: 1 }, { id: 'c', duration: 0.5 }], upgraded));
        const result = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(result);
        if (!result.ok) return [`render failed: ${result.errorCode} ${result.message}`];
        const decoded = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', p.out, '-map', '0:v:0', '-vf', 'scale=4:4', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
        const wrong: string[] = [];
        const count = decoded.stdout.length / 16;
        for (let frame = 0; frame < count; frame += 1) {
          const cells = decoded.stdout.subarray(frame * 16, frame * 16 + 16);
          const mean = cells.reduce((sum, value) => sum + value, 0) / 16;
          const shade = frame < 36 ? 0xff : frame < 60 ? 0x80 : 0x40;
          if (Math.abs(mean - shade) > 24) wrong.push(`#${frame}: ${Math.round(mean)} != ${shade}`);
        }
        const failures = count === 75 ? [] : [`expected 75 frames, got ${count}`];
        return wrong.length ? [...failures, `${wrong.length} frames show another picture: ${wrong.slice(0, 6).join(', ')}`] : failures;
      },
    },
    {
      name: 'the check refuses an upgraded page whose scene list and timeline disagree, and only then',
      run: async () => {
        const p = await project(root, 'absolute-disagree', []);
        // Reordered by rewriting the page's times, with scene_starts left behind: a live run
        // delivered this, in the wrong order, reporting the order it was asked for.
        await p.writePage(page(
          '<section class="clip" id="s-a" data-scene-id="a" style="background:#fff"></section>'
            + '<section class="clip" id="s-b" data-scene-id="b" style="background:#808080"></section>',
          `const tl = gsap.timeline({ paused: true }); window.__timelines.old = tl;
tl.set('#s-b', { opacity: 1 }, 0).set('#s-b', { opacity: 0 }, 1);
tl.set('#s-a', { opacity: 1 }, 1).set('#s-a', { opacity: 0 }, 2);`,
          '<script src="./assets/vendor/gsap.min.js"></script><style>.clip { opacity: 0; }</style>',
        ));
        const scenes = [{ id: 'a', duration: 1 }, { id: 'b', duration: 1 }];
        const withStarts = (scene_starts: Record<string, number>) => manifest(scenes, { absolute_page: { timeline_key: 'old', scene_starts }, upgraded_from: 'project/composition' });
        const check = () => timelineApi.checkVideoTimeline({ productionDirAbs: p.production, videoDirAbs: p.video, allowedRoots: [root], segmentCacheDirAbs: p.cache });
        await p.writeManifest(withStarts({ a: 0, b: 1 }));
        const refused = await check();
        assertWindow(refused);
        const failures: string[] = [];
        const codes = ((refused.issues ?? []) as Array<{ code: string }>).map((issue) => issue.code);
        if (refused.ok || !codes.includes('PAGE_SCENE_NOT_SHOWN')) failures.push(`expected PAGE_SCENE_NOT_SHOWN, got ok=${refused.ok} ${codes.join(',')}`);
        await p.writeManifest(withStarts({ a: 1, b: 0 }));
        const agreed = await check();
        if (!agreed.ok) failures.push(`scenes that agree with the page were refused: ${agreed.message}`);
        return failures;
      },
    },
    {
      name: 'a large image is on screen from the first frame of a scene that reveals itself',
      run: async () => {
        const p = await project(root, 'large-image', []);
        const assetsDir = path.join(p.video, 'assets');
        await fs.mkdir(assetsDir, { recursive: true });
        // Big enough that Chromium decodes it in the background instead of while painting.
        for (const name of ['first.jpg', 'second.jpg']) {
          const made = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=2400x3200,noise=alls=20:allf=t', '-frames:v', '1', '-q:v', '2', path.join(assetsDir, name)]);
          if (made.code !== 0) return [`could not make the image: ${made.stderr.slice(-200)}`];
        }
        // Nothing paints a hidden section, so a timeline that reveals one at its first frame
        // leaves that frame's decode still running. The old scaffold did this in every scene.
        await p.writePage(page(`
<section id="s-a" class="hide" data-scene-id="a"><img src="./assets/first.jpg" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" alt=""></section>
<section id="s-b" class="hide" data-scene-id="b" style="background:url(./assets/second.jpg) center/cover"></section>`,
        `window.__timelines.a = gsap.timeline({ paused: true }).set('#s-a', { opacity: 1 }, 0);
window.__timelines.b = gsap.timeline({ paused: true }).set('#s-b', { opacity: 1 }, 0);`,
        '<script src="./assets/vendor/gsap.min.js"></script><style>.hide { opacity: 0; }</style>'));
        await p.writeManifest(manifest([{ id: 'a', duration: 0.5 }, { id: 'b', duration: 0.5 }]));
        const result = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(result);
        if (!result.ok) return [`render failed: ${result.errorCode} ${result.message}`];
        const decoded = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', p.out, '-map', '0:v:0', '-vf', 'scale=4:4', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
        const means: number[] = [];
        for (let offset = 0; offset + 16 <= decoded.stdout.length; offset += 16) {
          means.push(decoded.stdout.subarray(offset, offset + 16).reduce((sum, value) => sum + value, 0) / 16);
        }
        const blank = means.flatMap((value, index) => (value < 128 ? [index] : []));
        return blank.length ? [`frames without the image: ${blank.join(', ')} of ${means.length}`] : [];
      },
    },
    {
      name: 'every scene starts on its own picture when the page takes a while to paint',
      run: async () => {
        const shades = [0x30, 0xa0, 0x50, 0xd0, 0x70, 0x20];
        const assets = [];
        for (const [index, shade] of shades.entries()) {
          const file = path.join(root, `still-${index}.jpg`);
          const hex = shade.toString(16).padStart(2, '0').repeat(3);
          const made = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=1536x1024,noise=alls=12:allf=t`, '-frames:v', '1', '-q:v', '2', file]);
          if (made.code !== 0) return [`could not make the image: ${made.stderr.slice(-200)}`];
          assets.push({ id: `still-${index}`, kind: 'image', label: `Still ${index}`, path: file, origin: 'upload' });
        }
        const p = await project(root, 'first-paint', assets);
        // A full-size canvas under pictures it has to scale is what outlasts the settle wait.
        // The white behind each picture and the overlap of a page nothing has switched yet are
        // what a capture taken too soon shows.
        await p.writePage(`<!doctype html><html><head><meta charset="UTF-8"><style>
html, body { width: 1080px; height: 1920px; margin: 0; overflow: hidden; background: #000; }
main { position: relative; width: 100%; height: 100%; overflow: hidden; }
section { position: absolute; inset: 0; background: #fff; }
img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
</style></head><body><main data-composition-id="main">
${shades.map((_shade, index) => `<section data-scene-id="s${index}"><img data-clip="c${index}" alt=""></section>`).join('\n')}
</main><script>window.__timelines = {};</script></body></html>`);
        await p.writeManifest({
          ...manifest(shades.map((_shade, index) => ({ id: `s${index}`, clips: [{ id: `c${index}`, asset: `still-${index}`, in: 0, dur: 0.2 }] }))),
          canvas: { width: 1080, height: 1920, fps: FPS },
        });
        const result = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(result);
        if (!result.ok) return [`render failed: ${result.errorCode} ${result.message}`];
        const decoded = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', p.out, '-map', '0:v:0', '-vf', 'scale=4:4', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
        const wrong: string[] = [];
        const count = decoded.stdout.length / 16;
        for (let frame = 0; frame < count; frame += 1) {
          const cells = decoded.stdout.subarray(frame * 16, frame * 16 + 16);
          const mean = cells.reduce((sum, value) => sum + value, 0) / 16;
          // Encoded video levels sit a little off the source's.
          const shade = shades[Math.floor(frame / 6)];
          if (Math.abs(mean - shade) > 24) wrong.push(`#${frame}: ${Math.round(mean)} != ${shade}`);
        }
        const failures = count === shades.length * 6 ? [] : [`expected ${shades.length * 6} frames, got ${count}`];
        return wrong.length ? [...failures, `${wrong.length} frames show another picture: ${wrong.slice(0, 6).join(', ')}`] : failures;
      },
    },
    {
      name: 'a timeline on absolute time is refused, with the fix named',
      run: async () => {
        const p = await project(root, 'global-timeline', []);
        await p.writePage(page('<section data-scene-id="a"></section>', 'window.__timelines.main = { pause() {}, seek() {} };'));
        await p.writeManifest(manifest([{ id: 'a', duration: 1 }]));
        const result = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(result);
        return result.errorCode === 'E_PAGE_TIMELINE_NOT_PER_SCENE' && /scene-local/.test(String(result.message))
          ? []
          : [`expected E_PAGE_TIMELINE_NOT_PER_SCENE, got ${result.errorCode}: ${result.message}`];
      },
    },
    {
      name: 'a page that throws is refused before a frame is captured',
      run: async () => {
        const p = await project(root, 'page-error', []);
        await p.writePage(page('<section data-scene-id="a"></section>', 'throw new Error("boom");'));
        await p.writeManifest(manifest([{ id: 'a', duration: 1 }]));
        const result = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(result);
        const failures = result.errorCode === 'E_PAGE_SCRIPT_ERROR' ? [] : [`expected E_PAGE_SCRIPT_ERROR, got ${result.errorCode}: ${result.message}`];
        if (await fs.stat(p.out).then(() => true, () => false)) failures.push('a broken page published a file');
        return failures;
      },
    },
    {
      name: 'check reports layout findings from the real page without rendering',
      run: async () => {
        const p = await project(root, 'check', []);
        await p.writePage(page('<section data-scene-id="a"><h1 data-slot="line" style="font-size:12px">x</h1></section>'));
        await p.writeManifest(manifest([{ id: 'a', duration: 2, text: { line: { value: 'Tiny words' } } }]));
        const result = await timelineApi.checkVideoTimeline({
          productionDirAbs: p.production,
          videoDirAbs: p.video,
          allowedRoots: [root],
          segmentCacheDirAbs: p.cache,
        });
        assertWindow(result);
        const failures: string[] = [];
        const warnings = (result.warnings ?? []) as Array<{ code: string }>;
        if (!result.ok) failures.push(`expected warnings only, got ${result.errorCode}: ${result.message}`);
        if (!warnings.some((issue) => issue.code === 'FONT_TOO_SMALL')) failures.push(`no FONT_TOO_SMALL in ${warnings.map((issue) => issue.code).join(',')}`);
        if (!warnings.some((issue) => issue.code === 'SCENE_STATIC')) failures.push('a motionless two second scene went unmentioned');
        if (!warnings.some((issue) => issue.code === 'SCENE_MOSTLY_EMPTY')) failures.push('a nearly blank frame went unmentioned');
        if (!String(result.message).includes('too small to read')) failures.push(`text below the readable size should say so at the top, got: ${String(result.message).slice(0, 200)}`);
        const review = result.visual_review as { status?: string; advisory?: boolean } | undefined;
        if (review?.status !== 'has_findings' || !review.advisory || !String(result.message).includes('slides')) failures.push('a nearly blank scene should retain advisory visual findings');
        const rendered = await timelineApi.renderVideoTimeline(p.renderOptions());
        if (!rendered.ok) failures.push(`advisory findings blocked rendering: ${rendered.errorCode}`);
        if (JSON.stringify(rendered.visual_review) !== JSON.stringify(result.visual_review)) failures.push('render lost the checked findings');
        const ship = await import('../../src/main/features/video_timeline_ship');
        const shipped = await ship.shipVideoFile({ productionDirAbs: p.production, videoDirAbs: p.video, allowedRoots: [root], videoPathAbs: p.out });
        if (!shipped.ok) failures.push(`advisory findings blocked delivery: ${shipped.errorCode}`);
        if (JSON.stringify(shipped.visual_review) !== JSON.stringify(result.visual_review)) failures.push('delivery lost the checked findings');
        // Real-looking footage: the numbered clip is deliberately a flat field.
        const busyClip = path.join(root, 'busy.mp4');
        const busy = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${WIDTH}x${HEIGHT}:r=${FPS}:d=3`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', busyClip]);
        if (busy.code !== 0) return [`fixture failed: ${busy.stderr.slice(-200)}`];
        const filled = await project(root, 'check-filled', [{ id: 'clip', kind: 'video', label: 'Busy', path: busyClip, origin: 'generated' }]);
        await filled.writeManifest(manifest([{ id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 2 }] }]));
        const clean = await timelineApi.checkVideoTimeline({
          productionDirAbs: filled.production,
          videoDirAbs: filled.video,
          allowedRoots: [root],
          segmentCacheDirAbs: filled.cache,
        });
        const moving = (clean.warnings ?? []) as Array<{ code: string }>;
        if (moving.some((issue) => issue.code === 'SCENE_STATIC')) failures.push('footage was called static');
        if ((clean.visual_review as { status?: string } | undefined)?.status !== 'no_findings') failures.push(`full-frame footage should have no sampled findings: ${JSON.stringify(clean.visual_review)}`);
        return failures;
      },
    },
    {
      name: 'a page-rendered film joins a ffmpeg-made clip of another frame rate within a frame',
      run: async () => {
        const p = await project(root, 'mixed-join', clipAssets);
        await p.writeManifest(manifest([{ id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 1 }] }]));
        const rendered = await timelineApi.renderVideoTimeline(p.renderOptions());
        assertWindow(rendered);
        if (!rendered.ok) return [`render failed: ${rendered.errorCode} ${rendered.message}`];
        const other = path.join(p.production, 'other.mp4');
        await numberedClip(other, 50, WIDTH, HEIGHT, 25, true);
        const joined = path.join(p.production, 'joined.mp4');
        // The same script the agent runs, in its own process.
        const script = path.join(process.cwd(), 'resources/builtin/marketplace/agents/79df9cc89f5f/skills/stage-edit/scripts/edit_video.js');
        const edit = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          const entry = 'require(process.argv[1])({ args: process.argv.slice(2) }).catch((err) => { console.error(err); process.exit(1); });';
          const child = spawn(process.execPath, ['-e', entry, script, '--op', 'concat', '--inputs', [p.out, other].join(','), '--output', joined], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stderr }));
        });
        if (edit.code !== 0) return [`concat failed (${edit.code}): ${edit.stderr.slice(-300)}`];
        const probed = await run(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=width,height,codec_type,nb_read_frames,r_frame_rate', '-of', 'json', joined]);
        const parsed = JSON.parse(probed.stdout.toString('utf8')) as { streams: Array<{ codec_type: string; width?: number; height?: number; nb_read_frames?: string; r_frame_rate?: string }> };
        const failures: string[] = [];
        const video = parsed.streams.find((stream) => stream.codec_type === 'video');
        // 1s at 30fps plus 2s conformed from 25fps to 30fps.
        if (Math.abs(Number(video?.nb_read_frames) - 90) > 1) failures.push(`expected 90 frames, got ${video?.nb_read_frames}`);
        if (video?.r_frame_rate !== '30/1') failures.push(`frame rate became ${video?.r_frame_rate}`);
        if (video?.width !== WIDTH || video?.height !== HEIGHT) failures.push(`canvas became ${video?.width}x${video?.height}`);
        if (!parsed.streams.some((stream) => stream.codec_type === 'audio')) failures.push('the joined file lost its audio');
        // The tool's re-encode can lag a frame behind AAC priming, and no more than that.
        const shown = (await decodeFrameNumbers(joined)).slice(0, 30);
        const off = shown.flatMap((value, index) => (value === index || value === index - 1 ? [] : [`#${index}: ${value}`]));
        if (off.length) failures.push(`${off.length} frames more than one frame off, first: ${off.slice(0, 5).join(', ')}`);
        return failures;
      },
    },
  ];
}

/** 60 seconds at 1080x1920 through the real chain, footage under a moving page. */
async function runPerf(root: string): Promise<void> {
  const width = 1080;
  const height = 1920;
  const clip = path.join(root, 'perf-clip.mp4');
  const frames = 8 * FPS;
  await numberedClip(clip, frames, width, height);
  const assets = [{ id: 'clip', kind: 'video', label: 'Numbered', path: clip, origin: 'generated' }];
  const p = await project(root, 'perf', assets);
  const sceneCount = 8;
  const sections = Array.from({ length: sceneCount }, (_item, index) => `
<section data-scene-id="s${index}"><img data-clip="c${index}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" alt="">
<h1 data-slot="line" class="line${index}" style="top:60%">x</h1></section>`).join('');
  const motion = Array.from({ length: sceneCount }, (_item, index) => `
// ORKAS-SCENE-MOTION-BEGIN:s${index}
window.__timelines.s${index} = gsap.timeline({ paused: true }).from('.line${index}', { y: 60, opacity: 0, duration: 0.6 }, 0.1);
// ORKAS-SCENE-MOTION-END:s${index}
`).join('');
  await p.writePage(page(sections, motion, '<script src="./assets/vendor/gsap.min.js"></script>').replace(`width: ${WIDTH}px; height: ${HEIGHT}px`, `width: ${width}px; height: ${height}px`));
  await p.writeManifest({
    ...manifest(Array.from({ length: sceneCount }, (_item, index) => ({
      id: `s${index}`,
      clips: [{ id: `c${index}`, asset: 'clip', in: 0, dur: 7.5 }],
      text: { line: { value: `Selling point number ${index + 1}` } },
    }))),
    canvas: { width, height, fps: FPS },
  });
  // Standard quality keeps 30fps on a software-rendered host, where final quality
  // would fall back to 24fps and change what the frames can be compared against.
  const started = Date.now();
  const result = await timelineApi.renderVideoTimeline({ ...p.renderOptions(), quality: 'standard' });
  const seconds = (Date.now() - started) / 1000;
  if (!result.ok) throw new Error(`perf render failed: ${result.errorCode} ${result.message}`);
  const numbers = await decodeFrameNumbers(p.out, width, height);
  const expectedOne = range(0, 225);
  const expected = Array.from({ length: sceneCount }, () => expectedOne).flat();
  const wrong = expected.filter((value, index) => numbers[index] !== value).length;
  const stat = await fs.stat(p.out);
  // The path this replaces, same size and rate: a page holding one <video>.
  process.stdout.write(`[video-timeline-perf] ${JSON.stringify({
    platform: `${os.platform()}-${os.arch()}`,
    cpus: os.cpus().length,
    ram_gb: Math.round(os.totalmem() / 1024 ** 3),
    video_seconds: 60,
    frames: expected.length,
    wall_seconds: Math.round(seconds * 10) / 10,
    seconds_per_video_second: Math.round((seconds / 60) * 100) / 100,
    ms_per_frame: Math.round((seconds * 1000) / expected.length),
    wrong_frames: wrong,
    decoded_frames: numbers.length,
    output_mb: Math.round(stat.size / 1024 / 1024),
    render_fps: result.fps,
    gpu: (result.render_profile as { observed_gpu_mode?: string } | undefined)?.observed_gpu_mode ?? 'unknown',
  })}\n`);
  await fs.rm(p.production, { recursive: true, force: true });
}

export async function main(): Promise<number> {
  timelineApi = await import('../../src/main/features/video_timeline_render') as unknown as Timeline;
  const runtime = await import('../../src/main/util/bundled-runtime') as unknown as Runtime;
  const bins = runtime.bundledFfmpegPaths();
  ffmpeg = bins.ffmpeg ?? '';
  ffprobe = bins.ffprobe ?? '';
  if (!ffmpeg || !ffprobe) {
    process.stderr.write('[video-timeline-canary] bundled ffmpeg is missing\n');
    return 2;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-timeline-canary-'));
  let failed = 0;
  let executed = 0;
  try {
    if (process.env.ORKAS_VIDEO_TIMELINE_PERF === '1') {
      await runPerf(root);
      return 0;
    }
    const clipFile = path.join(root, 'clip.mp4');
    await numberedClip(clipFile, SOURCE_FRAMES);
    const only = process.env.ORKAS_VIDEO_TIMELINE_CASE || '';
    for (const testCase of buildCases(root, clipFile)) {
      if (only && !testCase.name.includes(only)) continue;
      executed += 1;
      let failures: string[];
      try {
        failures = await testCase.run();
      } catch (err) {
        if (err instanceof NoWindow) {
          process.stderr.write(`[video-timeline-canary] no usable window on this host: ${err.message}\n`);
          return 2;
        }
        failures = [`threw: ${(err as Error).stack || (err as Error).message}`];
      }
      if (failures.length) {
        failed += 1;
        process.stdout.write(`FAIL ${testCase.name}\n`);
        for (const reason of failures) process.stdout.write(`     ${reason}\n`);
      } else {
        process.stdout.write(`ok   ${testCase.name}\n`);
      }
    }
    if (!executed) { failed += 1; process.stdout.write('FAIL no native cases matched the selection\n'); }
    process.stdout.write(`[video-timeline-canary] ${failed ? `${failed} failed` : 'all cases passed'} (${executed} executed)\n`);
    return failed ? 1 : 0;
  } finally {
    if (failed || process.env.ORKAS_VIDEO_TIMELINE_KEEP_ARTIFACTS === '1') {
      process.stdout.write(`[video-timeline-canary] retained synthetic artifacts: ${root}\n`);
    } else {
      await fs.rm(root, { recursive: true, force: true }).catch(() => { /* temp root */ });
    }
  }
}
