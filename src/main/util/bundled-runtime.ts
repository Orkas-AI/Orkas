import * as fs from 'node:fs';
import * as path from 'node:path';

import { runtimeResourcesDir } from '../paths';

function isFile(p: string | undefined): p is string {
  if (!p) return false;
  try { return fs.statSync(p).isFile(); }
  catch { return false; }
}

function isDir(p: string | undefined): p is string {
  if (!p) return false;
  try { return fs.statSync(p).isDirectory(); }
  catch { return false; }
}

function platformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

function pushUnique(out: string[], seen: Set<string>, value: string | undefined): void {
  if (!value) return;
  const resolved = path.resolve(value);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  out.push(resolved);
}

function runtimeRoots(): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  pushUnique(roots, seen, process.env.ORKAS_RUNTIME_DIR);
  pushUnique(roots, seen, runtimeResourcesDir());
  return roots;
}

function runtimeVariantDirs(kind: 'python' | 'uv' | 'node' | 'ffmpeg' | 'whisper'): string[] {
  const dirs: string[] = [];
  for (const runtimeRoot of runtimeRoots()) {
    const root = path.join(runtimeRoot, kind);
    dirs.push(path.join(root, 'current'), path.join(root, platformKey()));
  }
  return [
    ...dirs,
  ];
}

function whisperRuntimeEnabled(dir: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.orkas-whisper-ready.json'), 'utf8')) as {
      capability?: { status?: string };
    };
    return marker.capability?.status !== 'disabled';
  } catch {
    // Development payloads created before capability markers remain usable.
    return true;
  }
}

