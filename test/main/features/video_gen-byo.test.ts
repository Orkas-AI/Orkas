import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TEST_MP4 = Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,2,0,0x69,0x73,0x6f,0x6d,0x69,0x73,0x6f,0x32]);
const mockState = vi.hoisted(() => ({ videoProfiles: [] as any[], workspace: '' }));
vi.mock('../../../src/main/features/auth', () => ({ loadVideoProfiles: () => mockState.videoProfiles }));
vi.mock('../../../src/main/features/user_workspace', () => ({getWorkspacePath:()=>mockState.workspace}));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()}) }));
vi.mock('../../../src/main/features/generation_reference_assets', () => ({
 prepareReferenceUrls: async ({urls,paths}: {urls?: string[],paths?:string[]}) => {
   if(paths?.length) throw new Error('local references are outside this protocol fixture');
   return [...(urls || [])];
 }, registerGeneratedMediaUrl: vi.fn(),
}));
afterEach(async () => {
 (await import('../../../src/main/util/proxy-dispatcher'))._resetProxyRoutingForTests();
 vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); mockState.videoProfiles = [];
});
// Shared frozen-source provider contracts; every request is intercepted by the fixture.
describe('video control request lifecycle', () => {
  const req = (signal?: AbortSignal) => ({ apiKey: 'fixture-key', model: 'kling-v3-0-turbo',
    prompt: 'A quiet landscape', referenceImageUrls: [], referenceVideoUrls: [],
    operation: 'generate', ratio: '16:9', duration: 5, resolution: '720p',
    generateAudio: true, watermark: false, pollIntervalMs: 1, timeoutMs: 600_000, signal } as any);
  const stalled = (init?: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
    },
  }), { headers: { 'content-type': 'application/json' } });

  it('bounds stalled poll bodies and retries only the accepted task query', async () => {
    const { callKlingVideo } = await import('../../../src/main/features/video_gen');
    vi.useFakeTimers();
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Response(JSON.stringify({ code: 0, data: { id: 'accepted-stalled-task' } })) : stalled(init));
    vi.stubGlobal('fetch', fetch);
    const outcome = callKlingVideo(req()).then(() => null, error => error);
    await vi.advanceTimersByTimeAsync(100_010);
    const observed = await Promise.race([outcome, Promise.resolve('still pending')]);
    expect(observed).toMatchObject({ taskId: 'accepted-stalled-task' });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a stalled creation body after headers', async () => {
    const { callKlingVideo } = await import('../../../src/main/features/video_gen');
    vi.useFakeTimers();
    const user = new AbortController();
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => stalled(init));
    vi.stubGlobal('fetch', fetch);
    const outcome = callKlingVideo(req(user.signal)).then(() => null, error => error);
    await vi.advanceTimersByTimeAsync(0);
    user.abort();
    await vi.advanceTimersByTimeAsync(0);
    const observed = await Promise.race([outcome, Promise.resolve('still pending')]);
    expect(observed).toMatchObject({ message: 'operation aborted' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['doubao', 'doubao-seedance-2-0-260128'], ['minimax', 'MiniMax-Hailuo-2.3'],
    ['vidu', 'viduq3-pro'], ['kling', 'kling-v3-0-turbo'],
    ['google', 'veo-3.1-generate-preview'], ['runway', 'gen4.5'],
  ])('does not create a fallback task after an accepted %s response loses its receipt', async (provider, model) => {
    mockState.videoProfiles = [
      { id: 'primary', provider, model, apiKey: 'fixture-key', createdAt: 1 },
      { id: 'fallback', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', createdAt: 2 },
    ];
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {} })));
    vi.stubGlobal('fetch', fetch);
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    const result = await generateVideo({ prompt: 'A quiet landscape', outputAbsPath: path.join(os.tmpdir(), 'uncreated-video-receipt.mp4') });
    expect(result).toMatchObject({ ok: false, postDispatch: true });
    expect(result).not.toHaveProperty('taskId');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retains unknown dispatch status after losing creation headers without sending another request', async () => {
    mockState.videoProfiles = [
      { id: 'primary', provider: 'kling', model: 'kling-v3-0-turbo', apiKey: 'fixture-key', createdAt: 1 },
      { id: 'fallback', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', createdAt: 2 },
    ];
    const fetch = vi.fn(async () => { throw new Error('fixture connection lost after dispatch'); });
    vi.stubGlobal('fetch', fetch);
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    expect(await generateVideo({ prompt: 'A quiet landscape', outputAbsPath: path.join(os.tmpdir(), 'uncreated-video-receipt.mp4') }))
      .toMatchObject({ ok: false, postDispatch: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps private rejection bodies out of the public failure receipt', async () => {
    mockState.videoProfiles = [{ id: 'primary', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', createdAt: 1 }];
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'private-generation-prompt' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    const result = await generateVideo({ prompt: 'A quiet landscape', outputAbsPath: path.join(os.tmpdir(), 'uncreated-video-receipt.mp4') });
    expect(result).toMatchObject({ ok: false, errorCode: 'PROVIDER_API_ERROR' });
    expect(JSON.stringify(result)).not.toContain('private-generation-prompt');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['http', 'business'])('preserves configured fallback after a proven %s rejection', async rejection => {
    mockState.videoProfiles = [
      { id: 'primary', provider: 'kling', model: 'kling-v3-0-turbo', apiKey: 'fixture-key', createdAt: 1 },
      { id: 'fallback', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', createdAt: 2 },
    ];
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-rejection-'));
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('klingai.com')) return new Response(JSON.stringify({ code: 123, message: 'private-generation-prompt' }), { status: rejection === 'http' ? 400 : 200 });
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'fallback-task' }));
      if (url.includes('/tasks/fallback-task')) return new Response(JSON.stringify({ status: 'succeeded', content: { video_url: 'https://video.example/rejected-fallback.mp4' } }));
      return new Response(new Uint8Array(TEST_MP4));
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'A quiet landscape', outputAbsPath: path.join(root, 'clip.mp4'), pollIntervalMs: 1 }))
        .toMatchObject({ ok: true, provider: 'doubao', taskId: 'fallback-task' });
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('video_gen › latest user-key provider adapters', () => {
  // Ark's direct contract: Fast/Mini support only480p/720p. Requester chose
  // 1080p ->720p fallback; Standard retains1080p. The confirmed Mini mapping
  // changes only the upstream request ID, preserving saved/internal identity.
  it.each([
    ['doubao-seedance-2-0-fast-260128', '1080p', '720p', 'doubao-seedance-2-0-fast-260128'],
    ['doubao-seedance-2-0-mini', '1080p', '720p', 'doubao-seedance-2-0-mini-260615'],
    ['doubao-seedance-2-0-mini-260615', '1080p', '720p', 'doubao-seedance-2-0-mini-260615'],
    ['doubao-seedance-2-0-fast-260128', '480p', '480p', 'doubao-seedance-2-0-fast-260128'],
    ['doubao-seedance-2-0-mini', '720p', '720p', 'doubao-seedance-2-0-mini-260615'],
    ['doubao-seedance-2-0-260128', '1080p', '1080p', 'doubao-seedance-2-0-260128'],
  ])('preserves %s selection and adapts resolution %s to %s before dispatch', async (model, resolution, expected, upstreamModel) => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({ model: upstreamModel, resolution: expected });
        return new Response(JSON.stringify({ id: 'fixture-doubao' }));
      }
      if (url.endsWith('/tasks/fixture-doubao')) return new Response(JSON.stringify({ status: 'succeeded', content: { video_url: 'https://video.example/seedance.mp4' } }));
      if (url === 'https://video.example/seedance.mp4') return new Response(TEST_MP4);
      throw new Error(`unexpected fixture request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    const { callDoubaoVideo } = await import('../../../src/main/features/video_gen');
    expect(await callDoubaoVideo({ apiKey: 'fixture-key', model, prompt: 'a quiet lake', resolution,
      referenceImageUrls: [], referenceVideoUrls: [], operation: 'generate', ratio: '16:9', duration: 5,
      generateAudio: true, watermark: false, pollIntervalMs: 1, timeoutMs: 1000 } as any))
      .toMatchObject({ buffer: TEST_MP4, resolution: expected });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('uses the official Mini request ID from an existing profile without rewriting the profile', async () => {
    const profile = { id: 'saved-mini', provider: 'doubao', model: 'doubao-seedance-2-0-mini', apiKey: 'fixture-key', label: 'My Mini', createdAt: 1 };
    mockState.videoProfiles = [{ ...profile }];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
        expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
        expect(JSON.parse(String(init.body))).toMatchObject({ model: 'doubao-seedance-2-0-mini-260615', resolution: '720p' });
        return new Response(JSON.stringify({ id: 'mini-task' }));
      }
      if (url.endsWith('/tasks/mini-task')) return new Response(JSON.stringify({ model: 'doubao-seedance-2-0-mini-260615', status: 'succeeded', content: { video_url: 'https://video.example/mini.mp4' } }));
      if (url === 'https://video.example/mini.mp4') return new Response(TEST_MP4);
      throw new Error('unexpected fixture request');
    });
    vi.stubGlobal('fetch', fetch);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-model-id-'));
    try {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      const output = path.join(root, 'clip.mp4');
      expect(await generateVideo({ prompt: 'a quiet lake', outputAbsPath: output, resolution: '1080p', pollIntervalMs: 1, timeoutMs: 1000 }))
        .toMatchObject({ ok: true, provider: 'doubao', model: 'doubao-seedance-2-0-mini', taskId: 'mini-task', resolution: '720p' });
      expect(mockState.videoProfiles.find(p => p.id === 'saved-mini')).toEqual(profile);
      expect(await fs.readFile(output)).toEqual(TEST_MP4);
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('reports the confirmed720p fallback throughout the saved Fast profile journey', async () => {
    mockState.videoProfiles = [{ id: 'saved-fast', provider: 'doubao', model: 'doubao-seedance-2-0-fast-260128', apiKey: 'fixture-key', label: 'Doubao', createdAt: 1 }];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'fixture-fast' }));
      if (url.endsWith('/tasks/fixture-fast')) return new Response(JSON.stringify({ status: 'succeeded', content: { video_url: 'https://video.example/fast.mp4' } }));
      if (url === 'https://video.example/fast.mp4') return new Response(TEST_MP4);
      throw new Error(`unexpected fixture request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-resolution-'));
    const events: any[] = [];
    try {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'a quiet lake', outputAbsPath: path.join(root, 'clip.mp4'), resolution: '1080p', pollIntervalMs: 1, timeoutMs: 1000, onProgress: e => events.push(e) }))
        .toMatchObject({ ok: true, model: 'doubao-seedance-2-0-fast-260128', resolution: '720p' });
      expect(await fs.readFile(path.join(root, 'clip.mp4'))).toEqual(TEST_MP4);
      for (const event of events.filter(e => e.phase === 'configuration' || e.phase === 'create_task')) expect(event.data.resolution).toBe('720p');
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('creates, polls, and downloads with MiniMax, Vidu, Kling, Google, and Runway contracts', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://api.minimax.io/v1/video_generation') {
        return new Response(JSON.stringify({ task_id: 'minimax_1' }), { status: 200 });
      }
      if (url === 'https://api.minimax.io/v1/query/video_generation?task_id=minimax_1') {
        return new Response(JSON.stringify({ status: 'Success', file_id: 'file_1' }), { status: 200 });
      }
      if (url === 'https://api.minimax.io/v1/files/retrieve?file_id=file_1') {
        return new Response(JSON.stringify({ file: { download_url: 'https://video.example/minimax.mp4' } }), { status: 200 });
      }
      if (url === 'https://api.vidu.com/ent/v2/text2video') {
        return new Response(JSON.stringify({ task_id: 'vidu_1' }), { status: 200 });
      }
      if (url === 'https://api.vidu.com/ent/v2/tasks/vidu_1/creations') {
        return new Response(JSON.stringify({ state: 'success', creations: [{ url: 'https://video.example/vidu.mp4' }] }), { status: 200 });
      }
      if (url === 'https://api-singapore.klingai.com/text-to-video/kling-3.0-turbo') {
        return new Response(JSON.stringify({ code: 0, data: { id: 'kling_1' } }), { status: 200 });
      }
      if (url === 'https://api-singapore.klingai.com/tasks?task_ids=kling_1') {
        return new Response(JSON.stringify({
          code: 0, data: [{ id: 'kling_1', status: 'succeeded', outputs: [{ type: 'video', url: 'https://video.example/kling.mp4' }] }],
        }), { status: 200 });
      }
      if (url === 'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning') {
        return new Response(JSON.stringify({ name: 'operations/veo_1' }), { status: 200 });
      }
      if (url === 'https://generativelanguage.googleapis.com/v1beta/operations/veo_1') {
        return new Response(JSON.stringify({
          done: true,
          response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://video.example/google.mp4' } }] } },
        }), { status: 200 });
      }
      if (url === 'https://api.dev.runwayml.com/v1/text_to_video') {
        return new Response(JSON.stringify({ id: 'runway_1' }), { status: 200 });
      }
      if (url === 'https://api.dev.runwayml.com/v1/tasks/runway_1') {
        return new Response(JSON.stringify({ status: 'SUCCEEDED', output: ['https://video.example/runway.mp4'] }), { status: 200 });
      }
      if (url.startsWith('https://video.example/')) {
        return new Response(new Uint8Array(TEST_MP4), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const m = await import('../../../src/main/features/video_gen');
    const req = (model: string) => ({
      apiKey: 'user-key',
      model,
      prompt: 'a quiet landscape',
      referenceImageUrls: [],
      referenceVideoUrls: [],
      operation: 'generate',
      ratio: '16:9',
      duration: 5,
      resolution: '720p',
      generateAudio: true,
      watermark: false,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    } as any);

    const results = await Promise.all([
      m.callMiniMaxVideo(req('MiniMax-Hailuo-2.3')),
      m.callViduVideo(req('viduq3-pro')),
      m.callKlingVideo(req('kling-v3-0-turbo')),
      m.callGoogleVideo(req('veo-3.1-generate-preview')),
      m.callRunwayVideo(req('gen4.5')),
    ]);

    expect(results.map((result) => result.model)).toEqual([
      'MiniMax-Hailuo-2.3',
      'viduq3-pro',
      'kling-v3-0-turbo',
      'veo-3.1-generate-preview',
      'gen4.5',
    ]);
    expect(results.every((result) => result.buffer.equals(TEST_MP4))).toBe(true);

    const createBodies = Object.fromEntries(calls
      .filter((call) => call.init?.method === 'POST')
      .map((call) => [call.url, JSON.parse(call.init?.body as string)]));
    expect(createBodies['https://api.minimax.io/v1/video_generation']).toMatchObject({
      model: 'MiniMax-Hailuo-2.3', duration: 6, resolution: '768P',
    });
    expect(createBodies['https://api.vidu.com/ent/v2/text2video']).toMatchObject({
      model: 'viduq3-pro', audio: true, aspect_ratio: '16:9',
    });
    expect(createBodies['https://api-singapore.klingai.com/text-to-video/kling-3.0-turbo']).toEqual({
      prompt: 'a quiet landscape', settings: { duration: 5, resolution: '720p', aspect_ratio: '16:9' },
      options: { watermark_info: { enabled: false } },
    });
    expect(createBodies['https://api.dev.runwayml.com/v1/text_to_video']).toMatchObject({
      model: 'gen4.5', ratio: '1280:720', duration: 5,
    });
    expect(createBodies['https://api.dev.runwayml.com/v1/text_to_video']).not.toHaveProperty('promptImage');
    const googleDownload = calls.find((call) => call.url === 'https://video.example/google.mp4');
    expect(googleDownload?.init?.headers).toMatchObject({ 'x-goog-api-key': 'user-key' });
  });

  // Independent native protocol oracle: Kling-owned3.0Turbo docs, rather than
  // the legacy/v1/videos request that happened to pass the former fixture.
  it.each([false, true])('delivers saved Kling Turbo text/image video with native task identity (image=%s)', async imageMode => {
    mockState.videoProfiles = [{ id: 'saved-kling', provider: 'kling', model: 'kling-v3-0-turbo', apiKey: 'fixture-key', label: 'Kling', createdAt: 1 }];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(url).toBe(`https://api-singapore.klingai.com/${imageMode ? 'image-to-video' : 'text-to-video'}/kling-3.0-turbo`);
        expect(init.headers).toEqual({ Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' });
        const settings = { duration: imageMode ? 5 : 3, resolution: '1080p', ...(!imageMode ? { aspect_ratio: '9:16' } : {}) };
        expect(JSON.parse(String(init.body))).toEqual({
          ...(imageMode ? { contents: [{ type: 'prompt', text: 'a quiet landscape' }, { type: 'first_frame', url: 'https://images.example/portrait.png' }] } : { prompt: 'a quiet landscape' }),
          settings, options: { watermark_info: { enabled: true } },
        });
        return new Response(JSON.stringify({ code: 0, data: { id: 'saved-task' } }));
      }
      if (url === 'https://api-singapore.klingai.com/tasks?task_ids=saved-task') return new Response(JSON.stringify({ code: 0, data: [
        { id: 'foreign-task', status: 'succeeded', outputs: [{ type: 'video', url: 'https://video.example/wrong.mp4' }] },
        { id: 'saved-task', status: 'succeeded', outputs: [{ type: 'audio', mp3_url: 'https://video.example/audio.mp3' }, { type: 'video', url: 'https://video.example/plain.mp4', watermark_url: 'https://video.example/watermarked.mp4' }] },
      ] }));
      if (url === 'https://video.example/watermarked.mp4') return new Response(TEST_MP4);
      throw new Error(`unexpected fixture request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kling-native-'));
    try {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      const output = path.join(root, 'clip.mp4');
      expect(await generateVideo({ prompt: 'a quiet landscape', outputAbsPath: output,
        ...(imageMode ? { referenceImageUrls: ['https://images.example/portrait.png'] } : { ratio: '9:16' }),
        duration: imageMode ? 5 : 3, resolution: '1080p', watermark: true, pollIntervalMs: 1, timeoutMs: 1000 }))
        .toMatchObject({ ok: true, model: 'kling-v3-0-turbo', taskId: 'saved-task', videoUrl: 'https://video.example/watermarked.mp4', resolution: '1080p' });
      expect(await fs.readFile(output)).toEqual(TEST_MP4);
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { resolution: '480p' }, { ratio: '21:9' }, { duration: 16 }, { duration: 4.5 }, { seed: 1 },
    { generateAudio: false }, { referenceVideoUrls: ['https://video.example/reference.mp4'] },
    { referenceImageUrls: ['https://images.example/1.png', 'https://images.example/2.png'] },
    { referenceImageUrls: ['https://images.example/portrait.png'], ratio: '16:9' },
  ])('rejects unsupported Kling parameters before side effects or provider fallback (%j)', async input => {
    mockState.videoProfiles = [
      { id: 'kling', provider: 'kling', model: 'kling-v3-0-turbo', apiKey: 'fixture-key', label: 'Kling', createdAt: 1 },
      { id: 'fallback', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', label: 'Doubao', createdAt: 2 },
    ];
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kling-preflight-'));
    try {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'a quiet landscape', outputAbsPath: path.join(root, 'clip.mp4'), ...input }))
        .toMatchObject({ ok: false, errorCode: 'BAD_INPUT', dispatched: false });
      expect(fetch).not.toHaveBeenCalled();
      expect(await fs.readdir(root)).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(['failed', 'foreign', 'business-error'])('retains an accepted Kling task receipt without creating a fallback task (%s)', async outcome => {
    mockState.videoProfiles = [
      { id: 'kling', provider: 'kling', model: 'kling-v3-0-turbo', apiKey: 'fixture-key', label: 'Kling', createdAt: 1 },
      { id: 'fallback', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', label: 'Doubao', createdAt: 2 },
    ];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ code: 0, data: { id: 'accepted-task' } }));
      return new Response(JSON.stringify(outcome === 'business-error' ? { code: 1002, message: 'private provider detail' }
        : { code: 0, data: [{ id: outcome === 'foreign' ? 'another-task' : 'accepted-task', status: 'failed', message: 'private provider detail' }] }));
    });
    vi.stubGlobal('fetch', fetch);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kling-accepted-'));
    try {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      const result = await generateVideo({ prompt: 'a quiet landscape', outputAbsPath: path.join(root, 'clip.mp4'), pollIntervalMs: 1, timeoutMs: 1000 });
      expect(result).toMatchObject({ ok: false, errorCode: 'PROVIDER_API_ERROR', taskId: 'accepted-task', postDispatch: true });
      expect(JSON.stringify(result)).not.toContain('private provider detail');
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      expect(await fs.readdir(root)).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(['recover', 'persistent', 'deadline'])('keeps Kling polling on the accepted task without a new creation (%s)', async outcome => {
    let polls = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ code: 0, data: { id: 'poll-task' }, id: 'wrong-envelope-id' }));
      if (url === 'https://api-singapore.klingai.com/tasks?task_ids=poll-task') {
        if (++polls === 1 || outcome === 'persistent') throw new Error('Kling video query timed out');
        return new Response(JSON.stringify({ code: 0, data: [{ id: 'poll-task', status: 'succeeded', outputs: [{ type: 'video', url: 'https://video.example/poll.mp4' }] }] }));
      }
      if (url === 'https://video.example/poll.mp4') return new Response(TEST_MP4);
      throw new Error('unexpected fixture request');
    });
    vi.stubGlobal('fetch', fetch);
    const { callKlingVideo } = await import('../../../src/main/features/video_gen');
    const request = callKlingVideo({
      apiKey: 'fixture-key', model: 'kling-v3-0-turbo', prompt: 'a quiet landscape',
      referenceImageUrls: [], referenceVideoUrls: [], operation: 'generate',
      ratio: '16:9', duration: 3, resolution: '720p', quality: 'balanced', generateAudio: true,
      watermark: false, pollIntervalMs: 1, timeoutMs: outcome === 'deadline' ? 0 : 600_000,
    });
    if (outcome === 'recover') {
      expect(await request).toMatchObject({ taskId: 'poll-task', buffer: TEST_MP4, duration: 3 });
      expect(polls).toBe(2);
    } else {
      await expect(request).rejects.toMatchObject({ taskId: 'poll-task', errorCode: outcome === 'deadline' ? 'TIMEOUT' : 'PROVIDER_API_ERROR' });
      expect(polls).toBe(outcome === 'deadline' ? 0 : 5);
    }
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('sends the native Veo image object and delivers the generated video through the saved profile', async () => {
    // Google-owned SDK oracle: src/converters/_models_converters.ts,
    // imageToMldev + generateVideosParametersToMldev. predictLongRunning uses
    // bytesBase64Encoded/mimeType, unlike Gemini generateContent inlineData.
    mockState.videoProfiles = [{ id: 'saved-veo', provider: 'google', model: 'veo-3.1-generate-preview', apiKey: 'fixture-key', label: 'Google', createdAt: 1 }];
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://images.example/first.png') return new Response(image);
      if (url.endsWith(':predictLongRunning')) {
        const body = JSON.parse(String(init?.body));
        expect(body.instances).toEqual([{ prompt: 'Animate the first frame.', image: { bytesBase64Encoded: image.toString('base64'), mimeType: 'image/png' } }]);
        expect(body.parameters).toEqual({ aspectRatio: '16:9', durationSeconds: 8, resolution: '1080p' });
        return new Response(JSON.stringify({ name: 'operations/fixture-veo' }));
      }
      if (url.endsWith('/operations/fixture-veo')) return new Response(JSON.stringify({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://video.example/veo.mp4' } }] } } }));
      if (url === 'https://video.example/veo.mp4') {
        expect(init?.headers).toEqual({ 'x-goog-api-key': 'fixture-key' });
        return new Response(TEST_MP4);
      }
      throw new Error(`unexpected fixture request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veo-image-contract-'));
    try {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      const output = path.join(root, 'clip.mp4');
      expect(await generateVideo({ prompt: 'Animate the first frame.', outputAbsPath: output,
        referenceImageUrls: ['https://images.example/first.png'], resolution: '1080p', duration: 6, pollIntervalMs: 1, timeoutMs: 1000 }))
        .toMatchObject({ ok: true, provider: 'google', taskId: 'operations/fixture-veo', duration: 8 });
      expect(await fs.readFile(output)).toEqual(TEST_MP4);
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('uses Runway image-to-video only when a reference image is present', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://api.dev.runwayml.com/v1/image_to_video') {
        return new Response(JSON.stringify({ id: 'runway_image_1' }), { status: 200 });
      }
      if (url === 'https://api.dev.runwayml.com/v1/tasks/runway_image_1') {
        return new Response(JSON.stringify({
          status: 'SUCCEEDED', output: ['https://video.example/runway-image.mp4'],
        }), { status: 200 });
      }
      if (url === 'https://video.example/runway-image.mp4') {
        return new Response(new Uint8Array(TEST_MP4), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const m = await import('../../../src/main/features/video_gen');
    const result = await m.callRunwayVideo({
      apiKey: 'user-key',
      model: 'gen4.5',
      prompt: 'animate the supplied portrait',
      referenceImageUrls: ['https://images.example/portrait.png'],
      referenceVideoUrls: [],
      operation: 'generate',
      ratio: '1:1',
      duration: 8,
      resolution: '720p',
      generateAudio: false,
      watermark: false,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    } as any);

    expect(result.buffer.equals(TEST_MP4)).toBe(true);
    const createCalls = calls.filter((call) => call.init?.method === 'POST');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.url).toBe('https://api.dev.runwayml.com/v1/image_to_video');
    expect(JSON.parse(String(createCalls[0]?.init?.body || '{}'))).toMatchObject({
      model: 'gen4.5',
      promptImage: 'https://images.example/portrait.png',
      promptText: 'animate the supplied portrait',
      ratio: '960:960',
      duration: 10,
    });
  });
});

describe('accepted video delivery ownership', () => {
  it('rejects a provider HTTP success with corrupt bytes and leaves no MP4 artifact', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-gen-test-'));
    const outputPath = path.join(tmpDir, 'corrupt-result.mp4');
    mockState.videoProfiles = [{id:'public-api',provider:'orkas-api',model:'orkas-video',apiKey:'fixture-key'}];
    let createCount = 0;
    let downloadCount = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === 'https://orkas.ai/v1/videos') {
        createCount += 1;
        return new Response(JSON.stringify({
          code: 0,
          id: 'corrupt-task',
          status: 'succeeded',
          url: 'https://video.example/corrupt-task.mp4',
        }), { status: 202 });
      }
      if (url === 'https://video.example/corrupt-task.mp4') {
        downloadCount += 1;
        return new Response('<html>expired signed URL</html>', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    try {
      vi.useFakeTimers();
      const m = await import('../../../src/main/features/video_gen');
      const generation = m.generateVideo({
        prompt: 'make a quiet test clip',
        outputAbsPath: outputPath,
        pollIntervalMs: 1,
        timeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(3_100);
      const result = await generation;

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'DELIVERY_ERROR',
        taskId: 'corrupt-task',
        postDispatch: true,
        message: expect.stringMatching(/invalid or unsupported MP4 bytes/i),
      });
      expect(createCount).toBe(1);
      expect(downloadCount).toBe(3);
      await expect(fs.access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps provider task evidence when cancellation interrupts only the output download backoff', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-cancelled-delivery-'));
    const outputPath = path.join(tmpDir, 'cancelled.mp4');
    mockState.videoProfiles = [{id:'public-api',provider:'orkas-api',model:'orkas-video',apiKey:'fixture-key'}];
    const controller = new AbortController();
    let createCount = 0;
    let downloadCount = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === 'https://orkas.ai/v1/videos') {
        createCount += 1;
        return new Response(JSON.stringify({
          code: 0,
          id: 'cancelled-delivery-task',
          status: 'succeeded',
          url: 'https://video.example/cancelled.mp4',
        }), { status: 202 });
      }
      if (url === 'https://video.example/cancelled.mp4') {
        downloadCount += 1;
        throw new Error('temporary transfer failure');
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    try {
      vi.useFakeTimers();
      const m = await import('../../../src/main/features/video_gen');
      const generation = m.generateVideo({
        prompt: 'one potentially billable clip',
        outputAbsPath: outputPath,
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(downloadCount).toBe(1);
      controller.abort(new Error('user cancelled'));

      await expect(generation).resolves.toMatchObject({
        ok: false,
        errorCode: 'DELIVERY_ERROR',
        taskId: 'cancelled-delivery-task',
        postDispatch: true,
        message: expect.stringMatching(/cancelled after the provider completed generation/i),
      });
      expect(createCount).toBe(1);
      expect(downloadCount).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      await expect(fs.access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not switch to another configured provider after output download retries are exhausted', async () => {
    mockState.videoProfiles = [
      {
        id: 'doubao-primary',
        provider: 'doubao',
        model: 'doubao-seedance-2-0-260128',
        apiKey: 'sk-primary',
        label: 'Primary',
        createdAt: 2,
      },
      {
        id: 'doubao-fallback',
        provider: 'doubao',
        model: 'doubao-seedance-2-0-fast-260128',
        apiKey: 'sk-fallback',
        label: 'Fallback',
        createdAt: 1,
      },
    ];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-delivery-failure-'));
    const outputPath = path.join(tmpDir, 'result.mp4');
    let createCount = 0;
    let downloadCount = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks') {
        createCount += 1;
        return new Response(JSON.stringify({ id: `task_${createCount}`, status: 'queued' }), { status: 200 });
      }
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task_1') {
        return new Response(JSON.stringify({
          status: 'succeeded',
          content: { video_url: 'https://video.example/task_1.mp4' },
        }), { status: 200 });
      }
      if (url === 'https://video.example/task_1.mp4') {
        downloadCount += 1;
        throw new Error('temporary CDN connection reset');
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    try {
      vi.useFakeTimers();
      const m = await import('../../../src/main/features/video_gen');
      const generation = m.generateVideo({
        prompt: 'a single paid clip',
        outputAbsPath: outputPath,
        pollIntervalMs: 1,
        timeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(3_100);
      await expect(generation).resolves.toMatchObject({
        ok: false,
        errorCode: 'DELIVERY_ERROR',
        taskId: 'task_1',
      });
      expect(createCount).toBe(1);
      expect(downloadCount).toBe(3);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not create a second billable provider task when the first video cannot be saved locally', async () => {
    mockState.videoProfiles = [
      {
        id: 'doubao-primary',
        provider: 'doubao',
        model: 'doubao-seedance-2-0-260128',
        apiKey: 'sk-primary',
        label: 'Primary',
        createdAt: 2,
      },
      {
        id: 'doubao-fallback',
        provider: 'doubao',
        model: 'doubao-seedance-2-0-fast-260128',
        apiKey: 'sk-fallback',
        label: 'Fallback',
        createdAt: 1,
      },
    ];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-save-failure-'));
    const blockedParent = path.join(tmpDir, 'not-a-directory');
    await fs.writeFile(blockedParent, 'occupied');
    let createCount = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks') {
        createCount += 1;
        return new Response(JSON.stringify({
          id: `task_${createCount}`,
          status: 'queued',
        }), { status: 200 });
      }
      if (url.startsWith('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task_')) {
        const taskId = url.split('/').pop();
        return new Response(JSON.stringify({
          status: 'succeeded',
          content: { video_url: `https://video.example/${taskId}.mp4` },
        }), { status: 200 });
      }
      if (url.startsWith('https://video.example/task_')) {
        return new Response(new Uint8Array(TEST_MP4), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    try {
      const m = await import('../../../src/main/features/video_gen');
      const result = await m.generateVideo({
        prompt: 'a single paid clip',
        outputAbsPath: path.join(blockedParent, 'out.mp4'),
        pollIntervalMs: 1,
        timeoutMs: 1000,
      });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'IO_ERROR',
        message: expect.stringMatching(/provider completed.*do not retry automatically/i),
      });
      expect(createCount).toBe(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

});


describe('existing generate_video tool with a BYO profile', () => {
  it('delivers a Vidu MP4 and notifies the owning conversation through the unchanged tool contract', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-byo-video-tool-'));
    mockState.workspace = root;
    mockState.videoProfiles = [{id:'saved-vidu',provider:'vidu',model:'viduq3-pro',apiKey:'fixture-key',label:'My Vidu',createdAt:1}];
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      requested.push(url);
      if (url==='https://api.vidu.com/ent/v2/text2video') {
        expect(init?.headers).toMatchObject({Authorization:'Token fixture-key'});
        expect(JSON.parse(String(init?.body))).toMatchObject({model:'viduq3-pro',prompt:'A quiet river.'});
        return new Response(JSON.stringify({task_id:'vidu-owned-task'}));
      }
      if (url==='https://api.vidu.com/ent/v2/tasks/vidu-owned-task/creations') return new Response(JSON.stringify({state:'success',creations:[{url:'https://video.example/owned.mp4'}]}));
      if (url==='https://video.example/owned.mp4') return new Response(TEST_MP4);
      throw new Error('unexpected fixture request');
    });
    try {
      const {createVideoGenTool} = await import('../../../src/main/model/core-agent/video-gen-tool');
      const delivered: string[] = [];
      const tool = createVideoGenTool({userId:'fixture-video-owner',onFileWritten:file=>{delivered.push(file);}});
      expect(tool.name).toBe('generate_video');
      const result = await tool.execute({prompt:'A quiet river.',output_path:'clip.mp4'}, {workingDir:root} as any);
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain('vidu/viduq3-pro');
      expect(result.content).toContain('vidu-owned-task');
      expect(delivered).toEqual([path.join(root,'clip.mp4')]);
      expect(await fs.readFile(delivered[0])).toEqual(TEST_MP4);
      expect(requested).toEqual(['https://api.vidu.com/ent/v2/text2video','https://api.vidu.com/ent/v2/tasks/vidu-owned-task/creations','https://video.example/owned.mp4']);
    } finally { await fs.rm(root,{recursive:true,force:true}); }
  }, 15_000);
});
