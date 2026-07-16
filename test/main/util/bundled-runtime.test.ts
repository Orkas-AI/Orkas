import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bundled-runtime-'));
  process.env.ORKAS_RUNTIME_DIR = path.join(tmpDir, 'runtime');
  process.env.ORKAS_WORKSPACE_ROOT ||= path.join(tmpDir, 'data');
});

afterEach(() => {
  delete process.env.ORKAS_RUNTIME_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('bundled-runtime', () => {
  it('exposes bundled runtime executable directories for sandbox PATH precedence', async () => {
    const key = `${process.platform}-${process.arch}`;
    const runtimeRoot = process.env.ORKAS_RUNTIME_DIR!;
    const pythonRel = process.platform === 'win32'
      ? path.join('python', key, 'python', 'python.exe')
      : path.join('python', key, 'python', 'bin', 'python3');
    const uvRel = process.platform === 'win32'
      ? path.join('uv', key, 'uv.exe')
      : path.join('uv', key, 'uv');
    // ensure-runtime flattens Node so the executable sits at bin/node (mac/linux)
    // or node.exe at the install root (win) — see bundled-runtime resolveNodeExecutable.
    const nodeRel = process.platform === 'win32'
      ? path.join('node', key, 'node.exe')
      : path.join('node', key, 'bin', 'node');
    const pythonExe = path.join(runtimeRoot, pythonRel);
    const uvExe = path.join(runtimeRoot, uvRel);
    const nodeExe = path.join(runtimeRoot, nodeRel);
    fs.mkdirSync(path.dirname(pythonExe), { recursive: true });
    fs.mkdirSync(path.dirname(uvExe), { recursive: true });
    fs.mkdirSync(path.dirname(nodeExe), { recursive: true });
    fs.writeFileSync(pythonExe, '');
    fs.writeFileSync(uvExe, '');
    fs.writeFileSync(nodeExe, '');
    if (process.platform === 'win32') {
      fs.mkdirSync(path.join(path.dirname(pythonExe), 'Scripts'), { recursive: true });
    }

    const runtime = await import('../../../src/main/util/bundled-runtime');

    expect(runtime.bundledRuntimeEnv().ORKAS_PYTHON).toBe(pythonExe);
    expect(runtime.bundledRuntimeEnv().ORKAS_UV).toBe(uvExe);
    expect(runtime.bundledRuntimeEnv().ORKAS_BUNDLED_NODE).toBe(nodeExe);
    const entries = runtime.bundledRuntimePathEntries();
    expect(entries[0]).toBe(path.dirname(pythonExe));
    expect(entries).toContain(path.dirname(uvExe));
    // Node's bin (mac/linux) / install root (win) must be on PATH so the bash
    // tool and orkas-pkg resolve bundled node/npm/npx without a user toolchain.
    expect(entries).toContain(path.dirname(nodeExe));
    if (process.platform === 'win32') {
      expect(entries).toContain(path.join(path.dirname(pythonExe), 'Scripts'));
    }
  });
});

describe('bundled-runtime › media binaries (ffmpeg / whisper)', () => {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const key = `${process.platform}-${process.arch}`;
  const MEDIA_ENV = ['ORKAS_BUNDLED_FFMPEG', 'ORKAS_BUNDLED_FFPROBE', 'ORKAS_WHISPER_CPP', 'ORKAS_WHISPER_CLI', 'ORKAS_WHISPER_MODEL'];
  let savedEnv: Record<string, string | undefined>;
  let savedResourcesPath: PropertyDescriptor | undefined;

  beforeEach(() => {
    savedEnv = {};
    for (const k of MEDIA_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    savedResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  });
  afterEach(() => {
    for (const k of MEDIA_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (savedResourcesPath) Object.defineProperty(process, 'resourcesPath', savedResourcesPath);
    else delete (process as unknown as { resourcesPath?: string }).resourcesPath;
  });

  function vendorFfmpeg(): { ffmpeg: string; ffprobe: string } {
    const dir = path.join(process.env.ORKAS_RUNTIME_DIR!, 'ffmpeg', key);
    fs.mkdirSync(dir, { recursive: true });
    const ffmpeg = path.join(dir, `ffmpeg${exe}`);
    const ffprobe = path.join(dir, `ffprobe${exe}`);
    fs.writeFileSync(ffmpeg, '');
    fs.writeFileSync(ffprobe, '');
    return { ffmpeg, ffprobe };
  }

  it('resolves vendored ffmpeg/ffprobe and exposes them to subprocess env + PATH', async () => {
    const { ffmpeg, ffprobe } = vendorFfmpeg();
    const runtime = await import('../../../src/main/util/bundled-runtime');

    expect(runtime.bundledFfmpegPaths()).toEqual({ ffmpeg, ffprobe });
    // Skill subprocesses inherit the resolved binaries via env (their resolver
    // checks these first) — the gap that let a stray shell `ffprobe` fail.
    const env = runtime.bundledRuntimeEnv();
    expect(env.ORKAS_BUNDLED_FFMPEG).toBe(ffmpeg);
    expect(env.ORKAS_BUNDLED_FFPROBE).toBe(ffprobe);
    expect(runtime.bundledRuntimePathEntries()).toContain(path.dirname(ffmpeg));
  });

  it('honors ORKAS_BUNDLED_FFMPEG / ORKAS_BUNDLED_FFPROBE overrides', async () => {
    const ffmpeg = path.join(tmpDir, `custom-ffmpeg${exe}`);
    const ffprobe = path.join(tmpDir, `custom-ffprobe${exe}`);
    fs.writeFileSync(ffmpeg, '');
    fs.writeFileSync(ffprobe, '');
    process.env.ORKAS_BUNDLED_FFMPEG = ffmpeg;
    process.env.ORKAS_BUNDLED_FFPROBE = ffprobe;
    const runtime = await import('../../../src/main/util/bundled-runtime');
    expect(runtime.bundledFfmpegPaths()).toEqual({ ffmpeg, ffprobe });
  });

  it('falls back to a system-PATH ffmpeg/ffprobe when nothing is vendored', async () => {
    // Neutralize the packaged resources root (which may hold a real vendored
    // ffmpeg on a dev machine) so the only resolvable binary is on PATH.
    Object.defineProperty(process, 'resourcesPath', {
      value: path.join(tmpDir, 'no-resources'), configurable: true, writable: true,
    });
    const pathDir = path.join(tmpDir, 'sysbin');
    fs.mkdirSync(pathDir, { recursive: true });
    const sysFfmpeg = path.join(pathDir, `ffmpeg${exe}`);
    const sysFfprobe = path.join(pathDir, `ffprobe${exe}`);
    fs.writeFileSync(sysFfmpeg, '');
    fs.writeFileSync(sysFfprobe, '');
    const savedPath = process.env.PATH;
    process.env.PATH = pathDir;
    try {
      const runtime = await import('../../../src/main/util/bundled-runtime');
      expect(runtime.bundledFfmpegPaths()).toEqual({ ffmpeg: sysFfmpeg, ffprobe: sysFfprobe });
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('mediaRuntimeStatus reports whisper missing when its bundled payload is absent', async () => {
    Object.defineProperty(process, 'resourcesPath', {
      value: path.join(tmpDir, 'no-resources'), configurable: true, writable: true,
    });
    vendorFfmpeg(); // ffmpeg present so only whisper is missing
    const runtime = await import('../../../src/main/util/bundled-runtime');
    const status = runtime.mediaRuntimeStatus();
    expect(status.ffmpeg).toBeTruthy();
    expect(status.ffprobe).toBeTruthy();
    expect(status.missing).toContain('whisper_cli');
    expect(status.missing).toContain('whisper_model');
    expect(status.missing).not.toContain('ffmpeg');
  });

  it('resolves the packaged multilingual q5 Whisper CLI and model', async () => {
    const dir = path.join(process.env.ORKAS_RUNTIME_DIR!, 'whisper', key);
    const cli = path.join(dir, 'bin', `whisper-cli${exe}`);
    const model = path.join(dir, 'models', 'ggml-base-q5_1.bin');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.writeFileSync(cli, '');
    fs.writeFileSync(model, 'model');

    const runtime = await import('../../../src/main/util/bundled-runtime');
    expect(runtime.bundledWhisperPaths()).toEqual({ cli, model });
    const env = runtime.bundledRuntimeEnv();
    expect(env.ORKAS_WHISPER_CPP).toBe(cli);
    expect(env.ORKAS_WHISPER_MODEL).toBe(model);
    expect(runtime.bundledRuntimePathEntries()).toContain(path.dirname(cli));
  });

  it('does not advertise a verified Whisper payload disabled for this CPU', async () => {
    Object.defineProperty(process, 'resourcesPath', {
      value: path.join(tmpDir, 'no-resources'), configurable: true, writable: true,
    });
    const dir = path.join(process.env.ORKAS_RUNTIME_DIR!, 'whisper', key);
    const cli = path.join(dir, 'bin', `whisper-cli${exe}`);
    const model = path.join(dir, 'models', 'ggml-base-q5_1.bin');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.writeFileSync(cli, '');
    fs.writeFileSync(model, 'model');
    fs.writeFileSync(path.join(dir, '.orkas-whisper-ready.json'), JSON.stringify({
      capability: { status: 'disabled', reason: 'unsupported_cpu' },
    }));

    const runtime = await import('../../../src/main/util/bundled-runtime');
    expect(runtime.bundledWhisperPaths()).toEqual({});
    expect(runtime.mediaRuntimeStatus().missing).toEqual(expect.arrayContaining(['whisper_cli', 'whisper_model']));
  });

  it('resolves whisper cli + model from env overrides and exports them', async () => {
    const cli = path.join(tmpDir, `whisper-cli${exe}`);
    const model = path.join(tmpDir, 'ggml-base.bin');
    fs.writeFileSync(cli, '');
    fs.writeFileSync(model, '');
    process.env.ORKAS_WHISPER_CPP = cli;
    process.env.ORKAS_WHISPER_MODEL = model;
    const runtime = await import('../../../src/main/util/bundled-runtime');
    expect(runtime.bundledWhisperPaths()).toEqual({ cli, model });
    const env = runtime.bundledRuntimeEnv();
    expect(env.ORKAS_WHISPER_CPP).toBe(cli);
    expect(env.ORKAS_WHISPER_MODEL).toBe(model);
  });
});