function resolvePythonExecutable(): string | undefined {
  const configured = process.env.ORKAS_BUNDLED_PYTHON || process.env.ORKAS_PYTHON;
  if (isFile(configured)) return configured;

  const names = process.platform === 'win32'
    ? ['python.exe', path.join('python', 'python.exe')]
    : [
      path.join('python', 'bin', 'python3'),
      path.join('python', 'bin', 'python'),
      path.join('bin', 'python3'),
      path.join('bin', 'python'),
    ];

  for (const dir of runtimeVariantDirs('python')) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveUvExecutable(): string | undefined {
  const configured = process.env.ORKAS_BUNDLED_UV || process.env.ORKAS_UV;
  if (isFile(configured)) return configured;

  const name = process.platform === 'win32' ? 'uv.exe' : 'uv';
  for (const dir of runtimeVariantDirs('uv')) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function resolveNodeExecutable(): string | undefined {
  const configured = process.env.ORKAS_BUNDLED_NODE;
  if (isFile(configured)) return configured;

  // ensure-runtime flattens the official Node archive so the payload root holds
  // `bin/node` (mac/linux) / `node.exe` (win) directly — see manifest `executable`.
  const names = process.platform === 'win32'
    ? ['node.exe']
    : [path.join('bin', 'node')];

  for (const dir of runtimeVariantDirs('node')) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Look up a bare executable name on the process PATH, returning its absolute
 *  path. Used only as a last-resort fallback when no vendored binary exists. */
function resolveOnSystemPath(name: string): string | undefined {
  const raw = process.env.PATH || process.env.Path || '';
  if (!raw) return undefined;
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function resolveFfmpegBinary(kind: 'ffmpeg' | 'ffprobe'): string | undefined {
  const envName = kind === 'ffmpeg' ? 'ORKAS_BUNDLED_FFMPEG' : 'ORKAS_BUNDLED_FFPROBE';
  const configured = process.env[envName];
  if (isFile(configured)) return configured;

  const name = process.platform === 'win32' ? `${kind}.exe` : kind;
  for (const dir of runtimeVariantDirs('ffmpeg')) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
    // Tolerate a per-binary `bin/` layout if a future vendor step nests them.
    const nested = path.join(dir, 'bin', name);
    if (isFile(nested)) return nested;
  }
  // Defense-in-depth: a box that lacks the vendored binary but has a system
  // ffmpeg/ffprobe on PATH should still work rather than hard-fail with
  // E_FFMPEG_MISSING. The vendored build is capability-verified (libass); a
  // system binary may lack filters, so the vendored copy always wins above.
  return resolveOnSystemPath(name);
}

function resolveWhisperBinary(): string | undefined {
  const configured = process.env.ORKAS_WHISPER_CPP || process.env.ORKAS_WHISPER_CLI;
  if (isFile(configured)) return configured;

  const names = process.platform === 'win32'
    ? [
      'whisper-cli.exe',
      path.join('bin', 'whisper-cli.exe'),
      'main.exe',
      path.join('bin', 'main.exe'),
    ]
    : [
      'whisper-cli',
      path.join('bin', 'whisper-cli'),
      'main',
      path.join('bin', 'main'),
    ];
  for (const dir of runtimeVariantDirs('whisper')) {
    if (!whisperRuntimeEnabled(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveWhisperModel(modelHint?: string): string | undefined {
  const hinted = modelHint || process.env.ORKAS_WHISPER_MODEL;
  if (isFile(hinted)) return path.resolve(hinted);

  const normalizedHint = modelHint
    ? String(modelHint).replace(/^ggml-/, '').replace(/\.bin$/i, '').trim()
    : '';
  const names = [
    modelHint,
    normalizedHint ? `ggml-${normalizedHint}.bin` : '',
    'ggml-base-q5_1.bin',
    'ggml-large-v3.bin',
    'ggml-medium.bin',
    'ggml-small.bin',
    'ggml-base.bin',
    'ggml-tiny.bin',
  ].filter((name): name is string => !!name);
  for (const dir of runtimeVariantDirs('whisper')) {
    if (!whisperRuntimeEnabled(dir)) continue;
    for (const name of names) {
      const candidates = [
        path.join(dir, name),
        path.join(dir, 'models', name),
      ];
      for (const candidate of candidates) {
        if (isFile(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Bundled ffmpeg/ffprobe absolute paths, or undefined when not vendored for
 * this platform. VideoStudio native render/edit/media analysis paths use these
 * binaries instead of relying on whatever the user's machine happens to have.
 * When undefined (e.g. a dev checkout before the vendor step), callers should
 * surface a clear missing-runtime error or use their own explicit fallback.
 */
export function bundledFfmpegPaths(): { ffmpeg?: string; ffprobe?: string } {
  const result: { ffmpeg?: string; ffprobe?: string } = {};
  const ffmpeg = resolveFfmpegBinary('ffmpeg');
  const ffprobe = resolveFfmpegBinary('ffprobe');
  if (ffmpeg) result.ffmpeg = ffmpeg;
  if (ffprobe) result.ffprobe = ffprobe;
  return result;
}

/**
 * Bundled whisper.cpp paths. The app treats speech transcription as a native
 * VideoStudio capability, so default installs can vendor `resources/runtime/whisper`
 * without requiring users to hand-set ORKAS_WHISPER_*.
 */
export function bundledWhisperPaths(modelHint?: string): { cli?: string; model?: string } {
  const result: { cli?: string; model?: string } = {};
  const cli = resolveWhisperBinary();
  const model = resolveWhisperModel(modelHint);
  if (cli) result.cli = cli;
  if (model) result.model = model;
  return result;
}

function pushPathDir(out: string[], seen: Set<string>, dir: string | undefined): void {
  if (!isDir(dir)) return;
  const resolved = path.resolve(dir);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(resolved);
}

export function bundledRuntimePathEntries(): string[] {
  const entries: string[] = [];
  const seen = new Set<string>();
  const python = resolvePythonExecutable();
  if (python) {
    const pythonDir = path.dirname(python);
    pushPathDir(entries, seen, pythonDir);
    pushPathDir(entries, seen, path.join(pythonDir, 'Scripts'));
    pushPathDir(entries, seen, path.join(pythonDir, 'bin'));
  }
  const uv = resolveUvExecutable();
  if (uv) pushPathDir(entries, seen, path.dirname(uv));
  // Node's `bin` (mac/linux) or install root (win) holds `node`, `npm`, `npx`.
  // Injecting it lets the bash tool AND orkas-pkg's `npm install` resolve a
  // bundled Node on machines without a user-installed toolchain.
  const node = resolveNodeExecutable();
  if (node) pushPathDir(entries, seen, path.dirname(node));
  // ffmpeg/ffprobe + whisper dirs go LAST (python stays entries[0]). This puts
  // the resolved media binaries on the sandbox/bash PATH so a skill subprocess —
  // or a stray shell `ffprobe` — resolves to the vendored copy instead of
  // failing with "'ffprobe' is not recognized" on a box with no system ffmpeg.
  const { ffmpeg, ffprobe } = bundledFfmpegPaths();
  if (ffmpeg) pushPathDir(entries, seen, path.dirname(ffmpeg));
  if (ffprobe) pushPathDir(entries, seen, path.dirname(ffprobe));
  const { cli: whisperCli } = bundledWhisperPaths();
  if (whisperCli) pushPathDir(entries, seen, path.dirname(whisperCli));
  return entries;
}

export interface MediaRuntimeStatus {
  ffmpeg?: string;
  ffprobe?: string;
  whisperCli?: string;
  whisperModel?: string;
  missing: Array<'ffmpeg' | 'ffprobe' | 'whisper_cli' | 'whisper_model'>;
}

/**
 * Preflight the media runtime VideoStudio depends on. Reports which binaries
 * resolve (bundled → env override → system PATH for ffmpeg/ffprobe; bundled →
 * env for whisper) so a caller can fail fast with one actionable message
 * instead of discovering a missing binary mid-render/transcribe.
 */
export function mediaRuntimeStatus(modelHint?: string): MediaRuntimeStatus {
  const ff = bundledFfmpegPaths();
  const wh = bundledWhisperPaths(modelHint);
  const missing: MediaRuntimeStatus['missing'] = [];
  if (!ff.ffmpeg) missing.push('ffmpeg');
  if (!ff.ffprobe) missing.push('ffprobe');
  if (!wh.cli) missing.push('whisper_cli');
  if (!wh.model) missing.push('whisper_model');
  return {
    ...(ff.ffmpeg ? { ffmpeg: ff.ffmpeg } : {}),
    ...(ff.ffprobe ? { ffprobe: ff.ffprobe } : {}),
    ...(wh.cli ? { whisperCli: wh.cli } : {}),
    ...(wh.model ? { whisperModel: wh.model } : {}),
    missing,
  };
}

/** Absolute path to the bundled Node executable, or undefined when not present. */
export function bundledNodeExecutable(): string | undefined {
  return resolveNodeExecutable();
}

/**
 * Absolute path to the bundled npm `npx-cli.js`, or undefined when not present.
 * Resolved relative to the bundled Node so callers can run it as
 * `node <npx-cli.js> ...` — robust cross-platform (no shebang / `.cmd` / shell
 * dependency, unlike spawning `npx` directly).
 */
export function bundledNpxCli(): string | undefined {
  const node = resolveNodeExecutable();
  if (!node) return undefined;
  const dir = path.dirname(node);
  const candidates = process.platform === 'win32'
    ? [path.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js')]
    : [path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')];
  for (const c of candidates) if (isFile(c)) return c;
  return undefined;
}

export function bundledRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const python = resolvePythonExecutable();
  const uv = resolveUvExecutable();
  const node = resolveNodeExecutable();
  if (python) env.ORKAS_PYTHON = python;
  if (uv) env.ORKAS_UV = uv;
  if (node) env.ORKAS_BUNDLED_NODE = node;
  // Export the resolved media binaries so skill subprocesses inherit them via
  // env (their own resolver checks these first) instead of independently
  // re-resolving and hard-failing when process.resourcesPath is unavailable.
  const { ffmpeg, ffprobe } = bundledFfmpegPaths();
  if (ffmpeg) env.ORKAS_BUNDLED_FFMPEG = ffmpeg;
  if (ffprobe) env.ORKAS_BUNDLED_FFPROBE = ffprobe;
  const { cli: whisperCli, model: whisperModel } = bundledWhisperPaths();
  if (whisperCli) env.ORKAS_WHISPER_CPP = whisperCli;
  if (whisperModel) env.ORKAS_WHISPER_MODEL = whisperModel;
  return env;
}
