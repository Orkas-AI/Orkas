import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));
vi.mock('../../../src/main/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/paths')>();
  return { ...actual, userLocalRoot: () => path.join(process.env.UPGRADE_TEST_ROOT as string, 'local') };
});

import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';
import {
  discoverOldProductions,
  oldPageTimelineKey,
  upgradeOldProductions,
  upgradePageMarkup,
} from '../../../src/main/features/video_project_upgrade';
import { compileVideoPage, VideoManifestV3Schema } from '../../../src/main/features/video_timeline';

const userId = 'upgrade-user';
let root: string;
let workspace: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-upgrade-'));
  process.env.UPGRADE_TEST_ROOT = root;
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  delete process.env.UPGRADE_TEST_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string): string {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function makeClip(relative: string, seconds = 2): string {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const run = spawnSync(bundledFfmpegPaths().ffmpeg as string, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=s=360x640:r=30:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file,
  ], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
  return file;
}

function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else hash.update(path.relative(dir, full)).update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

const oldManifest = (extra: Record<string, unknown> = {}) => ({
  schema_version: 2,
  composition: { id: 'main-film', width: 1080, height: 1920, duration: 5, fps: 30, language: 'zh-CN' },
  scenes: [
    { id: 'hook', start: 0, duration: 2, narration_text: '第一句' },
    { id: 'offer', start: 2, duration: 3 },
  ],
  audio: { owner: 'none', tracks: [] },
  ...extra,
});

const oldPage = `<!doctype html><html><head><script src="./assets/vendor/gsap.min.js"></script></head><body>
<main data-composition-id="main-film" data-width="1080" data-height="1920" data-duration="5">
<section class="clip" data-scene-id="hook" data-start="0" data-duration="2"><h1>Hook</h1></section>
<section class="clip" data-scene-id="offer" data-start="2" data-duration="3"><h1>Offer</h1></section>
</main>
<script>window.__timelines = window.__timelines || {}; window.__timelines["main-film"] = gsap.timeline({ paused: true });</script>
</body></html>`;

function oldComposition(relative: string, manifest: unknown = oldManifest(), page: string | null = oldPage): string {
  write(`${relative}/composition-manifest.json`, JSON.stringify(manifest));
  if (page !== null) write(`${relative}/index.html`, page);
  write(`${relative}/assets/logo.txt`, 'logo');
  write(`${relative}/qa/report.json`, '{}');
  return path.join(workspace, relative);
}

const upgrade = () => upgradeOldProductions({ userId, workspaceAbs: workspace });
const readJson = (relative: string) => JSON.parse(fs.readFileSync(path.join(workspace, relative), 'utf8'));

describe('a composition with no plan', () => {
  it('becomes a video on the new layout, with what the renderer needs to play its old page', async () => {
    oldComposition('project/composition');
    const results = await upgrade();
    expect(results).toEqual([{ production_dir: '.', videos: ['main-film'], status: 'upgraded' }]);
    const manifest = readJson('videos/main-film/manifest.json');
    expect(VideoManifestV3Schema.safeParse(manifest).success).toBe(true);
    expect(manifest).toMatchObject({
      schema_version: 3,
      canvas: { width: 1080, height: 1920, fps: 30, language: 'zh-CN' },
      upgraded_from: 'project/composition',
      absolute_page: { timeline_key: 'main-film', scene_starts: { hook: 0, offer: 2 } },
    });
    expect(manifest.scenes).toEqual([
      { id: 'hook', duration: 2, narration: { text: '第一句' } },
      { id: 'offer', duration: 3 },
    ]);
    expect(fs.existsSync(path.join(workspace, 'videos/main-film/index.html'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'videos/main-film/assets/logo.txt'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'videos/main-film/qa'))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'videos/main-film/upgrade-notes.md'), 'utf8')).toContain('written into the HTML');
  });

  it('names what the page is missing, so the check that refuses it is no surprise', async () => {
    oldComposition('project/composition', oldManifest(), oldPage.replace(' data-scene-id="offer"', ''));
    await upgrade();
    expect(fs.readFileSync(path.join(workspace, 'videos/main-film/upgrade-notes.md'), 'utf8')).toContain('no section for "offer"');
  });

  it('says how to reorder a page that keeps its one timeline, so the page is not rewritten for it', async () => {
    oldComposition('project/composition');
    await upgrade();
    const notes = fs.readFileSync(path.join(workspace, 'videos/main-film/upgrade-notes.md'), 'utf8');
    expect(notes).toContain('This page keeps its one timeline through `absolute_page` in manifest.json, so it renders as it is. To reorder scenes, change their order in manifest.json; leave `absolute_page` and the page alone.');
  });

  it('still upgrades a composition that never had a page, and says so', async () => {
    oldComposition('project/composition', oldManifest(), null);
    await upgrade();
    expect(readJson('videos/main-film/manifest.json').absolute_page).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, 'videos/main-film/upgrade-notes.md'), 'utf8')).toContain('no page');
  });

  it('leaves every byte of the old folder alone', async () => {
    oldComposition('project/composition');
    const before = treeHash(path.join(workspace, 'project'));
    await upgrade();
    expect(treeHash(path.join(workspace, 'project'))).toBe(before);
  });

  it('changes nothing the second time', async () => {
    oldComposition('project/composition');
    await upgrade();
    const before = treeHash(workspace);
    expect(await upgrade()).toEqual([]);
    expect(treeHash(workspace)).toBe(before);
  });

  it('moves page sound to tracks, and names a track that cannot come along', async () => {
    const manifest = oldManifest({
      audio: {
        owner: 'composition',
        tracks: [
          { id: 'voice', kind: 'narration', src: 'assets/voice.mp3', start: 0, duration: 5, volume: 1 },
          { id: 'sting', kind: 'sfx', src: 'assets/sting.mp3', start: 4, duration: 1, volume: 0.5 },
        ],
      },
      scenes: [{ id: 'hook', start: 0, duration: 2 }, { id: 'offer', start: 2, duration: 3 }],
    });
    oldComposition('project/composition', manifest, oldPage.replace('</main>', '<audio id="voice" src="assets/voice.mp3" data-start="0"></audio></main>'));
    await upgrade();
    const upgraded = readJson('videos/main-film/manifest.json');
    expect(upgraded.tracks).toEqual([{ kind: 'narration', asset: 'track-voice', volume: 1 }]);
    expect(readJson('assets.json').assets).toEqual([expect.objectContaining({ id: 'track-voice', kind: 'audio', path: 'videos/main-film/assets/voice.mp3' })]);
    expect(fs.readFileSync(path.join(workspace, 'videos/main-film/index.html'), 'utf8')).not.toContain('<audio');
    const notes = fs.readFileSync(path.join(workspace, 'videos/main-film/upgrade-notes.md'), 'utf8');
    expect(notes).toContain('"sting"');
    expect(notes).toContain('generate it again scene by scene');
  });

  it('lists the delivered draft as a version', async () => {
    const dir = oldComposition('project/composition');
    makeClip('project/composition/render/draft.mp4');
    fs.mkdirSync(path.join(root, 'local/video_studio/gates'), { recursive: true });
    fs.writeFileSync(path.join(root, 'local/video_studio/gates/a.json'), JSON.stringify({ composition_dir: dir, task_title: '台灯广告', draft: { path: path.join(dir, 'render/draft.mp4') } }));
    await upgrade();
    expect(readJson('videos/main-film/manifest.json').label).toBe('台灯广告');
    expect(readJson('versions.json').versions).toEqual([expect.objectContaining({
      id: 'v1',
      video_id: 'main-film',
      path: 'project/composition/render/draft.mp4',
      canvas: '360x640',
      warnings: ['DELIVERED_BEFORE_UPGRADE'],
    })]);
  });

  it('reports a damaged manifest, keeps the old files, and tries again next time', async () => {
    write('project/composition/composition-manifest.json', '{"schema_version":2,"composition":{}}');
    write('project/composition/index.html', oldPage);
    const before = treeHash(path.join(workspace, 'project'));
    const [result] = await upgrade();
    expect(result).toMatchObject({ production_dir: '.', status: 'failed', videos: [] });
    expect(result.reason).toContain('project/composition');
    expect(treeHash(path.join(workspace, 'project'))).toBe(before);
    write('project/composition/composition-manifest.json', JSON.stringify(oldManifest()));
    expect((await upgrade())[0]).toMatchObject({ status: 'upgraded', videos: ['main-film'] });
  });

  it('does not overwrite a video already using the name', async () => {
    write('videos/main-film/manifest.json', JSON.stringify({ schema_version: 3, id: 'main-film', label: 'New', canvas: { width: 1080, height: 1920, fps: 30 }, scenes: [{ id: 'a', duration: 1 }] }));
    oldComposition('project/composition');
    expect((await upgrade())[0].videos).toEqual(['main-film-2']);
    expect(readJson('videos/main-film/manifest.json').label).toBe('New');
  });
});

