import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A video on the canvas changes only when the user updates it (decided 2026-11-09): a change
// waits for the Update, and stops one in progress, whose file would no longer match. A paid
// redo keeps its request, the shot in that scene and the old output.
// The renderer and the generation tools have their own suites; here they are stand-ins that
// record what they were asked to do.

vi.mock('electron', () => ({}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
// A framed take's first frame is read before its request is planned, and an Update reads whether
// the video changed; a case can hold either read.
const frameRead = vi.hoisted(() => ({ hold: null as null | (() => Promise<void>) }));
const changeRead = vi.hoisted(() => ({ hold: null as null | (() => Promise<void>) }));
vi.mock('../../../src/main/features/video_canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/video_canvas')>();
  return {
    ...actual,
    pictureShape: async (fileAbs: string) => {
      if (frameRead.hold) await frameRead.hold();
      return actual.pictureShape(fileAbs);
    },
    videoUpToDate: async (productionAbs: string, videoId: string) => {
      if (changeRead.hold) await changeRead.hold();
      return actual.videoUpToDate(productionAbs, videoId);
    },
  };
});
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
const account = vi.hoisted(() => ({ uid: 'u-jobs' as string | null }));
vi.mock('../../../src/main/features/users', () => ({
  hasActiveUser: () => account.uid !== null,
  getActiveUserId: () => account.uid,
}));
const workspaces = vi.hoisted(() => new Map<string, string>());
vi.mock('../../../src/main/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/paths')>();
  return { ...actual, userLocalRoot: () => path.join(process.env.CANVAS_JOBS_ROOT as string, 'local') };
});
vi.mock('../../../src/main/features/group_chat/conv_workspace', () => ({
  getConversationWorkspacePath: async (_uid: string, cid: string) => {
    const dir = workspaces.get(cid);
    if (!dir) throw new Error('no workspace');
    return dir;
  },
}));
const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  ship: vi.fn(),
  finalize: vi.fn(async () => {}),
  quote: vi.fn(),
  videoExecute: vi.fn(),
  imageExecute: vi.fn(),
  videoToolOpts: [] as unknown[],
  imageToolOpts: [] as unknown[],
  candidates: [] as Array<{ entry: Record<string, unknown> }>,
  imageCandidates: [] as Array<{ entry: Record<string, unknown>; capability: Record<string, unknown> }>,
}));
vi.mock('../../../src/main/features/video_timeline_render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/video_timeline_render')>();
  return { ...actual, renderVideoTimeline: mocks.render };
});
vi.mock('../../../src/main/features/video_timeline_ship', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/video_timeline_ship')>();
  return { ...actual, shipVideoFile: mocks.ship };
});
vi.mock('../../../src/main/features/produced_output_hooks', () => ({ finalizeProducedFile: mocks.finalize }));
vi.mock('../../../src/main/features/video_production_spend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/video_production_spend')>();
  return { ...actual, quoteProductionIntents: mocks.quote };
});
vi.mock('../../../src/main/model/core-agent/video-gen-tool', () => ({
  createVideoGenTool: (opts: unknown) => {
    mocks.videoToolOpts.push(opts);
    return { execute: mocks.videoExecute };
  },
}));
vi.mock('../../../src/main/model/core-agent/image-gen-tool', () => ({
  createImageGenTool: (opts: unknown) => {
    mocks.imageToolOpts.push(opts);
    return { execute: mocks.imageExecute };
  },
}));
// The services configured on this machine; what each can make comes from the real catalog.
vi.mock('../../../src/main/features/video_gen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/video_gen')>();
  return { ...actual, listVideoGenCandidates: () => mocks.candidates };
});
vi.mock('../../../src/main/features/image_gen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/image_gen')>();
  return { ...actual, listOpenImageGenCandidates: () => mocks.imageCandidates };
});

import {
  onVideoCanvasJob,
  quoteVideoCanvasDraft,
  quoteVideoCanvasRedo,
  resetVideoCanvasJobsForTest,
  resolveVideoCanvasDelivery,
  scheduleVideoCanvasRender,
  startVideoCanvasDraft,
  startVideoCanvasRedo,
  stopVideoCanvasRender,
  stopVideoCanvasJobsForQuit,
  updateVideoCanvasVideo,
  videoCanvasDraftOptions,
  videoCanvasJobs,
  videoCanvasRedoOptions,
  type VideoCanvasJobEvent,
} from '../../../src/main/features/video_canvas_jobs';
import { applyVideoCanvasDraftChange, type VideoCanvasDraftChange } from '../../../src/main/features/video_canvas';
import { fitVideoParameters } from '../../../src/main/features/video_parameter_compatibility';
import { reserveProductionRequest } from '../../../src/main/features/video_production_budget';
import { notifyUserSwitch } from '../../../src/main/features/user-switch-hooks';
import { normaliseSeedreamSize } from '../../../src/main/features/image_size';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';

const UID = 'u-jobs';
const CID = 'c-jobs';
const CTX = { uid: UID, cid: CID, dir: 'ad' };
let root: string;
let workspace: string;
let events: VideoCanvasJobEvent[];

