import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  profiles: [] as Array<{
    id: string;
    provider: string;
    model: string;
    apiKey: string;
    label: string;
    createdAt: number;
  }>,
  registerGeneratedMediaUrl: vi.fn(),
  downloadBinaryWithProxyPolicy: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../src/main/features/auth', () => ({
  loadVideoProfiles: () => mocks.profiles.map((profile) => ({ ...profile })),
}));

vi.mock('../../../src/main/features/generation_reference_assets', () => ({
  prepareReferenceUrls: vi.fn(async ({ urls }: { urls?: string[] }) => [...(urls || [])]),
  registerGeneratedMediaUrl: mocks.registerGeneratedMediaUrl,
}));

vi.mock('../../../src/main/util/proxy-dispatcher', () => ({
  downloadBinaryWithProxyPolicy: mocks.downloadBinaryWithProxyPolicy,
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));

import { generateVideo, validateDownloadedVideo } from '../../../src/main/features/video_gen';

let tmpDir: string;

function mp4Fixture(): Buffer {
  const out = Buffer.alloc(24);
  out.writeUInt32BE(24, 0);
  out.write('ftyp', 4, 'ascii');
  out.write('isom', 8, 'ascii');
  out.writeUInt32BE(0, 12);
  out.write('isom', 16, 'ascii');
  out.write('mp42', 20, 'ascii');
  return out;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-gen-'));
  mocks.profiles = [{
    id: 'vid-orkas',
    provider: 'orkas-api',
    model: 'orkas-video',
    apiKey: 'orkas-user-key',
    label: 'Orkas',
    createdAt: 1,
  }];
  mocks.registerGeneratedMediaUrl.mockReset();
  mocks.warn.mockReset();
  mocks.downloadBinaryWithProxyPolicy.mockReset();
  mocks.downloadBinaryWithProxyPolicy.mockImplementation(async (_url, options) => {
    const body = mp4Fixture();
    options?.validate?.(body);
    return { body, finalUrl: 'https://cdn.example.test/video.mp4' };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('video_gen › Orkas public API', () => {
  it('creates, downloads, and saves a public API video without sending a model', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      id: 'video_public_test',
      status: 'succeeded',
      url: 'https://cdn.example.test/video.mp4',
      duration: 5,
      ratio: '16:9',
      resolution: '720p',
    }), { status: 202 }));
    vi.stubGlobal('fetch', fetchStub);
    const requestedPath = path.join(tmpDir, 'result.mov');

    const result = await generateVideo({
      prompt: 'a paper boat crosses a pond',
      outputAbsPath: requestedPath,
      quality: 'economy',
      generateAudio: false,
      usageContext: { conversationId: 'conv_123', turnId: 'turn-456' },
    });

    expect(result).toMatchObject({
      ok: true,
      path: path.join(tmpDir, 'result.mp4'),
      provider: 'orkas-api',
      model: 'orkas-video',
      taskId: 'video_public_test',
    });
    expect(fs.readFileSync(path.join(tmpDir, 'result.mp4'))).toEqual(mp4Fixture());
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith(
      'https://orkas.ai/v1/videos',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Orkas-Conversation-Id': 'conv_123',
          'X-Orkas-Turn-Id': 'turn-456',
        }),
      }),
    );
    const body = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      prompt: 'a paper boat crosses a pond',
      quality: 'balanced',
      generate_audio: false,
    });
    expect(body).not.toHaveProperty('model');
    expect(mocks.registerGeneratedMediaUrl).toHaveBeenCalledWith(
      path.join(tmpDir, 'result.mp4'),
      'https://cdn.example.test/video.mp4',
    );
  });

  it('fails before dispatch when edit mode has no reference video', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);

    await expect(generateVideo({
      prompt: 'change the ending',
      outputAbsPath: path.join(tmpDir, 'edit.mp4'),
      operation: 'edit',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'BAD_INPUT',
      message: expect.stringContaining('requires at least one reference video'),
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('returns NO_CAPABLE_MODEL when no Orkas public video profile exists', async () => {
    mocks.profiles = [];
    await expect(generateVideo({
      prompt: 'a quiet landscape',
      outputAbsPath: path.join(tmpDir, 'missing.mp4'),
    })).resolves.toMatchObject({ ok: false, errorCode: 'NO_CAPABLE_MODEL' });
  });

  it('rejects non-MP4 downloads', () => {
    expect(() => validateDownloadedVideo(Buffer.from('not a video'))).toThrow(/invalid or unsupported MP4/);
  });
});

describe('video request body lifetime', () => {
  it.each(['cancel', 'deadline'] as const)('keeps %s active after create response headers arrive', async (mode) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let bodyRead!: () => void;
    const reading = new Promise<void>((resolve) => { bodyRead = resolve; });
    const fetchStub = vi.fn(async (_url, init) => ({
      ok: true,
      status: 202,
      text: () => new Promise<string>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        bodyRead();
      }),
    }));
    vi.stubGlobal('fetch', fetchStub);
    try {
      const pending = generateVideo({ prompt: 'test', outputAbsPath: path.join(tmpDir, 'pending.mp4'), signal: controller.signal });
      await reading;
      if (mode === 'cancel') controller.abort();
      else await vi.advanceTimersByTimeAsync(60_001);
      expect(await pending).toMatchObject({ ok: false, message: expect.stringMatching(mode === 'cancel' ? /abort/i : /timed out/i) });
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(mocks.downloadBinaryWithProxyPolicy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tmpDir, 'pending.mp4'))).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});


