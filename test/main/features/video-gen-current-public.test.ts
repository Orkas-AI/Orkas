import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
const TEST_MP4=Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,2,0,105,115,111,109,105,115,111,50]);
const mockState=vi.hoisted(()=>({videoProfiles:[] as any[]}));
vi.mock('node:fs/promises',async importOriginal=>({...await importOriginal<typeof import('node:fs/promises')>()}));
// Protocol tests use signature-only bytes. The owning output conversion suite decodes real media.
vi.mock('../../../src/main/features/video_output_compatibility',()=>({saveCompatibleVideo:vi.fn(async(buffer,file,_wanted,_native,signal,exclusive)=>{if(signal?.aborted)throw signal.reason;await fs.writeFile(file,buffer,exclusive?{flag:'wx'}:undefined);return{bytes:buffer.length,changed:false};})}));
vi.mock('../../../src/main/features/auth',()=>({loadVideoProfiles:()=>mockState.videoProfiles}));
afterEach(async()=>{const proxy=await import('../../../src/main/util/proxy-dispatcher');proxy._resetProxyRoutingForTests();vi.useRealTimers();vi.unstubAllGlobals();vi.resetModules();mockState.videoProfiles=[];});
describe('video_gen › current API generations', () => {
  it.each([
    ['veo-3.1-generate-001', '1080p'], ['veo-3.1-generate-001', '4k'],
    ['veo-3.1-fast-generate-001', '1080p'], ['veo-3.1-fast-generate-001', '4k'],
    ['veo-3.1-lite-generate-001', '1080p'], ['veo-3.1-lite-generate-001', '4k'],
  ])('rejects an overlong high-resolution shot before authorizing or submitting %s/%s', async (model, resolution) => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    mockState.videoProfiles = [{ id: 'cloud-duration-boundary', provider: 'google-cloud', model,
      apiKey: JSON.stringify({ type: 'service_account', project_id: 'video-project', client_email: 'video@video-project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) }];
    const fetch = vi.fn(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture-access', expires_in: 3600 });
      if (url.endsWith(':predictLongRunning')) return Response.json({ name: 'fixture-operation' });
      return Response.json({ done: true, response: { videos: [{ mimeType: 'video/mp4', bytesBase64Encoded: TEST_MP4.toString('base64') }] } });
    });
    vi.stubGlobal('fetch', fetch);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veo-duration-boundary-'));
    try {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      const outputAbsPath = path.join(root, 'clip.mp4');
      expect(await generateVideo({ prompt: 'A continuous thirty-second shot', outputAbsPath, duration: 30, resolution, pollIntervalMs: 1 }))
        .toMatchObject({ ok: false, errorCode: 'BAD_INPUT', dispatched: false, message: expect.stringContaining('duration') });
      expect(fetch).not.toHaveBeenCalled();
      await expect(fs.stat(outputAbsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each([4, 8, undefined])('preserves standard Cloud Veo 4K through authorization, native dispatch and output (duration %s)', async duration => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    mockState.videoProfiles = [{ id: 'cloud-4k', provider: 'google-cloud', model: 'veo-3.1-generate-001',
      apiKey: JSON.stringify({ type: 'service_account', project_id: 'video-project', client_email: 'video@video-project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) }];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture-access', expires_in: 3600 });
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer fixture-access' });
      if (url.endsWith(':predictLongRunning')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ parameters: { resolution: '4k', durationSeconds: 8, sampleCount: 1 } });
        return Response.json({ name: 'projects/video-project/locations/us-central1/operations/4k-task' });
      }
      expect(url).toMatch(/models\/veo-3\.1-generate-001:fetchPredictOperation$/);
      expect(JSON.parse(String(init?.body))).toEqual({ operationName: 'projects/video-project/locations/us-central1/operations/4k-task' });
      return Response.json({ done: true, response: { videos: [{ mimeType: 'video/mp4', bytesBase64Encoded: TEST_MP4.toString('base64') }] } });
    });
    vi.stubGlobal('fetch', fetch);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veo-4k-'));
    try {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      const progress = vi.fn();
      const outputAbsPath = path.join(root, 'clip.mp4');
      expect(await generateVideo({ prompt: 'A lake', outputAbsPath, resolution: '4k', duration, onProgress: progress, pollIntervalMs: 1 }))
        .toMatchObject({ ok: true, model: 'veo-3.1-generate-001', resolution: '4k', duration: 8 });
      expect(await fs.readFile(outputAbsPath)).toEqual(TEST_MP4);
      expect(progress.mock.calls.find(([event]) => event.phase === 'configuration')?.[0].message).toContain('Google Cloud Veo 3.1');
      expect(fetch.mock.calls.filter(([url]) => url.endsWith(':predictLongRunning'))).toHaveLength(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(['veo-3.1-fast-generate-001', 'veo-3.1-lite-generate-001'])('still checks credentials after adapting unsupported 4K on %s', async model => {
    mockState.videoProfiles = [{ id: 'cloud', provider: 'google-cloud', model, apiKey: 'not-needed-for-invalid-parameters' }];
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    expect(await generateVideo({ prompt: 'A lake', outputAbsPath: '/not-written.mp4', resolution: '4k', duration: 8 }))
      .toMatchObject({ ok: false, errorCode: 'BAD_INPUT', dispatched: false, message: expect.stringContaining('service-account') });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves an explicit adaptive ratio for the retained Seedance 2.0 API', async () => {
    mockState.videoProfiles = [{ id: 'retained', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', createdAt: 1 }];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body)).ratio).toBe('adaptive');
        return Response.json({ id: 'adaptive-retained' });
      }
      if (url.endsWith('/tasks/adaptive-retained')) return Response.json({ status: 'succeeded', content: { video_url: 'https://video.example/adaptive.mp4' } });
      return new Response(TEST_MP4);
    });
    vi.stubGlobal('fetch', fetch);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'retained-adaptive-'));
    try {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'A lake', outputAbsPath: path.join(root, 'clip.mp4'), ratio: 'adaptive', pollIntervalMs: 1 })).toMatchObject({ ok: true });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  
  const primary = (provider: string, model: string, extras = {}) => {
    mockState.videoProfiles = [{ id: 'current', provider, model, apiKey: 'fixture-key', createdAt: 1, ...extras }];
  };
  const withOutput = async (run: (outputAbsPath: string) => Promise<void>) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'current-video-'));
    try { await run(path.join(root, 'clip.mp4')); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  };

  it.each([
    ['minimax', 'MiniMax-H3', 'https://api.minimax.cn', 'https://api.minimax.io', '/v2/video_generation', '/v2/query/video_generation/site-task', '768p', 'Bearer'],
    ['vidu', 'viduq3-pro', 'https://api.vidu.cn', 'https://api.vidu.com', '/ent/v2/text2video', '/ent/v2/tasks/site-task/creations', '720p', 'Token'],
    ['kling', 'kling-v4-0', 'https://api-beijing.klingai.com', 'https://api-singapore.klingai.com', '/text-to-video/kling-4.0', '/tasks?task_ids=site-task', '720p', 'Bearer'],
  ].flatMap(row => [undefined, 'global', 'cn'].map(apiSite => [...row, apiSite])))('pins %s creation and tracking to its saved API site (%s)', async (provider, model, cnBase, globalBase, createPath, queryPath, resolution, authorization, apiSite) => {
    primary(provider!, model!, apiSite ? { apiSite } : {});
    const base = apiSite === 'cn' ? cnBase : globalBase;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${base}${createPath}`) {
        expect((init?.headers as Record<string, string>).Authorization).toBe(`${authorization} fixture-key`);
        expect(init?.method).toBe('POST');
        return Response.json(provider === 'kling' ? { code: 0, data: { id: 'site-task' } } : { task_id: 'site-task' });
      }
      if (url === `${base}${queryPath}`) {
        expect((init?.headers as Record<string, string>).Authorization).toBe(`${authorization} fixture-key`);
        const output = 'https://video.example/site.mp4';
        return Response.json(provider === 'minimax' ? { task: { id: 'site-task', status: 'succeeded', content: { url: output } } }
          : provider === 'vidu' ? { state: 'success', creations: [{ url: output }] }
            : { code: 0, data: [{ id: 'site-task', status: 'succeeded', outputs: [{ type: 'video', url: output }] }] });
      }
      expect(url).toBe('https://video.example/site.mp4');
      expect(init?.headers || {}).not.toHaveProperty('Authorization');
      return new Response(TEST_MP4);
    });
    vi.stubGlobal('fetch', fetch);
    await withOutput(async outputAbsPath => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'A lake', outputAbsPath, resolution, pollIntervalMs: 1 }))
        .toMatchObject({ ok: true, provider, model, taskId: 'site-task' });
      expect(await fs.readFile(outputAbsPath)).toEqual(TEST_MP4);
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps an uncertain domestic submission on its original site without trying the international endpoint', async () => {
    primary('minimax', 'MiniMax-H3', { apiSite: 'cn' });
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.minimax.cn/v2/video_generation');
      throw new TypeError('Connection lost after send');
    });
    vi.stubGlobal('fetch', fetch);
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    expect(await generateVideo({ prompt: 'A lake', outputAbsPath: '/not-written.mp4', resolution: '768p' }))
      .toMatchObject({ ok: false, postDispatch: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('https://api.minimax.cn/v2/video_generation');
  });

  it.each([2, 6, 10])('preserves Runway Gen-4.5 native duration %s instead of rounding to an older model tier', async duration => {
    primary('runway', 'gen4.5');
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body)).duration).toBe(duration);
        return Response.json({ id: 'runway-current' });
      }
      if (url.includes('/v1/tasks/')) return Response.json({ status: 'SUCCEEDED', output: ['https://video.example/current.mp4'] });
      return new Response(TEST_MP4);
    });
    vi.stubGlobal('fetch', fetch);
    await withOutput(async outputAbsPath => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'A quiet lake', outputAbsPath, duration, pollIntervalMs: 1 })).toMatchObject({ ok: true, duration });
    });
  });

  it('does not start another H3 poll when its interval reaches the overall deadline', async () => {
    const { callMiniMaxVideo } = await import('../../../src/main/features/video_gen');
    vi.useFakeTimers();
    const fetch = vi.fn(async () => Response.json({ task_id: 'h3-deadline' }));
    vi.stubGlobal('fetch', fetch);
    const outcome = callMiniMaxVideo({ apiKey: 'fixture-key', model: 'MiniMax-H3', prompt: 'A lake',
      referenceImageUrls: [], referenceVideoUrls: [], operation: 'generate', ratio: '16:9', duration: 5,
      resolution: '768p', generateAudio: true, watermark: false, pollIntervalMs: 100, timeoutMs: 100 } as any)
      .then(() => null, error => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ taskId: 'h3-deadline', errorCode: 'TIMEOUT' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for an Omni file to become active and downloads it only from the fixed Google endpoint', async () => {
    primary('google', 'gemini-omni-1.1-flash');
    let filePolls = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'fixture-key' });
      if (init?.method === 'POST') return Response.json({ id: 'omni-file', status: 'in_progress' });
      if (url.endsWith('/interactions/omni-file')) return Response.json({ id: 'omni-file', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', uri: 'https://generativelanguage.googleapis.com/v1beta/files/output:download?alt=media' }] }] });
      if (url.endsWith('/files/output')) return Response.json({ state: ++filePolls === 1 ? 'PROCESSING' : 'ACTIVE' });
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/files/output:download?alt=media');
      return new Response(TEST_MP4);
    });
    vi.stubGlobal('fetch', fetch);
    await withOutput(async outputAbsPath => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'A quiet lake', outputAbsPath, pollIntervalMs: 1 })).toMatchObject({ ok: true, taskId: 'omni-file' });
      expect(filePolls).toBe(2);
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    });
  });

  it.each([
    ['vidu', 'viduq3-turbo', { duration: 17 }],
    ['runway', 'gen4.5', { duration: 11 }],
    ['doubao', 'doubao-seedance-2-0-260128', { duration: 30 }],
  ])('rejects unsupported %s/%s controls before any reference upload or paid submission', async (provider, model, args) => {
    primary(provider as string, model as string);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    expect(await generateVideo({ prompt: 'A lake', outputAbsPath: '/not-written.mp4', referenceImageUrls: ['https://images.example/valid.png'], ...args as object }))
      .toMatchObject({ ok: false, dispatched: false, errorCode: 'BAD_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['veo-3.1-generate-001', 'veo-3.1-fast-generate-001', 'veo-3.1-lite-generate-001'])('uses user Google Cloud authorization, native operation query and inline output for %s', async model => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    primary('google-cloud', model, { apiKey: JSON.stringify({ type: 'service_account', project_id: 'video-project', client_email: 'video@video-project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) });
    const base = `https://us-central1-aiplatform.googleapis.com/v1/projects/video-project/locations/us-central1/publishers/google/models/${model}`;
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const imageMode = model === 'veo-3.1-generate-001';
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://images.example/first.png') return new Response(image);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'user-access', expires_in: 3600 });
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer user-access' });
      if (url === `${base}:predictLongRunning`) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ instances: [{ prompt: 'A quiet lake', ...(imageMode ? { image: { bytesBase64Encoded: image.toString('base64'), mimeType: 'image/png' } } : {}) }], parameters: { durationSeconds: 8, sampleCount: 1, generateAudio: true } });
        return Response.json({ name: 'projects/video-project/locations/us-central1/operations/veo-task' });
      }
      expect(url).toBe(`${base}:fetchPredictOperation`);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ operationName: 'projects/video-project/locations/us-central1/operations/veo-task' });
      return Response.json({ done: true, response: { videos: [{ mimeType: 'video/mp4', bytesBase64Encoded: TEST_MP4.toString('base64') }] } });
    });
    vi.stubGlobal('fetch', fetch);
    await withOutput(async outputAbsPath => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'A quiet lake', outputAbsPath, pollIntervalMs: 1, ...(imageMode ? { referenceImageUrls: ['https://images.example/first.png'] } : {}) })).toMatchObject({ ok: true, provider: 'google-cloud', model, duration: 8 });
      expect(await fs.readFile(outputAbsPath)).toEqual(TEST_MP4);
      expect(fetch).toHaveBeenCalledTimes(imageMode ? 4 : 3);
    });
  });

  it.each(['MiniMax-H3', 'viduq3-turbo', 'kling-v4-0', 'gemini-omni-1.1-flash', 'wan3.0-video'])('never falls back after an uncertain current-tier submission: %s', async model => {
    const provider = ({ 'MiniMax-H3': 'minimax', 'viduq3-turbo': 'vidu', 'kling-v4-0': 'kling', 'gemini-omni-1.1-flash': 'google', 'wan3.0-video': 'aliyun' } as Record<string, string>)[model];
    primary(provider, model, { workspaceId: 'workspace123', region: 'cn-beijing' });
    mockState.videoProfiles.push({ id: 'fallback', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key' });
    const fetch = vi.fn(async () => { throw new Error('fixture lost headers'); }); vi.stubGlobal('fetch', fetch);
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    expect(await generateVideo({ prompt: 'A quiet lake', outputAbsPath: '/not-written.mp4' })).toMatchObject({ ok: false, postDispatch: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('preserves all 30 image and 10 video references and sends explicit Seedance editing semantics', async () => {
    primary('doubao', 'doubao-seedance-2-5-260628');
    const images = Array.from({ length: 30 }, (_, index) => `https://images.example/${index}.png`);
    const videos = Array.from({ length: 10 }, (_, index) => `https://video.example/${index}.mp4`);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ duration: -1, ratio: 'adaptive', omni_reference_task_type: 'edit' });
        expect(body.content.filter((item: any) => item.type === 'image_url').map((item: any) => item.image_url.url)).toEqual(images);
        expect(body.content.filter((item: any) => item.type === 'video_url').map((item: any) => item.video_url.url)).toEqual(videos);
        return Response.json({ id: 'all-references' });
      }
      if (url.endsWith('/tasks/all-references')) return Response.json({ status: 'succeeded', content: { video_url: 'https://video.example/current.mp4' } });
      return new Response(TEST_MP4);
    });
    vi.stubGlobal('fetch', fetch);
    await withOutput(async outputAbsPath => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'Edit the video', outputAbsPath, operation: 'edit', referenceImageUrls: images, referenceVideoUrls: videos, pollIntervalMs: 1 })).toMatchObject({ ok: true });
    });
  });

  it.each([4, 16, 30, -1])('sends Seedance 2.5 duration %s unchanged through create, poll and local delivery', async duration => {
    primary('doubao', 'doubao-seedance-2-5-260628');
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
        expect(JSON.parse(String(init.body))).toMatchObject({ model: 'doubao-seedance-2-5-260628', duration, ratio: 'adaptive', generate_audio: false });
        return Response.json({ id: 'seedance25' });
      }
      if (url.endsWith('/tasks/seedance25')) return Response.json({ status: 'succeeded', duration: 12, ratio: '9:16', content: { video_url: 'https://video.example/current.mp4' } });
      return new Response(TEST_MP4);
    });
    vi.stubGlobal('fetch', fetch);
    await withOutput(async outputAbsPath => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'A quiet lake', outputAbsPath, duration, ratio: 'adaptive', generateAudio: false, pollIntervalMs: 1 }))
        .toMatchObject({ ok: true, model: 'doubao-seedance-2-5-260628', duration: 12, ratio: '9:16' });
      expect(await fs.readFile(outputAbsPath)).toEqual(TEST_MP4);
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    });
  });

  it.each([
    { duration: 31 },
    { referenceImagePaths: Array(31).fill('/not-uploaded.png') },
    { referenceVideoPaths: Array(11).fill('/not-uploaded.mp4') },
  ])('rejects invalid Seedance 2.5 inputs before upload, creation or fallback: %j', async args => {
    primary('doubao', 'doubao-seedance-2-5-260628');
    mockState.videoProfiles.push({ id: 'fallback', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key' });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    expect(await generateVideo({ prompt: 'Edit the video', outputAbsPath: '/not-written.mp4', ...args } as any))
      .toMatchObject({ ok: false, errorCode: 'BAD_INPUT', dispatched: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['MiniMax-H3', '768p', '768P'], ['MiniMax-H3', '2k', '2K'],
    ['MiniMax-H3-Highspeed', '480p', '480P'], ['MiniMax-H3-Lite', '768p', '768P'], ['MiniMax-H3-Max', '768p', '768P'],
  ])('uses the H3 V2 protocol and direct task output for %s at %s', async (model, resolution, nativeResolution) => {
    primary('minimax', model);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(url).toBe('https://api.minimax.io/v2/video_generation');
        expect(JSON.parse(String(init.body))).toEqual({ model, content: [{ type: 'text', text: 'A quiet lake' }], duration: 5, resolution: nativeResolution, ratio: '16:9' });
        return Response.json({ task_id: 'h3-task' });
      }
      if (url.includes('/v2/query/video_generation/')) {
        expect(url).toBe('https://api.minimax.io/v2/query/video_generation/h3-task');
        return Response.json({ task: { id: 'h3-task', status: 'succeeded', content: { url: 'https://video.example/current.mp4' }, resolution: nativeResolution, duration: 5 } });
      }
      expect(url).toBe('https://video.example/current.mp4'); return new Response(TEST_MP4);
    });
    vi.stubGlobal('fetch', fetch);
    await withOutput(async outputAbsPath => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'A quiet lake', outputAbsPath, resolution, pollIntervalMs: 1 }))
        .toMatchObject({ ok: true, provider: 'minimax', model, resolution });
    });
  });

  it.each(['kling-v4-0', 'kling-v4-0-flash'])('uses current Kling Omni references and query receipt for %s', async model => {
    primary('kling', model);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(url).toBe(`https://api-singapore.klingai.com/omni-video/${model === 'kling-v4-0' ? 'kling-4.0' : 'kling-4.0-flash'}`);
        expect(JSON.parse(String(init.body))).toMatchObject({ contents: [
          { type: 'prompt', text: 'Edit @Video1' }, { type: 'base_video', url: 'https://video.example/ref.mp4', id: 'Video1' },
        ], settings: { duration: 5, resolution: '720p', aspect_ratio: '16:9' } });
        return Response.json({ code: 0, data: { id: 'kling4' } });
      }
      if (url.includes('/tasks?')) return Response.json({ code: 0, data: [{ id: 'kling4', status: 'succeeded', outputs: [{ type: 'video', url: 'https://video.example/current.mp4', duration: '5' }] }] });
      return new Response(TEST_MP4);
    });
    vi.stubGlobal('fetch', fetch);
    await withOutput(async outputAbsPath => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'Edit @Video1', outputAbsPath, operation: 'edit', referenceVideoUrls: ['https://video.example/ref.mp4'], pollIntervalMs: 1 }))
        .toMatchObject({ ok: true, model });
    });
  });

  it('accepts Kling English prompts above the non-English budget without truncation', async () => {
    primary('kling', 'kling-v4-0');
    const prompt = 'a'.repeat(12000);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body)).prompt).toBe(prompt);
        return Response.json({ code: 0, data: { id: 'long-kling' } });
      }
      if (url.includes('/tasks?')) return Response.json({ code: 0, data: [{ id: 'long-kling', status: 'succeeded', outputs: [{ type: 'video', url: 'https://video.example/current.mp4' }] }] });
      return new Response(TEST_MP4);
    });
    vi.stubGlobal('fetch', fetch);
    await withOutput(async outputAbsPath => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt, outputAbsPath, pollIntervalMs: 1 })).toMatchObject({ ok: true });
    });
  });

  it.each(['a'.repeat(26001), '湖'.repeat(11001), 'a'.repeat(13000) + '湖'.repeat(5501)])('rejects an over-budget native Kling prompt before submission', async prompt => {
    primary('kling', 'kling-v4-0');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    expect(await generateVideo({ prompt, outputAbsPath: '/not-written.mp4' })).toMatchObject({ ok: false, dispatched: false, errorCode: 'BAD_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['wan3.0-video', 'wan3.0-video-prime'])('keeps Wan region/workspace consistent from submission to query for %s', async model => {
    primary('aliyun', model, { workspaceId: 'workspace123', region: 'ap-southeast-1' });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(url).toBe('https://workspace123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis');
        expect(init.headers).toMatchObject({ 'X-DashScope-Async': 'enable', Authorization: 'Bearer fixture-key' });
        expect(JSON.parse(String(init.body))).toMatchObject({ model, input: { prompt: 'A quiet lake' }, parameters: { duration: 30, resolution: '1080P', audio: false } });
        return Response.json({ output: { task_id: 'wan-task', task_status: 'PENDING' } });
      }
      if (url.includes('/api/v1/tasks/')) {
        expect(url).toBe('https://workspace123.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/wan-task');
        return Response.json({ output: { task_id: 'wan-task', task_status: 'SUCCEEDED', video_url: 'https://video.example/current.mp4' } });
      }
      return new Response(TEST_MP4);
    });
    vi.stubGlobal('fetch', fetch);
    await withOutput(async outputAbsPath => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'A quiet lake', outputAbsPath, duration: 30, resolution: '1080p', generateAudio: false, pollIntervalMs: 1 }))
        .toMatchObject({ ok: true, model });
    });
  });

  it('reads Omni REST model-output steps instead of SDK-only convenience fields', async () => {
    primary('google', 'gemini-omni-1.1-flash');
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
      expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'fixture-key' });
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gemini-omni-1.1-flash', background: true, response_format: { type: 'video', delivery: 'uri', aspect_ratio: '16:9', resolution: '720p' } });
      return Response.json({ id: 'omni-task', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: TEST_MP4.toString('base64') }] }] });
    });
    vi.stubGlobal('fetch', fetch);
    await withOutput(async outputAbsPath => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'A quiet lake', outputAbsPath, pollIntervalMs: 1 })).toMatchObject({ ok: true, model: 'gemini-omni-1.1-flash', taskId: 'omni-task' });
      expect(await fs.readFile(outputAbsPath)).toEqual(TEST_MP4);
      expect(fetch).toHaveBeenCalledOnce();
    });
  });
});

