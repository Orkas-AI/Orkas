import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  provider: 'custom',
  owner: '',
  baseUrl: 'https://speech.example.invalid',
  profileFailure: null as Error | null,
  probe: vi.fn<() => Promise<number | null>>(),
  warn: vi.fn(),
}));
vi.mock('../../../src/main/features/users', async original => ({
  ...await original<typeof import('../../../src/main/features/users')>(),
  hasActiveUser: () => !!state.owner,
  getActiveUserId: () => state.owner,
}));
vi.mock('../../../src/main/features/tts_auth', async original => ({
  ...await original<typeof import('../../../src/main/features/tts_auth')>(),
  listUsableTtsProfiles: () => {
    if (state.profileFailure) throw state.profileFailure;
    return [{
    id: 'response-test', provider: state.provider, baseUrl: state.baseUrl,
    apiKey: 'fixture-key', model: 'fixture-model', voice: 'fixture-voice', format: 'mp3',
    }];
  },
}));
vi.mock('../../../src/main/features/tts_capabilities', () => ({
  resolveTtsSelection: async () => ({ ok: true, selection: {
    routeRef: 'response-test', voiceRef: 'response-voice', providerVoiceId: 'fixture-voice', language: 'en',
  } }),
}));
vi.mock('../../../src/main/util/media_probe', () => ({ probeMediaDurationSec: state.probe }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ warn: state.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

import { generateSpeech } from '../../../src/main/features/tts';

function speechClock() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
}

let root: string;
let priorBase: string | undefined;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tts-response-'));
  priorBase = process.env.ORKAS_TTS_BASE_URL;
  delete process.env.ORKAS_TTS_BASE_URL;
  state.baseUrl = 'https://speech.example.invalid';
  state.profileFailure = null;
  state.owner = '';
  state.probe.mockResolvedValue(null);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (priorBase === undefined) delete process.env.ORKAS_TTS_BASE_URL;
  else process.env.ORKAS_TTS_BASE_URL = priorBase;
  rmSync(root, { recursive: true, force: true });
});

