import { describe, expect, it } from 'vitest';

import {
  parseDoubaoV3Ndjson,
  deriveDoubaoResourceId,
  normalizeDoubaoAudioFormat,
  wrapPcm16MonoWav,
} from '../../../src/main/features/tts';

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('parseDoubaoV3Ndjson', () => {
  it('concatenates base64 audio chunks in order, ignoring the terminator', () => {
    const raw = [
      JSON.stringify({ code: 0, data: b64('AAAA') }),
      JSON.stringify({ code: 0, data: b64('BBBB') }),
      JSON.stringify({ code: 20000000 }),
    ].join('\n');
    const r = parseDoubaoV3Ndjson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.audio.toString()).toBe('AAAABBBB');
  });

  it('succeeds even without an explicit terminator line', () => {
    const r = parseDoubaoV3Ndjson(JSON.stringify({ code: 0, data: b64('hello') }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.audio.toString()).toBe('hello');
  });

  it('tolerates blank and stray non-JSON lines between data events', () => {
    const raw = [
      '',
      'not json at all',
      JSON.stringify({ code: 0, data: b64('X') }),
      '   ',
      JSON.stringify({ code: 0, data: b64('Y') }),
    ].join('\n');
    const r = parseDoubaoV3Ndjson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.audio.toString()).toBe('XY');
  });

  it('fails with the server message on an error event (and does not deliver partial audio)', () => {
    const raw = [
      JSON.stringify({ code: 0, data: b64('partial') }),
      JSON.stringify({ code: 40000001, message: 'invalid speaker' }),
    ].join('\n');
    const r = parseDoubaoV3Ndjson(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('invalid speaker');
  });

  it('falls back to the code when an error event has no message', () => {
    const r = parseDoubaoV3Ndjson(JSON.stringify({ code: 55000123 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('55000123');
  });

  it('fails when there is no audio at all (terminator only)', () => {
    const r = parseDoubaoV3Ndjson(JSON.stringify({ code: 20000000 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/no audio/i);
  });

  it('fails on empty input', () => {
    expect(parseDoubaoV3Ndjson('').ok).toBe(false);
  });

  it('skips a code-0 line whose data is empty (not a chunk)', () => {
    const raw = [
      JSON.stringify({ code: 0, data: '' }),
      JSON.stringify({ code: 0, data: b64('Z') }),
    ].join('\n');
    const r = parseDoubaoV3Ndjson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.audio.toString()).toBe('Z');
  });

  it('accepts numeric string codes and SSE data prefixes', () => {
    const raw = [
      `data: ${JSON.stringify({ code: '0', data: b64('voice') })}`,
      `data: ${JSON.stringify({ code: '20000000' })}`,
    ].join('\n');
    const r = parseDoubaoV3Ndjson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.audio.toString()).toBe('voice');
  });
});

describe('Doubao streaming audio formats', () => {
  it('maps public formats to formats supported by the streaming endpoint', () => {
    expect(normalizeDoubaoAudioFormat('mp3')).toBe('mp3');
    expect(normalizeDoubaoAudioFormat('opus')).toBe('ogg_opus');
    expect(normalizeDoubaoAudioFormat('ogg')).toBe('ogg_opus');
    expect(normalizeDoubaoAudioFormat('wav')).toBe('pcm');
  });

  it('wraps PCM16 audio in a valid mono WAV header', () => {
    const wav = wrapPcm16MonoWav(Buffer.from([1, 2, 3, 4]));
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(44)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});

describe('deriveDoubaoResourceId', () => {
  it('maps the moon / mars / ICL 1.0 family to seed-tts-1.0', () => {
    expect(deriveDoubaoResourceId('zh_male_shaonianzixin_moon_bigtts')).toBe('seed-tts-1.0');
    expect(deriveDoubaoResourceId('zh_female_cancan_mars_bigtts')).toBe('seed-tts-1.0');
    expect(deriveDoubaoResourceId('ICL_zh_female_xxx')).toBe('seed-tts-1.0');
  });

  it('maps the uranus / jupiter / saturn 2.0 family to seed-tts-2.0', () => {
    expect(deriveDoubaoResourceId('zh_female_vv_jupiter_bigtts')).toBe('seed-tts-2.0');
    expect(deriveDoubaoResourceId('zh_male_x_uranus_bigtts')).toBe('seed-tts-2.0');
    expect(deriveDoubaoResourceId('saturn_zh_female_x')).toBe('seed-tts-2.0');
  });

  it('maps a cloned S_ voice to seed-icl-2.0', () => {
    expect(deriveDoubaoResourceId('S_abc123def')).toBe('seed-icl-2.0');
  });

  it('is case-insensitive', () => {
    expect(deriveDoubaoResourceId('ZH_MALE_X_MOON_BIGTTS')).toBe('seed-tts-1.0');
  });

  it('falls back to seed-tts-2.0 for an unknown or empty family', () => {
    expect(deriveDoubaoResourceId('weird_voice_id')).toBe('seed-tts-2.0');
    expect(deriveDoubaoResourceId('')).toBe('seed-tts-2.0');
  });
});
