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
    const pythonExe = path.join(runtimeRoot, pythonRel);
    const uvExe = path.join(runtimeRoot, uvRel);
    fs.mkdirSync(path.dirname(pythonExe), { recursive: true });
    fs.mkdirSync(path.dirname(uvExe), { recursive: true });
    fs.writeFileSync(pythonExe, '');
    fs.writeFileSync(uvExe, '');
    if (process.platform === 'win32') {
      fs.mkdirSync(path.join(path.dirname(pythonExe), 'Scripts'), { recursive: true });
    }

    const runtime = await import('../../../src/main/util/bundled-runtime');

    expect(runtime.bundledRuntimeEnv().ORKAS_PYTHON).toBe(pythonExe);
    expect(runtime.bundledRuntimeEnv().ORKAS_UV).toBe(uvExe);
    const entries = runtime.bundledRuntimePathEntries();
    expect(entries[0]).toBe(path.dirname(pythonExe));
    expect(entries).toContain(path.dirname(uvExe));
    if (process.platform === 'win32') {
      expect(entries).toContain(path.join(path.dirname(pythonExe), 'Scripts'));
    }
  });
});