// These are transport tests: only route discovery and duration probing are
// controlled. Real Response/ReadableStream and the public synthesis entry own
// receipt, cancellation, output bytes, and post-dispatch billing uncertainty.
describe.each(['custom', 'elevenlabs', 'doubao', 'orkas-api'])('%s response lifecycle', provider => {
  beforeEach(() => { state.provider = provider; });
  const output = () => path.join(root, 'speech.mp3');
  const request = (signal?: AbortSignal) => generateSpeech({ text: 'Keep this narration intact.', outputAbsPath: output(), signal });
  const bodyBytes = (audio: Buffer) => provider === 'doubao'
    ? Buffer.from(JSON.stringify({ code: 0, data: audio.toString('base64') }) + '\n{"code":20000000}')
    : audio;


  if (provider === 'orkas-api') {
    it('retains the public API-key speech endpoint and opaque usage headers without an account session', async () => {
      state.baseUrl = 'https://orkas.ai/v1';
      const fetch = vi.fn(async () => new Response(Buffer.from('audio'), { headers: { 'Content-Type': 'audio/mpeg' } }));
      vi.stubGlobal('fetch', fetch);
      expect(await generateSpeech({ text: 'Public speech request.', outputAbsPath: output(),
        usageContext: { conversationId: 'local-conversation', turnId: 'turn-1' } })).toMatchObject({ ok: true });
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0] as any;
      expect(url).toBe('https://orkas.ai/v1/audio/speech');
      expect(init.headers).toEqual({ Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json',
        'X-Orkas-Conversation-Id': 'local-conversation', 'X-Orkas-Turn-Id': 'turn-1' });
      expect(JSON.parse(init.body)).toEqual({ model: 'fixture-model', input: 'Public speech request.', voice: 'fixture-voice', response_format: 'mp3' });
    });
  }

  it('keeps private transport diagnostics out of logs and the user result', async () => {
    const detail = 'https://fixture-user:fixture-password@private.example/?api_key=fixture-secret prompt=fixture-private-text';
    const fetch = vi.fn(async () => { throw new Error(detail); });
    vi.stubGlobal('fetch', fetch);
    const result = await request();
    expect(result).toMatchObject({ ok: false, errorCode: 'E_TTS_NETWORK', requestDisposition: 'sent', chargeStatus: 'unknown' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(state.warn).toHaveBeenCalledOnce();
    const observed = JSON.stringify([result, state.warn.mock.calls]);
    for (const privateValue of ['fixture-password', 'fixture-secret', 'fixture-private-text', 'private.example']) {
      expect(observed).not.toContain(privateValue);
    }
    expect(existsSync(output())).toBe(false);
  });

  if (provider === 'custom') {
    it('does not log the key in a real fetch invalid-URL failure', async () => {
      state.baseUrl = 'https://fixture.invalid host/?api_key=fixture-url-secret';
      const result = await request();
      expect(result).toMatchObject({ ok: false, errorCode: 'E_TTS_NETWORK' });
      expect(state.warn).toHaveBeenCalledOnce();
      expect(JSON.stringify([result, state.warn.mock.calls])).not.toContain('fixture-url-secret');
    });

    it('keeps a private Unicode filename out of persistence diagnostics', async () => {
      const blockedParent = path.join(root, '私密文件名');
      writeFileSync(blockedParent, 'not a directory');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('audio'))));
      const result = await generateSpeech({ text: 'Keep private filenames private.', outputAbsPath: path.join(blockedParent, 'speech.mp3') });
      expect(result).toMatchObject({ ok: false, errorCode: 'E_TTS_WRITE', requestDisposition: 'sent' });
      expect(state.warn).toHaveBeenCalledOnce();
      expect(JSON.stringify([result, state.warn.mock.calls])).not.toContain('私密文件名');
    });

    it('keeps a successful file when duration probing fails without logging private diagnostics', async () => {
      state.probe.mockRejectedValue(new Error('probe failed token=fixture-probe-secret'));
      vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('audio'))));
      expect(await request()).toMatchObject({ ok: true });
      expect(readFileSync(output()).toString()).toBe('audio');
      expect(state.warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(state.warn.mock.calls)).not.toContain('fixture-probe-secret');
    });

    it('reports unavailable profile storage without logging its private failure text', async () => {
      state.profileFailure = new Error('read /Users/test/profile.json token=fixture-profile-secret');
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      expect(await request()).toMatchObject({ ok: false, errorCode: 'E_TTS_NOT_CONFIGURED' });
      expect(fetch).not.toHaveBeenCalled();
      expect(state.warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(state.warn.mock.calls)).not.toContain('fixture-profile-secret');
    });
  }

  it('preserves fragmented audio bytes with one provider request', async () => {
    const audio = Buffer.from('ID3 fixture audio');
    const bytes = bodyBytes(audio);
    let offset = 0;
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(offset, ++offset));
      },
    })));
    vi.stubGlobal('fetch', fetch);
    expect(await request()).toMatchObject({ ok: true, bytes: audio.length });
    expect(readFileSync(output())).toEqual(audio);
    expect(fetch).toHaveBeenCalledOnce();
  });

  if (provider === 'doubao') {
    it('rejects a real HTTP 200 response closed before synthesis completion without overwriting or replaying', async () => {
      writeFileSync(output(), 'prior complete narration');
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ code: 0, data: Buffer.from('partial').toString('base64') }));
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        await expect(request()).resolves.toMatchObject({
          ok: false, errorCode: 'E_TTS_API_ERROR', requestDisposition: 'sent',
          chargeStatus: 'unknown', retryPolicy: 'unknown',
        });
        expect(requests).toBe(1);
        expect(readFileSync(output(), 'utf8')).toBe('prior complete narration');
        expect(state.probe).not.toHaveBeenCalled();
      } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  }

  it.each([200])('returns sent/unknown after a body disconnect (HTTP %s) without overwriting or replaying', async status => {
    writeFileSync(output(), 'prior narration');
    const privateError = 'connection failed https://private.example/voice?token=fixture-secret';
    let pulls = 0;
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(Buffer.from('partial'));
        else controller.error(new Error(privateError));
      },
    }, { highWaterMark: 0 }), { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(request()).resolves.toMatchObject({
      ok: false, errorCode: 'E_TTS_NETWORK', requestDisposition: 'sent', chargeStatus: 'unknown', retryPolicy: 'unknown',
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(readFileSync(output(), 'utf8')).toBe('prior narration');
    expect(state.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain('fixture-secret');
  });

  it.each([200])('cancels an undeclared oversized stream (HTTP %s) before reading the remaining body', async status => {
    // Preserve the existing 50 MiB audio / 100 MiB NDJSON wire limits. The
    // shared chunk bounds fixture memory; a read beyond the cap is a failure.
    const maxChunks = status === 503 ? 64 : provider === 'doubao' ? 100 : 50;
    const chunk = Buffer.alloc(status === 503 ? 1024 : 1024 * 1024, 32);
    let pulls = 0;
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulls > maxChunks + 1) controller.error(new Error('overflow body was read beyond its limit'));
        else controller.enqueue(chunk);
      },
      cancel,
    }, { highWaterMark: 0 }), { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(request()).resolves.toMatchObject({
      ok: false, errorCode: 'E_TTS_TOO_LARGE', requestDisposition: 'sent', chargeStatus: 'unknown',
    });
    expect(pulls).toBe(maxChunks + 1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(existsSync(output())).toBe(false);
  });

  it.each(['cancel', 'deadline'] as const)('settles a pending body on %s without saving partial audio', async mode => {
    vi.useFakeTimers();
    // AbortSignal.timeout uses a native timer. Route that clock through the
    // controlled test timer, preserving the timeout requested by production.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const timeout = new AbortController();
      setTimeout(() => timeout.abort(new DOMException('Timed out', 'TimeoutError')), ms);
      return timeout.signal;
    });
    const parent = new AbortController();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    let bodyPending!: () => void;
    const pending = new Promise<void>(resolve => { bodyPending = resolve; });
    const cancel = vi.fn();
    let pulls = 0;
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller; },
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(bodyBytes(Buffer.from('partial')));
        else bodyPending();
      },
      cancel,
    }, { highWaterMark: 0 })));
    vi.stubGlobal('fetch', fetch);
    const result = request(parent.signal);
    await pending;
    if (mode === 'cancel') parent.abort();
    else await vi.advanceTimersByTimeAsync(120_000);
    // Make the old implementation terminate too: it must reject this late
    // completion, rather than write a falsely successful partial narration.
    if (!cancel.mock.calls.length) bodyController.close();
    await expect(result).resolves.toMatchObject({
      ok: false, errorCode: mode === 'cancel' ? 'E_TTS_ABORTED' : 'E_TTS_NETWORK',
      requestDisposition: 'sent', chargeStatus: 'unknown', retryPolicy: 'unknown',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(existsSync(output())).toBe(false);
  });

  it('cancels real HTTP body receipt after headers without reporting partial audio as success', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { 'Content-Type': provider === 'doubao' ? 'application/json' : 'audio/mpeg' });
      response.write(bodyBytes(Buffer.from('partial')));
      // Keep the body open until client cancellation. The fallback below also
      // makes a broken implementation finish with an observable wrong result.
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const realFetch = globalThis.fetch;
    let headersReceived!: () => void;
    const headers = new Promise<void>(resolve => { headersReceived = resolve; });
    const fetch = vi.fn(async (...args: Parameters<typeof realFetch>) => {
      const response = await realFetch(...args);
      headersReceived();
      return response;
    });
    vi.stubGlobal('fetch', fetch);
    const parent = new AbortController();
    try {
      const result = request(parent.signal);
      await headers;
      await new Promise<void>(resolve => setImmediate(resolve));
      parent.abort();
      const fallback = setTimeout(() => server.closeAllConnections(), 1000);
      try {
        await expect(result).resolves.toMatchObject({
          ok: false, errorCode: 'E_TTS_ABORTED', requestDisposition: 'sent', chargeStatus: 'unknown',
        });
      } finally { clearTimeout(fallback); }
      expect(requests).toBe(1);
      expect(fetch).toHaveBeenCalledOnce();
      expect(existsSync(output())).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('speech capacity and limit recovery', () => {
  beforeEach(() => { state.provider = 'custom'; });
  const synthesize = (name: string, signal?: AbortSignal) => generateSpeech({
    text: name, outputAbsPath: path.join(root, `${name}.mp3`), signal,
  });

  it('runs six narrations at peak two and preserves each completed file', async () => {
    let active = 0, peak = 0;
    const releases: Array<() => void> = [];
    const fetch = vi.fn(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => { releases.push(resolve); });
      active--;
      return new Response(Buffer.from('complete audio'), { headers: { 'Content-Type': 'audio/mpeg' } });
    });
    vi.stubGlobal('fetch', fetch);
    const pending = Array.from({ length: 6 }, (_, n) => synthesize(`line-${n}`));
    for (let wave = 0; wave < 3; wave++) {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes((wave + 1) * 2));
      expect(active).toBe(2);
      releases.splice(0).forEach(release => release());
    }
    expect((await Promise.all(pending)).every(result => result.ok)).toBe(true);
    expect(peak).toBe(2);
    for (let n = 0; n < 6; n++) expect(readFileSync(path.join(root, `line-${n}.mp3`)).toString()).toBe('complete audio');
  });

  it('cancels a queued line without dispatch and retains active capacity until transport settles', async () => {
    const releases: Array<() => void> = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise<void>(resolve => { releases.push(resolve); });
      return new Response('complete', { headers: { 'Content-Type': 'audio/mpeg' } });
    }));
    const running = [synthesize('a'), synthesize('b')];
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const stop = new AbortController();
    const queued = synthesize('cancelled', stop.signal);
    stop.abort();
    expect(await queued).toMatchObject({ ok: false, requestDisposition: 'not_sent', chargeStatus: 'not_charged' });
    const queueLogs = state.warn.mock.calls.filter(([event]) => event === 'media_admission_wait').map(([, data]) => data);
    expect(releases).toHaveLength(2);
    releases.splice(0).forEach(release => release());
    expect((await Promise.all(running)).every(result => result.ok)).toBe(true);
    expect(queueLogs).toEqual([
      expect.objectContaining({ event: 'wait', operation: 'tts', concurrency: 2 }),
      expect.objectContaining({ event: 'result', outcome: 'cancelled', concurrency: 2 }),
    ]);
    expect(queueLogs[0].request_ref).toBe(queueLogs[1].request_ref);
    expect(existsSync(path.join(root, 'cancelled.mp3'))).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('next', { headers: { 'Content-Type': 'audio/mpeg' } })));
    expect(await synthesize('next')).toMatchObject({ ok: true });
  });
});

