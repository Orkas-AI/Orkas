import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ profiles: [] as any[] }));
vi.mock('../../../src/main/features/tts_auth', async original => ({
  ...await original<any>(), listUsableTtsProfiles: () => state.profiles,
}));
vi.mock('../../../src/main/util/media_probe', () => ({ probeMediaDurationSec: async () => null }));
import { generateSpeech } from '../../../src/main/features/tts';
import { listTtsCapabilities } from '../../../src/main/features/tts_capabilities';
import { listTtsProviderPresets } from '../../../src/main/features/tts_auth';

let root: string;
let prior: NodeJS.ProcessEnv;
const text = 'Keep this transcript unchanged. 配音测试。';
const audio = Buffer.from('ID3 fixture audio');
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'native-tts-'));
  prior = { ...process.env }; delete process.env.ORKAS_TTS_BASE_URL;
});
afterEach(() => { vi.unstubAllGlobals(); process.env = prior; rmSync(root, { recursive: true, force: true }); });
function select(provider: string, model: string, voice: string, format = 'mp3') {
  state.profiles = [{ id: 'saved-native', provider, model, voice, format, apiKey: 'fixture-key',
    baseUrl: provider === 'minimax' ? 'https://api.minimax.cn/v1' : provider === 'google'
      ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://workspace.cn-beijing.maas.aliyuncs.com',
    workspaceId: 'workspace', label: provider, createdAt: 1 }];
}
async function request(format = state.profiles[0].format, speed?: number, signal?: AbortSignal) {
  const [route] = await listTtsCapabilities();
  return generateSpeech({ text, outputAbsPath: path.join(root, `speech.${format}`),
    routeRef: route.routeRef, voiceRef: route.defaultVoiceRef, format, speed, signal });
}

it('offers six BYOK TTS providers and native model tiers while retaining the public API-key route', () => {
  const presets = listTtsProviderPresets() as any[];
  expect(presets.map(p => p.id)).toEqual(expect.arrayContaining(['doubao', 'minimax', 'aliyun', 'google', 'elevenlabs', 'openai']));
  expect(presets.find(p => p.id === 'minimax').models.map((m: any) => m.id)).toEqual(['speech-2.8-hd', 'speech-2.8-turbo']);
  expect(presets.find(p => p.id === 'aliyun').models.map((m: any) => m.id)).toEqual([
    'qwen-audio-3.1-tts-plus', 'qwen-audio-3.1-tts-flash', 'cosyvoice-v3.5-flash', 'cosyvoice-v3.5-plus',
  ]);
  expect(presets.find(p => p.id === 'orkas-api')).toMatchObject({ defaultModel: 'orkas-tts-1' });
});

// Independent native contract: platform.minimax.cn/docs/api-reference/speech-t2a-http.
it.each(['speech-2.8-hd', 'speech-2.8-turbo'])('synthesizes %s using domestic Bearer auth and hex audio', async model => {
  select('minimax', model, 'male-qn-qingse');
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://api.minimax.cn/v1/t2a_v2');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
    expect(JSON.parse(String(init.body))).toEqual({ model, text, stream: false, output_format: 'hex',
      voice_setting: { voice_id: 'male-qn-qingse', speed: 1.1 },
      audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 } });
    return Response.json({ base_resp: { status_code: 0 }, data: { status: 2, audio: audio.toString('hex') } });
  });
  vi.stubGlobal('fetch', fetch);
  expect(await request('mp3', 1.1)).toMatchObject({ ok: true, backend: 'minimax' });
  expect(readFileSync(path.join(root, 'speech.mp3'))).toEqual(audio); expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  { base_resp: { status_code: 1004, status_msg: 'private error' }, data: { status: 2, audio: '494433' } },
  { base_resp: { status_code: 0 }, data: { status: 1, audio: '494433' } },
  { base_resp: { status_code: 0 }, data: { status: 2, audio: '49443z' } },
  { base_resp: { status_code: 0 }, data: { status: 2, audio: '' } },
])('does not save incomplete, rejected, empty, or malformed MiniMax results', async body => {
  select('minimax', 'speech-2.8-hd', 'male-qn-qingse');
  const fetch = vi.fn(async () => Response.json(body)); vi.stubGlobal('fetch', fetch);
  const result = await request();
  expect(result).toMatchObject({ ok: false, requestDisposition: 'sent', chargeStatus: 'unknown' });
  expect(JSON.stringify(result)).not.toContain('private error');
  expect(existsSync(path.join(root, 'speech.mp3'))).toBe(false); expect(fetch).toHaveBeenCalledOnce();
});

