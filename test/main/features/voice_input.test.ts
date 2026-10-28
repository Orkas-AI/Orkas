import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ key: 'test-speech-key', uid: 'local-owner', status: 'granted', ask: vi.fn(async () => true) }));
vi.mock('../../../src/main/features/auth', () => ({ getOrkasApiKey: () => state.key }));
vi.mock('../../../src/main/features/users', () => ({ getActiveUserId: () => state.uid }));
vi.mock('electron', () => ({ systemPreferences: {
  getMediaAccessStatus: vi.fn(() => state.status), askForMediaAccess: state.ask,
} }));

import { createVoiceSession, getVoiceStatus, ensureMicrophoneAccess } from '../../../src/main/features/voice_input';

const ticket = 't'.repeat(43);
describe('API-key voice session', () => {
  beforeEach(() => { state.key = 'test-speech-key'; state.uid = 'local-owner'; state.status = 'granted'; state.ask.mockClear(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('exchanges a main-process credential for a fixed-origin ticket without exposing the key', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ticket, expires_in: 30, max_seconds: 120 })));
    vi.stubGlobal('fetch', fetcher);
    const result = await createVoiceSession();
    expect(getVoiceStatus()).toEqual({ configured: true });
    expect(result).toEqual({ ok: true, url: `wss://orkas.ai/api/voice/asr_ws?ticket=${ticket}`, maxSeconds: 120 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://orkas.ai/v1/audio/transcription_sessions');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', body: '{}',
      headers: { Authorization: 'Bearer test-speech-key', 'Content-Type': 'application/json' } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain(state.key);
  });

  it('requires a configured key before making any request', async () => {
    state.key = '';
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await createVoiceSession()).toEqual({ ok: false, code: 'api_key_required' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(getVoiceStatus()).toEqual({ configured: false });
  });

  it.each([401, 403, 429, 500, 503])('returns a bounded public failure for HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private upstream error', { status })));
    const result = await createVoiceSession();
    expect(result).toEqual({ ok: false, code: status === 401 ? 'invalid_api_key' : status === 403 ? 'insufficient_scope' : status === 429 ? 'rate_limit_exceeded' : 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([
    { ticket: 'short' }, { ticket: 'x'.repeat(44) }, { ticket: `${'x'.repeat(42)}&` },
    { url: 'wss://untrusted.example/asr', ticket: '' }, { ticket: 123 },
  ])('rejects malformed ticket responses without constructing an arbitrary transport', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    expect(await createVoiceSession()).toEqual({ ok: false, code: 'unavailable' });
  });

  it.each(['key', 'uid'])('discards a late ticket when the local %s changes', async (field) => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const pending = createVoiceSession();
    state[field as 'key' | 'uid'] = 'replacement';
    finish(new Response(JSON.stringify({ ticket })));
    expect(await pending).toEqual({ ok: false, code: 'unavailable' });
  });

  it('keeps the timeout active until the control response body finishes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    })));
    const pending = createVoiceSession();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await pending).toEqual({ ok: false, code: 'unavailable' });
  });
});

// The macOS preflight never repeats a denied prompt; capture remains authoritative
// on other platforms (unknown is not a verified microphone grant).
describe('voice microphone preflight', () => {
  it.each(['denied', 'restricted'])('preserves %s without another OS request', async (status) => {
    state.status = status; state.ask.mockClear();
    expect(await ensureMicrophoneAccess('darwin')).toEqual({ granted: false, status });
    expect(state.ask).not.toHaveBeenCalled();
  });
  it('asks only for undecided macOS permission and leaves non-mac capture authoritative', async () => {
    state.status = 'not-determined'; state.ask.mockClear(); state.ask.mockResolvedValue(true);
    expect(await ensureMicrophoneAccess('darwin')).toEqual({ granted: true, status: 'granted' });
    expect(state.ask).toHaveBeenCalledWith('microphone');
    expect(await ensureMicrophoneAccess('linux')).toEqual({ granted: true, status: 'unknown' });
    expect(await ensureMicrophoneAccess('win32')).toEqual({ granted: true, status: 'unknown' });
  });
});