describe('video_gen expired provider tasks', () => {
  const adapterRequest = {
    model: 'doubao-seedance-2-0-260128', prompt: 'x', referenceImageUrls: [], referenceVideoUrls: [],
    operation: 'generate', ratio: '16:9', duration: 5, resolution: '720p', generateAudio: false,
    watermark: false, pollIntervalMs: 1, timeoutMs: 600_000,
  } as any;
  it('stops the user-key Doubao tracker on the first expired status', async () => {
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'expired-task', status: 'queued' }));
      polls += 1;
      return new Response(JSON.stringify({ status: polls < 3 ? 'expired' : 'failed' }));
    }));
    const { callDoubaoVideo } = await import('../../../src/main/features/video_gen');
    await expect(callDoubaoVideo({ ...adapterRequest, apiKey: 'sk-user' })).rejects.toThrow(/expired-task expired/);
    expect(polls).toBe(1);
  });
  it.each(['created', 'polled'])('stops an expired public API task at the %s response without downloading or creating again', async stage => {
    let polls = 0;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'expired-public-task', status: stage === 'created' ? 'expired' : 'queued' }));
      polls += 1;
      return new Response(JSON.stringify({ id: 'expired-public-task', status: polls < 3 ? 'expired' : 'failed', url: 'https://cdn.example.test/must-not-download.mp4' }));
    });
    vi.stubGlobal('fetch', fetch);
    const output = path.join(tmpDir, 'preserved.mp4');
    fs.writeFileSync(output, 'previous usable video');
    const result = await generateVideo({ prompt: 'A quiet landscape', outputAbsPath: output, pollIntervalMs: 1 });
    expect(result).toMatchObject({ ok: false, errorCode: 'PROVIDER_API_ERROR' });
    expect(result.message).toContain('expired-public-task expired');
    expect(polls).toBe(stage === 'created' ? 0 : 1);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(mocks.downloadBinaryWithProxyPolicy).not.toHaveBeenCalled();
    expect(mocks.registerGeneratedMediaUrl).not.toHaveBeenCalled();
    expect(fs.readFileSync(output, 'utf8')).toBe('previous usable video');
  });
});

