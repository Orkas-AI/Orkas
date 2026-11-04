import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';

// Run the actual boot module with isolated Windows paths and filesystem faults.
// Fixtures model reported disk metadata, not a native Google Drive driver.
const typedFile = path.resolve(__dirname, '../../src/main/install-data-root.ts');
const sourceFile = fs.existsSync(typedFile) ? typedFile : path.resolve(__dirname, '../../src/main/install-data-root.cjs');
const source = fs.readFileSync(sourceFile, 'utf8');
const compiled = sourceFile.endsWith('.ts')
  ? ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  : source;
const win = path.win32;
const PIN = 'C:\\Profile\\Orkas\\install-pin.json';
const oldPin = '{ "container": "G:\\\\.orkas", "chosenAt": "original" }';
type Kind = 'local' | 'nonlocal' | 'unknown';

function fixture(options: {
  pin?: string; kind?: Kind; missingDrive?: boolean; inventoryFailure?: boolean;
  inventoryRaw?: string; badCandidate?: boolean; allBad?: boolean; commitFailure?: boolean;
  pinFailure?: boolean; badRead?: string; linkAt?: string; badSelected?: boolean; kindChanges?: boolean; onTemporary?: (f: any) => void; entries?: string[]; onLock?: (f: any) => void;
} = {}) {
  const files = new Map<string, string>();
  const dirs = new Set(['C:\\', 'D:\\', 'G:\\', 'C:\\Profile', 'C:\\Profile\\Orkas']);
  const reads: string[] = [], operations: string[][] = [], warnings: string[] = [], migrations: string[] = [];
  let inventoryCalls = 0;
  if (options.missingDrive) dirs.delete('G:\\');
  if (options.pin) files.set(PIN, options.pin);
  const error = (code: string) => Object.assign(new Error(code), { code });
  const norm = (p: any) => win.normalize(String(p));
  function addFile(p: string, value = 'user data') {
    p = norm(p); files.set(p, value);
    for (let parent = win.dirname(p); ; parent = win.dirname(parent)) {
      dirs.add(parent); if (win.dirname(parent) === parent) break;
    }
  }
  for (const p of options.entries || []) addFile(p);
  const fsMock: any = {
    existsSync(p: string) { p = norm(p); return dirs.has(p) || files.has(p); },
    lstatSync(p: string) {
      p = norm(p); reads.push(p);
      if (options.badRead && p.startsWith(options.badRead)) throw error('EACCES');
      if (!dirs.has(p) && !files.has(p)) throw error('ENOENT');
      return { isDirectory: () => dirs.has(p), isFile: () => files.has(p), isSymbolicLink: () => p === options.linkAt, size: files.get(p)?.length || 0 };
    },
    statSync(p: string) { return this.lstatSync(p); },
    readFileSync(p: string) { p = norm(p); reads.push(p); if (!files.has(p)) throw error('ENOENT'); return files.get(p)!; },
    opendirSync(p: string) {
      p = norm(p); reads.push(p); this.lstatSync(p);
      const children = [...new Set([...dirs, ...files.keys()].filter(x => x !== p && win.dirname(x) === p).map(x => win.basename(x)))];
      let index = 0;
      return { readSync: () => index < children.length ? { name: children[index++] } : null, closeSync() {} };
    },
    mkdirSync(p: string, opts?: any) {
      p = norm(p); operations.push(['mkdir', p]);
      if (options.badSelected && p.startsWith('G:\\')) throw error('EACCES');
      if ((options.badCandidate && p.startsWith('D:\\')) || (options.allBad && (p.startsWith('D:\\') || p === 'C:\\.orkas\\data'))) throw error('EACCES');
      if (p.endsWith('.lock') && dirs.has(p)) throw error('EEXIST');
      dirs.add(p);
      if (p.endsWith('.lock')) options.onLock?.({ files, dirs, addFile });
      if (opts?.recursive) for (let parent = win.dirname(p); ; parent = win.dirname(parent)) { dirs.add(parent); if (win.dirname(parent) === parent) break; }
    },
    writeFileSync(p: string, body: any, opts?: any) {
      p = norm(p); operations.push(['write', p]);
      if (options.pinFailure && p.startsWith(PIN)) throw error('EACCES');
      if (opts?.flag === 'wx' && files.has(p)) throw error('EEXIST');
      files.set(p, String(body));
      if (p.startsWith(PIN + '.') && p.endsWith('.tmp')) options.onTemporary?.({ files, dirs, addFile });
    },
    renameSync(a: string, b: string) {
      a = norm(a); b = norm(b); operations.push(['rename', a, b]);
      if (options.commitFailure && b === PIN) throw error('EACCES');
      if (!files.has(a)) throw error('ENOENT'); files.set(b, files.get(a)!); files.delete(a);
    },
    openSync(p: string) { if (!files.has(norm(p))) throw error('ENOENT'); return 5; },
    fsyncSync() {}, closeSync() {},
    unlinkSync(p: string) { p = norm(p); operations.push(['unlink', p]); files.delete(p); },
    rmdirSync(p: string) { dirs.delete(norm(p)); },
    rmSync(p: string) { p = norm(p); operations.push(['rm', p]); files.delete(p); },
  };
  function boot() {
    const env: Record<string, string> = { LOCALAPPDATA: 'C:\\Profile', SystemDrive: 'C:', SystemRoot: 'C:\\Windows' };
    const module = { exports: {} };
    const requireMock = (id: string): any => {
      if (id === 'node:fs') return fsMock;
      if (id === 'node:path') return win;
      if (id === 'node:os') return { homedir: () => 'C:\\User' };
      if (id === 'node:crypto') return { randomUUID: () => 'fixture-' + operations.length };
      if (id === 'node:child_process') return { execFileSync: () => {
        inventoryCalls++;
        if (options.inventoryFailure) throw error('ETIMEDOUT');
        return options.inventoryRaw ?? JSON.stringify({ version: 1, drives: [
          { id: 'C:', kind: 'local' }, { id: 'D:', kind: 'local' }, { id: 'G:', kind: options.kindChanges && inventoryCalls > 1 ? 'unknown' : options.kind || 'unknown' },
        ] });
      } };
      if (id.includes('migrate-')) return {
        migratePcDataRoot: (p: string) => migrations.push(p), migrateSourceDataRoot: (p: string) => migrations.push(p),
      };
      throw new Error('Unexpected dependency: ' + id);
    };
    let failure: any;
    try {
      vm.runInNewContext(compiled, { require: requireMock, module, exports: module.exports, process: { platform: 'win32', env, stderr: { write: (s: string) => warnings.push(s) } }, __dirname: 'C:\\Source\\src\\main' }, { timeout: 2000 });
    } catch (error) { failure = error; }
    return { root: env.ORKAS_WORKSPACE_ROOT, error: failure, exports: module.exports as any };
  }
  return { files, dirs, reads, operations, warnings, migrations, boot, addFile, inventoryCalls: () => inventoryCalls };
}

