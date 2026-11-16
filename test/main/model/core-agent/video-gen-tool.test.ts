import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  generateVideo: vi.fn(),
  workspace: '',
  route: vi.fn(),
  quote: vi.fn(),
}));

vi.mock('../../../../src/main/features/app_media_route', () => ({ appTaskMediaRoute: h.route }));
vi.mock('../../../../src/main/features/video_production_services', async original => ({ ...await original(), checkVideoProductionServices: h.quote }));
vi.mock('../../../../src/main/features/video_gen', () => ({
  generateVideo: h.generateVideo,
}));
vi.mock('../../../../src/main/paths', async importOriginal => ({
  ...await importOriginal(),
  userLocalRoot: (uid: string) => path.join(h.workspace, '.local', uid),
}));
vi.mock('../../../../src/main/features/user_workspace', () => ({
  getWorkspacePath: () => h.workspace,
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createVideoGenTool } from '../../../../src/main/model/core-agent/video-gen-tool';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-open-video-tool-'));
  h.workspace = root;
  h.route.mockReset().mockResolvedValue(undefined);
  h.quote.mockReset().mockResolvedValue({ sufficient: true, externally_billed_segment_ids: ['request'], unavailable_segment_ids: [], external_billing_estimate_available: false, segments: [] });
  h.generateVideo.mockReset().mockImplementation(async ({ outputAbsPath }) => ({
    ok: true,
    path: outputAbsPath,
    bytes: 256,
    provider: 'orkas-api',
    model: 'orkas-video',
    taskId: 'video-test-task',
    videoUrl: 'https://cdn.example.test/video.mp4',
    status: 'succeeded',
  }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('generate_video tool in the open build', () => {
  it('dispatches the configured public provider and publishes an MP4 path', async () => {
    const published: string[] = [];
    const progress = vi.fn();
    const tool = createVideoGenTool({
      userId: 'user-a',
      cid: 'conv_123',
      turnId: 'turn-456',
      onFileWritten: (file) => published.push(file),
    });
    const result = await tool.execute(
      {
        prompt: 'a paper boat crosses a pond',
        output_path: 'clip.mov',
        duration: 6,
        quality: 'quality',
        generate_audio: false,
      },
      { workingDir: root, emitProgress: progress } as any,
    );

    expect(result.isError).not.toBe(true);
    expect(h.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a paper boat crosses a pond',
      outputAbsPath: path.join(root, 'clip.mp4'),
      duration: 6,
      quality: 'quality',
      generateAudio: false,
      usageContext: { conversationId: 'conv_123', turnId: 'turn-456' },
    }));
    expect(published).toEqual([path.join(root, 'clip.mp4')]);
    expect(String(result.content)).toContain('orkas-api/orkas-video');
    expect(String(result.content)).toContain('[video](');
  });

  it('rejects out-of-scope outputs and invalid edit requests before dispatch', async () => {
    const tool = createVideoGenTool({ userId: 'user-a' });
    const outside = await tool.execute(
      { prompt: 'a dot', output_path: path.join(root, '..', 'outside.mp4') },
      { workingDir: root } as any,
    );
    const missingReference = await tool.execute(
      { prompt: 'change the ending', output_path: 'edit.mp4', operation: 'edit' },
      { workingDir: root } as any,
    );

    expect(outside.isError).toBe(true);
    expect(String(outside.content)).toContain('E_PATH_OUT_OF_SCOPE');
    expect(missingReference.isError).toBe(true);
    expect(String(missingReference.content)).toContain('requires at least one reference video');
    expect(h.generateVideo).not.toHaveBeenCalled();
  });

  it('turns exhausted public API credits into a non-retry instruction', async () => {
    h.generateVideo.mockResolvedValueOnce({
      ok: false,
      errorCode: 'CREDITS_EXHAUSTED',
      message: 'quota exhausted',
    });
    const tool = createVideoGenTool({ userId: 'user-a' });
    const result = await tool.execute(
      { prompt: 'a quiet landscape', output_path: 'clip.mp4' },
      { workingDir: root } as any,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('E_CREDITS_EXHAUSTED');
    expect(String(result.content)).toContain('Do not retry');
  });
});

const studioId = '79df9cc89f5f';
function studioTool() { return createVideoGenTool({ userId: 'test-video-owner', agentId: studioId, cid: 'c-video' }); }
function shotInput() { return { prompt: 'A red product rotates on a clean studio table', output_path: 'ad/shot-1.mp4', production_dir: 'ad', duration: 5, resolution: '720p', generate_audio: false }; }
function context() { return { workingDir: root } as any; }
describe('current timeline and configured service boundaries', () => {
  it.each([false, true, undefined])('permits an explicit retry only after a structured undispatched failure (dispatched=%s)', async dispatched => {
    const tool = studioTool(), input = shotInput();
    const error = { ok: false, errorCode: 'PROVIDER_API_ERROR', message: 'fixture terminal failure', ...(dispatched === undefined ? {} : { dispatched }) };
    h.generateVideo.mockResolvedValue(error);
    expect(await tool.execute(input, context())).toMatchObject({ isError: true, content: '[PROVIDER_API_ERROR] fixture terminal failure' });
    const repeated = await tool.execute(input, context());
    if (dispatched === false) { expect(h.generateVideo).toHaveBeenCalledTimes(2); expect(repeated.content).toContain('[PROVIDER_API_ERROR]'); }
    else { expect(h.generateVideo).toHaveBeenCalledTimes(1); expect(repeated.content).toContain('E_GENERATION_PENDING'); }
  });
  it('requires the production before sending a Studio shot', async () => {
    const { production_dir, ...input } = shotInput(); const result = await studioTool().execute(input, context());
    expect(result).toMatchObject({ isError: true }); expect(result.content).toContain('E_PRODUCTION_DIR'); expect(h.generateVideo).not.toHaveBeenCalled();
  });
  it('reuses the exact completed file without another dispatch even after settings become unavailable', async () => {
    h.generateVideo.mockImplementation(async ({ outputAbsPath }) => { fs.mkdirSync(path.dirname(outputAbsPath), { recursive: true }); fs.writeFileSync(outputAbsPath, 'completed-fixture'); return { ok: true, path: outputAbsPath, bytes: 17, provider: 'orkas-api', model: 'orkas-video', taskId: 'one' }; });
    const tool = studioTool(), input = shotInput(); const first = await tool.execute(input, context());
    expect(first.isError).not.toBe(true); const assets = JSON.parse(fs.readFileSync(path.join(root, 'ad/assets.json'), 'utf8')).assets;
    expect(assets).toEqual([expect.objectContaining({ kind: 'video', path: 'shot-1.mp4', prompt: input.prompt, origin: 'generated' })]);
    h.quote.mockResolvedValue({ sufficient: false });
    const second = await tool.execute(input, context()); expect(second.isError).not.toBe(true); expect(second.content).toContain('already finished'); expect(second.content).not.toContain('paid for'); expect(h.generateVideo).toHaveBeenCalledTimes(1);
  });
  it('preserves an uncertain thrown dispatch and refuses a second request', async () => {
    h.generateVideo.mockRejectedValue(new Error('request status unknown')); const tool = studioTool(), input = shotInput();
    expect((await tool.execute(input, context())).content).toContain('PROVIDER_EXCEPTION');
    expect((await tool.execute(input, context())).content).toContain('E_GENERATION_PENDING'); expect(h.generateVideo).toHaveBeenCalledTimes(1);
  });
  it('honors the app-selected service without falling back and includes frames in that dispatch', async () => {
    h.route.mockResolvedValue('selected-service'); const tool = createVideoGenTool({ userId: 'u', cid: 'app-session', videoRoute: 'different-service' });
    const result = await tool.execute({ prompt: 'opening and ending', output_path: 'f.mp4', first_frame: 'https://image.example/first.png', last_frame: 'https://image.example/last.png' }, context());
    expect(result.isError).not.toBe(true); expect(h.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'selected-service', firstFrameUrl: 'https://image.example/first.png', lastFrameUrl: 'https://image.example/last.png' }));
  });
  it('refuses a broken app-selected identity without dispatch', async () => {
    h.route.mockRejectedValue(new Error('selection removed')); const result = await createVideoGenTool({ userId: 'u', cid: 'app-session' }).execute({ prompt: 'clip', output_path: 'f.mp4' }, context());
    expect(result.isError).toBe(true); expect(h.generateVideo).not.toHaveBeenCalled();
  });
  it('bounds the expanded envelope before reading missing files', async () => {
    const result = await createVideoGenTool({ userId: 'u' }).execute({ prompt: 'clip', output_path: 'f.mp4', reference_image_paths: Array(31).fill('missing.png') }, context());
    expect(result.content).toContain('30'); expect(h.generateVideo).not.toHaveBeenCalled();
  });
  it('passes the expanded model-specific envelope to the owning validator', async () => {
    const images = Array.from({ length: 30 }, (_, i) => 'https://image.example/' + i + '.png'), videos = Array.from({ length: 10 }, (_, i) => 'https://video.example/' + i + '.mp4');
    await createVideoGenTool({ userId: 'u' }).execute({ prompt: 'clip', output_path: 'f.mp4', reference_image_urls: images, reference_video_urls: videos, duration: -1, ratio: 'adaptive', resolution: '1080p' }, context());
    expect(h.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ referenceImageUrls: images, referenceVideoUrls: videos, duration: -1, ratio: 'adaptive', resolution: '1080p' }));
  });
  it('rejects a local frame outside the workspace before dispatch', async () => {
    const result = await createVideoGenTool({ userId: 'u' }).execute({ prompt: 'clip', output_path: 'f.mp4', first_frame: path.join(root, '..', 'outside.png') }, context());
    expect(result.content).toContain('E_PATH_OUT_OF_SCOPE'); expect(h.generateVideo).not.toHaveBeenCalled();
  });
  it('does not replace an earlier Studio shot when a changed prompt uses the same name', async () => {
    fs.mkdirSync(path.join(root, 'ad')); fs.writeFileSync(path.join(root, 'ad/shot-1.mp4'), 'old');
    await studioTool().execute(shotInput(), context()); expect(h.generateVideo.mock.calls[0][0].outputAbsPath).not.toBe(path.join(root, 'ad/shot-1.mp4')); expect(fs.readFileSync(path.join(root, 'ad/shot-1.mp4'), 'utf8')).toBe('old');
  });
});

it('keeps an unresolved canvas shot visible across turns without retaining a replay payload', async () => {
  const tool = createVideoGenTool({ userId: 'test-video-owner', agentId: '79df9cc89f5f', cid: 'c-video' });
  h.generateVideo.mockResolvedValue({ ok: false, errorCode: 'PROVIDER_API_ERROR', message: 'uncertain' });
  await tool.execute({ ...shotInput(), shot: 'hero' }, { workingDir: root } as any);
  const { hasPendingProductionRequest } = await import('../../../../src/main/features/video_production_budget');
  expect(await hasPendingProductionRequest({ userId: 'test-video-owner', scope: 'c-video', productionDirAbs: path.join(root, 'ad'), shot: 'hero', kind: 'video' })).toBe(true);
});
