import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  it.each([['--help'], ['status', '--help']].map(args => ({ args })))('offers read-only invocation help without a project or codec: $args', async ({ args }) => {
    delete process.env.ORKAS_BUNDLED_FFMPEG; delete process.env.ORKAS_BUNDLED_FFPROBE;
    const result = await audio.default({ args });
    expect(result).toMatchObject({ ok: true, operations: expect.arrayContaining(['preflight', 'probe', 'status', 'render', 'convert']) });
    expect(result.usage).toContain('audio --');
    expect(result.request).toContain('project');
    expect(await fs.readdir(root)).toEqual([]);
  });
  it.each([
    [], ['render'], ['render', 'missing.json', 'extra'], ['preflight', 'unused.json'],
    ['status', '--help', 'extra'],
  ].map(args => ({ args })))('rejects malformed argument counts before reading files or changing project state: $args', async ({ args }) => {
    await save(speechPlan()); const before = await fs.readFile(project);
    const result = await audio.default({ args });
    expect(result).toMatchObject({ ok: false, code: 'E_USAGE', message: expect.stringContaining('audio --') });
    expect(await fs.readFile(project)).toEqual(before);
    expect(await fs.readdir(root)).toEqual(['voice-project.json']);
  });
  it('rejects unknown or reversed operations before request I/O, including direct module callers', async () => {
    for (const args of [['missing.json'], ['missing.json', 'render'], ['bogus', 'missing.json']]) {
      expect(await audio.default({ args })).toMatchObject({ ok: false, code: 'E_OPERATION', message: expect.stringContaining('audio --') });
    }
    await expect(audio.execute('bogus', {})).rejects.toMatchObject({ code: 'E_OPERATION' });
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('distinguishes a missing or malformed request from a project problem and permits a corrected invocation', async () => {
    await save({ schema_version: 1, roles: {}, segments: [] }); const before = await fs.readFile(project);
    const requestFile = path.join(root, 'request.json');
    expect(await audio.default({ args: ['status', requestFile] })).toMatchObject({ ok: false, code: 'E_REQUEST', message: expect.stringContaining('request JSON') });
    await fs.writeFile(requestFile, '{');
    expect(await audio.default({ args: ['status', requestFile] })).toMatchObject({ ok: false, code: 'E_REQUEST', message: expect.stringContaining('valid JSON') });
    await fs.writeFile(requestFile, JSON.stringify({ project }));
    expect(await audio.default({ args: ['status', requestFile] })).toEqual({ ok: true, segments: [] });
    expect(await fs.readFile(project)).toEqual(before);
    expect((await fs.readdir(root)).sort()).toEqual(['request.json', 'voice-project.json']);
  });
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

  it.runIf(process.env.ORKAS_REAL_WHISPER_TEST === '1')('keeps native silence recognition readable without publishing invalid timing or fetching dependencies', async () => {
    const source = Buffer.from(tone(1).map((b, i) => i < 44 ? b : 0));
    await fs.writeFile(path.join(root, 'silence.wav'), source);
    await save({ schema_version: 1, segments: [] });
    const result = await call('transcribe', { input_path: 'silence.wav', language: 'en' });
    expect(result.absolute_files).toEqual(result.files.map((file: string) => path.join(root, file)));
    const textFile = result.files.find((f: string) => f.endsWith('.txt'));
    const dir = path.dirname(path.join(root, textFile));
    const declaration = JSON.parse(await fs.readFile(path.join(dir, '.orkas-output-types.json'), 'utf8'));
    expect(declaration).toEqual({ schema_version: 1, outputs: [{
      path: path.basename(textFile), content_type: 'audio-text',
      sha256: createHash('sha256').update(await fs.readFile(path.join(root, textFile))).digest('hex'),
    }] });
    expect(await fs.readFile(path.join(root, 'silence.wav'))).toEqual(source);
    // Recognition of silence is not promised to be empty. A recognizer may
    // emit an out-of-range silence marker; that is recoverable TXT, not SRT.
    if (!result.ok) {
      expect(result.code).toBe('E_TRANSCRIPT');
      expect((await fs.readFile(path.join(root, textFile), 'utf8')).trim()).not.toBe('');
      expect((await fs.readdir(dir)).sort()).toEqual(['.orkas-output-types.json', 'transcript.txt']);
    } else {
      const file = result.files.find((f: string) => f.endsWith('.json'));
      const transcript = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
      expect(transcript.schema_version).toBe(1);
      expect(Array.isArray(transcript.segments)).toBe(true);
      expect(transcript.source_sha256).toBe(createHash('sha256').update(source).digest('hex'));
      let previous = 0;
      for (const s of transcript.segments) {
        expect(s.start_sec).toBeGreaterThanOrEqual(previous);
        expect(s.end_sec).toBeGreaterThan(s.start_sec);
        expect(s.end_sec).toBeLessThanOrEqual(1.001);
        previous = s.end_sec;
      }
      expect((await fs.readdir(dir)).sort()).toEqual(['.orkas-output-types.json', 'transcript.json', 'transcript.srt', 'transcript.txt']);
    }
  }, 60000);
});

