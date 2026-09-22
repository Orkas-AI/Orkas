import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { bundledRuntimeEnv } from '../../../src/main/util/bundled-runtime';

const require = createRequire(import.meta.url);
const audio = require('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/audio.js');
let root: string;
let project: string;
let priorEnv: NodeJS.ProcessEnv;

function tone(seconds: number, hz = 440) {
  const samples = Math.round(seconds * 48000), data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(48000, 24); data.writeUInt32LE(96000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(3000 * Math.sin(i * hz * 2 * Math.PI / 48000)), 44 + i * 2);
  return data;
}
function speechPlan() {
  return { schema_version: 1, roles: { narrator: { route_ref: 'test-route', voice_ref: 'test-voice', language: 'en', speed: 1 } },
    segments: [{ id: 'first', role: 'narrator', text: 'First line.' }, { id: 'second', role: 'narrator', text: 'Second line.' }] };
}
const save = (plan: unknown) => fs.writeFile(project, JSON.stringify(plan));
const call = (op: string, fields = {}) => audio.execute(op, { project, ...fields });

beforeEach(async () => {
  priorEnv = { ...process.env };
  Object.assign(process.env, bundledRuntimeEnv());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-core-')));
  project = path.join(root, 'voice-project.json');
});
afterEach(async () => { process.env = priorEnv; await fs.rm(root, { recursive: true, force: true }); });

