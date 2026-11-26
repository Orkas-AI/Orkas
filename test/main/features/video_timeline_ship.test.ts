import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import sharp from 'sharp';

import { deliveredFrameSamples, parseVisualHints, recordProductionVoice, shipVideoFile, writeDeliveredFrameSheet } from '../../../src/main/features/video_timeline_ship';
import * as storage from '../../../src/main/storage';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';
import * as fileHash from '../../../src/main/util/sha256';
import { driftingCuts, makeBeatMontage } from '../../fixtures/beat-montage';

// The gate judges the file, so these cases build files the way a model might, by
// hand with ffmpeg, and never through the renderer. That is the 2026-08-10 lesson:
// a check attached to one tool disappears when the model uses another.

const { deliveryWarning } = vi.hoisted(() => ({ deliveryWarning: vi.fn() }));
vi.mock('../../../src/main/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/logger')>();
  return { ...actual, createLogger: (name: string) => {
    const logger = actual.createLogger(name);
    if (name !== 'video-timeline-ship') return logger;
    return { ...logger, warn: (...args: Parameters<typeof logger.warn>) => {
      deliveryWarning(...args);
      logger.warn(...args);
    } };
  } };
});

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-ship-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function ffmpeg(args: string[]): void {
  const { ffmpeg: bin } = bundledFfmpegPaths();
  const run = spawnSync(bin as string, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
}

/** A moving picture so the static hint stays out of cases about something else. */
function picture(file: string, seconds: number, size = '360x640', source = 'testsrc2'): void {
  ffmpeg(['-f', 'lavfi', '-i', `${source}=s=${size}:r=30:d=${seconds}`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file]);
}

function withTone(file: string, seconds: number, toneSeconds = seconds): void {
  ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=s=360x640:r=30:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${toneSeconds}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  ]);
}

function codes(result: { issues?: unknown; warnings?: unknown }, key: 'issues' | 'warnings' = 'issues'): string[] {
  return ((result[key] ?? []) as Array<{ code: string }>).map((issue) => issue.code);
}

function project(root: string, manifest: unknown, assets: unknown[] = []) {
  const production = path.join(root, 'production');
  const video = path.join(production, 'videos', 'main');
  fs.mkdirSync(video, { recursive: true });
  fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(production, 'assets.json'), JSON.stringify({ assets }));
  return { production, video };
}

function timeline(scenes: unknown[], extra: Record<string, unknown> = {}) {
  return {
    schema_version: 3,
    id: 'main',
    label: 'Ad',
    canvas: { width: 360, height: 640, fps: 30 },
    scenes,
    ...extra,
  };
}

describe('shipVideoFile against a timeline', () => {
  it('advises on the kept original sound in the published file, even if it has a different soundtrack', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([
      { id: 'intro', duration: 2 },
      { id: 'dialogue', clips: [{ id: 'a', asset: 'episode', in: 1, dur: 3, audio: 'keep' }] },
    ]), [{ id: 'episode', kind: 'video', label: 'Episode', path: 'episode.mp4', origin: 'upload' }]);
    const source = path.join(production, 'episode.mp4');
    const replacement = path.join(root, 'replacement.mp4');
    const kept = path.join(root, 'kept.mp4');
    const covered = path.join(root, 'covered.mp4');
    const noise = (seed: number, volume: string) => `anoisesrc=d=5:c=pink:r=16000:a=${volume}:seed=${seed}`;
    for (const [file, seed] of [[source, 1], [replacement, 2]] as const) {
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=5', '-f', 'lavfi', '-i', noise(seed, '0.3'),
        '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', file]);
    }
    for (const [file, level, bed] of [[kept, '0.65', '0.04'], [covered, '0.15', '0.6']] as const) {
      const original = `[0:a]atrim=start=1:end=4,asetpts=N/SR/TB,volume=${level},adelay=2000:all=1[original]`;
      ffmpeg(['-i', source, '-f', 'lavfi', '-i', noise(2, bed), '-filter_complex',
        `${original};[1:a][original]amix=inputs=2:duration=first:normalize=0[mix]`,
        '-map', '0:v', '-map', '[mix]', '-c:v', 'copy', '-c:a', 'aac', file]);
    }
    const warningCode = 'DELIVERY_ORIGINAL_AUDIO_UNVERIFIED';
    const options = { productionDirAbs: production, videoDirAbs: video, allowedRoots: [root] };
    const ship = (file: string) => shipVideoFile({ ...options, videoPathAbs: file });
    const checkWarning = (result: Awaited<ReturnType<typeof ship>>) => {
      expect(result).toMatchObject({
        ok: true, version: { warnings: expect.arrayContaining([warningCode]) },
        warnings: expect.arrayContaining([expect.objectContaining({
          code: warningCode, severity: 'warning', message: expect.stringMatching(/2\.00s.*5\.00s/),
        })]),
      });
      expect(codes(result, 'warnings')).not.toContain('DELIVERY_SILENT_STRETCH');
    };
    const original = await ship(kept);
    expect(original.ok).toBe(true);
    expect(codes(original, 'warnings')).not.toContain(warningCode);
    checkWarning(await ship(replacement));

    // Original sound still exists in the covered export, so the finding is uncertainty.
    checkWarning(await ship(covered));
    // Policy output and repeats are checked against what the user's version actually plays.
    checkWarning(await shipVideoFile({ ...options, videoPathAbs: kept, finalize: async (file) => {
      fs.copyFileSync(replacement, file);
    } }));
    checkWarning(await ship(kept));

    const standalone = await shipVideoFile({ ...options, videoDirAbs: undefined, videoPathAbs: replacement });
    expect(standalone.ok).toBe(true);
    expect(codes(standalone, 'warnings')).not.toContain(warningCode);
  }, 60_000);

  it('refuses a silent hand-made file for a narrated timeline', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline(
      [{ id: 'a', duration: 2, narration: { text: 'Hello', asset: 'voice' } }],
    ), [{ id: 'voice', kind: 'audio', label: 'Voice', path: 'voice.m4a', origin: 'generated' }]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'aac', path.join(production, 'voice.m4a')]);
    const file = path.join(root, 'made-by-hand.mp4');
    picture(file, 2);
    const result = await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect(codes(result)).toContain('DELIVERY_NO_AUDIO');
    expect(fs.existsSync(path.join(production, 'versions.json'))).toBe(false);
  });

  it('refuses two narration lines that talk over each other', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([
      { id: 'a', duration: 2, narration: { text: 'One', asset: 'long' } },
      { id: 'b', duration: 2, narration: { text: 'Two', asset: 'short' } },
    ]), [
      { id: 'long', kind: 'audio', label: 'Long', path: 'long.m4a', origin: 'generated' },
      { id: 'short', kind: 'audio', label: 'Short', path: 'short.m4a', origin: 'generated' },
    ]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.6', '-c:a', 'aac', path.join(production, 'long.m4a')]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1', '-c:a', 'aac', path.join(production, 'short.m4a')]);
    const file = path.join(root, 'out.mp4');
    withTone(file, 4);
    const result = await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file });
    expect(codes(result)).toContain('DELIVERY_NARRATION_OVERLAP');
  });

  it('leaves a frame of each delivered scene for whatever shows the scenes', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([{ id: 'a', duration: 1 }, { id: 'b', duration: 2 }]));
    const file = path.join(root, 'out.mp4');
    picture(file, 3);

    expect(await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file })).toMatchObject({ ok: true });

    const [run, ...others] = fs.readdirSync(path.join(production, 'preview', 'main'));
    expect(others).toEqual([]);
    const frames = fs.readdirSync(path.join(production, 'preview', 'main', run)).sort();
    expect(frames).toEqual(['01-a-end.png', '02-b-end.png']);
    const meta = await sharp(path.join(production, 'preview', 'main', run, '02-b-end.png')).metadata();
    expect(meta.width).toBe(480);
  });

  it('makes an older version\'s bytes the latest again, as moving a scene back does', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([{ id: 'a', duration: 1 }]));
    const first = path.join(root, 'first.mp4');
    const second = path.join(root, 'second.mp4');
    picture(first, 1, '360x640', 'testsrc2');
    picture(second, 1, '360x640', 'testsrc');
    const ship = (file: string) => shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file });

    const shipped = [await ship(first), await ship(second), await ship(first)] as Array<{ version: { id: string; path: string } }>;

    expect(shipped.map((result) => result.version.id)).toEqual(['v1', 'v2', 'v3']);
    const versions = JSON.parse(fs.readFileSync(path.join(production, 'versions.json'), 'utf8')).versions;
    expect(versions).toHaveLength(3);
    expect(fs.readFileSync(path.join(production, versions[2].path)).equals(fs.readFileSync(first))).toBe(true);
  });

  it('answers a repeat of the latest delivery with the same version', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([{ id: 'a', duration: 1 }]));
    const file = path.join(root, 'out.mp4');
    picture(file, 1);
    const ship = () => shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file });

    const results = [await ship(), await ship()] as Array<{ version: { id: string } }>;

    expect(results.map((result) => result.version.id)).toEqual(['v1', 'v1']);
  });

  it('remembers that this timeline reached delivery', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([{ id: 'a', duration: 1 }]));
    const file = path.join(root, 'out.mp4');
    picture(file, 1);
    const { noteTimelineBeforeChange, timelineAheadOfDelivery } = await import('../../../src/main/features/video_timeline_render');
    const paths = { productionDirAbs: production, videoDirAbs: video };
    await noteTimelineBeforeChange(paths);
    fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify(timeline([{ id: 'a', duration: 1 }, { id: 'b', duration: 0.1 }])));
    expect(await timelineAheadOfDelivery(paths)).toBe(true);
    fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify(timeline([{ id: 'a', duration: 1 }])));

    expect(await shipVideoFile({ ...paths, allowedRoots: [root], videoPathAbs: file })).toMatchObject({ ok: true });

    expect(await timelineAheadOfDelivery(paths)).toBe(false);
  });

  // Decided 2026-11-09: the Agent applies product changes when the user updates a video, so a
  // delivery remembers the product info it went out with, and the next delivery takes changes in.
  it('remembers the product info a delivery went out with', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([{ id: 'a', duration: 1 }]));
    const file = path.join(root, 'out.mp4');
    picture(file, 1);
    const facts = (list: unknown[]) => fs.writeFileSync(path.join(production, 'product.json'), JSON.stringify({ name: 'Lamp', facts: list, images: [] }));
    facts([{ id: 'price', text: '$29', source: 'page' }, { id: 'base', text: 'Wireless base', source: 'page' }]);
    const { productChangesSinceDelivery } = await import('../../../src/main/features/video_timeline_render');
    const paths = { productionDirAbs: production, videoDirAbs: video };
    const ship = () => shipVideoFile({ ...paths, allowedRoots: [root], videoPathAbs: file });
    expect(await ship()).toMatchObject({ ok: true, version: { id: 'v1' } });
    expect(await productChangesSinceDelivery(paths)).toEqual([]);

    facts([
      { id: 'price', text: '$19', source: 'user' },
      { id: 'base', text: 'Wireless base', source: 'page' },
      { id: 'warranty', text: 'Two-year warranty', source: 'page' },
    ]);
    expect(await productChangesSinceDelivery(paths)).toEqual([{ before: '$29', after: '$19' }]);

    // Nothing on screen needed to change, so the same file goes out again as the same version.
    expect(await ship()).toMatchObject({ ok: true, version: { id: 'v1' } });
    expect(await productChangesSinceDelivery(paths)).toEqual([]);
  });

  it('has no scenes to show for a file with no timeline', async () => {
    const root = makeRoot();
    const production = path.join(root, 'production');
    fs.mkdirSync(production, { recursive: true });
    const file = path.join(root, 'out.mp4');
    picture(file, 1);

    expect(await shipVideoFile({ productionDirAbs: production, allowedRoots: [root], videoPathAbs: file })).toMatchObject({ ok: true });

    expect(fs.existsSync(path.join(production, 'preview'))).toBe(false);
  });

  it('refuses a file of the wrong length past the tolerance, not at it', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([{ id: 'a', duration: 4 }]));
    const within = path.join(root, 'within.mp4');
    picture(within, 3.6);
    expect(await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: within })).toMatchObject({ ok: true });
    const off = path.join(root, 'off.mp4');
    picture(off, 3);
    const result = await shipVideoFile({
      productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: off, expect: { durationSec: 3 },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect(codes(result)).toContain('DELIVERY_DURATION_DRIFT');
    expect(JSON.stringify(result)).not.toMatch(/approved plan/);
    expect(JSON.stringify(result)).toContain('Narration and captions are timed against');
  });

  it('refuses a file of the wrong shape', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([{ id: 'a', duration: 2 }]));
    const file = path.join(root, 'wide.mp4');
    picture(file, 2, '640x360');
    expect(codes(await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file }))).toContain('DELIVERY_ASPECT_MISMATCH');
  });

  it('delivers footage repeated across a cut, and says so with the delivery', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([
      { id: 'intro', clips: [{ id: 'a', asset: 'demo', in: 0, dur: 2 }] },
      { id: 'team', clips: [{ id: 'b', asset: 'demo', in: 1, dur: 2 }] },
    ]), [{ id: 'demo', kind: 'video', label: 'Demo', path: 'media/demo.mp4', origin: 'page' }]);
    fs.mkdirSync(path.join(production, 'media'));
    picture(path.join(production, 'media', 'demo.mp4'), 6);
    const file = path.join(root, 'out.mp4');
    picture(file, 4);

    const result = await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file });

    expect(result).toMatchObject({ ok: true, version: { warnings: expect.arrayContaining(['TIMELINE_ADJACENT_FOOTAGE_OVERLAP']) } });
    expect(codes(result, 'warnings')).toContain('TIMELINE_ADJACENT_FOOTAGE_OVERLAP');
  });

  it('refuses when an asset the timeline needs is gone from the ledger', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([{ id: 'a', clips: [{ id: 'c', asset: 'gone', in: 0, dur: 2 }] }]));
    const file = path.join(root, 'out.mp4');
    picture(file, 2);
    expect(codes(await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file }))).toContain('TIMELINE_ASSET_UNKNOWN');
  });
});

