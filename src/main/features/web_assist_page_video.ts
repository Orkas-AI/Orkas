/**
 * Save the video a page plays, for VideoStudio's reference inspection.
 *
 * The page opens in the task browser, where the user can see it and sign in or
 * pass a check. The host, never the model, chooses what to save: only files the
 * page itself loaded as video or audio, and only those as long as the largest
 * video playing in view. Picture and sound that arrive as separate files are
 * joined without re-encoding. Nothing here runs page script beyond reading the
 * playing video, and the browser adapter (web_assist) owns the tab, the capture
 * of response headers and the download.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { bundledFfmpegPaths } from '../util/bundled-runtime';
import { runMediaProbeProcessForTest as runMediaProcess } from '../util/media_probe';

/** reference.inspect reads files up to this size. */
export const PAGE_VIDEO_MAX_BYTES = 256 * 1024 * 1024;
/** One budget for opening, waiting and every download, as for other downloads. */
const PAGE_VIDEO_TOTAL_MS = 10 * 60_000;
const MAX_CANDIDATES = 6;

export type PageMediaResponse = {
  url: string;
  contentType: string;
  /** From Content-Range or Content-Length; null when the response did not say. */
  totalBytes: number | null;
  /** Responses seen for this address: a player keeps asking for the file it plays. */
  hits: number;
};

export type PageVideoDownload = { state: 'completed' | 'refused' | 'too_large' | 'cancelled' };

/** The task browser as this module needs it; web_assist supplies the real one. */
export interface PageVideoBrowser {
  open(url: string): Promise<{ ok: true; tabId: string } | { ok: false }>;
  waitLoaded(tabId: string): Promise<void>;
  /** The largest video in view with a known length; `src` only when it is an http(s) file. */
  playingVideo(tabId: string): Promise<{ durationSec: number; src: string } | null>;
  media(tabId: string): PageMediaResponse[];
  download(tabId: string, url: string, savePath: string, limits: { maxBytes: number; signal: AbortSignal }): Promise<PageVideoDownload>;
  /** Leave the tab for the user, beyond this task turn. */
  keepOpen(tabId: string): void;
  close(tabId: string): void;
  release(): void;
}

export type PageVideoResult =
  | { ok: true; path: string; host: string; silent: boolean }
  | { ok: false; code: 'unavailable' }
  | { ok: false; code: 'no_video'; host: string }
  | { ok: false; code: 'not_saved'; host: string; reason: 'no_match' | 'too_large' | 'refused' }
  | { ok: false; code: 'cancelled'; host: string };

type Probed = { durationSec: number; picture: boolean; sound: boolean; container: 'mp4' | 'webm' | 'other' };

/** Same length as the playing video, allowing for container rounding. */
function sameLength(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1, b * 0.03);
}

/** Most-requested first, then largest: the playing file, not a preloaded next one. */
function ranked(responses: PageMediaResponse[]): PageMediaResponse[] {
  return [...responses].sort((a, b) => b.hits - a.hits || (b.totalBytes ?? 0) - (a.totalBytes ?? 0));
}

async function probe(file: string, signal: AbortSignal): Promise<Probed | null> {
  const { ffprobe } = bundledFfmpegPaths();
  if (!ffprobe) return null;
  const out = await runMediaProcess(ffprobe, ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type', '-of', 'json', file],
    { signal, timeoutMs: 30_000 });
  if (out.code !== 0) return null;
  try {
    const parsed = JSON.parse(out.stdout) as { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string }> };
    const durationSec = Number(parsed.format?.duration);
    if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
    const kinds = new Set((parsed.streams ?? []).map(stream => stream.codec_type));
    const format = String(parsed.format?.format_name ?? '');
    return { durationSec, picture: kinds.has('video'), sound: kinds.has('audio'),
      container: /\bmp4\b|\bmov\b/.test(format) ? 'mp4' : /\bwebm\b/.test(format) ? 'webm' : 'other' };
  } catch {
    return null;
  }
}

const extension = (container: Probed['container']) => (container === 'mp4' ? '.mp4' : container === 'webm' ? '.webm' : '.mkv');

