import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requirePackage = createRequire(path.join(process.cwd(), 'package.json'));
const { assertBootstrapNode, verifySharpRuntime, verifyNativeDependencies, PROBE_TIMEOUT_MS } = requirePackage('./scripts/verify-native-dependencies.cjs');
const { probeSqlite } = requirePackage('./scripts/native-dependency-probe.cjs');
const temporary: string[] = [];
const linuxSharpWarning = "(process:123): GLib-GObject-CRITICAL **: 03:37:35.946: g_object_ref: assertion 'G_IS_OBJECT (object)' failed\n(node:123) [SharpElectronLinux] Warning: Binaries provided by Electron for use on Linux may be incompatible with sharp - see https://sharp.pixelplumbing.com/install#electron-and-linux\n(Use `electron --trace-warnings ...` to show where the warning was created)\n";
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('source native dependency readiness', () => {
  it.each(['20.19.0', '22.11.0', 'invalid', '22.12', '22.12.0-rc.1'])('rejects unsupported bootstrap Node %s before installation', version => {
    expect(() => assertBootstrapNode(version)).toThrow(/Node.js 22.12.0\+.*Node.js 24 LTS/);
  });
  it.each(['22.12.0', '22.23.2', '24.18.0'])('accepts supported bootstrap Node %s', version => {
    expect(() => assertBootstrapNode(version)).not.toThrow();
  });

  it('performs SQL/vector operations in Electron and PNG operations in bundled Node', async () => {
    expect(process.versions.electron).toBeTruthy();
    expect(await probeSqlite(requirePackage)).toMatchObject({ vectorDistance: 5 });
    expect(verifySharpRuntime()).toMatchObject({ sharp: 'png-2x2', electron: null });
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
    ['known warning without functional proof', { status: 0, stdout: '{"status":"passed"}', stderr: linuxSharpWarning }],
  ])('rejects %s with an actionable error', (_label, result) => {
    const spawn = vi.fn(() => result);
    expect(() => verifyNativeDependencies({ spawn })).toThrow(/native:repair/);
    expect(() => verifyNativeDependencies({ spawn })).not.toThrow('/private');
    expect(spawn.mock.calls[0][2]).toMatchObject({ timeout: PROBE_TIMEOUT_MS, env: { ELECTRON_RUN_AS_NODE: '1' } });
  });

  it('rejects a missing bundled Node without falling back to Electron', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-runtime-'));
    temporary.push(root);
    const spawn = vi.fn();
    expect(() => verifySharpRuntime({ packageRoot: root, spawn })).toThrow(/bundled Node.*native:repair/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['missing functional proof', { status: 0, stdout: '{"status":"passed"}' }],
    ['native diagnostic', { status: 0, stderr: linuxSharpWarning }],
    ['loader failure', { status: 1, stderr: '/private/image.dll: missing library' }],
    ['timeout', { status: null, error: { code: 'ETIMEDOUT' } }],
  ])('rejects image runtime %s without exposing private diagnostics', (_label, result) => {
    const spawn = vi.fn(() => result);
    expect(() => verifySharpRuntime({ spawn })).toThrow(/native:repair/);
    expect(() => verifySharpRuntime({ spawn })).not.toThrow('/private');
    expect(spawn.mock.calls[0][2].env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(spawn.mock.calls[0][2].timeout).toBe(PROBE_TIMEOUT_MS);
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
    expect(pkg.scripts['native:repair']).toBe('node scripts/verify-native-dependencies.cjs --host-only && npm install --include=optional --no-save && node bin/ensure-runtime.cjs --kind node && npm run native:check');
    expect(pkg.scripts['native:check']).toBe('node scripts/verify-native-dependencies.cjs');
  });
});