describe('video_gen › transient status failures on an accepted task', () => {
  // The accepted task keeps running whether or not this client is watching. One failed status read must not abandon it, and a
  // new creation request would pay twice. Rejections stay immediate: repeating them
  // cannot help, and they must not wait out a retry budget.
  const VIDEO_URL = 'https://video.example/accepted.mp4';
  const request = (extra: Record<string, unknown> = {}) => ({
    model: 'doubao-seedance-2-0-260128', prompt: 'x', referenceImageUrls: [], referenceVideoUrls: [],
    operation: 'generate', ratio: '16:9', duration: 5, resolution: '720p', generateAudio: true,
    watermark: false, pollIntervalMs: 1, timeoutMs: 600_000, apiKey: 'fixture-key', ...extra,
  }) as any;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const adapters = {
    doubao: {
      call: 'callDoubaoVideo',
      create: () => json({ id: 'accepted-task', status: 'queued' }),
      processing: () => json({ status: 'running' }),
      done: () => json({ status: 'succeeded', content: { video_url: VIDEO_URL } }),
    },
    kling: {
      call: 'callKlingVideo',
      create: () => json({ code: 0, data: { id: 'accepted-task' } }),
      processing: () => json({ code: 0, data: [{ id: 'accepted-task', status: 'processing' }] }),
      done: () => json({ code: 0, data: [{ id: 'accepted-task', status: 'succeeded', outputs: [{ type: 'video', url: VIDEO_URL }] }] }),
    },
  } as const;
  const names = Object.keys(adapters) as Array<keyof typeof adapters>;
  type Step = () => Response;
  const upstream = (status: number, body = 'SYNTHETIC_UPSTREAM_BODY'): Step => () => new Response(body, { status });
  const thrown = (message: string, Type: new (m: string) => Error = Error): Step => () => { throw new Type(message); };

  /** Replays one scripted answer per status read; the last answer repeats. */
  function stub(name: keyof typeof adapters, steps: Step[]) {
    const counts = { creates: 0, polls: 0 };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === VIDEO_URL) return new Response(new Uint8Array(mp4Fixture()));
      if (init?.method === 'POST') { counts.creates += 1; return adapters[name].create(); }
      const step = steps[Math.min(counts.polls, steps.length - 1)];
      counts.polls += 1;
      return step();
    }));
    return counts;
  }
  const run = async (name: keyof typeof adapters, extra?: Record<string, unknown>) => {
    const m: any = await import('../../../src/main/features/video_gen');
    return m[adapters[name].call](request(extra));
  };

  it.each(names)('%s: delivers after server errors, rate limits and dropped connections', async name => {
    const counts = stub(name, [upstream(503), thrown('fetch failed', TypeError), upstream(429), thrown('read ECONNRESET'), adapters[name].done]);
    const result = await run(name);
    expect(result).toMatchObject({ taskId: 'accepted-task', videoUrl: VIDEO_URL });
    expect(Buffer.compare(result.buffer, mp4Fixture())).toBe(0);
    expect(counts).toEqual({ creates: 1, polls: 5 });
  });

  it.each(names)('%s: a successful read restarts the failure budget', async name => {
    const four = [upstream(503), upstream(502), upstream(500), upstream(504)];
    const counts = stub(name, [...four, adapters[name].processing, ...four, adapters[name].done]);
    expect(await run(name)).toMatchObject({ taskId: 'accepted-task' });
    expect(counts).toEqual({ creates: 1, polls: 10 });
  });

  it.each(names)('%s: stops at the fifth consecutive failure on the same task', async name => {
    const counts = stub(name, [upstream(503)]);
    await expect(run(name)).rejects.toThrow();
    expect(counts).toEqual({ creates: 1, polls: 5 });
  });

  it.each(names.flatMap(name => [401, 403, 404, 400].map(status => [name, status] as const)))(
    '%s: HTTP %i ends tracking on the first read', async (name, status) => {
      const counts = stub(name, [upstream(status)]);
      await expect(run(name)).rejects.toThrow();
      expect(counts).toEqual({ creates: 1, polls: 1 });
    });

  it.each(names.flatMap(name => [401, 404].map(status => [name, status] as const)))(
    '%s: HTTP %i stays a rejection when its body reads like a transient failure', async (name, status) => {
      const counts = stub(name, [upstream(status, '系统繁忙，请稍后重试 503 timed out ECONNRESET')]);
      await expect(run(name)).rejects.toThrow();
      expect(counts).toEqual({ creates: 1, polls: 1 });
    });

  it('kling: a native business rejection stays terminal', async () => {
    const counts = stub('kling', [() => json({ code: 1102, message: 'SYNTHETIC_UPSTREAM_BODY' })]);
    await expect(run('kling')).rejects.toMatchObject({ taskId: 'accepted-task' });
    expect(counts).toEqual({ creates: 1, polls: 1 });
  });

  it.each(names)('%s: cancelling during a failing read stops without another request', async name => {
    const controller = new AbortController();
    const counts = stub(name, [() => { controller.abort(); throw new TypeError('fetch failed'); }]);
    await expect(run(name, { signal: controller.signal })).rejects.toThrow();
    expect(counts).toEqual({ creates: 1, polls: 1 });
  });

  it.each(['doubao'] as const)('%s: the stop reason names what actually failed', async name => {
    stub(name, [upstream(503)]);
    const persistent: Error = await run(name).catch((err: Error) => err);
    expect(persistent.message).toMatch(/persistently interrupted/i);
    expect(persistent.message).toContain('accepted-task');
    expect(persistent.message).not.toContain('timed out');

    stub(name, [upstream(503), upstream(503), upstream(503), upstream(503), thrown('query timed out after 20s')]);
    const mixed: Error = await run(name).catch((err: Error) => err);
    expect(mixed.message).not.toMatch(/connection timed out/i);

    stub(name, [thrown('query timed out after 20s')]);
    const timedOut: Error = await run(name).catch((err: Error) => err);
    expect(timedOut.message).toMatch(/the connection timed out 5 times in a row/);
  });

  it.each(names)('%s: retry progress is truthful and carries no upstream body', async name => {
    const events: Array<{ phase: string; message: string; data?: unknown }> = [];
    stub(name, [upstream(503), thrown('query timed out after 20s'), adapters[name].done]);
    await run(name, { onProgress: (event: any) => events.push(event) });
    const retries = events.filter(event => /retry/i.test(event.message));
    expect(retries).toHaveLength(2);
    expect(retries[0].message).not.toMatch(/timed out/i);
    expect(retries[1].phase).toBe('poll_timeout');
    expect(retries[1].message).toMatch(/timed out/i);
    expect(JSON.stringify(events)).not.toContain('SYNTHETIC_UPSTREAM_BODY');
  });

});

