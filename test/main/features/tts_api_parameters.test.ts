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

let root: string;
let prior: NodeJS.ProcessEnv;
const transcript = 'Keep the supplied narration. 保留原文。';
const pcm = Buffer.alloc(4800);
function wav(rate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tts-parameters-'));
  prior = { ...process.env }; delete process.env.ORKAS_TTS_BASE_URL;
});
afterEach(() => { vi.unstubAllGlobals(); process.env = prior; rmSync(root, { recursive: true, force: true }); });
function configure(provider: string, model: string, format = 'mp3') {
  const bases: Record<string, string> = { minimax: 'https://api.minimax.cn/v1',
    aliyun: 'https://workspace.cn-beijing.maas.aliyuncs.com', google: 'https://generativelanguage.googleapis.com/v1beta',
    openai: 'https://api.openai.com/v1', elevenlabs: 'https://api.elevenlabs.io/v1', doubao: 'https://openspeech.bytedance.com' };
  state.profiles = [{ id: 'saved-api', provider, model, baseUrl: bases[provider], apiKey: 'fixture-key',
    voice: provider === 'doubao' ? 'zh_female_vv_uranus_bigtts' : 'configured-voice', format }];
}
const output = (format: string) => path.join(root, `speech.${format}`);
async function request(format?: string, speed?: number, text = transcript) {
  const [route] = await listTtsCapabilities();
  return generateSpeech({ text, routeRef: route.routeRef, voiceRef: route.defaultVoiceRef,
    outputAbsPath: output(format || state.profiles[0].format), format, speed });
}

// Native OpenAPI T2AAudioSetting enum, not the narrower voice_modify effect formats:
// https://platform.minimax.cn/docs/api-reference/speech-t2a-http.md
it.each(['speech-2.8-hd', 'speech-2.8-turbo'].flatMap(model =>
  ['mp3', 'wav', 'pcm', 'flac', 'opus'].map(format => [model, format])))('MiniMax %s sends native %s audio settings', async (model, format) => {
  configure('minimax', model, format);
  const audio = format === 'wav' ? wav(32000) : format === 'pcm' ? pcm : Buffer.from(`native ${format}`);
  const fetch = vi.fn(async () => Response.json({ base_resp: { status_code: 0 }, data: { status: 2, audio: audio.toString('hex') } }));
  vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: true, backend: 'minimax' });
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0] as any;
  expect(url).toBe('https://api.minimax.cn/v1/t2a_v2');
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body)).toEqual({ model, text: transcript, stream: false, output_format: 'hex',
    voice_setting: { voice_id: 'configured-voice', speed: 1 },
    audio_setting: { format, sample_rate: format === 'opus' ? 24000 : 32000, bitrate: 128000, channel: 1 } });
  expect(readFileSync(output(format))).toEqual(audio);
});

// Qwen-Audio-TTS HTTP input.rate and four native formats, Beijing workspace endpoint.
it.each(['qwen-audio-3.1-tts-plus', 'qwen-audio-3.1-tts-flash'].flatMap(model =>
  ['mp3', 'wav', 'pcm', 'opus'].map(format => [model, format])))('Qwen %s sends native %s format and downloads without credentials', async (model, format) => {
  configure('aliyun', model, format);
  const audio = format === 'wav' ? wav() : format === 'pcm' ? pcm : Buffer.from(`native ${format}`);
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ output: { finish_reason: 'stop', audio: {
    url: `http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.${format}?signature=fixture`,
  } } })).mockResolvedValueOnce(new Response(audio)); vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: true, backend: 'aliyun' });
  const [url, init] = fetch.mock.calls[0] as any;
  expect(url).toBe('https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body)).toEqual({ model, input: { text: transcript, voice: 'configured-voice', format, sample_rate: 24000, rate: 1 } });
  expect(fetch.mock.calls[1]).toEqual([`https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.${format}?signature=fixture`,
    { signal: expect.any(AbortSignal), redirect: 'error' }]);
  expect(readFileSync(output(format))).toEqual(audio);
});