// A price change that edits the narration's words but keeps its audio file leaves the voice
// saying the old price. In the 2026-11-06 retests Luna did this in 4 of 12 runs and said the
// voice was updated; every run that voiced the line again first was correct.
describe('shipVideoFile and words that changed while the voice did not', () => {
  const VOICE = { route_ref: 'env:tts', voice_ref: 'env:tts:voice:abc' };
  const CODE = 'DELIVERY_NARRATION_NOT_REVOICED';

  function tone(file: string, frequency: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=1`, '-c:a', 'aac', file]);
  }

  /** A finished file of the two-second scene; each frequency gives different bytes. */
  function rendered(root: string, frequency: number): string {
    const file = path.join(root, `render-${frequency}.mp4`);
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=2',
      '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=2`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
    ]);
    return file;
  }

  function priceScene(text: string, asset = 'voice-price') {
    return timeline([{ id: 'price', duration: 2, narration: { text, asset } }]);
  }

  function setUp(row: Record<string, unknown> = {}) {
    const root = makeRoot();
    const voiceRow = { id: 'voice-price', kind: 'audio', label: 'Price', path: 'voice/price.m4a', origin: 'generated', request: VOICE, ...row };
    const { production, video } = project(root, priceScene('现在只要一百九十九元。'), [voiceRow]);
    tone(path.join(production, String(voiceRow.path)), 440);
    const ship = (file: string, override?: { codes: string[]; reason: string }) => shipVideoFile({
      productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file, ...(override ? { override } : {}),
    });
    const write = (manifest: unknown, rows: unknown[] = [voiceRow]) => {
      fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify(manifest));
      fs.writeFileSync(path.join(production, 'assets.json'), JSON.stringify({ assets: rows }));
    };
    const versions = () => JSON.parse(fs.readFileSync(path.join(production, 'versions.json'), 'utf8')).versions as unknown[];
    return { root, production, voiceRow, ship, write, versions };
  }

  const finding = (result: unknown) => ((result as { issues?: Array<{ code: string }> }).issues ?? []).find((issue) => issue.code === CODE);

  it('stops a delivery whose words changed on the same voice, and says what it said and which voice to use', async () => {
    const { root, ship, write, versions } = setUp();
    expect(await ship(rendered(root, 300))).toMatchObject({ ok: true });

    write(priceScene('现在只要一百七十九元。'));
    const result = await ship(rendered(root, 310));

    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect(finding(result)).toEqual({
      code: CODE,
      severity: 'error',
      message: 'Scene "price": the narration text changed but its audio is the same file as in the last delivery, when the text was "现在只要一百九十九元。". Generate this line again with its voice (route_ref env:tts, voice_ref env:tts:voice:abc), point the scene\'s narration at the new file, then render and ship.',
    });
    expect(versions()).toHaveLength(1);
  });

  it('knows a copy of the old voice under a new name is still the old voice', async () => {
    const { root, production, voiceRow, ship, write } = setUp();
    expect(await ship(rendered(root, 300))).toMatchObject({ ok: true });

    fs.copyFileSync(path.join(production, 'voice', 'price.m4a'), path.join(production, 'voice', 'price-179.m4a'));
    const copy = { id: 'voice-price-179', kind: 'audio', label: 'Price', path: 'voice/price-179.m4a', origin: 'generated' };
    write(priceScene('现在只要一百七十九元。', 'voice-price-179'), [voiceRow, copy]);
    const result = await ship(rendered(root, 310));

    // The copy's row names no voice, so the result cannot name one either.
    expect(finding(result)).toMatchObject({
      message: 'Scene "price": the narration text changed but its audio is the same file as in the last delivery, when the text was "现在只要一百九十九元。". Generate this line again with its voice, point the scene\'s narration at the new file, then render and ship.',
    });
  });

  it('delivers the change once the line is voiced again', async () => {
    const { root, production, voiceRow, ship, write, versions } = setUp();
    expect(await ship(rendered(root, 300))).toMatchObject({ ok: true });

    tone(path.join(production, 'voice', 'price-v2.m4a'), 660);
    const again = { ...voiceRow, id: 'voice-price-v2', path: 'voice/price-v2.m4a' };
    write(priceScene('现在只要一百七十九元。', 'voice-price-v2'), [voiceRow, again]);

    expect(await ship(rendered(root, 310))).toMatchObject({ ok: true, version: { id: 'v2' } });
    expect(versions()).toHaveLength(2);
  });

  it('does not count punctuation, spacing or full-width digits as changed words', async () => {
    const { root, ship, write } = setUp();
    write(priceScene('现在只要199元，点击下方了解。'));
    expect(await ship(rendered(root, 300))).toMatchObject({ ok: true });

    write(priceScene('现在只要１９９元 点击下方了解'));

    expect(await ship(rendered(root, 310))).toMatchObject({ ok: true, version: { id: 'v2' } });
  });

  it('leaves the user\'s own recording to the user', async () => {
    const { root, ship, write, voiceRow } = setUp({ path: 'media/my-voice.m4a', origin: 'upload', request: undefined });
    expect(await ship(rendered(root, 300))).toMatchObject({ ok: true });

    write(priceScene('现在只要一百七十九元。'), [voiceRow]);
    const result = await ship(rendered(root, 310));

    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect(finding(result)).toMatchObject({
      message: 'Scene "price": the narration text changed but its audio is the user\'s own recording, the same file as in the last delivery, when the text was "现在只要一百九十九元。". Only the user can record it again: tell them, and let them choose a new recording, captions only for this scene, or keeping it as it is.',
    });
  });

  it('delivers the old voice when the user chose to keep it, and does not stop those words again', async () => {
    const { root, ship, write } = setUp();
    expect(await ship(rendered(root, 300))).toMatchObject({ ok: true });
    write(priceScene('现在只要一百七十九元。'));
    expect(await ship(rendered(root, 310))).toMatchObject({ ok: false });

    expect(await ship(rendered(root, 310), { codes: [CODE], reason: 'User keeps the recorded voice' }))
      .toMatchObject({ ok: true, version: { id: 'v2', override: { codes: [CODE] } } });

    // The same words on that voice again, and the words it was first delivered with.
    expect(await ship(rendered(root, 320))).toMatchObject({ ok: true, version: { id: 'v3' } });
    write(priceScene('现在只要一百九十九元。'));
    expect(await ship(rendered(root, 330))).toMatchObject({ ok: true, version: { id: 'v4' } });
  });

  it('starts from the first delivery that records the words, for a production delivered before', async () => {
    const { root, production, ship, write } = setUp();
    expect(await ship(rendered(root, 300))).toMatchObject({ ok: true });
    // What versions.json held before this record existed.
    const file = path.join(production, 'versions.json');
    fs.writeFileSync(file, JSON.stringify({ versions: JSON.parse(fs.readFileSync(file, 'utf8')).versions }));

    write(priceScene('现在只要一百七十九元。'));
    expect(await ship(rendered(root, 310))).toMatchObject({ ok: true, version: { id: 'v2' } });

    write(priceScene('现在只要一百五十九元。'));
    expect(finding(await ship(rendered(root, 320)))).toMatchObject({ code: CODE });
  });
});