/** Join a picture-only and a sound-only file without re-encoding. */
async function join(picture: { file: string; info: Probed }, sound: { file: string; info: Probed }, dir: string, signal: AbortSignal): Promise<string | null> {
  const { ffmpeg } = bundledFfmpegPaths();
  if (!ffmpeg) return null;
  const container = picture.info.container === sound.info.container ? picture.info.container : 'other';
  const out = path.join(dir, `reference${extension(container)}`);
  const joined = await runMediaProcess(ffmpeg, ['-y', '-loglevel', 'error', '-i', picture.file, '-i', sound.file,
    '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', ...(container === 'mp4' ? ['-movflags', '+faststart'] : []), out], { signal, timeoutMs: 120_000 });
  return joined.code === 0 ? out : null;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function savePageVideo(browser: PageVideoBrowser, input: {
  url: string;
  /** An empty folder of the production; on success it holds only the saved video. */
  targetDir: string;
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; message: string }) => void;
  pollMs?: number;
  videoWaitMs?: number;
}): Promise<PageVideoResult> {
  const host = new URL(input.url).hostname;
  const budget = AbortSignal.timeout(PAGE_VIDEO_TOTAL_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, budget]) : budget;
  const progress = (message: string) => input.onProgress?.({ phase: 'reference.page', message });
  const kept: string[] = [];
  const discard = async (file: string) => { await fs.rm(file, { force: true }).catch(() => undefined); };
  const discardAll = async () => { for (const file of kept.splice(0)) await discard(file); };
  try {
    progress('Opening the page in the task browser.');
    const opened = await browser.open(input.url);
    if (!opened.ok) return { ok: false, code: 'unavailable' };
    const tabId = opened.tabId;
    let leaveOpen = false;
    try {
      await browser.waitLoaded(tabId);
      progress('Waiting for the page to play its video.');
      const until = Date.now() + (input.videoWaitMs ?? 20_000);
      let video: { durationSec: number; src: string } | null = null;
      // A file states its size; a live stream, which never ends, does not.
      const files = () => browser.media(tabId).filter(item => item.totalBytes !== null);
      while (!signal.aborted) {
        video = await browser.playingVideo(tabId);
        // A stream player is ready to save once its files have been seen.
        if (video && (video.src || files().length)) break;
        if (Date.now() >= until) break;
        await wait(input.pollMs ?? 1000, signal);
      }
      if (signal.aborted) return { ok: false, code: 'cancelled', host };
      if (!video) {
        leaveOpen = true;
        browser.keepOpen(tabId);
        return { ok: false, code: 'no_video', host };
      }
      const seen = video.src ? [{ url: video.src, contentType: '', totalBytes: null, hits: 1 }] : ranked(files());
      const fitting = seen.filter(item => item.totalBytes === null || item.totalBytes <= PAGE_VIDEO_MAX_BYTES);
      let refused = false;
      let tooLarge = fitting.length < seen.length;
      let completed = false;
      let whole: { file: string; info: Probed } | null = null;
      let picture: { file: string; info: Probed } | null = null;
      let sound: { file: string; info: Probed } | null = null;
      progress('Saving the video from the page.');
      for (const [index, item] of fitting.slice(0, MAX_CANDIDATES).entries()) {
        const file = path.join(input.targetDir, `candidate-${index}`);
        const got = await browser.download(tabId, item.url, file, { maxBytes: PAGE_VIDEO_MAX_BYTES, signal });
        if (got.state === 'cancelled' || signal.aborted) {
          await discard(file);
          await discardAll();
          return { ok: false, code: 'cancelled', host };
        }
        if (got.state !== 'completed') {
          await discard(file);
          if (got.state === 'refused') refused = true; else tooLarge = true;
          continue;
        }
        completed = true;
        const info = await probe(file, signal);
        if (!info || !sameLength(info.durationSec, video.durationSec) || (picture && !info.sound) || (sound && !info.picture)) {
          await discard(file);
          continue;
        }
        kept.push(file);
        if (info.picture && info.sound) { whole = { file, info }; break; }
        if (info.picture) picture = { file, info }; else sound = { file, info };
        if (picture && sound) break;
      }
      if (signal.aborted) {
        await discardAll();
        return { ok: false, code: 'cancelled', host };
      }
      let saved: string | null = null;
      if (whole) {
        saved = path.join(input.targetDir, `reference${extension(whole.info.container)}`);
        await fs.rename(whole.file, saved);
        kept.splice(kept.indexOf(whole.file), 1);
      } else if (picture && sound) {
        saved = await join(picture, sound, input.targetDir, signal);
      } else if (picture) {
        saved = path.join(input.targetDir, `reference${extension(picture.info.container)}`);
        await fs.rename(picture.file, saved);
        kept.splice(kept.indexOf(picture.file), 1);
      }
      await discardAll();
      if (signal.aborted) {
        if (saved) await discard(saved);
        return { ok: false, code: 'cancelled', host };
      }
      if (!saved) {
        const reason = completed || (!refused && !tooLarge) ? 'no_match' : refused ? 'refused' : 'too_large';
        return { ok: false, code: 'not_saved', host, reason };
      }
      return { ok: true, path: saved, host, silent: !whole && !sound };
    } finally {
      if (!leaveOpen) browser.close(tabId);
    }
  } finally {
    await discardAll();
    browser.release();
  }
}