describe('video_gen › a service the user chose for one request', () => {
  // On the canvas a user can make a shot again on another configured service (decided
  // 2026-11-09). Only that service is tried: falling back would make the shot on a model the
  // user did not pick, and possibly charge another account.
  const doubaoTask = (url: string, init?: RequestInit): Response | null => {
    if (url.includes('volces.com') && init?.method === 'POST') return new Response(JSON.stringify({ id: 'chosen-task' }));
    if (url.includes('/tasks/chosen-task')) return new Response(JSON.stringify({ status: 'succeeded', content: { video_url: 'https://video.example/chosen.mp4' } }));
    if (url === 'https://video.example/chosen.mp4') return new Response(new Uint8Array(TEST_MP4));
    return null;
  };
  
  const posts = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST').map(([url]) => String(url));

  async function inTemp<T>(run: (root: string) => Promise<T>): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-chosen-'));
    try { return await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
  }

  it('makes the shot on the chosen service even when another comes first', async () => {
    mockState.videoProfiles = [
      { id: 'first', provider: 'kling', model: 'kling-v3-0-turbo', apiKey: 'fixture-key', createdAt: 1 },
      { id: 'chosen', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', createdAt: 2 },
    ];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => doubaoTask(url, init) ?? new Response('unexpected', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    await inTemp(async (root) => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      expect(await generateVideo({ prompt: 'A quiet landscape', outputAbsPath: path.join(root, 'clip.mp4'), pollIntervalMs: 1, profileId: 'chosen' }))
        .toMatchObject({ ok: true, provider: 'doubao', taskId: 'chosen-task' });
    });
    expect(fetch.mock.calls.some(([url]) => String(url).includes('klingai'))).toBe(false);
  });

  it('does not fall back to another service when the chosen one refuses', async () => {
    mockState.videoProfiles = [
      { id: 'chosen', provider: 'kling', model: 'kling-v3-0-turbo', apiKey: 'fixture-key', createdAt: 1 },
      { id: 'other', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', createdAt: 2 },
    ];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => (url.includes('klingai.com')
      ? new Response(JSON.stringify({ code: 123, message: 'refused' }), { status: 400 })
      : doubaoTask(url, init) ?? new Response('unexpected', { status: 500 })));
    vi.stubGlobal('fetch', fetch);
    await inTemp(async (root) => {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      const result = await generateVideo({ prompt: 'A quiet landscape', outputAbsPath: path.join(root, 'clip.mp4'), pollIntervalMs: 1, profileId: 'chosen' });
      expect(result).toMatchObject({ ok: false });
      await expect(fs.access(path.join(root, 'clip.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    expect(posts(fetch)).toHaveLength(1);
    expect(posts(fetch)[0]).toContain('klingai.com');
  });

  

  it('sends nothing when the chosen service is no longer configured', async () => {
    mockState.videoProfiles = [{ id: 'own', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', createdAt: 1 }];
    const fetch = vi.fn(async () => new Response('unexpected', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    expect(await generateVideo({ prompt: 'A quiet landscape', outputAbsPath: path.join(os.tmpdir(), 'never-written.mp4'), profileId: 'removed' }))
      .toMatchObject({ ok: false, errorCode: 'NO_CAPABLE_MODEL', dispatched: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('video_gen › first and last frames', () => {
  const FIRST = 'https://images.example/first.png';
  const LAST = 'https://images.example/last.png';
  const REFERENCE = 'https://images.example/reference.png';
  const OUTPUT = 'https://video.example/framed.mp4';
  const PROMPT = 'The lamp turns on and the room fills with light';
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const ARK = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';
  const KLING = 'https://api-singapore.klingai.com';
  const CANNOT_COMBINE = 'cannot combine first_frame or last_frame with reference images or videos. Send the images either as frames or as references.';
  const BOTH_FRAMES = [
    { type: 'text', text: PROMPT },
    { type: 'image_url', role: 'first_frame', image_url: { url: FIRST } },
    { type: 'image_url', role: 'last_frame', image_url: { url: LAST } },
  ];

  function own(provider: string, model: string, extras: Record<string, unknown> = {}) {
    mockState.videoProfiles = [{ id: 'own', provider, model, apiKey: 'fixture-key', createdAt: 1, ...extras }];
  }

  /** A service's own create, query and result, keeping what each creation asked for. */
  function serve(routes: Record<string, unknown>) {
    const created: Array<{ url: string; body: any }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url in routes) {
        if (init?.method === 'POST') created.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json(routes[url]);
      }
      if (url === OUTPUT) return new Response(TEST_MP4);
      if (url === FIRST || url === LAST) return new Response(PNG);
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    return { created, fetch };
  }

  async function generate(args: Record<string, unknown>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-frames-'));
    try {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      return await generateVideo({ prompt: PROMPT, outputAbsPath: path.join(root, 'clip.mp4'), pollIntervalMs: 1, timeoutMs: 5000, ...args } as any);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }

  const seedance = () => serve({ [ARK]: { id: 'framed' }, [`${ARK}/framed`]: { status: 'succeeded', content: { video_url: OUTPUT } } });
  const kling = (endpoint: string) => serve({
    [`${KLING}/${endpoint}`]: { code: 0, data: { id: 'framed' } },
    [`${KLING}/tasks?task_ids=framed`]: { code: 0, data: [{ id: 'framed', status: 'succeeded', outputs: [{ type: 'video', url: OUTPUT }] }] },
  });

  it.each(['doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628'])('sends %s both frames by role, at the first frame\'s aspect ratio', async (model) => {
    own('doubao', model);
    const { created } = seedance();
    expect(await generate({ firstFrameUrl: FIRST, lastFrameUrl: LAST })).toMatchObject({ ok: true });
    expect(created).toHaveLength(1);
    expect(created[0].body.content).toEqual(BOTH_FRAMES);
    expect(created[0].body.ratio).toBe('adaptive');
  });

  it('keeps an aspect ratio asked for where Seedance 2.0 lets one be set', async () => {
    own('doubao', 'doubao-seedance-2-0-260128');
    const { created } = seedance();
    expect(await generate({ firstFrameUrl: FIRST, ratio: '9:16' })).toMatchObject({ ok: true });
    expect(created[0].body.content).toEqual(BOTH_FRAMES.slice(0, 2));
    expect(created[0].body.ratio).toBe('9:16');
  });

  it('accepts adaptive where the first frame sets the aspect ratio', async () => {
    own('doubao', 'doubao-seedance-2-5-260628');
    const { created } = seedance();
    expect(await generate({ firstFrameUrl: FIRST, ratio: 'adaptive' })).toMatchObject({ ok: true });
    expect(created[0].body.content).toEqual(BOTH_FRAMES.slice(0, 2));
    expect(created[0].body.ratio).toBe('adaptive');
  });

  it('sends MiniMax H3 both frames by role, at the first frame\'s aspect ratio', async () => {
    own('minimax', 'MiniMax-H3');
    const { created } = serve({
      'https://api.minimax.io/v2/video_generation': { task_id: 'framed' },
      'https://api.minimax.io/v2/query/video_generation/framed': { task: { id: 'framed', status: 'succeeded', content: { url: OUTPUT } } },
    });
    expect(await generate({ firstFrameUrl: FIRST, lastFrameUrl: LAST, ratio: 'adaptive' })).toMatchObject({ ok: true });
    expect(created[0].body.content).toEqual(BOTH_FRAMES);
    expect(created[0].body.ratio).toBe('adaptive');
  });

  // Seen with real Lite tasks on 2026-11-10: one 480x864 first frame came back 864x480 at the
  // default 16:9 and 480x864 at 9:16. Lite keeps no frame's shape, so it takes the ratio asked.
  it('sends MiniMax H3 Lite frames at the aspect ratio asked, and at 16:9 when none is', async () => {
    own('minimax', 'MiniMax-H3-Lite');
    const { created } = serve({
      'https://api.minimax.io/v2/video_generation': { task_id: 'framed' },
      'https://api.minimax.io/v2/query/video_generation/framed': { task: { id: 'framed', status: 'succeeded', content: { url: OUTPUT } } },
    });
    expect(await generate({ firstFrameUrl: FIRST, ratio: '9:16' })).toMatchObject({ ok: true });
    expect(created[0].body.content).toEqual(BOTH_FRAMES.slice(0, 2));
    expect(created[0].body.ratio).toBe('9:16');
    expect(await generate({ firstFrameUrl: FIRST })).toMatchObject({ ok: true });
    expect(created[1].body.ratio).toBe('16:9');
  });

  it('places Kling 4.0 frames first and last around its reference images', async () => {
    own('kling', 'kling-v4-0');
    const { created } = kling('omni-video/kling-4.0');
    expect(await generate({ firstFrameUrl: FIRST, lastFrameUrl: LAST, referenceImageUrls: [REFERENCE] })).toMatchObject({ ok: true });
    expect(created[0].body.contents).toEqual([
      { type: 'prompt', text: PROMPT },
      { type: 'first_frame', url: FIRST },
      { type: 'refer_image', url: REFERENCE, id: 'Image1' },
      { type: 'last_frame', url: LAST },
    ]);
    expect(created[0].body.settings.aspect_ratio).toBe('adaptive');
  });

  it('opens a Kling 4.0 Flash video on its first frame, adaptive included', async () => {
    own('kling', 'kling-v4-0-flash');
    const { created } = kling('omni-video/kling-4.0-flash');
    expect(await generate({ firstFrameUrl: FIRST, ratio: 'adaptive' })).toMatchObject({ ok: true });
    expect(created[0].body.contents).toEqual([{ type: 'prompt', text: PROMPT }, { type: 'first_frame', url: FIRST }]);
  });

  it.each([
    [{ firstFrameUrl: FIRST, lastFrameUrl: LAST }, 'start-end2video', [FIRST, LAST]],
    [{ firstFrameUrl: FIRST }, 'img2video', [FIRST]],
  ])('sends Vidu Q3 frames to the endpoint for them (%j)', async (frames, endpoint, images) => {
    own('vidu', 'viduq3-pro');
    const { created } = serve({
      [`https://api.vidu.com/ent/v2/${endpoint}`]: { task_id: 'framed' },
      'https://api.vidu.com/ent/v2/tasks/framed/creations': { state: 'success', creations: [{ url: OUTPUT }] },
    });
    expect(await generate(frames)).toMatchObject({ ok: true });
    expect(created[0].body).toMatchObject({ model: 'viduq3-pro', prompt: PROMPT, images });
    expect(created[0].body).not.toHaveProperty('aspect_ratio');
  });

  it('sends Wan 3.0 both frames as media', async () => {
    own('aliyun', 'wan3.0-video', { workspaceId: 'workspace123', region: 'ap-southeast-1' });
    const base = 'https://workspace123.ap-southeast-1.maas.aliyuncs.com/api/v1';
    const { created } = serve({
      [`${base}/services/aigc/video-generation/video-synthesis`]: { output: { task_id: 'framed', task_status: 'PENDING' } },
      [`${base}/tasks/framed`]: { output: { task_id: 'framed', task_status: 'SUCCEEDED', video_url: OUTPUT } },
    });
    expect(await generate({ firstFrameUrl: FIRST, lastFrameUrl: LAST })).toMatchObject({ ok: true });
    expect(created[0].body.input.media).toEqual([{ type: 'first_frame', url: FIRST }, { type: 'last_frame', url: LAST }]);
    expect(created[0].body.parameters.ratio).toBe('adaptive');
  });

  it('opens a Runway Gen-4.5 video on its first frame, at an image-to-video ratio', async () => {
    own('runway', 'gen4.5');
    const { created } = serve({
      'https://api.dev.runwayml.com/v1/image_to_video': { id: 'framed' },
      'https://api.dev.runwayml.com/v1/tasks/framed': { status: 'SUCCEEDED', output: [OUTPUT] },
    });
    expect(await generate({ firstFrameUrl: FIRST, ratio: '1:1' })).toMatchObject({ ok: true });
    expect(created[0].body).toMatchObject({ model: 'gen4.5', promptImage: FIRST, ratio: '960:960' });
  });

  it('gives Cloud Veo 3.1 both frames as images', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    own('google-cloud', 'veo-3.1-generate-001', { apiKey: JSON.stringify({
      type: 'service_account', project_id: 'video-project', client_email: 'video@video-project.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }) });
    const created: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture-access', expires_in: 3600 });
      if (url === FIRST || url === LAST) return new Response(PNG);
      if (url.endsWith(':predictLongRunning')) {
        created.push(JSON.parse(String(init?.body)));
        return Response.json({ name: 'projects/video-project/locations/us-central1/operations/framed' });
      }
      if (url.endsWith(':fetchPredictOperation')) return Response.json({ done: true, response: { videos: [{ mimeType: 'video/mp4', bytesBase64Encoded: TEST_MP4.toString('base64') }] } });
      throw new Error(`unexpected request: ${url}`);
    }));
    expect(await generate({ firstFrameUrl: FIRST, lastFrameUrl: LAST })).toMatchObject({ ok: true });
    const image = { mimeType: 'image/png', bytesBase64Encoded: PNG.toString('base64') };
    expect(created).toHaveLength(1);
    expect(created[0].instances[0]).toEqual({ prompt: PROMPT, image, lastFrame: image });
  });

  it('opens a saved MiniMax Hailuo 2.3 video on its first frame', async () => {
    own('minimax', 'MiniMax-Hailuo-2.3');
    const { created } = serve({
      'https://api.minimax.io/v1/video_generation': { task_id: 'framed' },
      'https://api.minimax.io/v1/query/video_generation?task_id=framed': { status: 'Success', file_id: 'file_1' },
      'https://api.minimax.io/v1/files/retrieve?file_id=file_1': { file: { download_url: OUTPUT } },
    });
    expect(await generate({ firstFrameUrl: FIRST })).toMatchObject({ ok: true });
    expect(created[0].body.first_frame_image).toBe(FIRST);
  });

  it('opens a saved Kling 3.0 Turbo video on its first frame', async () => {
    own('kling', 'kling-v3-0-turbo');
    const { created } = kling('image-to-video/kling-3.0-turbo');
    expect(await generate({ firstFrameUrl: FIRST })).toMatchObject({ ok: true });
    expect(created[0].body.contents).toEqual([{ type: 'prompt', text: PROMPT }, { type: 'first_frame', url: FIRST }]);
  });

  

  

  it.each([
    ['doubao', 'doubao-seedance-2-0-260128', { lastFrameUrl: LAST },
      'last_frame needs first_frame. Pass the opening image as first_frame too, or move this image to first_frame.'],
    ['doubao', 'doubao-seedance-2-5-260628', { firstFrameUrl: FIRST, operation: 'edit', referenceVideoUrls: ['https://video.example/base.mp4'], duration: -1, ratio: 'adaptive' },
      'operation=edit cannot use first_frame or last_frame.'],
    ['google', 'gemini-omni-1.1-flash', { firstFrameUrl: FIRST },
      'Gemini Omni has no frame setting. Pass the images as reference images and say in the prompt which one opens the video and which one ends it.'],
    ['google-cloud', 'veo-3.1-lite-generate-001', { firstFrameUrl: FIRST }, 'Google Cloud Veo 3.1 Lite does not accept images; remove first_frame.'],
    ['kling', 'kling-v4-0-flash', { firstFrameUrl: FIRST, lastFrameUrl: LAST }, 'Kling 4.0 Flash takes a first frame only; remove last_frame.'],
    ['runway', 'gen4.5', { firstFrameUrl: FIRST, lastFrameUrl: LAST }, 'Runway Gen-4.5 takes a first frame only; remove last_frame.'],
    ['kling', 'kling-v3-0-turbo', { firstFrameUrl: FIRST, lastFrameUrl: LAST }, 'Kling 3.0 Turbo takes a first frame only; remove last_frame.'],
    ['minimax', 'MiniMax-Hailuo-2.3', { firstFrameUrl: FIRST, lastFrameUrl: LAST }, 'MiniMax Hailuo 2.3 takes a first frame only; remove last_frame.'],
    ['minimax', 'MiniMax-H3', { firstFrameUrl: FIRST, referenceImageUrls: [REFERENCE] }, `MiniMax H3 ${CANNOT_COMBINE}`],
    ['doubao', 'doubao-seedance-2-0-260128', { firstFrameUrl: FIRST, referenceVideoUrls: ['https://video.example/reference.mp4'] }, `Doubao Seedance 2.0 ${CANNOT_COMBINE}`],
    ['aliyun', 'wan3.0-video', { firstFrameUrl: FIRST, lastFrameUrl: LAST, referenceImageUrls: [REFERENCE] }, `Alibaba Cloud Wan 3.0 ${CANNOT_COMBINE}`],
    ['google-cloud', 'veo-3.1-generate-001', { firstFrameUrl: FIRST, referenceImageUrls: [REFERENCE] }, `Google Cloud Veo 3.1 ${CANNOT_COMBINE}`],
    ['vidu', 'viduq3-pro', { firstFrameUrl: FIRST, referenceImageUrls: [REFERENCE] }, `Vidu Q3 Pro ${CANNOT_COMBINE}`],
    ['kling', 'kling-v3-0-turbo', { firstFrameUrl: FIRST, referenceImageUrls: [REFERENCE] }, `Kling 3.0 Turbo ${CANNOT_COMBINE}`],
    ['kling', 'kling-v4-0', { firstFrameUrl: FIRST, lastFrameUrl: LAST, referenceImageUrls: Array.from({ length: 9 }, (_, i) => `https://images.example/${i}.png`) },
      'Kling 4.0 accepts at most 10 images, frames included.'],
  ])('refuses frames %s %s cannot take, before anything is sent (%j)', async (provider, model, frames, message) => {
    own(provider, model, provider === 'aliyun' ? { workspaceId: 'workspace123', region: 'ap-southeast-1' } : {});
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await generate(frames)).toEqual({ ok: false, errorCode: 'BAD_INPUT', message, dispatched: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  
});

describe('public API reference envelope after expanded native tiers',()=>{
 it.each([{images:10,videos:0},{images:0,videos:4}])('refuses oversized references before any HTTP or output write: %j',async({images,videos})=>{
  mockState.videoProfiles=[{id:'public',provider:'orkas-api',model:'orkas-video',apiKey:'fixture-key',createdAt:1}];
  const fetch=vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({id:'oversize'}):Response.json({status:'failed',error:{code:'BAD_INPUT'}}));vi.stubGlobal('fetch',fetch);
  const {generateVideo}=await import('../../../src/main/features/video_gen');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'public-video-envelope-'));
  try{const result=await generateVideo({prompt:'a clip',outputAbsPath:path.join(dir,'clip.mp4'),referenceImageUrls:Array.from({length:images},(_,i)=>'https://image.example/'+i+'.png'),referenceVideoUrls:Array.from({length:videos},(_,i)=>'https://video.example/'+i+'.mp4'),pollIntervalMs:1});
   expect(result).toMatchObject({ok:false,errorCode:'BAD_INPUT',dispatched:false});expect(fetch).not.toHaveBeenCalled();expect(await fs.readdir(dir)).toEqual([]);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
 });
});


describe('shared native video output and reference progress', () => {
  async function nativeRequest(extra: Record<string, unknown>, inspect: (result: any, progress: ReturnType<typeof vi.fn>, root: string) => Promise<void>) {
    mockState.videoProfiles = [{ id: 'native-source-parity', provider: 'doubao', model: 'doubao-seedance-2-5-260628', apiKey: 'fixture-key' }];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ id: 'source-parity-task' });
      if (url.endsWith('/tasks/source-parity-task')) return Response.json({ status: 'succeeded', content: { video_url: 'https://video.example/source-parity.mp4' } });
      expect(url).toBe('https://video.example/source-parity.mp4');
      return new Response(TEST_MP4);
    });
    vi.stubGlobal('fetch', fetch);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-source-parity-'));
    const progress = vi.fn();
    try {
      const { generateVideo } = await import('../../../src/main/features/video_gen');
      const result = await generateVideo({ prompt: 'A quiet lake', outputAbsPath: path.join(root, 'clip.mp4'), pollIntervalMs: 1, onProgress: progress, ...extra });
      await inspect(result, progress, root);
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
  it('includes opening and ending frames in reference preparation progress', async () => {
    await nativeRequest({ firstFrameUrl: 'https://reference.example/first.png', lastFrameUrl: 'https://reference.example/last.png' }, async (result, progress) => {
      expect(result).toMatchObject({ ok: true });
      expect(progress.mock.calls.find(([event]) => event.phase === 'prepare_references')?.[0].data).toEqual({ count: 2 });
    });
  });
  it('retains an explicitly requested native output extension as the source does', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-output-path-'));
    const outputAbsPath = path.join(root, 'requested.mov');
    try {
      await nativeRequest({ outputAbsPath }, async result => {
        expect(result).toMatchObject({ ok: true, path: outputAbsPath });
        expect(await fs.readFile(outputAbsPath)).toEqual(TEST_MP4);
        await expect(fs.stat(path.join(root, 'requested.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
      });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
