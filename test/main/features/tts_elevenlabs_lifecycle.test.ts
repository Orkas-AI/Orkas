import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ profiles: [] as any[] }));
vi.mock('../../../src/main/features/tts_auth', async original => ({
  ...await original<any>(),
  listUsableTtsProfiles: () => fixture.profiles,
}));
import { generateSpeech } from '../../../src/main/features/tts';
import { listTtsCapabilities } from '../../../src/main/features/tts_capabilities';
import { listTtsProviderPresets } from '../../../src/main/features/tts_auth';

let root: string;
let prior: NodeJS.ProcessEnv;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'elevenlabs-http-'));
  prior = { ...process.env };
  delete process.env.ORKAS_TTS_BASE_URL;
  const preset = listTtsProviderPresets().find(p => p.id === 'elevenlabs')!;
  fixture.profiles = [{ id: 'saved-elevenlabs', provider: preset.id, baseUrl: preset.baseUrl,
    // A saved legacy profile keeps its model when the new-config preset advances.
    model: 'eleven_multilingual_v2', apiKey: 'fixture-key', voice: 'JBFqnCBsd6RMkjVDRZzb', label: 'ElevenLabs', createdAt: 1 }];
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = prior;
  rmSync(root, { recursive: true, force: true });
});
async function request(format = 'mp3', speed?: number, signal?: AbortSignal) {
  const [route] = await listTtsCapabilities();
  return generateSpeech({ text: 'A clear release update.', outputAbsPath: path.join(root, `voice.${format}`),
    routeRef: route.routeRef, voiceRef: route.voices[0].voiceRef, format, speed, signal });
}

// Independent oracle: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
// Native voice_id path + xi-api-key; model_id/text body; codec query parameter.
// PCM 24k is available without a Pro plan and is wrapped locally for WAV output.
it.each([['mp3', 'mp3_44100_128'], ['wav', 'pcm_24000'], ['opus', 'opus_48000_128']])(
  'uses the saved ElevenLabs preset through voice selection and persists %s audio', async (format, codec) => {
    const audio = format === 'wav' ? Buffer.alloc(4800) : Buffer.from('fixture audio');
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=${codec}`);
      expect(init?.headers).toEqual({ 'xi-api-key': 'fixture-key', 'Content-Type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({ text: 'A clear release update.', model_id: 'eleven_multilingual_v2', voice_settings: { speed: 1.05 } });
      return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await request(format, 1.05)).toMatchObject({ ok: true, backend: 'elevenlabs' });
    expect(fetch).toHaveBeenCalledOnce();
    const bytes = readFileSync(path.join(root, `voice.${format}`));
    if (format === 'wav') {
      expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
      expect(bytes.readUInt32LE(24)).toBe(24000);
      expect(bytes.subarray(44)).toEqual(audio);
    } else expect(bytes).toEqual(audio);
  });

it('omits optional voice settings and encodes the voice as one path segment', async () => {
  fixture.profiles[0].voice = 'voice/with space';
  const fetch = vi.fn(async () => new Response(Buffer.from('audio')));
  vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: true });
  const [url, init] = fetch.mock.calls[0] as any;
  expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice%2Fwith%20space?output_format=mp3_44100_128');
  expect(JSON.parse(init.body)).toEqual({ text: 'A clear release update.', model_id: 'eleven_multilingual_v2' });
});

it.each([0.5, 1.3, NaN, Infinity])('rejects unsupported native speed without dispatch (%s)', async speed => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await request('mp3', speed)).toMatchObject({ ok: false, errorCode: 'E_TTS_ARG', chargeStatus: 'not_charged' });
  expect(fetch).not.toHaveBeenCalled(); expect(existsSync(path.join(root, 'voice.mp3'))).toBe(false);
});

it.each(['flac', 'constructor', '__proto__'])('rejects unsupported output codec %s without dispatch', async format => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await request(format)).toMatchObject({ ok: false, errorCode: 'E_TTS_ARG', chargeStatus: 'not_charged' });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([401, 422, 502, 200])('does not save error responses or replay synthesis (HTTP %s)', async status => {
  const fetch = vi.fn(async () => new Response('{"detail":"private provider error"}', { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const result = await request();
  expect(result).toMatchObject({ ok: false, requestDisposition: 'sent', chargeStatus: 'unknown' });
  expect(JSON.stringify(result)).not.toContain('private provider error');
  expect(fetch).toHaveBeenCalledOnce(); expect(existsSync(path.join(root, 'voice.mp3'))).toBe(false);
});

it('preserves unknown charge status after a transport error without replay', async () => {
  const fetch = vi.fn(async () => { throw new Error('fixture connection closed'); }); vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: false, errorCode: 'E_TTS_NETWORK', requestDisposition: 'sent', chargeStatus: 'unknown' });
  expect(fetch).toHaveBeenCalledOnce(); expect(existsSync(path.join(root, 'voice.mp3'))).toBe(false);
});

it('preserves cancellation before the native request', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const controller = new AbortController(); controller.abort();
  expect(await request('mp3', undefined, controller.signal)).toMatchObject({ ok: false, requestDisposition: 'not_sent', chargeStatus: 'not_charged' });
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps an explicit custom gateway on the OpenAI-compatible protocol', async () => {
  fixture.profiles[0].provider = 'custom';
  const fetch = vi.fn(async () => new Response(Buffer.from('audio'))); vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: true, backend: 'openai-compatible' });
  expect(fetch.mock.calls[0][0]).toBe('https://api.elevenlabs.io/v1/audio/speech');
});

it('uses Eleven v4 native speech with neutral speed omitted from unsupported voice settings', async () => {
  fixture.profiles[0].model = 'eleven_v4';
  const fetch = vi.fn(async () => new Response(Buffer.from('audio'))); vi.stubGlobal('fetch', fetch);
  expect(await request('mp3', 1)).toMatchObject({ ok: true, backend: 'elevenlabs' });
  const [url, init] = fetch.mock.calls[0] as any;
  expect(url).toContain('/text-to-speech/');
  expect(JSON.parse(init.body)).toEqual({ text: 'A clear release update.', model_id: 'eleven_v4' });
  expect((await listTtsCapabilities())[0].supports.speed).toBe(false);
});

it('rejects unsupported Eleven v4 speed before synthesizing', async () => {
  fixture.profiles[0].model = 'eleven_v4';
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await request('mp3', 1.1)).toMatchObject({ ok: false, chargeStatus: 'not_charged' });
  expect(fetch).not.toHaveBeenCalled();
});

it('uses the native OpenAI Speech API for the selected GPT-4o mini TTS model', async () => {
  fixture.profiles[0] = { ...fixture.profiles[0], provider: 'openai', model: 'gpt-4o-mini-tts',
    baseUrl: 'https://api.openai.com/v1', voice: 'alloy' };
  const fetch = vi.fn(async () => new Response(Buffer.from('audio'))); vi.stubGlobal('fetch', fetch);
  expect(await request('mp3', 1.1)).toMatchObject({ ok: true, backend: 'openai-compatible' });
  const [url, init] = fetch.mock.calls[0] as any;
  expect(url).toBe('https://api.openai.com/v1/audio/speech');
  expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
  expect(JSON.parse(init.body)).toEqual({ model: 'gpt-4o-mini-tts', input: 'A clear release update.',
    voice: 'alloy', response_format: 'mp3', speed: 1.1 });
});