describe('video_gen › classifyVideoGenError (transient vs bad-input)', () => {
  it('classifies a transient backend "系统繁忙" / 5xx / rate-limit / dropped connection as a retryable provider error', async () => {
    const { classifyVideoGenError } = await import('../../../src/main/features/video_gen');
    for (const msg of [
      '系统繁忙，请稍后重试',          // the reported generate_video failure (log)
      '系统繁忙，请稍后再试',          // the live-probe variant
      'DouBao video create API 503: upstream down',
      'account:/account/me http 503',
      'HTTP 502 Bad Gateway',
      'Too Many Requests',
      'service unavailable',
      'temporarily unavailable',
      'fetch failed',
      'ECONNRESET',
      'EAI_AGAIN getaddrinfo',
      // Chromium's own messages on the system-proxy route.
      'net::ERR_CONNECTION_RESET',
      'net::ERR_CONNECTION_CLOSED',
      'net::ERR_PROXY_CONNECTION_FAILED',
      'net::ERR_TUNNEL_CONNECTION_FAILED',
      'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_INTERNET_DISCONNECTED',
      'net::ERR_NETWORK_CHANGED',
    ]) {
      expect(classifyVideoGenError(msg), msg).toBe('PROVIDER_API_ERROR');
    }
  });

  it('classifies a timeout as TIMEOUT', async () => {
    const { classifyVideoGenError } = await import('../../../src/main/features/video_gen');
    for (const msg of ['Orkas · Video request timed out', 'request timeout after 60s', 'socket timed out',
      'net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_TIMED_OUT']) {
      expect(classifyVideoGenError(msg), msg).toBe('TIMEOUT');
    }
  });

  it('keeps genuine bad input as BAD_INPUT (look-alikes that must NOT read as a transient server error)', async () => {
    const { classifyVideoGenError } = await import('../../../src/main/features/video_gen');
    for (const msg of [
      'ENOENT: no such file or directory, open /tmp/ref.png',
      'unsupported image format',
      'prompt is required',
      'outputAbsPath is required',
      'reference image not found',
      'operation aborted',
      '',
      // Look-alikes of Chromium's net errors: names, and Node's programming errors.
      'unsupported reference image type: net_err_connection.png',
      'internet::ERR_CONNECTION_RESET',
      'reference net::err.png is empty',
      'ERR_INVALID_ARG_TYPE: path must be a string',
    ]) {
      expect(classifyVideoGenError(msg), msg).toBe('BAD_INPUT');
    }
  });
});


