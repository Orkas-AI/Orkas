import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkVideoTimeline,
  loadVideoProject,
  noteTimelineBeforeChange,
  timelineAheadOfDelivery,
  parseVisualReview,
  visualReview,
  productRectOnCanvas,
  renderVideoTimeline,
  shareOnProduct,
} from '../../../src/main/features/video_timeline_render';
import { shipVideoFile } from '../../../src/main/features/video_timeline_ship';
import { deriveVideoTimeline, timelineAudioTracks } from '../../../src/main/features/video_timeline';
import { buildVideoTrackRemuxArgs, pruneSegmentCache } from '../../../src/main/features/video_studio';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';
import type { Issue } from '../../../src/main/features/video_studio_qa';

// The window is faked here so the suite runs everywhere; ffmpeg is real, so frame
// extraction, encoding, joining and mixing are the real thing. Real-window pixels
// are covered by the timeline canary (test:video-timeline-canary).

const WIDTH = 160;
const HEIGHT = 284;

const electronFake = vi.hoisted(() => {
  const state: {
    captures: number;
    /** Frames the page was asked to show. */
    shown: number;
    /** Captures that still see the previous picture after the next frame shown. */
    lateCaptures: number;
    /** When set, the picture changes with every frame shown instead of staying the same. */
    moving: boolean;
    textured: boolean;
    /** A capture fails while the page shows this scene. */
    failScene: string;
    currentScene: string;
    failAtCapture: number;
    timelineKeys: string[];
    pageSections: string[];
    consoleError: string;
    calls: string[];
    /** What the page reports, scene by scene, as lines of words lying on a marked product. */
    productCover: Record<string, Array<{ text: string; share: number }>>;
    inspectIssues: Issue[];
  } = { captures: 0, shown: 0, lateCaptures: 0, moving: false, textured: false, failScene: '', currentScene: '', failAtCapture: -1, timelineKeys: [], pageSections: [], consoleError: '', calls: [], productCover: {}, inspectIssues: [] };
  let lateLeft = 0;
  class FakeBrowserWindow {
    private consoleHandler: ((event: { level: string; message: string }) => void) | null = null;
    webContents = {
      once: (event: string, callback: () => void) => {
        if (event === 'did-finish-load') {
          setImmediate(() => {
            if (state.consoleError) this.consoleHandler?.({ level: 'error', message: state.consoleError });
            callback();
          });
        }
      },
      on: (event: string, callback: (event: { level: string; message: string }) => void) => {
        if (event === 'console-message') this.consoleHandler = callback;
      },
      executeJavaScript: async (script: string) => {
        state.calls.push(script);
        const shownScene = /renderFrame\("([^"]+)"/.exec(script)?.[1];
        if (shownScene) {
          state.currentScene = shownScene;
          state.shown += 1;
          lateLeft = state.lateCaptures;
          state.lateCaptures = 0;
        }
        if (script.includes('productRectOnCanvas')) return state.productCover[state.currentScene] ?? [];
        if (script.includes('const issues = [];')) {
          const sampleTimeSec = Number(/const tSec = ([\d.e+-]+);/.exec(script)?.[1]);
          return state.inspectIssues.filter(issue => !issue.sceneId || issue.sceneId === state.currentScene)
            .map(issue => ({ ...issue, sampleTimeSec }));
        }
        if (script.includes('querySelectorAll') && script.includes('map((section)')) return state.pageSections;
        return script.includes('timelineKeys') ? state.timelineKeys : undefined;
      },
      capturePage: async () => {
        state.captures += 1;
        if (state.captures === state.failAtCapture) throw new Error('capture blew up');
        if (state.failScene && state.currentScene === state.failScene) throw new Error('capture blew up');
        const onSurface = lateLeft > 0 ? state.shown - 1 : state.shown;
        if (lateLeft > 0) lateLeft -= 1;
        const shade = state.moving ? (onSurface % 2 ? 0xc0 : 0x40) : 0x80;
        const bitmap = (width: number, height: number) => {
          const bytes = Buffer.alloc(width * height * 4, shade);
          if (state.textured) bytes.fill(0x10, 0, Math.floor(height / 2) * width * 4);
          return bytes;
        };
        return {
          getSize: () => ({ width: 160, height: 284 }),
          toBitmap: () => bitmap(160, 284),
          toPNG: () => Buffer.alloc(0),
          // video.check samples a smaller copy to see how empty a frame is.
          resize: ({ width }: { width: number }) => {
            const height = Math.max(1, Math.round((width * 284) / 160));
            return { getSize: () => ({ width, height }), toBitmap: () => bitmap(width, height) };
          },
        };
      },
      invalidate: () => {},
      setFrameRate: () => {},
    };
    setContentSize() {}
    loadURL = async () => {};
    destroy() {}
  }
  return { state, FakeBrowserWindow };
});

vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: () => false }, getPath: () => os.tmpdir(), isPackaged: false },
  BrowserWindow: electronFake.FakeBrowserWindow,
  session: { fromPartition: () => ({ webRequest: { onBeforeRequest: () => {} } }) },
}));

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-timeline-'));
  roots.push(root);
  return root;
}

