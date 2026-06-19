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

function runtimeVariantDirs(kind: 'python' | 'uv'): string[] {
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
  return entries;
}

export function bundledRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const python = resolvePythonExecutable();
  const uv = resolveUvExecutable();
  if (python) env.ORKAS_PYTHON = python;
  if (uv) env.ORKAS_UV = uv;
  return env;
}