describe('a plan assembled from segments', () => {
  const plan = (segments: unknown[], extra: Record<string, unknown> = {}) => ({ aspect: '9:16', language: 'zh-CN', segments, tracks: {}, ...extra });

  it('becomes one video in playing order, with each produced file as a clip', async () => {
    makeClip('project/cuts/open.mp4', 2);
    makeClip('project/shots/lamp.mp4', 3);
    makeClip('project/compositions/offer/render/offer.mp4', 2);
    write('project/plan.json', JSON.stringify(plan([
      { id: 'offer', order: 3, source: 'compose', produced_path: 'project/compositions/offer/render/offer.mp4', spec: { composition_dir: 'project/compositions/offer' } },
      { id: 'open', order: 1, source: 'edit', produced_path: 'project/cuts/open.mp4' },
      { id: 'lamp', order: 2, source: 'generate', produced_path: 'project/shots/lamp.mp4', spec: { prompt: 'a lamp at night' } },
    ])));
    expect(await upgrade()).toEqual([{ production_dir: '.', videos: ['main'], status: 'upgraded' }]);
    const manifest = readJson('videos/main/manifest.json');
    expect(manifest.scenes.map((scene: { id: string }) => scene.id)).toEqual(['open', 'lamp', 'offer']);
    expect(manifest.absolute_page).toBeUndefined();
    expect(manifest.upgraded_from).toBe('project/plan.json');
    expect(manifest.canvas).toMatchObject({ width: 1080, height: 1920 });
    const [first] = manifest.scenes[0].clips;
    expect(first).toMatchObject({ asset: 'segment-open', in: 0 });
    expect(first.dur).toBeCloseTo(2, 0);
    const assets = readJson('assets.json').assets;
    expect(assets.find((asset: { id: string }) => asset.id === 'segment-lamp')).toMatchObject({ origin: 'generated', prompt: 'a lamp at night', path: 'project/shots/lamp.mp4' });
    expect(fs.readFileSync(path.join(workspace, 'videos/main/upgrade-notes.md'), 'utf8')).toContain('project/compositions/offer/index.html');
  });

  it('names what it could not bring: overlays, unproduced segments, narration lines and captions', async () => {
    makeClip('project/cuts/open.mp4', 1);
    write('project/plan.json', JSON.stringify(plan([
      { id: 'open', order: 1, source: 'edit', produced_path: 'project/cuts/open.mp4' },
      { id: 'title', order: 2, layer: 'overlay', source: 'compose' },
      { id: 'later', order: 3, source: 'generate' },
    ], { tracks: { narration: { segments: [{ text: '一句话' }] }, captions: { lines: [{ text: '字幕' }] } } })));
    await upgrade();
    const notes = fs.readFileSync(path.join(workspace, 'videos/main/upgrade-notes.md'), 'utf8');
    expect(notes).toContain('"title"');
    expect(notes).toContain('"later"');
    expect(notes).toContain('narration line');
    expect(notes).toContain('Captions');
  });

  it('lists the final video as a version, and its compositions do not become videos of their own', async () => {
    makeClip('project/cuts/open.mp4', 1);
    makeClip('project/final.mp4', 1);
    oldComposition('project/compositions/offer');
    write('project/plan.json', JSON.stringify(plan(
      [{ id: 'open', order: 1, source: 'edit', produced_path: 'project/cuts/open.mp4' }],
      { _runtime: { render: { final_path: 'project/final.mp4' } } },
    )));
    expect((await upgrade())[0].videos).toEqual(['main']);
    expect(fs.existsSync(path.join(workspace, 'videos/main-film'))).toBe(false);
    expect(readJson('versions.json').versions[0]).toMatchObject({ video_id: 'main', path: 'project/final.mp4' });
  });

  it('warns about a paid request that never finished, so it is not paid for twice', async () => {
    makeClip('project/cuts/open.mp4', 1);
    const planFile = write('project/plan.json', JSON.stringify(plan([{ id: 'open', order: 1, source: 'edit', produced_path: 'project/cuts/open.mp4' }])));
    fs.mkdirSync(path.join(root, 'local/video_studio/production'), { recursive: true });
    fs.writeFileSync(path.join(root, 'local/video_studio/production/x.json'), JSON.stringify({
      plan_path: planFile,
      transactions: { t1: { status: 'pending', segment_id: 'lamp', output_path: 'project/shots/lamp.mp4', started_at: new Date().toISOString() }, t3: { status: 'pending', segment_id: 'gone', output_path: 'project/shots/months-old.mp4', started_at: '2026-01-01T00:00:00.000Z' }, t2: { status: 'completed', segment_id: 'done', output_path: 'project/shots/done.mp4' } },
    }));
    await upgrade();
    const notes = fs.readFileSync(path.join(workspace, 'videos/main/upgrade-notes.md'), 'utf8');
    expect(notes).toContain('project/shots/lamp.mp4');
    expect(notes).not.toContain('project/shots/done.mp4');
    // Uncertain old requests remain visible even when a result URL may have expired.
    expect(notes).toContain('project/shots/months-old.mp4');
    expect(notes).toContain('Check the selected service');
    expect(notes).not.toContain('without paying twice');
  });

  it('carries nothing over, and reports nothing wrong, when nothing in the plan was ever made', async () => {
    write('project/plan.json', JSON.stringify(plan([{ id: 'later', order: 1, source: 'generate' }])));
    expect(await upgrade()).toEqual([]);
    expect(fs.existsSync(path.join(workspace, 'videos/main'))).toBe(false);
  });

  it('keeps the pages of a plan that never produced anything, as videos of their own', async () => {
    write('project/plan.json', JSON.stringify(plan([{ id: 'offer', order: 1, source: 'compose' }])));
    oldComposition('project/compositions/offer');
    expect(await upgrade()).toEqual([{ production_dir: '.', videos: ['main-film'], status: 'upgraded' }]);
  });

  it('finds a segment a run wrote without recording it, where its kind is written', async () => {
    makeClip('project/cuts/open.mp4', 1);
    makeClip('project/parts/lamp.mp4', 1);
    makeClip('project/compositions/offer/render/film.mp4', 1);
    write('project/plan.json', JSON.stringify(plan([
      { id: 'open', order: 1, source: 'edit' },
      { id: 'lamp', order: 2, source: 'generate' },
      { id: 'offer', order: 3, source: 'compose' },
      { id: '../../escape', order: 4, source: 'compose' },
    ])));
    const manifest = (await upgrade()) && readJson('videos/main/manifest.json');
    expect(manifest.scenes.map((scene: { id: string }) => scene.id)).toEqual(['open', 'lamp', 'offer']);
  });

  it('finds the newest render as the delivered video when no record names one', async () => {
    makeClip('project/cuts/open.mp4', 1);
    const older = makeClip('project/render/first.mp4', 1);
    makeClip('project/render/second.mp4', 1);
    fs.utimesSync(older, new Date(1000), new Date(1000));
    write('project/plan.json', JSON.stringify(plan([{ id: 'open', order: 1, source: 'edit', produced_path: 'project/cuts/open.mp4' }])));
    await upgrade();
    expect(readJson('versions.json').versions[0].path).toBe('project/render/second.mp4');
  });

  it('ignores a plan.json that is about something else', async () => {
    write('project/plan.json', JSON.stringify({ segments: [{ id: 'a', source: 'market research' }] }));
    expect(await upgrade()).toEqual([]);
  });

  it('gives a video the next free name when the plan names it first', async () => {
    write('videos/main/manifest.json', JSON.stringify({ schema_version: 3, id: 'main', label: 'New', canvas: { width: 1080, height: 1920, fps: 30 }, scenes: [{ id: 'a', duration: 1 }] }));
    makeClip('project/cuts/open.mp4', 1);
    write('project/plan.json', JSON.stringify(plan([{ id: 'open', order: 1, source: 'edit', produced_path: 'project/cuts/open.mp4' }])));
    expect((await upgrade())[0].videos).toEqual(['main-2']);
  });
});