function ffmpeg(args: string[]): void {
  const { ffmpeg: bin } = bundledFfmpegPaths();
  const run = spawnSync(bin as string, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
}

function probe(file: string): { duration: number; streams: Array<Record<string, unknown>> } {
  const { ffprobe: bin } = bundledFfmpegPaths();
  const run = spawnSync(bin as string, ['-v', 'error', '-count_frames', '-show_entries', 'format=duration:stream=codec_type,nb_read_frames,width,height,duration', '-of', 'json', file], { encoding: 'utf8' });
  const parsed = JSON.parse(run.stdout) as { format: { duration: string }; streams: Array<Record<string, unknown>> };
  return { duration: Number(parsed.format.duration), streams: parsed.streams };
}

function audioSampleRate(file: string): number {
  const { ffprobe: bin } = bundledFfmpegPaths();
  const run = spawnSync(bin as string, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(run.stdout.trim());
}

function sourceClip(file: string, seconds = 3): void {
  ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=${WIDTH}x${HEIGHT}:r=30:d=${seconds}`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file]);
}

function setup(root: string, overrides: { assets?: unknown[]; manifest?: unknown; page?: string | null } = {}) {
  const production = path.join(root, 'production');
  const video = path.join(production, 'videos', 'main');
  fs.mkdirSync(path.join(production, 'media'), { recursive: true });
  fs.mkdirSync(video, { recursive: true });
  const clip = path.join(production, 'media', 'clip.mp4');
  if (!fs.existsSync(clip)) sourceClip(clip);
  const assets = overrides.assets ?? [{ id: 'clip', kind: 'video', label: 'Clip', path: 'media/clip.mp4', origin: 'upload' }];
  fs.writeFileSync(path.join(production, 'assets.json'), JSON.stringify({ assets }));
  const writeManifest = (manifest: unknown) => fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify(manifest));
  writeManifest(overrides.manifest ?? timeline());
  if (overrides.page) fs.writeFileSync(path.join(video, 'index.html'), overrides.page);
  const output = path.join(production, 'render', 'out.mp4');
  return {
    production,
    video,
    clip,
    output,
    writeManifest,
    options: () => ({
      productionDirAbs: production,
      videoDirAbs: video,
      allowedRoots: [root],
      outputAbsPath: output,
      segmentCacheDirAbs: path.join(root, 'cache'),
      quality: 'standard' as const,
    }),
  };
}

function timeline(scenes: unknown[] = [
  { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 0.5 }] },
  { id: 'b', clips: [{ id: 'c2', asset: 'clip', in: 1, dur: 0.5 }] },
], extra: Record<string, unknown> = {}) {
  return {
    schema_version: 3,
    id: 'main',
    label: 'Test',
    canvas: { width: WIDTH, height: HEIGHT, fps: 30 },
    scenes,
    ...extra,
  };
}

function sha(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

afterEach(() => {
  electronFake.state.captures = 0;
  electronFake.state.shown = 0;
  electronFake.state.lateCaptures = 0;
  electronFake.state.moving = false;
  electronFake.state.textured = false;
  electronFake.state.failScene = '';
  electronFake.state.currentScene = '';
  electronFake.state.failAtCapture = -1;
  electronFake.state.timelineKeys = [];
  electronFake.state.pageSections = [];
  electronFake.state.consoleError = '';
  electronFake.state.calls = [];
  electronFake.state.productCover = {};
  electronFake.state.inspectIssues = [];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('renderVideoTimeline', () => {
  it.each(['manifest.json', 'index.html', 'assets.json', 'product.json'])('does not load an out-of-scope symlink for %s', async name => {
    const p = setup(makeRoot());
    const file = path.join(name === 'manifest.json' || name === 'index.html' ? p.video : p.production, name);
    const foreign = path.join(makeRoot(), name);
    fs.writeFileSync(foreign, name === 'manifest.json' ? JSON.stringify(timeline())
      : name === 'assets.json' ? JSON.stringify({ assets: [] })
      : name === 'product.json' ? JSON.stringify({ name: 'Foreign material', facts: [], images: [] }) : '<div>Foreign material</div>');
    fs.rmSync(file, { force: true });
    fs.symlinkSync(foreign, file);
    const project = await loadVideoProject(p.options());
    expect(project.issues.map(i => i.code)).toContain('RESOURCE_OUT_OF_SCOPE');
    expect(project.product?.name).not.toBe('Foreign material');
    expect(project.html ?? '').not.toContain('Foreign material');
  });

  it('tells an Agent with no timeline that a file it cut itself goes straight to delivery', async () => {
    // 2026-11-14: a montage cut with ffmpeg ran video.check, read "No manifest.json" as a
    // missing setting and handed the work back unfinished.
    const p = setup(makeRoot(), { manifest: timeline() });
    fs.rmSync(path.join(p.video, 'manifest.json'));
    const project = await loadVideoProject(p.options());
    const missing = project.issues.find((issue) => issue.code === 'TIMELINE_MANIFEST_MISSING');
    expect(missing?.message).toContain('production_dir is the folder that holds videos/<video_id>/manifest.json');
    expect(missing?.message).toContain('a video made with edit_video or ffmpeg needs no check or render');
    expect(missing?.message).toContain('video.ship, its path and expect_duration_sec');
  });

  it('validates clip frame ranges at the selected draft frame rate before rendering', async () => {
    const p = setup(makeRoot(), { manifest: timeline([{ id: 'a', clips: [
      { id: 'c1', asset: 'clip', in: 0, dur: 0.04 },
      { id: 'c2', asset: 'clip', in: 1, dur: 0.04 },
    ] }]) });
    const result = await renderVideoTimeline({ ...p.options(), quality: 'draft' });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_CHECK_BLOCKED' });
    expect((result as { issues?: Array<{ code: string }> }).issues?.map(i => i.code)).toContain('TIMELINE_CLIP_TOO_SHORT');
    expect(electronFake.state.shown).toBe(0);
    expect(fs.existsSync(p.output)).toBe(false);
  });

  it('renders exactly the frames the timeline asks for and leaves the source untouched', async () => {
    const p = setup(makeRoot());
    const before = sha(p.clip);
    const result = await renderVideoTimeline(p.options());
    expect(result).toMatchObject({ ok: true, frames: 30, scene_segments: { total: 2, rendered: 2, reused: 0 } });
    const { streams } = probe(p.output);
    expect(streams.find((stream) => stream.codec_type === 'video')?.nb_read_frames).toBe('30');
    expect(streams.some((stream) => stream.codec_type === 'audio')).toBe(false);
    expect(sha(p.clip)).toBe(before);
    expect(electronFake.state.shown).toBe(30);
  });

  it('takes a scene\'s first frame only once the picture has changed and holds', async () => {
    const p = setup(makeRoot());
    electronFake.state.moving = true;
    electronFake.state.lateCaptures = 2;
    const result = await renderVideoTimeline(p.options());
    expect(result).toMatchObject({ ok: true, frames: 30 });
    const { ffmpeg: bin } = bundledFfmpegPaths();
    const decoded = spawnSync(bin as string, ['-hide_banner', '-loglevel', 'error', '-i', p.output, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
    // The first frame shown is bright; what was on the surface before it is dark.
    expect(decoded.stdout[0]).toBeGreaterThan(0x80);
  });

  it('stops waiting on a first frame that really matches what came before it', async () => {
    const p = setup(makeRoot());
    const result = await renderVideoTimeline(p.options());
    expect(result).toMatchObject({ ok: true, frames: 30 });
    expect(electronFake.state.shown).toBe(30);
    expect(electronFake.state.captures).toBeLessThanOrEqual(30 + 2 * 7);
  });

  it('captures nothing when only the order changed', async () => {
    const p = setup(makeRoot());
    await renderVideoTimeline(p.options());
    electronFake.state.captures = 0;
    p.writeManifest(timeline([
      { id: 'b', clips: [{ id: 'c2', asset: 'clip', in: 1, dur: 0.5 }] },
      { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 0.5 }] },
    ]));
    const result = await renderVideoTimeline(p.options());
    expect(result).toMatchObject({ ok: true, scene_segments: { rendered: 0, reused: 2 } });
    expect(electronFake.state.captures).toBe(0);
  });

  it('renders only the scene whose clip range changed', async () => {
    const p = setup(makeRoot());
    await renderVideoTimeline(p.options());
    electronFake.state.shown = 0;
    p.writeManifest(timeline([
      { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 0.5 }] },
      { id: 'b', clips: [{ id: 'c2', asset: 'clip', in: 2, dur: 0.5 }] },
    ]));
    const result = await renderVideoTimeline(p.options());
    expect(result).toMatchObject({ ok: true, scene_segments: { rendered: 1, reused: 1 } });
    expect(electronFake.state.shown).toBe(15);
  });

  it('re-renders when the source file changes behind the same path', async () => {
    const p = setup(makeRoot());
    await renderVideoTimeline(p.options());
    fs.rmSync(p.clip);
    ffmpeg(['-f', 'lavfi', '-i', `color=c=red:s=${WIDTH}x${HEIGHT}:r=30:d=3`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', p.clip]);
    const result = await renderVideoTimeline(p.options());
    expect(result).toMatchObject({ ok: true, scene_segments: { rendered: 2, reused: 0 } });
  });

  it('keeps finished scenes when one fails, says so, and finishes on the next call', async () => {
    const p = setup(makeRoot());
    // Both attempts at scene b die on its first frame.
    electronFake.state.failScene = 'b';
    const first = await renderVideoTimeline(p.options());
    expect(first).toMatchObject({
      ok: false,
      errorCode: 'E_SEGMENT_ASSEMBLY_INCOMPLETE',
      scene_segments: { total: 2, rendered: 1, failed: 1, resumable: true },
    });
    expect((first as { failed_scenes?: Array<{ scene_id: string }> }).failed_scenes?.[0]?.scene_id).toBe('b');
    expect(fs.existsSync(p.output)).toBe(false);

    electronFake.state.failScene = '';
    electronFake.state.shown = 0;
    const second = await renderVideoTimeline(p.options());
    expect(second).toMatchObject({ ok: true, scene_segments: { rendered: 1, reused: 1 } });
    expect(electronFake.state.shown).toBe(15);
  });

  it('leaves no frames or staging behind', async () => {
    const root = makeRoot();
    const p = setup(root);
    await renderVideoTimeline(p.options());
    const cache = fs.readdirSync(path.join(root, 'cache'));
    expect(cache.filter((name) => name.startsWith('.'))).toEqual([]);
    expect(fs.readdirSync(path.join(p.production, 'render')).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('refuses an asset that points outside the files the task may use, without touching it', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    const secret = path.join(outside, 'secret.mp4');
    sourceClip(secret, 1);
    const p = setup(root, {
      assets: [{ id: 'clip', kind: 'video', label: 'Clip', path: secret, origin: 'upload' }],
    });
    const result = await renderVideoTimeline(p.options());
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_CHECK_BLOCKED' });
    expect(JSON.stringify(result)).toContain('TIMELINE_ASSET_OUT_OF_SCOPE');
    expect(JSON.stringify(result)).not.toContain(outside);
    expect(electronFake.state.captures).toBe(0);
  });

  it('refuses a ledger traversal the same way', async () => {
    const root = makeRoot();
    const p = setup(root, {
      assets: [{ id: 'clip', kind: 'video', label: 'Clip', path: '../../../../../etc/hosts', origin: 'upload' }],
    });
    const result = await renderVideoTimeline(p.options());
    expect(JSON.stringify(result)).toContain('TIMELINE_ASSET_OUT_OF_SCOPE');
  });

  it('names a missing file and a clip past the end of its media', async () => {
    const root = makeRoot();
    const missing = setup(root, {
      assets: [{ id: 'clip', kind: 'video', label: 'Clip', path: 'media/nope.mp4', origin: 'upload' }],
    });
    expect(JSON.stringify(await renderVideoTimeline(missing.options()))).toContain('TIMELINE_ASSET_MISSING');

    const pastEnd = setup(makeRoot(), {
      manifest: timeline([{ id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 2.5, dur: 1 }] }]),
    });
    expect(JSON.stringify(await renderVideoTimeline(pastEnd.options()))).toContain('TIMELINE_CLIP_PAST_MEDIA_END');
  });

  it('never reports a wrong measured length from the ledger', async () => {
    const p = setup(makeRoot(), {
      assets: [{ id: 'clip', kind: 'video', label: 'Clip', path: 'media/clip.mp4', origin: 'upload', duration: 999 }],
      manifest: timeline([{ id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 2.5, dur: 1 }] }]),
    });
    expect(JSON.stringify(await renderVideoTimeline(p.options()))).toContain('TIMELINE_CLIP_PAST_MEDIA_END');
  });

  it('reports broken project files by name', async () => {
    const p = setup(makeRoot());
    fs.writeFileSync(path.join(p.production, 'assets.json'), '{ not json');
    const result = await renderVideoTimeline(p.options());
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_CHECK_BLOCKED' });
    expect(JSON.stringify(result)).toContain('PROJECT_FILE_NOT_JSON');
  });

  it('refuses a timeline under a name that is not a scene', async () => {
    const p = setup(makeRoot());
    electronFake.state.timelineKeys = ['main'];
    const result = await renderVideoTimeline(p.options());
    expect(result).toMatchObject({ ok: false, errorCode: 'E_PAGE_TIMELINE_NOT_PER_SCENE' });
    expect(electronFake.state.captures).toBe(0);
  });

  it('renders a page that still holds a scene taken off the timeline', async () => {
    const p = setup(makeRoot());
    electronFake.state.timelineKeys = ['removed'];
    electronFake.state.pageSections = ['removed'];

    expect(await renderVideoTimeline(p.options())).toMatchObject({ ok: true });
  });

  it('refuses a page that threw while loading, and only for an uncaught error', async () => {
    const page = '<!doctype html><html><head></head><body><main data-composition-id="main"><section data-scene-id="a"></section></main></body></html>';
    const manifest = timeline([{ id: 'a', duration: 0.2 }]);
    const thrown = setup(makeRoot(), { manifest, page });
    electronFake.state.consoleError = 'Uncaught ReferenceError: gsap is not defined';
    expect(await renderVideoTimeline(thrown.options())).toMatchObject({ ok: false, errorCode: 'E_PAGE_SCRIPT_ERROR' });
    expect(electronFake.state.captures).toBe(0);

    const noise = setup(makeRoot(), { manifest, page });
    electronFake.state.consoleError = 'A harmless console.error from the page';
    expect(await renderVideoTimeline(noise.options())).toMatchObject({ ok: true });
  });

  it('mixes narration, a kept clip sound and music into the delivered file', async () => {
    const root = makeRoot();
    const p = setup(root);
    const media = path.join(p.production, 'media');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'aac', path.join(media, 'voice.m4a')]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=30', '-c:a', 'aac', path.join(media, 'song.m4a')]);
    ffmpeg([
      '-f', 'lavfi', '-i', `testsrc2=s=${WIDTH}x${HEIGHT}:r=30:d=3`,
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(media, 'talk.mp4'),
    ]);
    fs.writeFileSync(path.join(p.production, 'assets.json'), JSON.stringify({ assets: [
      { id: 'clip', kind: 'video', label: 'Clip', path: 'media/clip.mp4', origin: 'upload' },
      { id: 'talk', kind: 'video', label: 'Talk', path: 'media/talk.mp4', origin: 'upload' },
      { id: 'voice', kind: 'audio', label: 'Voice', path: 'media/voice.m4a', origin: 'generated' },
      { id: 'song', kind: 'audio', label: 'Song', path: 'media/song.m4a', origin: 'generated' },
    ] }));
    p.writeManifest(timeline([
      { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 1 }], narration: { text: 'Hi', asset: 'voice' } },
      { id: 'b', clips: [{ id: 'c2', asset: 'talk', in: 1, dur: 1, audio: 'keep' }] },
    ], { tracks: [{ kind: 'music', asset: 'song', volume: 0.3, fade_out: 0.5, duck: true }] }));
    const result = await renderVideoTimeline(p.options());
    expect(result).toMatchObject({ ok: true, media_qa: { ok: true } });
    const probed = probe(p.output);
    expect(probed.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
    expect(Math.abs(probed.duration - 2)).toBeLessThan(0.1);
  });

  it.each([0, 0.3])('does not claim a silent render is normalized, and enforces the declared volume %s at delivery', async (volume) => {
    const root = makeRoot();
    const p = setup(root);
    ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=1', '-c:a', 'aac', path.join(p.production, 'media', 'silent.m4a')]);
    fs.writeFileSync(path.join(p.production, 'assets.json'), JSON.stringify({ assets: [
      { id: 'clip', kind: 'video', label: 'Clip', path: 'media/clip.mp4', origin: 'upload' },
      { id: 'sound', kind: 'audio', label: 'Sound', path: 'media/silent.m4a', origin: 'upload' },
    ] }));
    p.writeManifest(timeline([{ id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 1 }] }], {
      tracks: [{ kind: 'music', asset: 'sound', volume }],
    }));
    const rendered = await renderVideoTimeline({ ...p.options(), quality: 'high' });
    expect(rendered).toMatchObject({ ok: true, loudness: {
      before: { input_i: null, input_tp: null },
      decision: { normalize: false, reason: 'loudness analysis unavailable' },
    } });
    expect(rendered).not.toHaveProperty('loudness.normalize');
    const shipped = await shipVideoFile({ productionDirAbs: p.production, videoDirAbs: p.video, allowedRoots: [root], videoPathAbs: p.output });
    if (volume === 0) expect(shipped).toMatchObject({ ok: true });
    else expect(shipped).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED', issues: [{ code: 'DELIVERY_AUDIO_SILENT' }] });
  });

  it('delivers 48 kHz sound when it evens out the loudness of a 24 kHz voice', async () => {
    // loudnorm works at 192 kHz: without an output rate, the 2026-11-08 renders delivered 96 kHz.
    const root = makeRoot();
    const p = setup(root);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=1', '-ac', '1', '-c:a', 'aac', path.join(p.production, 'media', 'voice.m4a')]);
    fs.writeFileSync(path.join(p.production, 'assets.json'), JSON.stringify({ assets: [
      { id: 'clip', kind: 'video', label: 'Clip', path: 'media/clip.mp4', origin: 'upload' },
      { id: 'voice', kind: 'audio', label: 'Voice', path: 'media/voice.m4a', origin: 'generated' },
    ] }));
    p.writeManifest(timeline([
      { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 1 }], narration: { text: 'Hi', asset: 'voice' } },
    ]));
    const result = await renderVideoTimeline({ ...p.options(), quality: 'high' });
    expect(result).toMatchObject({ ok: true, loudness: { normalize: { skipped: false } } });
    expect(audioSampleRate(p.output)).toBe(48000);
  });

  it('refuses when a declared track\'s file has no sound', async () => {
    const root = makeRoot();
    const p = setup(root);
    fs.writeFileSync(path.join(p.production, 'assets.json'), JSON.stringify({ assets: [
      { id: 'clip', kind: 'video', label: 'Clip', path: 'media/clip.mp4', origin: 'upload' },
      { id: 'song', kind: 'audio', label: 'Song', path: 'media/clip.mp4', origin: 'generated' },
    ] }));
    p.writeManifest(timeline(
      [{ id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 0.5 }] }],
      { tracks: [{ kind: 'music', asset: 'song', volume: 0.3 }] },
    ));
    const result = await renderVideoTimeline(p.options());
    expect(JSON.stringify(result)).toContain('TIMELINE_ASSET_UNREADABLE');
    expect(fs.existsSync(p.output)).toBe(false);
  });

  it('passes each frame only the clips visible on it', async () => {
    const p = setup(makeRoot(), {
      manifest: timeline([{
        id: 'a',
        clips: [
          { id: 'first', asset: 'clip', in: 0, dur: 0.2 },
          { id: 'second', asset: 'clip', in: 1, dur: 0.2 },
          { id: 'corner', asset: 'clip', in: 2, dur: 0.1, at: 0.2 },
        ],
      }]),
    });
    await renderVideoTimeline(p.options());
    const frames = electronFake.state.calls.filter((call) => call.includes('renderFrame('));
    expect(frames).toHaveLength(12);
    expect(frames[0]).toContain('"first":');
    expect(frames[0]).not.toContain('"second":');
    expect(frames[6]).toContain('"second":');
    expect(frames[6]).toContain('"corner":');
    expect(frames[11]).not.toContain('"corner":');
  });
});

describe('timeline audio mix', () => {
  // Levels are measured from the mixed file, independent of the filter text.
  function rmsAt(file: string, startSec: number, durSec: number): number {
    const { ffmpeg: bin } = bundledFfmpegPaths();
    const run = spawnSync(bin as string, ['-hide_banner', '-ss', String(startSec), '-t', String(durSec), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(run.stderr);
    if (!match) return Number.NEGATIVE_INFINITY;
    return Number(match[1]);
  }

  function tone(file: string, seconds: number, frequency = 440): void {
    ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=${seconds}`, '-c:a', 'aac', file]);
  }

  function video(file: string, seconds: number): void {
    ffmpeg(['-f', 'lavfi', '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:r=30:d=${seconds}`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file]);
  }

  function mix(root: string, durationSec: number, audioTracks: Parameters<typeof buildVideoTrackRemuxArgs>[0]['audioTracks']): string {
    const base = path.join(root, 'base.mp4');
    if (!fs.existsSync(base)) video(base, durationSec);
    const out = path.join(root, 'mixed.mp4');
    const { ffmpeg: bin } = bundledFfmpegPaths();
    const run = spawnSync(bin as string, ['-hide_banner', '-loglevel', 'error', ...buildVideoTrackRemuxArgs({
      priorVideoAbsPath: base,
      outputAbsPath: out,
      durationSec,
      format: 'mp4',
      audioTracks,
    })], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
    if (run.status !== 0) throw new Error(run.stderr);
    return out;
  }

  it('reads a kept clip from its in point and only for its length', () => {
    const root = makeRoot();
    // Silence for 2s, then tone: the source's sound starts at 2s.
    const source = path.join(root, 'source.m4a');
    ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1', '-c:a', 'aac', source]);
    const out = mix(root, 4, [{ absPath: source, startSec: 1, inSec: 2, durSec: 1, volume: 1, voice: true }]);
    expect(rmsAt(out, 0.1, 0.7)).toBeLessThan(-60);
    expect(rmsAt(out, 1.1, 0.7)).toBeGreaterThan(-30);
    expect(rmsAt(out, 2.3, 1.5)).toBeLessThan(-60);
  });

  it('fades a track out at the end of the video when the source runs longer', () => {
    const root = makeRoot();
    const music = path.join(root, 'music.m4a');
    tone(music, 10);
    const out = mix(root, 4, [{ absPath: music, startSec: 0, volume: 1, fadeInSec: 1, fadeOutSec: 1, declaredDurationSec: 10 }]);
    const start = rmsAt(out, 0, 0.2);
    const middle = rmsAt(out, 1.5, 1);
    const end = rmsAt(out, 3.8, 0.2);
    expect(start).toBeLessThan(middle - 6);
    expect(end).toBeLessThan(middle - 6);
  });

  it.each(['m4a', 'wav'])('repeats short %s music through the video and fades only at its end', async (extension) => {
    const root = makeRoot();
    const p = setup(root);
    sourceClip(p.clip, 4);
    const music = path.join(p.production, 'media', `music.${extension}`);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=0.75',
      '-c:a', extension === 'wav' ? 'pcm_s16le' : 'aac', music]);
    fs.writeFileSync(path.join(p.production, 'assets.json'), JSON.stringify({ assets: [
      { id: 'clip', kind: 'video', label: 'Clip', path: 'media/clip.mp4', origin: 'upload' },
      { id: 'song', kind: 'audio', label: 'Song', path: `media/music.${extension}`, origin: 'upload' },
    ] }));
    p.writeManifest(timeline([{ id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 4 }] }], {
      tracks: [{ kind: 'music', asset: 'song', volume: 0.5, fade_in: 0.2, fade_out: 0.5 }],
    }));
    expect(await renderVideoTimeline(p.options())).toMatchObject({ ok: true,
      media_qa: { expected_audio_end_seconds: 4, source_audio_tracks: [expect.objectContaining({ source_duration_seconds: 4 })] } });
    const out = p.output;
    const measured = probe(out);
    // The existing loudness/remux pass may retain encoder timestamp padding.
    expect(Math.abs(measured.duration - 4)).toBeLessThan(0.15);
    expect(Math.abs(Number(measured.streams.find(stream => stream.codec_type === 'audio')?.duration) - 4)).toBeLessThan(0.15);
    // Includes both sides of repeated source boundaries, well beyond the original file.
    for (const start of [0.4, 0.72, 1.5, 2.4, 3.2]) expect(rmsAt(out, start, 0.15)).toBeGreaterThan(-35);
    expect(rmsAt(out, 3.9, 0.1)).toBeLessThan(rmsAt(out, 3.2, 0.15) - 10);
  });

  it.each(['narration', 'sfx'] as const)('does not repeat a short %s track', (kind) => {
    const root = makeRoot();
    const audio = path.join(root, 'once.m4a');
    tone(audio, 0.5);
    const manifest = timeline([{ id: 'a', duration: 3 }], {
      tracks: [{ kind, asset: 'once', volume: 1 }],
    });
    const out = mix(root, 3, timelineAudioTracks({ manifest, timeline: deriveVideoTimeline(manifest), resolve: () => audio }));
    expect(rmsAt(out, 0.1, 0.2)).toBeGreaterThan(-30);
    expect(rmsAt(out, 1, 1.5)).toBeLessThan(-60);
    expect(probe(out).duration).toBeCloseTo(3, 1);
  });

  it('keeps short music audible in full and cached timeline renders without rewriting its source', async () => {
    const root = makeRoot();
    const p = setup(root);
    const music = path.join(p.production, 'media', 'song.m4a');
    const voice = path.join(p.production, 'media', 'voice.wav');
    tone(music, 0.5);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.3', '-ac', '2', '-c:a', 'pcm_s16le', voice]);
    const original = sha(music);
    fs.writeFileSync(path.join(p.production, 'assets.json'), JSON.stringify({ assets: [
      { id: 'clip', kind: 'video', label: 'Clip', path: 'media/clip.mp4', origin: 'upload' },
      { id: 'song', kind: 'audio', label: 'Song', path: 'media/song.m4a', origin: 'upload' },
      { id: 'voice', kind: 'audio', label: 'Voice', path: 'media/voice.wav', origin: 'upload' },
    ] }));
    p.writeManifest(timeline([{ id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 2 }], narration: { text: 'Hi', asset: 'voice' } }], {
      tracks: [{ kind: 'music', asset: 'song', volume: 0.5, fade_out: 0.3, duck: true }],
    }));
    for (const rendered of [1, 0]) {
      expect(await renderVideoTimeline(p.options())).toMatchObject({ ok: true,
        scene_segments: { rendered, reused: 1 - rendered }, media_qa: { ok: true, expected_audio_end_seconds: 2 } });
      expect(rmsAt(p.output, 1.3, 0.2)).toBeGreaterThan(-35);
      const measured = probe(p.output);
      expect(Math.abs(measured.duration - 2)).toBeLessThan(0.15);
      expect(Number(measured.streams.find(stream => stream.codec_type === 'audio')?.duration)).toBeCloseTo(2, 2);
      expect(fs.readdirSync(path.join(root, 'cache')).filter(name => name.startsWith('.'))).toEqual([]);
      expect(fs.readdirSync(path.dirname(p.output)).filter(name => name.startsWith('.'))).toEqual([]);
    }
    expect(sha(music)).toBe(original);
  });

  it('lowers ducked music while someone speaks and restores it afterwards', () => {
    const root = makeRoot();
    const music = path.join(root, 'music.m4a');
    const voice = path.join(root, 'voice.m4a');
    tone(music, 8, 220);
    tone(voice, 2, 880);
    const plain = mix(root, 6, [
      { absPath: music, startSec: 0, volume: 0.5 },
    ]);
    const plainDuring = rmsAt(plain, 2.5, 1);
    const ducked = mix(root, 6, [
      { absPath: music, startSec: 0, volume: 0.5, duck: true },
      { absPath: voice, startSec: 2, volume: 1, voice: true },
    ]);
    const { ffmpeg: bin } = bundledFfmpegPaths();
    const musicOnly = (start: number, dur: number) => {
      // Only the 220 Hz band: the voice's 880 Hz tone would hide what the music did.
      const run = spawnSync(bin as string, ['-hide_banner', '-ss', String(start), '-t', String(dur), '-i', ducked, '-af', 'lowpass=f=300,lowpass=f=300,volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
      return Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(run.stderr)?.[1]);
    };
    expect(musicOnly(2.5, 1)).toBeLessThan(musicOnly(0.5, 1) - 6);
    expect(musicOnly(5, 0.8)).toBeGreaterThan(musicOnly(2.5, 1) + 6);
    expect(plainDuring).toBeGreaterThan(-40);
  });

  it('builds the same filter as before for a track with none of the new fields', () => {
    const root = makeRoot();
    const audio = path.join(root, 'voice.m4a');
    tone(audio, 1);
    const args = buildVideoTrackRemuxArgs({
      priorVideoAbsPath: '/a.mp4',
      outputAbsPath: '/b.mp4',
      durationSec: 4,
      audioTracks: [{ absPath: audio, startSec: 1, volume: 0.8 }],
    });
    expect(args[args.indexOf('-filter_complex') + 1]).toBe('[1:a]volume=0.8,adelay=1000|1000,apad,atrim=0:4.000[a0];[a0]anull[aout]');
  });
});