it.each(['custom', 'doubao', 'orkas-api'])('%s recovers a rejected HTTP limit and publishes just the successful audio', async provider => {
  state.provider = provider;
  speechClock();
  const bytes = Buffer.from('complete recovered audio');
  const fetch = vi.fn().mockResolvedValueOnce(new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429, headers: { 'Retry-After': '2' } }))
    .mockResolvedValueOnce(new Response(provider === 'doubao' ? JSON.stringify({ code: 0, data: bytes.toString('base64') }) + '\n{"code":20000000}' : bytes,
      { headers: { 'Content-Type': provider === 'doubao' ? 'application/json' : 'audio/mpeg' } }));
  vi.stubGlobal('fetch', fetch);
  const outputAbsPath = path.join(root, 'recovered.mp3');
  const pending = generateSpeech({ text: 'Recover exactly once', outputAbsPath });
  await vi.advanceTimersByTimeAsync(9999);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ ok: true, path: outputAbsPath });
  expect(readFileSync(outputAbsPath)).toEqual(bytes);
  expect(fetch).toHaveBeenCalledTimes(2);
  const logs = state.warn.mock.calls.filter(([event]) => event === 'media_rate_limit').map(([, data]) => data);
  expect(logs).toEqual([
    expect.objectContaining({ event: 'wait', operation: 'tts', code: 'rate_limit_exceeded', status: 429, planned_wait_ms: 10000 }),
    expect.objectContaining({ event: 'result', operation: 'tts', outcome: 'recovered', retry_count: 1, wait_ms: 10000 }),
  ]);
  expect(logs[0].request_ref).toBe(logs[1].request_ref);
  expect(JSON.stringify(logs)).not.toMatch(/Recover exactly once|fixture-key|recovered\.mp3|speech\.example/);
});