// On 2026-11-07 Luna voiced a 12-second script as one file, found it longer than any of its
// 4-second scenes, dropped the narration and delivered a silent ad the user had asked to be narrated.
describe('shipVideoFile and narration made for a video that plays none', () => {
  const CODE = 'DELIVERY_NARRATION_MISSING';

  function setUp() {
    const root = makeRoot();
    const { production, video } = project(root, timeline([{ id: 'a', duration: 2 }, { id: 'b', duration: 2 }]));
    const voice = async (relative: string, seconds?: number) => {
      const file = path.join(production, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'aac', file]);
      await recordProductionVoice({ workspaceAbs: root, fileAbs: file, ...(seconds ? { seconds } : {}) });
      return file;
    };
    const write = (manifest: unknown, rows: unknown[]) => {
      fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify(manifest));
      fs.writeFileSync(path.join(production, 'assets.json'), JSON.stringify({ assets: rows }));
    };
    const silent = () => {
      const file = path.join(root, `silent-${Date.now()}-${Math.random()}.mp4`);
      picture(file, 4);
      return file;
    };
    const voiced = () => {
      const file = path.join(root, `voiced-${Date.now()}-${Math.random()}.mp4`);
      withTone(file, 4);
      return file;
    };
    const ship = (file: string, override?: { codes: string[]; reason: string }) => shipVideoFile({
      productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file, ...(override ? { override } : {}),
    });
    const record = () => JSON.parse(fs.readFileSync(path.join(production, 'versions.json'), 'utf8'));
    return { root, production, voice, write, silent, voiced, ship, record };
  }

  const finding = (result: unknown) => ((result as { issues?: Array<{ code: string }> }).issues ?? []).find((issue) => issue.code === CODE);
  const allRow = { id: 'voice-all', kind: 'audio', label: 'Voice', path: 'voice/all.m4a', origin: 'generated' };

  it('stops a video that plays no narration when narration was made for it, and names the file', async () => {
    const { voice, silent, ship, record } = setUp();
    await voice('voice/all.m4a', 12.2);

    const result = await ship(silent());

    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect(finding(result)).toEqual({
      code: CODE,
      severity: 'error',
      message: 'This video plays no narration, but narration was made for it: voice/all.m4a (12.2 s). Put it in the video, as scene narration or as a narration track when one file covers several scenes, then render and ship. If the user asked for no narration, ship with accept_findings and say why.',
    });
    expect(record().versions).toEqual([]);
  });

  it('delivers once the file plays as a narration track, and starts the record over', async () => {
    const { voice, write, voiced, silent, ship, record } = setUp();
    await voice('voice/all.m4a', 12.2);
    write(timeline([{ id: 'a', duration: 2 }, { id: 'b', duration: 2 }], { tracks: [{ kind: 'narration', asset: 'voice-all', volume: 1 }] }), [allRow]);

    expect(await ship(voiced())).toMatchObject({ ok: true, version: { id: 'v1' } });
    expect(record().voices_since_delivery).toBeUndefined();

    // Made before the last delivery, so a later video without it is not stopped for it.
    write(timeline([{ id: 'a', duration: 2 }, { id: 'b', duration: 2 }]), [allRow]);
    expect(await ship(silent())).toMatchObject({ ok: true, version: { id: 'v2' } });
  });

  it('gives a usable timeline repair for the single saved narration take', async () => {
    const { voice, write, silent, voiced, ship } = setUp();
    const scenes = [{ id: 'a', duration: 2 }, { id: 'b', duration: 2 }];
    await voice('voice/all.m4a', 3);
    write(timeline(scenes), [allRow]);

    const result = await ship(silent());
    const message = (finding(result) as { message?: string } | undefined)?.message ?? '';
    const example = message.match(/\{[^{}]+\}/)?.[0];
    expect(example).toBeDefined();
    const track = JSON.parse(example!);
    expect(track).toEqual({ kind: 'narration', asset: 'voice-all', volume: 1 });
    expect(message).toContain('video_id "main"');

    write(timeline(scenes, { tracks: [track] }), [allRow]);
    expect(await ship(voiced())).toMatchObject({ ok: true, version: { id: 'v1', video_id: 'main' } });
  });

  it('delivers when a scene speaks one of the lines', async () => {
    const { voice, write, voiced, ship } = setUp();
    await voice('voice/a.m4a', 1);
    await voice('voice/b.m4a', 1);
    write(timeline([{ id: 'a', duration: 2, narration: { text: 'One', asset: 'voice-a' } }, { id: 'b', duration: 2 }]), [
      { id: 'voice-a', kind: 'audio', label: 'A', path: 'voice/a.m4a', origin: 'generated' },
    ]);

    expect(await ship(voiced())).toMatchObject({ ok: true });
  });

  it('counts a voice placed on any track as played', async () => {
    const { voice, write, voiced, ship } = setUp();
    await voice('voice/all.m4a', 12.2);
    write(timeline([{ id: 'a', duration: 2 }, { id: 'b', duration: 2 }], { tracks: [{ kind: 'music', asset: 'voice-all', volume: 1 }] }), [allRow]);

    expect(await ship(voiced())).toMatchObject({ ok: true });
  });

  it('does not count captions without audio as narration', async () => {
    const { voice, write, silent, ship } = setUp();
    await voice('voice/all.m4a', 12.2);
    write(timeline([{ id: 'a', duration: 2, narration: { text: 'Only captions' } }, { id: 'b', duration: 2 }], { captions: { enabled: true } }), [allRow]);

    expect(finding(await ship(silent()))).toMatchObject({ code: CODE });
  });

  it('names three files and counts the rest', async () => {
    const { voice, silent, ship } = setUp();
    for (const [index, name] of ['hook', 'benefit', 'price', 'proof', 'cta'].entries()) await voice(`voice/${name}.m4a`, index + 1);

    expect((finding(await ship(silent())) as { message?: string })?.message).toBe('This video plays no narration, but narration was made for it: voice/hook.m4a (1.0 s), voice/benefit.m4a (2.0 s), voice/price.m4a (3.0 s) and 2 more. Put them in the video, as scene narration or as a narration track when one file covers several scenes, then render and ship. If the user asked for no narration, ship with accept_findings and say why.');
  });

  it('lists a line made again once, under its latest length', async () => {
    const { voice, silent, ship } = setUp();
    await voice('voice/all.m4a', 12.2);
    await voice('voice/cta.m4a', 2);
    await voice('voice/all.m4a', 11.4);

    expect((finding(await ship(silent())) as { message?: string })?.message).toContain('made for it: voice/cta.m4a (2.0 s), voice/all.m4a (11.4 s). Put them');
  });

  it('does not stop for a voice whose file is gone', async () => {
    const { voice, silent, ship } = setUp();
    fs.rmSync(await voice('voice/all.m4a', 12.2));

    expect(await ship(silent())).toMatchObject({ ok: true });
  });

  it('delivers without narration when the user said so, and does not stop the next delivery for it', async () => {
    const { voice, silent, ship, record } = setUp();
    await voice('voice/all.m4a', 12.2);
    expect(finding(await ship(silent()))).toMatchObject({ code: CODE });

    expect(await ship(silent(), { codes: [CODE], reason: 'The user wants music only' }))
      .toMatchObject({ ok: true, version: { override: { codes: [CODE], reason: 'The user wants music only' } } });
    expect(record().voices_since_delivery).toBeUndefined();
    expect(await ship(silent())).toMatchObject({ ok: true });
  });

  it('starts over after a delivery made without a timeline', async () => {
    const { root, production, voice, silent, ship } = setUp();
    await voice('voice/all.m4a', 12.2);
    const handMade = path.join(root, 'hand-made.mp4');
    withTone(handMade, 4);
    expect(await shipVideoFile({ productionDirAbs: production, allowedRoots: [root], videoPathAbs: handMade })).toMatchObject({ ok: true });

    expect(await ship(silent())).toMatchObject({ ok: true });
  });

  it('ignores a listed path that leaves the production, without looking at it', async () => {
    const { root, production, silent, ship } = setUp();
    const outside = path.join(root, 'outside.m4a');
    fs.writeFileSync(outside, 'audio');
    fs.writeFileSync(path.join(production, 'versions.json'), JSON.stringify({ versions: [], voices_since_delivery: [{ path: '../outside.m4a', seconds: 3 }, { path: outside, seconds: 3 }] }));

    expect(await ship(silent())).toMatchObject({ ok: true });
  });

  it('does not count a listed file that links out of the production', async () => {
    const { root, production, silent, ship } = setUp();
    const outside = path.join(root, 'outside.m4a');
    fs.writeFileSync(outside, 'audio');
    fs.mkdirSync(path.join(production, 'voice'));
    fs.symlinkSync(outside, path.join(production, 'voice', 'all.m4a'));
    fs.writeFileSync(path.join(production, 'versions.json'), JSON.stringify({ versions: [], voices_since_delivery: [{ path: 'voice/all.m4a', seconds: 3 }] }));

    expect(await ship(silent())).toMatchObject({ ok: true });
  });
});

