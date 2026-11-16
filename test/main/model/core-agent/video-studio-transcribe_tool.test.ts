import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

// 2026-10-31 Luna drive: transcripts were never written into the project when
// the model omitted transcript_path, so every later turn reported the ingest
// records missing and redid the work. Omitting the path now saves the
// transcript under project/transcripts/ and returns where.
const UID = 'transcribe-tool';
const ENV_KEYS = [
  'ORKAS_WORKSPACE_ROOT',
  'ORKAS_BUNDLED_FFMPEG',
  'ORKAS_BUNDLED_FFPROBE',
  'ORKAS_RUNTIME_DIR',
  'ORKAS_WHISPER_CPP',
  'ORKAS_WHISPER_CLI',
  'ORKAS_WHISPER_MODEL',
] as const;
const originalEnv = new Map<string, string | undefined>();
let root: string;
let workspace: string;

function writeExecutable(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  fs.chmodSync(file, 0o755);
}

beforeEach(async () => {
  for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-transcribe-tool-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../../src/main/features/users')).activateUser(UID);
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'project', 'raw'), { recursive: true });
  (await import('../../../../src/main/features/user_workspace')).setWorkspacePath(UID, workspace);

  const bin = path.join(root, 'bin');
  writeExecutable(path.join(bin, 'ffprobe'), [
    '#!/usr/bin/env node',
    'process.stdout.write(JSON.stringify({ format: { duration: "5" }, streams: [{ codec_type: "audio", codec_name: "aac" }] }));',
  ]);
  writeExecutable(path.join(bin, 'ffmpeg'), [
    '#!/usr/bin/env node',
    "require('node:fs').writeFileSync(process.argv[process.argv.length - 1], 'wav');",
  ]);
  const runtimeRoot = path.join(root, 'runtime');
  writeExecutable(path.join(runtimeRoot, 'whisper', 'current', 'bin', 'whisper-cli'), [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "const base = args[args.indexOf('-of') + 1];",
    "require('node:fs').writeFileSync(base + '.json', JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 1500 }, text: ' Grow without hiring.' }] }));",
  ]);
  const model = path.join(runtimeRoot, 'whisper', 'current', 'models', 'ggml-base.bin');
  fs.mkdirSync(path.dirname(model), { recursive: true });
  fs.writeFileSync(model, 'model');
  process.env.ORKAS_BUNDLED_FFMPEG = path.join(bin, 'ffmpeg');
  process.env.ORKAS_BUNDLED_FFPROBE = path.join(bin, 'ffprobe');
  process.env.ORKAS_RUNTIME_DIR = runtimeRoot;
  delete process.env.ORKAS_WHISPER_CPP;
  delete process.env.ORKAS_WHISPER_CLI;
  delete process.env.ORKAS_WHISPER_MODEL;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function tool(extra: Record<string, unknown> = {}) {
  return (await import('../../../../src/main/model/core-agent/video-studio-tool')).createVideoStudioTool({
    userId: UID, cid: 'current-chat', ...extra,
  } as any);
}
const body = (result: any) => JSON.parse(String(result.content).split('\n\n<file-renamed>')[0]);
const transcriptsDir = () => path.join(workspace, 'project', 'transcripts');