describe('a file at the production root that is not this flow\'s', () => {
  it.each([
    ['an unrelated JSON file', '{"logo":"a.png","hero":"b.png"}\n'],
    ['a list, as a bundler writes', '["a.png","b.png"]\n'],
    ['a ledger with one typo', '{ "assets": [ { "id": "mine", "kind": "video", "label": "x", "path": "x.mp4", "origin": "edited" }, ] }\n'],
  ])('leaves %s named assets.json alone and upgrades nothing', async (_label, content) => {
    write('assets.json', content);
    oldComposition('project/composition');
    const [result] = await upgrade();
    expect(result).toMatchObject({ status: 'failed', videos: [] });
    expect(result.reason).toContain('assets.json');
    expect(fs.readFileSync(path.join(workspace, 'assets.json'), 'utf8')).toBe(content);
    expect(fs.existsSync(path.join(workspace, 'videos/main-film'))).toBe(false);
  });

  it('upgrades once the file is out of the way', async () => {
    write('assets.json', '["a.png"]\n');
    oldComposition('project/composition');
    await upgrade();
    fs.rmSync(path.join(workspace, 'assets.json'));
    expect((await upgrade())[0]).toMatchObject({ status: 'upgraded', videos: ['main-film'] });
  });

  it('adds to a ledger of its own without losing its rows', async () => {
    write('assets.json', `${JSON.stringify({ assets: [{ id: 'mine', kind: 'video', label: 'x', path: 'x.mp4', origin: 'edited' }] })}\n`);
    oldComposition('project/composition', oldManifest({ audio: { owner: 'c', tracks: [{ id: 'voice', kind: 'narration', src: 'assets/voice.mp3', start: 0, volume: 1 }] } }));
    write('project/composition/assets/voice.mp3', 'audio');
    await upgrade();
    expect(readJson('assets.json').assets.map((asset: { id: string }) => asset.id)[0]).toBe('mine');
    expect(readJson('assets.json').assets.length).toBeGreaterThan(1);
  });

  it('leaves an unrelated versions.json alone, and still upgrades the video', async () => {
    const unrelated = '{"versions":"1.2.3","app":"my-site"}\n';
    write('versions.json', unrelated);
    oldComposition('project/composition');
    makeClip('project/composition/render/final.mp4', 5);
    expect((await upgrade())[0]).toMatchObject({ status: 'upgraded', videos: ['main-film'] });
    expect(fs.readFileSync(path.join(workspace, 'versions.json'), 'utf8')).toBe(unrelated);
  });
});

