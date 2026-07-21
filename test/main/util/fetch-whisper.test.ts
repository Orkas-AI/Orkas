import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const fetchWhisper = require('../../../scripts/fetch-whisper.cjs') as {
  expectedFiles: (target: any) => Record<string, { bytes: number; sha256: string }>;
  isWindowsIllegalInstruction: (status: number | null) => boolean;
  matchesFile: (file: string, expected: { bytes: number; sha256: string }) => boolean;
  noticeForTarget: (target: any) => string;
  replaceDirectoryTransactional: (
    tempDir: string,
    destDir: string,
    options?: Record<string, unknown>,
  ) => void;
  runtimeVersion: (target: any) => string;
  targetOptions: (argv: string[]) => { platform: string; arch: string; force: boolean };
  writeCapabilityState: (dir: string, capability: { status: string; reason?: string }) => void;
};
const { WHISPER_RUNTIME_CONTRACT } = require('../../../bin/runtime-gate.cjs') as {
  WHISPER_RUNTIME_CONTRACT: any;
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fetch-whisper', () => {
  it('parses the explicit package target without a system-install option', () => {
    expect(fetchWhisper.targetOptions([
      'node', 'fetch-whisper.cjs', '--platform', 'win32', '--arch', 'x64', '--force',
    ])).toEqual({ platform: 'win32', arch: 'x64', force: true });
  });

  it('keeps the checked-in macOS CLIs and licenses pinned to the runtime contract', () => {
    const vendor = path.join(process.cwd(), 'vendor', 'whisper', `v${WHISPER_RUNTIME_CONTRACT.version}`);
    for (const key of ['darwin-arm64', 'darwin-x64']) {
      const spec = WHISPER_RUNTIME_CONTRACT.targets[key].files['bin/whisper-cli'];
      expect(fetchWhisper.matchesFile(path.join(vendor, key, 'whisper-cli'), spec)).toBe(true);
    }
    for (const [name, spec] of Object.entries(WHISPER_RUNTIME_CONTRACT.licenses)) {
      expect(fetchWhisper.matchesFile(path.join(vendor, name), spec as any)).toBe(true);
    }
  });

  it('recognizes signed and unsigned Windows illegal-instruction exit codes', () => {
    expect(fetchWhisper.isWindowsIllegalInstruction(-1073741795)).toBe(true);
    expect(fetchWhisper.isWindowsIllegalInstruction(0xC000001D)).toBe(true);
    expect(fetchWhisper.isWindowsIllegalInstruction(1)).toBe(false);
    expect(fetchWhisper.isWindowsIllegalInstruction(null)).toBe(false);
  });

  it('allows Windows to advance to the CPU-dispatch release without changing pinned macOS builds', () => {
    const windows = WHISPER_RUNTIME_CONTRACT.targets['win32-x64'];
    const darwin = WHISPER_RUNTIME_CONTRACT.targets['darwin-x64'];
    expect(fetchWhisper.runtimeVersion(windows)).toBe('1.9.1');
    expect(fetchWhisper.runtimeVersion(darwin)).toBe(WHISPER_RUNTIME_CONTRACT.version);
    expect(fetchWhisper.noticeForTarget(windows)).toContain('runtime version is 1.9.1');
    expect(fetchWhisper.noticeForTarget(windows)).toContain('OpenBLAS/tree/v0.3.29');
    expect(fetchWhisper.noticeForTarget(windows)).toContain('see LICENSE.openblas');
    expect(fetchWhisper.noticeForTarget(darwin)).toContain(`runtime version is ${WHISPER_RUNTIME_CONTRACT.version}`);
    expect(fetchWhisper.noticeForTarget(darwin)).not.toContain('LICENSE.openblas');
  });

  it('persists an unsupported-CPU capability state without changing verified file records', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-whisper-marker-'));
    tempDirs.push(dir);
    const markerFile = path.join(dir, '.orkas-whisper-ready.json');
    fs.writeFileSync(markerFile, JSON.stringify({ schema: 1, files: { cli: { bytes: 1 } }, capability: { status: 'ready' } }));

    fetchWhisper.writeCapabilityState(dir, { status: 'disabled', reason: 'unsupported_cpu' });

    expect(JSON.parse(fs.readFileSync(markerFile, 'utf8'))).toEqual({
      schema: 1,
      files: { cli: { bytes: 1 } },
      capability: { status: 'disabled', reason: 'unsupported_cpu' },
    });
  });

  it('retries transient Windows rename failures and removes the previous runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-whisper-swap-'));
    tempDirs.push(root);
    const temp = path.join(root, 'next');
    const dest = path.join(root, 'current');
    const backup = path.join(root, 'backup');
    fs.mkdirSync(temp);
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(temp, 'marker'), 'new');
    fs.writeFileSync(path.join(dest, 'marker'), 'old');
    let nextRenameFailures = 2;
    const fakeFs = {
      ...fs,
      renameSync(source: fs.PathLike, target: fs.PathLike) {
        if (source === temp && target === dest && nextRenameFailures-- > 0) {
          throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
        }
        fs.renameSync(source, target);
      },
    };

    fetchWhisper.replaceDirectoryTransactional(temp, dest, {
      fs: fakeFs,
      backupDir: backup,
      retries: 2,
      retryDelayMs: 0,
      wait: () => {},
    });

    expect(fs.readFileSync(path.join(dest, 'marker'), 'utf8')).toBe('new');
    expect(fs.existsSync(backup)).toBe(false);
  });

  it('restores the previous runtime when the replacement cannot be renamed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-whisper-rollback-'));
    tempDirs.push(root);
    const temp = path.join(root, 'next');
    const dest = path.join(root, 'current');
    const backup = path.join(root, 'backup');
    fs.mkdirSync(temp);
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(temp, 'marker'), 'new');
    fs.writeFileSync(path.join(dest, 'marker'), 'old');
    const fakeFs = {
      ...fs,
      renameSync(source: fs.PathLike, target: fs.PathLike) {
        if (source === temp && target === dest) {
          throw Object.assign(new Error('persistently locked'), { code: 'EPERM' });
        }
        fs.renameSync(source, target);
      },
    };

    expect(() => fetchWhisper.replaceDirectoryTransactional(temp, dest, {
      fs: fakeFs,
      backupDir: backup,
      retries: 1,
      retryDelayMs: 0,
      wait: () => {},
    })).toThrow('persistently locked');

    expect(fs.readFileSync(path.join(dest, 'marker'), 'utf8')).toBe('old');
    expect(fs.readFileSync(path.join(temp, 'marker'), 'utf8')).toBe('new');
    expect(fs.existsSync(backup)).toBe(false);
  });

  it('recovers a previous interrupted swap before installing the next runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-whisper-recover-'));
    tempDirs.push(root);
    const temp = path.join(root, 'next');
    const dest = path.join(root, 'current');
    const backup = path.join(root, 'backup');
    fs.mkdirSync(temp);
    fs.mkdirSync(backup);
    fs.writeFileSync(path.join(temp, 'marker'), 'new');
    fs.writeFileSync(path.join(backup, 'marker'), 'old');

    fetchWhisper.replaceDirectoryTransactional(temp, dest, {
      backupDir: backup,
      retries: 0,
    });

    expect(fs.readFileSync(path.join(dest, 'marker'), 'utf8')).toBe('new');
    expect(fs.existsSync(backup)).toBe(false);
  });

  it('rolls back when Windows cannot remove the previous runtime backup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-whisper-cleanup-'));
    tempDirs.push(root);
    const temp = path.join(root, 'next');
    const dest = path.join(root, 'current');
    const backup = path.join(root, 'backup');
    fs.mkdirSync(temp);
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(temp, 'marker'), 'new');
    fs.writeFileSync(path.join(dest, 'marker'), 'old');
    const fakeFs = {
      ...fs,
      rmSync(target: fs.PathLike, options?: fs.RmDirOptions) {
        if (target === backup && fs.existsSync(backup) && fs.existsSync(dest)) {
          throw Object.assign(new Error('old runtime is still locked'), { code: 'EPERM' });
        }
        return fs.rmSync(target, options);
      },
    };

    expect(() => fetchWhisper.replaceDirectoryTransactional(temp, dest, {
      fs: fakeFs,
      backupDir: backup,
      retries: 0,
    })).toThrow('old runtime is still locked');

    expect(fs.readFileSync(path.join(dest, 'marker'), 'utf8')).toBe('old');
    expect(fs.readFileSync(path.join(temp, 'marker'), 'utf8')).toBe('new');
    expect(fs.existsSync(backup)).toBe(false);
  });

  it('registers the model, licenses, binaries, and app-local VC DLLs as verified files', () => {
    const target = WHISPER_RUNTIME_CONTRACT.targets['win32-x64'];
    expect(Object.keys(fetchWhisper.expectedFiles(target))).toEqual(expect.arrayContaining([
      'bin/whisper-cli.exe',
      'bin/ggml-blas.dll',
      'bin/libopenblas.dll',
      'bin/ggml-cpu-x64.dll',
      'bin/ggml-cpu-sse42.dll',
      'bin/ggml-cpu-haswell.dll',
      'bin/ggml-cpu-alderlake.dll',
      'models/ggml-base-q5_1.bin',
      'LICENSE.whisper.cpp',
      'LICENSE.model',
      'LICENSE.openblas',
      'bin/msvcp140.dll',
      'bin/msvcp140_1.dll',
      'bin/vcruntime140.dll',
      'bin/vcruntime140_1.dll',
      'bin/vcomp140.dll',
    ]));
    expect(Object.keys(fetchWhisper.expectedFiles(target))).not.toContain('vc_redist.x64.exe');
    const openBlasLicense = target.licenses['LICENSE.openblas'];
    expect(fetchWhisper.matchesFile(
      path.join(process.cwd(), 'vendor', 'whisper', ...openBlasLicense.vendorPath.split('/')),
      openBlasLicense,
    )).toBe(true);
  });
});
