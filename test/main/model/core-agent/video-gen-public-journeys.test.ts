// Portable source video-gen-tool journeys; existing public regression owner is retained separately.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appMedia=vi.hoisted(()=>({route:vi.fn()}));
vi.mock('../../../../src/main/features/app_media_route',()=>({appTaskMediaRoute:appMedia.route}));
beforeEach(()=>{appMedia.route.mockReset();});

// Drive generate_video's result so we can assert how the tool surfaces each
// failure class to the agent. Everything else the tool touches is stubbed to a
// no-op so the test isolates the error-message mapping.
const h = vi.hoisted(() => ({
  genResult: { ok: false, errorCode: 'CREDITS_EXHAUSTED', message: '积分不足' } as any,
  generateVideo: vi.fn(),
  noteGeneration: vi.fn(),
  regenerationWarning: vi.fn(),
  localRoot: '',
  quoteArgs: [] as unknown[][],
  outOfScope: [] as string[],
}));

vi.mock('../../../../src/main/features/video_production_services', async (original) => ({
  ...(await original<object>()),
  checkVideoProductionServices: async (...args: unknown[]) => (h.quoteArgs.push(args), {
    sufficient: true, externally_billed_segment_ids: ['request'], unavailable_segment_ids: [],
    external_billing_estimate_available: false, segments: [],
  }),
}));
vi.mock('../../../../src/main/paths', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  userLocalRoot: () => h.localRoot,
}));
vi.mock('../../../../src/main/features/video_gen', () => ({
  generateVideo: (...args: unknown[]) => h.generateVideo(...args),
}));
vi.mock('../../../../src/main/util/path-sandbox', () => ({
  isPathAllowed: (p: string) => !h.outOfScope.includes(p),
}));
vi.mock('../../../../src/main/util/uniquify-path', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uniquifyPath: async (p: string) => ({ finalPath: p, renamed: false }),
  renderRenameSignal: () => '',
}));
vi.mock('../../../../src/main/util/generation-guard', () => ({
  noteGeneration: (...args: unknown[]) => h.noteGeneration(...args),
  regenerationWarning: (...args: unknown[]) => h.regenerationWarning(...args),
}));
vi.mock('../../../../src/main/features/user_workspace', () => ({
  getWorkspacePath: () => '/ws',
}));
vi.mock('../../../../src/main/util/project-layout', () => ({
  chatAttachmentDirForConversation: () => '/ws/att',
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));
vi.mock('../../../../src/main/util/log-redact', () => ({
  logErrorRef: (e: unknown) => String(e),
  logPathRef: (p: unknown) => String(p),
  maskId: (s: unknown) => String(s),
}));

beforeEach(() => {
  h.genResult = { ok: false, errorCode: 'CREDITS_EXHAUSTED', message: '积分不足' };
  h.generateVideo.mockReset();
  h.generateVideo.mockImplementation(async () => h.genResult);
  h.noteGeneration.mockReset().mockReturnValue(1);
  h.regenerationWarning.mockReset().mockReturnValue(null);
  h.quoteArgs.length = 0;
  h.outOfScope.length = 0;
});

afterEach(() => {
  vi.resetModules();
});

function ctx() {
  return { workingDir: '/ws' } as any;
}

describe('generate_video tool › failure surfacing', () => {
  it('passes the expanded Seedance reference envelope and model-specific controls to the owning validator', async () => {
    const { createVideoGenTool } = await import('../../../../src/main/model/core-agent/video-gen-tool');
    const tool = createVideoGenTool({ userId: 'u1', cid: 'c1' });
    const images = Array.from({ length: 30 }, (_, i) => `https://images.example/${i}.png`);
    const videos = Array.from({ length: 10 }, (_, i) => `https://video.example/${i}.mp4`);
    await tool.execute!({ prompt: 'Edit the video', output_path: 'out.mp4', reference_image_urls: images, reference_video_urls: videos, duration: -1, ratio: 'adaptive', resolution: '1080p' }, ctx());
    expect(h.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ referenceImageUrls: images, referenceVideoUrls: videos, duration: -1, ratio: 'adaptive', resolution: '1080p' }));
  });

  it('bounds the global reference envelope before resolving paths or dispatching generation', async () => {
    const { createVideoGenTool } = await import('../../../../src/main/model/core-agent/video-gen-tool');
    const tool = createVideoGenTool({ userId: 'u1', cid: 'c1' });
    const result = await tool.execute!({ prompt: 'A clip', output_path: 'out.mp4', reference_image_paths: Array(31).fill('missing.png') }, ctx());
    expect(result).toMatchObject({ isError: true });
    expect(String(result.content)).toContain('30');
    expect(h.generateVideo).not.toHaveBeenCalled();
  });

  it('keeps configured video controls optional and explains when to use them', async () => {
    const { createVideoGenTool } = await import('../../../../src/main/model/core-agent/video-gen-tool');
    const tool = createVideoGenTool({ userId: 'u1' });
    const properties = (tool.inputSchema as any).properties;
    expect(tool.inputSchema.required).toEqual(['prompt', 'output_path']);
    expect(properties.duration.description).toMatch(/whole seconds.*omit.*service default/i);
    expect(properties.resolution.description).toMatch(/resolution.*service default/i);
    expect(properties.ratio.description).toMatch(/adaptive only where supported/i);
    expect(properties.generate_audio.description).toContain('supported');
    expect(tool.name).toBe('generate_video');
  });

  it('returns typed E_CREDITS_EXHAUSTED without retry or an unsupported free-rebilling promise', async () => {
    h.genResult = { ok: false, errorCode: 'CREDITS_EXHAUSTED', message: '积分不足' };
    const { createVideoGenTool } = await import('../../../../src/main/model/core-agent/video-gen-tool');
    const tool = createVideoGenTool({ userId: 'u1', cid: 'c1' });
    const res = await tool.execute!({ prompt: 'a clip', output_path: 'out.mp4' }, ctx());
    expect(res.isError).toBe(true);
    const content = String(res.content);
    expect(content).toContain('E_CREDITS_EXHAUSTED');
    expect(content).toMatch(/do not retry/i);
    expect(content).toMatch(/tops? up/i);
    expect(content).not.toMatch(/not be re-billed|nothing was charged/i);
    // The out-of-credits case must NOT fall through to the generic [CODE] shape.
    expect(content).not.toContain('[CREDITS_EXHAUSTED]');
  });

  it('keeps the generic [CODE] message shape for other provider errors', async () => {
    h.genResult = { ok: false, errorCode: 'PROVIDER_API_ERROR', message: 'boom' };
    const { createVideoGenTool } = await import('../../../../src/main/model/core-agent/video-gen-tool');
    const tool = createVideoGenTool({ userId: 'u1', cid: 'c1' });
    const res = await tool.execute!({ prompt: 'a clip', output_path: 'out.mp4' }, ctx());
    expect(res.isError).toBe(true);
    expect(String(res.content)).toBe('[PROVIDER_API_ERROR] boom');
  });

  it('surfaces exhausted delivery retries without inviting another generation request', async () => {
    h.genResult = {
      ok: false,
      errorCode: 'DELIVERY_ERROR',
      message: 'The provider completed task video-1, but download retries failed. Do not submit another generation task.',
      taskId: 'video-1',
      postDispatch: true,
    };
    const { createVideoGenTool } = await import('../../../../src/main/model/core-agent/video-gen-tool');
    const tool = createVideoGenTool({ userId: 'u1', cid: 'c1' });
    const res = await tool.execute!({ prompt: 'a clip', output_path: 'out.mp4' }, ctx());

    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('[DELIVERY_ERROR]');
    expect(String(res.content)).toMatch(/do not submit another generation task/i);
    expect(h.generateVideo).toHaveBeenCalledTimes(1);
  });

  it('redacts provider secrets from returned failures and thrown exceptions', async () => {
    h.genResult = {
      ok: false,
      errorCode: 'PROVIDER_API_ERROR',
      message: '401 apiKey=sk-returned-secret-value owner=owner@example.test',
    };
    const { createVideoGenTool } = await import('../../../../src/main/model/core-agent/video-gen-tool');
    const tool = createVideoGenTool({ userId: 'u1', cid: 'c1' });

    const providerResult = await tool.execute!({ prompt: 'a clip', output_path: 'out.mp4' }, ctx());
    expect(String(providerResult.content)).toContain('[PROVIDER_API_ERROR] 401');
    expect(String(providerResult.content)).not.toContain('sk-returned-secret-value');
    expect(String(providerResult.content)).not.toContain('owner@example.test');

    h.generateVideo.mockRejectedValueOnce(new Error(
      'Authorization: Bearer provider-secret-token owner@example.test',
    ));
    const thrownResult = await tool.execute!({ prompt: 'a clip', output_path: 'out.mp4' }, ctx());
    expect(String(thrownResult.content)).toContain('[PROVIDER_EXCEPTION]');
    expect(String(thrownResult.content)).not.toContain('provider-secret-token');
    expect(String(thrownResult.content)).not.toContain('owner@example.test');
  });

  it('returns the saved artifact and repeated-cost warning without exposing a signed provider URL', async () => {
    const savedPath = path.resolve('/ws/out.mp4');
    h.genResult = {
      ok: true,
      path: savedPath,
      bytes: 24,
      provider: 'fixture-provider',
      model: 'fixture-model',
      taskId: 'video-task',
      videoUrl: 'https://cdn.example/out.mp4?X-Amz-Credential=private&X-Amz-Signature=secret-signature',
      status: 'succeeded',
    };
    h.noteGeneration.mockReturnValueOnce(3);
    h.regenerationWarning.mockReturnValueOnce('generation #3 is billable');
    const { createVideoGenTool } = await import('../../../../src/main/model/core-agent/video-gen-tool');
    const tool = createVideoGenTool({ userId: 'u1', cid: 'cost-aware-chat' });

    const result = await tool.execute!({ prompt: 'a clip', output_path: 'out.mp4' }, ctx());
    const content = String(result.content);

    expect(result.isError).toBeFalsy();
    expect(content).toContain(`Video written to ${savedPath}`);
    expect(content).toContain('[video](');
    expect(content).toContain('generation #3 is billable');
    expect(content).not.toContain('cdn.example');
    expect(content).not.toContain('private');
    expect(content).not.toContain('secret-signature');
    expect(h.noteGeneration).toHaveBeenCalledWith('cost-aware-chat', savedPath);
    expect(h.regenerationWarning).toHaveBeenCalledWith(3, 'video');
  });

  it('surfaces a thrown provider exception as a tool result instead of rejecting the turn', async () => {
    h.generateVideo.mockRejectedValueOnce(new Error('connection closed'));
    const { createVideoGenTool } = await import('../../../../src/main/model/core-agent/video-gen-tool');
    const tool = createVideoGenTool({ userId: 'u1', cid: 'c1' });
    const res = await tool.execute!({ prompt: 'a clip', output_path: 'out.mp4' }, ctx());
    expect(res.isError).toBe(true);
    expect(String(res.content)).toBe('[PROVIDER_EXCEPTION] connection closed');
  });
});