describe('an upgrade that does not finish', () => {
  const plan = (segments: unknown[]) => ({ aspect: '9:16', language: 'zh-CN', segments, tracks: {} });
  const withVoice = (id: string) => oldManifest({
    composition: { id, width: 1080, height: 1920, duration: 5, fps: 30 },
    audio: { owner: 'c', tracks: [{ id: 'voice', kind: 'narration', src: 'assets/voice.mp3', start: 0, volume: 1 }] },
  });
  const segments = () => plan([
    { id: 'cover', order: 1, source: 'provided', produced_path: 'project/stills/cover.png', target_sec: 2 },
    { id: 'open', order: 2, source: 'edit', produced_path: 'project/cuts/open.mp4' },
  ]);
  const ledgerIds = () => readJson('assets.json').assets.map((asset: { id: string }) => asset.id);

  it('leaves no video behind for a later pass to skip when a copy fails', async () => {
    oldComposition('project/compositions/a', withVoice('a'));
    write('project/compositions/a/assets/voice.mp3', 'audio');
    oldComposition('project/compositions/b', withVoice('b'));
    write('project/compositions/b/assets/voice.mp3', 'audio');
    const locked = write('project/compositions/b/assets/locked.bin', 'x');
    const { syncBuiltinESMExports } = await import('node:module');
    const fsp = fs.promises;
    const copy = fsp.cp;
    let refusedCopies = 0;
    // chmod(0) does not deny reads on Windows or for a privileged runner.
    const fault = vi.spyOn(fsp, 'cp').mockImplementation(async (from, to, options) => {
      if (String(from) === path.dirname(locked)) {
        refusedCopies++;
        throw Object.assign(new Error('controlled video-copy failure'), { code: 'EACCES' });
      }
      return copy(from, to, options);
    });
    syncBuiltinESMExports();
    try {
      expect((await upgrade())[0].status).toBe('failed');
      expect(refusedCopies).toBe(1);
    } finally {
      fault.mockRestore();
      syncBuiltinESMExports();
    }
    expect(fs.readFileSync(locked, 'utf8')).toBe('x');
    expect(fs.readdirSync(path.join(workspace, 'videos'))).toEqual([]);
    expect(fs.existsSync(path.join(workspace, 'assets.json'))).toBe(false);

    const [second] = await upgrade();
    expect(second).toMatchObject({ status: 'upgraded', videos: ['a', 'b'] });
    expect(ledgerIds().length).toBe(2);
  });

  it('keeps nothing in place when the ledger cannot be written, and finishes the next time', async () => {
    oldComposition('project/composition', withVoice('main-film'));
    write('project/composition/assets/voice.mp3', 'audio');
    fs.mkdirSync(path.join(workspace, 'assets.json'));
    expect((await upgrade())[0].status).toBe('failed');
    expect(fs.existsSync(path.join(workspace, 'videos/main-film'))).toBe(false);
    fs.rmdirSync(path.join(workspace, 'assets.json'));
    expect((await upgrade())[0]).toMatchObject({ status: 'upgraded', videos: ['main-film'] });
    expect(ledgerIds().length).toBe(1);
  });

  it('counts a stop as not done, rather than as a shorter video', async () => {
    makeClip('project/cuts/open.mp4', 1);
    write('project/stills/cover.png', 'not really a png');
    write('project/plan.json', JSON.stringify(segments()));
    const controller = new AbortController();
    controller.abort();
    const [first] = await upgradeOldProductions({ userId, workspaceAbs: workspace, signal: controller.signal });
    expect(first).toMatchObject({ status: 'failed', videos: [] });
    expect(fs.existsSync(path.join(workspace, 'videos/main'))).toBe(false);

    expect((await upgrade())[0]).toMatchObject({ status: 'upgraded', videos: ['main'] });
    expect(readJson('videos/main/manifest.json').scenes.map((scene: { id: string }) => scene.id)).toEqual(['cover', 'open']);
  });

  it('does not turn a plan into separate videos because a stop kept it from being measured', async () => {
    makeClip('project/compositions/offer/render/offer.mp4', 1);
    oldComposition('project/compositions/offer', oldManifest({ composition: { id: 'offer', width: 360, height: 640, duration: 3, fps: 30 } }));
    write('project/plan.json', JSON.stringify(plan([{ id: 'offer', order: 1, source: 'compose', produced_path: 'project/compositions/offer/render/offer.mp4' }])));
    const controller = new AbortController();
    controller.abort();
    expect((await upgradeOldProductions({ userId, workspaceAbs: workspace, signal: controller.signal }))[0]).toMatchObject({ status: 'failed', videos: [] });
    expect((await upgrade())[0]).toMatchObject({ status: 'upgraded', videos: ['main'] });
    expect(fs.readdirSync(path.join(workspace, 'videos'))).toEqual(['main']);
  });
});