describe('rendering across volumes', () => {
  // A 2026-11-03 Windows render failed every segment with EXDEV: the project sat on C:,
  // Orkas had its data root on D:, and each segment was staged beside the output and
  // renamed into the cache. Staging lives inside the cache, so this never spans volumes.
  function acrossVolumes(side: 'project-on-other-volume' | 'cache-on-other-volume') {
    const root = makeRoot();
    const projectVolume = path.join(root, side === 'project-on-other-volume' ? 'volume-b' : 'volume-a');
    const cacheVolume = path.join(root, side === 'project-on-other-volume' ? 'volume-a' : 'volume-b');
    fs.mkdirSync(projectVolume, { recursive: true });
    const p = setup(projectVolume);
    const realRename = fsPromises.rename;
    const volumeOf = (target: unknown) => path.relative(root, String(target)).split(path.sep)[0];
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (volumeOf(from) !== volumeOf(to)) {
        throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${from}' -> '${to}'`), { code: 'EXDEV' });
      }
      return realRename(from, to);
    });
    syncBuiltinESMExports();
    return { p, cacheDir: path.join(cacheVolume, 'cache'), rename };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it.each(['cache-on-other-volume', 'project-on-other-volume'] as const)('renders every scene when the %s', async (side) => {
    const { p, cacheDir } = acrossVolumes(side);
    const result = await renderVideoTimeline({ ...p.options(), segmentCacheDirAbs: cacheDir });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, scene_segments: { total: 2, rendered: 2, reused: 0 } });
    expect(fs.existsSync(p.output)).toBe(true);
    const entries = fs.readdirSync(cacheDir);
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(fs.existsSync(path.join(cacheDir, entry, 'segment.mp4'))).toBe(true);
  });

  it('clears staging when a scene fails mid-render', async () => {
    const { p, cacheDir } = acrossVolumes('cache-on-other-volume');
    electronFake.state.failAtCapture = 1;
    const result = await renderVideoTimeline({
      ...p.options(),
      segmentCacheDirAbs: cacheDir,
      // Fail the fresh-window retry too.
      onProgress: (event) => {
        if (String(event.message).includes('retrying')) electronFake.state.failAtCapture = electronFake.state.captures + 1;
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_SEGMENT_ASSEMBLY_INCOMPLETE' });
    expect(fs.existsSync(path.join(cacheDir, '.staging'))).toBe(false);
  });

  it('neither counts nor evicts staging when pruning the cache', async () => {
    const root = makeRoot();
    const sized = (dir: string, bytes: number, mtimeMs: number) => {
      const file = path.join(dir, 'segment.mp4');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, '');
      fs.truncateSync(file, bytes);
      fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
    };
    const entry = path.join(root, 'entry');
    const staging = path.join(root, '.staging', 'in-flight');
    // Staging is oldest and large enough to push the total past the 2 GiB cap; counted
    // or evicted, it would either delete the entry or be deleted itself.
    sized(entry, 1024 ** 3, 1_700_000_001_000);
    sized(staging, 2 * 1024 ** 3, 1_700_000_000_000);
    await pruneSegmentCache(root);
    expect(fs.existsSync(entry)).toBe(true);
    expect(fs.existsSync(staging)).toBe(true);
  });
});