it('retries the exact V3 concurrency subtype, while other 45000000 quota errors remain terminal', async () => {
  state.provider = 'doubao'; vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(new Response('{"code":45000000,"message":"quota exceeded for types: concurrency"}', { headers: { 'Retry-After': '45' } }))
    .mockResolvedValueOnce(new Response('{"code":0,"data":"QVVESU8="}\n{"code":20000000}'));
  vi.stubGlobal('fetch', fetch);
  const outputAbsPath = path.join(root, 'v3.mp3');
  const pending = generateSpeech({ text: 'Recover V3', outputAbsPath });
  await vi.advanceTimersByTimeAsync(44999);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ ok: true }); expect(fetch).toHaveBeenCalledTimes(2);
  expect(state.warn.mock.calls.filter(([event]) => event === 'media_rate_limit').map(([, data]) => data))
    .toEqual([expect.objectContaining({ event: 'wait', status: 200, code: '45000000_concurrency' }),
      expect.objectContaining({ event: 'result', outcome: 'recovered', wait_ms: 45000 })]);
  fetch.mockReset().mockResolvedValue(new Response('{"code":45000000,"message":"quota exceeded for types: voice"}'));
  expect(await generateSpeech({ text: 'No replay', outputAbsPath })).toMatchObject({ ok: false, chargeStatus: 'unknown' });
  expect(fetch).toHaveBeenCalledOnce(); expect(readFileSync(outputAbsPath).toString()).toBe('AUDIO');
  for (const field of ['id', 'task_id', 'audio', 'output']) {
    fetch.mockReset().mockResolvedValue(new Response(JSON.stringify({
      code: 45000000, message: 'quota exceeded for types: concurrency', [field]: 'accepted',
    })));
    expect(await generateSpeech({ text: 'Do not duplicate accepted work', outputAbsPath }))
      .toMatchObject({ ok: false, chargeStatus: 'unknown' });
    expect(fetch).toHaveBeenCalledOnce();
  }
});