describe('recordProductionVoice', () => {
  function production(root: string, marker: 'videos' | 'assets.json', relative = 'lamp-ad') {
    const dir = path.join(root, relative);
    if (marker === 'videos') fs.mkdirSync(path.join(dir, 'videos'), { recursive: true });
    else {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'assets.json'), '{"assets":[]}');
    }
    return dir;
  }
  const listed = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'versions.json'), 'utf8')).voices_since_delivery;

  it('records a line in the production that holds it, at any depth below it', async () => {
    const root = makeRoot();
    const dir = production(root, 'assets.json');
    await recordProductionVoice({ workspaceAbs: root, fileAbs: path.join(dir, 'voice', 'scenes', 'hook.mp3'), seconds: 2.04 });
    expect(listed(dir)).toEqual([{ path: 'voice/scenes/hook.mp3', seconds: 2 }]);
  });

  it('finds a production nested in the workspace, and the workspace when it is one', async () => {
    const root = makeRoot();
    const nested = production(root, 'videos', path.join('ads', 'lamp-ad'));
    await recordProductionVoice({ workspaceAbs: root, fileAbs: path.join(nested, 'voice', 'hook.mp3'), seconds: 2 });
    expect(listed(nested)).toEqual([{ path: 'voice/hook.mp3', seconds: 2 }]);
    expect(fs.existsSync(path.join(root, 'ads', 'versions.json'))).toBe(false);

    const top = makeRoot();
    fs.mkdirSync(path.join(top, 'videos'));
    await recordProductionVoice({ workspaceAbs: top, fileAbs: path.join(top, 'voice', 'hook.mp3') });
    expect(listed(top)).toEqual([{ path: 'voice/hook.mp3' }]);
  });

  it('writes nothing for a line outside any production, or outside the workspace', async () => {
    const root = makeRoot();
    await recordProductionVoice({ workspaceAbs: root, fileAbs: path.join(root, 'voice', 'hook.mp3'), seconds: 2 });
    const elsewhere = makeRoot();
    production(elsewhere, 'assets.json');
    await recordProductionVoice({ workspaceAbs: root, fileAbs: path.join(elsewhere, 'lamp-ad', 'voice', 'hook.mp3'), seconds: 2 });

    expect(fs.readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith('versions.json'))).toEqual([]);
    expect(fs.existsSync(path.join(elsewhere, 'lamp-ad', 'versions.json'))).toBe(false);
  });

  it('keeps the delivered versions and words beside it', async () => {
    const root = makeRoot();
    const dir = production(root, 'assets.json');
    const stored = { versions: [{ id: 'v1', path: 'versions/main-v1.mp4' }], delivered_narration: { ['a'.repeat(64)]: ['Hello'] } };
    fs.writeFileSync(path.join(dir, 'versions.json'), JSON.stringify(stored));
    await recordProductionVoice({ workspaceAbs: root, fileAbs: path.join(dir, 'voice', 'hook.mp3'), seconds: 2 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'versions.json'), 'utf8'))).toEqual({ ...stored, voices_since_delivery: [{ path: 'voice/hook.mp3', seconds: 2 }] });
  });

  it('keeps the latest 32', async () => {
    const root = makeRoot();
    const dir = production(root, 'assets.json');
    for (let index = 0; index < 34; index += 1) {
      await recordProductionVoice({ workspaceAbs: root, fileAbs: path.join(dir, 'voice', `${index}.mp3`), seconds: 1 });
    }
    const voices = listed(dir) as Array<{ path: string }>;
    expect(voices).toHaveLength(32);
    expect([voices[0].path, voices[31].path]).toEqual(['voice/2.mp3', 'voice/33.mp3']);
  });

  it('leaves a list it cannot read as it was', async () => {
    const root = makeRoot();
    const dir = production(root, 'assets.json');
    fs.writeFileSync(path.join(dir, 'versions.json'), '{"versions": [');
    await expect(recordProductionVoice({ workspaceAbs: root, fileAbs: path.join(dir, 'voice', 'hook.mp3'), seconds: 2 })).rejects.toThrow();
    expect(fs.readFileSync(path.join(dir, 'versions.json'), 'utf8')).toBe('{"versions": [');
  });

  it('writes through no link that leaves the production', async () => {
    const root = makeRoot();
    const dir = production(root, 'assets.json');
    const elsewhere = makeRoot();
    const target = path.join(elsewhere, 'versions.json');
    fs.writeFileSync(target, '{"versions":[]}');
    fs.symlinkSync(target, path.join(dir, 'versions.json'));

    await expect(recordProductionVoice({ workspaceAbs: root, fileAbs: path.join(dir, 'voice', 'hook.mp3'), seconds: 2 })).rejects.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('{"versions":[]}');
    expect(fs.lstatSync(path.join(dir, 'versions.json')).isSymbolicLink()).toBe(true);
  });
});