// The raw Gemini Interactions REST response uses steps, not the SDK output_audio accessor.
it.each(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'])('saves %s WAV through Interactions', async model => {
  select('google', model, 'Kore', 'wav');
  const wav = Buffer.alloc(48); wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'fixture-key' });
    expect(JSON.parse(String(init.body))).toEqual({ model, input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: 'Kore' }] }, store: false });
    return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: wav.toString('base64') }] }] });
  });
  vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: true, backend: 'google' });
  expect(readFileSync(path.join(root, 'speech.wav'))).toEqual(wav); expect(fetch).toHaveBeenCalledOnce();
  expect((await listTtsCapabilities())[0].supports.speed).toBe(false);
});

it.each(['qwen-audio-3.1-tts-plus', 'qwen-audio-3.1-tts-flash'])('saves %s from the signed audio URL without forwarding credentials', async model => {
  select('aliyun', model, 'longanhuan_v3.1');
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/SpeechSynthesizer')) {
      expect(url).toBe('https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
      expect(JSON.parse(String(init.body))).toEqual({ model, input: { text, voice: 'longanhuan_v3.1', format: 'mp3', sample_rate: 24000, rate: 1.1 } });
      return Response.json({ output: { finish_reason: 'stop', audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/voice.mp3?signature=fixture' } } });
    }
    expect(init.headers).toBeUndefined(); expect(init.redirect).toBe('error');
    return new Response(audio, { headers: { 'content-type': 'audio/mpeg' } });
  });
  vi.stubGlobal('fetch', fetch);
  expect(await request('mp3', 1.1)).toMatchObject({ ok: true, backend: 'aliyun' });
  expect(readFileSync(path.join(root, 'speech.mp3'))).toEqual(audio); expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(['https://localhost/private', 'https://169.254.169.254/secret', 'http://evil.example/voice', 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.example/x'])('rejects an untrusted result URL %s without downloading it', async url => {
  select('aliyun', 'qwen-audio-3.1-tts-plus', 'longanhuan_v3.1');
  const fetch = vi.fn(async () => Response.json({ output: { finish_reason: 'stop', audio: { url } } })); vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: false, requestDisposition: 'sent' }); expect(fetch).toHaveBeenCalledOnce();
});

it.each([['minimax', 'speech-2.8-hd', 'aac', 1], ['google', 'gemini-3.8-flash-tts', 'wav', 1.2],
  ['aliyun', 'qwen-audio-3.1-tts-plus', 'mp3', 2.1]])('rejects unsupported %s arguments before a billable call', async (provider, model, format, speed) => {
  select(String(provider), String(model), 'configured-voice', String(format));
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await request(String(format), Number(speed))).toMatchObject({ ok: false, errorCode: 'E_TTS_ARG', chargeStatus: 'not_charged' });
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps pre-dispatch cancellation free of requests', async () => {
  select('minimax', 'speech-2.8-hd', 'male-qn-qingse');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const controller = new AbortController(); controller.abort();
  expect(await request('mp3', undefined, controller.signal)).toMatchObject({ ok: false, requestDisposition: 'not_sent', chargeStatus: 'not_charged' });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  { status: 'in_progress', steps: [] },
  { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'private error' }] }] },
  { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: '%%%=' }] }] },
])('rejects incomplete or malformed Google output without polling or saving it', async response => {
  select('google', 'gemini-3.8-flash-tts', 'Kore', 'wav');
  const fetch = vi.fn(async () => Response.json(response)); vi.stubGlobal('fetch', fetch);
  const result = await request();
  expect(result).toMatchObject({ ok: false, requestDisposition: 'sent', chargeStatus: 'unknown' });
  expect(JSON.stringify(result)).not.toContain('private error');
  expect(fetch).toHaveBeenCalledOnce(); expect(existsSync(path.join(root, 'speech.wav'))).toBe(false);
});

it('bounds a native JSON receipt before buffering its declared oversized body', async () => {
  select('minimax', 'speech-2.8-hd', 'male-qn-qingse');
  const cancel = vi.fn();
  const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-length': String(200 * 1024 * 1024) } }));
  vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: false, errorCode: 'E_TTS_TOO_LARGE', chargeStatus: 'unknown' });
  expect(cancel).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
});

it('preserves possible charges when an Alibaba audio download fails after accepted synthesis', async () => {
  select('aliyun', 'qwen-audio-3.1-tts-plus', 'longanhuan_v3.1');
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ output: { finish_reason: 'stop', audio: {
    url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/voice.mp3',
  } } })).mockResolvedValueOnce(Response.json({ error: 'private error' }, { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: false, requestDisposition: 'sent', chargeStatus: 'unknown' });
  expect(fetch).toHaveBeenCalledTimes(2); expect(existsSync(path.join(root, 'speech.mp3'))).toBe(false);
});
