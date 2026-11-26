import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The canvas shows what a production holds and lets the user change it without a model:
// words, order, scenes, pictures, facts and assets (plan section 10.2). These cases read
// back the files the renderer and the Agent both depend on, because those are the outcome.

vi.mock('electron', () => ({}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
const workspaces = vi.hoisted(() => new Map<string, string>());
vi.mock('../../../src/main/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/paths')>();
  return { ...actual, userLocalRoot: () => path.join(process.env.CANVAS_TEST_ROOT as string, 'local') };
});
vi.mock('../../../src/main/features/group_chat/conv_workspace', () => ({
  getConversationWorkspacePath: async (_uid: string, cid: string) => {
    const dir = workspaces.get(cid);
    if (!dir) throw new Error('no workspace');
    return dir;
  },
}));
// The voices the speech services on this machine offer; a case can make the list fail.
const speech = vi.hoisted(() => ({ routes: [] as unknown[], fail: false }));
vi.mock('../../../src/main/features/tts_capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/tts_capabilities')>();
  return {
    ...actual,
    listTtsCapabilities: async () => {
      if (speech.fail) throw new Error('voice catalog unavailable');
      return speech.routes;
    },
  };
});

import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';
import {
  applyVideoCanvasDraftChange,
  applyVideoCanvasEdit,
  importVideoCanvasFiles,
  readVideoCanvasProductions,
  readVideoCanvasVoices,
  saveVideoCanvasLayout,
  videoUpToDate,
  type VideoCanvasDraftChange,
  type VideoCanvasEdit,
} from '../../../src/main/features/video_canvas';

const UID = 'u-canvas';
const CID = 'c-canvas';
let root: string;
let workspace: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-canvas-')));
  process.env.CANVAS_TEST_ROOT = root;
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  workspaces.clear();
  workspaces.set(CID, workspace);
});

