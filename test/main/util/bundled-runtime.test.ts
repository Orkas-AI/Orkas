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