// Interactions single-speaker unary WAV is converted locally, with no invented prompt or speed setting.
it.each(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'].flatMap(model =>
  ['wav', 'pcm', 'mp3', 'opus'].map(format => [model, format])))('Gemini %s delivers actual %s bytes from unary WAV', async (model, format) => {
  configure('google', model, format);
  const fetch = vi.fn(async () => Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [
    { type: 'audio', mime_type: 'audio/wav', data: wav().toString('base64') },
  ] }] })); vi.stubGlobal('fetch', fetch);
  expect(await request(undefined, 1)).toMatchObject({ ok: true, backend: 'google' });
  const [url, init] = fetch.mock.calls[0] as any;
  expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ 'x-goog-api-key': 'fixture-key', 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body)).toEqual({ model, input: [{ type: 'user_input', content: [{ type: 'text', text: transcript }] }],
    response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: 'configured-voice' }] }, store: false });
  const bytes = readFileSync(output(format));
  if (format === 'wav') expect(bytes).toEqual(wav());
  else if (format === 'pcm') expect(bytes).toEqual(pcm);
  else expect(bytes.subarray(0, format === 'mp3' ? 3 : 4).toString()).toBe(format === 'mp3' ? 'ID3' : 'OggS');
  expect(fetch).toHaveBeenCalledOnce();
});