describe('Windows user data location preservation', () => {
  it.each(['local', 'unknown'] as const)('keeps an existing %s pin byte-for-byte even when empty', kind => {
    const f = fixture({ pin: oldPin, kind }); const result = f.boot();
    expect(result.root).toBe('G:\\.orkas\\data'); expect(f.files.get(PIN)).toBe(oldPin);
    expect(f.operations.some(o => o.includes(PIN))).toBe(false);
  });
  it.each(['local', 'unknown', 'nonlocal'] as const)('never replaces a disconnected %s pin', kind => {
    const f = fixture({ pin: oldPin, kind, missingDrive: true }); f.boot();
    expect(f.files.get(PIN)).toBe(oldPin); expect(f.operations.some(o => o.includes(PIN))).toBe(false);
  });
  it.each(['G:\\.orkas\\data\\users.json', 'G:\\.orkas\\data\\uid\\cloud\\chat.json', 'G:\\.orkas\\userWorkSpace\\draft.txt', 'G:\\.orkas\\data\\.migrated-from-source'])('preserves nonlocal real data at %s', entry => {
    const f = fixture({ pin: oldPin, kind: 'nonlocal', entries: [entry] }); f.boot();
    expect(f.files.get(PIN)).toBe(oldPin); expect(f.files.get(entry)).toBe('user data');
    expect(f.operations.filter(o => o[0] === 'rm' || o[0] === 'unlink').some(o => o[1].startsWith('G:'))).toBe(false);
  });
  it('treats inaccessible real data as unknown, not empty', () => {
    const f = fixture({ pin: oldPin, kind: 'nonlocal', entries: ['G:\\.orkas\\data\\users.json'], badRead: 'G:\\.orkas' }); f.boot();
    expect(f.files.get(PIN)).toBe(oldPin);
  });
  it('keeps the pin if drive discovery fails', () => {
    const f = fixture({ pin: oldPin, inventoryFailure: true }); f.boot(); expect(f.files.get(PIN)).toBe(oldPin);
  });
  it('moves only a positively nonlocal empty pin, and reopens the committed location', () => {
    const f = fixture({ pin: oldPin, kind: 'nonlocal' });
    expect(f.boot().root).toBe('D:\\.orkas\\data');
    expect(JSON.parse(f.files.get(PIN)!).container).toBe('D:\\.orkas');
    expect(f.boot().root).toBe('D:\\.orkas\\data');
    expect(f.migrations).toEqual(['D:\\.orkas', 'D:\\.orkas']);
  });
  it('ignores data_test entirely when deciding whether a nonlocal pin has real data', () => {
    const f = fixture({ pin: oldPin, kind: 'nonlocal', entries: ['G:\\.orkas\\data_test\\uid\\chat.json'], badRead: 'G:\\.orkas\\data_test' });
    expect(f.boot().root).toBe('D:\\.orkas\\data');
    expect(f.reads.some(p => p.includes('data_test'))).toBe(false);
    expect(f.files.has('G:\\.orkas\\data_test\\uid\\chat.json')).toBe(true);
  });
  it('abandons relocation when real data appears before pin publication', () => {
    const f = fixture({ pin: oldPin, kind: 'nonlocal', onLock: f => f.addFile('G:\\.orkas\\data\\new.json') });
    expect(f.boot().root).toBe('G:\\.orkas\\data'); expect(f.files.get(PIN)).toBe(oldPin);
  });
  it('defers to a concurrent pin winner instead of overwriting it', () => {
    const winner = JSON.stringify({ container: 'C:\\.orkas', chosenAt: 'winner' });
    const f = fixture({ pin: oldPin, kind: 'nonlocal', onLock: f => f.files.set(PIN, winner) });
    expect(f.boot().root).toBe('C:\\.orkas\\data'); expect(f.files.get(PIN)).toBe(winner);
  });
  it('retains the old pin and does not migrate if atomic publication fails', () => {
    const f = fixture({ pin: oldPin, kind: 'nonlocal', commitFailure: true });
    expect(f.boot().error).toBeTruthy(); expect(f.files.get(PIN)).toBe(oldPin); expect(f.migrations).toEqual([]);
  });
  it('does not overwrite a malformed existing pin', () => {
    const f = fixture({ pin: '{broken' }); expect(f.boot().error).toBeTruthy(); expect(f.files.get(PIN)).toBe('{broken');
    expect(f.migrations).toEqual([]);
  });
  it('chooses verified local D over provider-backed or unknown G on first launch', () => {
    const f = fixture(); expect(f.boot().root).toBe('D:\\.orkas\\data');
    expect(JSON.parse(f.files.get(PIN)!).container).toBe('D:\\.orkas');
  });
  it('tries the system drive when a fresh local candidate cannot be prepared', () => {
    const f = fixture({ badCandidate: true }); expect(f.boot().root).toBe('C:\\.orkas\\data');
    expect(JSON.parse(f.files.get(PIN)!).container).toBe('C:\\.orkas');
  });
  it('does not pin any destination or migrate when all fresh candidates fail', () => {
    const f = fixture({ allBad: true }); expect(f.boot().error).toBeTruthy(); expect(f.files.has(PIN)).toBe(false); expect(f.migrations).toEqual([]);
  });
  it('does not start at an unrecorded destination if pin persistence fails', () => {
    const f = fixture({ pinFailure: true }); expect(f.boot().error).toBeTruthy(); expect(f.files.has(PIN)).toBe(false); expect(f.migrations).toEqual([]);
  });
  it('keeps a local pin when its selected directory is unwritable', () => {
    const f = fixture({ pin: oldPin, kind: 'local', badSelected: true });
    expect(f.boot().error).toBeTruthy(); expect(f.files.get(PIN)).toBe(oldPin);
    expect(f.operations.some(o => o.includes(PIN))).toBe(false);
  });
  it('does not classify a nonlocal reparse-point container as empty', () => {
    const f = fixture({ pin: oldPin, kind: 'nonlocal', entries: ['G:\\.orkas\\data_test\\file'], linkAt: 'G:\\.orkas' });
    f.boot(); expect(f.files.get(PIN)).toBe(oldPin);
  });
  it('counts a zero-byte real user file as data', () => {
    const f = fixture({ pin: oldPin, kind: 'nonlocal' }); f.addFile('G:\\.orkas\\data\\users.json', '');
    f.boot(); expect(f.files.get(PIN)).toBe(oldPin); expect(f.inventoryCalls()).toBe(0);
  });
  it('retains an existing selection if locality becomes unknown at publication', () => {
    const f = fixture({ pin: oldPin, kind: 'nonlocal', kindChanges: true });
    expect(f.boot().root).toBe('G:\\.orkas\\data'); expect(f.files.get(PIN)).toBe(oldPin);
  });
  it('does not switch when real data appears after the replacement file is prepared', () => {
    const f = fixture({ pin: oldPin, kind: 'nonlocal', onTemporary: f => f.addFile('G:\\.orkas\\userWorkSpace\\late.txt') });
    expect(f.boot().root).toBe('G:\\.orkas\\data'); expect(f.files.get(PIN)).toBe(oldPin);
  });
  it.each(['nonlocal', 'unknown'] as const)('uses the system drive with only C and %s G on first launch', kind => {
    const f = fixture({ inventoryRaw: JSON.stringify({ version: 1, drives: [{ id: 'C:', kind: 'local' }, { id: 'G:', kind }] }) });
    expect(f.boot().root).toBe('C:\\.orkas\\data');
    expect(f.operations.some(o => o.some(p => p.startsWith('G:')))).toBe(false);
  });
  it('retains the selected pin after malformed discovery output', () => {
    const f = fixture({ pin: oldPin, inventoryRaw: '{invalid' }); f.boot(); expect(f.files.get(PIN)).toBe(oldPin);
  });
  it('does not hide existing local real data behind a fresh install', () => {
    const f = fixture({ entries: ['D:\\.orkas\\data\\uid\\chat.json'], badCandidate: true });
    expect(f.boot().error).toBeTruthy(); expect(f.files.has(PIN)).toBe(false); expect(f.migrations).toEqual([]);
  });
  it('does not treat abandoned empty preparation directories as real user data', () => {
    const f = fixture({ badCandidate: true }); f.dirs.add('D:\\.orkas'); f.dirs.add('D:\\.orkas\\data');
    expect(f.boot().root).toBe('C:\\.orkas\\data');
  });
  it('does not steal an existing publication lock', () => {
    const f = fixture({ pin: oldPin, kind: 'nonlocal' }); f.dirs.add(PIN + '.lock');
    expect(f.boot().error).toBeTruthy(); expect(f.files.get(PIN)).toBe(oldPin); expect(f.dirs.has(PIN + '.lock')).toBe(true);
  });
  it('validates structured drive facts instead of accepting partial or ambiguous output', () => {
    const f = fixture({ pin: oldPin, kind: 'local' }); const root = f.boot().exports;
    expect(root.parseWindowsDriveInventory('\uFEFF' + JSON.stringify({ version: 1, drives: [{ id: 'd:', kind: 'local' }, { id: 'G:', kind: 'unknown' }] })))
      .toEqual([{ id: 'D:', kind: 'local' }, { id: 'G:', kind: 'unknown' }]);
    for (const doc of [{}, { version: 1, drives: null }, { version: 1, drives: [{ id: 'G:', kind: 'fixed' }] },
      { version: 1, drives: [{ id: 'G:', kind: 'local' }, { id: 'g:', kind: 'nonlocal' }] },
      { version: 1, drives: [{ id: '\\\\server\\share', kind: 'local' }] }]) {
      expect(() => root.parseWindowsDriveInventory(JSON.stringify(doc))).toThrow();
    }
  });
  it.skipIf(process.platform !== 'win32')('reads real Windows disk metadata with the exact production probe', () => {
    const f = fixture({ pin: oldPin, kind: 'local' }); const root = f.boot().exports;
    const probe = root.windowsFixedDriveProbe(process.env);
    const rows = root.parseWindowsDriveInventory(execFileSync(probe.file, probe.args, probe.options));
    expect(rows).toContainEqual({ id: (process.env.SystemDrive || 'C:').toUpperCase(), kind: 'local' });
  });

  it.each(['failure', 'empty'])('persists the system fallback after discovery %s', kind => {
    const f = fixture({ inventoryFailure: kind === 'failure', inventoryRaw: JSON.stringify({ version: 1, drives: [] }) });
    expect(f.boot().root).toBe('C:\\.orkas\\data');
    const committed = f.files.get(PIN)!; expect(JSON.parse(committed).container).toBe('C:\\.orkas');
    f.addFile('C:\\.orkas\\data\\uid\\chat.json');
    expect(f.boot().root).toBe('C:\\.orkas\\data'); expect(f.files.get(PIN)).toBe(committed); expect(f.inventoryCalls()).toBe(1);
  });
  it('uses bounded hidden absolute PowerShell with structured output in both editions', () => {
    const root = fixture({ pin: oldPin, kind: 'local' }).boot().exports;
    const probe = root.windowsFixedDriveProbe({ SystemRoot: 'D:\\Windows' });
    expect(probe.file).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(probe.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(probe.args[4]).toContain('Win32_LogicalDiskToPartition');
    expect(probe.args[4]).toContain('ConvertTo-Json');
    expect(probe.options).toEqual({ encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 65536 });
  });
  it.skipIf(sourceFile.endsWith('.ts'))('preserves a public legacy custom pin without applying hosted-only path restrictions', () => {
    const pin = JSON.stringify({ container: 'G:\\CustomData', chosenAt: 'legacy' });
    const f = fixture({ pin, kind: 'nonlocal' }); expect(f.boot().root).toBe('G:\\CustomData\\data'); expect(f.files.get(PIN)).toBe(pin);
  });

});