function write(relative: string, content = 'bytes'): string {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** A real picture of this size, because a shot on frames takes its shape from probing it. */
function writePicture(relative: string, width: number, height: number): void {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(bundledFfmpegPaths().ffmpeg as string, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=gray:s=${width}x${height}`, '-frames:v', '1', file,
  ]);
}

function quote(overrides: Record<string, unknown> = {}) {
 return {external_billing_estimate_available:false,sufficient:true,externally_billed_segment_ids:['request'],unavailable_segment_ids:[],segments:[],...overrides};
}

const manifestOf = () => JSON.parse(fs.readFileSync(path.join(workspace, 'ad/videos/main/manifest.json'), 'utf8'));
const ledgerOf = () => JSON.parse(fs.readFileSync(path.join(workspace, 'ad/assets.json'), 'utf8')).assets;
const lastOf = (status: string, kind = 'render') => events.filter((event) => event.status === status && event.kind === kind).at(-1);

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

beforeEach(() => {
  account.uid = UID;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-canvas-jobs-')));
  process.env.CANVAS_JOBS_ROOT = root;
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  workspaces.clear();
  workspaces.set(CID, workspace);
  write('ad/media/a.png');
  write('ad/gen/shot.mp4');
  write('ad/assets.json', JSON.stringify({ assets: [
    { id: 'a', kind: 'image', label: 'A', path: 'media/a.png', origin: 'upload' },
    {
      id: 'shot',
      kind: 'video',
      label: 'Pour',
      path: 'gen/shot.mp4',
      origin: 'generated',
      shot: 'pour',
      prompt: 'pour juice',
      request: {
        prompt: 'pour juice',
        output_path: 'ad/gen/shot.mp4',
        production_dir: 'ad',
        shot: 'pour',
        label: 'Pour',
        duration: 8,
        reference_image_paths: ['ad/media/a.png'],
      },
    },
    { id: 'old', kind: 'video', label: 'Old', path: 'gen/shot.mp4', origin: 'generated' },
  ] }));
  write('ad/videos/main/manifest.json', JSON.stringify({
    schema_version: 3,
    id: 'main',
    label: 'Main',
    canvas: { width: 1080, height: 1920, fps: 30 },
    scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'shot', in: 0, dur: 3 }] }],
  }));
  events = [];
  mocks.render.mockReset();
  mocks.ship.mockReset();
  mocks.finalize.mockClear();
  mocks.quote.mockReset();
  mocks.videoExecute.mockReset();
  mocks.imageExecute.mockReset();
  mocks.videoToolOpts.length = 0;
  mocks.imageToolOpts.length = 0;
  mocks.candidates = [];
  mocks.imageCandidates = [];
  frameRead.hold = null;
  changeRead.hold = null;
  mocks.render.mockResolvedValue({ ok: true, op: 'video.render' });
  mocks.ship.mockResolvedValue({ ok: true, op: 'video.ship', version: { id: 'v2' } });
  mocks.quote.mockResolvedValue(quote());
  onVideoCanvasJob((event) => events.push(event));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fsp.readFile).mockImplementation((await vi.importActual<typeof fsp>('node:fs/promises')).readFile);
  resetVideoCanvasJobsForTest();
  delete process.env.CANVAS_JOBS_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('rendering when the user updates a video', () => {
  it.each(['confirm', 'edit', 'account_switch'] as const)(
    'resolves a still-frame review only for its current canvas (%s)', async (decision) => {
      let delivered = false;
      mocks.ship.mockImplementationOnce(async options => {
        const current = await options.reviewHeldStills({ percent: 76, scenes: [{ id: 'one', seconds: 2 }] });
        if (!current?.() || options.signal.aborted) return { ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' };
        delivered = true;
        return { ok: true, version: { id: 'v2' } };
      });
      scheduleVideoCanvasRender(CTX, 'main');
      await until(() => !!lastOf('review'));
      const review = lastOf('review')?.review;
      expect(videoCanvasJobs(UID, CID, { busy: false })).toMatchObject([
        { video_id: 'main', review: { percent: 76, preview_path: path.join(workspace, 'ad/render/main.mp4') } },
      ]);
      expect(delivered).toBe(false);
      expect(resolveVideoCanvasDelivery({ ...CTX, cid: 'another' }, 'main', review?.id, 'deliver', () => false).ok).toBe(false);
      expect(resolveVideoCanvasDelivery(CTX, 'main', 'older-review', 'deliver', () => false)).toEqual({ ok: false, code: 'changed' });
      expect(resolveVideoCanvasDelivery(CTX, 'main', review?.id, 'deliver', () => true)).toEqual({ ok: false, code: 'busy' });
      if (decision === 'account_switch') {
        account.uid = 'new-account';
        await notifyUserSwitch(UID, account.uid);
      } else {
        expect(resolveVideoCanvasDelivery(CTX, 'main', review?.id, decision === 'confirm' ? 'deliver' : 'edit', () => false)).toEqual({ ok: true });
      }
      expect(resolveVideoCanvasDelivery(CTX, 'main', review?.id, 'deliver', () => false).ok).toBe(false);
      await until(() => videoCanvasJobs(UID, CID, { busy: false }).length === 0);
      expect(delivered).toBe(decision === 'confirm');
      expect(lastOf('done')?.version).toBe(decision === 'confirm' ? 'v2' : undefined);
      expect(mocks.render).toHaveBeenCalledOnce();
    },
  );

  it('cancels a queued old-account render and admits work for the newly active account', async () => {
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 10 });
    notifyUserSwitch(UID, 'next-user');
    account.uid = 'next-user';
    const other = { ...CTX, uid: 'next-user' };
    scheduleVideoCanvasRender(other, 'main', { delayMs: 0 });
    await until(() => events.some(e => e.userId === other.uid && e.status === 'done'));
    expect(mocks.render).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.userId === UID && e.status === 'done')).toBe(false);
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
  });

  it('aborts an old-account render and ignores a late successful result', async () => {
    let finish!: (value: unknown) => void;
    mocks.render.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!finish);
    const signal = mocks.render.mock.calls[0][0].signal as AbortSignal;
    notifyUserSwitch(UID, 'next-user');
    expect(signal.aborted).toBe(true);
    finish({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(mocks.ship).not.toHaveBeenCalled();
    expect(lastOf('done')).toBeUndefined();
  });

  // Decided 2026-11-11: Update reads first whether the video changed since its latest version; an
  // account change during that read renders nothing for the old account.
  it.each([UID, 'next-user', null])('rechecks account %s after reading whether the video changed', async nextUser => {
    let release: (() => void) | undefined;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    changeRead.hold = () => new Promise<void>(resolve => { release = resolve; entered(); });
    const started = updateVideoCanvasVideo(CTX, 'main');
    try {
      await Promise.race([paused, started]);
      expect(release).toBeDefined();
      account.uid = nextUser;
      if (nextUser !== UID) notifyUserSwitch(UID, nextUser);
    } finally { release?.(); }
    const result = await started;
    if (nextUser === UID) {
      expect(result).toEqual({ ok: true });
      await until(() => !!lastOf('done'));
      expect(mocks.render).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toEqual({ ok: false, code: 'not_found' });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(mocks.render).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    }
  });

  it('renders at standard when this machine cannot take the video at high, as the Agent does', async () => {
    mocks.render
      .mockResolvedValueOnce({ ok: false, op: 'video.render', errorCode: 'E_RENDER_TOO_HEAVY', message: 'too heavy' })
      .mockResolvedValueOnce({ ok: true, op: 'video.render' });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!lastOf('done'));
    expect(mocks.render.mock.calls.map(([input]) => input.quality)).toEqual(['high', 'standard']);
    expect(lastOf('failed')).toBeUndefined();
  });

  it('does not try again for any other refusal', async () => {
    mocks.render.mockResolvedValueOnce({ ok: false, op: 'video.render', errorCode: 'E_VIDEO_CHECK_BLOCKED', message: 'bad page' });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!lastOf('failed'));
    expect(mocks.render).toHaveBeenCalledTimes(1);
  });

  it('renders, delivers a new version and reports it', async () => {
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!lastOf('done'));

    const [renderInput] = mocks.render.mock.calls[0];
    expect(renderInput).toMatchObject({
      productionDirAbs: path.join(workspace, 'ad'),
      videoDirAbs: path.join(workspace, 'ad/videos/main'),
      outputAbsPath: path.join(workspace, 'ad/render/main.mp4'),
      quality: 'high',
    });
    // The cache the Agent renders into, so a scene it already rendered is not done again.
    expect(renderInput.segmentCacheDirAbs).toContain(path.join('video_studio', 'segment_cache'));
    expect(mocks.ship.mock.calls[0][0]).toMatchObject({
      videoPathAbs: path.join(workspace, 'ad/render/main.mp4'),
      videoDirAbs: path.join(workspace, 'ad/videos/main'),
    });
    expect(lastOf('done')).toMatchObject({ dir: 'ad', video_id: 'main', version: 'v2', userId: UID, cid: CID });
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
  });

  it('runs what the account does to a delivered file on the version\'s copy', async () => {
    mocks.ship.mockImplementation(async (input) => {
      await input.finalize('/copy.mp4');
      return { ok: true, op: 'video.ship', version: { id: 'v2' } };
    });
    scheduleVideoCanvasRender({ ...CTX, projectId: 'p1' }, 'main', { delayMs: 0 });
    await until(() => !!lastOf('done'));

    expect(mocks.finalize).toHaveBeenCalledWith('/copy.mp4', { userId: UID, cid: CID, projectId: 'p1', source: 'video_canvas.ship' });
  });

  it('shows the work in progress to a panel opened later', async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.render.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => mocks.render.mock.calls.length === 1);

    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([
      expect.objectContaining({ dir: 'ad', video_id: 'main', kind: 'render', status: 'running', phase: 'render' }),
    ]);
    expect(videoCanvasJobs(UID, 'other', { busy: false })).toEqual([]);

    finish({ ok: true, op: 'video.render' });
    await until(() => !!lastOf('done'));
  });

  it('reports how far along it is, without flooding the renderer', async () => {
    mocks.render.mockImplementation(async ({ onProgress }) => {
      onProgress({ phase: 'video.render', message: '', data: { segmentsTotal: 3, segmentsToRender: 2, segmentsCached: 1 } });
      for (let frame = 1; frame <= 200; frame += 1) {
        onProgress({ phase: 'video.render.capture', message: '', data: { sceneId: 's1', frame, totalFrames: 200 } });
      }
      onProgress({ phase: 'video.render.capture', message: '', data: { sceneId: 's2', frame: 1, totalFrames: 100 } });
      return { ok: true, op: 'video.render' };
    });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!lastOf('done'));

    const running = events.filter((event) => event.status === 'running');
    expect(running.length).toBeLessThan(10);
    expect(mocks.render).toHaveBeenCalledTimes(1);
    const progress = running.map((event) => event.progress).filter((value): value is number => value !== undefined);
    expect(progress.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('treats several quick updates as one render', async () => {
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 20 });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 20 });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 20 });
    await until(() => !!lastOf('done'));

    expect(mocks.render).toHaveBeenCalledTimes(1);
    expect(mocks.ship).toHaveBeenCalledTimes(1);
  });

  it('stops a render when the user updates again, and delivers only the newest', async () => {
    const signals: AbortSignal[] = [];
    mocks.render.mockImplementation(({ signal }) => {
      signals.push(signal);
      if (signals.length > 1) return Promise.resolve({ ok: true, op: 'video.render' });
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: false, errorCode: 'E_RENDER_ABORTED', message: 'aborted' }));
      });
    });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => mocks.render.mock.calls.length === 1);

    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 5 });
    expect(signals[0].aborted).toBe(true);
    await until(() => !!lastOf('done'));

    expect(mocks.render).toHaveBeenCalledTimes(2);
    expect(mocks.ship).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.status === 'failed')).toBe(false);
  });

  it('does not deliver a render the user updated again during', async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.render
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ ok: true, op: 'video.render' });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => mocks.render.mock.calls.length === 1);

    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 5 });
    // This render ignored the stop and finished anyway.
    finish({ ok: true, op: 'video.render' });
    await until(() => !!lastOf('done'));

    expect(mocks.ship).toHaveBeenCalledTimes(1);
    expect(mocks.render).toHaveBeenCalledTimes(2);
  });

  it('keeps a failure on the card until the next try', async () => {
    mocks.render.mockResolvedValueOnce({ ok: false, errorCode: 'E_PAGE_SCRIPT_ERROR', message: 'boom at /secret/path' });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!lastOf('failed'));

    expect(lastOf('failed')).toMatchObject({ code: 'E_PAGE_SCRIPT_ERROR', video_id: 'main' });
    expect(JSON.stringify(events)).not.toContain('/secret/path');
    expect(mocks.ship).not.toHaveBeenCalled();
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([
      expect.objectContaining({ status: 'failed', code: 'E_PAGE_SCRIPT_ERROR' }),
    ]);

    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!lastOf('done'));
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
  });

  it('names what the delivery check found', async () => {
    mocks.ship.mockResolvedValueOnce({
      ok: false,
      errorCode: 'E_VIDEO_SHIP_BLOCKED',
      message: 'x',
      issues: [{ code: 'DELIVERY_TIMELINE_CHANGED', severity: 'error', message: 'x' }],
    });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!lastOf('failed'));

    expect(lastOf('failed')?.code).toBe('DELIVERY_TIMELINE_CHANGED');
  });

  it('reports a render that throws', async () => {
    mocks.render.mockRejectedValueOnce(new Error('window gone'));
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!lastOf('failed'));

    expect(lastOf('failed')?.code).toBe('E_CANVAS_RENDER');
  });

  it('still renders the next update when the render it replaced throws', async () => {
    let fail: (err: Error) => void = () => {};
    mocks.render
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue({ ok: true, op: 'video.render' });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => mocks.render.mock.calls.length === 1);

    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    fail(new Error('window closed by the stop'));
    await until(() => !!lastOf('done'));

    expect(mocks.render).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.status === 'failed')).toBe(false);
  });

  it('says it is waiting when another render holds the slot', async () => {
    mocks.render.mockImplementation(async ({ onProgress }) => {
      onProgress({ phase: 'video.render.queue', message: '', data: { queued: true, waitedMs: 1000 } });
      onProgress({ phase: 'video.render.queue', message: '', data: { queued: true, waitedMs: 2000 } });
      return { ok: true, op: 'video.render' };
    });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!lastOf('done'));

    const phases = events.filter((event) => event.status === 'running').map((event) => event.phase);
    expect(phases.filter((phase) => phase === 'queue').length).toBeLessThanOrEqual(2);
    expect(phases).toContain('deliver');
  });

  it('forgets an old failure once the Agent has taken over', async () => {
    mocks.render.mockResolvedValueOnce({ ok: false, errorCode: 'E_X', message: 'x' });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!lastOf('failed'));

    expect(videoCanvasJobs(UID, CID, { busy: true })).toEqual([]);
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
  });

  it('refuses a video folder that climbs out of the production', async () => {
    scheduleVideoCanvasRender(CTX, '../../x', { delayMs: 0 });
    await until(() => !!lastOf('failed'));

    expect(lastOf('failed')?.code).toBe('E_CANVAS_NOT_FOUND');
    expect(mocks.render).not.toHaveBeenCalled();
  });
});

// Review 2026-11-16 S4-10: a quit stops what the canvas started, as it stops the Agent's turns,
// so FFmpeg does not run on after the app and partial files are removed.
describe('quitting the app', () => {
  it('stops a render and a take in progress, reports neither as failed, and waits for them to let go', async () => {
    let unwound = false;
    mocks.render.mockImplementation(({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => setTimeout(() => {
        unwound = true;
        resolve({ ok: false, op: 'video.render', errorCode: 'E_RENDER_ABORTED', message: 'aborted' });
      }, 30));
    }));
    let takeSignal: AbortSignal | undefined;
    mocks.videoExecute.mockImplementationOnce((_request, context) => new Promise((resolve) => {
      takeSignal = context.signal;
      context.signal.addEventListener('abort', () => resolve({ isError: true, content: 'operation aborted' }));
    }));
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    expect(await startVideoCanvasRedo({ ctx: CTX, asset: 'shot', isBusy: () => false })).toEqual({ ok: true });
    await until(() => mocks.render.mock.calls.length === 1 && !!takeSignal);

    await stopVideoCanvasJobsForQuit();

    expect((mocks.render.mock.calls[0][0].signal as AbortSignal).aborted).toBe(true);
    expect(takeSignal!.aborted).toBe(true);
    expect(unwound).toBe(true);
    expect(mocks.ship).not.toHaveBeenCalled();
    expect(events.some((event) => event.status === 'failed' || event.status === 'done')).toBe(false);
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
  });

  it('does not hold the quit open for a render that never lets go', async () => {
    mocks.render.mockImplementation(() => new Promise(() => {}));
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => mocks.render.mock.calls.length === 1);
    vi.useFakeTimers();
    try {
      let done = false;
      const quitting = stopVideoCanvasJobsForQuit().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await quitting;
      expect(done).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('returns at once when nothing is running', async () => {
    await expect(stopVideoCanvasJobsForQuit()).resolves.toBeUndefined();
  });
});

describe('a change while the user waits for an update', () => {
  /** A render that stays busy until it is stopped, then takes `unwindMs` to let go. */
  const busyUntilStopped = (unwindMs = 0) => mocks.render.mockImplementation(({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      setTimeout(() => resolve({ ok: false, op: 'video.render', errorCode: 'E_RENDER_ABORTED', message: 'aborted' }), unwindMs);
    });
  }));

  it('stops the update in progress, delivers nothing and reports no failure', async () => {
    busyUntilStopped();
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => mocks.render.mock.calls.length === 1);
    const signal = mocks.render.mock.calls[0][0].signal as AbortSignal;

    stopVideoCanvasRender(CTX, 'main');

    expect(signal.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ dir: 'ad', video_id: 'main', kind: 'render', status: 'stopped' });
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(mocks.ship).not.toHaveBeenCalled();
    expect(events.some((event) => event.status === 'failed' || event.status === 'done')).toBe(false);
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
  });

  it('stops an update that has not started yet', async () => {
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 10 });
    stopVideoCanvasRender(CTX, 'main');
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    expect(mocks.render).not.toHaveBeenCalled();
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
  });

  it('lets go of a failed update, so the card offers the update again', async () => {
    mocks.render.mockResolvedValueOnce({ ok: false, errorCode: 'E_PAGE_SCRIPT_ERROR', message: 'boom' });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!lastOf('failed'));

    stopVideoCanvasRender(CTX, 'main');

    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
    expect(events.at(-1)).toMatchObject({ video_id: 'main', status: 'stopped' });
  });

  it('starts the next update only once the stopped one has let go, and delivers it', async () => {
    let active = 0;
    let most = 0;
    mocks.render.mockImplementation(({ signal }) => {
      active += 1;
      most = Math.max(most, active);
      if (mocks.render.mock.calls.length > 1) {
        active -= 1;
        return Promise.resolve({ ok: true, op: 'video.render' });
      }
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => setTimeout(() => {
          active -= 1;
          resolve({ ok: false, op: 'video.render', errorCode: 'E_RENDER_ABORTED', message: 'aborted' });
        }, 15));
      });
    });
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => mocks.render.mock.calls.length === 1);

    stopVideoCanvasRender(CTX, 'main');
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => !!lastOf('done'));

    expect(most).toBe(1);
    expect(mocks.render).toHaveBeenCalledTimes(2);
    expect(mocks.ship).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.status === 'failed')).toBe(false);
  });

  it('says nothing when the video was not being updated', () => {
    stopVideoCanvasRender(CTX, 'main');

    expect(events).toEqual([]);
  });
});

// The services configured for these cases, and a take that asked for specific settings.
const SERVICES = {
  doubao: { id: 'doubao', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key' },
  h3: { id: 'h3', provider: 'minimax', model: 'MiniMax-H3-Lite', apiKey: 'fixture-key' },
  vidu: { id: 'vidu', provider: 'vidu', model: 'viduq3-turbo', apiKey: 'fixture-key' },
  kling: { id: 'kling', provider: 'kling', model: 'kling-v4-0', apiKey: 'fixture-key' },
  orkas: { id: 'public', provider: 'orkas-api', model: 'orkas-video', apiKey: 'fixture-key' },
};
const configure = (...ids: Array<keyof typeof SERVICES>) => {
  mocks.candidates = (ids.length ? ids : Object.keys(SERVICES) as Array<keyof typeof SERVICES>).map((id) => ({ entry: SERVICES[id] }));
};
function addTake(id: string, overrides: { model?: string; request?: Record<string, unknown> } = {}) {
  write('ad/assets.json', JSON.stringify({ assets: [...ledgerOf(), {
    id,
    kind: 'video',
    label: 'Pour',
    path: 'gen/shot.mp4',
    origin: 'generated',
    shot: id,
    model: overrides.model ?? 'doubao/doubao-seedance-2-0-260128',
    request: {
      prompt: 'pour juice', ratio: '9:16', resolution: '720p', duration: 8, generate_audio: false,
      reference_image_paths: ['ad/media/a.png'], production_dir: 'ad', shot: id, label: 'Pour',
      ...overrides.request,
    },
  }] }));
}
const CONCRETE_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
const SEEDANCE_OFFER = { ratios: CONCRETE_RATIOS, resolutions: ['480p', '720p', '1080p'], durations: [4, 5, 6, 8, 10, 12, 15], silent: true };

describe('the services a shot can be made on again', () => {
  // Decided 2026-11-09: the user can pick another configured video service, or the public API.
  // A service that cannot make the shot as asked says why; only the resolution, and sound a
  // service cannot leave out, are changed for it, and the user sees that before paying.
  it('lists each configured service and the public API, with what each would ask for', async () => {
    configure();
    addTake('rich');

    expect(await videoCanvasRedoOptions(CTX, 'rich')).toEqual({
      ok: true,
      current: 'doubao',
      // How the take is made, and whether its inputs could open and end it instead (2026-11-10).
      method: 'references',
      frames_fit: true,
      // What each offers comes from its own documented limits (video_models.ts); the public API keeps its declared legacy envelope.
      choices: [
        { id: 'doubao', name: 'Doubao Seedance 2.0', frames: 'first_last', ...SEEDANCE_OFFER, params: { ratio: '9:16', resolution: '720p', duration: 8, audio: false } },
        { id: 'h3', name: 'MiniMax H3 Lite', frames: 'first_last', ratios: CONCRETE_RATIOS, resolutions: ['480p', '768p'], durations: [4, 5, 6, 8, 10, 12, 15], silent: false, params: { ratio: '9:16', resolution: '768p', duration: 8, audio: true } },
        { id: 'vidu', name: 'Vidu Q3 Turbo', frames: 'first_last', ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'], resolutions: ['540p', '720p', '1080p'], durations: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15], silent: true, params: { ratio: '9:16', resolution: '720p', duration: 8, audio: false } },
        { id: 'kling', name: 'Kling 4.0', frames: 'first_last', ratios: ['16:9', '9:16', '1:1', '21:9'], resolutions: ['720p', '1080p'], durations: [3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30], silent: false, params: { ratio: '9:16', resolution: '720p', duration: 8, audio: true } },
        { id:'public', name:'orkas-video', frames: 'none', ...SEEDANCE_OFFER, params: { ratio: '9:16', resolution: '720p', duration: 8, audio: false } },
      ],
    });
  });

  // Decided 2026-11-10 (plan 27.21): the user sets the shape, sharpness, length and sound, and a
  // take made again asks for them on whichever service, or exactly as recorded when untouched.
  it('makes a take again at the settings the user picked, and as recorded with none', async () => {
    configure('doubao', 'h3');
    addTake('take');
    const settings = { ratio: '16:9', resolution: '1080p', duration: 10, audio: true };

    const options = await videoCanvasRedoOptions(CTX, 'take', undefined, settings);
    if (!options.ok) throw new Error('no options');
    const byId = Object.fromEntries(options.choices.map((choice) => [choice.id, choice]));
    expect(byId.doubao.params).toEqual({ ratio: '16:9', resolution: '1080p', duration: 10, audio: true });
    // H3 Lite makes no 1080p, so the nearest it makes; it stays offered.
    expect(byId.h3.params).toEqual({ ratio: '16:9', resolution: '768p', duration: 10, audio: true });
    expect(byId.h3).not.toHaveProperty('unavailable');

    expect(await quoteVideoCanvasRedo(CTX, 'take', 'doubao', undefined, settings)).toMatchObject({ ok: true });
    expect(mocks.quote.mock.calls[0][0][0]).toMatchObject({ kind: 'video', ratio: '16:9', resolution: '1080p', duration: 10, generate_audio: true });
    expect(await quoteVideoCanvasRedo(CTX, 'take', 'h3', undefined, { audio: false })).toMatchObject({ ok: true });
    // H3 always makes sound: asked for none, it is asked with sound, as the panel shows.
    expect(mocks.quote.mock.calls[1][0][0]).toMatchObject({ resolution: '768p', duration: 8, generate_audio: true });

    mocks.videoExecute.mockResolvedValue({ content: 'E_PATH_OUT_OF_SCOPE: nope', isError: true });
    expect(await startVideoCanvasRedo({ ctx: CTX, asset: 'take', choice: 'doubao', settings, isBusy: () => false })).toEqual({ ok: true });
    await until(() => mocks.videoExecute.mock.calls.length === 1);
    expect(mocks.videoExecute.mock.calls[0][0]).toMatchObject({ ratio: '16:9', resolution: '1080p', duration: 10, generate_audio: true });

    // Untouched, the call on record.
    await quoteVideoCanvasRedo(CTX, 'take', 'doubao');
    expect(mocks.quote.mock.calls.at(-1)![0][0]).toMatchObject({ ratio: '9:16', resolution: '720p', duration: 8, generate_audio: false });
  });

  it('refuses settings it cannot read, before pricing anything', async () => {
    configure('doubao');
    addTake('take');
    for (const settings of [{ ratio: '2:1' }, { resolution: '9000p' }, { duration: 'ten' }, { duration: 4.5 }, { duration: 99 }, { audio: 'yes' }, 'loud', [1]]) {
      expect(await quoteVideoCanvasRedo(CTX, 'take', 'doubao', undefined, settings)).toEqual({ ok: false, code: 'invalid' });
      expect(await videoCanvasRedoOptions(CTX, 'take', undefined, settings)).toEqual({ ok: false, code: 'invalid' });
    }
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  // Until 2026-11-10 a service that could not make the take's length or shape was greyed out; with
  // the settings in the panel (plan 27.21) it takes the nearest it makes, and shows that.
  it('moves a setting a service cannot make to the nearest it can, and greys a service out only for its footage', async () => {
    configure();
    addTake('long', { request: { duration: 20, ratio: '21:9', reference_image_paths: ['ad/media/a.png', 'ad/media/a.png', 'ad/media/a.png'] } });

    const options = await videoCanvasRedoOptions(CTX, 'long');
    if (!options.ok) throw new Error('no options');
    expect(Object.fromEntries(options.choices.map((choice) => [choice.id, choice.unavailable ?? null]))).toEqual({
      doubao: null,
      h3: null,
      vidu: { code: 'images', max: 1 },
      kling: null,
            public: null,
          });
    const params = Object.fromEntries(options.choices.map((choice) => [choice.id, choice.params]));
    expect(params.doubao).toEqual({ ratio: '21:9', resolution: '720p', duration: 15, audio: false });
    expect(params.kling).toEqual({ ratio: '21:9', resolution: '720p', duration: 20, audio: true });
    // Vidu makes no 21:9: the nearest shape it makes.
    expect(params.vidu).toMatchObject({ ratio: '16:9' });
    expect(options.current).toBe('doubao');
    // A length it makes but has no step for stays as it was.
    addTake('odd', { request: { duration: 7 } });
    const odd = await videoCanvasRedoOptions(CTX, 'odd');
    if (!odd.ok) throw new Error('no options');
    const doubao = odd.choices.find((choice) => choice.id === 'doubao')!;
    expect(doubao.params.duration).toBe(7);
    expect(doubao.durations).toEqual([4, 5, 6, 7, 8, 10, 12, 15]);
  });

  // Decided 2026-11-18 (review S4-6, option A): the canvas fits a setting the way the Agent's
  // generation does (fitVideoParameters), so a take asks a service for the same thing from either.
  it('fits a resolution a service does not make to the lowest it offers not below it, as the Agent does', async () => {
    mocks.candidates = [
      { entry: { id: 'fast', provider: 'doubao', model: 'doubao-seedance-2-0-fast-260128', apiKey: 'fixture-key' } },
      { entry: SERVICES.h3 },
      { entry: SERVICES.vidu },
    ];
    addTake('take');

    const options = await videoCanvasRedoOptions(CTX, 'take', undefined, { resolution: '540p' });
    if (!options.ok) throw new Error('no options');
    const byId = Object.fromEntries(options.choices.map((choice) => [choice.id, choice]));
    // Asked for 540p: Seedance 2.0 Fast (480p, 720p) and H3 Lite (480p, 768p) make the next sharper
    // one, not a softer 480p; Vidu makes 540p itself. What each lists is unchanged.
    expect(byId.fast).toMatchObject({ resolutions: ['480p', '720p'], params: { resolution: '720p' } });
    expect(byId.h3).toMatchObject({ resolutions: ['480p', '768p'], params: { resolution: '768p' } });
    expect(byId.vidu).toMatchObject({ resolutions: ['540p', '720p', '1080p'], params: { resolution: '540p' } });
    for (const entry of mocks.candidates.map(({ entry }) => entry)) {
      expect(byId[entry.id as string].params.resolution)
        .toBe(fitVideoParameters({ resolution: '540p' }, entry.provider as string, entry.model as string).resolution);
      expect(byId[entry.id as string]).not.toHaveProperty('unavailable');
    }

    // The price is asked for what is made.
    expect(await quoteVideoCanvasRedo(CTX, 'take', 'fast', undefined, { resolution: '540p' })).toMatchObject({ ok: true });
    expect(mocks.quote.mock.calls[0][0][0]).toMatchObject({ resolution: '720p' });
  });

  it('rounds a length a service cannot make up as the Agent does, keeping Veo to 4, 6 or 8 seconds', async () => {
    const runway = { id: 'runway', provider: 'runway', model: 'gen4.5', apiKey: 'fixture-key' };
    const veo = {
      id: 'veo',
      provider: 'google-cloud',
      model: 'veo-3.1-fast-generate-001',
      apiKey: JSON.stringify({
        type: 'service_account',
        project_id: 'video-project',
        client_email: 'video@video-project.iam.gserviceaccount.com',
        private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
    };
    mocks.candidates = [{ entry: SERVICES.doubao }, { entry: runway }, { entry: veo }];
    const agentLength = (entry: Record<string, unknown>, duration: number) =>
      fitVideoParameters({ duration, resolution: '720p' }, entry.provider as string, entry.model as string).duration;
    const choicesFor = async (asset: string, settings?: Record<string, unknown>) => {
      const options = await videoCanvasRedoOptions(CTX, asset, undefined, settings);
      if (!options.ok) throw new Error('no options');
      return Object.fromEntries(options.choices.map((choice) => [choice.id, choice]));
    };

    // One second asked for: Runway makes 2 at the least, Seedance 4.
    addTake('take');
    const short = await choicesFor('take', { duration: 1 });
    expect(short.runway.params.duration).toBe(2);
    expect(short.doubao.params.duration).toBe(4);
    expect(short.runway.params.duration).toBe(agentLength(runway, 1));

    // A take on record at 8.4 seconds asks for the whole second above, as its call did, not a
    // shorter 8; Veo takes its next step up, and still lists only 4, 6 and 8.
    addTake('odd', { request: { duration: 8.4 } });
    const odd = await choicesFor('odd');
    expect(odd.doubao).toMatchObject({ params: { duration: 9 }, durations: [4, 5, 6, 8, 9, 10, 12, 15] });
    expect(odd.doubao.params.duration).toBe(agentLength(SERVICES.doubao, 8.4));
    addTake('veo', { request: { duration: 4.2 } });
    const onVeo = (await choicesFor('veo')).veo;
    expect(onVeo).toMatchObject({ params: { duration: 6 }, durations: [4, 6, 8] });
    expect(onVeo.params.duration).toBe(agentLength(veo, 4.2));
    expect(onVeo).not.toHaveProperty('unavailable');
  });

  it.each([
    ['the user\'s own service', 'minimax/MiniMax-H3-Lite', {}, 'h3'],
    ['the public API service', 'orkas-api/orkas-video', {}, 'public'],
    ['a service no longer configured', 'aliyun/wan3.0-video', {}, 'doubao'],
  ])('starts from the service that made the take: %s', async (_label, model, request, current) => {
    configure();
    addTake('take', { model, request });
    expect(await videoCanvasRedoOptions(CTX, 'take')).toMatchObject({ ok: true, current });
  });

  // A take that opens or ends on given frames (decided 2026-11-10) can be made again only where the
  // service takes those frames as asked.
  it('says which services cannot open or end the take on its frames', async () => {
    mocks.candidates = [
      { entry: SERVICES.doubao },
      { entry: { id: 'flash', provider: 'kling', model: 'kling-v4-0-flash', apiKey: 'fixture-key' } },
      { entry: { id: 'omni', provider: 'google', model: 'gemini-omni-1.1-flash', apiKey: 'fixture-key' } },
      { entry: SERVICES.kling },
      { entry: SERVICES.orkas },
    ];
    addTake('framed', { request: { ratio: undefined, reference_image_paths: [], first_frame: 'ad/media/a.png', last_frame: 'ad/media/a.png' } });
    addTake('mixed', { request: { ratio: undefined, first_frame: 'ad/media/a.png' } });
    addTake('opening', { request: { ratio: 'adaptive', reference_image_paths: [], first_frame: 'ad/media/a.png' } });

    const reasons = async (asset: string) => {
      const options = await videoCanvasRedoOptions(CTX, asset);
      if (!options.ok) throw new Error('no options');
      return Object.fromEntries(options.choices.map((choice) => [choice.id, choice.unavailable ?? null]));
    };
    expect(await reasons('framed')).toEqual({
      doubao: null,
      flash: { code: 'last_frame' },
      omni: { code: 'frames' },
      kling: null,
            public: { code: 'frames' },
          });
    expect(await reasons('mixed')).toEqual({
      doubao: { code: 'frames_with_references' },
      flash: null,
      omni: { code: 'frames' },
      kling: null,
            public: { code:'frames' },
          });
    // The public API has no explicit-frame capability.
    expect(await reasons('opening')).toEqual({
      doubao: null,
      flash: null,
      omni: { code: 'frames' },
      kling: null,
            public: { code: 'frames' },
          });
  });

  it('keeps the public API when it is the only configured service', async () => {
    configure('orkas');
    addTake('take');
    expect(await videoCanvasRedoOptions(CTX, 'take')).toMatchObject({ ok: true, current: 'public' });
  });

  it('offers no choice of service for a still, which keeps the one configured', async () => {
    configure();
    write('ad/assets.json', JSON.stringify({ assets: [...ledgerOf(), {
      id: 'still', kind: 'image', label: 'Still', path: 'gen/still.png', origin: 'generated', request: { prompt: 'a lamp' },
    }] }));
    write('ad/gen/still.png');
    expect(await videoCanvasRedoOptions(CTX, 'still')).toEqual({ ok: true, choices: [], current: '' });
  });

  it('refuses a take with no call on record', async () => {
    configure();
    expect(await videoCanvasRedoOptions(CTX, 'old')).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('quoting a redo', () => {
  it('aborts an in-flight redo and preserves the scene when a late result arrives', async () => {
    let finish!: (value: unknown) => void;
    mocks.videoExecute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    expect(await startVideoCanvasRedo({ ctx: CTX, asset: 'shot', isBusy: () => false })).toEqual({ ok: true });
    await until(() => !!finish);
    const signal = mocks.videoExecute.mock.calls[0][1].signal as AbortSignal;
    notifyUserSwitch(UID, 'next-user');
    expect(signal.aborted).toBe(true);
    finish({ content: JSON.stringify({ asset_id: 'a' }) });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(manifestOf().scenes[0].clips[0].asset).toBe('shot');
    expect(mocks.render).not.toHaveBeenCalled();
    expect(lastOf('done', 'redo')).toBeUndefined();
  });

  it('does not dispatch an old-account redo after its pending quote resolves', async () => {
    let finish!: (value: unknown) => void;
    mocks.quote.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const started = startVideoCanvasRedo({ ctx: CTX, asset: 'shot', isBusy: () => false });
    await until(() => !!finish);
    notifyUserSwitch(UID, 'next-user');
    finish(quote());
    expect((await started).ok).toBe(false);
    expect(mocks.videoExecute).not.toHaveBeenCalled();
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
  });

  it('checks the call on record', async () => {
    const result = await quoteVideoCanvasRedo(CTX, 'shot');

    expect(result).toEqual({ ok: true, sufficient: true, own_key: true, external_billing_estimate_available: false });
    const [intents] = mocks.quote.mock.calls[0];
    expect(intents[0]).toMatchObject({
      kind: 'video',
      prompt: 'pour juice',
      duration: 8,
      reference_image_paths: [path.join(workspace, 'ad/media/a.png')],
    });
  });

  it('checks the frames on record with the call', async () => {
    configure();
    addTake('framed', { request: { ratio: undefined, reference_image_paths: [], first_frame: 'ad/media/a.png', last_frame: 'https://images.example/last.png' } });

    expect(await quoteVideoCanvasRedo(CTX, 'framed')).toMatchObject({ ok: true });
    const [intents] = mocks.quote.mock.calls[0];
    expect(intents[0]).toMatchObject({
      kind: 'video',
      first_frame_path: path.join(workspace, 'ad/media/a.png'),
      last_frame_url: 'https://images.example/last.png',
    });
  });

  

  it('reports configured-service billing without a hosted balance or fallback',async()=>{mocks.quote.mockResolvedValue(quote());const result=await quoteVideoCanvasRedo(CTX,'shot');expect(result).toEqual({ok:true,sufficient:true,own_key:true,external_billing_estimate_available:false});expect(result).not.toHaveProperty('credits');expect(result).not.toHaveProperty('may_fall_back');});

  it('refuses a result with no call on record, or that was not generated', async () => {
    expect(await quoteVideoCanvasRedo(CTX, 'old')).toEqual({ ok: false, code: 'not_found' });
    expect(await quoteVideoCanvasRedo(CTX, 'a')).toEqual({ ok: false, code: 'not_found' });
    expect(await quoteVideoCanvasRedo(CTX, 'nope')).toEqual({ ok: false, code: 'not_found' });
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it('reports when configured-service availability cannot be checked', async () => {
    mocks.quote.mockRejectedValue(new Error('offline'));
    expect(await quoteVideoCanvasRedo(CTX, 'shot')).toEqual({ ok: false, code: 'quote_failed' });
  });

  it('checks it on the service the user chose, as that service would make it', async () => {
    configure();
    addTake('rich');

    expect(await quoteVideoCanvasRedo(CTX, 'rich', 'h3')).toMatchObject({ ok: true, sufficient: true });

    const [intents, , , route] = mocks.quote.mock.calls[0];
    expect(route).toBe('h3');
    expect(intents[0]).toMatchObject({ kind: 'video', ratio: '9:16', resolution: '768p', duration: 8, generate_audio: true });
  });

  it('checks it where the take was made when no service is chosen', async () => {
    configure();
    addTake('rich', { model: 'minimax/MiniMax-H3-Lite' });
    await quoteVideoCanvasRedo(CTX, 'rich');
    expect(mocks.quote.mock.calls[0][3]).toBe('h3');
  });

  

  it('checks nothing on a service that cannot make it, or one not configured', async () => {
    configure();
    addTake('many', { request: { reference_image_paths: ['ad/media/a.png', 'ad/media/a.png'] } });
    expect(await quoteVideoCanvasRedo(CTX, 'many', 'vidu')).toEqual({ ok: false, code: 'unsupported' });
    expect(await quoteVideoCanvasRedo(CTX, 'many', 'removed')).toEqual({ ok: false, code: 'route_unavailable' });
    expect(mocks.quote).not.toHaveBeenCalled();
  });
});

describe('making a shot again', () => {
  const start = (overrides: Record<string, unknown> = {}) => startVideoCanvasRedo({
    ctx: CTX,
    asset: 'shot',
    isBusy: () => false,
    ...overrides,
  });

  function succeedWith(assetId: string, extra: Record<string, unknown> = {}) {
    mocks.videoExecute.mockImplementation(async (input: Record<string, unknown>) => {
      const ledger = ledgerOf();
      // A still, so taking its place in the scene needs no real clip to measure.
      ledger.push({ id: assetId, kind: 'image', label: input.label, path: `gen/${assetId}.png`, origin: 'generated', shot: input.shot });
      write(`ad/gen/${assetId}.png`);
      write('ad/assets.json', JSON.stringify({ assets: ledger }));
      return { content: [JSON.stringify({ asset_id: assetId, ...extra }), 'Video written.'].join('\n') };
    });
  }

  it.each([UID, 'next-user', null])('rechecks account %s after the real pending-request read before admitting a paid redo', async nextUser => {
    succeedWith('after-budget-read');
    const beforeLedger = fs.readFileSync(path.join(workspace, 'ad/assets.json'), 'utf8');
    const read = (await vi.importActual<typeof fsp>('node:fs/promises')).readFile;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let intercepted = false;
    vi.mocked(fsp.readFile).mockImplementation(async (...args: Parameters<typeof read>) => {
      if (!intercepted && String(args[0]).includes(path.join('video_studio', 'requests'))) {
        intercepted = true; entered(); await resume;
      }
      return read(...args);
    });
    const started = start();
    try {
      await Promise.race([paused, until(() => intercepted)]);
      account.uid = nextUser;
      if (nextUser !== UID) notifyUserSwitch(UID, nextUser);
    } finally { release(); }
    const result = await started;
    if (nextUser === UID) {
      expect(result).toEqual({ ok: true });
      await until(() => !!lastOf('done', 'redo'));
      expect(mocks.quote).toHaveBeenCalledTimes(1);
      expect(mocks.videoExecute).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toEqual({ ok: false, code: 'not_found' });
      expect(mocks.quote).not.toHaveBeenCalled();
      expect(mocks.videoExecute).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(videoCanvasJobs(UID, CID)).toEqual([]);
      expect(fs.readFileSync(path.join(workspace, 'ad/assets.json'), 'utf8')).toBe(beforeLedger);
    }
  });

  // A framed take's first frame is read before its request is planned (2026-11-11, with the check
  // above): an account change during that read admits nothing either.
  it.each([UID, 'next-user', null])('rechecks account %s after reading the first frame before admitting a paid redo', async nextUser => {
    succeedWith('after-frame-read');
    let release: (() => void) | undefined;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    frameRead.hold = () => new Promise<void>(resolve => { release = resolve; entered(); });
    const started = start({ inputs: { method: 'frames' } });
    try {
      await Promise.race([paused, started]);
      expect(release).toBeDefined();
      account.uid = nextUser;
      if (nextUser !== UID) notifyUserSwitch(UID, nextUser);
    } finally { release?.(); }
    const result = await started;
    if (nextUser === UID) {
      expect(result).toEqual({ ok: true });
      await until(() => !!lastOf('done', 'redo'));
      expect(mocks.quote).toHaveBeenCalledTimes(1);
      expect(mocks.videoExecute).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toEqual({ ok: false, code: 'not_found' });
      expect(mocks.quote).not.toHaveBeenCalled();
      expect(mocks.videoExecute).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    }
  });

  it('runs the Agent\'s tool as a new request, for this shot', async () => {
    succeedWith('new');
    expect(await start()).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));

    const [input, context] = mocks.videoExecute.mock.calls[0];
    expect(input).toMatchObject({
      prompt: 'pour juice',
      duration: 8,
      reference_image_paths: ['ad/media/a.png'],
      production_dir: path.join(workspace, 'ad'),
      shot: 'pour',
      label: 'Pour',
    });
    expect(input.output_path).toMatch(/gen[\\/]shot-redo-\d+\.mp4$/);
    expect(input.output_path).not.toBe(path.join(workspace, 'ad/gen/shot.mp4'));
    expect(context.workingDir).toBe(workspace);
    expect(mocks.videoToolOpts[0]).toMatchObject({ userId: UID, cid: CID, agentId: '79df9cc89f5f' });
  });

  it('asks for a different path each time, so a repeat is never the old paid file', async () => {
    succeedWith('new');
    await start();
    await until(() => !!lastOf('done', 'redo'));
    await new Promise((resolve) => { setTimeout(resolve, 2); });
    events.length = 0;
    await start();
    await until(() => !!lastOf('done', 'redo'));

    const [first, second] = mocks.videoExecute.mock.calls.map(([input]) => input.output_path);
    expect(first).not.toBe(second);
  });

  it('puts the new take where the shot was shown, in every video, and renders nothing', async () => {
    write('ad/videos/other/manifest.json', JSON.stringify({ ...manifestOf(), id: 'other', label: 'Other' }));
    succeedWith('new');
    await start();
    await until(() => !!lastOf('done', 'redo'));

    expect(manifestOf().scenes[0].clips[0]).toMatchObject({ id: 'c1', asset: 'new' });
    expect(manifestOf('other').scenes[0].clips[0]).toMatchObject({ id: 'c1', asset: 'new' });
    expect(lastOf('done', 'redo')).toMatchObject({ shot: 'shot:pour', asset_id: 'new', swapped: true });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('stops an update in progress of a video the new take goes into', async () => {
    mocks.render.mockImplementation(({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ ok: false, op: 'video.render', errorCode: 'E_RENDER_ABORTED', message: 'aborted' }));
    }));
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    await until(() => mocks.render.mock.calls.length === 1);
    succeedWith('new');
    await start();
    await until(() => !!lastOf('done', 'redo'));

    expect((mocks.render.mock.calls[0][0].signal as AbortSignal).aborted).toBe(true);
    expect(lastOf('stopped')).toMatchObject({ video_id: 'main' });
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
    expect(mocks.ship).not.toHaveBeenCalled();
  });

  it('passes no hosted spending grants into a configured-service call',async()=>{succeedWith('new');await start();await until(()=>!!lastOf('done','redo'));expect(mocks.videoToolOpts[0]).not.toHaveProperty('confirmedSpend');});

  it('says who paid when the user\'s own service made it', async () => {
    mocks.quote.mockResolvedValue(quote({
      sufficient: true,
      externally_billed_segment_ids: ['request'],
    }));
    succeedWith('new', { billed_to_own_key: true });
    await start();
    await until(() => !!lastOf('done', 'redo'));

    expect(lastOf('done', 'redo')).toMatchObject({ own_key: true });
  });

  it('sends nothing when no configured service can make it', async () => {
    mocks.quote.mockResolvedValue(quote({ sufficient: false, externally_billed_segment_ids: [], unavailable_segment_ids: ['request'] }));

    expect(await start()).toEqual({ ok: false, code: 'route_unavailable' });
    expect(mocks.videoExecute).not.toHaveBeenCalled();
  });

  it('refuses a second confirmation while the first is still being checked', async () => {
    let answer: (value: unknown) => void = () => {};
    mocks.quote.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    succeedWith('new');
    const first = start();
    expect(await start()).toEqual({ ok: false, code: 'in_progress' });
    await until(() => mocks.quote.mock.calls.length === 1);
    answer(quote());
    expect(await first).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));
    expect(mocks.videoExecute).toHaveBeenCalledTimes(1);
  });

  it('lets the user try again after a refusal', async () => {
    mocks.quote.mockResolvedValueOnce(quote({ sufficient: false, externally_billed_segment_ids: [], unavailable_segment_ids: ['request'] }));
    expect(await start()).toMatchObject({ ok: false, code: 'route_unavailable' });
    succeedWith('new');
    expect(await start()).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));
  });

  it('leaves a scene alone if it changed while the shot was being made', async () => {
    write('ad/assets.json', JSON.stringify({ assets: [
      ...ledgerOf(),
      { id: 'b', kind: 'image', label: 'B', path: 'media/a.png', origin: 'upload' },
    ] }));
    write('ad/videos/main/manifest.json', JSON.stringify({
      ...manifestOf(),
      scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'shot', in: 0, dur: 3 }] }],
    }));
    succeedWith('new');
    const made = mocks.videoExecute.getMockImplementation() as (input: Record<string, unknown>) => Promise<unknown>;
    mocks.videoExecute.mockImplementation(async (input: Record<string, unknown>) => {
      // An Agent turn, or the user, changed this scene and finished first.
      write('ad/videos/main/manifest.json', JSON.stringify({
        ...manifestOf(),
        scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'b', in: 0, dur: 3 }] }],
      }));
      return made(input);
    });

    await start();
    await until(() => !!lastOf('done', 'redo'));

    expect(lastOf('done', 'redo')).toMatchObject({ asset_id: 'new', swapped: false });
    expect(manifestOf().scenes[0].clips[0].asset).toBe('b');
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('keeps a result it saved outside the production reachable by saving the new one inside', async () => {
    write('elsewhere/far.mp4');
    write('ad/assets.json', JSON.stringify({ assets: [
      ...ledgerOf(),
      { id: 'far', kind: 'video', label: 'Far', path: '../elsewhere/far.mp4', origin: 'generated', shot: 'far', request: { prompt: 'far away' } },
    ] }));
    succeedWith('new');

    await start({ asset: 'far' });
    await until(() => !!lastOf('done', 'redo'));

    const [input] = mocks.videoExecute.mock.calls[0];
    expect(input.output_path).toContain(path.join(workspace, 'ad', 'shots'));
  });

  it('sends nothing while the Agent works', async () => {
    expect(await start({ isBusy: () => true })).toEqual({ ok: false, code: 'busy' });
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it('refuses a second request for a shot already being made', async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.videoExecute.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await start();
    await until(() => mocks.videoExecute.mock.calls.length === 1);

    expect(await start()).toEqual({ ok: false, code: 'in_progress' });
    expect(mocks.videoExecute).toHaveBeenCalledTimes(1);
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([
      expect.objectContaining({ kind: 'redo', status: 'running', shot: 'shot:pour', phase: 'generate' }),
    ]);

    finish({ content: 'E_PATH_OUT_OF_SCOPE: nope', isError: true });
    await until(() => !!lastOf('failed', 'redo'));
  });

  it('leaves the timeline alone when the Agent started while the shot was being made', async () => {
    let busy = false;
    succeedWith('new');
    const made = mocks.videoExecute.getMockImplementation() as (input: Record<string, unknown>) => Promise<unknown>;
    mocks.videoExecute.mockImplementation(async (input: Record<string, unknown>) => {
      busy = true;
      return made(input);
    });
    await start({ isBusy: () => busy });
    await until(() => !!lastOf('done', 'redo'));

    expect(lastOf('done', 'redo')).toMatchObject({ asset_id: 'new', swapped: false });
    expect(manifestOf().scenes[0].clips[0].asset).toBe('shot');
    expect(ledgerOf().map((row: { id: string }) => row.id)).toContain('new');
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('keeps the new take on the shot\'s card when no video shows the shot', async () => {
    write('ad/videos/main/manifest.json', JSON.stringify({ ...manifestOf(), scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'a', in: 0, dur: 3 }] }] }));
    succeedWith('new');
    await start();
    await until(() => !!lastOf('done', 'redo'));

    expect(lastOf('done', 'redo')).toMatchObject({ asset_id: 'new', swapped: false });
    expect(ledgerOf().map((row: { id: string }) => row.id)).toContain('new');
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it.each([
    ['a provider error', { content: '[CREDITS_EXHAUSTED] out', isError: true }, 'CREDITS_EXHAUSTED'],
    ['a plain refusal', { content: 'E_PATH_OUT_OF_SCOPE: nope', isError: true }, 'E_PATH_OUT_OF_SCOPE'],
    ['a tool that ends the turn without an asset', {
      content: JSON.stringify({ ok: false, errorCode: 'E_UNAVAILABLE', message: 'x' }),
      isError: false,
      synthesizeAndEndTurn: true,
    }, 'E_UNAVAILABLE'],
    ['a result that is not on the ledger', { content: `${JSON.stringify({ note: 'not recorded' })}\nVideo written.` }, 'E_CANVAS_REDO'],
  ])('reports %s and leaves the scene as it was', async (_label, result, code) => {
    mocks.videoExecute.mockResolvedValue(result);
    await start();
    await until(() => !!lastOf('failed', 'redo'));

    expect(lastOf('failed', 'redo')).toMatchObject({ code, shot: 'shot:pour' });
    expect(manifestOf().scenes[0].clips[0].asset).toBe('shot');
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('makes it with the words the user changed, keeping the rest of the call', async () => {
    succeedWith('new');
    expect(await start({ prompt: '  Pour orange juice slowly  ' })).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));

    expect(mocks.quote.mock.calls[0][0][0]).toMatchObject({ prompt: 'Pour orange juice slowly', duration: 8 });
    expect(mocks.videoExecute.mock.calls[0][0]).toMatchObject({
      prompt: 'Pour orange juice slowly', duration: 8, reference_image_paths: ['ad/media/a.png'], shot: 'pour', label: 'Pour',
    });
    expect(lastOf('done', 'redo')).toMatchObject({ changes: 'prompt' });
  });

  it('sends nothing for words that are empty', async () => {
    expect(await start({ prompt: '   ' })).toEqual({ ok: false, code: 'invalid' });
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.videoExecute).not.toHaveBeenCalled();
  });

  it('makes it on the service the user chose, asking only what that service can make', async () => {
    configure();
    addTake('rich');
    succeedWith('new');
    expect(await start({ asset: 'rich', choice: 'h3' })).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));

    expect(mocks.quote.mock.calls[0][3]).toBe('h3');
    expect(mocks.videoExecute.mock.calls[0][0]).toMatchObject({
      prompt: 'pour juice', ratio: '9:16', resolution: '768p', duration: 8, generate_audio: true, reference_image_paths: ['ad/media/a.png'],
    });
    expect(mocks.videoToolOpts[0]).toMatchObject({ videoRoute: 'h3' });
    expect(lastOf('done', 'redo')).toMatchObject({ shot: 'shot:rich', changes: 'model' });
  });

  

  it('goes back to the service that made the take when none is chosen', async () => {
    configure();
    addTake('rich', { model: 'minimax/MiniMax-H3-Lite', request: { resolution: '768p', generate_audio: true } });
    succeedWith('new');
    await start({ asset: 'rich' });
    await until(() => !!lastOf('done', 'redo'));

    expect(mocks.videoToolOpts[0]).toMatchObject({ videoRoute: 'h3' });
    expect(lastOf('done', 'redo')).toMatchObject({ changes: 'none' });
  });

  it('sends nothing on a service that cannot make the shot, or one not configured', async () => {
    configure();
    addTake('many', { request: { reference_image_paths: ['ad/media/a.png', 'ad/media/a.png'] } });

    expect(await start({ asset: 'many', choice: 'vidu' })).toEqual({ ok: false, code: 'unsupported' });
    expect(await start({ asset: 'many', choice: 'removed' })).toEqual({ ok: false, code: 'route_unavailable' });
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.videoExecute).not.toHaveBeenCalled();
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
  });

  it('blocks a pending shot across turns instead of replaying it with new words or another service',async()=>{configure();await reserveProductionRequest({userId:UID,scope:CID,fingerprint:'a'.repeat(64),kind:'video',production:{dir:path.join(workspace,'ad'),shot:'pour'}});succeedWith('new');expect(await quoteVideoCanvasRedo(CTX,'shot','h3')).toEqual({ok:false,code:'in_progress'});expect(await start({prompt:'something else',choice:'h3'})).toEqual({ok:false,code:'in_progress'});expect(mocks.quote).not.toHaveBeenCalled();expect(mocks.videoExecute).not.toHaveBeenCalled();expect(manifestOf().scenes[0].clips[0].asset).toBe('shot');});

  it('makes a still again with the words the user changed, on the service configured', async () => {
    configure();
    write('ad/gen/still.png');
    write('ad/assets.json', JSON.stringify({ assets: [
      ...ledgerOf(),
      { id: 'still', kind: 'image', label: 'Still', path: 'gen/still.png', origin: 'generated', request: { prompt: 'a lamp', size: '2k' } },
    ] }));
    mocks.imageExecute.mockImplementation(async () => {
      write('ad/assets.json', JSON.stringify({ assets: [
        ...ledgerOf(),
        { id: 'still-2', kind: 'image', label: 'Still', path: 'gen/still.png', origin: 'generated', shot: 'still' },
      ] }));
      return { content: `${JSON.stringify({ asset_id: 'still-2' })}\nImage written.` };
    });

    expect(await start({ asset: 'still', prompt: 'a brass lamp', choice: 'h3' })).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));

    expect(mocks.imageExecute.mock.calls[0][0]).toMatchObject({ prompt: 'a brass lamp', size: '2k' });
    expect(mocks.imageToolOpts[0]).not.toHaveProperty('videoRoute');
    expect(mocks.quote.mock.calls[0][3]).toBeUndefined();
  });

  it('reports a tool that throws', async () => {
    mocks.videoExecute.mockRejectedValue(new Error('boom'));
    await start();
    await until(() => !!lastOf('failed', 'redo'));

    expect(lastOf('failed', 'redo')?.code).toBe('E_CANVAS_REDO');
  });

  it('uses the image tool for a still', async () => {
    write('ad/gen/still.png');
    write('ad/assets.json', JSON.stringify({ assets: [
      ...ledgerOf(),
      { id: 'still', kind: 'image', label: 'Still', path: 'gen/still.png', origin: 'generated', request: { prompt: 'a lamp', size: '2k', reference_images: ['ad/media/a.png'] } },
    ] }));
    write('ad/videos/main/manifest.json', JSON.stringify({
      ...manifestOf(),
      scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'still', in: 0, dur: 3 }] }],
    }));
    mocks.imageExecute.mockImplementation(async () => {
      write('ad/assets.json', JSON.stringify({ assets: [
        ...ledgerOf(),
        { id: 'still-2', kind: 'image', label: 'Still', path: 'gen/still.png', origin: 'generated', shot: 'still' },
      ] }));
      return { content: `${JSON.stringify({ asset_id: 'still-2' })}\nImage written.` };
    });

    expect(await start({ asset: 'still' })).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));

    expect(mocks.quote.mock.calls[0][0][0]).toMatchObject({
      kind: 'image',
      size: '2k',
      reference_images: [path.join(workspace, 'ad/media/a.png')],
    });
    expect(mocks.imageExecute.mock.calls[0][0].output_path).toMatch(/still-redo-\d+\.png$/);
    expect(mocks.videoExecute).not.toHaveBeenCalled();
    expect(manifestOf().scenes[0].clips[0].asset).toBe('still-2');
  });
});


// Decided 2026-11-10 (plan 27.20): the shot panel adds footage to a take, as TapNow does. A video
// take is made from references, or opens and ends on frames; switching moves every input, the
// take's own and the added ones, in order. A still takes images only, up to the tool's four.
describe('adding footage to a take', () => {
  const abs = (relative: string) => path.join(workspace, 'ad', relative);
  beforeEach(() => {
    for (const file of ['media/b.png', 'media/c.png', 'media/d.png', 'media/e.png', 'media/clip.mp4', 'media/voice.mp3', 'gen/still.png']) write(`ad/${file}`);
    write('ad/assets.json', JSON.stringify({ assets: [
      ...ledgerOf(),
      { id: 'b', kind: 'image', label: 'B', path: 'media/b.png', origin: 'upload' },
      { id: 'c', kind: 'image', label: 'C', path: 'media/c.png', origin: 'upload' },
      { id: 'd', kind: 'image', label: 'D', path: 'media/d.png', origin: 'upload' },
      { id: 'e', kind: 'image', label: 'E', path: 'media/e.png', origin: 'upload' },
      { id: 'clip', kind: 'video', label: 'Clip', path: 'media/clip.mp4', origin: 'upload' },
      { id: 'voice', kind: 'audio', label: 'Voice', path: 'media/voice.mp3', origin: 'upload' },
    ] }));
  });
  const redo = (asset: string, extra: Record<string, unknown> = {}) => startVideoCanvasRedo({ ctx: CTX, asset, isBusy: () => false, ...extra });
  function succeed(assetId = 'new') {
    const respond = async (input: Record<string, unknown>) => {
      write(`ad/gen/${assetId}.png`);
      write('ad/assets.json', JSON.stringify({ assets: [
        ...ledgerOf(),
        { id: assetId, kind: 'image', label: input.label, path: `gen/${assetId}.png`, origin: 'generated', shot: input.shot },
      ] }));
      return { content: `${JSON.stringify({ asset_id: assetId })}\nWritten.` };
    };
    mocks.videoExecute.mockImplementation(respond);
    mocks.imageExecute.mockImplementation(respond);
  }
  function addStill(request: Record<string, unknown>) {
    write('ad/assets.json', JSON.stringify({ assets: [
      ...ledgerOf(),
      { id: 'still', kind: 'image', label: 'Still', path: 'gen/still.png', origin: 'generated', shot: 'still', request: { prompt: 'a lamp', ...request } },
    ] }));
  }
  const reasons = async (asset: string, inputs?: unknown) => {
    const options = await videoCanvasRedoOptions(CTX, asset, inputs);
    if (!options.ok) throw new Error('no options');
    return Object.fromEntries(options.choices.map((choice) => [choice.id, choice.unavailable ?? null]));
  };

  it('says which services take frames, and whether the inputs could be frames', async () => {
    mocks.candidates = [
      { entry: SERVICES.doubao },
      { entry: { id: 'flash', provider: 'kling', model: 'kling-v4-0-flash', apiKey: 'fixture-key' } },
      { entry: { id: 'omni', provider: 'google', model: 'gemini-omni-1.1-flash', apiKey: 'fixture-key' } },
    ];
    addTake('rich');

    const options = await videoCanvasRedoOptions(CTX, 'rich');
    if (!options.ok) throw new Error('no options');
    expect(options).toMatchObject({ method: 'references', frames_fit: true });
    expect(options.choices.map((choice) => [choice.id, choice.frames])).toEqual([['doubao', 'first_last'], ['flash', 'first'], ['omni', 'none']]);
    expect(await videoCanvasRedoOptions(CTX, 'rich', { added: ['b'] })).toMatchObject({ frames_fit: true });
    // A video, or a third image, cannot open or end a video.
    expect(await videoCanvasRedoOptions(CTX, 'rich', { added: ['clip'] })).toMatchObject({ frames_fit: false });
    expect(await videoCanvasRedoOptions(CTX, 'rich', { added: ['b', 'c'] })).toMatchObject({ frames_fit: false });
  });

  it('starts a take that opened on a frame from frames, and offers an edit no choice of method', async () => {
    configure('doubao');
    addTake('framed', { request: { reference_image_paths: [], first_frame: 'ad/media/a.png' } });
    addTake('edit', { request: { operation: 'edit', reference_image_paths: [], reference_video_paths: ['ad/media/clip.mp4'] } });

    expect(await videoCanvasRedoOptions(CTX, 'framed')).toMatchObject({ method: 'frames', frames_fit: true });
    const edit = await videoCanvasRedoOptions(CTX, 'edit');
    expect(edit).toMatchObject({ ok: true });
    expect(edit).not.toHaveProperty('method');
    expect(edit).not.toHaveProperty('frames_fit');
    // An edit keeps its source's shape and length: only sharpness and sound are offered.
    if (!edit.ok) throw new Error('no options');
    expect(edit.choices[0]).toMatchObject({ ratios: [], durations: [], resolutions: ['480p', '720p', '1080p'], silent: true });
  });

  it('greys every service out when frames are asked for with inputs that cannot be frames', async () => {
    configure('doubao', 'kling');
    addTake('rich');
    addTake('bare', { request: { reference_image_paths: [] } });

    const none = { doubao: { code: 'frames_inputs' }, kling: { code: 'frames_inputs' } };
    expect(await reasons('rich', { method: 'frames', added: ['b', 'c'] })).toEqual(none);
    expect(await reasons('rich', { method: 'frames', added: ['clip'] })).toEqual(none);
    expect(await reasons('bare', { method: 'frames' })).toEqual(none);
    expect(await reasons('rich', { method: 'frames', added: ['b'] })).toEqual({ doubao: null, kling: null });
  });

  it('makes it with the footage the user added, after its own', async () => {
    configure('doubao');
    addTake('rich');
    succeed();

    expect(await redo('rich', { inputs: { added: ['b', 'clip'] } })).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));

    const [input] = mocks.videoExecute.mock.calls[0];
    expect(input.reference_image_paths).toEqual(['ad/media/a.png', abs('media/b.png')]);
    expect(input.reference_video_paths).toEqual([abs('media/clip.mp4')]);
    expect(input).not.toHaveProperty('first_frame');
    expect(lastOf('done', 'redo')).toMatchObject({ shot: 'shot:rich', changes: 'none', added_refs: 2 });
  });

  it('checks the footage the user added', async () => {
    configure('doubao');
    addTake('rich');

    expect(await quoteVideoCanvasRedo(CTX, 'rich', 'doubao', { added: ['b'] })).toMatchObject({ ok: true });

    expect(mocks.quote.mock.calls[0][0][0]).toMatchObject({ reference_image_paths: [abs('media/a.png'), abs('media/b.png')] });
  });

  it('opens and ends on the inputs in order once the user picks frames', async () => {
    configure('doubao');
    addTake('rich');
    succeed();

    expect(await redo('rich', { inputs: { method: 'frames', added: ['b'] } })).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));

    const [input] = mocks.videoExecute.mock.calls[0];
    expect(input).toMatchObject({ first_frame: 'ad/media/a.png', last_frame: abs('media/b.png'), ratio: '9:16' });
    expect(input).not.toHaveProperty('reference_image_paths');
    expect(lastOf('done', 'redo')).toMatchObject({ added_refs: 1 });
  });

  it('leaves the shape to the first frame where the service takes it from there', async () => {
    // MiniMax H3 does; H3 Lite does not (next case).
    mocks.candidates = [{ entry: { id: 'h3', provider: 'minimax', model: 'MiniMax-H3', apiKey: 'fixture-key' } }];
    writePicture('ad/media/a.png', 480, 864);
    addTake('rich', { model: 'minimax/MiniMax-H3' });
    succeed();

    const options = await videoCanvasRedoOptions(CTX, 'rich', { method: 'frames' });
    if (!options.ok) throw new Error('no options');
    expect(options.choices[0]).toMatchObject({ id: 'h3', ratios: ['adaptive'], params: { ratio: 'adaptive', resolution: '768p', duration: 8, audio: true } });
    expect(options.choices[0]).not.toHaveProperty('unavailable');
    expect(await redo('rich', { inputs: { method: 'frames' } })).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));

    const [input] = mocks.videoExecute.mock.calls[0];
    expect(input).toMatchObject({ first_frame: 'ad/media/a.png' });
    expect(input).not.toHaveProperty('ratio');
  });

  // Decided 2026-11-10 after real H3 Lite tasks made a 480x864 first frame 864x480: Lite makes the
  // ratio it is asked for, so a framed take that left its shape to the frame asks it for the shape
  // nearest that frame, whatever the production's videos are.
  it('asks a service that keeps no frame\'s shape for the shape nearest the first frame', async () => {
    configure('h3');
    writePicture('ad/media/tall.png', 480, 864);
    writePicture('ad/media/wide.png', 1536, 1024);
    // Made on Lite before this, with no ratio, and on Seedance, where it followed the frame.
    addTake('tall', { model: 'minimax/MiniMax-H3-Lite', request: { ratio: undefined, reference_image_paths: [], first_frame: 'ad/media/tall.png' } });
    addTake('wide', { request: { ratio: 'adaptive', reference_image_paths: [], first_frame: 'ad/media/wide.png' } });
    succeed();

    const choiceOf = async (asset: string) => {
      const options = await videoCanvasRedoOptions(CTX, asset);
      if (!options.ok) throw new Error('no options');
      return options.choices.find((choice) => choice.id === 'h3');
    };
    expect(await choiceOf('tall')).toMatchObject({ ratios: CONCRETE_RATIOS, params: { ratio: '9:16' } });
    // 3:2 is nearer 4:3 than 16:9; the production's portrait videos do not decide it.
    expect(await choiceOf('wide')).toMatchObject({ ratios: CONCRETE_RATIOS, params: { ratio: '4:3' } });

    expect(await redo('tall')).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));
    expect(mocks.videoExecute.mock.calls[0][0]).toMatchObject({ first_frame: 'ad/media/tall.png', ratio: '9:16' });
    expect(await redo('wide', { choice: 'h3' })).toEqual({ ok: true });
    await until(() => events.filter(event => event.status === 'done' && event.kind === 'redo').length === 2);
    expect(mocks.videoExecute).toHaveBeenCalledTimes(2);
    expect(mocks.videoExecute.mock.calls[1][0]).toMatchObject({ first_frame: 'ad/media/wide.png', ratio: '4:3' });
  });

  it('leaves the shape to the service when the first frame cannot be read, or there is none', async () => {
    configure('h3');
    // The fixture's a.png holds no picture.
    addTake('unread', { model: 'minimax/MiniMax-H3-Lite', request: { ratio: undefined, reference_image_paths: [], first_frame: 'ad/media/a.png' } });
    addTake('plain', { model: 'minimax/MiniMax-H3-Lite', request: { ratio: undefined } });
    succeed();

    for (const asset of ['unread', 'plain']) {
      const options = await videoCanvasRedoOptions(CTX, asset);
      if (!options.ok) throw new Error('no options');
      // What the service makes when asked for none.
      expect(options.choices[0]).toMatchObject({ id: 'h3', params: { ratio: '16:9' } });
    }
    expect(await redo('unread')).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));
    expect(mocks.videoExecute.mock.calls[0][0]).not.toHaveProperty('ratio');
  });

  it('turns frames back into references, in order', async () => {
    configure('doubao');
    addTake('framed', { request: { reference_image_paths: [], first_frame: 'ad/media/a.png', last_frame: 'ad/media/b.png' } });
    succeed();

    expect(await redo('framed', { inputs: { method: 'references' } })).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));

    const [input] = mocks.videoExecute.mock.calls[0];
    expect(input.reference_image_paths).toEqual(['ad/media/a.png', 'ad/media/b.png']);
    expect(input).not.toHaveProperty('first_frame');
    expect(input).not.toHaveProperty('last_frame');
    expect(lastOf('done', 'redo')).toMatchObject({ added_refs: 0 });
  });

  it.each([
    ['footage not on this production', { added: ['missing'] }],
    ['sound', { added: ['voice'] }],
    ['a list that is not one', { added: 'b' }],
    ['more than the panel can add', { added: Array.from({ length: 31 }, () => 'b') }],
    ['a way of making it that does not exist', { method: 'sideways' }],
  ])('refuses %s before pricing anything', async (_label, inputs) => {
    configure('doubao');
    addTake('rich');

    expect(await quoteVideoCanvasRedo(CTX, 'rich', 'doubao', inputs)).toEqual({ ok: false, code: 'invalid' });
    expect(await redo('rich', { inputs })).toEqual({ ok: false, code: 'invalid' });
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.videoExecute).not.toHaveBeenCalled();
  });

  it('refuses frames for an edit', async () => {
    configure('doubao');
    addTake('edit', { request: { operation: 'edit', reference_image_paths: [], reference_video_paths: ['ad/media/clip.mp4'] } });
    expect(await quoteVideoCanvasRedo(CTX, 'edit', 'doubao', { method: 'frames' })).toEqual({ ok: false, code: 'invalid' });
  });

  it('adds images to a still, up to the four the image tool takes, and no video or frames', async () => {
    configure();
    addStill({ reference_images: ['ad/media/a.png'] });

    expect(await videoCanvasRedoOptions(CTX, 'still', { added: ['b', 'c', 'd'] })).toEqual({ ok: true, choices: [], current: '' });
    expect(await videoCanvasRedoOptions(CTX, 'still', { added: ['b', 'c', 'd', 'e'] }))
      .toEqual({ ok: true, choices: [], current: '', unavailable: { code: 'images', max: 4 } });
    expect(await quoteVideoCanvasRedo(CTX, 'still', undefined, { added: ['b', 'c', 'd', 'e'] })).toEqual({ ok: false, code: 'unsupported' });
    expect(await quoteVideoCanvasRedo(CTX, 'still', undefined, { added: ['clip'] })).toEqual({ ok: false, code: 'invalid' });
    expect(await quoteVideoCanvasRedo(CTX, 'still', undefined, { method: 'frames' })).toEqual({ ok: false, code: 'invalid' });
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it('makes a still with the added images, keeping what each reference is for', async () => {
    configure();
    addStill({
      reference_images: ['ad/media/a.png'],
      reference_image_urls: ['https://images.example/style.png'],
      reference_bindings: [{ index: 0, role: 'identity' }, { index: 1, role: 'style' }],
    });
    succeed('still-2');

    expect(await redo('still', { inputs: { added: ['b'] } })).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'redo'));

    expect(mocks.quote.mock.calls[0][0][0]).toMatchObject({ kind: 'image', reference_images: [abs('media/a.png'), abs('media/b.png')] });
    expect(mocks.imageExecute.mock.calls[0][0]).toMatchObject({
      reference_images: ['ad/media/a.png', abs('media/b.png')],
      reference_image_urls: ['https://images.example/style.png'],
      // The style reference now comes after two images, not one.
      reference_bindings: [{ index: 0, role: 'identity' }, { index: 2, role: 'style' }],
    });
    expect(lastOf('done', 'redo')).toMatchObject({ added_refs: 1 });
  });
});

// Decided 2026-11-10 (plan 27.20): a line drawn from footage or a shot makes a new shot, as TapNow
// does. It uses the same configured-service admission as making a shot again, through the Agent's own
// tool, and becomes a shot card where it stood. It goes into no video.
describe('making a new shot', () => {
  const abs = (relative: string) => path.join(workspace, 'ad', relative);
  beforeEach(() => {
    for (const file of ['media/b.png', 'media/c.png', 'media/d.png', 'media/e.png', 'media/clip.mp4']) write(`ad/${file}`);
    write('ad/assets.json', JSON.stringify({ assets: [
      ...ledgerOf(),
      { id: 'b', kind: 'image', label: 'B', path: 'media/b.png', origin: 'upload' },
      { id: 'c', kind: 'image', label: 'C', path: 'media/c.png', origin: 'upload' },
      { id: 'd', kind: 'image', label: 'D', path: 'media/d.png', origin: 'upload' },
      { id: 'e', kind: 'image', label: 'E', path: 'media/e.png', origin: 'upload' },
      { id: 'clip', kind: 'video', label: 'Clip', path: 'media/clip.mp4', origin: 'upload' },
    ] }));
  });
  const change = (next: VideoCanvasDraftChange) => applyVideoCanvasDraftChange({ uid: UID, cid: CID, dir: 'ad', change: next });
  async function draft(fields: Record<string, unknown> = {}, type: 'video' | 'image' = 'video'): Promise<string> {
    const made = await change({ kind: 'create', type, inputs: ['b'], at: { x: 400, y: 120 } });
    if (!made.ok) throw new Error(`no draft: ${made.code}`);
    if (Object.keys(fields).length) {
      const updated = await change({ kind: 'update', id: made.id, ...fields } as VideoCanvasDraftChange);
      if (!updated.ok) throw new Error(`not updated: ${updated.code}`);
    }
    return made.id;
  }
  const canvasFile = () => JSON.parse(fs.readFileSync(path.join(workspace, 'ad', 'canvas.json'), 'utf8'));
  const generate = (id: string, isBusy = () => false) => startVideoCanvasDraft({ ctx: CTX, id, isBusy });
  const choicesOf = async (id: string) => {
    const options = await videoCanvasDraftOptions(CTX, id);
    if (!options.ok || options.kind !== 'video') throw new Error('no options');
    return { options, byId: Object.fromEntries(options.choices.map((choice) => [choice.id, choice])) };
  };
  function succeed(assetId = 'made') {
    const respond = async (input: Record<string, unknown>) => {
      write('ad/assets.json', JSON.stringify({ assets: [
        ...ledgerOf(),
        { id: assetId, kind: 'video', label: input.label, path: 'gen/shot.mp4', origin: 'generated', shot: input.shot },
      ] }));
      return { content: `${JSON.stringify({ asset_id: assetId })}\nWritten.` };
    };
    mocks.videoExecute.mockImplementation(respond);
    mocks.imageExecute.mockImplementation(respond);
  }
  const veo = () => ({
    id: 'veo',
    provider: 'google-cloud',
    model: 'veo-3.1-fast-generate-001',
    apiKey: JSON.stringify({
      type: 'service_account',
      project_id: 'video-project',
      client_email: 'video@video-project.iam.gserviceaccount.com',
      private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
  });
  const CONCRETE = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];

  it('does not silently replace a configured model removed after it was selected', async () => {
    configure('doubao', 'h3');
    const id = await draft({ prompt: 'pour juice', choice: 'h3' });
    expect(await videoCanvasDraftOptions(CTX, id)).toMatchObject({ ok: true, current: 'h3' });

    configure('doubao');
    expect(await videoCanvasDraftOptions(CTX, id)).toMatchObject({ ok: true, current: '', unavailable: { code: 'other' } });
    expect(await quoteVideoCanvasDraft(CTX, id)).toEqual({ ok: false, code: 'route_unavailable' });
    expect(await generate(id)).toEqual({ ok: false, code: 'route_unavailable' });
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.videoExecute).not.toHaveBeenCalled();
  });

  it.each([UID, 'next-user', null])('rechecks draft account %s after the real pending-request read', async nextUser => {
    configure('doubao');
    const id = await draft({ prompt: 'pour juice' });
    succeed();
    const beforeLedger = fs.readFileSync(path.join(workspace, 'ad/assets.json'));
    const beforeCanvas = fs.readFileSync(path.join(workspace, 'ad/canvas.json'));
    const read = (await vi.importActual<typeof fsp>('node:fs/promises')).readFile;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let intercepted = false;
    vi.mocked(fsp.readFile).mockImplementation(async (...args: Parameters<typeof read>) => {
      if (!intercepted && String(args[0]).includes(path.join('video_studio', 'requests'))) {
        intercepted = true; entered(); await resume;
      }
      return read(...args);
    });
    const started = generate(id);
    try {
      await Promise.race([paused, until(() => intercepted)]);
      account.uid = nextUser;
      if (nextUser !== UID) notifyUserSwitch(UID, nextUser);
    } finally { release(); }
    const result = await started;
    if (nextUser === UID) {
      expect(result).toEqual({ ok: true });
      await until(() => !!lastOf('done', 'new_shot'));
      expect(mocks.quote).toHaveBeenCalledTimes(1);
      expect(mocks.videoExecute).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toEqual({ ok: false, code: 'not_found' });
      expect(mocks.quote).not.toHaveBeenCalled();
      expect(mocks.videoExecute).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(videoCanvasJobs(UID, CID)).toEqual([]);
      expect(fs.readFileSync(path.join(workspace, 'ad/assets.json'))).toEqual(beforeLedger);
      expect(fs.readFileSync(path.join(workspace, 'ad/canvas.json'))).toEqual(beforeCanvas);
    }
  });

  it.each(['missing file', 'removed ledger row', 'audio', 'video for still', 'escaping symlink'])
    ('refuses a draft with %s before pricing or generating a different shot', async mutation => {
      configure('doubao');
      const id = await draft({ prompt: 'preserve this reference' }, mutation === 'video for still' ? 'image' : 'video');
      const beforeCanvas = fs.readFileSync(path.join(workspace, 'ad/canvas.json'));
      if (mutation === 'missing file') fs.unlinkSync(abs('media/b.png'));
      else if (mutation === 'escaping symlink') {
        const outside = write('outside.png');
        fs.unlinkSync(abs('media/b.png'));
        fs.symlinkSync(outside, abs('media/b.png'));
      } else {
        const ledger = JSON.parse(fs.readFileSync(path.join(workspace, 'ad/assets.json'), 'utf8'));
        if (mutation === 'removed ledger row') ledger.assets = ledger.assets.filter((row: { id: string }) => row.id !== 'b');
        else ledger.assets.find((row: { id: string }) => row.id === 'b').kind = mutation === 'audio' ? 'audio' : 'video';
        write('ad/assets.json', JSON.stringify(ledger));
      }
      expect(await quoteVideoCanvasDraft(CTX, id)).toEqual({ ok: false, code: 'invalid' });
      expect(await generate(id)).toEqual({ ok: false, code: 'invalid' });
      expect(mocks.quote).not.toHaveBeenCalled();
      expect(mocks.imageExecute).not.toHaveBeenCalled();
      expect(mocks.videoExecute).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(fs.readFileSync(path.join(workspace, 'ad/canvas.json'))).toEqual(beforeCanvas);
    });

  it('accepts an intentionally reference-free draft and preserves a valid selected reference', async () => {
    configure('doubao');
    const empty = await draft({ prompt: 'a new shot', inputs: [] });
    expect(await quoteVideoCanvasDraft(CTX, empty)).toMatchObject({ ok: true });
    const selected = await draft({ prompt: 'use the supplied picture' });
    expect(await quoteVideoCanvasDraft(CTX, selected)).toMatchObject({ ok: true });
    expect(mocks.quote.mock.calls.at(-1)![0][0]).toMatchObject({ reference_image_paths: [abs('media/b.png')] });
  });

  it('offers each service with the shapes and lengths it can make, at the defaults decided', async () => {
    mocks.candidates = [
      { entry: SERVICES.doubao },
      { entry: veo() },
      { entry: { id: 'omni', provider: 'google', model: 'gemini-omni-1.1-flash', apiKey: 'fixture-key' } },
      { entry: SERVICES.orkas },
    ];
    const id = await draft({ prompt: 'pour juice' });

    const { options, byId } = await choicesOf(id);
    expect(options).toMatchObject({ kind: 'video', method: 'references', frames_fit: true, current: 'doubao' });
    // The production's videos are portrait, so the new shot is too.
    expect(byId.doubao).toMatchObject({ frames: 'first_last', ratios: CONCRETE, resolutions: ['480p', '720p', '1080p'], durations: [4, 5, 6, 8, 10, 12, 15], silent: true, params: { ratio: '9:16', resolution: '720p', duration: 5, audio: false } });
    expect(byId.veo).toMatchObject({ ratios: ['16:9', '9:16'], resolutions: ['720p', '1080p'], durations: [4, 6, 8], silent: true, params: { ratio: '9:16', resolution: '720p', duration: 8, audio: false } });
    // Omni times a video from its prompt, and cannot leave sound out.
    expect(byId.omni).toMatchObject({ frames: 'none', durations: [], silent: false, params: { ratio: '9:16', resolution: '720p', audio: true } });
    expect(byId.omni.params).not.toHaveProperty('duration');
    expect(byId.public).toMatchObject({
      ratios: CONCRETE, durations: [4, 5, 6, 8, 10, 12, 15], params: { ratio: '9:16', resolution: '720p', duration: 5, audio: false },
    });
    for (const choice of options.choices) expect(choice).not.toHaveProperty('unavailable');
  });

  // Decided 2026-11-10: a new shot on frames starts at its first frame's shape on every service,
  // kept by the service where it can ("Match first frame"), else the nearest shape it makes,
  // though the production's videos are portrait.
  it('starts a new shot on frames at the first frame\'s shape, kept by the service or the nearest it makes', async () => {
    writePicture('ad/media/wide.png', 1280, 720);
    write('ad/assets.json', JSON.stringify({ assets: [...ledgerOf(), { id: 'wide', kind: 'image', label: 'Wide', path: 'media/wide.png', origin: 'upload' }] }));
    const h3 = { id: 'h3full', provider: 'minimax', model: 'MiniMax-H3', apiKey: 'fixture-key' };
    mocks.candidates = [{ entry: SERVICES.doubao }, { entry: h3 }, { entry: SERVICES.h3 }, { entry: veo() }, { entry: SERVICES.orkas }];
    const id = await draft({ prompt: 'pour juice', method: 'frames', inputs: ['wide'] });

    const { byId } = await choicesOf(id);
    expect(byId.doubao).toMatchObject({ ratios: ['adaptive', ...CONCRETE], params: { ratio: 'adaptive' } });
    // MiniMax H3 takes its shape from the frame and nothing else.
    expect(byId.h3full).toMatchObject({ ratios: ['adaptive'], params: { ratio: 'adaptive' } });
    // H3 Lite and Veo make the shape they are asked for.
    expect(byId.h3).toMatchObject({ ratios: CONCRETE, params: { ratio: '16:9' } });
    expect(byId.veo).toMatchObject({ ratios: ['16:9', '9:16'], params: { ratio: '16:9' } });
    expect(byId.public).toMatchObject({ unavailable: { code: 'frames' } });

    mocks.candidates = [{ entry: SERVICES.h3 }];
    expect(await quoteVideoCanvasDraft(CTX, id)).toMatchObject({ ok: true });
    expect(mocks.quote.mock.calls[0][0][0]).toMatchObject({ ratio: '16:9' });
  });

  it('starts a new shot on frames at the production\'s shape when its first frame cannot be read', async () => {
    mocks.candidates = [{ entry: SERVICES.h3 }, { entry: veo() }];
    // The fixture's b.png holds no picture.
    const id = await draft({ prompt: 'pour juice', method: 'frames' });

    const { byId } = await choicesOf(id);
    expect(byId.h3).toMatchObject({ params: { ratio: '9:16' } });
    expect(byId.veo).toMatchObject({ params: { ratio: '9:16' } });
  });

  it('keeps the shape and length the user picked where a service offers them', async () => {
    mocks.candidates = [{ entry: SERVICES.doubao }, { entry: veo() }];
    const id = await draft({ prompt: 'pour juice', ratio: '1:1', duration: 10 });

    const { byId } = await choicesOf(id);
    expect(byId.doubao.params).toMatchObject({ ratio: '1:1', duration: 10 });
    // Veo offers neither, so it shows what it would make instead.
    expect(byId.veo.params).toMatchObject({ ratio: '9:16', duration: 8 });
  });

  // Decided 2026-11-10 (plan 27.21): a new shot keeps the user's sharpness and sound too; a service
  // that cannot make a setting makes the nearest one, and one that cannot leave sound out has it.
  it('keeps a new shot\'s settings where a service offers them, and the nearest otherwise', async () => {
    mocks.candidates = [{ entry: SERVICES.doubao }, { entry: veo() }, { entry: SERVICES.h3 }];
    const id = await draft({ prompt: 'pour juice', ratio: '21:9', duration: 12, resolution: '1080p', audio: true });

    const { byId } = await choicesOf(id);
    expect(byId.doubao.params).toEqual({ ratio: '21:9', resolution: '1080p', duration: 12, audio: true });
    // Veo makes neither 21:9 nor 12 seconds: the nearest of each.
    expect(byId.veo.params).toEqual({ ratio: '16:9', resolution: '1080p', duration: 8, audio: true });
    // H3 Lite makes 768p at most, and always with sound.
    expect(byId.h3.params).toEqual({ ratio: '21:9', resolution: '768p', duration: 12, audio: true });

    configure('doubao');
    expect(await quoteVideoCanvasDraft(CTX, id)).toMatchObject({ ok: true });
    expect(mocks.quote.mock.calls[0][0][0]).toMatchObject({ ratio: '21:9', resolution: '1080p', duration: 12, generate_audio: true });

    // Silence asked of a service that cannot leave sound out.
    mocks.candidates = [{ entry: SERVICES.h3 }];
    const quiet = await draft({ prompt: 'pour juice', audio: false });
    expect((await choicesOf(quiet)).byId.h3.params).toMatchObject({ audio: true });
  });

  it('greys out a service that cannot take its footage, and starts on one that can', async () => {
    mocks.candidates = [{ entry: SERVICES.vidu }, { entry: SERVICES.doubao }];
    const id = await draft({ prompt: 'pour juice', inputs: ['b', 'clip'] });

    const { options, byId } = await choicesOf(id);
    expect(byId.vidu.unavailable).toEqual({ code: 'videos', max: 0 });
    expect(options).toMatchObject({ current: 'doubao', frames_fit: false });
  });

  it('prices it on the service picked, as it would be made', async () => {
    configure('doubao');
    const id = await draft({ prompt: 'pour juice' });

    expect(await quoteVideoCanvasDraft(CTX, id)).toEqual({ ok: true, sufficient: true, own_key: true, external_billing_estimate_available: false });
    expect(mocks.quote.mock.calls[0][0][0]).toMatchObject({
      kind: 'video', prompt: 'pour juice', reference_image_paths: [abs('media/b.png')], ratio: '9:16', duration: 5, resolution: '720p', generate_audio: false,
    });
    expect(mocks.quote.mock.calls[0][3]).toBe('doubao');
  });

  // Preflight runs before the prompt is entered; the panel checks
  // for one before the words were written, and kept that refusal after they were.
  it('checks a new shot before its words are written, since they do not change availability', async () => {
    configure('doubao');
    const id = await draft();

    expect(await quoteVideoCanvasDraft(CTX, id)).toEqual({ ok: true, sufficient: true, own_key: true, external_billing_estimate_available: false });
    expect(mocks.quote.mock.calls[0][0][0]).toMatchObject({ kind: 'video', ratio: '9:16', duration: 5, resolution: '720p', generate_audio: false });
    expect(mocks.quote.mock.calls[0][3]).toBe('doubao');
    // Making it still waits for them.
    expect(await generate(id)).toEqual({ ok: false, code: 'invalid' });
    expect(mocks.quote).toHaveBeenCalledTimes(1);
    expect(mocks.videoExecute).not.toHaveBeenCalled();
  });

  it('makes it with the Agent\'s tool as a shot of its own, where the new shot stood, in no video', async () => {
    configure('doubao');
    const id = await draft({ prompt: 'pour juice slowly into a tall glass' });
    succeed();
    const before = JSON.stringify(manifestOf());

    expect(await generate(id)).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'new_shot'));

    const [input, context] = mocks.videoExecute.mock.calls[0];
    expect(input).toEqual({
      prompt: 'pour juice slowly into a tall glass',
      output_path: abs(`shots/${id}.mp4`),
      production_dir: path.join(workspace, 'ad'),
      shot: id,
      label: 'pour juice slowl',
      reference_image_paths: [abs('media/b.png')],
      ratio: '9:16',
      duration: 5,
      resolution: '720p',
      generate_audio: false,
    });
    expect(context.workingDir).toBe(workspace);
    expect(mocks.videoToolOpts[0]).toMatchObject({ videoRoute: 'doubao', agentId: '79df9cc89f5f' });
    expect(lastOf('done', 'new_shot')).toMatchObject({ shot: `draft:${id}`, asset_id: 'made', added_refs: 1 });
    // The new shot card takes the draft's place.
    expect(canvasFile().drafts ?? {}).toEqual({});
    expect(canvasFile().cards).toEqual({ [`shot:${id}`]: { x: 400, y: 120 } });
    expect(JSON.stringify(manifestOf())).toBe(before);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('keeps the new shot and says why when it could not be made', async () => {
    configure('doubao');
    const id = await draft({ prompt: 'pour juice' });
    mocks.videoExecute.mockResolvedValue({ content: '[CREDITS_EXHAUSTED] out', isError: true });

    expect(await generate(id)).toEqual({ ok: true });
    await until(() => !!lastOf('failed', 'new_shot'));

    expect(lastOf('failed', 'new_shot')).toMatchObject({ shot: `draft:${id}`, code: 'CREDITS_EXHAUSTED' });
    expect(Object.keys(canvasFile().drafts)).toEqual([id]);
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([
      expect.objectContaining({ kind: 'new_shot', status: 'failed', shot: `draft:${id}` }),
    ]);
  });

  it('sends nothing while the Agent works, without words, on a service that cannot make it, or without an available service', async () => {
    mocks.candidates = [{ entry: SERVICES.vidu }, { entry: SERVICES.doubao }];
    const wordless = await draft();
    const clip = await draft({ prompt: 'pour juice', inputs: ['clip'], choice: 'vidu' });
    const bare = await draft({ prompt: 'pour juice', inputs: [], method: 'frames', choice: 'doubao' });
    const ready = await draft({ prompt: 'pour juice', choice: 'doubao' });

    expect(await generate(ready, () => true)).toEqual({ ok: false, code: 'busy' });
    expect(await generate(wordless)).toEqual({ ok: false, code: 'invalid' });
    expect(await generate(clip)).toEqual({ ok: false, code: 'unsupported' });
    expect(await generate(bare)).toEqual({ ok: false, code: 'unsupported' });
    expect(await generate('missing')).toEqual({ ok: false, code: 'not_found' });
    expect(mocks.quote).not.toHaveBeenCalled();
    mocks.quote.mockResolvedValue(quote({ sufficient: false, externally_billed_segment_ids: [], unavailable_segment_ids: ['request'] }));
    expect(await generate(ready)).toEqual({ ok: false, code: 'route_unavailable' });
    expect(mocks.videoExecute).not.toHaveBeenCalled();
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
  });

  it('refuses a second confirmation while the new shot is being made', async () => {
    configure('doubao');
    const id = await draft({ prompt: 'pour juice' });
    let finish: (value: unknown) => void = () => {};
    mocks.videoExecute.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

    expect(await generate(id)).toEqual({ ok: true });
    await until(() => mocks.videoExecute.mock.calls.length === 1);
    expect(await generate(id)).toEqual({ ok: false, code: 'in_progress' });
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([
      expect.objectContaining({ kind: 'new_shot', status: 'running', shot: `draft:${id}`, phase: 'generate', added_refs: 1 }),
    ]);

    finish({ content: 'E_PATH_OUT_OF_SCOPE: nope', isError: true });
    await until(() => !!lastOf('failed', 'new_shot'));
  });

  it('keeps an unresolved draft and refuses a duplicate before checking or sending a new request',async()=>{configure('doubao');const id=await draft({prompt:'pour juice'});const before=fs.readFileSync(path.join(workspace,'ad/canvas.json'));await reserveProductionRequest({userId:UID,scope:CID,fingerprint:'b'.repeat(64),kind:'video',production:{dir:path.join(workspace,'ad'),shot:id}});expect(await quoteVideoCanvasDraft(CTX,id)).toEqual({ok:false,code:'in_progress'});expect(await generate(id)).toEqual({ok:false,code:'in_progress'});expect(mocks.quote).not.toHaveBeenCalled();expect(mocks.videoExecute).not.toHaveBeenCalled();expect(fs.readFileSync(path.join(workspace,'ad/canvas.json'))).toEqual(before);});

  it('makes an image with the image tool, from up to four images', async () => {
    configure('doubao');
    const id = await draft({ prompt: 'a brass lamp' }, 'image');
    succeed('still');

    expect(await videoCanvasDraftOptions(CTX, id)).toEqual({ ok: true, kind: 'image', choices: [], current: '' });
    expect(await generate(id)).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'new_shot'));

    expect(mocks.quote.mock.calls[0][0][0]).toMatchObject({ kind: 'image', prompt: 'a brass lamp', reference_images: [abs('media/b.png')] });
    expect(mocks.quote.mock.calls[0][3]).toBeUndefined();
    expect(mocks.imageExecute.mock.calls[0][0]).toEqual({
      prompt: 'a brass lamp',
      output_path: abs(`shots/${id}.png`),
      production_dir: path.join(workspace, 'ad'),
      shot: id,
      label: 'a brass lamp',
      reference_images: [abs('media/b.png')],
    });
    expect(mocks.videoExecute).not.toHaveBeenCalled();

    const many = await draft({ prompt: 'a brass lamp', inputs: ['a', 'b', 'c', 'd', 'e'] }, 'image');
    expect(await videoCanvasDraftOptions(CTX, many)).toEqual({ ok: true, kind: 'image', choices: [], current: '', unavailable: { code: 'images', max: 4 } });
    expect(await generate(many)).toEqual({ ok: false, code: 'unsupported' });
  });

  // On 2026-11-10 a still drawn from a portrait video's footage came back square.
  it('makes an image the shape of the production\'s videos, at a size its image service takes as asked', async () => {
    configure('doubao');
    const flash = 'doubao-seedream-5-0-flash-260915';
    mocks.imageCandidates = [{
      entry: { id: 'img', provider: 'doubao', model: flash, apiKey: 'fixture-key' },
      capability: { model: flash, api: 'doubao', supportsEdit: true },
    }];
    const id = await draft({ prompt: 'a brass lamp' }, 'image');
    succeed('still');

    expect(await generate(id)).toEqual({ ok: true });
    await until(() => !!lastOf('done', 'new_shot'));

    const { size } = mocks.imageExecute.mock.calls[0][0];
    const [width, height] = String(size).split('x').map(Number);
    // Portrait like the 1080×1920 videos, and not a size the service would resize or refuse.
    expect(width / height).toBeCloseTo(1080 / 1920, 2);
    expect(normaliseSeedreamSize(size, flash)).toBe(size);
    // Priced at the size it is made at.
    expect(mocks.quote.mock.calls[0][0][0]).toMatchObject({ kind: 'image', size });

    // A service that takes no shape makes it at its own default.
    mocks.imageCandidates = [{
      entry: { id: 'gpt', provider: 'openai', model: 'gpt-image-2', apiKey: 'fixture-key' },
      capability: { model: 'gpt-image-2', api: 'openai', supportsEdit: true },
    }];
    const plain = await draft({ prompt: 'a brass lamp' }, 'image');
    succeed('still-2');
    expect(await generate(plain)).toEqual({ ok: true });
    await until(() => events.filter((event) => event.status === 'done' && event.kind === 'new_shot').length === 2);
    expect(mocks.imageExecute.mock.calls[1][0]).not.toHaveProperty('size');
  });
});

describe('work arriving after account activation changed', () => {
  it.each(['next-user', null])('rejects a late old-account request with active identity %s', async (uid) => {
    notifyUserSwitch(UID, 'next-user');
    account.uid = uid;
    scheduleVideoCanvasRender(CTX, 'main', { delayMs: 0 });
    const priced = await quoteVideoCanvasRedo(CTX, 'shot');
    const redo = await startVideoCanvasRedo({ ctx: CTX, asset: 'shot', isBusy: () => false });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(priced).toEqual({ ok: false, code: 'not_found' });
    expect(redo).toEqual({ ok: false, code: 'not_found' });
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.videoExecute).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(videoCanvasJobs(UID, CID, { busy: false })).toEqual([]);
  });
});
