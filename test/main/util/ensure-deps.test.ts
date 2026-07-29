import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const ensureDeps = require('../../../scripts/ensure-deps.cjs') as {
  acquireDependencyLock(options: {
    lockFile: string;
    timeoutMs?: number;
    pollMs?: number;
    isProcessAlive?: (pid: number) => boolean;
    logWait?: boolean;
  }): () => void;
  dependencyInstallReason(input: {
    nodeModulesExists: boolean;
    stored: string;
    current: string;
    missingPackages: string[];
  }): string;
  electronDependencyState(input: {
    lockedVersion: string;
    installedVersion: string;
    binaryVersion: string;
    binaryExists: boolean;
  }): string;
  lockedPackageVersion(options: {
    lockFile: string;
    packageName: string;
  }): string;
  missingDeclaredDependencyPackages(options: {
    packageFile: string;
    nodeModulesDir: string;
  }): string[];
  replaceElectronPackageFromSource(options: {
    sourceDir: string;
    electronDir: string;
    expectedVersion: string;
  }): void;
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeManifest(nodeModulesDir: string, name: string, contents: unknown = { version: '1.0.0' }) {
  const manifest = path.join(nodeModulesDir, ...name.split('/'), 'package.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

describe('ensure-deps package-tree health', () => {
  it('pins the repository Electron dependency exactly to the lockfile version', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    const lockedVersion = ensureDeps.lockedPackageVersion({
      lockFile: path.resolve('package-lock.json'),
      packageName: 'electron',
    });

    expect(lockedVersion).toBe('41.7.1');
    expect(packageJson.devDependencies?.electron).toBe(lockedVersion);
  });

  it('detects missing and corrupt required package manifests while ignoring optional packages', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-dependency-health-'));
    tempDirs.push(root);
    const packageFile = path.join(root, 'package.json');
    const nodeModulesDir = path.join(root, 'node_modules');
    fs.writeFileSync(packageFile, JSON.stringify({
      dependencies: { ready: '^1.0.0', '@scope/missing': '^1.0.0' },
      devDependencies: { corrupt: '^1.0.0' },
      optionalDependencies: { 'platform-optional': '^1.0.0' },
    }));
    writeManifest(nodeModulesDir, 'ready');
    writeManifest(nodeModulesDir, 'corrupt', '{not-json');

    expect(ensureDeps.missingDeclaredDependencyPackages({ packageFile, nodeModulesDir })).toEqual([
      '@scope/missing',
      'corrupt',
    ]);
  });

  it('requests installation when the fingerprint matches but required packages are incomplete', () => {
    expect(ensureDeps.dependencyInstallReason({
      nodeModulesExists: true,
      stored: 'same',
      current: 'same',
      missingPackages: ['missing-package'],
    })).toBe('packages_incomplete');
    expect(ensureDeps.dependencyInstallReason({
      nodeModulesExists: true,
      stored: 'same',
      current: 'same',
      missingPackages: [],
    })).toBe('');
  });

  it('uses package-lock as the Electron authority and rejects a newer installed wrapper', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-electron-lock-'));
    tempDirs.push(root);
    const lockFile = path.join(root, 'package-lock.json');
    fs.writeFileSync(lockFile, JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/electron': { version: '41.7.1' },
      },
    }));

    const lockedVersion = ensureDeps.lockedPackageVersion({
      lockFile,
      packageName: 'electron',
    });
    expect(lockedVersion).toBe('41.7.1');
    expect(ensureDeps.electronDependencyState({
      lockedVersion,
      installedVersion: '41.10.3',
      binaryVersion: '41.7.1',
      binaryExists: true,
    })).toBe('package_version_mismatch');
  });

  it('requires both the Electron package and binary to match the locked version', () => {
    expect(ensureDeps.electronDependencyState({
      lockedVersion: '41.7.1',
      installedVersion: '41.7.1',
      binaryVersion: '41.10.3',
      binaryExists: true,
    })).toBe('binary_version_mismatch');
    expect(ensureDeps.electronDependencyState({
      lockedVersion: '41.7.1',
      installedVersion: '41.7.1',
      binaryVersion: '41.7.1',
      binaryExists: true,
    })).toBe('');
  });

  it('atomically replaces a drifted Electron wrapper without copying its stale binary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-electron-wrapper-'));
    tempDirs.push(root);
    const nodeModulesDir = path.join(root, 'node_modules');
    const sourceDir = path.join(root, 'locked-electron');
    const wrongTarget = path.join(root, 'wrong-electron');
    const electronDir = path.join(nodeModulesDir, 'electron');
    writeManifest(root, 'locked-electron', { version: '41.7.1' });
    fs.mkdirSync(path.join(sourceDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'install.js'), '// locked installer');
    fs.writeFileSync(path.join(sourceDir, 'path.txt'), 'stale-binary');
    fs.writeFileSync(path.join(sourceDir, 'dist', 'version'), '41.10.3');
    writeManifest(root, 'wrong-electron', { version: '41.10.3' });
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    if (process.platform === 'win32') {
      fs.cpSync(wrongTarget, electronDir, { recursive: true });
    } else {
      fs.symlinkSync(wrongTarget, electronDir, 'dir');
    }

    ensureDeps.replaceElectronPackageFromSource({
      sourceDir,
      electronDir,
      expectedVersion: '41.7.1',
    });

    expect(JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8')).version).toBe('41.7.1');
    expect(fs.readFileSync(path.join(electronDir, 'install.js'), 'utf8')).toBe('// locked installer');
    expect(fs.existsSync(path.join(electronDir, 'path.txt'))).toBe(false);
    expect(fs.existsSync(path.join(electronDir, 'dist'))).toBe(false);
    if (process.platform !== 'win32') expect(fs.existsSync(wrongTarget)).toBe(true);
  });

  it('reclaims a dead dependency lock and releases only its own lock file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-dependency-lock-'));
    tempDirs.push(root);
    const lockFile = path.join(root, 'ensure-deps.lock');
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: 987_654_321,
      token: 'dead-owner',
      createdAt: Date.now(),
    }));

    const release = ensureDeps.acquireDependencyLock({
      lockFile,
      timeoutMs: 100,
      pollMs: 1,
      isProcessAlive: () => false,
      logWait: false,
    });
    const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number; token: string };
    expect(owner.pid).toBe(process.pid);
    expect(owner.token).not.toBe('dead-owner');

    release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('does not let a second live dependency repair pass the lock', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-dependency-lock-live-'));
    tempDirs.push(root);
    const lockFile = path.join(root, 'ensure-deps.lock');
    const release = ensureDeps.acquireDependencyLock({
      lockFile,
      timeoutMs: 100,
      pollMs: 1,
      logWait: false,
    });

    expect(() => ensureDeps.acquireDependencyLock({
      lockFile,
      timeoutMs: 5,
      pollMs: 1,
      isProcessAlive: () => true,
      logWait: false,
    })).toThrow(/Timed out waiting for dependency preparation lock/);

    release();
  });

  it('does not reclaim a live dependency lock based on age alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-dependency-lock-old-live-'));
    tempDirs.push(root);
    const lockFile = path.join(root, 'ensure-deps.lock');
    const originalOwner = {
      pid: 424_242,
      token: 'old-live-owner',
      createdAt: Date.now() - 31 * 60 * 1000,
    };
    fs.writeFileSync(lockFile, JSON.stringify(originalOwner));
    const oldTimestamp = new Date(Date.now() - 31 * 60 * 1000);
    fs.utimesSync(lockFile, oldTimestamp, oldTimestamp);

    expect(() => ensureDeps.acquireDependencyLock({
      lockFile,
      timeoutMs: 5,
      pollMs: 1,
      isProcessAlive: () => true,
      logWait: false,
    })).toThrow(/Timed out waiting for dependency preparation lock/);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8'))).toEqual(originalOwner);
  });

  it('reclaims an expired dependency lock without valid owner metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-dependency-lock-invalid-'));
    tempDirs.push(root);
    const lockFile = path.join(root, 'ensure-deps.lock');
    fs.writeFileSync(lockFile, '{invalid-owner');
    const oldTimestamp = new Date(Date.now() - 31 * 60 * 1000);
    fs.utimesSync(lockFile, oldTimestamp, oldTimestamp);

    const release = ensureDeps.acquireDependencyLock({
      lockFile,
      timeoutMs: 100,
      pollMs: 1,
      isProcessAlive: () => true,
      logWait: false,
    });
    const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number; token: string };
    expect(owner.pid).toBe(process.pid);
    expect(owner.token).toBeTruthy();

    release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});
