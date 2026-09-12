import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requirePackage = createRequire(path.join(process.cwd(), 'package.json'));
const { assertBootstrapNode, verifyNativeDependencies, PROBE_TIMEOUT_MS } = requirePackage('./scripts/verify-native-dependencies.cjs');
const { probeSqlite, probeSharp } = requirePackage('./scripts/native-dependency-probe.cjs');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('source native dependency readiness', () => {
  it.each(['20.19.0', '22.11.0', 'invalid', '22.12', '22.12.0-rc.1'])('rejects unsupported bootstrap Node %s before installation', version => {
    expect(() => assertBootstrapNode(version)).toThrow(/Node.js 22.12.0\+.*Node.js 24 LTS/);
  });
  it.each(['22.12.0', '22.23.2', '24.18.0'])('accepts supported bootstrap Node %s', version => {
    expect(() => assertBootstrapNode(version)).not.toThrow();
  });

  it('performs real SQL, vector distance and PNG encoding/decoding under the test Electron', async () => {
    expect(process.versions.electron).toBeTruthy();
    expect(await probeSqlite(requirePackage)).toMatchObject({ vectorDistance: 5 });
    expect(await probeSharp(requirePackage)).toEqual({ sharp: 'png-2x2' });
  });

  it('runs the complete check in the installed Electron child', () => {
    expect(verifyNativeDependencies()).toMatchObject({ status: 'passed', sharp: 'png-2x2', vectorDistance: 5 });
  });

  it('closes an in-memory database and identifies a missing vector extension without exposing paths', async () => {
    const close = vi.fn();
    const req = (name: string) => {
      if (name === 'better-sqlite3') return class {
        close = close;
        prepare() { return { get: () => ({ answer: 42 }) }; }
        loadExtension() { throw new Error('/private/user/library/vec0.dll'); }
      };
      return { getLoadablePath: () => '/private/user/library/vec0.dll' };
    };
    await expect(probeSqlite(req)).rejects.toThrow(/sqlite-vec.*native:repair/);
    expect(close).toHaveBeenCalledOnce();
    await expect(probeSqlite(req)).rejects.not.toThrow('/private');
  });

  it('rejects an image engine that loads but cannot decode its output', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const sharp = (input: unknown) => Buffer.isBuffer(input)
      ? { metadata: async () => ({ format: 'png', width: 1, height: 2 }) }
      : { png: () => ({ toBuffer: async () => png }) };
    await expect(probeSharp(() => sharp)).rejects.toThrow(/sharp.*PNG encoding\/decoding/);
  });

  it('rejects dependency version drift before launching any child', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-native-version-'));
    temporary.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/electron': { version: '42.8.0' } } }));
    const spawn = vi.fn();
    expect(() => verifyNativeDependencies({ packageRoot: root, spawn })).toThrow(/electron.*native:repair/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports a missing lockfile with recovery instructions and no filesystem path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-native-lock-'));
    temporary.push(root);
    const spawn = vi.fn();
    expect(() => verifyNativeDependencies({ packageRoot: root, spawn })).toThrow(/restore.*lockfile.*native:repair/);
    expect(() => verifyNativeDependencies({ packageRoot: root, spawn })).not.toThrow(root);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['empty success', { status: 0, stdout: '' }],
    ['incomplete success', { status: 0, stdout: '{"status":"passed"}' }],
    ['timeout', { status: null, error: { code: 'ETIMEDOUT' } }],
    ['loader failure', { status: 1, stderr: '/private/location: missing DLL' }],
  ])('rejects %s with an actionable error', (_label, result) => {
    const spawn = vi.fn(() => result);
    expect(() => verifyNativeDependencies({ spawn })).toThrow(/native:repair/);
    expect(() => verifyNativeDependencies({ spawn })).not.toThrow('/private');
    expect(spawn.mock.calls[0][2]).toMatchObject({ timeout: PROBE_TIMEOUT_MS, env: { ELECTRON_RUN_AS_NODE: '1' } });
  });

  it('stops development preparation before reporting readiness when the native check fails', () => {
    const calls: string[] = [];
    const output: string[] = [];
    const exit = vi.fn(() => { throw new Error('exit'); });
    const entry = path.join(process.cwd(), 'scripts/ensure-dev-dependencies.cjs');
    const module = { exports: {} };
    const req: any = (name: string) => name === 'node:child_process'
      ? { spawnSync: (_node: string, args: string[]) => {
        const script = path.basename(args[0]); calls.push(script);
        return { status: script === 'verify-native-dependencies.cjs' && !args.includes('--host-only') ? 1 : 0 };
      } } : requirePackage(name.startsWith('.') ? path.resolve(path.dirname(entry), name) : name);
    req.main = module;
    expect(() => vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
      require: req, module, __dirname: path.dirname(entry),
      process: { execPath: process.execPath, env: {}, platform: 'win32', arch: 'x64', exit },
      console: { log: (s: string) => output.push(s), error: (s: string) => output.push(s) },
    })).toThrow('exit');
    expect(calls).toContain('ensure-sqlite-electron-abi.mjs');
    expect(calls.at(-1)).toBe('verify-native-dependencies.cjs');
    expect(output.join('\n')).toContain('native dependencies failed');
    expect(output.join('\n')).not.toContain('built-in dependencies ready');
  });

  it('keeps one repair command guarded before install and verified afterward', () => {
    const pkg = requirePackage('./package.json');
    expect(pkg.engines.node).toBe('>=22.12.0');
    expect(pkg.scripts['native:repair']).toBe('node scripts/verify-native-dependencies.cjs --host-only && npm install --include=optional --no-save && npm run native:check');
    expect(pkg.scripts['native:check']).toBe('node scripts/verify-native-dependencies.cjs');
  });
});