describe('public reference upload transport boundary', () => {
  it('keeps a Chromium reference upload failure retryable and undispatched', async () => {
    mocks.profiles = [{ id: 'direct', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture', label: 'Direct', createdAt: 1 }];
    const references = await import('../../../src/main/features/generation_reference_assets');
    vi.mocked(references.prepareReferenceUrls).mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await generateVideo({ prompt: 'extend', outputAbsPath: path.join(tmpDir, 'reference.mp4'), referenceVideoPaths: [path.join(tmpDir, 'input.mp4')] });
    expect(result).toMatchObject({ ok: false, errorCode: 'PROVIDER_API_ERROR', dispatched: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, 'reference.mp4'))).toBe(false);
  });
});

describe('public Orkas API poll timeout budget', () => {
  it('preserves the existing five-timeout bound without creating another task', async () => {
    vi.useFakeTimers();
    let creations = 0, reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      if (init?.method === 'POST') { creations++; return new Response(JSON.stringify({ id: 'public-accepted', status: 'processing' })); }
      reads++; throw new Error('fixture status timed out');
    }));
    try {
      const pending = generateVideo({ prompt: 'fixture', outputAbsPath: path.join(tmpDir, 'timed-out.mp4'), pollIntervalMs: 1, timeoutMs: 600000 });
      await vi.advanceTimersByTimeAsync(6000);
      expect(await pending).toMatchObject({ ok: false, errorCode: 'TIMEOUT', message: expect.stringContaining('fixture status timed out') });
      expect({ creations, reads }).toEqual({ creations: 1, reads: 5 });
      expect(mocks.downloadBinaryWithProxyPolicy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tmpDir, 'timed-out.mp4'))).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe('video_gen public provider rejection reason', () => {
  const output = path.join(os.tmpdir(), 'uncreated-video-rejection.mp4');
  it('reports a user-key Doubao input rejection by its code and never its prose', async () => {
    mocks.profiles = [{ id: 'primary', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', label: 'Fixture', createdAt: 1 }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'InputImageSensitiveContentDetected.PrivacyInformation', message: 'private-generation-prompt' },
    }), { status: 400 })));
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    const result = await generateVideo({ prompt: 'A quiet landscape', outputAbsPath: output });
    expect(result).toMatchObject({ ok: false, errorCode: 'BAD_INPUT' });
    expect(JSON.stringify(result)).toContain('InputImageSensitiveContentDetected.PrivacyInformation');
    expect(JSON.stringify(result)).not.toContain('private-generation-prompt');
  });

  it.each([
    [{ error: { code: 'AuthenticationError', message: 'private-generation-prompt' } }, 401, 'AuthenticationError'],
    [{ error: { code: 'private-generation-prompt and more words' } }, 400, null],
    [{ error: { code: 1613 } }, 400, null],
    ['private-generation-prompt', 400, null],
  ])('does not treat a user-key response as an input rejection: %j', async (body, status, code) => {
    mocks.profiles = [{ id: 'primary', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', label: 'Fixture', createdAt: 1 }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })));
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    const result = await generateVideo({ prompt: 'A quiet landscape', outputAbsPath: output });
    expect(result).toMatchObject({ ok: false, errorCode: 'PROVIDER_API_ERROR' });
    expect(JSON.stringify(result)).not.toContain('private-generation-prompt');
    if (code) expect(JSON.stringify(result)).toContain(code);
  });

  it('reports why a user-key Doubao task failed by its code', async () => {
    mocks.profiles = [{ id: 'primary', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', label: 'Fixture', createdAt: 1 }];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST'
      ? new Response(JSON.stringify({ id: 'byok-task' }))
      : new Response(JSON.stringify({ status: 'failed', error: { code: 'OutputVideoSensitiveContentDetected', message: 'private-generation-prompt' } })))));
    const { generateVideo } = await import('../../../src/main/features/video_gen');
    const result = await generateVideo({ prompt: 'A quiet landscape', outputAbsPath: output, pollIntervalMs: 1 });
    expect(result).toMatchObject({ ok: false, errorCode: 'PROVIDER_API_ERROR', postDispatch: true, taskId: 'byok-task' });
    expect(JSON.stringify(result)).toContain('OutputVideoSensitiveContentDetected');
    expect(JSON.stringify(result)).not.toContain('private-generation-prompt');
  });
});