describe('shipVideoFile for a video made with ffmpeg alone', () => {
  it('needs no timeline and records one version', async () => {
    const root = makeRoot();
    const production = path.join(root, 'production');
    fs.mkdirSync(production);
    const file = path.join(production, 'cut.mp4');
    picture(file, 3);
    const result = await shipVideoFile({ productionDirAbs: production, allowedRoots: [root], videoPathAbs: file });
    expect(result).toMatchObject({ ok: true, version: { id: 'v1', path: 'versions/cut-v1.mp4', canvas: '360x640', fps: 30 } });
    const stored = JSON.parse(fs.readFileSync(path.join(production, 'versions.json'), 'utf8'));
    expect(stored.versions).toHaveLength(1);
    expect(stored.versions[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('checks the cuts against the beat only for a video said to be cut to it', async () => {
    const root = makeRoot();
    const file = path.join(root, 'montage.mp4');
    makeBeatMontage(file, 16, driftingCuts(16));
    const checked = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file, cutToBeat: true });
    expect(checked).toMatchObject({ ok: true });
    expect(codes(checked, 'warnings')).toContain('DELIVERY_CUTS_OFF_BEAT');
    const plain = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
    expect(codes(plain, 'warnings')).not.toContain('DELIVERY_CUTS_OFF_BEAT');
  }, 60_000);

  it('tells the Agent when a video said to be cut to the beat shows one picture throughout', async () => {
    const root = makeRoot();
    const file = path.join(root, 'still.mp4');
    makeBeatMontage(file, 16, []);
    const checked = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file, cutToBeat: true });
    expect(checked).toMatchObject({ ok: true });
    expect(codes(checked, 'warnings')).toContain('DELIVERY_NO_CUTS');
    const plain = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
    expect(codes(plain, 'warnings')).not.toContain('DELIVERY_NO_CUTS');
  }, 60_000);

  it('blocks missing required audio and a wrong aspect ratio while reporting a requested length separately', async () => {
    const root = makeRoot();
    const file = path.join(root, 'cut.mp4');
    picture(file, 3);
    const result = await shipVideoFile({
      productionDirAbs: root,
      allowedRoots: [root],
      videoPathAbs: file,
      expect: { durationSec: 10, hasAudio: true, aspect: '16:9' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect(codes(result)).toEqual(['DELIVERY_ASPECT_MISMATCH', 'DELIVERY_NO_AUDIO']);
    expect(codes(result, 'warnings')).toContain('DELIVERY_REQUESTED_DURATION_DRIFT');
    expect(fs.existsSync(path.join(root, 'versions.json'))).toBe(false);
  });

  // On 2026-11-19 "one of them stops early" left a tutorial (picture 30.6 s, sound 22.2 s) asking
  // for its narration to be recorded again rather than filling or cutting the silent end.
  it('refuses a file whose sound stops long before its picture, and says to fill the silent end or cut the picture to the sound', async () => {
    const root = makeRoot();
    const file = path.join(root, 'cut.mp4');
    withTone(file, 4, 2);
    const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
    const issue = (result.issues as Array<{ code: string; message: string }>).find((item) => item.code === 'DELIVERY_AV_DURATION_MISMATCH');
    expect(issue?.message).toBe('The picture runs 4.00s and the sound 2.00s, so the last 2.00s have no sound. Give that stretch sound, such as another narration line or music under the end, or cut the picture to 2.00s, then deliver again.');
  });

  it('refuses a file whose sound runs on past its picture, and says to cut the sound or extend the picture', async () => {
    const root = makeRoot();
    const file = path.join(root, 'cut.mp4');
    withTone(file, 2, 4);
    const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
    const issue = (result.issues as Array<{ code: string; message: string }>).find((item) => item.code === 'DELIVERY_AV_DURATION_MISMATCH');
    expect(issue?.message).toBe('The picture runs 2.00s and the sound 4.00s, so the sound runs 2.00s past the picture. Cut the sound to 2.00s or extend the picture, then deliver again.');
  });

  it('asks to reuse the original narration when a shorter output track cuts the recorded line off', async () => {
    const root = makeRoot();
    const voice = path.join(root, 'voice.wav');
    const footage = path.join(root, 'picture.mp4');
    const broken = path.join(root, 'broken.mp4');
    const repaired = path.join(root, 'repaired.mp4');
    picture(footage, 4);
    ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=d=3.9:c=pink:r=16000:a=0.3:seed=17', voice]);
    fs.writeFileSync(path.join(root, 'assets.json'), JSON.stringify({ assets: [
      { id: 'narration', kind: 'audio', path: 'voice.wav', origin: 'generated', prompt: '确认导出完成后，再打开保存目录。' },
    ] }));
    await recordProductionVoice({ workspaceAbs: root, fileAbs: voice, seconds: 3.9 });

    const assemble = (output: string, soundLength: number) => ffmpeg([
      '-i', footage, '-i', voice, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac',
      '-af', `atrim=duration=${soundLength}`, output,
    ]);
    const ship = (videoPathAbs: string) => shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs });
    assemble(broken, 2.8);
    const refused = await ship(broken);
    expect(refused).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED', message: expect.stringMatching(/rebuild the mix from the original narration/i) });
    expect(codes(refused)).toContain('DELIVERY_AV_DURATION_MISMATCH');
    expect(codes(refused)).toContain('DELIVERY_NARRATION_CUT_OFF');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8')).versions).toEqual([]);

    assemble(repaired, 3.9);
    expect(await ship(repaired)).toMatchObject({ ok: true, version: { id: 'v1', duration_sec: 4 } });
  }, 60_000);

  it('accepts sound and picture that differ by less than the tolerance', async () => {
    const root = makeRoot();
    const file = path.join(root, 'cut.mp4');
    withTone(file, 4, 3.8);
    expect(await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file })).toMatchObject({ ok: true });
  });

  it('refuses something that is not a video', async () => {
    const root = makeRoot();
    const file = path.join(root, 'cut.mp4');
    fs.writeFileSync(file, 'not a video');
    const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
    expect(codes(result)).toContain('DELIVERY_VIDEO_UNREADABLE');
  });

  // 2026-11-20 benchmark: a recap played one narration line twice, the first time cut off, and
  // delivery passed it. Lines made since the last delivery are matched against the file's sound.
  it('stops a delivery that plays a narration line made for it twice, and passes the same line played once', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'voice'), { recursive: true });
    const line = path.join(root, 'voice', 'hook.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=d=3:c=pink:r=16000:a=0.3:seed=7', '-ac', '1', line]);
    fs.writeFileSync(path.join(root, 'assets.json'), JSON.stringify({ assets: [
      { id: 'hook', kind: 'audio', path: 'voice/hook.wav', origin: 'generated', prompt: '合同从三十天变成九十天。' },
    ] }));
    fs.writeFileSync(path.join(root, 'versions.json'), JSON.stringify({ versions: [], voices_since_delivery: [{ path: 'voice/hook.wav', seconds: 3 }] }));
    const cut = (name: string, starts: number[]) => {
      const file = path.join(root, name);
      const placed = starts.map((start, index) => `[${index + 1}:a]adelay=${start * 1000}:all=1[p${index}]`).join(';');
      const mix = `[bed]${starts.map((_s, index) => `[p${index}]`).join('')}amix=inputs=${starts.length + 1}:normalize=0:duration=first[a]`;
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=10', ...starts.flatMap(() => ['-i', line]),
        '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=10',
        '-filter_complex', `${placed};[${starts.length + 1}:a]volume=0.05[bed];${mix}`,
        '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '10', file]);
      return file;
    };
    const twice = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: cut('twice.mp4', [1, 6]) });
    expect(twice).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    const repeated = ((twice as { issues?: Array<{ code: string; message: string }> }).issues ?? []).find((issue) => issue.code === 'DELIVERY_NARRATION_REPEATED');
    expect(repeated?.message).toMatch(/^The narration line "合同从三十天变成九十天。" plays twice, from 1\.0 s and from 6\.0 s\. Keep it once, then deliver again\.$/);
    const once = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: cut('once.mp4', [1]) });
    expect(codes(once)).not.toContain('DELIVERY_NARRATION_REPEATED');
    expect(codes(once)).not.toContain('DELIVERY_NARRATION_CUT_OFF');
  }, 120_000);

  it('refuses a path outside the task\'s files before reading it', async () => {
    const root = makeRoot();
    const elsewhere = makeRoot();
    const file = path.join(elsewhere, 'cut.mp4');
    picture(file, 1);
    const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_OUT_OF_SCOPE' });
    expect(JSON.stringify(result)).not.toContain(elsewhere);
    // 2026-11-20: a recreation copied its absolute path one character wrong twice and gave up on
    // "out of scope"; the refusal now says how to pass the path.
    expect((result as { message: string }).message).toBe('That file is outside the files this task can use. Pass its path relative to the production folder, such as render/main.mp4, and run it again.');
  });
});