// A video can open and end on given frames (decided 2026-11-10, with the exact field texts).
describe('generate_video tool › first and last frames', () => {
  const FIRST_FRAME = 'Image the video must open on: a local path in workspace/attachments, or an https or asset:// URL. Some models cannot also take reference images or videos.';
  const LAST_FRAME = 'Image the video must end on, given like first_frame. Requires first_frame; not every model supports it.';
  let dir = '';

  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-frames-'))); });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (h.localRoot) fs.rmSync(h.localRoot, { recursive: true, force: true });
    h.localRoot = '';
  });

  const image = (name: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'png');
    return file;
  };
  const tool = async (opts: Record<string, unknown> = {}) => (await import('../../../../src/main/model/core-agent/video-gen-tool'))
    .createVideoGenTool({ userId: 'u1', cid: 'c1', ...opts } as any);

  it('advertises generation frames and when the source determines ratio', async () => {
    const properties = ((await tool()).inputSchema as any).properties;
    expect(properties.first_frame).toEqual({ type: 'string', description: FIRST_FRAME });
    expect(properties.last_frame).toEqual({ type: 'string', description: LAST_FRAME });
    expect(properties.ratio.description).toMatch(/omit when the model takes the ratio from the first frame or edit source/i);
  });

  it('passes a local frame as a path and a linked one as a URL', async () => {
    const first = image('first.png');
    await (await tool()).execute!({ prompt: 'A lamp lights up', output_path: 'out.mp4', first_frame: first, last_frame: 'https://images.example/last.png' }, ctx());
    expect(h.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ firstFramePath: first, lastFrameUrl: 'https://images.example/last.png' }));
    expect(h.generateVideo.mock.calls[0][0]).not.toHaveProperty('firstFrameUrl');
    expect(h.generateVideo.mock.calls[0][0]).not.toHaveProperty('lastFramePath');
  });

  it('passes an asset:// frame as a URL', async () => {
    await (await tool()).execute!({ prompt: 'A lamp lights up', output_path: 'out.mp4', first_frame: 'asset://portrait-1' }, ctx());
    expect(h.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ firstFrameUrl: 'asset://portrait-1' }));
  });

  it('refuses a frame outside the task\'s files, or one that is not a file, before generating', async () => {
    const outside = image('outside.png');
    h.outOfScope.push(outside);
    expect(await (await tool()).execute!({ prompt: 'A lamp', output_path: 'out.mp4', first_frame: outside }, ctx()))
      .toEqual({ content: `E_PATH_OUT_OF_SCOPE: first_frame is outside the current scope (workspace + attachments): ${outside}`, isError: true });
    const missing = path.join(dir, 'missing.png');
    expect(await (await tool()).execute!({ prompt: 'A lamp', output_path: 'out.mp4', first_frame: image('first.png'), last_frame: missing }, ctx()))
      .toEqual({ content: `last_frame is not a file: ${missing}`, isError: true });
    expect(h.generateVideo).not.toHaveBeenCalled();
  });

  it('records a VideoStudio shot\'s frames by role and checks them with the request', async () => {
    h.localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-frames-shot-'));
    const productionDir = path.join(h.localRoot, 'ad');
    const first = path.join(productionDir, 'media', 'first.png');
    const last = path.join(productionDir, 'media', 'last.png');
    fs.mkdirSync(path.join(productionDir, 'media'), { recursive: true });
    fs.mkdirSync(path.join(productionDir, 'shots'), { recursive: true });
    fs.writeFileSync(first, 'lamp off');
    fs.writeFileSync(last, 'lamp on');
    fs.writeFileSync(path.join(productionDir, 'assets.json'), JSON.stringify({ assets: [
      { id: 'first', kind: 'image', label: 'Off', path: 'media/first.png', origin: 'upload' },
      { id: 'last', kind: 'image', label: 'On', path: 'media/last.png', origin: 'upload' },
    ] }));
    const outputPath = path.join(productionDir, 'shots', 'framed.mp4');
    h.genResult = { ok: true, path: outputPath, bytes: 11, provider: 'doubao', model: 'doubao-seedance-2-0-260128', taskId: 't', videoUrl: '', status: 'succeeded' };
    h.generateVideo.mockImplementation(async () => { fs.writeFileSync(outputPath, 'video-bytes'); return h.genResult; });
    const input = { prompt: 'The lamp turns on', output_path: outputPath, production_dir: productionDir, first_frame: first, last_frame: last, shot: 'framed', label: 'Lamp on' };
    const shot = await tool({ agentId: '79df9cc89f5f', agentName: 'VideoStudio' });

    expect((await shot.execute!(input, ctx())).isError).toBeFalsy();
    expect(h.quoteArgs.at(-1)?.[0]).toEqual([expect.objectContaining({ first_frame_path: first, last_frame_path: last })]);
    const row = JSON.parse(fs.readFileSync(path.join(productionDir, 'assets.json'), 'utf8')).assets.find((asset: any) => asset.shot === 'framed');
    expect(row.refs).toEqual([{ asset: 'first', role: 'first_frame' }, { asset: 'last', role: 'last_frame' }]);
    expect(row.request).toMatchObject({ first_frame: first, last_frame: last });

    // Another opening picture under the same name is another request, though the call reads the same.
    fs.writeFileSync(first, 'another lamp');
    h.generateVideo.mockClear();
    await shot.execute!(input, ctx());
    expect(h.generateVideo).toHaveBeenCalledTimes(1);
  });
});

it('uses the app-selected concrete video model ahead of a caller default',async()=>{
 appMedia.route.mockResolvedValue('selected-video-service');const{createVideoGenTool}=await import('../../../../src/main/model/core-agent/video-gen-tool');await createVideoGenTool({userId:'u1',cid:'app-owned',videoRoute:'other-profile'}).execute!({prompt:'clip',output_path:'out.mp4'},ctx());expect(h.generateVideo).toHaveBeenCalledWith(expect.objectContaining({profileId:'selected-video-service'}));
});