describe('VoiceStudio audio project journeys', () => {
  it.each([null, [], {}, { schema_version: 1, segments: [] }, { project: 42 }, { project: '' }].map(request => ({ request })))('reports an invalid request as an input problem without touching the saved project: $request', async ({ request }) => {
    await save({ schema_version: 1, roles: {}, segments: [] });
    const before = await fs.readFile(project);
    const requestFile = path.join(root, 'request.json');
    await fs.writeFile(requestFile, JSON.stringify(request));
    const result = await audio.default({ args: ['status', requestFile] });
    expect(result).toMatchObject({ ok: false, code: 'E_INPUT', message: expect.stringContaining('project') });
    expect(result.message).not.toContain(root);
    expect(await fs.readFile(project)).toEqual(before);
    expect((await fs.readdir(root)).sort()).toEqual(['request.json', 'voice-project.json']);
    // Correct the request, preserving the user's project instead of recreating it.
    await fs.writeFile(requestFile, JSON.stringify({ project }));
    expect(await audio.default({ args: ['status', requestFile] })).toEqual({ ok: true, segments: [] });
    expect(await fs.readFile(project)).toEqual(before);
  });

  it('preserves completed speech, blocks uncertain replay, and invalidates only changed speech', async () => {
    const plan = speechPlan(); await save(plan);
    const attempt = await call('begin', { segment_id: 'first' });
    expect(attempt.request).toMatchObject({ text: 'First line.', voice_ref: 'test-voice', format: 'wav' });
    // Interrupted before receipt: a new process/turn cannot create a duplicate attempt.
    await expect(call('begin', { segment_id: 'first' })).rejects.toMatchObject({ code: 'E_ATTEMPT_EXISTS' });
    expect((await call('status')).segments[0].status).toBe('uncertain');
    // The provider completed its file before interruption; recover it without synthesis.
    await fs.writeFile(attempt.request.output_path, tone(1));
    await call('record', { segment_id: 'first', key: attempt.key });
    expect((await call('status')).segments.map((s: any) => s.status)).toEqual(['ready', 'pending']);
    (plan.segments[0] as any).gap_after_sec = 0.4;
    plan.segments[1].text = 'Revised second line.';
    await save(plan);
    expect((await call('status')).segments.map((s: any) => s.status)).toEqual(['ready', 'pending']);
    expect((await call('status')).segments[0].key).toBe(attempt.key);
    await fs.writeFile(attempt.request.output_path, tone(0.5));
    expect((await call('status')).segments[0].status).toBe('stale');
    await expect(call('render')).rejects.toMatchObject({ code: 'E_NOT_READY' });
  });

  it('makes a decodable cut/concatenation/music export and preserves sources and previous candidates', async () => {
    const source = tone(2), music = tone(0.4, 220);
    await fs.writeFile(path.join(root, 'source.wav'), source);
    await fs.writeFile(path.join(root, 'music.wav'), music);
    const plan = { schema_version: 1, segments: [
      { id: 'cut', path: 'source.wav', start_sec: 0.5, end_sec: 1.5, gap_after_sec: 0.2, fade_in_sec: 0.1 },
      { id: 'fast', path: 'source.wav', speed: 2, fade_out_sec: 0.1, denoise: true },
    ], music: { path: 'music.wav', volume: 0.1 } };
    await save(plan);
    const first = await call('render', { format: 'wav' });
    expect(first.duration_sec).toBeCloseTo(2.2, 1);
    const bytes = await fs.readFile(path.join(root, first.files[0]));
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(first.files.some((f: string) => f.endsWith('.srt'))).toBe(false);
    const second = await call('render', { format: 'mp3' });
    expect(second.duration_sec).toBeCloseTo(2.2, 1);
    expect(second.files[0]).not.toBe(first.files[0]);
    expect(await fs.readFile(path.join(root, first.files[0]))).toEqual(bytes);
    expect(await fs.readFile(path.join(root, 'source.wav'))).toEqual(source);
    const receipt = JSON.parse(await fs.readFile(path.join(root, second.files.find((f: string) => f.endsWith('receipt.json'))), 'utf8'));
    expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
    plan.segments[0].end_sec = 5; await save(plan);
    await expect(call('render')).rejects.toMatchObject({ code: 'E_TRIM' });
    expect((await fs.readdir(root)).some(f => f.startsWith('.voice-render-'))).toBe(false);
    expect(await fs.readFile(path.join(root, first.files[0]))).toEqual(bytes);
  }, 60000);

  it('records a receipt through a project directory alias and reuses its canonical relative path after reload', async () => {
    const aliases = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-alias-'));
    try {
      const alias = path.join(aliases, 'project');
      await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const plan = speechPlan(); plan.segments = plan.segments.slice(0, 1); await save(plan);
      const attempt = await call('begin', { segment_id: 'first' });
      const source = tone(.6);
      await fs.writeFile(attempt.request.output_path, source);
      const receiptPath = path.join(alias, path.basename(attempt.request.output_path));
      expect((await call('probe', { input_path: receiptPath })).duration_sec).toBeCloseTo(.6, 2);
      await call('record', { segment_id: 'first', key: attempt.key, output_path: receiptPath });
      const state = JSON.parse(await fs.readFile(path.join(root, '.voice-state.json'), 'utf8'));
      expect(state.attempts[attempt.key].path).toBe(path.basename(attempt.request.output_path));
      expect((await audio.execute('status', { project: path.join(alias, 'voice-project.json') })).segments[0].status).toBe('ready');
      await expect(call('begin', { segment_id: 'first' })).rejects.toMatchObject({ code: 'E_ATTEMPT_EXISTS' });
      const exported = await call('render', { format: 'wav' });
      expect(exported.duration_sec).toBeCloseTo(.6, 1);
      expect(await fs.readFile(attempt.request.output_path)).toEqual(source);
      expect(await fs.readFile(project, 'utf8')).toBe(JSON.stringify(plan));
    } finally { await fs.rm(aliases, { recursive: true, force: true }); }
  });

  it('rejects an escaped receipt and a directory alias without changing the uncertain attempt, then recovers a valid receipt', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-receipt-outside-'));
    try {
      await save(speechPlan());
      const attempt = await call('begin', { segment_id: 'first' });
      const before = await fs.readFile(path.join(root, '.voice-state.json'));
      const source = tone(.5); await fs.writeFile(path.join(outside, 'source.wav'), source);
      await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      await fs.symlink(root, path.join(root, 'self'), process.platform === 'win32' ? 'junction' : 'dir');
      for (const output_path of [path.join(outside, 'source.wav'), 'escape/source.wav', 'self']) {
        await expect(call('record', { segment_id: 'first', key: attempt.key, output_path })).rejects.toMatchObject({ code: 'E_PATH' });
        expect(await fs.readFile(path.join(root, '.voice-state.json'))).toEqual(before);
        expect((await fs.readdir(root))).not.toContain('.voice-lock');
      }
      expect(await fs.readFile(path.join(outside, 'source.wav'))).toEqual(source);
      await fs.writeFile(attempt.request.output_path, source);
      await call('record', { segment_id: 'first', key: attempt.key });
      expect((await call('status')).segments[0].status).toBe('ready');
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it('rejects outside-project and symlink media before rendering or changing files', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'source.wav'), tone(1));
      await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      await save({ schema_version: 1, segments: [{ id: 'bad', path: 'escape/source.wav' }] });
      await expect(call('render')).rejects.toMatchObject({ code: 'E_PATH' });
      await save({ schema_version: 1, segments: [{ id: 'bad', path: path.join(outside, 'source.wav') }] });
      await expect(call('render')).rejects.toMatchObject({ code: 'E_PATH' });
      expect(await fs.readFile(path.join(outside, 'source.wav'))).toEqual(tone(1));
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it('reports missing bundled runtime without starting installation or producing an export', async () => {
    delete process.env.ORKAS_BUNDLED_FFMPEG;
    const preflight = await audio.execute('preflight', {});
    expect(preflight.ok).toBe(false);
    expect(preflight.ready.ORKAS_BUNDLED_FFMPEG).toBe(false);
    await fs.writeFile(path.join(root, 'source.wav'), tone(1));
    await save({ schema_version: 1, segments: [{ id: 'clip', path: 'source.wav' }] });
    await expect(call('render')).rejects.toMatchObject({ code: 'E_RUNTIME_MISSING' });
    expect((await fs.readdir(root)).filter(f => f.startsWith('export-'))).toEqual([]);
  });

  it('rejects a busy project and cancellation without losing its completed state', async () => {
    await save(speechPlan());
    await fs.writeFile(path.join(root, '.voice-lock'), 'existing task');
    await expect(call('begin', { segment_id: 'first' })).rejects.toMatchObject({ code: 'E_BUSY' });
    expect(await fs.readFile(path.join(root, '.voice-lock'), 'utf8')).toBe('existing task');
    await fs.rm(path.join(root, '.voice-lock'));
    await fs.writeFile(path.join(root, 'source.wav'), tone(1));
    await save({ schema_version: 1, segments: [{ id: 'clip', path: 'source.wav' }] });
    const controller = new AbortController(); controller.abort();
    await expect(audio.execute('render', { project }, controller.signal)).rejects.toMatchObject({ code: 'E_CANCELLED' });
    expect((await fs.readdir(root)).filter(f => f.startsWith('export-') || f === '.voice-lock')).toEqual([]);
    expect(await fs.readFile(path.join(root, 'source.wav'))).toEqual(tone(1));
  });

  it('converts real Whisper offset shape to timed text and rejects malformed timing', () => {
    const segments = audio.whisperSegments({ transcription: [
      { offsets: { from: 1200, to: 2500 }, text: ' Hello.' },
      { offsets: { from: 3000, to: 4200 }, text: 'World.' },
    ] });
    expect(audio.subtitles(segments)).toBe('1\n00:00:01,200 --> 00:00:02,500\nHello.\n\n2\n00:00:03,000 --> 00:00:04,200\nWorld.\n');
    expect(() => audio.whisperSegments({ transcription: [{ text: 'missing timing' }] })).toThrow('invalid segment timing');
  });

  it('runs the bundled transcription pipeline and saves a readable result without fetching dependencies', async () => {
    await fs.writeFile(path.join(root, 'silence.wav'), Buffer.from(tone(1).map((b, i) => i < 44 ? b : 0)));
    await save({ schema_version: 1, segments: [] });
    const result = await call('transcribe', { input_path: 'silence.wav', language: 'en' });
    expect(result.ok).toBe(true);
    const file = result.files.find((f: string) => f.endsWith('.json'));
    const transcript = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
    expect(transcript.schema_version).toBe(1);
    expect(Array.isArray(transcript.segments)).toBe(true);
    expect(transcript.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    const dir = path.dirname(path.join(root, file));
    const textFile = result.files.find((f: string) => f.endsWith('.txt'));
    const declaration = JSON.parse(await fs.readFile(path.join(dir, '.orkas-output-types.json'), 'utf8'));
    expect(declaration).toEqual({ schema_version: 1, outputs: [{
      path: path.basename(textFile), content_type: 'audio-text',
      sha256: createHash('sha256').update(await fs.readFile(path.join(root, textFile))).digest('hex'),
    }] });
    expect((await fs.readdir(dir)).sort()).toEqual(['.orkas-output-types.json', 'transcript.json', 'transcript.srt', 'transcript.txt']);
  }, 60000);
});

describe('VoiceStudio revision and caption scenarios', () => {
  it.each(['voice_ref', 'route_ref', 'language', 'speed'])('invalidates a changed role %s and rejects recording an obsolete request', async field => {
    const plan = speechPlan(); await save(plan);
    const first = await call('begin', { segment_id: 'first' });
    await fs.writeFile(first.request.output_path, tone(1));
    await call('record', { segment_id: 'first', key: first.key });
    (plan.roles.narrator as any)[field] = field === 'speed' ? 1.2 : 'changed'; await save(plan);
    expect((await call('status')).segments[0]).toMatchObject({ status: 'pending' });
    await expect(call('record', { segment_id: 'first', key: first.key })).rejects.toMatchObject({ code: 'E_STALE' });
    expect(await fs.readFile(first.request.output_path)).toEqual(tone(1));
  });
  it('gives different roles separate voice requests while repeated text in the same role shares a recording', async () => {
    const plan: any = speechPlan();
    plan.roles.guest = { ...plan.roles.narrator, voice_ref: 'guest-voice' };
    plan.segments[1].text = plan.segments[0].text; plan.segments[1].role = 'guest'; await save(plan);
    const first = await call('begin', { segment_id: 'first' }), second = await call('begin', { segment_id: 'second' });
    expect(first.key).not.toBe(second.key); expect(second.request.voice_ref).toBe('guest-voice');
    plan.segments[1].role = 'narrator'; await save(plan);
    expect((await call('status')).segments.map((s: any) => s.key)).toEqual([first.key, first.key]);
    await expect(call('begin', { segment_id: 'second' })).rejects.toMatchObject({ code: 'E_ATTEMPT_EXISTS' });
  });
  it('exports timed segment captions after local speed edits and omits misleading captions after a cut', async () => {
    const plan: any = speechPlan(); plan.segments[0].gap_after_sec = .2; plan.segments[1].speed = .5; await save(plan);
    for (const segment_id of ['first', 'second']) {
      const a = await call('begin', { segment_id }); await fs.writeFile(a.request.output_path, tone(1));
      await call('record', { segment_id, key: a.key });
    }
    const result = await call('render', { format: 'wav' });
    const subtitle = result.files.find((f: string) => f.endsWith('.srt'));
    expect(await fs.readFile(path.join(root, subtitle), 'utf8')).toBe('1\n00:00:00,000 --> 00:00:01,000\nFirst line.\n\n2\n00:00:01,200 --> 00:00:03,200\nSecond line.\n');
    plan.segments[0].start_sec = .2; await save(plan);
    const cut = await call('render', { format: 'wav' });
    expect(cut.captions_complete).toBe(false); expect(cut.files.some((f: string) => f.endsWith('.srt'))).toBe(false);
    expect(await fs.readFile(path.join(root, subtitle), 'utf8')).toContain('First line.');
  }, 60000);
  it.each([
    { speed: 0 }, { speed: 2.1 }, { volume: -1 }, { gap_after_sec: 61 }, { start_sec: 2, end_sec: 1 }, { fade_in_sec: -1 }, { denoise: 'yes' },
  ])('rejects invalid editing parameters before mutating a project: %j', async change => {
    await fs.writeFile(path.join(root, 'source.wav'), tone(1));
    await save({ schema_version: 1, segments: [{ id: 'first', path: 'source.wav', ...change }] });
    const before = await fs.readFile(project);
    await expect(call('render')).rejects.toMatchObject({ code: 'denoise' in change || 'end_sec' in change ? 'E_PLAN' : 'E_INPUT' });
    expect(await fs.readFile(project)).toEqual(before);
    expect((await fs.readdir(root)).some(f => f.startsWith('export-') || f === '.voice-lock')).toBe(false);
  });
  it('leaves an interrupted synthesis uncertain when its file is missing or corrupt', async () => {
    await save(speechPlan()); const a = await call('begin', { segment_id: 'first' });
    await expect(call('record', { segment_id: 'first', key: a.key })).rejects.toBeDefined();
    await fs.writeFile(a.request.output_path, 'not an audio file');
    await expect(call('record', { segment_id: 'first', key: a.key })).rejects.toMatchObject({ code: 'E_PROCESS' });
    expect((await call('status')).segments[0].status).toBe('uncertain');
    await expect(call('begin', { segment_id: 'first' })).rejects.toMatchObject({ code: 'E_ATTEMPT_EXISTS' });
  });
});

describe('VoiceStudio size and active cancellation boundaries', () => {
  it('accepts a 200-segment saved chapter, rejects 201 without mutation, and renders a 32-segment sequence', async () => {
    await fs.writeFile(path.join(root, 'source.wav'), tone(.1));
    const plan = { schema_version: 1, segments: Array.from({ length: 200 }, (_, i) => ({ id: `line_${i}`, path: 'source.wav' })) };
    await save(plan);
    expect((await call('status')).segments).toHaveLength(200);
    plan.segments.push({ id: 'overflow', path: 'source.wav' }); await save(plan);
    await expect(call('render')).rejects.toMatchObject({ code: 'E_PLAN' });
    expect((await fs.readdir(root)).some(f => f.startsWith('export-'))).toBe(false);
    plan.segments.length = 32; await save(plan);
    const start = Date.now(), result = await call('render', { format: 'wav' });
    expect(result.duration_sec).toBeCloseTo(3.2, 1);
    expect(Date.now() - start).toBeLessThan(60000);
    expect(await fs.readFile(path.join(root, 'source.wav'))).toEqual(tone(.1));
  }, 60000);
  it('cancels an active render, removes only its unfinished candidate, and can render again', async () => {
    await fs.writeFile(path.join(root, 'source.wav'), tone(1));
    await save({ schema_version: 1, segments: Array.from({ length: 20 }, (_, i) => ({ id: `part_${i}`, path: 'source.wav' })) });
    const controller = new AbortController();
    const pending = audio.execute('render', { project }, controller.signal).then(() => null, (e: any) => e);
    let started = false;
    for (let i = 0; i < 200; i++) {
      if ((await fs.readdir(root)).some(f => f.startsWith('.voice-render-'))) { started = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort(); const error = await pending;
    expect(started).toBe(true); expect(error?.code).toBe('E_CANCELLED');
    expect((await fs.readdir(root)).some(f => f === '.voice-lock' || f.startsWith('.voice-render-') || f.startsWith('export-'))).toBe(false);
    expect(await fs.readFile(path.join(root, 'source.wav'))).toEqual(tone(1));
    await save({ schema_version: 1, segments: [{ id: 'retained', path: 'source.wav' }] });
    expect((await call('render', { format: 'wav' })).ok).toBe(true);
  }, 60000);
});