describe('finding old productions', () => {
  it('looks in the workspace and one level down, and ignores files that are only named plan.json', async () => {
    oldComposition('lamp/project/composition');
    write('notes/project/plan.json', '{"steps":[]}');
    const found = await discoverOldProductions({ userId, workspaceAbs: workspace });
    expect(found.map((item) => path.relative(workspace, item.rootAbs))).toEqual(['lamp']);
    expect((await upgrade())[0]).toMatchObject({ production_dir: 'lamp' });
    expect(fs.existsSync(path.join(workspace, 'lamp/videos/main-film/manifest.json'))).toBe(true);
  });

  it('follows a gate record to a composition elsewhere, but never out of this workspace', async () => {
    const inside = oldComposition('deep/down/film');
    const outside = path.join(root, 'elsewhere', 'film');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'composition-manifest.json'), JSON.stringify(oldManifest()));
    fs.mkdirSync(path.join(root, 'local/video_studio/gates'), { recursive: true });
    fs.writeFileSync(path.join(root, 'local/video_studio/gates/in.json'), JSON.stringify({ composition_dir: inside }));
    fs.writeFileSync(path.join(root, 'local/video_studio/gates/out.json'), JSON.stringify({ composition_dir: outside }));
    fs.writeFileSync(path.join(root, 'local/video_studio/gates/bad.json'), 'not json');
    const found = await discoverOldProductions({ userId, workspaceAbs: workspace });
    expect(found.map((item) => path.relative(workspace, item.rootAbs))).toEqual([path.join('deep', 'down')]);
  });

  it('looks only at gate records when asked to, so a look-alike folder is left alone', async () => {
    oldComposition('lamp/project/composition');
    expect(await upgradeOldProductions({ userId, workspaceAbs: workspace, gateRecordsOnly: true })).toEqual([]);
    expect(fs.existsSync(path.join(workspace, 'lamp/videos'))).toBe(false);
    fs.mkdirSync(path.join(root, 'local/video_studio/gates'), { recursive: true });
    fs.writeFileSync(path.join(root, 'local/video_studio/gates/a.json'), JSON.stringify({ composition_dir: path.join(workspace, 'lamp/project/composition') }));
    expect((await upgradeOldProductions({ userId, workspaceAbs: workspace, gateRecordsOnly: true }))[0]).toMatchObject({ production_dir: 'lamp', status: 'upgraded' });
  });

  it('finds nothing in an empty workspace, or one with no such folder', async () => {
    expect(await upgrade()).toEqual([]);
    expect(await upgradeOldProductions({ userId, workspaceAbs: path.join(root, 'missing') })).toEqual([]);
  });
});