describe('VoiceStudio explicit recording recovery', () => {
  async function interrupted() {
    const plan = speechPlan(); plan.segments = plan.segments.slice(0, 1);
    await save(plan);
    const attempt = await call('begin', { segment_id: 'first' });
    await fs.writeFile(attempt.request.output_path, tone(.6));
    return { plan, attempt };
  }
  it('prepares a reusable request without copying the key, changing state or repeating synthesis', async () => {
    const { plan, attempt } = await interrupted();
    const before = await fs.readFile(path.join(root, '.voice-state.json'));
    const prepared = await call('prepare-record', { segment_id: 'first' });
    expect(prepared).toMatchObject({ ok: true, operation: 'record', request_file: expect.any(String) });
    expect(JSON.parse(await fs.readFile(prepared.request_file, 'utf8'))).toEqual({
      project, segment_id: 'first', key: attempt.key, output_path: path.basename(attempt.request.output_path),
    });
    expect(await fs.readFile(path.join(root, '.voice-state.json'))).toEqual(before);
    expect(await fs.readFile(project, 'utf8')).toBe(JSON.stringify(plan));
    expect(await fs.readFile(attempt.request.output_path)).toEqual(tone(.6));
    const files = (await fs.readdir(root)).sort();
    expect(await call('prepare-record', { segment_id: 'first' })).toEqual(prepared);
    expect((await fs.readdir(root)).sort()).toEqual(files);
    delete process.env.ORKAS_BUNDLED_FFMPEG;
    // Local edit settings may change without changing the speech identity.
    (plan.segments[0] as any).gap_after_sec = .2; await save(plan);
    expect(await audio.default({ args: ['record', prepared.request_file] })).toMatchObject({ ok: true, key: attempt.key });
    expect((await call('status')).segments[0].status).toBe('ready');
    await expect(call('begin', { segment_id: 'first' })).rejects.toMatchObject({ code: 'E_ATTEMPT_EXISTS' });
  });
  it.each(['text', 'take', 'voice_ref'])('rejects a prepared request after changing %s, preserving both attempts', async field => {
    const { plan, attempt } = await interrupted();
    const prepared = await call('prepare-record', { segment_id: 'first' });
    if (field === 'voice_ref') plan.roles.narrator.voice_ref = 'changed';
    else (plan.segments[0] as any)[field] = field === 'take' ? 1 : 'Changed words.';
    await save(plan);
    const next = await call('begin', { segment_id: 'first' });
    await fs.writeFile(next.request.output_path, tone(.4, 660));
    const before = await fs.readFile(path.join(root, '.voice-state.json'));
    expect(await audio.default({ args: ['record', prepared.request_file] })).toMatchObject({ ok: false, code: 'E_STALE' });
    expect(await fs.readFile(path.join(root, '.voice-state.json'))).toEqual(before);
    expect(await fs.readFile(attempt.request.output_path)).toEqual(tone(.6));
    expect(await fs.readFile(next.request.output_path)).toEqual(tone(.4, 660));
    const current = await call('prepare-record', { segment_id: 'first' });
    expect(current.request_file).not.toBe(prepared.request_file);
    expect(await audio.default({ args: ['record', current.request_file] })).toMatchObject({ ok: true, key: next.key });
  });
  it('uses an explicitly supplied renamed receipt while retaining the original destination', async () => {
    const { attempt } = await interrupted();
    const renamed = path.join(root, 'renamed.wav'); await fs.rename(attempt.request.output_path, renamed);
    const prepared = await call('prepare-record', { segment_id: 'first', output_path: renamed });
    expect(JSON.parse(await fs.readFile(prepared.request_file, 'utf8')).output_path).toBe('renamed.wav');
    expect((await call('status')).segments[0].status).toBe('uncertain');
    expect(await audio.default({ args: ['record', prepared.request_file] })).toMatchObject({ ok: true, key: attempt.key });
    expect((await call('status')).segments[0]).toMatchObject({ status: 'ready', path: 'renamed.wav' });
  });
  it('never overwrites an altered prepared request or falsely repairs completed audio', async () => {
    const { attempt } = await interrupted();
    const prepared = await call('prepare-record', { segment_id: 'first' });
    const before = await fs.readFile(path.join(root, '.voice-state.json'));
    const changed = JSON.stringify({ project, segment_id: 'first', key: 'wrong' });
    await fs.writeFile(prepared.request_file, changed);
    await expect(call('prepare-record', { segment_id: 'first' })).rejects.toMatchObject({ code: 'E_REQUEST_CONFLICT' });
    expect(await fs.readFile(prepared.request_file, 'utf8')).toBe(changed);
    expect(await fs.readFile(path.join(root, '.voice-state.json'))).toEqual(before);
    await call('record', { segment_id: 'first', key: attempt.key });
    await fs.writeFile(attempt.request.output_path, tone(.2));
    await expect(call('prepare-record', { segment_id: 'first' })).rejects.toMatchObject({ code: 'E_ATTEMPT_STATE' });
    expect((await call('status')).segments[0].status).toBe('stale');
  });
  it('rejects absent attempts, missing files, cancellation and busy projects without preparing or promoting audio', async () => {
    await save(speechPlan());
    await expect(call('prepare-record', { segment_id: 'first' })).rejects.toMatchObject({ code: 'E_ATTEMPT_STATE' });
    const attempt = await call('begin', { segment_id: 'first' });
    const before = await fs.readFile(path.join(root, '.voice-state.json'));
    await expect(call('prepare-record', { segment_id: 'first' })).rejects.toMatchObject({ code: 'E_SOURCE_NOT_FOUND' });
    await fs.writeFile(attempt.request.output_path, tone(.6));
    const controller = new AbortController(); controller.abort();
    await expect(audio.execute('prepare-record', { project, segment_id: 'first' }, controller.signal)).rejects.toMatchObject({ code: 'E_CANCELLED' });
    await fs.writeFile(path.join(root, '.voice-lock'), 'busy');
    await expect(call('prepare-record', { segment_id: 'first' })).rejects.toMatchObject({ code: 'E_BUSY' });
    expect(await fs.readFile(path.join(root, '.voice-lock'), 'utf8')).toBe('busy');
    await fs.rm(path.join(root, '.voice-lock'));
    expect((await fs.readdir(root)).filter(f => f.startsWith('record-'))).toEqual([]);
    expect(await fs.readFile(path.join(root, '.voice-state.json'))).toEqual(before);
  });
  it('rejects escaped and non-file recovery receipts without changing state or external files', async () => {
    await interrupted();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-prepare-outside-'));
    try {
      const source = path.join(outside, 'voice.wav'); await fs.writeFile(source, tone(.3));
      await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      await fs.mkdir(path.join(root, 'directory'));
      const before = await fs.readFile(path.join(root, '.voice-state.json'));
      for (const output_path of [source, 'escape/voice.wav', 'directory']) {
        await expect(call('prepare-record', { segment_id: 'first', output_path })).rejects.toMatchObject({ code: 'E_PATH' });
      }
      expect(await fs.readFile(source)).toEqual(tone(.3));
      expect(await fs.readFile(path.join(root, '.voice-state.json'))).toEqual(before);
      expect((await fs.readdir(root)).filter(f => f.startsWith('record-') || f === '.voice-lock')).toEqual([]);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
});

describe('VoiceStudio source request diagnostics', () => {
  it.each(['probe', 'transcribe', 'convert', 'extract'])('identifies a missing input_path for %s and accepts either corrected path representation', async op => {
    await save({ schema_version: 1, roles: {}, segments: [] });
    const before = await fs.readFile(project);
    const requestFile = path.join(root, 'request.json');
    const fields = { project, input_path: 'missing.wav', format: 'wav' };
    await fs.writeFile(requestFile, JSON.stringify(fields));
    expect(await audio.default({ args: [op, requestFile] })).toMatchObject({
      ok: false, code: 'E_SOURCE_NOT_FOUND', message: expect.stringContaining('input_path'),
    });
    const failed = await audio.default({ args: [op, requestFile] });
    expect(failed.message).not.toContain(root);
    expect((await fs.readdir(root)).sort()).toEqual(['request.json', 'voice-project.json']);
    const source = path.join(root, 'source.wav'); await fs.writeFile(source, tone(.6));
    // Transcription's native ASR execution is already covered separately;
    // probe verifies the common resolver without introducing a model here.
    for (const input_path of ['source.wav', source]) {
      const result = await call(op === 'transcribe' ? 'probe' : op, { input_path, format: 'wav' });
      expect(result).toMatchObject({ ok: true, duration_sec: .6 });
    }
    expect(await fs.readFile(project)).toEqual(before);
    expect(await fs.readFile(source)).toEqual(tone(.6));
  });
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

// Real decoding and source duration; only recognition output is controlled.
// These cases protect delivered files and explicit recovery, not ASR accuracy.
describe.skipIf(process.platform === 'win32')('VoiceStudio transcript timing publication', () => {
  async function recognize(transcription: unknown[], action = '') {
    const output = path.join(root, 'recognition.json');
    await fs.writeFile(output, JSON.stringify({ transcription }));
    const cli = path.join(root, 'whisper');
    await fs.writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'recognition-calls'), '1');
fs.copyFileSync(args[args.indexOf('-f') + 1], path.join(__dirname, 'recognized-input.wav'));
${action}
fs.copyFileSync(path.join(__dirname, 'recognition.json'), args[args.indexOf('-of') + 1] + '.json');
`);
    await fs.chmod(cli, 0o755);
    process.env.ORKAS_WHISPER_CPP = cli;
    process.env.ORKAS_WHISPER_MODEL = output;
  }
  const segment = (from: number, to: number, text: string) => ({ offsets: { from, to }, text });
  async function setup() {
    await fs.writeFile(path.join(root, 'source.wav'), tone(2));
    await save({ schema_version: 1, segments: [] });
  }
  // The user owns later source edits. This attempt still delivers the decoded
  // initial recording, and its transcript must never authorize cuts on a new one.
  it.each(['segment', 'word'].flatMap(granularity => ['overwrite', 'replace', 'delete'].map(change => ({ granularity, change }))))(
    'delivers the initial $granularity recording after source $change during recognition', async ({ granularity, change }) => {
      await setup();
      const source = path.join(root, 'source.wav'), original = await fs.readFile(source);
      const replacement = tone(2, 880);
      await fs.writeFile(path.join(root, 'replacement.wav'), replacement);
      await recognize([segment(0, 1000, 'Initial recording.')]);
      const prior = await call('transcribe', { input_path: 'source.wav', granularity });
      const priorBytes = await Promise.all(prior.files.map((f: string) => fs.readFile(path.join(root, f))));
      const actions: Record<string, string> = {
        overwrite: "fs.writeFileSync(path.join(__dirname, 'source.wav'), fs.readFileSync(path.join(__dirname, 'replacement.wav')));",
        replace: "fs.renameSync(path.join(__dirname, 'replacement.wav'), path.join(__dirname, 'source.wav'));",
        delete: "fs.unlinkSync(path.join(__dirname, 'source.wav'));",
      };
      await recognize([segment(0, 1000, 'Initial recording.')], actions[change]);
      const result = await call('transcribe', { input_path: 'source.wav', granularity });
      expect(result.ok).toBe(true);
      const transcriptPath = result.files.find((f: string) => f.endsWith('.json'));
      const transcript = JSON.parse(await fs.readFile(path.join(root, transcriptPath), 'utf8'));
      expect(transcript.source_sha256).toBe(createHash('sha256').update(original).digest('hex'));
      expect(transcript.source_sha256).not.toBe(createHash('sha256').update(replacement).digest('hex'));
      expect(transcript.segments).toEqual([{ start_sec: 0, end_sec: 1, text: 'Initial recording.' }]);
      expect(await fs.readFile(path.join(root, result.files.find((f: string) => f.endsWith('.srt'))), 'utf8'))
        .toBe('1\n00:00:00,000 --> 00:00:01,000\nInitial recording.\n');
      const observed = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-nostdin', '-i',
        path.join(root, 'recognized-input.wav'), '-f', 's16le', '-ac', '1', '-ar', '16000', '-'], { timeout: 30000 });
      expect(observed.status).toBe(0); expect(observed.stderr.length).toBe(0);
      expect(observed.stdout.length).toBe(2 * 16000 * 2);
      // An independent frequency oracle distinguishes the two equal-sized sources.
      const energy = (hz: number) => {
        let re = 0, im = 0;
        for (let i = 1600; i < 3200; i++) {
          const sample = observed.stdout.readInt16LE(i * 2);
          re += sample * Math.cos(2 * Math.PI * hz * i / 16000);
          im += sample * Math.sin(2 * Math.PI * hz * i / 16000);
        }
        return Math.hypot(re, im) / 1600;
      };
      expect(energy(440)).toBeGreaterThan(1000); expect(energy(880)).toBeLessThan(5);
      expect(await fs.readFile(path.join(root, 'recognition-calls'), 'utf8')).toBe('11');
      expect(await Promise.all(prior.files.map((f: string) => fs.readFile(path.join(root, f))))).toEqual(priorBytes);
      expect((await fs.readdir(path.dirname(path.join(root, transcriptPath)))).sort())
        .toEqual(['.orkas-output-types.json', 'transcript.json', 'transcript.srt', 'transcript.txt']);
      if (change === 'delete') await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await fs.readFile(source)).toEqual(replacement);
      if (granularity === 'word') {
        await fs.writeFile(source, replacement);
        await save({ schema_version: 3, segments: [{ id: 'cut', path: 'source.wav', word_edit: {
          transcript_path: transcriptPath, mode: 'keep', ranges: [{ first: 0, last: 0 }] } }],
          export: { format: 'wav', normalize_loudness: false } });
        await expect(call('render')).rejects.toMatchObject({ code: 'E_TRANSCRIPT_STALE' });
        expect((await fs.readdir(root)).some(f => f.startsWith('export-') || f.startsWith('.voice-render-'))).toBe(false);
        await fs.writeFile(source, original);
        expect((await call('render')).duration_sec).toBe(1);
      }
    });

  it.each(['segment', 'word'])('rejects an unstable %s input during preparation before ASR and permits explicit retry', async granularity => {
    await setup();
    const source = path.join(root, 'source.wav');
    await fs.writeFile(path.join(root, 'replacement.wav'), tone(2, 880));
    await recognize([segment(0, 1000, 'Prepared recording.')]);
    const ffmpeg = process.env.ORKAS_BUNDLED_FFMPEG!;
    const wrapper = path.join(root, 'ffmpeg-wrapper');
    await fs.writeFile(wrapper, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const result = spawnSync(${JSON.stringify(ffmpeg)}, process.argv.slice(2), { stdio: 'inherit' });
if (result.status === 0) fs.copyFileSync(path.join(__dirname, 'replacement.wav'), path.join(__dirname, 'source.wav'));
process.exit(result.status ?? 1);
`);
    await fs.chmod(wrapper, 0o755); process.env.ORKAS_BUNDLED_FFMPEG = wrapper;
    await expect(call('transcribe', { input_path: 'source.wav', granularity })).rejects.toMatchObject({ code: 'E_TRANSCRIPT_STALE' });
    await expect(fs.stat(path.join(root, 'recognition-calls'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(root)).some(f => f.startsWith('transcript-'))).toBe(false);
    expect(await fs.readFile(source)).toEqual(tone(2, 880));
    process.env.ORKAS_BUNDLED_FFMPEG = ffmpeg;
    const recovered = await call('transcribe', { input_path: 'source.wav', granularity });
    expect(recovered.ok).toBe(true);
    const transcript = JSON.parse(await fs.readFile(path.join(root, recovered.files.find((f: string) => f.endsWith('.json'))), 'utf8'));
    expect(transcript.source_sha256).toBe(createHash('sha256').update(tone(2, 880)).digest('hex'));
    expect(await fs.readFile(path.join(root, 'recognition-calls'), 'utf8')).toBe('1');
  });

  it.each([
    { label: 'past the audio end', rows: [segment(0, 3000, 'Keep all recognized words.')] },
    { label: 'reversed segments', rows: [segment(1000, 1500, 'First.'), segment(0, 500, 'Second.')] },
    { label: 'overlapping segments', rows: [segment(0, 1200, 'First.'), segment(1000, 1800, 'Second.')] },
    { label: 'zero-duration speech', rows: [segment(500, 500, 'Still preserve this.')] },
    { label: 'negative timing', rows: [segment(-100, 500, 'Still preserve this.')] },
    { label: 'missing timing', rows: [{ text: 'Still preserve this.' }] },
    { label: 'null timing', rows: [{ offsets: { from: null, to: 500 }, text: 'Still preserve this.' }] },
    { label: 'boolean timing', rows: [{ offsets: { from: false, to: 500 }, text: 'Still preserve this.' }] },
    { label: 'blank timing', rows: [{ offsets: { from: ' ', to: 500 }, text: 'Still preserve this.' }] },
    { label: 'beyond millisecond precision', rows: [segment(0, 2002, 'Still preserve this.')] },
  ])('preserves text for $label without publishing subtitles or replacing prior results, then recovers', async ({ rows }) => {
    await setup();
    await recognize([segment(0, 2000, 'Prior valid transcript.')]);
    const prior = await call('transcribe', { input_path: 'source.wav' });
    const oldFiles = await Promise.all(prior.files.map((f: string) => fs.readFile(path.join(root, f))));
    await recognize(rows);
    const request = path.join(root, 'request.json');
    await fs.writeFile(request, JSON.stringify({ project, input_path: 'source.wav' }));
    const result = await audio.default({ args: ['transcribe', request] });
    expect(result).toMatchObject({ ok: false, code: 'E_TRANSCRIPT' });
    expect(result.message).not.toContain(root);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatch(/transcript\.txt$/);
    const text = path.join(root, result.files[0]);
    expect(await fs.readFile(text, 'utf8')).toBe(rows.map(s => s.text.trim()).join('\n') + '\n');
    expect((await fs.readdir(path.dirname(text))).sort()).toEqual(['.orkas-output-types.json', 'transcript.txt']);
    const declaration = JSON.parse(await fs.readFile(path.join(path.dirname(text), '.orkas-output-types.json'), 'utf8'));
    expect(declaration.outputs[0]).toMatchObject({ path: 'transcript.txt', content_type: 'audio-text',
      sha256: createHash('sha256').update(await fs.readFile(text)).digest('hex') });
    expect(await fs.readFile(path.join(root, 'recognition-calls'), 'utf8')).toBe('11');
    expect(await fs.readFile(path.join(root, 'source.wav'))).toEqual(tone(2));
    expect(await Promise.all(prior.files.map((f: string) => fs.readFile(path.join(root, f))))).toEqual(oldFiles);
    await recognize([segment(0, 1000, 'First.'), segment(1000, 2000, 'Second.')]);
    const recovered = await call('transcribe', { input_path: 'source.wav' });
    expect(recovered.ok).toBe(true);
    expect(await fs.readFile(path.join(root, recovered.files.find((f: string) => f.endsWith('.srt'))), 'utf8'))
      .toBe('1\n00:00:00,000 --> 00:00:01,000\nFirst.\n\n2\n00:00:01,000 --> 00:00:02,000\nSecond.\n');
    expect(await fs.readFile(text, 'utf8')).toBe(rows.map(s => s.text.trim()).join('\n') + '\n');
  });
  it.each([1999, 2000, 2001])('accepts an end at %i ms within the existing one-millisecond precision allowance', async end => {
    await setup(); await recognize([segment(0, end, 'Unchanged words.')]);
    const result = await call('transcribe', { input_path: 'source.wav' });
    expect(result.ok).toBe(true);
    const transcript = JSON.parse(await fs.readFile(path.join(root, result.files.find((f: string) => f.endsWith('.json'))), 'utf8'));
    expect(transcript.segments).toEqual([{ start_sec: 0, end_sec: end / 1000, text: 'Unchanged words.' }]);
    expect(await fs.readFile(path.join(root, result.files.find((f: string) => f.endsWith('.txt'))), 'utf8')).toBe('Unchanged words.\n');
  });
  it('retains a valid empty transcript for silence', async () => {
    await setup(); await recognize([]);
    const result = await call('transcribe', { input_path: 'source.wav' });
    expect(result).toMatchObject({ ok: true, empty: true, segments: 0 });
    expect(await fs.readFile(path.join(root, result.files.find((f: string) => f.endsWith('.srt'))), 'utf8')).toBe('');
  });
  it('retains numeric offset strings without rewriting recognized words', async () => {
    await setup(); await recognize([{ offsets: { from: '0', to: '2000' }, text: 'Original wording.' }]);
    const result = await call('transcribe', { input_path: 'source.wav' });
    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(root, result.files.find((f: string) => f.endsWith('.txt'))), 'utf8')).toBe('Original wording.\n');
  });
  it('checks the decoded audio end when a video container continues after its audio', async () => {
    await setup();
    const encoded = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-nostdin',
      '-f', 'lavfi', '-i', 'color=size=32x32:duration=4:rate=10', '-i', path.join(root, 'source.wav'),
      '-c:v', 'mpeg4', '-c:a', 'aac', path.join(root, 'long-video.mp4')], { encoding: 'utf8', timeout: 30000 });
    expect(encoded.status).toBe(0); expect(encoded.stderr).toBe('');
    expect((await call('probe', { input_path: 'long-video.mp4' })).duration_sec).toBe(4);
    await recognize([segment(0, 3000, 'Do not extend into the silent picture.')]);
    const result = await call('transcribe', { input_path: 'long-video.mp4' });
    expect(result).toMatchObject({ ok: false, code: 'E_TRANSCRIPT' });
    expect(result.files).toHaveLength(1);
    expect(await fs.readFile(path.join(root, result.files[0]), 'utf8')).toBe('Do not extend into the silent picture.\n');
  });
  it('preserves word-mode text after a timing failure without producing editable timing', async () => {
    await setup(); await recognize([segment(0, 3000, 'Words remain available.')]);
    const result = await call('transcribe', { input_path: 'source.wav', granularity: 'word' });
    expect(result).toMatchObject({ ok: false, code: 'E_WORD_EDIT' });
    expect(result.files).toHaveLength(1);
    expect((await fs.readdir(path.dirname(path.join(root, result.files[0])))).sort()).toEqual(['.orkas-output-types.json', 'transcript.txt']);
    expect(await fs.readFile(path.join(root, result.files[0]), 'utf8')).toBe('Words remain available.\n');
  });
});