describe('shipVideoFile hints and overrides', () => {
  // 2026-11-15–21: three of eleven users who got a video called it pictures and cards ("只是圖片組合"),
  // one delivered with 82% still and only a warning. A video that promotes something now stops
  // when its pictures and words stand still for over half its length; footage that holds is not counted.
  // 2026-11-22: a site promo held its screenshots 59% of the time without writing product.json, and
  // explainers that named their topic there were stopped for diagrams that hold while the voice
  // explains, so only still pictures count, whatever product.json says.
  describe('a video built from held stills', () => {
    function promo(root: string, product = true, scenes = [
      { id: 'hook', clips: [{ id: 'hook-shot', asset: 'shot', in: 0, dur: 2 }] },
      { id: 'site', clips: [{ id: 'site-shot', asset: 'shot', in: 0, dur: 2 }] },
      { id: 'street', clips: [{ id: 'street-walk', asset: 'walk', in: 0, dur: 2 }] },
    ] as Array<Record<string, unknown>>) {
      const made = project(root, timeline(scenes), [
        { id: 'shot', kind: 'image', label: 'Site', path: 'shot.png', origin: 'upload' },
        { id: 'walk', kind: 'video', label: 'Street', path: 'walk.mp4', origin: 'stock', duration: 2 },
      ]);
      ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x336699:s=360x640:d=1', '-frames:v', '1', path.join(made.production, 'shot.png')]);
      picture(path.join(made.production, 'walk.mp4'), 2);
      if (product) fs.writeFileSync(path.join(made.production, 'product.json'), JSON.stringify({ name: 'PetCare', facts: [], images: [] }));
      return made;
    }
    /** Six seconds: still where `still` says, moving elsewhere. */
    function cut(file: string, still: 'start' | 'end', colour = '0x336699'): void {
      const parts = still === 'start'
        ? [`color=c=${colour}:s=360x640:r=30:d=4`, 'testsrc2=s=360x640:r=30:d=2']
        : ['testsrc2=s=360x640:r=30:d=4', 'color=c=0x336699:s=360x640:r=30:d=2'];
      ffmpeg([...parts.flatMap((source) => ['-f', 'lavfi', '-i', source]),
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file]);
    }

    it('stops it and names the scenes that stand still', async () => {
      const root = makeRoot();
      const { production, video } = promo(root);
      const file = path.join(production, 'render.mp4');
      cut(file, 'start');
      const result = await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file });
      expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
      const held = ((result as { issues?: Array<{ code: string; message: string }> }).issues ?? []).find((issue) => issue.code === 'DELIVERY_HELD_STILLS');
      expect(held?.message).toMatch(/^6[0-9]% of this video is a still frame held for a second or more, so it plays as a slideshow\. It stands still in scenes "(hook|site)" \(2\.0 s\), "(hook|site)" \(2\.0 s\)\. Make those scenes move, then render and deliver again: where the shot need not be the user's own, such as a place or people using this kind of thing, cut to suitable available footage; where it is the user's own product or photo, move across it with a slow push in, pan or scroll; on a screen of a site or app, show the step the line names done on it with \.\/assets\/vendor\/screen-demo\.js \(timeline\.md\)\.$/);
      expect(codes(result, 'warnings')).not.toContain('DELIVERY_MOSTLY_STATIC');
    }, 60_000);

    it('stops still pictures held over half the video when nothing is promoted', async () => {
      const root = makeRoot();
      const { production, video } = promo(root, false, [
        { id: 'screens', clips: [{ id: 'screens-shot', asset: 'shot', in: 0, dur: 4 }] },
        { id: 'street', clips: [{ id: 'street-walk', asset: 'walk', in: 0, dur: 2 }] },
      ]);
      const file = path.join(production, 'render.mp4');
      cut(file, 'start');
      const result = await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file });
      expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
      const held = ((result as { issues?: Array<{ code: string; message: string }> }).issues ?? []).find((issue) => issue.code === 'DELIVERY_HELD_STILLS');
      expect(held?.message).toMatch(/^6[0-9]% of this video is a still frame held for a second or more, so it plays as a slideshow\. It stands still in scene "screens" \(4\.0 s\)\. Make those scenes move/);
    }, 60_000);

    it('only warns about a page drawn and held, even with its topic in product.json, and never counts footage that holds still', async () => {
      // An explainer's diagrams are drawn in the page and hold while the voice explains them.
      const plain = makeRoot();
      const unpromoted = promo(plain, true, [
        { id: 'diagram', duration: 4 },
        { id: 'street', clips: [{ id: 'street-walk', asset: 'walk', in: 0, dur: 2 }] },
      ]);
      const slides = path.join(unpromoted.production, 'render.mp4');
      cut(slides, 'start');
      const shipped = await shipVideoFile({ productionDirAbs: unpromoted.production, videoDirAbs: unpromoted.video, allowedRoots: [plain], videoPathAbs: slides });
      expect(shipped).toMatchObject({ ok: true });
      expect(codes(shipped, 'warnings')).toContain('DELIVERY_MOSTLY_STATIC');

      const footage = makeRoot();
      const promoted = promo(footage);
      const stillFootage = path.join(promoted.production, 'render.mp4');
      cut(stillFootage, 'end');
      const result = await shipVideoFile({ productionDirAbs: promoted.production, videoDirAbs: promoted.video, allowedRoots: [footage], videoPathAbs: stillFootage });
      expect(result).toMatchObject({ ok: true });
      expect(codes(result)).not.toContain('DELIVERY_HELD_STILLS');
    }, 60_000);

    it('counts the pictures in a scene that also plays footage, and only the footage\'s own still time is left out', async () => {
      // 2026-11-23: one stock clip and four screenshots in a single scene went out 69% still.
      const mixed = [{ id: 'story', clips: [
        { id: 'story-shot', asset: 'shot', in: 0, dur: 4 },
        { id: 'story-walk', asset: 'walk', in: 0, dur: 2 },
      ] }];
      const stills = makeRoot();
      const held = promo(stills, false, mixed);
      const slideshow = path.join(held.production, 'render.mp4');
      cut(slideshow, 'start');
      const stopped = await shipVideoFile({ productionDirAbs: held.production, videoDirAbs: held.video, allowedRoots: [stills], videoPathAbs: slideshow });
      expect(stopped).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
      const issue = ((stopped as { issues?: Array<{ code: string; message: string }> }).issues ?? []).find((item) => item.code === 'DELIVERY_HELD_STILLS');
      expect(issue?.message).toMatch(/^6[0-9]% of this video is a still frame held for a second or more, so it plays as a slideshow\. It stands still in scene "story" \(4\.0 s\)\./);

      const footage = makeRoot();
      const holding = promo(footage, false, mixed);
      const stillClip = path.join(holding.production, 'render.mp4');
      cut(stillClip, 'end');
      const delivered = await shipVideoFile({ productionDirAbs: holding.production, videoDirAbs: holding.video, allowedRoots: [footage], videoPathAbs: stillClip });
      expect(delivered).toMatchObject({ ok: true });
      expect(codes(delivered)).not.toContain('DELIVERY_HELD_STILLS');

      // Footage holding still for most of the same scene is still not counted.
      const recording = makeRoot();
      const screen = promo(recording, false, [{ id: 'story', clips: [
        { id: 'story-shot', asset: 'shot', in: 0, dur: 2 },
        { id: 'story-walk', asset: 'walk', in: 0, dur: 2 },
        { id: 'story-walk-2', asset: 'walk', in: 0, dur: 2 },
      ] }]);
      const holds = path.join(screen.production, 'render.mp4');
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=0x336699:s=360x640:r=30:d=4',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', holds]);
      const kept = await shipVideoFile({ productionDirAbs: screen.production, videoDirAbs: screen.video, allowedRoots: [recording], videoPathAbs: holds });
      expect(kept).toMatchObject({ ok: true });
      expect(codes(kept)).not.toContain('DELIVERY_HELD_STILLS');
    }, 60_000);

    it('gives a stopped video one round of changes: its next file is delivered with a warning', async () => {
      const root = makeRoot();
      const { production, video } = promo(root);
      const ship = (file: string) => shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file });
      const stopped = () => (JSON.parse(fs.readFileSync(path.join(production, 'versions.json'), 'utf8')) as { held_stills_stopped?: Record<string, string> }).held_stills_stopped;
      const first = path.join(production, 'render.mp4');
      cut(first, 'start');
      expect(await ship(first)).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
      expect(Object.values(stopped() ?? {})).toHaveLength(1);
      // The same file again has not been changed.
      expect(await ship(first)).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });

      const changed = path.join(production, 'render-2.mp4');
      cut(changed, 'start', '0x993366');
      const delivered = await ship(changed);
      expect(delivered).toMatchObject({ ok: true });
      const warning = ((delivered as { warnings?: Array<{ code: string; message: string }> }).warnings ?? []).find((issue) => issue.code === 'DELIVERY_HELD_STILLS');
      expect(warning?.message).toMatch(/^6[0-9]% of this video still stands still after one round of changes, in scenes "(hook|site)" \(2\.0 s\), "(hook|site)" \(2\.0 s\)\. It is delivered as it is: say in your reply which scenes still hold still, so the user can ask for more movement\.$/);
      expect(stopped()).toBeUndefined();

      // A delivery starts the next round: the next held file is stopped again.
      const next = path.join(production, 'render-3.mp4');
      cut(next, 'start', '0x669933');
      expect(await ship(next)).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    }, 120_000);

    it('keeps the delivery finding when recording fails and sends only diagnostic metadata to the logger', async () => {
      const root = makeRoot();
      const { production, video } = promo(root);
      const file = path.join(production, 'render.mp4');
      cut(file, 'start');
      const failure = Object.assign(new Error('EACCES: open /fixture/private-video-project/versions.json'), { code: 'EACCES' });
      const write = vi.spyOn(storage, 'writeBytesAtomic').mockRejectedValueOnce(failure);
      deliveryWarning.mockClear();
      try {
        const result = await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file });
        expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
        expect(codes(result)).toContain('DELIVERY_HELD_STILLS');
        expect(deliveryWarning).toHaveBeenCalledWith('held stills stop not recorded', {
          error: { error_code: 'EACCES', error_type: 'Error', message_hash: expect.any(String), message_chars: failure.message.length },
        });
        expect(JSON.stringify(deliveryWarning.mock.calls)).not.toContain('private-video-project');
      } finally {
        write.mockRestore();
      }
    }, 60_000);

    it.each(['confirm', 'dismiss', 'replace_file', 'newer_version', 'stale_request'] as const)(
      'binds the canvas still-frame decision to the file and version (%s)', async (decision) => {
        const root = makeRoot();
        const { production, video } = promo(root);
        const file = path.join(production, 'render.mp4');
        const ledger = path.join(production, 'versions.json');
        cut(file, 'start');
        const reviewHeldStills = vi.fn(async (finding: { percent: number; scenes: { id: string }[] }) => {
          expect(finding.percent).toBeGreaterThan(50);
          expect(finding.scenes.map(scene => scene.id).sort()).toEqual(['hook', 'site']);
          expect(fs.existsSync(ledger)).toBe(false);
          if (decision === 'replace_file') cut(file, 'start', '0x993366');
          if (decision === 'newer_version') {
            fs.writeFileSync(ledger, JSON.stringify({ versions: [{ id: 'v1', video_id: 'main', path: 'versions/recent.mp4', sha256: 'fixture' }] }));
          }
          return decision === 'dismiss' ? null : () => decision !== 'stale_request';
        });
        const finalize = vi.fn(async () => {});
        const result = await shipVideoFile({
          productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file, reviewHeldStills, finalize,
        });
        expect(reviewHeldStills).toHaveBeenCalledOnce();
        if (decision === 'confirm') {
          expect(result).toMatchObject({ ok: true, version: { id: 'v1', override: { codes: ['DELIVERY_HELD_STILLS'] } } });
          expect(fs.readFileSync(path.join(production, 'versions', 'main-v1.mp4'))).toEqual(fs.readFileSync(file));
          expect(finalize).toHaveBeenCalledOnce();
        } else {
          expect(result.ok).toBe(false);
          expect(fs.existsSync(path.join(production, 'versions'))).toBe(false);
          expect(finalize).not.toHaveBeenCalled();
          if (decision === 'newer_version') expect(JSON.parse(fs.readFileSync(ledger, 'utf8')).versions).toHaveLength(1);
          else expect(fs.existsSync(ledger)).toBe(false);
        }
      }, 60_000);

    it('does not offer a still-frame review for a file replaced during the delivery checks', async () => {
      const root = makeRoot();
      const { production, video } = promo(root);
      const file = path.join(production, 'render.mp4');
      const replacement = path.join(production, 'replacement.mp4');
      cut(file, 'start');
      picture(replacement, 1);
      const hash = fileHash.sha256OfFileStream;
      const hashReads = vi.spyOn(fileHash, 'sha256OfFileStream').mockImplementation(async (candidate) => {
        if (candidate === file && fs.existsSync(replacement)) fs.renameSync(replacement, file);
        return hash(candidate);
      });
      const reviewHeldStills = vi.fn(async () => () => true);
      try {
        const result = await shipVideoFile({
          productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file, reviewHeldStills,
        });
        expect(fs.existsSync(replacement)).toBe(false);
        expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_REVIEW_EXPIRED' });
        expect(reviewHeldStills).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(production, 'versions.json'))).toBe(false);
      } finally {
        hashReads.mockRestore();
      }
    }, 60_000);

    it('offers a still-frame review only when the render meets the other delivery checks', async () => {
      const root = makeRoot();
      const { production, video } = promo(root, true, [
        { id: 'hook', clips: [{ id: 'hook-shot', asset: 'shot', in: 0, dur: 2 }] },
        { id: 'site', clips: [{ id: 'site-shot', asset: 'shot', in: 0, dur: 2 }] },
      ]);
      const file = path.join(production, 'render.mp4');
      cut(file, 'start');
      const reviewHeldStills = vi.fn(async () => () => true);
      const result = await shipVideoFile({
        productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file, reviewHeldStills,
      });
      expect(result.ok).toBe(false);
      expect(codes(result)).toEqual(expect.arrayContaining(['DELIVERY_HELD_STILLS', 'DELIVERY_DURATION_DRIFT']));
      expect(reviewHeldStills).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(production, 'versions'))).toBe(false);
    }, 60_000);

    it('delivers when the user chose stills that hold', async () => {
      const root = makeRoot();
      const { production, video } = promo(root);
      const file = path.join(production, 'render.mp4');
      cut(file, 'start');
      const result = await shipVideoFile({
        productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file,
        override: { codes: ['DELIVERY_HELD_STILLS'], reason: '就要图文轮播，不用动' },
      });
      expect(result).toMatchObject({ ok: true });
    }, 60_000);
  });

  it('warns about a mostly static video without blocking it', async () => {
    const root = makeRoot();
    const file = path.join(root, 'slides.mp4');
    picture(file, 4, '360x640', 'color');
    const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
    expect(result).toMatchObject({ ok: true });
    expect(codes(result, 'warnings')).toContain('DELIVERY_MOSTLY_STATIC');
  });

  it('warns on loudness rather than blocking, and says how far off it is', async () => {
    const root = makeRoot();
    const file = path.join(root, 'quiet.mp4');
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-af', 'volume=-20dB', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
    ]);
    const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
    expect(result).toMatchObject({ ok: true });
    expect(codes(result, 'warnings')).toContain('DELIVERY_LOUDNESS_OFF_TARGET');
  });

  it('delivers past a named finding when the user accepted it, and records why', async () => {
    const root = makeRoot();
    const file = path.join(root, 'cut.mp4');
    withTone(file, 4, 2);
    const result = await shipVideoFile({
      productionDirAbs: root,
      allowedRoots: [root],
      videoPathAbs: file,
      override: { codes: ['DELIVERY_AV_DURATION_MISMATCH'], reason: 'User wants the ending silent' },
    });
    expect(result).toMatchObject({
      ok: true,
      version: { override: { codes: ['DELIVERY_AV_DURATION_MISMATCH'], reason: 'User wants the ending silent' } },
    });
  });

  it('does not let accepting one finding excuse another', async () => {
    const root = makeRoot();
    const file = path.join(root, 'cut.mp4');
    withTone(file, 4, 2);
    const result = await shipVideoFile({
      productionDirAbs: root,
      allowedRoots: [root],
      videoPathAbs: file,
      expect: { durationSec: 10, aspect: '16:9' },
      override: { codes: ['DELIVERY_AV_DURATION_MISMATCH'], reason: 'x' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect(codes(result)).toEqual(['DELIVERY_ASPECT_MISMATCH']);
    expect(codes(result, 'warnings')).toContain('DELIVERY_REQUESTED_DURATION_DRIFT');
  });

  it('gives the same file the same version when shipped again, and a new file the next one', async () => {
    const root = makeRoot();
    const file = path.join(root, 'cut.mp4');
    picture(file, 2);
    const first = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
    const again = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
    expect((again as { version: { id: string } }).version.id).toBe((first as { version: { id: string } }).version.id);
    const other = path.join(root, 'cut2.mp4');
    picture(other, 3);
    const next = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: other });
    expect((next as { version: { id: string } }).version.id).toBe('v2');
  });
});