it.each(['deadline', 'cancelled'] as const)('keeps limited speech pending until %s without extra dispatch', async mode => {
  state.provider = 'custom'; speechClock();
  const fetch = vi.fn(async () => new Response('{"error":{"code":"concurrency_limit_exceeded"}}', { status: 429 }));
  vi.stubGlobal('fetch', fetch);
  const stop = new AbortController();
  const pending = generateSpeech({ text: 'private-narration', outputAbsPath: path.join(root, 'private-output.mp3'), signal: stop.signal });
  let settled = false;
  void pending.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(mode === 'cancelled' ? 500 : 119999);
  expect(settled).toBe(false);
  if (mode === 'cancelled') stop.abort();
  else await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ ok: false, chargeStatus: 'not_charged' });
  const records = state.warn.mock.calls.filter(([event]) => event === 'media_rate_limit').map(([, data]) => data);
  expect(fetch).toHaveBeenCalledTimes(mode === 'cancelled' ? 1 : 12);
  expect(records).toHaveLength(mode === 'cancelled' ? 2 : 4);
  expect(records.at(-1)).toMatchObject({ event: 'result', outcome: mode === 'cancelled' ? 'cancelled' : 'budget_exhausted',
    retry_bound: 'deadline', retry_count: mode === 'cancelled' ? 0 : 11, wait_ms: mode === 'cancelled' ? 500 : 120000 });
  expect(JSON.stringify(records)).not.toMatch(/private-|fixture-key/);
});


