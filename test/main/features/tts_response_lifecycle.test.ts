import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  provider: 'custom',
  baseUrl: 'https://speech.example.invalid',
  profileFailure: null as Error | null,
  probe: vi.fn<() => Promise<number | null>>(),
  warn: vi.fn(),
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

let root: string;
let priorBase: string | undefined;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tts-response-'));
  priorBase = process.env.ORKAS_TTS_BASE_URL;
  delete process.env.ORKAS_TTS_BASE_URL;
  state.baseUrl = 'https://speech.example.invalid';
  state.profileFailure = null;
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