describe('every delivered version keeps its own file', () => {
  const version = (result: unknown) => (result as { version: { id: string; path: string; sha256: string; source_sha256?: string } }).version;

  it.each(['missing', 'changed', 'escaped'])(
    'does not report a successful repeat delivery when its kept file is %s', async (state) => {
      const root = makeRoot();
      const file = path.join(root, 'cut.mp4');
      picture(file, 1);
      const source = fs.readFileSync(file);
      const first = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
      expect(first).toMatchObject({ ok: true });
      const kept = path.join(root, version(first).path);
      const ledger = fs.readFileSync(path.join(root, 'versions.json'));
      if (state === 'changed') {
        picture(kept, 2);
      } else {
        fs.unlinkSync(kept);
        if (state === 'escaped') {
          const outside = makeRoot();
          const foreign = path.join(outside, 'foreign.mp4');
          fs.writeFileSync(foreign, source);
          fs.symlinkSync(foreign, kept, 'file');
        }
      }
      const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
      expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_RECORD' });
      expect(fs.readFileSync(file).equals(source)).toBe(true);
      expect(fs.readFileSync(path.join(root, 'versions.json')).equals(ledger)).toBe(true);
      fs.rmSync(kept, { force: true });
      fs.writeFileSync(kept, source);
      const recovered = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
      expect(recovered).toMatchObject({ ok: true, version: { id: version(first).id, sha256: version(first).sha256 } });
      expect(fs.readFileSync(path.join(root, 'versions.json')).equals(ledger)).toBe(true);
    });

  it('so the next render, which replaces the file, leaves the last delivery playable', async () => {
    const root = makeRoot();
    const render = path.join(root, 'render', 'main.mp4');
    fs.mkdirSync(path.dirname(render), { recursive: true });
    picture(render, 2);
    const first = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: render });
    const firstBytes = fs.readFileSync(path.join(root, version(first).path));
    expect(version(first).path).toBe('versions/main-v1.mp4');
    expect((first as { media: string }).media).toContain('versions/main-v1.mp4');

    picture(render, 3);
    const second = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: render });
    expect(version(second)).toMatchObject({ id: 'v2', path: 'versions/main-v2.mp4' });
    expect(fs.readFileSync(path.join(root, version(first).path)).equals(firstBytes)).toBe(true);
    const recorded = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8')).versions;
    for (const entry of recorded) {
      const onDisk = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, entry.path))).digest('hex');
      expect(onDisk).toBe(entry.sha256);
    }
  });

  it('and the account\'s output policy touches only that copy', async () => {
    const root = makeRoot();
    const old = path.join(root, 'project', 'render', 'final.mp4');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    picture(old, 2);
    const before = fs.readFileSync(old);
    const finalized: string[] = [];
    const finalize = async (fileAbs: string) => {
      finalized.push(fileAbs);
      fs.appendFileSync(fileAbs, 'marked');
    };
    const first = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: old, finalize });
    expect(fs.readFileSync(old).equals(before)).toBe(true);
    expect(finalized).toEqual([path.join(root, version(first).path)]);
    const kept = fs.readFileSync(path.join(root, version(first).path));
    expect(kept.subarray(-6).toString()).toBe('marked');
    expect(version(first).sha256).toBe(crypto.createHash('sha256').update(kept).digest('hex'));
    expect(version(first).source_sha256).toBe(crypto.createHash('sha256').update(before).digest('hex'));

    // The same file again is the same delivery, even though the copy came out different.
    const again = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: old, finalize });
    expect(version(again).id).toBe('v1');
    expect(finalized).toHaveLength(1);
  });

  it('and a list it cannot read is left for repair, not replaced', async () => {
    const root = makeRoot();
    const file = path.join(root, 'cut.mp4');
    picture(file, 2);
    for (const damaged of ['{"versions": [{"id": "v1"}', '{"versions": "1.2.3"}', '[]']) {
      fs.writeFileSync(path.join(root, 'versions.json'), damaged);
      const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
      expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_RECORD' });
      expect(fs.readFileSync(path.join(root, 'versions.json'), 'utf8')).toBe(damaged);
    }
  });
});

describe('parseVisualHints', () => {
  it('adds up frozen spans, including one still open at the end', () => {
    const stderr = [
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 1',
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 2',
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 3',
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 8',
    ].join('\n');
    expect(parseVisualHints(stderr, 10).staticShare).toBeCloseTo(0.4, 5);
    expect(parseVisualHints(stderr, 10).frozen).toEqual([{ startSec: 1, endSec: 3 }, { startSec: 8, endSec: 10 }]);
  });

  it('counts one shot per detected cut plus the opening', () => {
    const stderr = [
      '[Parsed_showinfo_3 @ 0x1] n:   0 pts:  100',
      '[Parsed_showinfo_3 @ 0x1] n:   1 pts:  200',
    ].join('\n');
    expect(parseVisualHints(stderr, 10).shots).toBe(3);
  });

  it('reports nothing for clean output', () => {
    expect(parseVisualHints('', 10)).toEqual({ staticShare: 0, shots: 1, frozen: [] });
  });
});

describe('shipVideoFile and a file that is not there', () => {
  it('says the file is missing rather than unreadable, so a wrong path is not taken for a broken check', async () => {
    const root = makeRoot();
    const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: path.join(root, 'render', 'main.mp4') });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_NO_FILE' });
    expect(String((result as { message?: string }).message)).toContain(path.join('render', 'main.mp4'));
  });

  it('still calls a file that is there but broken unreadable', async () => {
    const root = makeRoot();
    const broken = path.join(root, 'broken.mp4');
    fs.writeFileSync(broken, 'not a video');
    expect(await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: broken }))
      .toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED', issues: [{ code: 'DELIVERY_VIDEO_UNREADABLE' }] });
  });
});

