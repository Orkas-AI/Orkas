import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const fetchFfmpeg = require('../../../scripts/fetch-ffmpeg.cjs') as {
  ensureFfmpegStaticBinary(binaryPath: string, options?: Record<string, unknown>): boolean;
  ensureFfprobeInstallerBinary(options?: Record<string, unknown>): Promise<string>;
  installLockedPackageTarball(tgz: Buffer, packageDir: string, options?: Record<string, unknown>): void;
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ffmpeg-static-'));
  tempDirs.push(packageDir);
  const packageJsonPath = path.join(packageDir, 'package.json');
  const installScript = path.join(packageDir, 'install.js');
  const binaryPath = path.join(packageDir, 'ffmpeg');
  fs.writeFileSync(packageJsonPath, '{}');
  fs.writeFileSync(installScript, '// fixture');
  return { packageDir, packageJsonPath, installScript, binaryPath };
}

describe('fetch-ffmpeg host dependency repair', () => {
  it('does not run the package installer when the binary already exists', () => {
    const files = fixture();
    fs.writeFileSync(files.binaryPath, 'ready');
    const spawnSync = vi.fn();

    expect(fetchFfmpeg.ensureFfmpegStaticBinary(files.binaryPath, {
      packageJsonPath: files.packageJsonPath,
      spawnSync,
    })).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('runs the package install script and re-verifies a missing binary', () => {
    const files = fixture();
    const spawnSync = vi.fn((_node: string, _args: string[], options: Record<string, unknown>) => {
      expect(options.cwd).toBe(files.packageDir);
      expect(options.timeout).toBe(10 * 60 * 1000);
      fs.writeFileSync(files.binaryPath, 'repaired');
      return { status: 0 };
    });
    const logger = { warn: vi.fn(), log: vi.fn() };

    expect(fetchFfmpeg.ensureFfmpegStaticBinary(files.binaryPath, {
      packageJsonPath: files.packageJsonPath,
      spawnSync,
      logger,
    })).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(process.execPath, [files.installScript], expect.objectContaining({
      cwd: files.packageDir,
      stdio: 'inherit',
    }));
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledOnce();
  });

  it('fails when the package installer exits successfully without restoring the binary', () => {
    const files = fixture();

    expect(() => fetchFfmpeg.ensureFfmpegStaticBinary(files.binaryPath, {
      packageJsonPath: files.packageJsonPath,
      spawnSync: () => ({ status: 0 }),
      logger: { warn: vi.fn(), log: vi.fn() },
    })).toThrow('repair completed but the binary is still missing');
  });

  it('restores a missing ffprobe package only after lockfile integrity verification', async () => {
    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ffprobe-installer-'));
    tempDirs.push(packageDir);
    const binaryPath = path.join(packageDir, 'ffprobe');
    const tarball = Buffer.from('lockfile-pinned-ffprobe-package');
    const integrity = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
    const downloadBuffer = vi.fn(async () => tarball);
    const installPackage = vi.fn(async (_bytes: Buffer, destination: string) => {
      expect(destination).toBe(packageDir);
      fs.writeFileSync(path.join(destination, 'package.json'), '{}');
      fs.writeFileSync(binaryPath, 'ffprobe');
    });
    const logger = { warn: vi.fn(), log: vi.fn() };

    await expect(fetchFfmpeg.ensureFfprobeInstallerBinary({
      platformKey: 'darwin-arm64',
      packageDir,
      binaryPath,
      wrapperPackage: {
        optionalDependencies: { '@ffprobe-installer/darwin-arm64': '5.0.1' },
      },
      packageLock: {
        packages: {
          'node_modules/@ffprobe-installer/darwin-arm64': {
            version: '5.0.1',
            resolved: 'https://registry.npmjs.org/@ffprobe-installer/darwin-arm64/-/darwin-arm64-5.0.1.tgz',
            integrity,
          },
        },
      },
      downloadBuffer,
      installPackage,
      logger,
    })).resolves.toBe(binaryPath);
    expect(downloadBuffer).toHaveBeenCalledOnce();
    expect(installPackage).toHaveBeenCalledWith(tarball, packageDir);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledOnce();
  });

  it('rejects an ffprobe package that does not match package-lock.json', async () => {
    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ffprobe-integrity-'));
    tempDirs.push(packageDir);
    const installPackage = vi.fn();

    await expect(fetchFfmpeg.ensureFfprobeInstallerBinary({
      platformKey: 'darwin-arm64',
      packageDir,
      binaryPath: path.join(packageDir, 'ffprobe'),
      wrapperPackage: {
        optionalDependencies: { '@ffprobe-installer/darwin-arm64': '5.0.1' },
      },
      packageLock: {
        packages: {
          'node_modules/@ffprobe-installer/darwin-arm64': {
            version: '5.0.1',
            resolved: 'https://registry.npmjs.org/ffprobe.tgz',
            integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
          },
        },
      },
      downloadBuffer: async () => Buffer.from('tampered'),
      installPackage,
      logger: { warn: vi.fn(), log: vi.fn() },
    })).rejects.toThrow('integrity mismatch against package-lock.json');
    expect(installPackage).not.toHaveBeenCalled();
  });

  it('atomically replaces an incomplete ffprobe package after extracting the verified archive', () => {
    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ffprobe-package-'));
    tempDirs.push(packageDir);
    fs.writeFileSync(path.join(packageDir, 'stale'), 'stale');
    const spawnSync = vi.fn((_command: string, args: string[]) => {
      const extractRoot = args[args.indexOf('-C') + 1];
      const extracted = path.join(extractRoot, 'package');
      fs.mkdirSync(extracted, { recursive: true });
      fs.writeFileSync(path.join(extracted, 'package.json'), '{"version":"5.0.1"}');
      fs.writeFileSync(path.join(extracted, 'ffprobe'), 'repaired');
      return { status: 0 };
    });

    fetchFfmpeg.installLockedPackageTarball(Buffer.from('verified-tgz'), packageDir, { spawnSync });

    expect(fs.existsSync(path.join(packageDir, 'stale'))).toBe(false);
    expect(fs.readFileSync(path.join(packageDir, 'ffprobe'), 'utf8')).toBe('repaired');
    expect(spawnSync).toHaveBeenCalledOnce();
  });
});
