import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: function BrowserWindow() {} }));

import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';
import { runVideoProcessForTest } from '../../../src/main/features/video_studio';
import {
  savePageVideo,
  type PageMediaResponse,
  type PageVideoBrowser,
  type PageVideoDownload,
} from '../../../src/main/features/web_assist_page_video';

// A reference link opens in the task browser and the host saves the video that page
// plays. The browser is scripted here; the files are real, so picking, joining and
// measuring run against what ffmpeg reads, not against what the page claims.
let fixtures: string;
const file = (name: string) => path.join(fixtures, name);

async function make(name: string, args: string[]): Promise<void> {
  const made = await runVideoProcessForTest(bundledFfmpegPaths().ffmpeg!, ['-y', '-loglevel', 'error', ...args, file(name)], { timeoutMs: 20_000 });
  expect(made.code, name).toBe(0);
}

beforeAll(async () => {
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-page-video-'));
  const picture = (seconds: number) => ['-f', 'lavfi', '-i', `testsrc=s=160x90:d=${seconds}`];
  const sound = (seconds: number) => ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`];
  await make('both.mp4', [...picture(3), ...sound(3), '-c:v', 'libx264', '-c:a', 'aac', '-shortest']);
  await make('picture.mp4', [...picture(3), '-c:v', 'libx264']);
  await make('sound.m4a', [...sound(3), '-c:a', 'aac']);
  await make('effect.mp4', [...picture(1), ...sound(1), '-c:v', 'libx264', '-c:a', 'aac', '-shortest']);
  await make('next.mp4', [...picture(8), ...sound(8), '-c:v', 'libx264', '-c:a', 'aac', '-shortest']);
}, 60_000);
afterAll(() => { fs.rmSync(fixtures, { recursive: true, force: true }); });

type Script = {
  video?: { durationSec: number; src: string } | null;
  media?: PageMediaResponse[];
  /** What the site sends for each address; anything else is refused. */
  files?: Record<string, string>;
  refuse?: string[];
  open?: boolean;
  /** Calls before the page reports its video. */
  videoAfter?: number;
};

function browser(script: Script) {
  const events: string[] = [];
  const downloads: string[] = [];
  let probes = 0;
  const fake: PageVideoBrowser = {
    async open(url) { events.push(`open ${url}`); return script.open === false ? { ok: false } : { ok: true, tabId: 'tab-1' }; },
    async waitLoaded() { events.push('loaded'); },
    async playingVideo() { probes += 1; return probes > (script.videoAfter ?? 0) ? script.video ?? null : null; },
    media() { return script.media ?? []; },
    async download(_tab, url, savePath, limits): Promise<PageVideoDownload> {
      downloads.push(url);
      if (limits.signal.aborted) return { state: 'cancelled' };
      if (script.refuse?.includes(url)) return { state: 'refused' };
      const source = script.files?.[url];
      if (!source) return { state: 'refused' };
      if (fs.statSync(file(source)).size > limits.maxBytes) return { state: 'too_large' };
      fs.copyFileSync(file(source), savePath);
      return { state: 'completed' };
    },
    keepOpen() { events.push('keep'); },
    close() { events.push('close'); },
    release() { events.push('release'); },
  };
  return { fake, events, downloads };
}

const media = (url: string, contentType: string, hits = 1, totalBytes: number | null = 1000): PageMediaResponse => ({ url, contentType, hits, totalBytes });
const page = 'https://www.example-video.test/v/1';
const quick = { pollMs: 5, videoWaitMs: 200 };

async function probe(target: string) {
  const out = await runVideoProcessForTest(bundledFfmpegPaths().ffprobe!, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', target], { timeoutMs: 10_000 });
  const parsed = JSON.parse(out.stdout);
  return { duration: Number(parsed.format.duration), streams: parsed.streams.map((s: { codec_type: string }) => s.codec_type).sort() };
}

function target() { return fs.mkdtempSync(path.join(fixtures, 'out-')); }

describe('saving the video a page plays', () => {
  it('saves the file whose length matches the playing video, passing over a short effect clip and the next video', async () => {
    const dir = target();
    const { fake, events, downloads } = browser({
      video: { durationSec: 3, src: '' },
      media: [media('https://cdn.test/next', 'video/mp4', 1, 9000), media('https://cdn.test/main', 'video/mp4', 5, 5000), media('https://cdn.test/effect', 'video/mp4', 2, 800)],
      files: { 'https://cdn.test/next': 'next.mp4', 'https://cdn.test/main': 'both.mp4', 'https://cdn.test/effect': 'effect.mp4' },
    });
    const saved = await savePageVideo(fake, { url: page, targetDir: dir, ...quick });
    expect(saved).toMatchObject({ ok: true, host: 'www.example-video.test', silent: false });
    if (!saved.ok) return;
    expect(await probe(saved.path)).toMatchObject({ streams: ['audio', 'video'] });
    expect(Math.abs((await probe(saved.path)).duration - 3)).toBeLessThan(0.2);
    // The page fetched the playing video most often, so it is tried first and nothing else is fetched.
    expect(downloads).toEqual(['https://cdn.test/main']);
    expect(fs.readdirSync(dir)).toEqual([path.basename(saved.path)]);
    expect(events).toEqual([`open ${page}`, 'loaded', 'close', 'release']);
  });

  it('joins picture and sound that the page loads as separate files', async () => {
    const dir = target();
    const { fake } = browser({
      video: { durationSec: 3, src: '' },
      media: [media('https://cdn.test/picture', 'video/mp4', 5, 7000), media('https://cdn.test/effect', 'video/mp4', 2, 800), media('https://cdn.test/sound', 'audio/mp4', 5, 400)],
      files: { 'https://cdn.test/picture': 'picture.mp4', 'https://cdn.test/sound': 'sound.m4a', 'https://cdn.test/effect': 'effect.mp4' },
    });
    const saved = await savePageVideo(fake, { url: page, targetDir: dir, ...quick });
    expect(saved).toMatchObject({ ok: true, silent: false });
    if (!saved.ok) return;
    expect(await probe(saved.path)).toMatchObject({ streams: ['audio', 'video'] });
    expect(fs.readdirSync(dir)).toEqual([path.basename(saved.path)]);
  });

  it('keeps the picture and says so when the page has no sound file for it', async () => {
    const { fake } = browser({
      video: { durationSec: 3, src: '' },
      media: [media('https://cdn.test/picture', 'video/mp4', 5, 7000)],
      files: { 'https://cdn.test/picture': 'picture.mp4' },
    });
    const saved = await savePageVideo(fake, { url: page, targetDir: target(), ...quick });
    expect(saved).toMatchObject({ ok: true, silent: true });
    if (saved.ok) expect(await probe(saved.path)).toMatchObject({ streams: ['video'] });
  });

  it('saves a player\'s own file address without looking at other responses', async () => {
    const { fake, downloads } = browser({
      video: { durationSec: 3, src: 'https://cdn.test/direct.mp4' },
      media: [media('https://cdn.test/effect', 'video/mp4', 9, 800)],
      files: { 'https://cdn.test/direct.mp4': 'both.mp4', 'https://cdn.test/effect': 'effect.mp4' },
    });
    const saved = await savePageVideo(fake, { url: page, targetDir: target(), ...quick });
    expect(saved).toMatchObject({ ok: true, silent: false });
    expect(downloads).toEqual(['https://cdn.test/direct.mp4']);
  });

  it('waits for a video that starts after the page loads', async () => {
    const { fake } = browser({
      video: { durationSec: 3, src: '' }, videoAfter: 3,
      media: [media('https://cdn.test/main', 'video/mp4', 5)],
      files: { 'https://cdn.test/main': 'both.mp4' },
    });
    expect(await savePageVideo(fake, { url: page, targetDir: target(), ...quick })).toMatchObject({ ok: true });
  });

  it('leaves a page with no playing video open for the user and saves nothing', async () => {
    const dir = target();
    const { fake, events, downloads } = browser({ video: null });
    expect(await savePageVideo(fake, { url: page, targetDir: dir, ...quick })).toEqual({ ok: false, code: 'no_video', host: 'www.example-video.test' });
    expect(events).toEqual([`open ${page}`, 'loaded', 'keep', 'release']);
    expect(downloads).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('reports why nothing was saved: no matching length, a refusing site, or files over the limit', async () => {
    const noMatch = browser({
      video: { durationSec: 3, src: '' },
      media: [media('https://cdn.test/effect', 'video/mp4', 2), media('https://cdn.test/next', 'video/mp4', 1)],
      files: { 'https://cdn.test/effect': 'effect.mp4', 'https://cdn.test/next': 'next.mp4' },
    });
    const dir = target();
    expect(await savePageVideo(noMatch.fake, { url: page, targetDir: dir, ...quick })).toEqual({ ok: false, code: 'not_saved', host: 'www.example-video.test', reason: 'no_match' });
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(noMatch.events.at(-2)).toBe('close');

    const refused = browser({ video: { durationSec: 3, src: '' }, media: [media('https://cdn.test/main', 'video/mp4', 5)], refuse: ['https://cdn.test/main'] });
    expect(await savePageVideo(refused.fake, { url: page, targetDir: target(), ...quick })).toMatchObject({ ok: false, code: 'not_saved', reason: 'refused' });

    const huge = browser({ video: { durationSec: 3, src: '' }, media: [media('https://cdn.test/main', 'video/mp4', 5, 300 * 1024 * 1024)], files: { 'https://cdn.test/main': 'both.mp4' } });
    expect(await savePageVideo(huge.fake, { url: page, targetDir: target(), ...quick })).toMatchObject({ ok: false, code: 'not_saved', reason: 'too_large' });
    // The size the response declared is enough to skip it: nothing is fetched.
    expect(huge.downloads).toEqual([]);
  });

  it('never fetches a stream that does not state its size, such as a live preview beside the video', async () => {
    const { fake, downloads } = browser({
      video: { durationSec: 3, src: '' },
      media: [media('https://live.test/room.flv', 'video/x-flv', 40, null), media('https://cdn.test/main', 'video/mp4', 2)],
      files: { 'https://cdn.test/main': 'both.mp4' },
    });
    expect(await savePageVideo(fake, { url: page, targetDir: target(), ...quick })).toMatchObject({ ok: true });
    expect(downloads).toEqual(['https://cdn.test/main']);
  });

  it('tries at most six files the page loaded', async () => {
    const many = Array.from({ length: 9 }, (_, i) => media(`https://cdn.test/clip-${i}`, 'video/mp4', 9 - i));
    const { fake, downloads } = browser({
      video: { durationSec: 3, src: '' }, media: many,
      files: Object.fromEntries(many.map(m => [m.url, 'effect.mp4'])),
    });
    expect(await savePageVideo(fake, { url: page, targetDir: target(), ...quick })).toMatchObject({ ok: false, reason: 'no_match' });
    expect(downloads).toHaveLength(6);
  });

  it('stops and removes what it saved when the call is cancelled', async () => {
    const controller = new AbortController();
    const dir = target();
    const { fake, events } = browser({
      video: { durationSec: 3, src: '' },
      media: [media('https://cdn.test/picture', 'video/mp4', 5), media('https://cdn.test/sound', 'audio/mp4', 4)],
      files: { 'https://cdn.test/picture': 'picture.mp4', 'https://cdn.test/sound': 'sound.m4a' },
    });
    const download = fake.download.bind(fake);
    fake.download = async (tab, url, savePath, limits) => {
      const got = await download(tab, url, savePath, limits);
      controller.abort();
      return got;
    };
    expect(await savePageVideo(fake, { url: page, targetDir: dir, signal: controller.signal, ...quick })).toEqual({ ok: false, code: 'cancelled', host: 'www.example-video.test' });
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(events.slice(-2)).toEqual(['close', 'release']);
  });

  it('says the browser is unavailable when the page cannot be opened, and still releases the capture', async () => {
    const { fake, events } = browser({ open: false });
    expect(await savePageVideo(fake, { url: page, targetDir: target(), ...quick })).toEqual({ ok: false, code: 'unavailable' });
    expect(events).toEqual([`open ${page}`, 'release']);
  });
});