describe('writeDeliveredFrameSheet', () => {
  const dominantChannel = async (sheet: string, left: number, top: number, width: number, height: number) => {
    // stats() reads the input, not the pipeline, so the crop has to be decoded first.
    const crop = await sharp(sheet).extract({ left, top, width, height }).png().toBuffer();
    const { channels } = await sharp(crop).stats();
    return channels[0].mean > channels[2].mean ? 'red' : 'blue';
  };

  it('shows a portrait file at a readable size, from its first frame to its last', async () => {
    const root = makeRoot();
    const file = path.join(root, 'two-colours.mp4');
    ffmpeg([
      '-f', 'lavfi', '-i', 'color=red:s=1080x1920:r=30:d=1',
      '-f', 'lavfi', '-i', 'color=blue:s=1080x1920:r=30:d=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file,
    ]);
    const output = path.join(root, 'sheet');
    fs.mkdirSync(output);
    const sheet = await writeDeliveredFrameSheet({ videoPathAbs: file, outputDirAbs: output, durationSec: 2, width: 1080, height: 1920 });
    expect(sheet).toBeTruthy();
    const { width = 0, height = 0 } = await sharp(sheet as string).metadata();
    // Six cells across and two down, each a 270x480 frame plus its label and gaps. The
    // rasterizer may add a density factor, so positions scale with the real width.
    const declaredWidth = 6 * 270 + 7 * 16;
    const declaredHeight = 2 * (480 + 36) + 3 * 16;
    const scale = width / declaredWidth;
    expect(scale).toBeGreaterThanOrEqual(1);
    expect(height).toBeCloseTo(declaredHeight * scale, -1);
    const at = (value: number) => Math.round(value * scale);
    expect(await dominantChannel(sheet as string, at(16 + 100), at(16 + 200), at(40), at(40))).toBe('red');
    const lastCellLeft = 16 + 5 * (270 + 16);
    const lastCellTop = 16 + 480 + 36 + 16;
    expect(await dominantChannel(sheet as string, at(lastCellLeft + 100), at(lastCellTop + 200), at(40), at(40))).toBe('blue');
  }, 60_000);

  // 2026-11-17 benchmark: a tutorial ended on the export spinner while its last line said the
  // file was saved, and another dropped the click its narration named. The twelve evenly
  // spaced frames showed the spinner, but nothing tied it to the line that claimed otherwise.
  it('takes each frame where a heard line ends, so its words sit over what it claims', async () => {
    const root = makeRoot();
    const file = path.join(root, 'two-colours.mp4');
    ffmpeg([
      '-f', 'lavfi', '-i', 'color=red:s=1080x1920:r=30:d=1',
      '-f', 'lavfi', '-i', 'color=blue:s=1080x1920:r=30:d=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file,
    ]);
    const output = path.join(root, 'sheet');
    fs.mkdirSync(output);
    const heard = [{ startSec: 0.1, endSec: 0.9, text: 'Open settings.' }, { startSec: 1.2, endSec: 1.95, text: 'It is saved.' }];
    const sheet = await writeDeliveredFrameSheet({ videoPathAbs: file, outputDirAbs: output, durationSec: 2, width: 1080, height: 1920, heard });
    const { width = 0 } = await sharp(sheet as string).metadata();
    const scale = width / (2 * 270 + 3 * 16);
    const at = (value: number) => Math.round(value * scale);
    expect(await dominantChannel(sheet as string, at(16 + 100), at(16 + 200), at(40), at(40))).toBe('red');
    expect(await dominantChannel(sheet as string, at(16 + 270 + 16 + 100), at(16 + 200), at(40), at(40))).toBe('blue');
  }, 60_000);

  it('gives up without throwing on a file it cannot read or a video with no length', async () => {
    const root = makeRoot();
    const broken = path.join(root, 'broken.mp4');
    fs.writeFileSync(broken, 'not a video');
    const input = { videoPathAbs: broken, outputDirAbs: root, durationSec: 2, width: 360, height: 640 };
    expect(await writeDeliveredFrameSheet(input)).toBeNull();
    expect(await writeDeliveredFrameSheet({ ...input, durationSec: 0 })).toBeNull();
  }, 60_000);
});


// Whether a delivery carries a voice decides if its frames are matched to what is said. A
// music cut transcribed anyway reads as words (2026-11-18: "(字幕:J Chong)" over a café
// montage, "多谢 小伙伴们" over a guesthouse one), so only a voiced video is listened to.
describe('shipVideoFile records whether the video carries a voice', () => {
  it('marks a delivery voiced once narration was made for it, and keeps the mark for the next', async () => {
    const root = makeRoot();
    const production = path.join(root, 'ad');
    fs.mkdirSync(path.join(production, 'render'), { recursive: true });
    fs.writeFileSync(path.join(production, 'assets.json'), JSON.stringify({ assets: [] }));
    // Different lengths: the same bytes again would be the same delivery.
    const ship = async (name: string, seconds: number) => {
      const file = path.join(production, 'render', name);
      withTone(file, seconds);
      const result = await shipVideoFile({ productionDirAbs: production, allowedRoots: [root], videoPathAbs: file });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return (result as unknown as { version: Record<string, unknown> }).version;
    };

    expect((await ship('music.mp4', 2)).voiced).toBeUndefined();
    const voice = path.join(production, 'voice', 'line.m4a');
    fs.mkdirSync(path.dirname(voice), { recursive: true });
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'aac', voice]);
    await recordProductionVoice({ workspaceAbs: root, fileAbs: voice, seconds: 1 });
    expect((await ship('narrated.mp4', 2.5)).voiced).toBe(true);
    // The made voice was delivered; a revision of the same video is still a voiced one.
    expect((await ship('narrated-v2.mp4', 3)).voiced).toBe(true);
  }, 60_000);
});

describe('deliveredFrameSamples', () => {
  const line = (startSec: number, endSec: number, text = 'x') => ({ startSec, endSec, text });

  it('spreads twelve frames from first to last when no voice was heard', () => {
    const samples = deliveredFrameSamples(10.1);
    expect(samples).toHaveLength(12);
    expect(samples[0]).toMatchObject({ atSec: 0, label: '0.0s' });
    expect(samples.at(-1)!.atSec).toBeCloseTo(10, 6);
    expect(samples.every((sample) => sample.heard === undefined)).toBe(true);
  });

  it('takes a frame just before each heard line ends, numbered, then the last frame', () => {
    expect(deliveredFrameSamples(23.2, [line(0, 4.86, 'a'), line(16.64, 21.3, 'saved')])).toEqual([
      { atSec: 4.76, label: '#1 4.8s', heard: 'a' },
      { atSec: 21.2, label: '#2 21.2s', heard: 'saved' },
      { atSec: 23.1, label: '#3 23.1s (last frame)' },
    ]);
  });

  it('does not repeat the last frame when the last line ends there', () => {
    const samples = deliveredFrameSamples(23.2, [line(16.64, 23.3, 'saved')]);
    expect(samples).toEqual([{ atSec: 23.1, label: '#1 23.1s', heard: 'saved' }]);
  });

  it('shows thirteen clauses of a tutorial whole, and keeps the first and last of many more', () => {
    const clauses = Array.from({ length: 13 }, (_item, index) => line(index * 2, index * 2 + 1.5, `clause ${index}`));
    expect(deliveredFrameSamples(30.7, clauses).filter((sample) => sample.heard).map((sample) => sample.heard))
      .toEqual(clauses.map((clause) => clause.text));
    const many = Array.from({ length: 30 }, (_item, index) => line(index, index + 0.8, `line ${index}`));
    const samples = deliveredFrameSamples(31, many);
    expect(samples).toHaveLength(17);
    expect(samples[0].heard).toBe('line 0');
    expect(samples[15].heard).toBe('line 29');
    expect(samples[16].heard).toBeUndefined();
  });
});

describe('delivery output filesystem boundary', () => {
  it.each(['video directory', 'run directory', 'frame file'])(
    'refuses an escaping preview %s before copying or recording', async (destination) => {
      const root = makeRoot();
      const { production, video } = project(root, timeline([{ id: 'a', duration: 1 }]));
      const foreign = path.join(root, 'foreign');
      fs.mkdirSync(foreign);
      const sentinel = path.join(foreign, 'sentinel.png');
      fs.writeFileSync(sentinel, 'keep outside bytes');
      const stamp = 1_800_000_000_000;
      const directory = path.join(production, 'preview', 'main');
      const run = path.join(directory, String(stamp));
      const link = destination === 'video directory' ? directory
        : destination === 'run directory' ? run : path.join(run, '01-a-end.png');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(destination === 'frame file' ? sentinel : foreign, link,
        destination === 'frame file' ? 'file' : 'junction');
      const file = path.join(production, 'out.mp4');
      picture(file, 1);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(stamp);
      try {
        const result = await shipVideoFile({ productionDirAbs: production, videoDirAbs: video,
          allowedRoots: [production], videoPathAbs: file });
        expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_OUT_OF_SCOPE' });
        expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep outside bytes');
        expect(fs.readdirSync(foreign)).toEqual(['sentinel.png']);
        expect(fs.existsSync(path.join(production, 'versions.json'))).toBe(false);
        expect(fs.existsSync(path.join(production, 'versions'))).toBe(false);
      } finally { clock.mockRestore(); }
    });

  it.each(['versions', 'versions.json', 'preview'])(
    'refuses an escaping %s destination before copying or recording', async (name) => {
      const root = makeRoot();
      const { production, video } = project(root, timeline([{ id: 'a', duration: 1 }]));
      const foreign = path.join(root, 'foreign');
      fs.mkdirSync(foreign);
      const ledger = path.join(foreign, 'versions.json');
      fs.writeFileSync(ledger, '{"versions":[]}');
      const target = name.endsWith('.json') ? ledger : foreign;
      fs.symlinkSync(target, path.join(production, name), name.endsWith('.json') ? 'file' : 'junction');
      const file = path.join(production, 'out.mp4');
      picture(file, 1);
      const result = await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [production], videoPathAbs: file });
      expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_OUT_OF_SCOPE' });
      expect(fs.readdirSync(foreign)).toEqual(['versions.json']);
      expect(fs.readFileSync(ledger, 'utf8')).toBe('{"versions":[]}');
    });
});