// OpenAI Speech and ElevenLabs native speech have independent authentication and codec contracts.
it.each(['mp3', 'wav', 'pcm', 'opus', 'aac', 'flac'])('OpenAI Speech preserves %s and omits absent speed', async format => {
  configure('openai', 'gpt-4o-mini-tts', format);
  const audio = Buffer.from(`native ${format}`);
  const fetch = vi.fn(async () => new Response(audio)); vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: true });
  const [url, init] = fetch.mock.calls[0] as any;
  expect(url).toBe('https://api.openai.com/v1/audio/speech');
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body)).toEqual({ model: 'gpt-4o-mini-tts', input: transcript, voice: 'configured-voice', response_format: format });
  expect(readFileSync(output(format))).toEqual(audio); expect(fetch).toHaveBeenCalledOnce();
});
it.each([['mp3', 'mp3_44100_128'], ['wav', 'pcm_24000'], ['pcm', 'pcm_24000'], ['opus', 'opus_48000_128']])('Eleven v4 maps %s to %s without unsupported speed settings', async (format, codec) => {
  configure('elevenlabs', 'eleven_v4', format);
  const fetch = vi.fn(async () => new Response(pcm)); vi.stubGlobal('fetch', fetch);
  expect(await request(undefined, 1)).toMatchObject({ ok: true });
  const [url, init] = fetch.mock.calls[0] as any;
  expect(url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/configured-voice?output_format=${codec}`);
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ 'xi-api-key': 'fixture-key', 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body)).toEqual({ model_id: 'eleven_v4', text: transcript });
  expect(readFileSync(output(format))).toEqual(format === 'wav' ? wav() : pcm);
});

// Volcengine HTTP: required UUID header; ogg_opus only supports 48000 Hz; PCM must stay PCM.
it.each([['mp3', 'mp3', 24000], ['wav', 'pcm', 24000], ['pcm', 'pcm', 24000],
  ['opus', 'ogg_opus', 48000], ['ogg', 'ogg_opus', 48000]])('Doubao %s requests %s at %s Hz with a request UUID', async (format, upstream, rate) => {
  configure('doubao', '', String(format));
  const fetch = vi.fn(async () => new Response(`${JSON.stringify({ code: 0, data: pcm.toString('base64') })}\n{"code":20000000}`));
  vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: true, backend: 'doubao' });
  const [url, init] = fetch.mock.calls[0] as any;
  expect(url).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ 'X-Api-Key': 'fixture-key', 'X-Api-Resource-Id': 'seed-tts-2.0',
    'X-Api-Request-Id': expect.stringMatching(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i), 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body).req_params).toEqual({ text: transcript, speaker: 'zh_female_vv_uranus_bigtts',
    audio_params: { format: upstream, sample_rate: rate } });
  expect(readFileSync(output(String(format)))).toEqual(format === 'wav' ? wav() : pcm);
  expect((await listTtsCapabilities())[0].supports.formats).toEqual(expect.arrayContaining(['mp3', 'wav', 'pcm', 'opus', 'ogg']));
});

const boundedModels = [
  ['minimax', 'speech-2.8-hd', 0.5, 2, 9999],
  ['aliyun', 'qwen-audio-3.1-tts-plus', 0.5, 2, undefined],
  ['openai', 'gpt-4o-mini-tts', 0.25, 4, 4096],
  ['elevenlabs', 'eleven_v4', 1, 1, 10000],
] as const;
it.each(boundedModels.flatMap(([provider, model, min, max]) =>
  [...new Set([min, max])].map(speed => ({ provider, model, speed }))))(
  '$provider accepts supported boundary speed $speed without rewriting it', async ({ provider, model, speed }) => {
    configure(provider, model);
    const fetch = vi.fn(async (url: string) => provider === 'minimax'
      ? Response.json({ base_resp: { status_code: 0 }, data: { status: 2, audio: pcm.toString('hex') } })
      : provider === 'aliyun' && url.endsWith('/SpeechSynthesizer')
        ? Response.json({ output: { finish_reason: 'stop', audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/voice.mp3' } } })
        : new Response(pcm)); vi.stubGlobal('fetch', fetch);
    expect(await request('mp3', speed)).toMatchObject({ ok: true });
    const body = JSON.parse((fetch.mock.calls[0] as any)[1].body);
    if (provider === 'minimax') expect(body.voice_setting.speed).toBe(speed);
    else if (provider === 'aliyun') expect(body.input.rate).toBe(speed);
    else if (provider === 'openai') expect(body.speed).toBe(speed);
    else expect(body).not.toHaveProperty('voice_settings');
    expect(fetch).toHaveBeenCalledTimes(provider === 'aliyun' ? 2 : 1);
  });
it.each(boundedModels.flatMap(([provider, model, min, max]) =>
  [min - 0.01, max + 0.01, NaN, Infinity].map(speed => ({ provider, model, speed }))))(
  '$provider rejects speed $speed before dispatch', async ({ provider, model, speed }) => {
    configure(provider, model); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await request('mp3', speed)).toMatchObject({ ok: false, errorCode: 'E_TTS_ARG', requestDisposition: 'rejected_preflight', chargeStatus: 'not_charged' });
    expect(fetch).not.toHaveBeenCalled(); expect(existsSync(output('mp3'))).toBe(false);
  });
it.each(boundedModels.filter(entry => entry[4] !== undefined).flatMap(([provider, model, , , limit]) =>
  [-1, 0, 1].map(delta => ({ provider, model, length: limit! + delta, allowed: delta <= 0 }))))(
  '$provider validates transcript length $length before dispatch', async ({ provider, model, length, allowed }) => {
    configure(provider, model);
    const fetch = vi.fn(async () => provider === 'minimax'
      ? Response.json({ base_resp: { status_code: 0 }, data: { status: 2, audio: pcm.toString('hex') } })
      : new Response(pcm)); vi.stubGlobal('fetch', fetch);
    const result = await request('mp3', undefined, 'a'.repeat(length));
    if (allowed) { expect(result).toMatchObject({ ok: true }); expect(fetch).toHaveBeenCalledOnce(); }
    else { expect(result).toMatchObject({ ok: false, chargeStatus: 'not_charged' }); expect(fetch).not.toHaveBeenCalled(); }
  });
it('does not turn an unsupported Doubao format into an MP3 file with a different extension', async () => {
  configure('doubao', ''); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await request('flac')).toMatchObject({ ok: false, errorCode: 'E_TTS_ARG', chargeStatus: 'not_charged' });
  expect(fetch).not.toHaveBeenCalled(); expect(existsSync(output('flac'))).toBe(false);
});

it('uses the documented clone resource and model for a configured Doubao 2.0 cloned voice', async () => {
  configure('doubao', ''); state.profiles[0].voice = 'S_fixture_cloned_voice';
  const fetch = vi.fn(async () => new Response(`${JSON.stringify({ code: 0, data: pcm.toString('base64') })}\n{"code":20000000}`));
  vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: true });
  const [, init] = fetch.mock.calls[0] as any;
  expect(init.headers['X-Api-Resource-Id']).toBe('seed-icl-2.0');
  expect(JSON.parse(init.body).req_params).toMatchObject({ speaker: 'S_fixture_cloned_voice', model: 'seed-tts-2.0-standard' });
});

it('gives separate Doubao synthesis requests distinct request UUIDs', async () => {
  configure('doubao', '');
  const fetch = vi.fn(async () => new Response(`${JSON.stringify({ code: 0, data: pcm.toString('base64') })}\n{"code":20000000}`));
  vi.stubGlobal('fetch', fetch);
  expect(await request()).toMatchObject({ ok: true });
  expect(await request()).toMatchObject({ ok: true });
  expect(fetch).toHaveBeenCalledTimes(2);
  const ids = fetch.mock.calls.map(call => (call as any)[1].headers['X-Api-Request-Id']);
  expect(ids[0]).not.toBe(ids[1]);
});
