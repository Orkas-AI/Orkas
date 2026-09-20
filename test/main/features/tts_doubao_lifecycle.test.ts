import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../../../src/main/features/tts_auth', async original => ({
  ...await original<any>(),
  listUsableTtsProfiles: () => [{ id: 'fixture-doubao', provider: 'doubao', baseUrl: 'https://speech.example.invalid', apiKey: 'fixture-key', voice: 'zh_female_vv_uranus_bigtts', format: 'wav' }],
}));
import { generateSpeech } from '../../../src/main/features/tts';
import { listTtsCapabilities } from '../../../src/main/features/tts_capabilities';
let root: string, prior: NodeJS.ProcessEnv;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-http-')); prior = { ...process.env }; delete process.env.ORKAS_TTS_BASE_URL; });
afterEach(() => { vi.unstubAllGlobals(); process.env = prior; fs.rmSync(root, { recursive: true, force: true }); });
const pcm = Buffer.alloc(2400 * 2);
const response = () => new Response(JSON.stringify({ code: 0, data: pcm.toString('base64') }) + '\n{"code":20000000}');
async function request(speed?: number) {
  const [route] = await listTtsCapabilities();
  return generateSpeech({ text: '这是一次配音。', outputAbsPath: path.join(root, 'voice.wav'), routeRef: route.routeRef, voiceRef: route.voices[0].voiceRef, language: 'zh-CN', format: 'wav', ...(speed === undefined ? {} : { speed }) });
}
// Oracle: Volcengine V3 audio_params.speech_rate, -50 = .5x, 0 = 1x, 100 = 2x.
it.each([[.5, -50], [1, 0], [1.1, 10], [2, 100], [undefined, undefined]])('sends V3 voice/format/speed and persists PCM as WAV (%s)', async (speed, rate) => {
  const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
  expect(await request(speed)).toMatchObject({ ok: true, backend: 'doubao' });
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0] as any;
  expect(url).toBe('https://speech.example.invalid/api/v3/tts/unidirectional');
  const req = JSON.parse(init.body).req_params;
  expect(req.speaker).toBe('zh_female_vv_uranus_bigtts');
  expect(req.audio_params).toEqual({ format: 'pcm', sample_rate: 24000, ...(rate === undefined ? {} : { speech_rate: rate }) });
  expect(req).not.toHaveProperty('speed_ratio');
  const bytes = fs.readFileSync(path.join(root, 'voice.wav'));
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF'); expect(bytes.readUInt32LE(24)).toBe(24000); expect(bytes.subarray(44)).toEqual(pcm);
});
it.each([0, 2.1, NaN, Infinity])('rejects invalid speed before dispatch (%s)', async speed => {
  const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
  expect(await request(speed)).toMatchObject({ ok: false, errorCode: 'E_TTS_ARG', chargeStatus: 'not_charged' });
  expect(fetch).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(root, 'voice.wav'))).toBe(false);
});
it('does not save partial rejected audio or repeat a potentially charged request', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: pcm.toString('base64') }) + '\n{"code":40000001,"message":"private upstream detail"}'));
  vi.stubGlobal('fetch', fetch);
  const result = await request(1);
  expect(result).toMatchObject({ ok: false, errorCode: 'E_TTS_API_ERROR', requestDisposition: 'sent', chargeStatus: 'unknown' });
  expect(JSON.stringify(result)).not.toContain('private upstream detail');
  expect(fetch).toHaveBeenCalledOnce(); expect(fs.existsSync(path.join(root, 'voice.wav'))).toBe(false);
});