describe('upgradePageMarkup', () => {
  const scenes = [{ id: 'hook', start: 0, duration: 2 }, { id: 'demo', start: 2, duration: 3 }];
  const page = (video: string) => `<section data-scene-id="demo">${video}</section>`;

  it('turns footage with complete timing into a clip placed in its scene', () => {
    const taken: unknown[] = [];
    const { html, unconverted } = upgradePageMarkup({
      html: page('<video class="hero" src="assets/a.mp4" data-start="2.5" data-duration="2" data-media-start="1" muted playsinline></video>'),
      scenes,
      takeVideo: (video) => { taken.push(video); return 'footage-demo'; },
    });
    expect(unconverted).toBe(0);
    expect(html).toContain('<img data-clip="footage-demo" class="hero" alt="">');
    expect(html).not.toContain('<video');
    expect(taken).toEqual([{ src: 'assets/a.mp4', sceneId: 'demo', inSec: 1, durSec: 2, atSec: 0.5 }]);
  });

  it.each([
    ['no timing', '<video src="assets/a.mp4"></video>'],
    ['no source', '<video data-start="2" data-duration="1"></video>'],
    ['a start in no scene', '<video src="a.mp4" data-start="9" data-duration="1"></video>'],
  ])('leaves footage with %s in place, for the check to refuse', (_label, video) => {
    const { html, unconverted } = upgradePageMarkup({ html: page(video), scenes, takeVideo: () => 'x' });
    expect(unconverted).toBe(1);
    expect(html).toContain('<video');
  });

  it('removes page audio of either form, and nothing else', () => {
    const { html } = upgradePageMarkup({
      html: '<audio src="a.mp3" data-start="0"></audio><p>Keep the word audio.</p><audio src="b.mp3"/>',
      scenes,
      takeVideo: () => 'x',
    });
    expect(html).toBe('<p>Keep the word audio.</p>');
  });

  it('has the check refuse a <video> left on an upgraded page', () => {
    const manifest = VideoManifestV3Schema.parse({
      schema_version: 3, id: 'main', label: 'Old', canvas: { width: 1080, height: 1920, fps: 30 },
      scenes: [{ id: 'demo', duration: 3 }], upgraded_from: 'project/composition',
    });
    const { issues } = compileVideoPage({ html: `<main>${page('<video src="a.mp4"></video>')}</main>`, manifest, product: null, baseHref: 'file:///x/' });
    expect(issues.map((issue) => issue.code)).toContain('PAGE_MEDIA_ELEMENT_FORBIDDEN');
  });
});

