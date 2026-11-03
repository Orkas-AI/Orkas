import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

// Exercise the public transcription tool with an explicit destination.
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

async function tool() {
  return (await import('../../../../src/main/model/core-agent/video-studio-tool')).createVideoStudioTool({
    userId: UID, cid: 'current-chat',
  } as any);
}
const body = (result: any) => JSON.parse(String(result.content).split('\n\n<file-renamed>')[0]);
const transcriptsDir = () => path.join(workspace, 'project', 'transcripts');

describe.skipIf(process.platform === 'win32')('video_studio speech.transcribe result safety', () => {
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

});