it('recovers after the third retry when earlier provider work still occupies capacity', async () => {
  state.provider = 'custom'; speechClock();
  const fetch = vi.fn(async () => Date.now() < 45000
    ? new Response('{"error":{"code":"concurrency_limit_exceeded"}}', { status: 429 })
    : new Response('complete after capacity was freed', { headers: { 'Content-Type': 'audio/mpeg' } }));
  vi.stubGlobal('fetch', fetch);
  const outputAbsPath = path.join(root, 'capacity-freed.mp3');
  const pending = generateSpeech({ text: 'Finish after the previous narration', outputAbsPath });
  await vi.advanceTimersByTimeAsync(9999);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(40000);
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(existsSync(outputAbsPath)).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ ok: true });
  expect(fetch).toHaveBeenCalledTimes(6);
  expect(readFileSync(outputAbsPath).toString()).toBe('complete after capacity was freed');
});

it('respects a longer provider wait and does not restart the narration budget after rejection', async () => {
  state.provider = 'custom'; vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const fetch = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '45' } }));
  vi.stubGlobal('fetch', fetch);
  const pending = generateSpeech({ text: 'Wait for existing work', outputAbsPath: path.join(root, 'wait.mp3') });
  await vi.advanceTimersByTimeAsync(44999);
  expect(fetch).toHaveBeenCalledOnce();
  clock = 45000;
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  // A suspended process must not dispatch when the shared operation budget expired.
  clock = 121000;
  await vi.advanceTimersByTimeAsync(45000);
  expect(await pending).toMatchObject({ ok: false, chargeStatus: 'not_charged' });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(state.warn.mock.calls.filter(([event]) => event === 'media_rate_limit').at(-1)?.[1])
    .toMatchObject({ outcome: 'budget_exhausted' });
});

it.each(['deadline', 'cancelled'] as const)('holds an unbounded Retry-After until %s without retrying early', async mode => {
  state.provider = 'custom'; speechClock();
  const fetch = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '86400' } }));
  vi.stubGlobal('fetch', fetch);
  const stop = new AbortController();
  let settled = false;
  const pending = generateSpeech({ text: 'Bound the recovery', outputAbsPath: path.join(root, 'bound.mp3'), signal: stop.signal });
  void pending.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(119999);
  expect(settled).toBe(false);
  if (mode === 'cancelled') stop.abort();
  else await vi.advanceTimersByTimeAsync(1);
  expect(await pending)
    .toMatchObject({ ok: false, chargeStatus: 'not_charged' });
  expect(fetch).toHaveBeenCalledOnce();
  expect(state.warn.mock.calls.filter(([event]) => event === 'media_rate_limit').at(-1)?.[1])
    .toMatchObject({ outcome: mode === 'cancelled' ? 'cancelled' : 'budget_exhausted', retry_count: 0 });
});

