import * as fs from 'node:fs';
import * as path from 'node:path';

import { runtimeResourcesDir } from './paths';

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

function runtimeVariantDirs(kind: 'python' | 'uv' | 'node' | 'ffmpeg'): string[] {
  const dirs: string[] = [];
  for (const runtimeRoot of runtimeRoots()) {
    const root = path.join(runtimeRoot, kind);
    dirs.push(path.join(root, 'current'), path.join(root, platformKey()));
  }
  return [
    ...dirs,
  ];
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
  return undefined;
}

/**
 * Bundled ffmpeg/ffprobe absolute paths, or undefined when not vendored for
 * this platform. VideoStudio skill scripts use these paths for deterministic
 * local media probing and ffmpeg operations instead of relying on whatever the
 * user's machine happens to have.
 */
export function bundledFfmpegPaths(): { ffmpeg?: string; ffprobe?: string } {
  const result: { ffmpeg?: string; ffprobe?: string } = {};
  const ffmpeg = resolveFfmpegBinary('ffmpeg');
  const ffprobe = resolveFfmpegBinary('ffprobe');
  if (ffmpeg) result.ffmpeg = ffmpeg;
  if (ffprobe) result.ffprobe = ffprobe;
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
  return entries;
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
  return env;
}
