import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { generateSpeech } from '../../../src/main/features/tts';
import { listTtsCapabilities } from '../../../src/main/features/tts_capabilities';
import { bundledRuntimeEnv } from '../../../src/main/util/bundled-runtime';
import { seedVoiceFixture, prepareVoiceProvider, inspectVoiceFixture, voiceChecks, inspectTranscript, speechFixtureFile, wordErrorRate } from '../../../eval/model-eval/regression/voice-studio-fixtures';
import { VOICE_LINES, VOICE_CASE_IDS } from '../../../eval/benchmark/scenarios/voice-studio';
const require = createRequire(import.meta.url);
const audio = require('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/audio.js');
let root: string, prior: NodeJS.ProcessEnv;
beforeEach(() => { prior = { ...process.env }; Object.assign(process.env, bundledRuntimeEnv()); root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-narration-'))); });
afterEach(() => { process.env = prior; fs.rmSync(root, { force: true, recursive: true }); });
it.each(['voice-narration-create', 'voice-revise-text'])('performs capability -> synthesis -> durable recording -> captions/export over real HTTP: %s', async id => {
  seedVoiceFixture(id, root); const provider = await prepareVoiceProvider(id);
  try {
    const project = path.join(root, 'audio/voice-project.json');
    const [route] = await listTtsCapabilities();
    const plan = JSON.parse(fs.readFileSync(project, 'utf8'));
    if (id === 'voice-narration-create') {
      plan.roles = { a: { route_ref: route.routeRef, voice_ref: route.voices[0].voiceRef, language: 'en-US', speed: 1 } };
      plan.segments = VOICE_LINES.slice(0, 2).map((text, i) => ({ id: i ? 'second' : 'first', text, role: 'a', gap_after_sec: i ? 0 : .2 }));
    } else plan.segments[1].text = VOICE_LINES[2];
    fs.writeFileSync(project, JSON.stringify(plan));
    const status = await audio.execute('status', { project });
    expect(status.segments.map((s: any) => s.status)).toEqual(id === 'voice-narration-create' ? ['pending', 'pending'] : ['ready', 'pending']);
    for (const s of status.segments.filter((s: any) => s.status === 'pending')) {
      const attempt = await audio.execute('begin', { project, segment_id: s.id });
      const r = attempt.request;
      const synthesized = await generateSpeech({ text: r.text, outputAbsPath: r.output_path, routeRef: r.route_ref, voiceRef: r.voice_ref, language: r.language, speed: r.speed, format: r.format });
      expect(synthesized.ok).toBe(true);
      await audio.execute('record', { project, segment_id: s.id, key: attempt.key });
    }
    const exported = await audio.execute('render', { project, format: 'wav' });
    const evidence = inspectVoiceFixture(id, root)!; evidence.speech = provider!.snapshot();
    expect(evidence).toMatchObject({ decoded: true, contentMatched: true, recordingsPreserved: true, narrationSubtitles: true, speech: { fulfilled: true, requests: id === 'voice-narration-create' ? 2 : 1 } });
    const calls = [{ name: 'bash', isError: false }, ...provider!.requests.map(() => ({ name: 'generate_speech', isError: false }))];
    expect(voiceChecks(id, { voiceStudio: evidence, toolCalls: calls } as any).every(c => c.pass)).toBe(true);
    const captions = fs.readFileSync(path.join(root, 'audio', exported.files.find((f: string) => f.endsWith('.srt'))), 'utf8');
    expect(captions).toContain(VOICE_LINES[id === 'voice-revise-text' ? 2 : 1]);
    if (id === 'voice-revise-text') expect(captions).not.toContain('Friday');
    const captionFile = path.join(root, 'audio', exported.files.find((f: string) => f.endsWith('.srt')));
    fs.writeFileSync(captionFile, captions.replace('notebook', 'umbrella'));
    const wrongCaption = inspectVoiceFixture(id, root)!; wrongCaption.speech = provider!.snapshot();
    expect(voiceChecks(id, { voiceStudio: wrongCaption, toolCalls: calls } as any).find(c => c.id === 'acceptance:voice-narration-subtitles')?.pass).toBe(false);
    fs.writeFileSync(captionFile, captions);
    // Replay must fail before another network request; output and old recordings survive.
    await expect(audio.execute('begin', { project, segment_id: 'second' })).rejects.toMatchObject({ code: 'E_ATTEMPT_EXISTS' });
    expect(provider!.snapshot().fulfilled).toBe(true);
    evidence.speech.fulfilled = false;
    expect(voiceChecks(id, { voiceStudio: evidence, toolCalls: calls } as any).every(c => c.pass)).toBe(false);
    if (id === 'voice-narration-create') {
      fs.renameSync(path.join(root, 'audio'), path.join(root, 'narration-topic'));
      seedVoiceFixture(id, root);
      expect(inspectVoiceFixture(id, root)).toMatchObject({ decoded: true, contentMatched: true, narrationPersisted: true, sourcesPreserved: true });
    }
  } finally { await provider?.close(); }
}, 60000);
it.runIf(process.env.ORKAS_REAL_WHISPER_TEST === '1')('transcribes real recorded speech with a separate reference and aligned TXT/SRT/JSON', async () => {
  seedVoiceFixture('voice-transcribe-speech', root);
  const project = path.join(root, 'audio/voice-project.json');
  const exported = await audio.execute('transcribe', { project, input_path: 'sources/meeting.wav', language: 'en' });
  const e = inspectVoiceFixture('voice-transcribe-speech', root)!;
  expect(e.transcript).toMatchObject({ timed: true, sourceMatched: true, consistent: true });
  expect(e.transcript!.wer).toBeLessThanOrEqual(.15);
  expect(e.sourcesPreserved).toBe(true);
  expect(fs.readFileSync(path.join(root, 'audio/sources/meeting.wav'))).toEqual(fs.readFileSync(speechFixtureFile));
}, 60000);
it('calibrates transcript quality against empty/wrong wording and invalid timing/provenance', () => {
  const text = fs.readFileSync(speechFixtureFile.replace('.wav', '.txt'), 'utf8').trim();
  const json = { text, source_sha256: 'source', segments: [{ start_sec: 0, end_sec: 11, text }] };
  const srt = `1\n00:00:00,000 --> 00:00:11,000\n${text}\n`;
  expect(inspectTranscript(json, text, srt, 'source')).toEqual({ wer: 0, timed: true, sourceMatched: true, consistent: true });
  expect(inspectTranscript(json, '', srt, 'source').wer).toBe(1);
  expect(inspectTranscript(json, '由 Orkas 生成\n\n' + text, srt, 'source').consistent).toBe(false);
  expect(inspectTranscript(json, 'a fabricated meeting about sales', srt, 'source').wer).toBeGreaterThan(.15);
  expect(inspectTranscript(json, text, srt.replace('11,000', '01,000'), 'source').timed).toBe(false);
  expect(inspectTranscript(json, text, srt, 'other').sourceMatched).toBe(false);
  expect(wordErrorRate('one two three', 'one four three')).toBeCloseTo(1 / 3);
});
it.runIf(process.env.ORKAS_REAL_WHISPER_TEST === '1')('preserves native VideoStudio wording and segment timing for real point-word recognition', async () => {
  const { transcribeSpeech } = await import('../../../src/main/features/video_studio');
  const transcriptPath = path.join(root, 'video-transcript.json');
  const source = fs.readFileSync(speechFixtureFile);
  const result = await transcribeSpeech({ inputAbsPath: speechFixtureFile, transcriptAbsPath: transcriptPath, language: 'en', timestamps: 'segment' });
  // JFK's 220–220 ms first word now fits before the next word at 330 ms.
  // Segment requests also validate that word view before publishing their JSON.
  expect(result).toMatchObject({ ok: true, transcript_path: transcriptPath });
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  expect(transcript).toMatchObject({ timestamp_detail: 'segment', words: [] });
  expect(transcript).toEqual(result.summary);
  expect(transcript.segments.length).toBeGreaterThan(0);
  for (const segment of transcript.segments) expect(segment.endSec).toBeGreaterThan(segment.startSec);
  const expected = fs.readFileSync(speechFixtureFile.replace('.wav', '.txt'), 'utf8');
  expect(wordErrorRate(expected, transcript.text)).toBeLessThanOrEqual(.15);
  expect(fs.readFileSync(speechFixtureFile)).toEqual(source);
}, 60000);

it.runIf(process.env.ORKAS_REAL_WHISPER_TEST === '1')('transcribes resampled stereo speech with quiet background noise without losing the source', async () => {
  seedVoiceFixture('voice-transcribe-speech', root);
  const file = path.join(root, 'audio/sources/noisy-stereo.wav');
  const env = bundledRuntimeEnv();
  await promisify(execFile)(env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-nostdin', '-i', speechFixtureFile, '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.003:sample_rate=16000:seed=7', '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:normalize=0', '-ar', '44100', '-ac', '2', file], { timeout: 30000 });
  const original = fs.readFileSync(file);
  const result = await audio.execute('transcribe', { project: path.join(root, 'audio/voice-project.json'), input_path: 'sources/noisy-stereo.wav', language: 'en' });
  const text = fs.readFileSync(path.join(root, 'audio', result.files.find((f: string) => f.endsWith('.txt'))), 'utf8');
  expect(wordErrorRate(fs.readFileSync(speechFixtureFile.replace('.wav', '.txt'), 'utf8'), text)).toBeLessThanOrEqual(.15);
  expect(fs.readFileSync(file)).toEqual(original);
}, 60000);
it.each(['voice-revise-text', 'voice-narration-create'])('rejects repeated provider requests and restores the prior route after fixture shutdown: %s', async id => {
  const oldBase = process.env.ORKAS_TTS_BASE_URL, provider = await prepareVoiceProvider(id);
  const target = process.env.ORKAS_TTS_BASE_URL + '/audio/speech';
  const payload = JSON.stringify({ input: VOICE_LINES[id === 'voice-revise-text' ? 2 : 0], voice: 'en_fixture_reader', response_format: 'wav', speed: 1 });
  try {
    expect((await fetch(target, { method: 'POST', body: payload })).status).toBe(200);
    expect(provider!.snapshot().fulfilled).toBe(id === 'voice-revise-text');
    expect((await fetch(target, { method: 'POST', body: payload })).status).toBe(400);
    expect(provider!.snapshot()).toMatchObject({ requests: 2, fulfilled: false });
  } finally { await provider?.close(); }
  expect(process.env.ORKAS_TTS_BASE_URL).toBe(oldBase);
});

// Every shipped semantic scenario must fail closed before an accidental media
// call can reach the real provider; an after-the-fact trace check is too late.
it.each(VOICE_CASE_IDS)('isolates media spending and restores the boundary: %s', async id => {
  const originalFetch = globalThis.fetch;
  try {
  const fallback = vi.fn(async () => new Response('model-transport'));
  globalThis.fetch = fallback as typeof fetch;
  const provider = await prepareVoiceProvider(id);
  expect(provider).toBeDefined();
  try {
    for (const input of [
      new Request('https://openspeech.bytedance.com/api/v1/tts', { method: 'POST' }),
      new URL('https://open.volcengineapi.com/?Action=GenBGMForTime'),
      'https://provider.invalid/v1/audio/speech',
    ]) await expect(fetch(input)).rejects.toThrow();
    expect(fallback).not.toHaveBeenCalled();
    expect(provider!.snapshot().fulfilled).toBe(false);
    expect(await (await fetch('https://chatgpt.com/backend-api/codex/responses')).text()).toBe('model-transport');
    expect(fallback).toHaveBeenCalledTimes(1);
  } finally { await provider?.close(); }
  expect(globalThis.fetch).toBe(fallback);
  } finally { globalThis.fetch = originalFetch; }
});

it('leaves unrelated native scenarios untouched', async () => {
  const originalFetch = globalThis.fetch;
  expect(await prepareVoiceProvider('unrelated-agent-case')).toBeUndefined();
  expect(globalThis.fetch).toBe(originalFetch);
});