// A terminal task and a rejected create have different replay and billing facts.
describe('public video rejection recovery boundaries', () => {
  const primary = { id: 'primary', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'fixture-key', label: 'Fixture', createdAt: 1 };
  it.each([
    ['InputImageSensitiveContentDetected.PrivacyInformation', 'BAD_INPUT'],
    ['UpstreamFailure', 'PROVIDER_API_ERROR'],
    ['InvalidParameter and private prose', 'PROVIDER_API_ERROR'],
    [null, 'PROVIDER_API_ERROR'],
  ])('preserves terminal failure and no replay for code %s', async (code, errorCode) => {
    mocks.profiles = [primary, { ...primary, id: 'fallback' }];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST'
      ? { id: 'terminal-task' }
      : { status: 'failed', error: { code, message: 'private-provider-prose' } })));
    vi.stubGlobal('fetch', fetch);
    const result = await generateVideo({ prompt: 'A quiet landscape', outputAbsPath: path.join(tmpDir, 'failed.mp4'), pollIntervalMs: 1 });
    expect(result).toMatchObject({ ok: false, errorCode, postDispatch: true, taskId: 'terminal-task' });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(mocks.downloadBinaryWithProxyPolicy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, 'failed.mp4'))).toBe(false);
    expect(JSON.stringify([result, mocks.warn.mock.calls])).not.toContain('private-provider-prose');
    expect(JSON.stringify(result)).not.toMatch(/nothing was charged|no credits were charged/i);
    expect((result as {message: string}).message).toContain('video task');
  });
  it('uses the configured fallback only after an explicitly rejected creation', async () => {
    mocks.profiles = [primary, { ...primary, id: 'fallback' }];
    let creations = 0;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') return ++creations === 1
        ? new Response(JSON.stringify({error: {code: 'InvalidParameter', message: 'private-provider-prose'}}), {status: 400})
        : new Response(JSON.stringify({id: 'fallback-task'}));
      return new Response(JSON.stringify({status: 'succeeded', content: {video_url: 'https://cdn.example.test/video.mp4'}}));
    });
    vi.stubGlobal('fetch', fetch);
    const output = path.join(tmpDir, 'fallback.mp4');
    expect(await generateVideo({prompt: 'A quiet landscape', outputAbsPath: output, pollIntervalMs: 1}))
      .toMatchObject({ok: true, taskId: 'fallback-task'});
    expect(creations).toBe(2);
    expect(fs.readFileSync(output)).toEqual(mp4Fixture());
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private-provider-prose');
  });
  it.each(['InvalidParameterLookalike', 'Prefix.InvalidImageURL', 'InputImageSensitiveContentDetected.PrivacyInformation.extra'])('keeps an unrecognized structured code a provider error: %s', async code => {
    mocks.profiles = [primary];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({error: {code}}), {status: 400})));
    expect(await generateVideo({prompt: 'A quiet landscape', outputAbsPath: path.join(tmpDir, 'unknown.mp4')}))
      .toMatchObject({ok: false, errorCode: 'PROVIDER_API_ERROR'});
  });
});
