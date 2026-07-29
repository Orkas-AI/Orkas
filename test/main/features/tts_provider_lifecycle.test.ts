import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateSpeech } from '../../../src/main/features/tts';

const envKeys = [
  'ORKAS_TTS_BASE_URL',
  'ORKAS_TTS_API_KEY',
  'ORKAS_TTS_MODEL',
  'ORKAS_TTS_VOICE',
  'ORKAS_TTS_FORMAT',
] as const;
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let tempRoot = '';

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'orkas-tts-provider-'));
  process.env.ORKAS_TTS_BASE_URL = 'https://speech.example.invalid/v1';
  process.env.ORKAS_TTS_API_KEY = 'tts-test-secret';
  process.env.ORKAS_TTS_MODEL = 'speech-test-model';
  process.env.ORKAS_TTS_VOICE = 'voice-test';
  delete process.env.ORKAS_TTS_FORMAT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tempRoot, { recursive: true, force: true });
  for (const key of envKeys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('TTS provider request-to-file lifecycle', () => {
  it('sends the selected OpenAI-compatible contract and persists returned audio', async () => {
    const audio = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
    const fetchStub = vi.fn(async () => new Response(audio, {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    }));
    vi.stubGlobal('fetch', fetchStub);
    const outputPath = path.join(tempRoot, 'nested', 'narration.mp3');

    const result = await generateSpeech({
      text: 'A clear release update.',
      outputAbsPath: outputPath,
      speed: 1.05,
    });

    expect(result).toMatchObject({
      ok: true,
      path: outputPath,
      bytes: audio.length,
      backend: 'openai-compatible',
    });
    expect(existsSync(outputPath)).toBe(true);
    expect(fetchStub).toHaveBeenCalledOnce();
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe('https://speech.example.invalid/v1/audio/speech');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer tts-test-secret',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'speech-test-model',
      input: 'A clear release update.',
      voice: 'voice-test',
      response_format: 'mp3',
      speed: 1.05,
    });
  });

  it('rejects a 200 JSON error envelope instead of saving it as playable audio', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'upstream_overloaded', message: 'try later' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const outputPath = path.join(tempRoot, 'should-not-exist.mp3');

    const result = await generateSpeech({
      text: 'Do not turn an error into audio.',
      outputAbsPath: outputPath,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'E_TTS_INVALID_AUDIO',
      requestDisposition: 'sent',
      chargeStatus: 'unknown',
      retryPolicy: 'unknown',
    });
    expect(existsSync(outputPath)).toBe(false);
  });

  it('bounds provider HTTP failures without leaking response internals', async () => {
    const raw = 'bucket failed at /srv/private/voice with token=provider-secret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    })));

    const result = await generateSpeech({
      text: 'Keep provider diagnostics out of the user result.',
      outputAbsPath: path.join(tempRoot, 'upstream-failure.mp3'),
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'E_TTS_API_ERROR',
      requestDisposition: 'sent',
      chargeStatus: 'unknown',
      retryPolicy: 'unknown',
    });
    expect(JSON.stringify(result)).not.toContain('/srv/private/voice');
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  });

  it('does not dispatch an already-aborted synthesis request', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    const controller = new AbortController();
    controller.abort();

    const result = await generateSpeech({
      text: 'Do not send this request.',
      outputAbsPath: path.join(tempRoot, 'aborted.mp3'),
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'E_TTS_ABORTED',
      requestDisposition: 'not_sent',
      chargeStatus: 'not_charged',
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('returns a retry-safe storage result when generated audio cannot be persisted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      Buffer.from([0x49, 0x44, 0x33, 0x04]),
      { status: 200, headers: { 'Content-Type': 'audio/mpeg' } },
    )));
    const blockedParent = path.join(tempRoot, 'parent-is-a-file');
    writeFileSync(blockedParent, 'not a directory');

    await expect(generateSpeech({
      text: 'This provider request may already be billable.',
      outputAbsPath: path.join(blockedParent, 'narration.mp3'),
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_TTS_WRITE',
      requestDisposition: 'sent',
      chargeStatus: 'unknown',
      retryPolicy: 'requires_user_action',
    });
  });
});