describe('delivering a file the timeline has moved on from', () => {
  const reordered = () => timeline([
    { id: 'b', clips: [{ id: 'c2', asset: 'clip', in: 1, dur: 0.5 }] },
    { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 0.5 }] },
  ]);
  const deliver = (p: ReturnType<typeof setup>, root: string, extra: Record<string, unknown> = {}) => shipVideoFile({
    productionDirAbs: p.production, allowedRoots: [root], videoPathAbs: p.output, videoDirAbs: p.video, ...extra,
  });
  const findings = (result: unknown) => ((result as { issues?: Array<{ code: string }> }).issues ?? []).map((issue) => issue.code);

  it('refuses it until it is rendered again, and then delivers the new one', async () => {
    const root = makeRoot();
    const p = setup(root);
    await renderVideoTimeline(p.options());
    expect(await deliver(p, root)).toMatchObject({ ok: true, version: { id: 'v1' } });
    expect(JSON.parse(fs.readFileSync(path.join(p.video, '.last-render.json'), 'utf8')))
      .toMatchObject({ delivered_version_id: 'v1' });

    p.writeManifest(reordered());
    const stale = await deliver(p, root);
    expect(stale).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect(findings(stale)).toEqual(['DELIVERY_TIMELINE_CHANGED']);

    await renderVideoTimeline(p.options());
    // The fake window paints every frame alike, so the file itself comes out the same.
    expect(await deliver(p, root)).toMatchObject({ ok: true });
  });

  // Revised on 2026-11-09: only the facts a scene quotes reach the screen, so a fact noted after
  // the render, such as a selling point the video does not show, does not hold the file back.
  it('counts a change to the page or to a fact a scene quotes, not to one no scene quotes', async () => {
    const root = makeRoot();
    const page = (extra = '') => '<!doctype html><html><head></head><body><main data-composition-id="main">'
      + `<section data-scene-id="a"><h1 data-slot="amount">x</h1>${extra}</section><section data-scene-id="b"></section></main></body></html>`;
    const p = setup(root, {
      manifest: timeline([
        { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 0.5 }], text: { amount: { fact_id: 'price' } } },
        { id: 'b', clips: [{ id: 'c2', asset: 'clip', in: 1, dur: 0.5 }] },
      ]),
      page: page(),
    });
    const product = (facts: unknown[]) => fs.writeFileSync(path.join(p.production, 'product.json'), JSON.stringify({ name: 'Lamp', facts, images: [] }));
    const price = (text: string) => ({ id: 'price', text, source: 'user' });
    product([price('79')]);
    expect(await renderVideoTimeline(p.options())).toMatchObject({ ok: true });
    product([price('79'), { id: 'wireless', text: 'Wireless base', source: 'page' }]);
    const delivered = await deliver(p, root);
    expect(findings(delivered)).toEqual([]);
    expect(delivered).toMatchObject({ ok: true });

    product([price('69'), { id: 'wireless', text: 'Wireless base', source: 'page' }]);
    expect(findings(await deliver(p, root))).toEqual(['DELIVERY_TIMELINE_CHANGED']);

    await renderVideoTimeline(p.options());
    expect((await deliver(p, root)).ok).toBe(true);
    fs.writeFileSync(path.join(p.video, 'index.html'), page('<p>new</p>'));
    expect(findings(await deliver(p, root))).toEqual(['DELIVERY_TIMELINE_CHANGED']);
  });

  it('delivers it when the user chose to keep the file as it is', async () => {
    const root = makeRoot();
    const p = setup(root);
    await renderVideoTimeline(p.options());
    p.writeManifest(reordered());
    const kept = await deliver(p, root, { override: { codes: ['DELIVERY_TIMELINE_CHANGED'], reason: 'keep the old order for now' } });
    expect(kept).toMatchObject({ ok: true, version: { override: { codes: ['DELIVERY_TIMELINE_CHANGED'] } } });
  });

  it('does not judge a file that did not come from the last render, such as one made from it with ffmpeg', async () => {
    const root = makeRoot();
    const p = setup(root);
    await renderVideoTimeline(p.options());
    const edited = path.join(p.production, 'render', 'with-subtitles.mp4');
    fs.copyFileSync(p.output, edited);
    p.writeManifest(reordered());
    const result = await shipVideoFile({ productionDirAbs: p.production, allowedRoots: [root], videoPathAbs: edited, videoDirAbs: p.video });
    expect(findings(result)).not.toContain('DELIVERY_TIMELINE_CHANGED');
  });

  it('does not judge a video that was never rendered here', async () => {
    const root = makeRoot();
    const p = setup(root);
    fs.mkdirSync(path.dirname(p.output), { recursive: true });
    ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=${WIDTH}x${HEIGHT}:r=30:d=1`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', p.output]);
    expect(findings(await deliver(p, root))).not.toContain('DELIVERY_TIMELINE_CHANGED');
  });

  it('notices a change made while it was rendering', async () => {
    const root = makeRoot();
    const p = setup(root);
    await renderVideoTimeline({
      ...p.options(),
      onProgress: (event) => { if (event.phase === 'video.render.capture') p.writeManifest(reordered()); },
    });
    expect(findings(await deliver(p, root))).toEqual(['DELIVERY_TIMELINE_CHANGED']);
  });
});

// On 2026-11-08 headlines sat on the lamp in a real run, and in twelve retests Luna still put words
// on the product in five; asking in the skill and at delivery was not enough.
describe('words on a marked product', () => {
  const cover = {
    box: { left: 0, top: 0, width: 1080, height: 1920 },
    layout: { width: 1080, height: 1920 },
    natural: { width: 1536, height: 1024 },
    fit: 'cover',
    position: '78% 50%',
  };

  it('places the marked part of a cover-fitted image where the page shows it', () => {
    // 1536x1024 covering 1080x1920 is drawn 2880 wide; 78% of the 1800 left over moves it 1404 left.
    expect(productRectOnCanvas(cover, [0.6, 0, 0.9, 1])).toEqual({ left: 324, top: 0, right: 1188, bottom: 1920 });
  });

  it('follows a push-in that scales the image', () => {
    const zoomed = { ...cover, box: { left: -50, top: -50, width: 1100, height: 1100 }, layout: { width: 1000, height: 1000 }, natural: { width: 1000, height: 1000 }, fit: 'fill', position: '50% 50%' };
    expect(productRectOnCanvas(zoomed, [0.5, 0.5, 1, 1])).toEqual({ left: 500, top: 500, right: 1050, bottom: 1050 });
  });

  it('letterboxes a contained image, and reads a position given in pixels', () => {
    const contained = { ...cover, box: { left: 0, top: 0, width: 400, height: 400 }, layout: { width: 400, height: 400 }, natural: { width: 800, height: 400 }, fit: 'contain', position: '50% 50%' };
    expect(productRectOnCanvas(contained, [0, 0, 1, 1])).toEqual({ left: 0, top: 100, right: 400, bottom: 300 });
    expect(productRectOnCanvas({ ...contained, position: '0px 30px' }, [0, 0, 1, 1])).toEqual({ left: 0, top: 30, right: 400, bottom: 230 });
  });

  it('reads a region given right to left the same, and ignores one with no area', () => {
    expect(productRectOnCanvas(cover, [0.9, 1, 0.6, 0])).toEqual(productRectOnCanvas(cover, [0.6, 0, 0.9, 1]));
    expect(productRectOnCanvas(cover, [0.5, 0.2, 0.5, 0.8])).toBeNull();
    expect(productRectOnCanvas({ ...cover, natural: { width: 0, height: 0 } }, [0, 0, 1, 1])).toBeNull();
  });

  it('measures how much of a line lies on the product', () => {
    expect(shareOnProduct({ left: 0, top: 0, right: 100, bottom: 20 }, { left: 50, top: 0, right: 200, bottom: 100 })).toBe(0.5);
    expect(shareOnProduct({ left: 0, top: 0, right: 100, bottom: 20 }, { left: 100, top: 0, right: 200, bottom: 100 })).toBe(0);
  });

  function marked(root: string, subject?: unknown) {
    const p = setup(root, {
      assets: [{ id: 'photo', kind: 'image', label: 'Lamp', path: 'media/photo.png', origin: 'upload', ...(subject ? { subject } : {}) }],
      manifest: timeline([
        { id: 'light', clips: [{ id: 'c1', asset: 'photo', in: 0, dur: 0.5 }] },
        { id: 'price', clips: [{ id: 'c2', asset: 'photo', in: 0, dur: 0.5 }] },
      ]),
    });
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=300x200', '-frames:v', '1', path.join(p.production, 'media', 'photo.png')]);
    return { ...p, check: (extra: Record<string, unknown> = {}) => checkVideoTimeline({ ...p.options(), ...extra }) };
  }
  it('asks for a fix before rendering when words sit on a marked product, naming each line once', async () => {
    const p = marked(makeRoot(), [0.5, 0, 1, 1]);
    // A line well on it at every frame of the scene, and small print that only grazes it.
    electronFake.state.productCover = { light: [{ text: '无频闪', share: 0.6 }, { text: 'Small print', share: 0.1 }] };
    const asked = vi.fn();
    const result = await p.check({ onWordsOnProductAsked: asked });
    // The fake frames are one flat colour, so the empty-scene request comes first.
    expect(result).toMatchObject({ ok: true, visual_review: { status: 'has_findings', advisory: true } });
    expect(result.message).toContain('Words cover the product in "无频闪" (light). Move the copy or the crop until the product is clear, then check again before rendering.');
    expect(result.message).not.toContain('Small print');
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('names at most three lines, in the order the scenes play', async () => {
    const p = marked(makeRoot(), [0.5, 0, 1, 1]);
    electronFake.state.productCover = {
      light: [{ text: '无频闪', share: 0.6 }, { text: '三档色温', share: 0.4 }],
      price: [{ text: '¥199', share: 0.9 }, { text: '点击了解', share: 0.5 }],
    };
    expect((await p.check()).message).toContain('Words cover the product in "无频闪" (light), "三档色温" (light), "¥199" (price). Move the copy or the crop until the product is clear, then check again before rendering.');
  });

  it('looks for nothing when no image marks where its product is', async () => {
    const p = marked(makeRoot());
    electronFake.state.productCover = { light: [{ text: '无频闪', share: 0.9 }] };
    const result = await p.check();
    expect(result.ok).toBe(true);
    expect(String(result.message ?? '')).not.toContain('Words cover the product');
    expect(electronFake.state.calls.some((script) => script.includes('productRectOnCanvas'))).toBe(false);
  });

  it('after asking three times in a run, lists it among the warnings instead', async () => {
    const p = marked(makeRoot(), [0.5, 0, 1, 1]);
    electronFake.state.productCover = { light: [{ text: '无频闪', share: 0.6 }] };
    const asked = vi.fn();
    const result = await p.check({ wordsOnProductAsked: 3, onWordsOnProductAsked: asked });
    expect(result.ok).toBe(true);
    expect(String(result.message ?? '')).not.toContain('Words cover the product');
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'TEXT_OVER_PRODUCT' }));
    expect(asked).not.toHaveBeenCalled();
  });

  it('refuses a marked region that is not four numbers', async () => {
    const p = marked(makeRoot(), [0.5, 0]);
    const result = await p.check();
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_CHECK_BLOCKED' });
    expect(String(result.message)).toContain('assets.json does not match its schema');
  });
});

describe('advisory visual review follows the checked input and delivered version', () => {
  it('round-trips measured facts while preserving legacy records and discarding untrusted optional evidence', () => {
    const legacy = { code: 'LOW_CONTRAST', count: 1, scenes: ['a'], examples: [{ scene_id: 'a', selector: '.title', message: 'Low contrast' }] };
    expect(parseVisualReview(visualReview('has_findings', [legacy]))).toEqual(visualReview('has_findings', [legacy]));
    const row = { ...legacy, count: 3, target_count: 1, unlocated_count: 0, examples: [{ ...legacy.examples[0], occurrences: 3, scene_time_sec: 0,
      evidence: { contrast_ratio: 1.2, minimum_ratio: 4.5, private: 'private-data' } }] };
    const review = visualReview('has_findings', [row]);
    const parsed = parseVisualReview(JSON.parse(JSON.stringify(review)));
    expect(parsed).toMatchObject({ status: 'has_findings', findings: [{ target_count: 1, unlocated_count: 0,
      examples: [{ occurrences: 3, scene_time_sec: 0, evidence: { contrast_ratio: 1.2, minimum_ratio: 4.5 } }] }] });
    expect(JSON.stringify(parsed)).not.toContain('private-data');
    const malformed = parseVisualReview({ ...review, findings: [{ ...row, examples: [{ ...row.examples[0],
      evidence: { contrast_ratio: 'private-data', minimum_ratio: Number.NaN, arbitrary: 'private-data' } }] }] });
    expect(malformed).toMatchObject({ status: 'has_findings', findings: [{ examples: [{ message: 'Low contrast' }] }] });
    expect(malformed?.findings[0].examples[0]).not.toHaveProperty('evidence');
  });

  it('rejects impossible counts or sample times without turning broken records into a clean check', () => {
    const row = { code: 'LOW_CONTRAST', count: 3, scenes: ['a'], examples: [{ scene_id: 'a', selector: '.title', message: 'Low contrast' }] };
    for (const invalid of [
      { ...row, target_count: 4 }, { ...row, unlocated_count: -1 }, { ...row, target_count: 2, unlocated_count: 2 },
      { ...row, target_count: 1, omitted_targets: 2 },
      { ...row, examples: [{ ...row.examples[0], occurrences: 4 }] },
      { ...row, examples: [{ ...row.examples[0], scene_time_sec: -1 }] },
    ]) expect(parseVisualReview({ status: 'has_findings', scope: 'sampled_page', advisory: true, findings: [invalid] })).toBeNull();
  });

  it('keeps review unavailable for an escaping resource without an additional binary read', async () => {
    const p = setup(makeRoot(), { page: '<html><head><link rel="stylesheet" href="assets/foreign.css"></head><body><main data-composition-id="main"><section data-scene-id="a"><img data-clip="c1"></section><section data-scene-id="b"><img data-clip="c2"></section></main></body></html>' });
    const foreign = path.join(makeRoot(), 'foreign.css');
    fs.writeFileSync(foreign, 'body{color:red}');
    fs.mkdirSync(path.join(p.video, 'assets'), { recursive: true });
    fs.symlinkSync(foreign, path.join(p.video, 'assets/foreign.css'));
    const reads = vi.spyOn(fsPromises, 'readFile');
    syncBuiltinESMExports();
    try {
      const result = await checkVideoTimeline(p.options());
      expect(result).toMatchObject({ ok: true, visual_review: { status: 'unavailable' } });
      expect(reads.mock.calls.filter(([file, options]) => String(file) === path.join(p.video, 'assets/foreign.css') && options === undefined)).toEqual([]);
      expect(fs.readFileSync(foreign, 'utf8')).toBe('body{color:red}');
    } finally { reads.mockRestore(); syncBuiltinESMExports(); }
  });

  it('does not count a check as a render or a pending timeline edit', async () => {
    const p = setup(makeRoot());
    await checkVideoTimeline(p.options());
    expect(await timelineAheadOfDelivery(p.options())).toBe(false);
    await noteTimelineBeforeChange(p.options());
    p.writeManifest({ ...timeline(), label: 'Changed' });
    expect(await timelineAheadOfDelivery(p.options())).toBe(true);
  });

  it('keeps advisory results bounded without silently calling omitted findings clean', () => {
    const findings = Array.from({ length: 17 }, (_, index) => ({
      code: `FINDING_${index}`, count: 30, scenes: Array.from({ length: 30 }, (_v, at) => `scene-${at}`),
      examples: Array.from({ length: 30 }, () => ({ message: 'x'.repeat(400), selector: 'p'.repeat(400) })),
    }));
    const bounded = visualReview('has_findings', findings);
    expect(bounded).toMatchObject({ status: 'has_findings', omitted_finding_types: 1 });
    expect(bounded.findings).toHaveLength(16);
    expect(bounded.findings[0].scenes).toHaveLength(12);
    expect(bounded.findings[0].examples).toHaveLength(2);
    expect(bounded.findings[0].examples[0].message).toHaveLength(200);
    expect(bounded.findings[0].examples[0].selector).toHaveLength(200);
    expect(parseVisualReview(bounded)).toEqual(bounded);
    expect(parseVisualReview({ ...bounded, status: 'no_findings' })).toBeNull();
    expect(parseVisualReview({ ...bounded, advisory: false })).toBeNull();
  });

  it('keeps malformed or legacy review records unknown rather than inventing a pass', async () => {
    const p = setup(makeRoot());
    await checkVideoTimeline(p.options());
    const file = path.join(p.video, '.last-render.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.visual_check.review = { status: 'no_findings' };
    fs.writeFileSync(file, JSON.stringify(record));
    expect(await renderVideoTimeline(p.options())).toMatchObject({ ok: true, visual_review: { status: 'unavailable' } });
    fs.writeFileSync(file, JSON.stringify({ output: 'render/old.mp4', source_sha256: 'old-format' }));
    expect(await renderVideoTimeline(p.options())).toMatchObject({ ok: true, visual_review: { status: 'not_checked' } });
  });

  it('does not turn unavailable review storage into a render gate or write outside the production', async () => {
    const p = setup(makeRoot());
    const foreign = path.join(makeRoot(), 'record.json');
    fs.writeFileSync(foreign, '{}');
    fs.symlinkSync(foreign, path.join(p.video, '.last-render.json'));
    const options = { ...p.options(), allowedRoots: [...roots] };
    expect(await checkVideoTimeline(options)).toMatchObject({ ok: true });
    expect(await renderVideoTimeline(options)).toMatchObject({ ok: true, visual_review: { status: 'unavailable' } });
    expect(fs.readFileSync(foreign, 'utf8')).toBe('{}');
    expect(fs.existsSync(p.output)).toBe(true);
  });

  it('keeps execution successful while carrying unresolved findings from check through render and delivery', async () => {
    const root = makeRoot();
    const p = setup(root);
    electronFake.state.inspectIssues = [
      { code: 'LOW_CONTRAST', severity: 'warning', sceneId: 'a', selector: '.title', message: 'Low contrast',
        evidence: { contrast_ratio: 1.2, minimum_ratio: 4.5 } },
      { code: 'LOW_CONTRAST', severity: 'warning', sceneId: 'a', selector: '.caption', message: 'Low contrast',
        evidence: { contrast_ratio: 2.2, minimum_ratio: 4.5 } },
    ];
    const checked = await checkVideoTimeline(p.options());
    expect(checked).toMatchObject({ ok: true, visual_review: {
      status: 'has_findings', scope: 'sampled_page', advisory: true,
      findings: expect.arrayContaining([expect.objectContaining({ code: 'SCENE_MOSTLY_EMPTY' })]),
    } });
    const finding = (checked.visual_review as ReturnType<typeof visualReview>).findings.find(row => row.code === 'LOW_CONTRAST');
    expect(finding).toMatchObject({ count: 6, target_count: 2, unlocated_count: 0,
      examples: [
        { scene_id: 'a', selector: '.title', occurrences: 3, scene_time_sec: 0, evidence: { contrast_ratio: 1.2, minimum_ratio: 4.5 } },
        { scene_id: 'a', selector: '.caption', occurrences: 3, scene_time_sec: 0, evidence: { contrast_ratio: 2.2, minimum_ratio: 4.5 } },
      ] });
    expect(electronFake.state.calls.filter(script => script.includes('const issues = [];'))).toHaveLength(6);
    const rendered = await renderVideoTimeline(p.options());
    expect(rendered).toMatchObject({ ok: true, visual_review: checked.visual_review });
    const shipped = await shipVideoFile({ productionDirAbs: p.production, videoDirAbs: p.video, allowedRoots: [root], videoPathAbs: p.output });
    expect(shipped).toMatchObject({ ok: true, visual_review: checked.visual_review, version: { visual_review: checked.visual_review } });
    expect(JSON.parse(fs.readFileSync(path.join(p.production, 'versions.json'), 'utf8')).versions[0].visual_review).toEqual(checked.visual_review);
  });

  it('does not promote an unchecked render when a later check finds no issues', async () => {
    const root = makeRoot();
    const p = setup(root);
    expect(await renderVideoTimeline(p.options())).toMatchObject({ ok: true, visual_review: { status: 'not_checked' } });
    electronFake.state.textured = true;
    electronFake.state.moving = true;
    expect(await checkVideoTimeline(p.options())).toMatchObject({ ok: true, visual_review: { status: 'no_findings', findings: [] } });
    expect(await shipVideoFile({ productionDirAbs: p.production, videoDirAbs: p.video, allowedRoots: [root], videoPathAbs: p.output }))
      .toMatchObject({ ok: true, visual_review: { status: 'not_checked' } });
  });

  it.each(['manifest', 'page', 'ledger', 'asset', 'stylesheet'])('marks the prior review stale after a change to %s and still renders', async (changed) => {
    const root = makeRoot();
    const p = setup(root, { page: '<html><head><link rel="stylesheet" href="assets/look.css"></head><body><main data-composition-id="main"><section data-scene-id="a"><img data-clip="c1"></section><section data-scene-id="b"><img data-clip="c2"></section></main></body></html>' });
    fs.mkdirSync(path.join(p.video, 'assets'), { recursive: true });
    const css = path.join(p.video, 'assets/look.css');
    fs.writeFileSync(css, 'body{color:red}');
    expect(await checkVideoTimeline(p.options())).toMatchObject({ ok: true });
    if (changed === 'manifest') p.writeManifest({ ...timeline(), label: 'Updated' });
    if (changed === 'page') fs.appendFileSync(path.join(p.video, 'index.html'), '<!-- changed -->');
    if (changed === 'ledger') {
      const file = path.join(p.production, 'assets.json');
      const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
      ledger.assets[0].label = 'New source label';
      fs.writeFileSync(file, JSON.stringify(ledger));
    }
    if (changed === 'asset') sourceClip(p.clip, 4);
    if (changed === 'stylesheet') fs.writeFileSync(css, 'body{color:blue}');
    expect(await renderVideoTimeline(p.options())).toMatchObject({ ok: true, visual_review: { status: 'stale' } });
  });

  it('clears findings only with a fresh check and preserves the earlier delivered review', async () => {
    const root = makeRoot();
    const p = setup(root);
    const paths = { productionDirAbs: p.production, videoDirAbs: p.video, allowedRoots: [root], videoPathAbs: p.output };
    await checkVideoTimeline(p.options());
    await renderVideoTimeline(p.options());
    const first = await shipVideoFile(paths);
    expect(first).toMatchObject({ ok: true, visual_review: { status: 'has_findings' } });
    // Change a visible source window, so the cache must render new pixels;
    // changing only a label correctly reuses the old video and its old review.
    p.writeManifest(timeline([
      { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0.1, dur: 0.5 }] },
      { id: 'b', clips: [{ id: 'c2', asset: 'clip', in: 1, dur: 0.5 }] },
    ]));
    electronFake.state.textured = true;
    electronFake.state.moving = true;
    expect(await checkVideoTimeline(p.options())).toMatchObject({ ok: true, visual_review: { status: 'no_findings' } });
    expect(await renderVideoTimeline(p.options())).toMatchObject({ ok: true, visual_review: { status: 'no_findings' } });
    expect(await shipVideoFile(paths)).toMatchObject({ ok: true, visual_review: { status: 'no_findings' }, version: { id: 'v2' } });
    expect(JSON.parse(fs.readFileSync(path.join(p.production, 'versions.json'), 'utf8')).versions[0].visual_review.status).toBe('has_findings');
  });

  it('does not apply a timeline review to a different output or a changed finalized copy', async () => {
    const root = makeRoot();
    const p = setup(root);
    await checkVideoTimeline(p.options());
    await renderVideoTimeline(p.options());
    const paths = { productionDirAbs: p.production, videoDirAbs: p.video, allowedRoots: [root] };
    const other = path.join(p.production, 'other.mp4');
    sourceClip(other, 1);
    expect(await shipVideoFile({ ...paths, videoPathAbs: other })).toMatchObject({ ok: true, visual_review: { status: 'not_checked' } });
    expect(await shipVideoFile({ ...paths, videoPathAbs: p.output, finalize: async (file) => { fs.appendFileSync(file, 'marked'); } }))
      .toMatchObject({ ok: true, visual_review: { status: 'stale' }, version: { visual_review: { status: 'stale' } } });
  });

  it('replaces a prior clear result with unavailable after a failed check', async () => {
    const root = makeRoot();
    const p = setup(root);
    electronFake.state.textured = true;
    electronFake.state.moving = true;
    expect(await checkVideoTimeline(p.options())).toMatchObject({ ok: true });
    electronFake.state.failAtCapture = electronFake.state.captures + 1;
    expect(await checkVideoTimeline(p.options())).toMatchObject({ ok: false, visual_review: { status: 'unavailable' } });
    electronFake.state.failAtCapture = -1;
    expect(await renderVideoTimeline(p.options())).toMatchObject({ ok: true, visual_review: { status: 'unavailable' } });
  });
});

describe('pictures a page places by file', () => {
  it('asks for clips in video.check without stopping it, and leaves the page around the scenes alone', async () => {
    const p = setup(makeRoot(), {
      assets: [
        { id: 'clip', kind: 'video', label: 'Clip', path: 'media/clip.mp4', origin: 'upload' },
        { id: 'r18', kind: 'image', label: 'Site', path: 'videos/main/assets/r18.png', origin: 'page' },
        { id: 'logo', kind: 'image', label: 'Logo', path: 'videos/main/assets/logo.png', origin: 'upload' },
      ],
      manifest: timeline([
        { id: 'a', clips: [{ id: 'c1', asset: 'clip', in: 0, dur: 0.5 }] },
        { id: 'memory', duration: 0.5 },
      ]),
      page: '<!doctype html><html><head></head><body><main data-composition-id="main"><img src="assets/logo.png">'
        + '<section data-scene-id="memory"><img src="assets/r18.png"></section></main></body></html>',
    });
    fs.mkdirSync(path.join(p.video, 'assets'), { recursive: true });
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=300x200', '-frames:v', '1', path.join(p.video, 'assets', 'r18.png')]);
    fs.copyFileSync(path.join(p.video, 'assets', 'r18.png'), path.join(p.video, 'assets', 'logo.png'));

    const result = await checkVideoTimeline(p.options());

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual({
      code: 'PAGE_PICTURE_NOT_A_CLIP',
      count: 1,
      target_count: 1,
      unlocated_count: 0,
      scenes: ['memory'],
      examples: [{
        scene_id: 'memory',
        selector: '[data-scene-id="memory"]',
        occurrences: 1,
        message: 'Scene "memory" places "r18" from assets.json straight in its page markup, so the canvas cannot show or swap it. Add it to the scene\'s "clips" and show it with <img data-clip="id">.',
      }],
    });
  });
});
