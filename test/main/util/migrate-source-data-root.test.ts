import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function load(file: string, overrides: Record<string, unknown>) {
  const filename = path.resolve(file), module = { exports: {} as any };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    require: (name: string) => name in overrides ? overrides[name] : require(name),
    process: overrides.process || process, Buffer,
  }, { filename });
  return module.exports;
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-source-migration-')); roots.push(root);
  const repo = path.join(root, 'source'), container = path.join(root, 'container');
  const src = path.join(repo, 'data/users.json'), dst = path.join(container, 'data/users.json');
  for (const [file, uid] of [[src, 'source-user'], [dst, 'target-user']]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ current_user_id: uid, users: [{ user_id: uid, created_at: '2026-01-01' }] }));
  }
  return { root, repo, container, src, dst };
}
describe('source-run boot migration continuity', () => {
  for (const fault of ['partial-write', 'publish']) it(`preserves both registries and retries after ${fault}`, () => {
    const f = fixture(), sourceBefore = fs.readFileSync(f.src, 'utf8'), targetBefore = fs.readFileSync(f.dst, 'utf8');
    let fail = true, injected = false;
    const fakeFs = { ...fs,
      writeFileSync(file: any, body: any, opts: any) {
        if (fail && fault === 'partial-write' && path.dirname(String(file)) === path.dirname(f.dst)
          && path.basename(String(file)).startsWith('users.json')) {
          injected = true; fs.writeFileSync(file, '{"partial":', opts); throw new Error('synthetic disk failure');
        }
        return fs.writeFileSync(file, body, opts);
      },
      renameSync(from: any, to: any) {
        if (fail && fault === 'publish' && String(to) === f.dst) { injected = true; throw new Error('synthetic disk failure'); }
        return fs.renameSync(from, to);
      },
    };
    const migration = load('src/main/util/migrate-source-data-root.cjs', { 'node:fs': fakeFs });
    expect(() => migration.migrateSourceDataRoot(f.container, f.repo)).toThrow('synthetic disk failure');
    expect(injected).toBe(true);
    expect(fs.readFileSync(f.src, 'utf8')).toBe(sourceBefore);
    expect(fs.readFileSync(f.dst, 'utf8')).toBe(targetBefore);
    expect(fs.readdirSync(path.dirname(f.dst))).toEqual(['users.json']);
    fail = false; migration.migrateSourceDataRoot(f.container, f.repo);
    const merged = JSON.parse(fs.readFileSync(f.dst, 'utf8'));
    expect(merged.users.map((user: any) => user.user_id).sort()).toEqual(['source-user', 'target-user']);
    expect(merged.current_user_id).toBe('source-user');
    expect(fs.existsSync(f.src)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(f.dst), '.migrated-from-source'))).toBe(true);
    migration.migrateSourceDataRoot(f.container, f.repo);
    expect(JSON.parse(fs.readFileSync(f.dst, 'utf8'))).toEqual(merged);
  });
  it('keeps early boot diagnostics free of private source paths and error text', () => {
    const f = fixture(), output: string[] = [], env: Record<string, string> = {};
    const root = load('src/main/install-data-root.cjs', {
      'node:os': { ...os, homedir: () => f.root },
      './util/migrate-source-data-root.cjs': { migrateSourceDataRoot() { throw new Error('EACCES /private/person/personal-file.json'); } },
      process: { platform: 'darwin', env, stderr: { write: (message: string) => output.push(message) } },
    });
    const diagnostics: string[] = []; root.flushEarlyDiagnostics((value: string) => diagnostics.push(value));
    expect(diagnostics).toEqual(['[install-data-root] source-run data migration failed']);
    expect(output).toEqual(['[install-data-root] source-run data migration failed\n']);
    expect(env.ORKAS_WORKSPACE_ROOT).toBe(path.join(f.root, '.orkas/data'));
    root.flushEarlyDiagnostics((value: string) => diagnostics.push(value)); expect(diagnostics).toHaveLength(1);
  });
});

// The public pre-tsx CJS boot owner probes Windows itself. Use its real resolver
// with only OS/filesystem boundaries controlled; never launch host PowerShell
// or write a real installation pin while verifying the native argv contract.
function windowsInstallRoot(probe: () => string) {
  const files = new Map<string, string>();
  const execute = vi.fn((_command: string, _args: string[], _options: {
    encoding: string; timeout: number; windowsHide: boolean;
  }) => probe());
  const owner = load('src/main/install-data-root.cjs', {
    'node:path': path.win32,
    'node:os': { homedir: () => 'C:\\Users\\Fixture' },
    'node:child_process': { execFileSync: execute },
    'node:fs': {
      readFileSync(file: string) {
        if (!files.has(file)) throw Object.assign(new Error('No fixture pin'), { code: 'ENOENT' });
        return files.get(file);
      },
      existsSync: (file: string) => ['C:\\', 'D:\\', 'E:\\'].includes(file),
      mkdirSync() {},
      writeFileSync: (file: string, body: string) => files.set(file, body),
    },
    process: { platform: 'win32', env: { SystemDrive: 'C:', LOCALAPPDATA: 'C:\\FixtureLocal',
      ORKAS_WORKSPACE_ROOT: 'isolated-bootstrap-override' }, stderr: { write: vi.fn() } },
  });
  return { owner, execute, files };
}

describe('public Windows install-root process boundary', () => {
  it('probes only fixed disks with bounded native argv and reuses the chosen installation pin', () => {
    const f = windowsInstallRoot(() => 'E:\r\nC:\r\nD:\r\ninvalid drive\r\n');
    expect(f.owner.resolveInstallContainer()).toBe('D:\\.orkas');
    expect(f.execute).toHaveBeenCalledExactlyOnceWith('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID",
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    expect(JSON.parse(f.files.get('C:\\FixtureLocal\\Orkas\\install-pin.json')!).container).toBe('D:\\.orkas');
    expect(f.owner.resolveInstallContainer()).toBe('D:\\.orkas');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it.each(['failure', 'no fixed disks'])('falls back to the system drive after probe %s and persists that decision', kind => {
    const f = windowsInstallRoot(() => {
      if (kind === 'failure') throw new Error('controlled unavailable PowerShell');
      return 'unrecognized probe output\n';
    });
    expect(f.owner.resolveInstallContainer()).toBe('C:\\.orkas');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0][2]).toMatchObject({ timeout: 5000, windowsHide: true });
    expect(JSON.parse(f.files.get('C:\\FixtureLocal\\Orkas\\install-pin.json')!).container).toBe('C:\\.orkas');
    expect(f.owner.resolveInstallContainer()).toBe('C:\\.orkas');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