it('does not dispatch queued narration under a different local user', async () => {
  state.provider = 'custom'; state.owner = 'first-local-user';
  const releases: Array<() => void> = [];
  const fetch = vi.fn(async () => {
    await new Promise<void>(resolve => { releases.push(resolve); });
    return new Response('complete', { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  vi.stubGlobal('fetch', fetch);
  const make = (name: string) => generateSpeech({ text: name, outputAbsPath: path.join(root, `${name}.mp3`) });
  const active = [make('first'), make('second')];
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const queued = make('old-user-queued');
  state.owner = 'second-local-user';
  releases.splice(0).forEach(release => release());
  await Promise.all(active);
  expect(await queued).toMatchObject({ ok: false, requestDisposition: 'not_sent', chargeStatus: 'not_charged' });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(existsSync(path.join(root, 'old-user-queued.mp3'))).toBe(false);
});

it('rejects queued narration after switching away and back, while allowing a fresh request', async () => {
  state.provider = 'custom'; state.owner = 'first-account';
  const { notifyUserSwitch } = await import('../../../src/main/features/user-switch-hooks');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  const fetch = vi.fn(async () => {
    if (++sends <= 2) await gate;
    return new Response('complete', { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  vi.stubGlobal('fetch', fetch);
  const make = (name: string) => generateSpeech({ text: name, outputAbsPath: path.join(root, `${name}.mp3`) });
  const active = [make('first'), make('second')];
  let queued: ReturnType<typeof generateSpeech> | undefined;
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    queued = make('stale-after-return');
    notifyUserSwitch('first-account', 'second-account'); state.owner = 'second-account';
    notifyUserSwitch('second-account', 'first-account'); state.owner = 'first-account';
    release(); await Promise.all(active);
    expect.soft(await queued).toMatchObject({ ok: false, requestDisposition: 'not_sent', chargeStatus: 'not_charged' });
    expect.soft(fetch).toHaveBeenCalledTimes(2);
    expect.soft(existsSync(path.join(root, 'stale-after-return.mp3'))).toBe(false);
    expect(await make('fresh-after-return')).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(readFileSync(path.join(root, 'fresh-after-return.mp3'), 'utf8')).toBe('complete');
  } finally { release(); await Promise.allSettled([...active, ...(queued ? [queued] : [])]); }
});

it('compares six serial versus concurrent complete narrations with bounded payloads', async () => {
  state.provider = 'custom';
  const records: Array<Record<string, number | string>> = [];
  let active = 0, peak = 0, peakRss = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    active++; peak = Math.max(peak, active); peakRss = Math.max(peakRss, process.memoryUsage().rss);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
    return new Response(Buffer.alloc(64 * 1024, 7), { headers: { 'Content-Type': 'audio/mpeg' } });
  }));
  for (let sample = 0; sample < 5; sample++) for (const mode of ['serial', 'concurrent']) {
    peak = 0; peakRss = 0;
    const cpu = process.cpuUsage(), started = performance.now();
    const make = (n: number) => generateSpeech({ text: 'One independent line', outputAbsPath: path.join(root, `${sample}-${mode}-${n}.mp3`) });
    const results = mode === 'concurrent' ? await Promise.all(Array.from({ length: 6 }, (_, n) => make(n)))
      : await (async () => { const results = []; for (let n = 0; n < 6; n++) results.push(await make(n)); return results; })();
    const used = process.cpuUsage(cpu);
    records.push({ mode, sample, elapsedMs: performance.now() - started, peak, cpuMs: (used.user + used.system) / 1000, peakRss });
    expect(results.every(result => result.ok)).toBe(true);
    expect(peak).toBe(mode === 'serial' ? 1 : 2);
    for (let n = 0; n < 6; n++) expect(readFileSync(path.join(root, `${sample}-${mode}-${n}.mp3`)).equals(Buffer.alloc(64 * 1024, 7))).toBe(true);
  }
  // Optional local benchmark artifact; timings/RSS have no test threshold or paid-provider claim.
  if (process.env.ORKAS_MEDIA_BENCHMARK_OUTPUT) writeFileSync(process.env.ORKAS_MEDIA_BENCHMARK_OUTPUT, JSON.stringify(records));
});

it('keeps a cancelled active request in its slot until the underlying transport settles', async () => {
  state.provider = 'custom';
  const stop = new AbortController();
  const releases = new Map<string, () => void>();
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const name = JSON.parse(String(init?.body)).input;
    await new Promise<void>(resolve => { releases.set(name, resolve); });
    return new Response('complete', { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  vi.stubGlobal('fetch', fetch);
  const make = (name: string, signal?: AbortSignal) => generateSpeech({ text: name, outputAbsPath: path.join(root, `${name}.mp3`), signal });
  const first = make('cancel-active', stop.signal), second = make('healthy');
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const queued = make('next-in-queue');
  stop.abort(); await Promise.resolve(); await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(2);
  releases.get('cancel-active')!();
  expect(await first).toMatchObject({ ok: false, requestDisposition: 'sent', chargeStatus: 'unknown' });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  releases.get('healthy')!(); releases.get('next-in-queue')!();
  expect((await Promise.all([second, queued])).every(result => result.ok)).toBe(true);
  expect(existsSync(path.join(root, 'cancel-active.mp3'))).toBe(false);
});