afterEach(() => {
  delete process.env.CANVAS_TEST_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string | Buffer = 'bytes'): string {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function readJson(relative: string): any {
  return JSON.parse(fs.readFileSync(path.join(workspace, relative), 'utf8'));
}

function writeLedger(assets: Array<Record<string, unknown>>, production = 'ad'): void {
  for (const asset of assets) write(path.join(production, String(asset.path)));
  write(path.join(production, 'assets.json'), JSON.stringify({ assets }));
}

function writeVideo(id: string, manifest: Record<string, unknown> = {}, production = 'ad'): void {
  write(path.join(production, 'videos', id, 'manifest.json'), JSON.stringify({
    schema_version: 3,
    id,
    label: `Video ${id}`,
    canvas: { width: 1080, height: 1920, fps: 30 },
    scenes: [
      { id: 'hook', duration: 3, text: { title: { value: 'Bright lamp' } } },
      { id: 'body', duration: 4 },
      { id: 'price', duration: 2, text: { amount: { fact_id: 'price' } } },
    ],
    ...manifest,
  }));
}

function writeProduct(facts: Array<Record<string, unknown>> = [{ id: 'price', text: '$29', source: 'page' }]): void {
  write('ad/product.json', JSON.stringify({ name: 'Desk lamp', facts, images: [] }));
}

function version(id: string, videoId: string | undefined, file: string) {
  return {
    id,
    ...(videoId ? { video_id: videoId } : {}),
    path: file,
    sha256: 'x',
    duration_sec: 9,
    canvas: '1080x1920',
    fps: 30,
    integrated_lufs: null,
    shipped_at: '2026-11-05T00:00:00Z',
    warnings: [],
  };
}

const manifestOf = (id = 'main') => readJson(`ad/videos/${id}/manifest.json`);
const edit = (change: VideoCanvasEdit, busy = false) => applyVideoCanvasEdit({ uid: UID, cid: CID, dir: 'ad', busy, edit: change });
const read = () => readVideoCanvasProductions(UID, CID);

/** A real clip, because lengths come from probing the file. */
function writeClip(relative: string, seconds: number): void {
  const { ffmpeg } = bundledFfmpegPaths();
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(ffmpeg as string, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=64x64:rate=10:duration=${seconds}`,
    '-pix_fmt', 'yuv420p', file,
  ]);
}

function writeSound(relative: string, seconds: number): void {
  const { ffmpeg } = bundledFfmpegPaths();
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(ffmpeg as string, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, file,
  ]);
}

describe('what the canvas shows', () => {
  it('does not read or edit videos through a parent directory escaping the workspace', async () => {
    writeVideo('main');
    const outside = path.join(root, 'outside-videos');
    fs.renameSync(path.join(workspace, 'ad/videos'), outside);
    fs.symlinkSync(outside, path.join(workspace, 'ad/videos'), 'junction');
    const file = path.join(outside, 'main/manifest.json');
    const before = fs.readFileSync(file);
    expect((await read()).flatMap(p => p.videos)).toEqual([]);
    expect((await edit({ kind: 'set_text', video: 'main', scene: 'hook', slot: 'title', value: 'Changed' })).ok).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('does not disclose a manifest reached through a file symlink outside the workspace', async () => {
    writeVideo('main');
    const file = path.join(workspace, 'ad/videos/main/manifest.json');
    const outside = path.join(root, 'foreign-manifest.json');
    fs.renameSync(file, outside);
    fs.symlinkSync(outside, file);
    expect((await read()).flatMap(p => p.videos)).toEqual([]);
  });

  it('does not copy dropped files through a media directory escaping the workspace', async () => {
    writeVideo('main');
    const outside = path.join(root, 'outside-media');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, 'ad/media'), 'junction');
    const source = path.join(root, 'voice.mp3');
    fs.writeFileSync(source, 'local attachment');
    await importVideoCanvasFiles({ uid: UID, cid: CID, dir: 'ad', busy: false, entries: [{ path: source, name: 'voice.mp3' }] });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('has nothing to show for a workspace with no production', async () => {
    write('notes/readme.txt');
    expect(await read()).toEqual([]);
  });

  // 2026-11-16: free stock files name their source and author on the canvas, as the providers'
  // API terms ask; the page link is offered only on the provider's own site.
  it('credits a stock reference with its source and author, linking only to the provider page', async () => {
    writeLedger([
      { id: 'pour', kind: 'video', label: 'woman pouring coffee', path: 'media/stock/pixabay-video-1.mp4', origin: 'stock',
        source: { provider: 'pixabay', id: 'pixabay-video-1', page_url: 'https://pixabay.com/videos/coffee-1/', author: 'Ana Lee',
          author_url: 'https://pixabay.com/users/ana-lee-17/', license: 'Pixabay Content License' } },
      { id: 'older', kind: 'video', label: 'steam over a cup', path: 'media/stock/pexels-video-4.mp4', origin: 'stock',
        source: { provider: 'pexels', id: 'pexels-video-4', page_url: 'https://www.pexels.com/video/steam-4/', author: 'Lee Ana',
          license: 'Pexels License' } },
      { id: 'rain', kind: 'image', label: 'rain', path: 'media/stock/pixabay-image-2.jpg', origin: 'stock',
        source: { provider: 'pixabay', id: 'pixabay-image-2', page_url: 'https://evil.example.com/pixabay.com', license: 'Pixabay Content License' } },
      { id: 'tea', kind: 'image', label: 'tea', path: 'media/stock/pixabay-image-3.jpg', origin: 'stock',
        source: { provider: 'pixabay', id: 'pixabay-image-3', page_url: 'http://pixabay.com/photos/tea-3/', author: 'Mo', license: 'Pixabay Content License' } },
      { id: 'photo', kind: 'image', label: 'Photo', path: 'media/photo.png', origin: 'upload' },
      { id: 'storm', kind: 'video', label: 'storm', path: 'media/stock/wikimedia-video-5.webm', origin: 'stock',
        source: { provider: 'wikimedia', id: 'wikimedia-video-5', page_url: 'https://commons.wikimedia.org/wiki/File:Storm.webm', author: 'Jane Doe',
          license: 'CC BY 4.0', credit: '"Storm" by Jane Doe, CC BY 4.0, https://commons.wikimedia.org/wiki/File:Storm.webm' } },
      { id: 'moon', kind: 'image', label: 'moon', path: 'media/stock/wikimedia-image-6.jpg', origin: 'stock',
        source: { provider: 'wikimedia', id: 'wikimedia-image-6', author: 'NASA', license: 'Public domain' } },
    ]);

    const [production] = await read();
    const credit = (id: string) => production.assets.find((card) => card.id === id)?.credit;
    // A licence that asks for credit is named; one that does not is left out.
    expect(credit('storm')).toEqual({ source: 'Wikimedia Commons', author: 'Jane Doe', license: 'CC BY 4.0', url: 'https://commons.wikimedia.org/wiki/File:Storm.webm' });
    expect(credit('moon')).toEqual({ source: 'Wikimedia Commons', author: 'NASA' });

    expect(credit('pour')).toEqual({ source: 'Pixabay', author: 'Ana Lee', url: 'https://pixabay.com/videos/coffee-1/' });
    // Imported before Pexels was removed: still credited, and linked on its own site.
    expect(credit('older')).toEqual({ source: 'Pexels', author: 'Lee Ana', url: 'https://www.pexels.com/video/steam-4/' });
    // A page the ledger names off the provider's site, or over plain http, is not offered as a link.
    expect(credit('rain')).toEqual({ source: 'Pixabay' });
    expect(credit('tea')).toEqual({ source: 'Pixabay', author: 'Mo' });
    expect(credit('photo')).toBeUndefined();
  });

  it('sorts footage, generated shots and videos into their cards, with audio on none', async () => {
    writeLedger([
      { id: 'photo', kind: 'image', label: 'Photo', path: 'media/photo.png', origin: 'upload' },
      { id: 'voice', kind: 'audio', label: 'Voice', path: 'media/voice.mp3', origin: 'upload' },
      { id: 'pour-1', kind: 'video', label: 'Pour', path: 'gen/pour-1.mp4', origin: 'generated', shot: 'pour', prompt: 'first', refs: [{ asset: 'photo', role: 'reference' }] },
      { id: 'pour-2', kind: 'video', label: 'Pour again', path: 'gen/pour-2.mp4', origin: 'generated', shot: 'pour', prompt: 'second', request: { prompt: 'second' } },
      { id: 'single', kind: 'image', label: 'Single', path: 'gen/single.png', origin: 'generated' },
    ]);
    writeVideo('main', { scenes: [
      { id: 'one', clips: [{ id: 'c1', asset: 'pour-2', in: 0, dur: 2 }] },
      { id: 'two', clips: [{ id: 'c2', asset: 'photo', in: 0, dur: 2 }] },
      { id: 'three', duration: 1, narration: { text: 'Light your desk.', asset: 'voice' } },
    ] });

    const [production] = await read();

    expect(production.dir).toBe('ad');
    expect(production.assets.map((card) => card.key)).toEqual(['asset:photo']);
    expect(production.shots.map((card) => card.key)).toEqual(['shot:pour', 'shot:single']);
    const pour = production.shots[0];
    expect(pour.results.map((result) => result.asset_id)).toEqual(['pour-1', 'pour-2']);
    expect(pour.label).toBe('Pour again');
    // Lines are computed from who uses whom, and are not stored.
    expect(pour.uses).toEqual(['asset:photo']);
    const [video] = production.videos;
    expect(video.key).toBe('video:main');
    expect(video.uses.sort()).toEqual(['asset:photo', 'shot:pour']);
    expect(video.scenes[0]).toMatchObject({
      id: 'one',
      start_sec: 0,
      duration_sec: 2,
      source: 'shot:pour',
      asset_id: 'pour-2',
      media_kind: 'video',
      redoable: true,
    });
    expect(video.scenes[1]).toMatchObject({ start_sec: 2, source: 'asset:photo', redoable: false });
    expect(video.scenes[2]).toMatchObject({ narration: 'Light your desk.', redoable: false });
    expect(video.scenes[2].source).toBeUndefined();
  });

  // Selecting a shot shows how each take was made, so the user can make it again with other
  // words or on another service (decided 2026-11-09).
  it('shows how each take of a shot was made, and how many videos show it', async () => {
    writeLedger([
      { id: 'photo', kind: 'image', label: 'Photo', path: 'media/photo.png', origin: 'upload' },
      { id: 'logo', kind: 'image', label: 'Logo', path: 'media/logo.png', origin: 'upload' },
      {
        id: 'pour-1', kind: 'video', label: 'Pour', path: 'gen/pour-1.mp4', origin: 'generated', shot: 'pour', prompt: 'juice pours',
        model: 'doubao/doubao-seedance-2-0-260128',
        refs: [{ asset: 'logo', role: 'reference' }, { asset: 'photo', role: 'first_frame' }, { asset: 'gone', role: 'reference' }],
        request: { prompt: 'juice pours', ratio: '9:16', resolution: '720p', duration: 5, generate_audio: false },
      },
      {
        id: 'pour-2', kind: 'video', label: 'Pour', path: 'gen/pour-2.mp4', origin: 'generated', shot: 'pour', prompt: 'juice pours slowly',
        model: 'doubao/doubao-seedance-2-0-fast-260128', request: { prompt: 'juice pours slowly', duration: 5 },
      },
      { id: 'pour-3', kind: 'video', label: 'Pour', path: 'gen/pour-3.mp4', origin: 'generated', shot: 'pour' },
      { id: 'still', kind: 'image', label: 'Still', path: 'gen/still.png', origin: 'generated', model: 'orkas-api/orkas-image', request: { prompt: 'a lamp', size: '2k' } },
    ]);
    writeVideo('main', { scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'pour-2', in: 0, dur: 2 }] }] });
    writeVideo('cut', { scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'pour-2', in: 0, dur: 2 }, { id: 'o', asset: 'still', in: 0, dur: 1, at: 0 }] }] });

    const [production] = await read();
    const pour = production.shots.find((card) => card.key === 'shot:pour')!;

    expect(pour.results[0]).toMatchObject({
      asset_id: 'pour-1',
      prompt: 'juice pours',
      // In the order the call named them, and only what is still on the canvas.
      refs: [{ card: 'asset:logo', role: 'reference' }, { card: 'asset:photo', role: 'first_frame' }],
      model: 'Doubao Seedance 2.0',
      params: { ratio: '9:16', resolution: '720p', duration: 5, audio: false },
      redoable: true,
      used_in: 0,
    });
    expect(pour.results[1]).toMatchObject({
      asset_id: 'pour-2', refs: [], model: 'Doubao Seedance 2.0 Fast', params: { duration: 5, audio: true }, redoable: true, used_in: 2,
    });
    expect(pour.results[2]).toMatchObject({ asset_id: 'pour-3', refs: [], redoable: false, used_in: 0 });
    expect(pour.results[2]).not.toHaveProperty('model');
    const still = production.shots.find((card) => card.key === 'shot:still')!;
    expect(still.results[0]).toMatchObject({ model: 'orkas-image', params: { size: '2k' }, redoable: true, used_in: 1 });
  });

  it('reads the words of a scene, and marks the ones that quote a fact', async () => {
    writeProduct();
    writeVideo('main');

    const [production] = await read();

    expect(production.name).toBe('Desk lamp');
    expect(production.product?.facts).toEqual([{ id: 'price', text: '$29', source: 'page' }]);
    const [hook, , price] = production.videos[0].scenes;
    expect(hook.texts).toEqual([{ slot: 'title', value: 'Bright lamp' }]);
    expect(price.texts).toEqual([{ slot: 'amount', value: '$29', fact_id: 'price' }]);
  });

  // Decided on 2026-11-09: the product sits among the footage as a card of its own, with lines
  // from its pictures and to every video, since each is made from it.
  it('shows the product as a card its pictures feed and every video uses', async () => {
    writeLedger([
      { id: 'photo', kind: 'image', label: 'Photo', path: 'media/photo.png', origin: 'upload' },
      { id: 'take', kind: 'image', label: 'Take', path: 'gen/take.png', origin: 'generated', shot: 'hero' },
    ]);
    write('ad/product.json', JSON.stringify({
      name: 'Desk lamp',
      facts: [{ id: 'price', text: '$29', source: 'page' }],
      images: ['photo', 'take', 'gone'],
    }));
    writeVideo('main');
    writeVideo('plain', { scenes: [{ id: 'one', duration: 2 }] });

    const [production] = await read();

    expect(production.product).toEqual({
      key: 'product',
      label: 'Desk lamp',
      facts: [{ id: 'price', text: '$29', source: 'page' }],
      uses: ['asset:photo', 'shot:hero'],
    });
    expect(production.videos.find((video) => video.id === 'main')?.uses).toContain('product');
    expect(production.videos.find((video) => video.id === 'plain')?.uses).toContain('product');
  });

  it('shows a frame for each scene from the newest preview that has one', async () => {
    writeVideo('main');
    write('ad/preview/main/1/01-hook-end.png');
    write('ad/preview/main/1/02-body-end.png');
    const newest = write('ad/preview/main/2/01-hook-end.png');
    write('ad/preview/main/2/01-hook-start.png');

    const [{ videos: [video] }] = await read();

    expect(video.scenes[0].frame_path).toBe(newest);
    expect(video.scenes[1].frame_path).toBe(path.join(workspace, 'ad/preview/main/1/02-body-end.png'));
    expect(video.scenes[2].frame_path).toBeUndefined();
  });

  it('lists a video\'s versions oldest first, and leaves out a file that is gone', async () => {
    writeVideo('main');
    const first = write('ad/versions/main-v1.mp4');
    const second = write('ad/versions/main-v3.mp4');
    write('ad/versions.json', JSON.stringify({ versions: [
      version('v1', 'main', 'versions/main-v1.mp4'),
      version('v2', 'main', 'versions/main-v2.mp4'),
      version('v3', 'main', 'versions/main-v3.mp4'),
      version('v9', 'other', 'versions/other.mp4'),
    ] }));

    const [{ videos: [video] }] = await read();

    expect(video.versions.map((item) => [item.id, item.media_path])).toEqual([['v1', first], ['v3', second]]);
  });

  it('gives a video made with ffmpeg alone a card that can only be played', async () => {
    const file = write('cut/final/cut.mp4');
    write('cut/versions.json', JSON.stringify({ versions: [version('v1', undefined, 'final/cut.mp4')] }));

    const [production] = await read();

    expect(production.videos).toHaveLength(1);
    expect(production.videos[0]).toMatchObject({ key: 'video:delivered', id: '', label: 'cut.mp4', scenes: [] });
    expect(production.videos[0].versions[0].media_path).toBe(file);
  });

  it('keeps showing the rest when a file is damaged', async () => {
    write('ad/assets.json', '{not json');
    write('ad/versions.json', '{not json');
    write('ad/product.json', '[]');
    writeVideo('main');
    write('ad/videos/broken/manifest.json', '{not json');

    const [production] = await read();

    expect(production.videos.map((video) => video.id)).toEqual(['main']);
    expect(production.product).toBeNull();
    expect(production.assets).toEqual([]);
  });

  it('never shows a file outside the production', async () => {
    write('secret.png');
    write('ad/assets.json', JSON.stringify({ assets: [
      { id: 'away', kind: 'image', label: 'Away', path: '../secret.png', origin: 'upload' },
    ] }));
    writeVideo('main', { scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'away', in: 0, dur: 1 }] }] });

    const [production] = await read();

    expect(production.assets).toEqual([]);
    expect(production.videos[0].scenes[0].media_path).toBeUndefined();
  });

  it('does not follow a link out of the production', async () => {
    const outside = path.join(root, 'private.png');
    fs.writeFileSync(outside, 'bytes');
    fs.mkdirSync(path.join(workspace, 'ad/media'), { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, 'ad/media/link.png'));
    write('ad/assets.json', JSON.stringify({ assets: [
      { id: 'link', kind: 'image', label: 'Link', path: 'media/link.png', origin: 'upload' },
    ] }));
    writeVideo('main', { scenes: [{ id: 'one', duration: 1 }] });

    const [production] = await read();

    expect(production.assets).toEqual([]);
  });

  it('puts the production changed last first, and moving a card does not change that', async () => {
    writeVideo('main', {}, 'older');
    writeVideo('main', {}, 'newer');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(workspace, 'older/videos/main/manifest.json'), past, past);

    await saveVideoCanvasLayout({ uid: UID, cid: CID, dir: 'older', cards: { 'video:main': { x: 1, y: 2 } } });

    expect((await read()).map((production) => production.dir)).toEqual(['newer', 'older']);
  });

  it('marks an upgraded page\'s scenes as drawn by the page', async () => {
    writeVideo('main', {
      upgraded_from: 'old',
      absolute_page: { timeline_key: 'root', scene_starts: { hook: 0, body: 3 } },
    });

    const [{ videos: [video] }] = await read();

    expect(video.scenes.map((scene) => scene.on_page_timeline)).toEqual([true, true, false]);
  });
});

describe('card positions', () => {
  it('keeps where the user put a card, and only sensible positions', async () => {
    writeVideo('main');

    expect(await saveVideoCanvasLayout({
      uid: UID,
      cid: CID,
      dir: 'ad',
      cards: { 'video:main': { x: 12.4, y: -8 }, bad: { x: 'a', y: 1 }, worse: null },
    })).toEqual({ ok: true });

    const [production] = await read();
    expect(production.layout).toEqual({ 'video:main': { x: 12, y: -8 } });
    expect(readJson('ad/canvas.json')).toEqual({ cards: { 'video:main': { x: 12, y: -8 } } });
  });

  it('reads a damaged layout as none', async () => {
    writeVideo('main');
    write('ad/canvas.json', '{not json');
    expect((await read())[0].layout).toEqual({});
  });

  it('discards non-finite card coordinates without losing valid positions', async () => {
    writeVideo('main');
    expect(await saveVideoCanvasLayout({ uid: UID, cid: CID, dir: 'ad', cards: {
      'video:main': { x: 0, y: -120 },
      'asset:nan': { x: NaN, y: 0 },
      'asset:infinite-x': { x: Infinity, y: 0 },
      'asset:infinite-y': { x: 0, y: -Infinity },
    } })).toEqual({ ok: true });
    expect((await read())[0].layout).toEqual({ 'video:main': { x: 0, y: -120 } });
    expect(readJson('ad/canvas.json').cards).toEqual({ 'video:main': { x: 0, y: -120 } });
  });

  it('refuses a folder outside the workspace', async () => {
    expect(await saveVideoCanvasLayout({ uid: UID, cid: CID, dir: '../elsewhere', cards: {} })).toMatchObject({ ok: false, code: 'not_found' });
    expect(fs.existsSync(path.join(root, 'elsewhere'))).toBe(false);
  });
});

// Decided 2026-11-10 (plan 27.20): a line drawn from footage or a shot makes a "new shot" card, as
// TapNow does. It belongs to the canvas until it is generated, so it lives in canvas.json beside
// the card positions, and survives closing the canvas.
describe('new shots drawn from footage', () => {
  const change = (next: VideoCanvasDraftChange) => applyVideoCanvasDraftChange({ uid: UID, cid: CID, dir: 'ad', change: next });
  beforeEach(() => {
    writeLedger([
      { id: 'photo', kind: 'image', label: 'Photo', path: 'media/photo.png', origin: 'upload' },
      { id: 'clip', kind: 'video', label: 'Clip', path: 'media/clip.mp4', origin: 'upload' },
      { id: 'voice', kind: 'audio', label: 'Voice', path: 'media/voice.mp3', origin: 'upload' },
      { id: 'pour-1', kind: 'video', label: 'Pour', path: 'gen/pour-1.mp4', origin: 'generated', shot: 'pour' },
    ]);
    writeVideo('main');
  });
  async function made(next: Extract<VideoCanvasDraftChange, { kind: 'create' }>): Promise<string> {
    const result = await change(next);
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    return result.id;
  }

  it('keeps a new shot made from a card where it was put, with what it uses', async () => {
    const id = await made({ kind: 'create', type: 'video', inputs: ['photo'], at: { x: 420.6, y: 80 } });
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

    const [production] = await read();
    expect(production.drafts).toEqual([{
      key: `draft:${id}`,
      id,
      kind: 'video',
      prompt: '',
      method: 'references',
      inputs: [{ asset_id: 'photo', card: 'asset:photo', kind: 'image', label: 'Photo', media_path: expect.stringContaining('photo.png') }],
      uses: ['asset:photo'],
    }]);
    expect(production.layout[`draft:${id}`]).toEqual({ x: 421, y: 80 });
  });

  it('keeps its words and choices, and leaves out footage that is no longer there', async () => {
    const id = await made({ kind: 'create', type: 'video', inputs: ['photo'], at: { x: 0, y: 0 } });

    expect(await change({ kind: 'update', id, prompt: 'pour juice', method: 'frames', inputs: ['photo', 'pour-1', 'photo'], choice: 'doubao', ratio: '9:16', duration: 8, resolution: '1080p', audio: true }))
      .toEqual({ ok: true, id });
    let [production] = await read();
    expect(production.drafts[0]).toMatchObject({
      prompt: 'pour juice',
      method: 'frames',
      choice: 'doubao',
      ratio: '9:16',
      duration: 8,
      // Its sharpness and sound too (decided 2026-11-10, plan 27.21).
      resolution: '1080p',
      audio: true,
      // A take of a shot stands for its shot's card; the same footage twice is once.
      inputs: [{ asset_id: 'photo', card: 'asset:photo' }, { asset_id: 'pour-1', card: 'shot:pour', kind: 'video' }],
      uses: ['asset:photo', 'shot:pour'],
    });

    writeLedger([{ id: 'pour-1', kind: 'video', label: 'Pour', path: 'gen/pour-1.mp4', origin: 'generated', shot: 'pour' }]);
    [production] = await read();
    expect(production.drafts[0].inputs.map((input) => input.asset_id)).toEqual(['pour-1']);
    expect(production.drafts[0].uses).toEqual(['shot:pour']);
  });

  it.each([
    ['sound', { kind: 'create', type: 'video', inputs: ['voice'], at: { x: 0, y: 0 } }],
    ['footage the ledger does not have', { kind: 'create', type: 'video', inputs: ['missing'], at: { x: 0, y: 0 } }],
    ['a kind of shot there is not', { kind: 'create', type: 'audio', inputs: [], at: { x: 0, y: 0 } }],
    ['a video for an image', { kind: 'create', type: 'image', inputs: ['clip'], at: { x: 0, y: 0 } }],
    ['a place that is not one', { kind: 'create', type: 'video', inputs: [], at: { x: 'left', y: 0 } }],
  ])('will not make a new shot from %s', async (_label, next) => {
    expect(await change(next as VideoCanvasDraftChange)).toEqual({ ok: false, code: 'invalid' });
    expect(fs.existsSync(path.join(workspace, 'ad', 'canvas.json'))).toBe(false);
  });

  it.each([
    ['an unknown aspect ratio', { ratio: 'wide' }],
    ['a length that is not whole seconds', { duration: 2.5 }],
    ['no length at all', { duration: 0 }],
    ['a resolution there is not', { resolution: '9000p' }],
    ['sound that is neither on nor off', { audio: 'loud' }],
    ['a way of making it that does not exist', { method: 'sideways' }],
    ['words longer than any service takes', { prompt: 'x'.repeat(20001) }],
    ['footage that is not a list', { inputs: 'photo' }],
  ])('will not save %s', async (_label, fields) => {
    const id = await made({ kind: 'create', type: 'video', inputs: ['photo'], at: { x: 0, y: 0 } });
    const before = fs.readFileSync(path.join(workspace, 'ad/canvas.json'));
    expect(await change({ kind: 'update', id, ...fields } as VideoCanvasDraftChange)).toEqual({ ok: false, code: 'invalid' });
    expect(fs.readFileSync(path.join(workspace, 'ad/canvas.json'))).toEqual(before);
    expect((await read())[0].drafts[0]).toMatchObject({ prompt: '', method: 'references' });
  });

  it.each([
    ['prompt', 'x'.repeat(19999), 'x'.repeat(20000), 'x'.repeat(20001)],
    ['choice', 'm'.repeat(199), 'm'.repeat(200), 'm'.repeat(201)],
    ['duration', 29, 30, 31],
  ] as const)('saves %s up to its limit and preserves the entire draft when the next value is too large', async (field, below, at, above) => {
    const id = await made({ kind: 'create', type: 'video', inputs: ['photo'], at: { x: 4, y: 8 } });
    for (const value of [below, at]) {
      expect(await change({ kind: 'update', id, [field]: value } as VideoCanvasDraftChange)).toEqual({ ok: true, id });
      expect(readJson('ad/canvas.json').drafts[id][field]).toBe(value);
      expect((await read())[0].drafts[0]).toHaveProperty(field, value);
    }
    const before = fs.readFileSync(path.join(workspace, 'ad/canvas.json'));
    expect(await change({ kind: 'update', id, prompt: 'must not partly save', [field]: above } as VideoCanvasDraftChange))
      .toEqual({ ok: false, code: 'invalid' });
    expect(fs.readFileSync(path.join(workspace, 'ad/canvas.json'))).toEqual(before);
    // A valid follow-up is still possible after refusal.
    expect(await change({ kind: 'update', id, [field]: below } as VideoCanvasDraftChange)).toEqual({ ok: true, id });
  });

  it('keeps reference order at the thirty-input boundary and refuses excess without a partial update', async () => {
    const inputs = Array.from({ length: 31 }, (_, i) => `photo-${i}`);
    writeLedger(inputs.map(id => ({ id, kind: 'image', label: id, path: `media/${id}.png`, origin: 'upload' })));
    const id = await made({ kind: 'create', type: 'video', inputs: inputs.slice(0, 29), at: { x: 0, y: 0 } });
    expect((await read())[0].drafts[0].inputs.map(item => item.asset_id)).toEqual(inputs.slice(0, 29));
    expect(await change({ kind: 'update', id, inputs: inputs.slice(0, 30) })).toEqual({ ok: true, id });
    expect((await read())[0].drafts[0].inputs.map(item => item.asset_id)).toEqual(inputs.slice(0, 30));
    const before = fs.readFileSync(path.join(workspace, 'ad/canvas.json'));
    expect(await change({ kind: 'update', id, prompt: 'must not partly save', inputs })).toEqual({ ok: false, code: 'invalid' });
    expect(await change({ kind: 'create', type: 'video', inputs, at: { x: 0, y: 0 } })).toEqual({ ok: false, code: 'invalid' });
    expect(fs.readFileSync(path.join(workspace, 'ad/canvas.json'))).toEqual(before);
  });

  it('preserves independent draft fields and card positions when updates overlap', async () => {
    const id = await made({ kind: 'create', type: 'video', inputs: ['photo'], at: { x: 10, y: 20 } });
    const results = await Promise.all([
      change({ kind: 'update', id, prompt: 'A lamp turns on' }),
      change({ kind: 'update', id, duration: 1, audio: false }),
      saveVideoCanvasLayout({ uid: UID, cid: CID, dir: 'ad', cards: { [`draft:${id}`]: { x: -80, y: 120 }, 'video:main': { x: 300, y: 40 } } }),
    ]);
    expect(results.every(result => result.ok)).toBe(true);
    const [production] = await read();
    expect(production.drafts[0]).toMatchObject({ id, prompt: 'A lamp turns on', duration: 1, audio: false });
    expect(production.layout).toEqual({ [`draft:${id}`]: { x: -80, y: 120 }, 'video:main': { x: 300, y: 40 } });
  });

  it('admits only one of two concurrent new shots at the fifty-draft limit, then recovers after removal', async () => {
    for (let index = 0; index < 49; index += 1) await made({ kind: 'create', type: 'video', inputs: [], at: { x: index, y: 0 } });
    const before = readJson('ad/canvas.json').drafts;
    const results = await Promise.all([0, 1].map(x => change({ kind: 'create', type: 'video', inputs: ['photo'], at: { x, y: 20 } })));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, code: 'invalid' }]);
    expect((await read())[0].drafts).toHaveLength(50);
    expect(readJson('ad/canvas.json').drafts).toMatchObject(before);
    const winner = results.find(result => result.ok)!;
    if (!winner.ok) throw new Error('Expected an admitted draft');
    expect(await change({ kind: 'remove', id: winner.id })).toEqual({ ok: true, id: winner.id });
    await made({ kind: 'create', type: 'video', inputs: ['photo'], at: { x: 0, y: 20 } });
    expect((await read())[0].drafts).toHaveLength(50);
  });

  it('keeps an image to images, made from references', async () => {
    const id = await made({ kind: 'create', type: 'image', inputs: ['photo'], at: { x: 0, y: 0 } });
    expect(await change({ kind: 'update', id, inputs: ['clip'] })).toEqual({ ok: false, code: 'invalid' });
    expect(await change({ kind: 'update', id, method: 'frames' })).toEqual({ ok: false, code: 'invalid' });
    expect(await change({ kind: 'update', id: 'missing', prompt: 'x' })).toEqual({ ok: false, code: 'not_found' });
  });

  it('removes a new shot and its place', async () => {
    const id = await made({ kind: 'create', type: 'video', inputs: ['photo'], at: { x: 10, y: 10 } });
    await saveVideoCanvasLayout({ uid: UID, cid: CID, dir: 'ad', cards: { 'video:main': { x: 1, y: 2 }, [`draft:${id}`]: { x: 10, y: 10 } } });

    expect(await change({ kind: 'remove', id })).toEqual({ ok: true, id });
    expect(await change({ kind: 'remove', id })).toEqual({ ok: false, code: 'not_found' });

    const [production] = await read();
    expect(production.drafts).toEqual([]);
    expect(readJson('ad/canvas.json')).toEqual({ cards: { 'video:main': { x: 1, y: 2 } } });
  });

  it('keeps new shots when a card moves, and forgets the place of one that is gone', async () => {
    const id = await made({ kind: 'create', type: 'video', inputs: ['photo'], at: { x: 10, y: 10 } });

    expect(await saveVideoCanvasLayout({
      uid: UID,
      cid: CID,
      dir: 'ad',
      cards: { 'video:main': { x: 1, y: 2 }, [`draft:${id}`]: { x: 30, y: 40 }, 'draft:gone': { x: 5, y: 5 } },
    })).toEqual({ ok: true });

    const file = readJson('ad/canvas.json');
    expect(file.cards).toEqual({ 'video:main': { x: 1, y: 2 }, [`draft:${id}`]: { x: 30, y: 40 } });
    expect(Object.keys(file.drafts)).toEqual([id]);
  });

  it('reads a new shot saved before it had a resolution or sound, and drops ones it cannot read', async () => {
    write('ad/canvas.json', JSON.stringify({
      cards: {},
      drafts: {
        older: { kind: 'video', prompt: 'a lamp', method: 'references', inputs: ['photo'], ratio: '9:16', duration: 5 },
        odd: { kind: 'video', prompt: 'a lamp', method: 'references', inputs: [], resolution: 1080, audio: 'yes' },
      },
    }));
    const drafts = Object.fromEntries((await read())[0].drafts.map((draft) => [draft.id, draft]));
    expect(drafts.older).toMatchObject({ ratio: '9:16', duration: 5 });
    expect(drafts.older).not.toHaveProperty('resolution');
    expect(drafts.older).not.toHaveProperty('audio');
    expect(drafts.odd).not.toHaveProperty('resolution');
    expect(drafts.odd).not.toHaveProperty('audio');
  });

  it('reads only the new shots it can trust from a damaged file', async () => {
    write('ad/canvas.json', JSON.stringify({
      cards: {},
      drafts: {
        'kept-1': { kind: 'image', prompt: 'a lamp', method: 'references', inputs: ['photo', 7] },
        'bad id!': { kind: 'video', prompt: '', method: 'references', inputs: [] },
        'no-kind': { prompt: '', method: 'references', inputs: [] },
        'no-words': { kind: 'video', prompt: 5, method: 'references', inputs: [] },
      },
    }));

    const [production] = await read();
    expect(production.drafts.map((draft) => [draft.id, draft.kind, draft.prompt, draft.inputs.map((input) => input.asset_id)]))
      .toEqual([['kept-1', 'image', 'a lamp', ['photo']]]);
  });

  it('holds at most fifty new shots in a production', async () => {
    for (let index = 0; index < 50; index += 1) await made({ kind: 'create', type: 'video', inputs: [], at: { x: index, y: 0 } });
    expect(await change({ kind: 'create', type: 'video', inputs: [], at: { x: 0, y: 0 } })).toEqual({ ok: false, code: 'invalid' });
    expect((await read())[0].drafts).toHaveLength(50);
  });
});

describe('changing a video', () => {
  beforeEach(() => {
    writeProduct();
    writeVideo('main');
  });

  it('changes nothing while the Agent is working', async () => {
    const before = fs.readFileSync(path.join(workspace, 'ad/videos/main/manifest.json'), 'utf8');

    const result = await edit({ kind: 'set_text', video: 'main', scene: 'hook', slot: 'title', value: 'New' }, true);

    expect(result).toEqual({ ok: false, code: 'busy' });
    expect(fs.readFileSync(path.join(workspace, 'ad/videos/main/manifest.json'), 'utf8')).toBe(before);
  });

  it('refuses a folder outside the workspace, and a video id that climbs out', async () => {
    expect(await applyVideoCanvasEdit({
      uid: UID,
      cid: CID,
      dir: '../elsewhere',
      busy: false,
      edit: { kind: 'remove_scene', video: 'main', scene: 'hook' },
    })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await edit({ kind: 'remove_scene', video: '../../x', scene: 'hook' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('changes the words in a scene and says the video needs rendering', async () => {
    const result = await edit({ kind: 'set_text', video: 'main', scene: 'hook', slot: 'title', value: 'New words' });

    expect(result).toEqual({ ok: true, changed_videos: ['main'] });
    expect(manifestOf().scenes[0].text.title).toEqual({ value: 'New words' });
  });

  // Decided 2026-11-11: words that quote a product fact change in the scene like any others. They
  // become that scene's own words, and the product, the other scenes and their quotes stay.
  it('makes words that quoted a fact the scene\'s own, and leaves the product as it was', async () => {
    const productBefore = fs.readFileSync(path.join(workspace, 'ad/product.json'), 'utf8');

    const result = await edit({ kind: 'set_text', video: 'main', scene: 'price', slot: 'amount', value: 'Only $1' });

    expect(result).toEqual({ ok: true, changed_videos: ['main'] });
    expect(manifestOf().scenes[2].text.amount).toEqual({ value: 'Only $1' });
    expect(fs.readFileSync(path.join(workspace, 'ad/product.json'), 'utf8')).toBe(productBefore);
    const [{ videos: [video] }] = await read();
    expect(video.scenes[2].texts).toEqual([{ slot: 'amount', value: 'Only $1' }]);
    expect(await edit({ kind: 'set_text', video: 'main', scene: 'price', slot: 'missing', value: 'x' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('moves scenes, and timing follows the new order', async () => {
    const result = await edit({ kind: 'reorder', video: 'main', order: ['price', 'hook', 'body'] });

    expect(result).toEqual({ ok: true, changed_videos: ['main'] });
    const [{ videos: [video] }] = await read();
    expect(video.scenes.map((scene) => [scene.id, scene.start_sec])).toEqual([['price', 0], ['hook', 2], ['body', 5]]);
  });

  it.each([
    ['a scene left out', ['hook', 'body']],
    ['a scene listed twice', ['hook', 'hook', 'body']],
    ['an unknown scene', ['hook', 'body', 'other']],
  ])('refuses an order with %s', async (_label, order) => {
    expect(await edit({ kind: 'reorder', video: 'main', order })).toMatchObject({ ok: false, code: 'invalid' });
    expect(manifestOf().scenes.map((scene: { id: string }) => scene.id)).toEqual(['hook', 'body', 'price']);
  });

  it('removes a scene, but not the last one', async () => {
    expect(await edit({ kind: 'remove_scene', video: 'main', scene: 'body' })).toEqual({ ok: true, changed_videos: ['main'] });
    expect(await edit({ kind: 'remove_scene', video: 'main', scene: 'hook' })).toEqual({ ok: true, changed_videos: ['main'] });
    expect(await edit({ kind: 'remove_scene', video: 'main', scene: 'price' })).toEqual({ ok: false, code: 'last_scene' });
    expect(manifestOf().scenes.map((scene: { id: string }) => scene.id)).toEqual(['price']);
  });

  it('never touches the page', async () => {
    const page = write('ad/videos/main/index.html', '<!doctype html><main data-composition-id="main"></main>');
    const before = fs.readFileSync(page, 'utf8');

    await edit({ kind: 'set_text', video: 'main', scene: 'hook', slot: 'title', value: 'New' });
    await edit({ kind: 'remove_scene', video: 'main', scene: 'body' });

    expect(fs.readFileSync(page, 'utf8')).toBe(before);
  });

  it('reports a damaged timeline without writing over it', async () => {
    write('ad/videos/main/manifest.json', '{not json');
    expect(await edit({ kind: 'remove_scene', video: 'main', scene: 'hook' })).toEqual({ ok: false, code: 'unreadable' });
    expect(fs.readFileSync(path.join(workspace, 'ad/videos/main/manifest.json'), 'utf8')).toBe('{not json');
  });

  it('will not save a change the video could not render with', async () => {
    writeVideo('main', { scenes: [
      { id: 'hook', duration: 3 },
      { id: 'broken', duration: 2, text: { amount: { fact_id: 'missing' } } },
    ] });
    const before = fs.readFileSync(path.join(workspace, 'ad/videos/main/manifest.json'), 'utf8');

    const result = await edit({ kind: 'remove_scene', video: 'main', scene: 'hook' });

    expect(result).toMatchObject({ ok: false, code: 'invalid' });
    expect(fs.readFileSync(path.join(workspace, 'ad/videos/main/manifest.json'), 'utf8')).toBe(before);
  });
});

// Decided 2026-11-11: narration voiced here changes on the canvas like words, and so does the
// video's one voice; the user's Update hands both to the Agent, which voices them again.
describe('changing narration and the voice', () => {
  const ROUTE = 'configured:test-voice';
  const WARM = `${ROUTE}:voice:warm`;
  const BRIGHT = `${ROUTE}:voice:bright`;
  const CALM = `${ROUTE}:voice:calm`;
  const voice = (voiceRef: string, displayName: string, locales = ['en-US']) => ({
    voiceRef,
    displayName,
    locale: locales[0],
    nativeLocale: locales[0],
    supportedLocales: locales,
    mixedLanguageSupport: false,
    languageConfidence: 'verified',
    styleTags: [],
    useCases: [],
    isDefault: false,
    providerVoiceId: voiceRef.split(':').pop(),
  });
  const spoken = (id: string, words: string, voiceRef = WARM) => ({
    id,
    kind: 'audio',
    label: words,
    path: `voice/${id}.mp3`,
    origin: 'generated',
    prompt: words,
    request: { route_ref: ROUTE, voice_ref: voiceRef, language: 'en-US' },
  });
  const RECORDING = { id: 'recording', kind: 'audio', label: 'My recording', path: 'voice/mine.m4a', origin: 'upload' };
  const writeNarrated = (hook: string, body: string) => writeVideo('main', { scenes: [
    { id: 'hook', duration: 3, narration: { text: 'Bright light for late nights.', asset: hook } },
    { id: 'body', duration: 4, narration: { text: 'It charges in an hour.', asset: body } },
    { id: 'outro', duration: 2, narration: { text: 'My own words.', asset: 'recording' } },
    { id: 'price', duration: 2 },
  ] });

  beforeEach(() => {
    speech.fail = false;
    speech.routes = [{
      routeRef: ROUTE,
      provider: 'doubao',
      model: 'tts',
      displayName: 'Configured Voice',
      catalogStatus: 'complete',
      voices: [voice(WARM, 'Warm'), voice(BRIGHT, 'Bright'), voice(CALM, 'Calm'), voice(`${ROUTE}:voice:mandarin`, '普通话女声', ['zh-CN'])],
      supports: { speed: true, formats: ['mp3'], languageContract: true },
    }];
    writeLedger([spoken('voice-hook', 'Bright light for late nights.'), spoken('voice-body', 'It charges in an hour.'), RECORDING]);
    writeNarrated('voice-hook', 'voice-body');
  });

  const card = async () => (await read())[0].videos[0];
  const setWords = (scene: string, value: string, busy = false) => edit({ kind: 'set_narration', video: 'main', scene, value }, busy);
  const pick = (voiceRef: string, busy = false) => edit({ kind: 'set_voice', video: 'main', route_ref: ROUTE, voice_ref: voiceRef }, busy);
  /** As the Agent leaves it after voicing every line again. */
  const voicedAgainIn = (voiceRef: string) => {
    writeLedger([
      spoken('voice-hook', 'Bright light for late nights.'),
      spoken('voice-body', 'It charges in an hour.'),
      spoken('hook-2', 'Bright light for late nights.', voiceRef),
      spoken('body-2', 'It charges in an hour.', voiceRef),
      RECORDING,
    ]);
    writeNarrated('hook-2', 'body-2');
  };

  it('lets the words of narration voiced here change, and names the voice it was made with', async () => {
    const video = await card();

    expect(video.scenes.map((scene) => scene.narration_editable)).toEqual([true, true, false, false]);
    expect(video.voice).toEqual({ route_ref: ROUTE, voice_ref: WARM });
    expect(video.narration_changes).toEqual([]);
    expect(video.voice_wanted).toBeNull();
  });

  it('keeps the voice when the words change, and lists the lines to voice again', async () => {
    expect(await setWords('hook', 'Warm light for late nights.')).toEqual({ ok: true, changed_videos: ['main'] });

    expect(manifestOf().scenes[0].narration).toEqual({ text: 'Warm light for late nights.', asset: 'voice-hook' });
    expect((await card()).narration_changes).toEqual([{ position: 1, scene: 'hook', text: 'Warm light for late nights.' }]);
  });

  it('counts the words said, not their punctuation, and nothing once they are changed back', async () => {
    await setWords('body', 'It charges, in an hour!');
    expect((await card()).narration_changes).toEqual([]);

    await setWords('body', 'It charges in half an hour.');
    await setWords('body', 'It charges in an hour.');
    expect((await card()).narration_changes).toEqual([]);
  });

  it('will not change narration not voiced here, or leave it empty', async () => {
    const before = fs.readFileSync(path.join(workspace, 'ad/videos/main/manifest.json'), 'utf8');

    expect(await setWords('outro', 'New words')).toMatchObject({ ok: false, code: 'invalid' });
    expect(await setWords('price', 'New words')).toMatchObject({ ok: false, code: 'invalid' });
    expect(await setWords('hook', '   ')).toMatchObject({ ok: false, code: 'invalid' });
    expect(await setWords('gone', 'New words')).toMatchObject({ ok: false, code: 'not_found' });
    expect(fs.readFileSync(path.join(workspace, 'ad/videos/main/manifest.json'), 'utf8')).toBe(before);
  });

  /** As Luna leaves its lines when it voices them before the production has a ledger: rows it
   *  wrote itself, with the voice and without the words (seen 2026-11-11). */
  const writtenByAgent = (id: string) => ({ id, kind: 'audio', label: id, path: `voice/${id}.mp3`, origin: 'generated', request: { route_ref: ROUTE, voice_ref: WARM } });
  /** A delivery of these lines, each audio its own bytes, heard with these words. */
  const deliver = (lines: Record<string, string | string[]>) => {
    const words: Record<string, string[]> = {};
    for (const [id, said] of Object.entries(lines)) {
      const bytes = `audio of ${id}`;
      write(`ad/voice/${id}.mp3`, bytes);
      words[crypto.createHash('sha256').update(bytes).digest('hex')] = [said].flat();
    }
    write('ad/versions.json', JSON.stringify({ versions: [version('v1', 'main', 'versions/main-v1.mp4')], delivered_narration: words }));
  };

  it('knows what a line says from its delivery when its row does not', async () => {
    writeLedger([writtenByAgent('voice-hook'), writtenByAgent('voice-body'), RECORDING]);
    deliver({ 'voice-hook': 'Bright light for late nights.', 'voice-body': 'It charges in an hour.' });

    expect((await card()).scenes.map((scene) => scene.narration_editable)).toEqual([true, true, false, false]);
    expect((await card()).narration_changes).toEqual([]);
    expect(await setWords('hook', 'Warm light for late nights.')).toEqual({ ok: true, changed_videos: ['main'] });
    expect((await card()).narration_changes).toEqual([{ position: 1, scene: 'hook', text: 'Warm light for late nights.' }]);
  });

  it('leaves a line whose words nothing records as it is', async () => {
    writeLedger([writtenByAgent('voice-hook'), writtenByAgent('voice-body'), RECORDING]);

    expect((await card()).scenes.map((scene) => scene.narration_editable)).toEqual([false, false, false, false]);
    expect(await setWords('hook', 'Warm light for late nights.')).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('lets a line change when its row names the voice its own way, and offers no other voice', async () => {
    // Seen 2026-11-11: Luna wrote "voice" and "route" rather than the refs.
    const ownWay = (id: string) => ({ ...writtenByAgent(id), request: { voice: 'mock-voice', route: 'openai-compatible' } });
    writeLedger([ownWay('voice-hook'), ownWay('voice-body'), RECORDING]);
    deliver({ 'voice-hook': 'Bright light for late nights.', 'voice-body': 'It charges in an hour.' });

    const video = await card();
    expect(video.scenes.map((scene) => scene.narration_editable)).toEqual([true, true, false, false]);
    expect(video.voice).toBeNull();
    expect(await pick(BRIGHT)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await setWords('hook', 'Warm light for late nights.')).toEqual({ ok: true, changed_videos: ['main'] });
    expect((await card()).narration_changes).toEqual([{ position: 1, scene: 'hook', text: 'Warm light for late nights.' }]);
  });

  it('takes the words a line went out with, such as ones the user kept, as said', async () => {
    deliver({ 'voice-hook': ['Bright light for late nights.', 'Bright light, all night.'] });

    await setWords('hook', 'Bright light, all night.');

    expect((await card()).narration_changes).toEqual([]);
  });

  it('keeps a voice picked for the video until its narration has it', async () => {
    expect(await pick(BRIGHT)).toEqual({ ok: true, changed_videos: ['main'] });
    expect((await card()).voice_wanted).toEqual({ route_ref: ROUTE, voice_ref: BRIGHT, name: 'Bright' });
    // Back to the voice it has, nothing is left to change.
    await pick(WARM);
    expect((await card()).voice_wanted).toBeNull();

    await pick(BRIGHT);
    voicedAgainIn(BRIGHT);

    const video = await card();
    expect(video.voice).toEqual({ route_ref: ROUTE, voice_ref: BRIGHT });
    expect(video.voice_wanted).toBeNull();
  });

  it('lets go of a pick once the voice changed some other way', async () => {
    await pick(BRIGHT);
    // Asked in the chat instead, the Agent voiced it as Calm.
    voicedAgainIn(CALM);

    expect((await card()).voice_wanted).toBeNull();
  });

  it('will not pick a voice the speech services do not offer, or while they cannot say', async () => {
    expect(await pick(`${ROUTE}:voice:nope`)).toMatchObject({ ok: false, code: 'not_found' });
    speech.fail = true;
    expect(await pick(BRIGHT)).toMatchObject({ ok: false });

    expect((await card()).voice_wanted).toBeNull();
  });

  it('keeps a pick when the canvas saves card positions', async () => {
    await pick(BRIGHT);

    await saveVideoCanvasLayout({ uid: UID, cid: CID, dir: 'ad', cards: { 'video:main': { x: 1, y: 2 } } });

    expect((await card()).voice_wanted).toEqual({ route_ref: ROUTE, voice_ref: BRIGHT, name: 'Bright' });
  });

  it('changes nothing while the Agent is working', async () => {
    expect(await setWords('hook', 'Warm light.', true)).toEqual({ ok: false, code: 'busy' });
    expect(await pick(BRIGHT, true)).toEqual({ ok: false, code: 'busy' });

    const video = await card();
    expect(video.narration_changes).toEqual([]);
    expect(video.voice_wanted).toBeNull();
  });

  it('lists the voices that speak the narration\'s language, and the one it has', async () => {
    expect(await readVideoCanvasVoices(UID, CID, 'ad', 'main')).toEqual({
      ok: true,
      current: { route_ref: ROUTE, voice_ref: WARM },
      voices: [
        { route_ref: ROUTE, route_name: 'Configured Voice', voice_ref: WARM, name: 'Warm' },
        { route_ref: ROUTE, route_name: 'Configured Voice', voice_ref: BRIGHT, name: 'Bright' },
        { route_ref: ROUTE, route_name: 'Configured Voice', voice_ref: CALM, name: 'Calm' },
      ],
    });
    speech.fail = true;
    expect(await readVideoCanvasVoices(UID, CID, 'ad', 'main')).toEqual({ ok: false, code: 'failed' });
  });
});

// Decided 2026-11-11: a scene taken out on the canvas can be put back as it was, from the "+" at
// the end of its video's scenes, and still after a restart. Each video keeps the last ten.
describe('putting back a scene taken out', () => {
  beforeEach(() => {
    writeLedger([{ id: 'photo', kind: 'image', label: 'Front photo.png', path: 'media/photo.png', origin: 'upload' }]);
    writeProduct();
    writeVideo('main', { scenes: [
      { id: 'hook', duration: 3, text: { title: { value: 'Bright lamp' } } },
      { id: 'body', clips: [{ id: 'body-clip', asset: 'photo', in: 0, dur: 4 }], text: { line: { value: 'Warm light' } }, narration: { text: 'It glows at night.' } },
      { id: 'price', duration: 2, text: { amount: { fact_id: 'price' } } },
    ] });
  });

  const removedOf = async (id = 'main') => (await read())[0].videos.find((video) => video.id === id)!.removed_scenes;
  const putBack = async (index = 0, id = 'main') => edit({ kind: 'restore_scene', video: id, removed: (await removedOf(id))[index].key });
  const ids = (id = 'main') => manifestOf(id).scenes.map((scene: { id: string }) => scene.id);

  it('puts a scene back as it was, where it was, and the video is then as it went out', async () => {
    const before = manifestOf();
    write('ad/versions.json', JSON.stringify({ versions: [version('v1', 'main', 'versions/main-v1.mp4')] }));
    expect(await videoUpToDate(path.join(workspace, 'ad'), 'main')).toBe(true);

    await edit({ kind: 'remove_scene', video: 'main', scene: 'body' });

    expect(await removedOf()).toEqual([{ key: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]*$/), position: 2, duration_sec: 4, words: 'Warm light' }]);
    expect(await putBack()).toEqual({ ok: true, changed_videos: ['main'] });
    expect(manifestOf()).toEqual(before);
    expect(await removedOf()).toEqual([]);
    // Update has nothing to render: the video already shows this.
    expect(await videoUpToDate(path.join(workspace, 'ad'), 'main')).toBe(true);
  });

  it('puts it back after the scene it followed, wherever that scene went', async () => {
    await edit({ kind: 'remove_scene', video: 'main', scene: 'body' });
    await edit({ kind: 'reorder', video: 'main', order: ['price', 'hook'] });

    await putBack();

    expect(ids()).toEqual(['price', 'hook', 'body']);
  });

  it('puts a first scene first, and one whose neighbour went too back where it stood', async () => {
    await edit({ kind: 'remove_scene', video: 'main', scene: 'body' });
    await edit({ kind: 'remove_scene', video: 'main', scene: 'hook' });
    expect((await removedOf()).map((item) => item.words)).toEqual(['Bright lamp', 'Warm light']);

    await putBack(1);
    expect(ids()).toEqual(['price', 'body']);
    await putBack(0);
    expect(ids()).toEqual(['hook', 'price', 'body']);
  });

  it('gives a scene new ids when a scene added since took them', async () => {
    writeVideo('main', { scenes: [
      { id: 'hook', duration: 3 },
      { id: 'photo', clips: [{ id: 'photo-clip', asset: 'photo', in: 0, dur: 2 }], text: { line: { value: 'Old words' } } },
    ] });
    await edit({ kind: 'remove_scene', video: 'main', scene: 'photo' });
    // The same picture added again takes the ids that were free.
    await edit({ kind: 'add_scene', video: 'main', asset: 'photo' });
    expect(ids()).toEqual(['hook', 'photo']);

    expect(await putBack()).toEqual({ ok: true, changed_videos: ['main'] });

    const scenes = manifestOf().scenes as Array<{ id: string; clips?: Array<{ id: string; asset: string }>; text?: Record<string, unknown> }>;
    expect(scenes).toHaveLength(3);
    expect(new Set(scenes.map((scene) => scene.id)).size).toBe(3);
    expect(new Set(scenes.flatMap((scene) => (scene.clips ?? []).map((clip) => clip.id))).size).toBe(2);
    expect(scenes[0].id).toBe('hook');
    expect(scenes[1]).toMatchObject({ text: { line: { value: 'Old words' } }, clips: [{ asset: 'photo', dur: 2 }] });
    expect(scenes[2].id).toBe('photo');
    expect(scenes[2].text).toBeUndefined();
  });

  it('does not offer a scene whose picture was removed since, and will not put it back', async () => {
    await edit({ kind: 'remove_scene', video: 'main', scene: 'body' });
    const [{ key }] = await removedOf();
    expect(await edit({ kind: 'remove_asset', asset: 'photo' })).toEqual({ ok: true, changed_videos: [] });

    expect(await removedOf()).toEqual([]);
    const before = fs.readFileSync(path.join(workspace, 'ad/videos/main/manifest.json'), 'utf8');
    expect(await edit({ kind: 'restore_scene', video: 'main', removed: key })).toMatchObject({ ok: false });
    expect(fs.readFileSync(path.join(workspace, 'ad/videos/main/manifest.json'), 'utf8')).toBe(before);
  });

  it('tells scenes apart by their first words, else their narration, cut short in a long sentence', async () => {
    writeVideo('main', { scenes: [
      { id: 'a', duration: 1, text: { empty: { value: ' ' }, title: { value: '一盏为深夜读书人准备的护眼台灯，暖光不刺眼，充电一次能用一整周' } } },
      { id: 'b', duration: 1, narration: { text: 'It glows at night.' } },
      { id: 'c', duration: 1 },
      { id: 'd', duration: 1 },
    ] });
    for (const scene of ['a', 'b', 'c']) await edit({ kind: 'remove_scene', video: 'main', scene });

    expect((await removedOf()).map((item) => item.words)).toEqual(['', 'It glows at night.', '一盏为深夜读书人准备的护眼台灯，暖光不刺眼，充电…']);
  });

  it('keeps the last ten a video took out, newest first', async () => {
    writeVideo('main', { scenes: Array.from({ length: 12 }, (_, n) => ({ id: `s${n + 1}`, duration: n + 1 })) });

    for (let n = 1; n <= 11; n += 1) await edit({ kind: 'remove_scene', video: 'main', scene: `s${n}` });

    expect((await removedOf()).map((item) => item.duration_sec)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it('keeps them when the canvas saves card positions or a new shot, and after a restart', async () => {
    await edit({ kind: 'remove_scene', video: 'main', scene: 'body' });

    await saveVideoCanvasLayout({ uid: UID, cid: CID, dir: 'ad', cards: { 'video:main': { x: 1, y: 2 } } });
    expect(await applyVideoCanvasDraftChange({ uid: UID, cid: CID, dir: 'ad', change: { kind: 'create', type: 'image', inputs: ['photo'], at: { x: 0, y: 0 } } })).toMatchObject({ ok: true });
    vi.resetModules();
    const restarted = await import('../../../src/main/features/video_canvas');

    const [production] = await restarted.readVideoCanvasProductions(UID, CID);
    expect(production.videos[0].removed_scenes.map((item) => item.words)).toEqual(['Warm light']);
  });

  it('keeps each video\'s own', async () => {
    writeVideo('other', { scenes: [{ id: 'a', duration: 1 }, { id: 'b', duration: 2 }] });
    await edit({ kind: 'remove_scene', video: 'other', scene: 'b' });

    expect(await removedOf('main')).toEqual([]);
    const [{ key }] = await removedOf('other');
    expect(await edit({ kind: 'restore_scene', video: 'main', removed: key })).toEqual({ ok: false, code: 'not_found' });
    expect(ids()).toEqual(['hook', 'body', 'price']);
    expect(await putBack(0, 'other')).toEqual({ ok: true, changed_videos: ['other'] });
    expect(ids('other')).toEqual(['a', 'b']);
  });

  it('retains the same undo entry when publishing the restored manifest fails', async () => {
    await edit({ kind: 'remove_scene', video: 'main', scene: 'body' });
    const removed = await removedOf(), [{ key }] = removed;
    const file = path.join(workspace, 'ad/videos/main/manifest.json');
    const before = fs.readFileSync(file);
    const rename = fs.promises.rename.bind(fs.promises);
    const failure = Object.assign(new Error('Controlled manifest publication failure'), { code: 'EIO' });
    const injected = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (path.resolve(String(destination)) === file) throw failure;
      return rename(source, destination);
    });
    syncBuiltinESMExports();
    try {
      await expect(edit({ kind: 'restore_scene', video: 'main', removed: key })).rejects.toBe(failure);
    } finally { injected.mockRestore(); syncBuiltinESMExports(); }
    expect(fs.readFileSync(file)).toEqual(before);
    expect(await removedOf()).toEqual(removed);
    expect(await edit({ kind: 'restore_scene', video: 'main', removed: key })).toEqual({ ok: true, changed_videos: ['main'] });
    expect(ids()).toEqual(['hook', 'body', 'price']);
    expect(await edit({ kind: 'restore_scene', video: 'main', removed: key })).toEqual({ ok: false, code: 'not_found' });
  });

  it('puts a scene back once', async () => {
    await edit({ kind: 'remove_scene', video: 'main', scene: 'body' });
    const [{ key }] = await removedOf();

    expect(await edit({ kind: 'restore_scene', video: 'main', removed: key })).toEqual({ ok: true, changed_videos: ['main'] });
    expect(await edit({ kind: 'restore_scene', video: 'main', removed: key })).toEqual({ ok: false, code: 'not_found' });
    expect(ids()).toEqual(['hook', 'body', 'price']);
  });

  it('changes nothing while the Agent is working', async () => {
    await edit({ kind: 'remove_scene', video: 'main', scene: 'body' });
    const [{ key }] = await removedOf();

    expect(await edit({ kind: 'restore_scene', video: 'main', removed: key }, true)).toEqual({ ok: false, code: 'busy' });

    expect(ids()).toEqual(['hook', 'price']);
    expect(await removedOf()).toHaveLength(1);
  });

  it('puts back a scene an old page draws, under its own id', async () => {
    writeVideo('main', {
      scenes: [{ id: 'intro', duration: 2 }, { id: 'outro', duration: 3 }],
      absolute_page: { scene_starts: { intro: 0, outro: 2 } },
    });
    write('ad/videos/main/index.html', '<main><section data-scene-id="intro"></section><section data-scene-id="outro"></section></main>');
    await edit({ kind: 'remove_scene', video: 'main', scene: 'outro' });

    expect(await putBack()).toEqual({ ok: true, changed_videos: ['main'] });

    expect(ids()).toEqual(['intro', 'outro']);
    expect(manifestOf().absolute_page).toEqual({ scene_starts: { intro: 0, outro: 2 } });
  });
});

// Decided 2026-11-11: no card says a video is behind; pressing Update asks it, and renders only a
// video that is.
describe('knowing at an Update whether a video is behind its timeline', () => {
  beforeEach(() => {
    writeProduct();
    writeVideo('main');
    // Each video went out once, so only a change since makes it behind.
    write('ad/versions.json', JSON.stringify({ versions: ['main', 'plain'].map((id) => version(`${id}-v1`, id, `versions/${id}-v1.mp4`)) }));
  });

  const behind = async (id = 'main') => !await videoUpToDate(path.join(workspace, 'ad'), id);
  const needsUpdate = () => behind();

  it('counts a video with no version yet as behind', async () => {
    write('ad/versions.json', JSON.stringify({ versions: [version('plain-v1', 'plain', 'versions/plain-v1.mp4')] }));
    expect(await needsUpdate()).toBe(true);
  });

  it('does not flag a video nobody has changed, such as an upgraded one', async () => {
    expect(await needsUpdate()).toBe(false);
  });

  it('flags it after a change, even if no render has ever been recorded', async () => {
    await edit({ kind: 'remove_scene', video: 'main', scene: 'hook' });
    expect(await needsUpdate()).toBe(true);
  });

  it('flags it when a fact it quotes changes', async () => {
    await edit({ kind: 'set_fact', fact: 'price', text: '$19' });
    expect(await needsUpdate()).toBe(true);
  });

  it('flags a render that never reached delivery, whatever happened after it', async () => {
    await edit({ kind: 'remove_scene', video: 'main', scene: 'hook' });
    // The app quit, or the delivery check refused it, right after the render finished.
    const record = readJson('ad/videos/main/.last-render.json');
    write('ad/videos/main/.last-render.json', JSON.stringify({ ...record, output: 'render/main.mp4', source_sha256: 'current' }));
    expect(await needsUpdate()).toBe(true);
  });

  it('stops flagging once the timeline is delivered', async () => {
    await edit({ kind: 'remove_scene', video: 'main', scene: 'hook' });
    const { markTimelineDelivered } = await import('../../../src/main/features/video_timeline_render');
    await markTimelineDelivered({ productionDirAbs: path.join(workspace, 'ad'), videoDirAbs: path.join(workspace, 'ad/videos/main') });
    expect(await needsUpdate()).toBe(false);
    await edit({ kind: 'remove_scene', video: 'main', scene: 'body' });
    expect(await needsUpdate()).toBe(true);
  });

  const deliver = async (id: string) => {
    const { markTimelineDelivered } = await import('../../../src/main/features/video_timeline_render');
    await markTimelineDelivered({ productionDirAbs: path.join(workspace, 'ad'), videoDirAbs: path.join(workspace, 'ad/videos', id) });
  };
  const flags = async () => Object.fromEntries(await Promise.all((await read())[0].videos.map(async (video) => [video.id, await behind(video.id)])));

  // On 2026-11-09 a price change flagged a video that does not show the price: every video
  // counted the whole product.json, so the flag could not say which videos to update.
  it('flags only the videos that quote the fact that changed', async () => {
    writeVideo('plain', { scenes: [{ id: 'one', duration: 2 }] });
    await deliver('main');
    await deliver('plain');

    await edit({ kind: 'set_fact', fact: 'price', text: '$19' });

    expect(await flags()).toEqual({ main: true, plain: false });
  });

  it('does not flag a video for facts it does not quote', async () => {
    writeProduct([
      { id: 'price', text: '$29', source: 'page' },
      { id: 'wireless', text: 'Wireless base', source: 'page' },
    ]);
    await deliver('main');

    await edit({ kind: 'set_fact', fact: 'wireless', text: 'Wireless charging base' });
    expect(await needsUpdate()).toBe(false);
    // As the Agent does while it works: a claim noted, the file written whole.
    writeProduct([
      { id: 'price', text: '$29', source: 'page' },
      { id: 'wireless', text: 'Wireless charging base', source: 'page' },
      { id: 'warranty', text: 'Two-year warranty', source: 'unverified' },
    ]);
    expect(await needsUpdate()).toBe(false);
  });

  const changesOf = async () => Object.fromEntries((await read())[0].videos.map((video) => [video.id, video.product_changes]));

  // Decided 2026-11-09: the Agent applies a product change when the user updates a video, so every
  // video made from the product says what changed since it went out, whatever words it shows.
  it('says what product info changed since each video went out, quoting it or not', async () => {
    writeProduct([
      { id: 'price', text: '$29', source: 'page' },
      { id: 'base', text: 'Wireless base', source: 'page' },
    ]);
    writeVideo('plain', { scenes: [{ id: 'one', duration: 2 }] });
    await deliver('main');
    await deliver('plain');
    expect(await changesOf()).toEqual({ main: [], plain: [] });

    await edit({ kind: 'set_fact', fact: 'base', text: 'Wireless charging base' });

    const changed = [{ before: 'Wireless base', after: 'Wireless charging base' }];
    expect(await changesOf()).toEqual({ main: changed, plain: changed });
    await deliver('plain');
    expect(await changesOf()).toEqual({ main: changed, plain: [] });
  });

  it('leaves out a fact noted after the video went out', async () => {
    await deliver('main');
    writeProduct([
      { id: 'price', text: '$29', source: 'page' },
      { id: 'warranty', text: 'Two-year warranty', source: 'unverified' },
    ]);
    expect((await changesOf()).main).toEqual([]);
  });

  it('lists the first change to a video that went out before deliveries kept the product info', async () => {
    await deliver('main');
    const record = readJson('ad/videos/main/.last-render.json');
    delete record.delivered_facts;
    write('ad/videos/main/.last-render.json', JSON.stringify(record));
    expect((await changesOf()).main).toEqual([]);

    await edit({ kind: 'set_fact', fact: 'price', text: '$19' });

    expect((await changesOf()).main).toEqual([{ before: '$29', after: '$19' }]);
  });

  // Decided 2026-11-11: Update renders nothing when nothing in the video changed, and the canvas
  // writes the file its own way.
  it('reads what the scenes say, not how their file is laid out', async () => {
    await deliver('main');
    const manifest = readJson('ad/videos/main/manifest.json');
    const { scenes, ...rest } = manifest;
    // As an Agent may write the same video: its own order, spacing and numbers.
    write('ad/videos/main/manifest.json', `${JSON.stringify({ scenes, ...rest }, null, 4).replace('"duration": 3,', '"duration": 3.0,')}\n`);
    expect(await needsUpdate()).toBe(false);

    write('ad/videos/main/manifest.json', JSON.stringify({ ...manifest, scenes: [{ ...scenes[0], duration: 3.5 }, ...scenes.slice(1)] }));
    expect(await needsUpdate()).toBe(true);
  });
});

describe('adding a scene', () => {
  beforeEach(() => {
    writeLedger([
      { id: 'photo', kind: 'image', label: 'Photo', path: 'media/photo.png', origin: 'upload' },
      { id: 'voice', kind: 'audio', label: 'Voice', path: 'media/voice.mp3', origin: 'upload' },
    ]);
    writeProduct();
    writeVideo('main');
  });

  it('adds a still for a few seconds at the end', async () => {
    expect(await edit({ kind: 'add_scene', video: 'main', asset: 'photo' })).toEqual({ ok: true, changed_videos: ['main'] });

    const scene = manifestOf().scenes.at(-1);
    expect(scene.id).toBe('photo');
    expect(scene.clips).toEqual([{ id: 'photo-clip', asset: 'photo', in: 0, dur: 3 }]);
    expect(scene.duration).toBeUndefined();
  });

  it('puts it after the scene asked for, under an id of its own', async () => {
    await edit({ kind: 'add_scene', video: 'main', asset: 'photo', after: 'hook' });
    await edit({ kind: 'add_scene', video: 'main', asset: 'photo', after: 'hook' });

    expect(manifestOf().scenes.map((scene: { id: string }) => scene.id)).toEqual(['hook', 'photo-2', 'photo', 'body', 'price']);
  });

  it('takes a short clip whole, and only the start of a long one', async () => {
    writeClip('ad/media/short.mp4', 2);
    writeClip('ad/media/long.mp4', 16);
    write('ad/assets.json', JSON.stringify({ assets: [
      { id: 'short', kind: 'video', label: 'Short', path: 'media/short.mp4', origin: 'upload' },
      { id: 'long', kind: 'video', label: 'Long', path: 'media/long.mp4', origin: 'upload' },
    ] }));

    const short = await edit({ kind: 'add_scene', video: 'main', asset: 'short' });
    const long = await edit({ kind: 'add_scene', video: 'main', asset: 'long' });

    expect(short).toEqual({ ok: true, changed_videos: ['main'] });
    expect(long).toEqual({ ok: true, changed_videos: ['main'], trimmed_to_sec: 15 });
    const scenes = manifestOf().scenes;
    expect(scenes.at(-2).clips[0].dur).toBeCloseTo(2, 1);
    expect(scenes.at(-1).clips[0].dur).toBe(15);
  });

  it('will not make a scene from sound, or from something the ledger does not have', async () => {
    expect(await edit({ kind: 'add_scene', video: 'main', asset: 'voice' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await edit({ kind: 'add_scene', video: 'main', asset: 'nope' })).toEqual({ ok: false, code: 'not_found' });
  });

  it('refuses a video past what a page render takes', async () => {
    writeVideo('main', { scenes: [{ id: 'long', duration: 599 }] });
    expect(await edit({ kind: 'add_scene', video: 'main', asset: 'photo' })).toMatchObject({ ok: false, code: 'too_long' });
  });
});

describe('changing a scene\'s picture', () => {
  beforeEach(() => {
    writeLedger([
      { id: 'a', kind: 'image', label: 'A', path: 'media/a.png', origin: 'upload' },
      { id: 'b', kind: 'image', label: 'B', path: 'media/b.png', origin: 'upload' },
    ]);
  });

  it('keeps the clip the page knows, so only the picture changes', async () => {
    writeVideo('main', { scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'a', in: 2, dur: 4 }] }] });

    expect(await edit({ kind: 'swap_clip', video: 'main', scene: 'one', asset: 'b' })).toEqual({ ok: true, changed_videos: ['main'] });

    expect(manifestOf().scenes[0].clips).toEqual([{ id: 'c1', asset: 'b', in: 0, dur: 4 }]);
  });

  it('gives a scene of words a picture behind them, at the same length', async () => {
    writeVideo('main', { scenes: [{ id: 'one', duration: 5, text: { title: { value: 'Hi' } } }] });

    expect(await edit({ kind: 'swap_clip', video: 'main', scene: 'one', asset: 'b' })).toEqual({ ok: true, changed_videos: ['main'] });

    const [scene] = manifestOf().scenes;
    expect(scene.clips).toEqual([{ id: 'one-clip', asset: 'b', in: 0, dur: 5 }]);
    expect(scene.duration).toBeUndefined();
    expect(scene.text).toEqual({ title: { value: 'Hi' } });
  });

  it('shortens the scene for a shorter clip', async () => {
    writeClip('ad/media/short.mp4', 2);
    write('ad/assets.json', JSON.stringify({ assets: [
      { id: 'a', kind: 'image', label: 'A', path: 'media/a.png', origin: 'upload' },
      { id: 'short', kind: 'video', label: 'Short', path: 'media/short.mp4', origin: 'upload' },
    ] }));
    writeVideo('main', { scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'a', in: 0, dur: 6 }] }] });

    expect(await edit({ kind: 'swap_clip', video: 'main', scene: 'one', asset: 'short' })).toMatchObject({ ok: true });

    expect(manifestOf().scenes[0].clips[0].dur).toBeCloseTo(2, 1);
  });

  it('refuses a clip too short for the scene\'s narration', async () => {
    writeClip('ad/media/short.mp4', 2);
    writeSound('ad/media/voice.mp3', 4);
    write('ad/assets.json', JSON.stringify({ assets: [
      { id: 'a', kind: 'image', label: 'A', path: 'media/a.png', origin: 'upload' },
      { id: 'short', kind: 'video', label: 'Short', path: 'media/short.mp4', origin: 'upload' },
      { id: 'voice', kind: 'audio', label: 'Voice', path: 'media/voice.mp3', origin: 'generated' },
    ] }));
    writeVideo('main', { scenes: [{
      id: 'one',
      clips: [{ id: 'c1', asset: 'a', in: 0, dur: 5 }],
      narration: { text: 'Hello', asset: 'voice' },
    }] });

    const result = await edit({ kind: 'swap_clip', video: 'main', scene: 'one', asset: 'short' });

    expect(result).toMatchObject({ ok: false, code: 'too_short' });
    expect(manifestOf().scenes[0].clips[0].asset).toBe('a');
  });

  it('leaves alone a scene an old page draws itself', async () => {
    writeVideo('main', {
      upgraded_from: 'old',
      absolute_page: { scene_starts: { one: 0 } },
      scenes: [{ id: 'one', duration: 3 }],
    });

    expect(await edit({ kind: 'swap_clip', video: 'main', scene: 'one', asset: 'b' })).toEqual({ ok: false, code: 'page_scene' });
    expect(manifestOf().scenes[0].clips).toBeUndefined();
  });

  it('still swaps a picture an old page already shows', async () => {
    writeVideo('main', {
      upgraded_from: 'old',
      absolute_page: { scene_starts: { one: 0 } },
      scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'a', in: 0, dur: 3 }] }],
    });

    expect(await edit({ kind: 'swap_clip', video: 'main', scene: 'one', asset: 'b' })).toMatchObject({ ok: true });
    expect(manifestOf().scenes[0].clips[0]).toEqual({ id: 'c1', asset: 'b', in: 0, dur: 3 });
  });

  it('refuses a file it cannot measure', async () => {
    write('ad/media/broken.mp4', 'not a video');
    write('ad/assets.json', JSON.stringify({ assets: [
      { id: 'a', kind: 'image', label: 'A', path: 'media/a.png', origin: 'upload' },
      { id: 'broken', kind: 'video', label: 'Broken', path: 'media/broken.mp4', origin: 'upload' },
    ] }));
    writeVideo('main', { scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'a', in: 0, dur: 3 }] }] });

    expect(await edit({ kind: 'swap_clip', video: 'main', scene: 'one', asset: 'broken' })).toEqual({ ok: false, code: 'unreadable' });
  });
});

describe('what a changed picture does to sound and scene ids', () => {
  function keptSoundVideo(): void {
    writeLedger([
      { id: 'still', kind: 'image', label: 'Still', path: 'media/still.png', origin: 'upload' },
      { id: 'other', kind: 'image', label: 'Other', path: 'media/other.png', origin: 'upload' },
    ]);
    writeVideo('main', { scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'other', in: 0, dur: 2, audio: 'keep', volume: 0.5 }] }] });
  }

  it('stops keeping sound when the new picture has none, because the mix would always fail', async () => {
    keptSoundVideo();
    expect(await edit({ kind: 'swap_clip', video: 'main', scene: 'one', asset: 'still' })).toMatchObject({ ok: true });
    expect(manifestOf().scenes[0].clips[0]).toEqual({ id: 'c1', asset: 'still', in: 0, dur: 2 });
  });

  it('does the same for a silent clip, and when replacing across videos', async () => {
    writeClip('ad/media/silent.mp4', 3);
    write('ad/assets.json', JSON.stringify({ assets: [
      { id: 'other', kind: 'image', label: 'Other', path: 'media/other.png', origin: 'upload' },
      { id: 'silent', kind: 'video', label: 'Silent', path: 'media/silent.mp4', origin: 'upload' },
    ] }));
    write('ad/media/other.png');
    writeVideo('main', { scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'other', in: 0, dur: 2, audio: 'keep' }] }] });

    expect(await edit({ kind: 'replace_asset', asset: 'other', with: 'silent' })).toMatchObject({ ok: true });

    expect(manifestOf().scenes[0].clips[0].audio).toBeUndefined();
  });

  it('keeps sound when the new clip has its own', async () => {
    const { ffmpeg } = bundledFfmpegPaths();
    const file = path.join(workspace, 'ad/media/loud.mp4');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    execFileSync(ffmpeg as string, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-pix_fmt', 'yuv420p', '-shortest', file,
    ]);
    write('ad/assets.json', JSON.stringify({ assets: [
      { id: 'other', kind: 'image', label: 'Other', path: 'media/other.png', origin: 'upload' },
      { id: 'loud', kind: 'video', label: 'Loud', path: 'media/loud.mp4', origin: 'upload' },
    ] }));
    write('ad/media/other.png');
    writeVideo('main', { scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'other', in: 0, dur: 2, audio: 'keep', volume: 0.5 }] }] });

    expect(await edit({ kind: 'swap_clip', video: 'main', scene: 'one', asset: 'loud' })).toMatchObject({ ok: true });

    expect(manifestOf().scenes[0].clips[0]).toMatchObject({ asset: 'loud', audio: 'keep', volume: 0.5 });
  });

  it('never gives a new scene the id of one still sitting in the page', async () => {
    writeLedger([{ id: 'hook', kind: 'image', label: 'Hook', path: 'media/hook.png', origin: 'upload' }]);
    writeVideo('main', { scenes: [{ id: 'other', duration: 2 }] });
    write('ad/videos/main/index.html', '<!doctype html><main data-composition-id="main"><section data-scene-id="other"></section><section data-scene-id="hook"><h1 data-slot="line">x</h1></section></main>');

    expect(await edit({ kind: 'add_scene', video: 'main', asset: 'hook' })).toMatchObject({ ok: true });

    expect(manifestOf().scenes.at(-1).id).toBe('hook-2');
  });

  it('refuses to swap a scene that changed since a redo was asked for', async () => {
    writeLedger([
      { id: 'a', kind: 'image', label: 'A', path: 'media/a.png', origin: 'upload' },
      { id: 'b', kind: 'image', label: 'B', path: 'media/b.png', origin: 'upload' },
      { id: 'c', kind: 'image', label: 'C', path: 'media/c.png', origin: 'upload' },
    ]);
    writeVideo('main', { scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'b', in: 0, dur: 2 }] }] });

    expect(await edit({ kind: 'swap_clip', video: 'main', scene: 'one', asset: 'c', if_current: 'a' })).toEqual({ ok: false, code: 'changed' });
    expect(manifestOf().scenes[0].clips[0].asset).toBe('b');
    expect(await edit({ kind: 'swap_clip', video: 'main', scene: 'one', asset: 'c', if_current: 'b' })).toMatchObject({ ok: true });
  });
});

describe('changing facts', () => {
  beforeEach(() => {
    writeProduct([
      { id: 'price', text: '$29', source: 'page' },
      { id: 'claim', text: 'Best in class', source: 'unverified' },
    ]);
    writeVideo('main');
    writeVideo('other', { scenes: [{ id: 'one', duration: 2 }] });
  });

  // Decided on 2026-11-09: the product is what the Agent writes a video from, so a change to any
  // fact leaves every video behind until the user updates it, and an update in progress stops.
  it('changes the fact, and names every video, quoting it or not', async () => {
    const price = await edit({ kind: 'set_fact', fact: 'price', text: '$19' }) as { ok: true; changed_videos: string[] };
    expect(price.ok).toBe(true);
    expect([...price.changed_videos].sort()).toEqual(['main', 'other']);
    const claim = await edit({ kind: 'set_fact', fact: 'claim', text: 'Bright' }) as { ok: true; changed_videos: string[] };
    expect([...claim.changed_videos].sort()).toEqual(['main', 'other']);

    const [production] = await read();
    expect(production.videos.find((video) => video.id === 'main')?.scenes[2].texts[0].value).toBe('$19');
    expect(readJson('ad/product.json').facts[0]).toEqual({ id: 'price', text: '$19', source: 'user' });
  });

  it('refuses an empty fact', async () => {
    expect(await edit({ kind: 'set_fact', fact: 'price', text: '  ' })).toEqual({ ok: false, code: 'invalid' });
  });

  it('no longer confirms or removes a fact, and leaves the file as it was', async () => {
    const before = fs.readFileSync(path.join(workspace, 'ad/product.json'), 'utf8');
    for (const kind of ['confirm_fact', 'remove_fact']) {
      expect(await edit({ kind, fact: 'claim' } as unknown as VideoCanvasEdit)).toEqual({ ok: false, code: 'invalid' });
    }
    expect(fs.readFileSync(path.join(workspace, 'ad/product.json'), 'utf8')).toBe(before);
  });

  it('refuses a fact that is not there', async () => {
    expect(await edit({ kind: 'set_fact', fact: 'nope', text: 'x' })).toEqual({ ok: false, code: 'not_found' });
  });

  it('keeps what it does not understand in the file', async () => {
    write('ad/product.json', JSON.stringify({
      name: 'Desk lamp',
      brand_note: 'from the Agent',
      facts: [{ id: 'price', text: '$29', source: 'page', evidence: 'https://shop.example/lamp' }],
      images: [],
    }));

    await edit({ kind: 'set_fact', fact: 'price', text: '$19' });

    expect(readJson('ad/product.json')).toEqual({
      name: 'Desk lamp',
      brand_note: 'from the Agent',
      facts: [{ id: 'price', text: '$19', source: 'user', evidence: 'https://shop.example/lamp' }],
      images: [],
    });
  });
});

describe('using another take of a shot', () => {
  // A take made again, or an older one the user prefers, goes wherever the shot was shown, and
  // those videos wait for the user's Update instead of rendering (decided 2026-11-09).
  beforeEach(() => {
    writeLedger([
      { id: 'a', kind: 'image', label: 'A', path: 'media/a.png', origin: 'upload' },
      { id: 'take-1', kind: 'image', label: 'Shot', path: 'gen/take-1.png', origin: 'generated', shot: 'shot' },
      { id: 'take-2', kind: 'image', label: 'Shot', path: 'gen/take-2.png', origin: 'generated', shot: 'shot' },
      { id: 'take-3', kind: 'image', label: 'Shot', path: 'gen/take-3.png', origin: 'generated', shot: 'shot' },
      { id: 'other', kind: 'image', label: 'Other', path: 'gen/other.png', origin: 'generated', shot: 'other' },
    ]);
    writeVideo('one', { scenes: [
      { id: 's', clips: [{ id: 'c1', asset: 'take-1', in: 0, dur: 3 }] },
      { id: 't', clips: [{ id: 'c2', asset: 'other', in: 0, dur: 3 }] },
    ] });
    writeVideo('two', { scenes: [
      { id: 's', clips: [{ id: 'c3', asset: 'take-2', in: 0, dur: 3 }] },
      { id: 't', clips: [{ id: 'c4', asset: 'a', in: 0, dur: 3 }] },
    ] });
  });

  const picturesOf = (id: string) => manifestOf(id).scenes
    .map((scene: { clips: Array<{ id: string; asset: string }> }) => scene.clips.map((clip) => `${clip.id}:${clip.asset}`));

  it('shows it wherever the shot is shown, renders nothing, and leaves those videos to be updated', async () => {
    write('ad/versions.json', JSON.stringify({ versions: [version('v1', 'one', 'versions/one-v1.mp4'), version('v2', 'two', 'versions/two-v1.mp4')] }));
    const upToDate = () => Promise.all(['one', 'two'].map((id) => videoUpToDate(path.join(workspace, 'ad'), id)));
    expect(await upToDate()).toEqual([true, true]);

    expect(await edit({ kind: 'use_result', asset: 'take-3' })).toEqual({ ok: true, changed_videos: ['one', 'two'] });

    expect(picturesOf('one')).toEqual([['c1:take-3'], ['c2:other']]);
    expect(picturesOf('two')).toEqual([['c3:take-3'], ['c4:a']]);
    expect(await upToDate()).toEqual([false, false]);
    // Every take stays on the ledger: each was paid for.
    expect(readJson('ad/assets.json').assets.map((row: { id: string }) => row.id)).toEqual(['a', 'take-1', 'take-2', 'take-3', 'other']);

    // Back to the take a video went out with, it is as it went out, and Update renders nothing
    // for it (2026-11-11); the other video now shows a take it did not go out with.
    expect(await edit({ kind: 'use_result', asset: 'take-1' })).toEqual({ ok: true, changed_videos: ['one', 'two'] });
    expect(await upToDate()).toEqual([true, false]);
  });

  it('changes nothing when no video shows the shot, or every one already shows this take', async () => {
    writeVideo('one', { scenes: [{ id: 's', clips: [{ id: 'c1', asset: 'a', in: 0, dur: 3 }] }] });
    writeVideo('two', { scenes: [{ id: 's', clips: [{ id: 'c3', asset: 'take-3', in: 0, dur: 3 }] }] });
    const before = [manifestOf('one'), manifestOf('two')];

    expect(await edit({ kind: 'use_result', asset: 'take-3' })).toEqual({ ok: true, changed_videos: [] });
    expect([manifestOf('one'), manifestOf('two')]).toEqual(before);
  });

  it('refuses footage the user brought, and a take that is not on the ledger', async () => {
    expect(await edit({ kind: 'use_result', asset: 'a' })).toEqual({ ok: false, code: 'not_found' });
    expect(await edit({ kind: 'use_result', asset: 'nope' })).toEqual({ ok: false, code: 'not_found' });
    expect(picturesOf('one')).toEqual([['c1:take-1'], ['c2:other']]);
  });

  it('changes nothing unless every video can show it', async () => {
    writeClip('ad/gen/short.mp4', 1);
    writeSound('ad/media/voice.mp3', 4);
    write('ad/assets.json', JSON.stringify({ assets: [
      ...readJson('ad/assets.json').assets,
      { id: 'take-short', kind: 'video', label: 'Shot', path: 'gen/short.mp4', origin: 'generated', shot: 'shot' },
      { id: 'voice', kind: 'audio', label: 'Voice', path: 'media/voice.mp3', origin: 'generated' },
    ] }));
    writeVideo('two', { scenes: [{ id: 's', clips: [{ id: 'c3', asset: 'take-2', in: 0, dur: 5 }], narration: { text: 'Hello', asset: 'voice' } }] });

    expect(await edit({ kind: 'use_result', asset: 'take-short' })).toMatchObject({ ok: false, code: 'too_short' });
    expect(picturesOf('one')).toEqual([['c1:take-1'], ['c2:other']]);
    expect(picturesOf('two')).toEqual([['c3:take-2']]);
  });
});

describe('removing and replacing assets', () => {
  beforeEach(() => {
    writeLedger([
      { id: 'a', kind: 'image', label: 'A', path: 'media/a.png', origin: 'upload' },
      { id: 'b', kind: 'image', label: 'B', path: 'media/b.png', origin: 'upload' },
      { id: 'free', kind: 'image', label: 'Free', path: 'media/free.png', origin: 'upload' },
      { id: 'music', kind: 'audio', label: 'Music', path: 'media/music.mp3', origin: 'upload' },
      { id: 'shot-1', kind: 'image', label: 'Shot', path: 'gen/shot-1.png', origin: 'generated', shot: 'shot' },
      { id: 'shot-2', kind: 'image', label: 'Shot', path: 'gen/shot-2.png', origin: 'generated', shot: 'shot' },
    ]);
    writeVideo('one', {
      scenes: [{ id: 's', clips: [{ id: 'c1', asset: 'a', in: 0, dur: 3 }] }],
      tracks: [{ kind: 'music', asset: 'music', volume: 0.3 }],
    });
    writeVideo('two', { scenes: [
      { id: 's', clips: [{ id: 'c2', asset: 'a', in: 0, dur: 3 }] },
      { id: 't', clips: [{ id: 'c3', asset: 'shot-1', in: 0, dur: 3 }] },
    ] });
  });

  const ledger = () => readJson('ad/assets.json').assets.map((row: { id: string }) => row.id);

  it('removes the row of an unused asset and keeps its file', async () => {
    expect(await edit({ kind: 'remove_asset', asset: 'free' })).toEqual({ ok: true, changed_videos: [] });
    expect(ledger()).not.toContain('free');
    expect(fs.existsSync(path.join(workspace, 'ad/media/free.png'))).toBe(true);
  });

  it.each([
    ['a scene shows it', 'a'],
    ['it plays under a video', 'music'],
    ['a generated result is in a scene', 'shot-1'],
  ])('refuses to remove an asset when %s', async (_label, asset) => {
    expect(await edit({ kind: 'remove_asset', asset })).toEqual({ ok: false, code: 'in_use' });
    expect(ledger()).toContain(asset);
  });

  it('replaces a picture in every video that uses it, and drops the old upload', async () => {
    expect(await edit({ kind: 'replace_asset', asset: 'a', with: 'b' })).toEqual({ ok: true, changed_videos: ['one', 'two'] });

    expect(manifestOf('one').scenes[0].clips[0].asset).toBe('b');
    expect(manifestOf('two').scenes[0].clips[0].asset).toBe('b');
    expect(ledger()).not.toContain('a');
    expect(fs.existsSync(path.join(workspace, 'ad/media/a.png'))).toBe(true);
  });

  it('keeps a replaced generated result in its shot\'s history, because it was paid for', async () => {
    expect(await edit({ kind: 'replace_asset', asset: 'shot-1', with: 'b' })).toEqual({ ok: true, changed_videos: ['two'] });

    expect(manifestOf('two').scenes[1].clips[0].asset).toBe('b');
    expect(ledger()).toContain('shot-1');
  });

  it('changes nothing unless every video can take the replacement', async () => {
    writeClip('ad/media/short.mp4', 1);
    writeSound('ad/media/voice.mp3', 4);
    const rows = readJson('ad/assets.json').assets;
    write('ad/assets.json', JSON.stringify({ assets: [
      ...rows,
      { id: 'short', kind: 'video', label: 'Short', path: 'media/short.mp4', origin: 'upload' },
      { id: 'voice', kind: 'audio', label: 'Voice', path: 'media/voice.mp3', origin: 'generated' },
    ] }));
    writeVideo('two', { scenes: [{
      id: 's',
      clips: [{ id: 'c2', asset: 'a', in: 0, dur: 5 }],
      narration: { text: 'Hello', asset: 'voice' },
    }] });

    const result = await edit({ kind: 'replace_asset', asset: 'a', with: 'short' });

    expect(result).toMatchObject({ ok: false, code: 'too_short' });
    expect(manifestOf('one').scenes[0].clips[0].asset).toBe('a');
    expect(manifestOf('two').scenes[0].clips[0].asset).toBe('a');
    expect(ledger()).toContain('a');
  });

  it('keeps what it does not understand in the other rows', async () => {
    const rows = readJson('ad/assets.json').assets.map((row: Record<string, unknown>) => (
      row.id === 'b' ? { ...row, note_from_agent: 'hero shot' } : row
    ));
    write('ad/assets.json', JSON.stringify({ assets: rows }));

    await edit({ kind: 'remove_asset', asset: 'free' });

    expect(readJson('ad/assets.json').assets.find((row: { id: string }) => row.id === 'b').note_from_agent).toBe('hero shot');
  });

  it('leaves an unreadable ledger as it is', async () => {
    write('ad/assets.json', '{not json');
    expect(await edit({ kind: 'remove_asset', asset: 'free' })).toEqual({ ok: false, code: 'unreadable' });
    expect(fs.readFileSync(path.join(workspace, 'ad/assets.json'), 'utf8')).toBe('{not json');
  });
});

describe('pictures a video\'s page places by file', () => {
  // On 2026-11-07 a launch video showed two site screenshots in a scene through <img src>
  // instead of clips. The video still shows them, so they are used like any clip's picture.
  beforeEach(() => {
    writeLedger([
      { id: 'photo', kind: 'image', label: 'Photo', path: 'media/photo.png', origin: 'upload' },
      { id: 'site', kind: 'image', label: 'Site', path: 'videos/main/assets/site.png', origin: 'page' },
      { id: 'logo', kind: 'image', label: 'Logo', path: 'videos/main/assets/logo.png', origin: 'upload' },
      { id: 'old', kind: 'image', label: 'Old', path: 'videos/main/assets/old.png', origin: 'upload' },
      { id: 'spare', kind: 'image', label: 'Spare', path: 'media/spare.png', origin: 'upload' },
    ]);
    writeVideo('main', { scenes: [
      { id: 'hook', clips: [{ id: 'c1', asset: 'photo', in: 0, dur: 2 }] },
      { id: 'memory', duration: 2 },
    ] });
    // The logo shows around every scene; "cut" was taken off the timeline and shows nothing.
    write('ad/videos/main/index.html', '<main data-composition-id="main"><img class="logo" src="assets/logo.png">'
      + '<section data-scene-id="memory"><img src="assets/site.png"></section>'
      + '<section data-scene-id="cut"><img src="./assets/old.png"></section></main>');
  });

  const ledger = () => readJson('ad/assets.json').assets.map((row: { id: string }) => row.id);

  it('draws a line from what the page shows, and none from a scene off the timeline', async () => {
    const [video] = (await read())[0].videos;
    expect([...video.uses].sort()).toEqual(['asset:logo', 'asset:photo', 'asset:site']);
    expect([...video.placed_by_page].sort()).toEqual(['logo', 'site']);
  });

  it('keeps a picture the page shows, and lets one go that only a scene off the timeline held', async () => {
    expect(await edit({ kind: 'remove_asset', asset: 'site' })).toEqual({ ok: false, code: 'in_use' });
    expect(await edit({ kind: 'remove_asset', asset: 'logo' })).toEqual({ ok: false, code: 'in_use' });
    expect(ledger()).toEqual(expect.arrayContaining(['site', 'logo']));

    expect(await edit({ kind: 'remove_asset', asset: 'old' })).toEqual({ ok: true, changed_videos: [] });
    expect(ledger()).not.toContain('old');
  });

  it('will not swap a picture the page shows, and changes nothing', async () => {
    const before = ['ad/videos/main/manifest.json', 'ad/videos/main/index.html', 'ad/assets.json']
      .map((file) => fs.readFileSync(path.join(workspace, file), 'utf8'));

    expect(await edit({ kind: 'replace_asset', asset: 'site', with: 'spare' })).toEqual({ ok: false, code: 'page_picture' });

    expect(['ad/videos/main/manifest.json', 'ad/videos/main/index.html', 'ad/assets.json']
      .map((file) => fs.readFileSync(path.join(workspace, file), 'utf8'))).toEqual(before);
  });

  it('will not put another take of a shot where the page shows one by file, and changes nothing', async () => {
    writeLedger([
      { id: 'photo', kind: 'image', label: 'Photo', path: 'media/photo.png', origin: 'upload' },
      { id: 'hero-1', kind: 'image', label: 'Hero', path: 'videos/main/assets/hero-1.png', origin: 'generated', shot: 'hero' },
      { id: 'hero-2', kind: 'image', label: 'Hero', path: 'gen/hero-2.png', origin: 'generated', shot: 'hero' },
    ]);
    write('ad/videos/main/index.html', '<main data-composition-id="main"><section data-scene-id="memory"><img src="assets/hero-1.png"></section></main>');
    const files = ['ad/videos/main/manifest.json', 'ad/videos/main/index.html', 'ad/assets.json'];
    const before = files.map((file) => fs.readFileSync(path.join(workspace, file), 'utf8'));

    expect(await edit({ kind: 'use_result', asset: 'hero-2' })).toEqual({ ok: false, code: 'page_picture' });

    expect(files.map((file) => fs.readFileSync(path.join(workspace, file), 'utf8'))).toEqual(before);
  });
});

describe('dropping files on the canvas', () => {
  const drop = (paths: Array<[string, string]>, busy = false) => importVideoCanvasFiles({
    uid: UID,
    cid: CID,
    dir: 'ad',
    busy,
    entries: paths.map(([file, name]) => ({ path: file, name })),
  });

  beforeEach(() => writeVideo('main'));

  function outside(name: string, content = 'bytes'): string {
    const file = path.join(root, 'downloads', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  it('copies them into the production and adds them to its ledger', async () => {
    const result = await drop([[outside('box.png'), 'box.png'], [outside('song.mp3'), 'song.mp3']]);

    expect(result).toEqual({
      ok: true,
      files: [
        { name: 'box.png', ok: true, asset_id: 'box' },
        { name: 'song.mp3', ok: true, asset_id: 'song' },
      ],
    });
    expect(fs.existsSync(path.join(workspace, 'ad/media/box.png'))).toBe(true);
    const [production] = await read();
    expect(production.assets.map((card) => card.id)).toEqual(['box']);
    expect(readJson('ad/assets.json').assets[0]).toMatchObject({ id: 'box', kind: 'image', origin: 'upload', path: 'media/box.png' });
  });

  it('skips what is not a picture, clip or sound', async () => {
    expect(await drop([[outside('notes.txt'), 'notes.txt']])).toEqual({ ok: true, files: [{ name: 'notes.txt', ok: false, reason: 'unsupported' }] });
    expect(fs.existsSync(path.join(workspace, 'ad/media/notes.txt'))).toBe(false);
  });

  it('does not change an asset in use when another file arrives under its name', async () => {
    await drop([[outside('box.png', 'first'), 'box.png']]);
    const again = await drop([[outside('box.png', 'second'), 'box.png']]);

    expect(again).toEqual({ ok: true, files: [{ name: 'box.png', ok: true, asset_id: 'box-2' }] });
    expect(fs.readFileSync(path.join(workspace, 'ad/media/box.png'), 'utf8')).toBe('first');
    expect(fs.readFileSync(path.join(workspace, 'ad/media/box-2.png'), 'utf8')).toBe('second');
  });

  it('does not turn a paid result into an upload when the same bytes are dropped', async () => {
    write('ad/assets.json', JSON.stringify({ assets: [
      { id: 'paid', kind: 'image', label: 'Paid', path: 'media/box.png', origin: 'generated', request: { prompt: 'a box' } },
    ] }));
    write('ad/media/box.png', 'same');

    const result = await drop([[outside('box.png', 'same'), 'box.png']]);

    expect(result).toEqual({ ok: true, files: [{ name: 'box.png', ok: true, asset_id: 'paid' }] });
    expect(readJson('ad/assets.json').assets).toEqual([
      { id: 'paid', kind: 'image', label: 'Paid', path: 'media/box.png', origin: 'generated', request: { prompt: 'a box' } },
    ]);
  });

  it('lists the same file only once', async () => {
    await drop([[outside('box.png', 'same'), 'box.png']]);
    const again = await drop([[outside('box.png', 'same'), 'box.png']]);

    expect(again).toEqual({ ok: true, files: [{ name: 'box.png', ok: true, asset_id: 'box' }] });
    expect(readJson('ad/assets.json').assets).toHaveLength(1);
  });

  it('reports a file it could not read, and takes the others', async () => {
    const result = await drop([[path.join(root, 'gone.png'), 'gone.png'], [outside('box.png'), 'box.png']]);
    expect(result).toEqual({ ok: true, files: [
      { name: 'gone.png', ok: false, reason: 'failed' },
      { name: 'box.png', ok: true, asset_id: 'box' },
    ] });
  });

  it('waits while the Agent works, and for an unreadable ledger', async () => {
    expect(await drop([[outside('box.png'), 'box.png']], true)).toEqual({ ok: false, code: 'busy' });
    write('ad/assets.json', '{not json');
    expect(await drop([[outside('box.png'), 'box.png']])).toEqual({ ok: false, code: 'unreadable' });
  });
});