describe.skipIf(process.platform === 'win32')('video_studio speech.transcribe transcript location', () => {
  it('returns an error and preserves the prior file when speech.transcribe produces corrupt JSON', async () => {
    const source = path.join(workspace, 'project', 'raw', 'clip.mp4');
    fs.writeFileSync(source, 'fake media');
    const transcript = path.join(transcriptsDir(), 'existing.json');
    fs.mkdirSync(transcriptsDir(), { recursive: true });
    fs.writeFileSync(transcript, '{"text":"Prior usable result"}\n');
    writeExecutable(path.join(root, 'runtime', 'whisper', 'current', 'bin', 'whisper-cli'), [
      '#!/usr/bin/env node',
      "const a = process.argv.slice(2);",
      "require('node:fs').writeFileSync(a[a.indexOf('-of') + 1] + '.json', '{');",
    ]);
    const result: any = await (await tool()).execute({
      op: 'speech.transcribe', input_path: source, transcript_path: transcript,
    }, { workingDir: workspace, state: {} } as any);
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ ok: false, errorCode: 'E_TRANSCRIBE_INVALID_OUTPUT' });
    expect(fs.readFileSync(transcript, 'utf8')).toBe('{"text":"Prior usable result"}\n');
    expect(fs.readFileSync(source, 'utf8')).toBe('fake media');
  });

  it('notifies only preserved text after invalid timing and leaves the previous transcript intact', async () => {
    const source = path.join(workspace, 'project', 'raw', 'clip.mp4'); fs.writeFileSync(source, 'fake media');
    fs.mkdirSync(transcriptsDir(), { recursive: true });
    const output = path.join(transcriptsDir(), 'old.json'); fs.writeFileSync(output, '{"text":"Prior"}');
    writeExecutable(path.join(root, 'runtime', 'whisper', 'current', 'bin', 'whisper-cli'), [
      '#!/usr/bin/env node', "const fs=require('node:fs'),a=process.argv.slice(2);",
      "fs.writeFileSync(a[a.indexOf('-of')+1]+'.json',JSON.stringify({transcription:[{text:'Keep this text.',offsets:{from:0,to:6000}}]}));",
    ]);
    const written: string[] = [];
    const t = await tool({ onFileWritten: (file: string) => { written.push(file); } });
    const result = await t.execute({ op: 'speech.transcribe', input_path: source, transcript_path: output }, { workingDir: workspace, state: {} } as any);
    const data = body(result);
    expect(result.isError).toBe(true); expect(data).toMatchObject({ ok: false, timing_valid: false });
    expect(fs.readFileSync(data.text_path, 'utf8')).toBe('Keep this text.\n');
    expect(written).toEqual([data.text_path]); expect(fs.readFileSync(output, 'utf8')).toBe('{"text":"Prior"}');
    expect(data.text_path.startsWith(transcriptsDir() + path.sep)).toBe(true);
  });

  it('saves an unrequested transcript in the project, once per source file', async () => {
    const source = path.join(workspace, 'project', 'raw', 'source.mp4');
    const sameName = path.join(workspace, 'uploads', 'source.mp4');
    fs.writeFileSync(source, 'fake media');
    fs.mkdirSync(path.dirname(sameName), { recursive: true });
    fs.writeFileSync(sameName, 'other media');
    const t = await tool();
    const ctx = { workingDir: workspace, state: {} } as any;

    const first = body(await t.execute({ op: 'speech.transcribe', input_path: 'project/raw/source.mp4' }, ctx));
    expect(first).toMatchObject({ ok: true, op: 'speech.transcribe' });
    expect(path.dirname(first.transcript_path)).toBe(transcriptsDir());
    expect(path.basename(first.transcript_path)).toMatch(/^source-[0-9a-f]{8}\.json$/);
    expect(JSON.parse(fs.readFileSync(first.transcript_path, 'utf8')).text).toBe('Grow without hiring.');

    // Re-transcribing the same file replaces its own transcript; another file
    // with the same name gets its own.
    const again = body(await t.execute({ op: 'speech.transcribe', input_path: source }, ctx));
    expect(again.transcript_path).toBe(first.transcript_path);
    const other = body(await t.execute({ op: 'speech.transcribe', input_path: 'uploads/source.mp4' }, ctx));
    expect(path.dirname(other.transcript_path)).toBe(transcriptsDir());
    expect(other.transcript_path).not.toBe(first.transcript_path);
    expect(fs.readdirSync(transcriptsDir()).sort()).toEqual(
      [path.basename(first.transcript_path), path.basename(other.transcript_path)].sort(),
    );
  });

  it('keeps an explicit transcript_path and still refuses one outside the workspace', async () => {
    fs.writeFileSync(path.join(workspace, 'project', 'raw', 'clip.mp4'), 'fake media');
    const t = await tool();
    const ctx = { workingDir: workspace, state: {} } as any;
    const kept = body(await t.execute({
      op: 'speech.transcribe', input_path: 'project/raw/clip.mp4', transcript_path: 'project/transcripts/clip.json',
    }, ctx));
    expect(kept.transcript_path).toBe(path.join(transcriptsDir(), 'clip.json'));
    expect(fs.readdirSync(transcriptsDir())).toEqual(['clip.json']);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-transcribe-outside-'));
    try {
      const refused: any = await t.execute({
        op: 'speech.transcribe', input_path: 'project/raw/clip.mp4', transcript_path: path.join(outside, 'clip.json'),
      }, ctx);
      expect(refused.isError).toBe(true);
      expect(String(refused.content)).toContain('E_PATH_OUT_OF_SCOPE');
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns the transcript without saving it when the default location is outside the workspace', async () => {
    const source = path.join(workspace, 'project', 'raw', 'clip.mp4');
    fs.writeFileSync(source, 'fake media');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-transcribe-elsewhere-'));
    try {
      const t = await tool();
      const result = body(await t.execute({ op: 'speech.transcribe', input_path: source }, { workingDir: elsewhere, state: {} } as any));
      expect(result).toMatchObject({ ok: true, transcript_path: '' });
      expect(result.summary.text).toBe('Grow without hiring.');
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(fs.existsSync(transcriptsDir())).toBe(false);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// 2026-11-13: three clips cut from a podcast on whole-second times taken from the
// transcript's sentences dropped a question, a closing line and a payoff. The result
// now opens with the transcript split at pauses measured while the audio is extracted.
describe.skipIf(process.platform === 'win32')('video_studio speech.transcribe phrase view', () => {
  it('opens the result with lines split at the pauses measured in the audio', async () => {
    // The extraction logs one silence; the recognizer stretches "without" over it.
    writeExecutable(path.join(root, 'bin', 'ffmpeg'), [
      '#!/usr/bin/env node',
      "process.stderr.write('[silencedetect @ 0x1] silence_start: 0.5\\n[silencedetect @ 0x1] silence_end: 1.1 | silence_duration: 0.6\\n');",
      "require('node:fs').writeFileSync(process.argv[process.argv.length - 1], 'wav');",
    ]);
    writeExecutable(path.join(root, 'runtime', 'whisper', 'current', 'bin', 'whisper-cli'), [
      '#!/usr/bin/env node',
      "const args = process.argv.slice(2);",
      "const base = args[args.indexOf('-of') + 1];",
      "const tok = (text, from, to) => ({ text, offsets: { from, to } });",
      "require('node:fs').writeFileSync(base + '.json', JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 2000 }, text: ' Grow without hiring.', tokens: [tok(' Grow', 0, 500), tok(' without', 500, 1500), tok(' hiring', 1500, 1900), tok('.', 1900, 2000)] }] }));",
    ]);
    const source = path.join(workspace, 'project', 'raw', 'talk.mp4');
    fs.writeFileSync(source, 'fake media');
    const result = await (await tool()).execute({ op: 'speech.transcribe', input_path: 'project/raw/talk.mp4' }, { workingDir: workspace, state: {} } as any);
    const content = String(result.content);
    const reply = body(result);
    expect(reply).toMatchObject({ ok: true, phrases: { lines: 2, measured_pauses: 1 } });
    expect(reply.phrases.text).toBe('[0.00–0.50] Grow\n  — 0.60s —\n[1.10–2.00] without hiring.');
    // Ahead of the full transcript, so a capped result still shows it.
    expect(content.indexOf('"phrases"')).toBeLessThan(content.indexOf('"summary"'));
    // The saved transcript is unchanged: the view is not written next to it.
    expect(fs.readdirSync(transcriptsDir())).toHaveLength(1);
  });
  it('builds the view from word times even when the caller asks for sentences', async () => {
    // 2026-11-13: a run that asked for sentence times got a view split only between
    // sentences and cut on whole seconds again.
    writeExecutable(path.join(root, 'bin', 'ffmpeg'), [
      '#!/usr/bin/env node',
      "process.stderr.write('[silencedetect @ 0x1] silence_start: 0.5\\n[silencedetect @ 0x1] silence_end: 1.1\\n');",
      "require('node:fs').writeFileSync(process.argv[process.argv.length - 1], 'wav');",
    ]);
    const argsLog = path.join(root, 'whisper-args.json');
    writeExecutable(path.join(root, 'runtime', 'whisper', 'current', 'bin', 'whisper-cli'), [
      '#!/usr/bin/env node',
      "const args = process.argv.slice(2);",
      `require('node:fs').writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args));`,
      "const base = args[args.indexOf('-of') + 1];",
      "const tok = (text, from, to) => ({ text, offsets: { from, to } });",
      "require('node:fs').writeFileSync(base + '.json', JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 2000 }, text: ' Grow without hiring.', tokens: [tok(' Grow', 0, 500), tok(' without', 500, 1500), tok(' hiring', 1500, 1900), tok('.', 1900, 2000)] }] }));",
    ]);
    fs.writeFileSync(path.join(workspace, 'project', 'raw', 'talk.mp4'), 'fake media');
    const reply = body(await (await tool()).execute(
      { op: 'speech.transcribe', input_path: 'project/raw/talk.mp4', timestamps: 'segment' },
      { workingDir: workspace, state: {} } as any,
    ));
    expect(JSON.parse(fs.readFileSync(argsLog, 'utf8'))).toContain('-ojf');
    expect(reply.summary).toMatchObject({ timestamp_detail: 'segment', words: [] });
    expect(reply.phrases.text).toBe('[0.00–0.50] Grow\n  — 0.60s —\n[1.10–2.00] without hiring.');
  });
});