describe('oldPageTimelineKey', () => {
  it.each([
    ['window.__timelines["film"] = tl', 'film', 'film'],
    ["window.__timelines['main'] = tl", 'film', 'main'],
    ['window.__timelines.root = tl', 'film', 'root'],
    ['window.__timelines.film = tl', 'film', 'film'],
  ])('finds the key in %s', (html, id, key) => {
    expect(oldPageTimelineKey(html, id)).toBe(key);
  });

  it.each([
    ['no timeline at all', '<p>film</p>'],
    ['a similar name', 'window.__timelines.filmstrip = tl'],
    ['a scene key', 'window.__timelines["hook"] = tl'],
  ])('finds none with %s', (_label, html) => {
    expect(oldPageTimelineKey(html, 'film')).toBeNull();
  });
});


describe('upgrade filesystem and publication recovery boundaries', () => {
  it.each(['project', 'manifest', 'page', 'videos', 'staging', 'ledger'])(
    'does not read or change foreign content through a %s symlink', async (boundary) => {
      const foreign = path.join(root, 'foreign');
      fs.mkdirSync(foreign);
      const old = oldComposition('project/composition');
      if (boundary === 'project') {
        fs.renameSync(path.join(workspace, 'project'), path.join(foreign, 'project'));
        fs.symlinkSync(path.join(foreign, 'project'), path.join(workspace, 'project'), 'junction');
      } else if (boundary === 'manifest' || boundary === 'page') {
        const name = boundary === 'manifest' ? 'composition-manifest.json' : 'index.html';
        fs.renameSync(path.join(old, name), path.join(foreign, name));
        fs.symlinkSync(path.join(foreign, name), path.join(old, name));
      } else if (boundary === 'videos') fs.symlinkSync(foreign, path.join(workspace, 'videos'), 'junction');
      else if (boundary === 'staging') {
        fs.mkdirSync(path.join(workspace, 'videos'));
        fs.symlinkSync(foreign, path.join(workspace, 'videos/.upgrading-main-film'), 'junction');
      } else {
        fs.writeFileSync(path.join(foreign, 'assets.json'), '{"assets":[]}');
        fs.symlinkSync(path.join(foreign, 'assets.json'), path.join(workspace, 'assets.json'));
      }
      fs.writeFileSync(path.join(foreign, 'sentinel'), 'private');
      const before = treeHash(foreign);
      const results = await upgrade();
      expect(results.some(result => result.status === 'upgraded')).toBe(false);
      expect(treeHash(foreign)).toBe(before);
      // The foreign page/manifest is never imported as a new, authorized video.
      expect(fs.existsSync(path.join(workspace, 'videos/main-film/manifest.json'))).toBe(false);
    });

  it('retries a partially published production without duplicating asset rows', async () => {
    const withVoice = (id: string) => oldManifest({
      composition: { id, width: 1080, height: 1920, fps: 30 },
      audio: { tracks: [{ id: 'voice', kind: 'narration', src: 'assets/voice.mp3', start: 0, volume: 1 }] },
    });
    for (const id of ['a', 'b']) {
      oldComposition(`project/compositions/${id}`, withVoice(id));
      write(`project/compositions/${id}/assets/voice.mp3`, 'voice');
    }
    const original = treeHash(path.join(workspace, 'project'));
    const { syncBuiltinESMExports } = await import('node:module');
    const rename = fs.promises.rename;
    const fault = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path.join(workspace, 'videos/b')) throw Object.assign(new Error('controlled publication failure'), { code: 'EACCES' });
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try { expect((await upgrade())[0].status).toBe('failed'); }
    finally { fault.mockRestore(); syncBuiltinESMExports(); }
    expect((await upgrade())[0]).toMatchObject({ status: 'upgraded', videos: ['b'] });
    const rows = readJson('assets.json').assets;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row: { path: string }) => row.path)).size).toBe(2);
    const referenced = ['a', 'b'].map(id => readJson(`videos/${id}/manifest.json`).tracks[0].asset);
    expect(rows.map((row: { id: string }) => row.id).sort()).toEqual(referenced.sort());
    expect(fs.readdirSync(path.join(workspace, 'videos')).sort()).toEqual(['a', 'b']);
    expect(treeHash(path.join(workspace, 'project'))).toBe(original);
  });
});
