import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import sharp from 'sharp';

import { parseVisualHints, recordProductionVoice, shipVideoFile, writeDeliveredFrameSheet } from '../../../src/main/features/video_timeline_ship';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';
import { driftingCuts, makeBeatMontage } from '../../fixtures/beat-montage';

// The gate judges the file, so these cases build files the way a model might, by
// hand with ffmpeg, and never through the renderer. That is the 2026-08-10 lesson:
// a check attached to one tool disappears when the model uses another.

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
    const result = await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: off });
    expect(codes(result)).toContain('DELIVERY_DURATION_DRIFT');
    expect(JSON.stringify(result)).not.toMatch(/approved plan/);
    expect(JSON.stringify(result)).toContain('Narration and captions are timed against');
    // A file cut without a timeline is held to the length the Agent passed, and told how to
    // correct that number rather than to stretch the file.
    const cut = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: off, expect: { durationSec: 4 } });
    expect(codes(cut)).toContain('DELIVERY_DURATION_DRIFT');
    expect(JSON.stringify(cut)).toContain('deliver it again with its real length as expect_duration_sec');
    expect(JSON.stringify(cut)).not.toContain('Narration and captions');
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

  it('holds the file to what the caller says it should be', async () => {
    const root = makeRoot();
    const file = path.join(root, 'cut.mp4');
    picture(file, 3);
    const result = await shipVideoFile({
      productionDirAbs: root,
      allowedRoots: [root],
      videoPathAbs: file,
      expect: { durationSec: 10, hasAudio: true, aspect: '16:9' },
    });
    expect(codes(result)).toEqual(expect.arrayContaining(['DELIVERY_DURATION_DRIFT', 'DELIVERY_NO_AUDIO', 'DELIVERY_ASPECT_MISMATCH']));
  });

  it('refuses a file whose sound stops long before its picture', async () => {
    const root = makeRoot();
    const file = path.join(root, 'cut.mp4');
    withTone(file, 4, 2);
    expect(codes(await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file }))).toContain('DELIVERY_AV_DURATION_MISMATCH');
  });

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

  it('refuses a path outside the task\'s files before reading it', async () => {
    const root = makeRoot();
    const elsewhere = makeRoot();
    const file = path.join(elsewhere, 'cut.mp4');
    picture(file, 1);
    const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_OUT_OF_SCOPE' });
    expect(JSON.stringify(result)).not.toContain(elsewhere);
  });
});

describe('shipVideoFile hints and overrides', () => {
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
      expect: { durationSec: 10 },
      override: { codes: ['DELIVERY_AV_DURATION_MISMATCH'], reason: 'x' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect(codes(result)).toEqual(['DELIVERY_DURATION_DRIFT']);
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
  });

  it('counts one shot per detected cut plus the opening', () => {
    const stderr = [
      '[Parsed_showinfo_3 @ 0x1] n:   0 pts:  100',
      '[Parsed_showinfo_3 @ 0x1] n:   1 pts:  200',
    ].join('\n');
    expect(parseVisualHints(stderr, 10).shots).toBe(3);
  });

  it('reports nothing for clean output', () => {
    expect(parseVisualHints('', 10)).toEqual({ staticShare: 0, shots: 1 });
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

  it('gives up without throwing on a file it cannot read or a video with no length', async () => {
    const root = makeRoot();
    const broken = path.join(root, 'broken.mp4');
    fs.writeFileSync(broken, 'not a video');
    const input = { videoPathAbs: broken, outputDirAbs: root, durationSec: 2, width: 360, height: 640 };
    expect(await writeDeliveredFrameSheet(input)).toBeNull();
    expect(await writeDeliveredFrameSheet({ ...input, durationSec: 0 })).toBeNull();
  }, 60_000);
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
