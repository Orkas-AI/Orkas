import { describe, expect, it, vi } from 'vitest';

import {
  ELECTRON_BINARY_INSTALL_TIMEOUT_MS,
  ensureElectronBinary,
  ensureSqliteElectronAbi,
  nativeBuildEnvironment,
  SQLITE_ABI_INSTALL_TIMEOUT_MS,
  SQLITE_ABI_PROBE_TIMEOUT_MS,
  SQLITE_ABI_REBUILD_TIMEOUT_MS,
} from '../../../scripts/ensure-sqlite-electron-abi.mjs';

const OPTIONS = {
  execPath: '/runtime/node',
  electronCli: '/app/node_modules/electron/cli.js',
  electronRebuildBin: '/app/node_modules/@electron/rebuild/lib/cli.js',
  electronVersion: '41.10.2',
  nativeAddon: '/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  pcRoot: '/app',
  prebuildInstallBin: '/app/node_modules/prebuild-install/bin.js',
  rebuildEnv: { PATH: '/tools' },
  sqliteDir: '/app/node_modules/better-sqlite3',
};

describe('SQLite Electron ABI repair orchestration', () => {
  it('adds macOS SDK C++ headers without leaking Electron-as-Node into rebuild helpers', () => {
    expect(nativeBuildEnvironment({
      env: {
        CPLUS_INCLUDE_PATH: '/custom/include',
        ELECTRON_RUN_AS_NODE: '1',
        PATH: '/tools',
      },
      platform: 'darwin',
      sdkRoot: '/CommandLineTools/SDKs/MacOSX.sdk',
    })).toEqual({
      CPLUS_INCLUDE_PATH: [
        '/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1',
        '/custom/include',
      ].join(process.platform === 'win32' ? ';' : ':'),
      PATH: '/tools',
      SDKROOT: '/CommandLineTools/SDKs/MacOSX.sdk',
    });
  });

  it('leaves non-macOS build paths alone except for Electron-as-Node isolation', () => {
    expect(nativeBuildEnvironment({
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        PATH: '/tools',
      },
      platform: 'win32',
      sdkRoot: '/ignored-sdk',
    })).toEqual({ PATH: '/tools' });
  });

  it('downloads the exact Electron binary before probing native modules', () => {
    let installedVersion = '';
    const spawn = vi.fn(() => {
      installedVersion = '42.8.0';
      return { status: 0 };
    });

    expect(ensureElectronBinary({
      electronInstall: '/app/node_modules/electron/install.js',
      electronVersion: '42.8.0',
      electronVersionFile: '/app/node_modules/electron/dist/version',
      execPath: OPTIONS.execPath,
      pcRoot: OPTIONS.pcRoot,
      readVersion: () => installedVersion,
      spawn,
    })).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      OPTIONS.execPath,
      ['/app/node_modules/electron/install.js'],
      {
        cwd: OPTIONS.pcRoot,
        stdio: 'inherit',
        timeout: ELECTRON_BINARY_INSTALL_TIMEOUT_MS,
      },
    );
  });

  it('reuses an already installed matching Electron binary', () => {
    const spawn = vi.fn();

    expect(ensureElectronBinary({
      electronInstall: '/app/node_modules/electron/install.js',
      electronVersion: '42.8.0',
      electronVersionFile: '/app/node_modules/electron/dist/version',
      execPath: OPTIONS.execPath,
      pcRoot: OPTIONS.pcRoot,
      readVersion: () => 'v42.8.0\n',
      spawn,
    })).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('trusts the installed Electron version after a late installer failure', () => {
    let installedVersion = '';
    const spawn = vi.fn(() => {
      installedVersion = '42.8.0';
      return { status: 7, stderr: 'late cleanup failed' };
    });

    expect(ensureElectronBinary({
      electronInstall: '/app/node_modules/electron/install.js',
      electronVersion: '42.8.0',
      electronVersionFile: '/app/node_modules/electron/dist/version',
      execPath: OPTIONS.execPath,
      pcRoot: OPTIONS.pcRoot,
      readVersion: () => installedVersion,
      spawn,
    })).toBe(0);
  });

  it('rejects an installer that exits successfully but leaves the wrong Electron version', () => {
    const logError = vi.fn();
    const spawn = vi.fn(() => ({ status: 0 }));

    expect(ensureElectronBinary({
      electronInstall: '/app/node_modules/electron/install.js',
      electronVersion: '42.8.0',
      electronVersionFile: '/app/node_modules/electron/dist/version',
      execPath: OPTIONS.execPath,
      pcRoot: OPTIONS.pcRoot,
      readVersion: () => '42.7.1',
      spawn,
      logError,
    })).toBe(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Electron 42.8.0 binary install failed'));
  });

  it('does no install work when the existing addon loads under Electron', () => {
    const spawn = vi.fn(() => ({ status: 0 }));

    expect(ensureSqliteElectronAbi({ ...OPTIONS, spawn })).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      OPTIONS.execPath,
      [
        OPTIONS.electronCli,
        '-e',
        `require(${JSON.stringify(OPTIONS.nativeAddon)})`,
      ],
      expect.objectContaining({
        cwd: OPTIONS.pcRoot,
        timeout: SQLITE_ABI_PROBE_TIMEOUT_MS,
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
      }),
    );
  });

  it('forcibly replaces an incompatible addon for the exact runtime/platform/arch', () => {
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 1, stderr: 'ABI mismatch' })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 });

    expect(ensureSqliteElectronAbi({ ...OPTIONS, spawn })).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls[1]).toEqual([
      OPTIONS.execPath,
      [
        OPTIONS.prebuildInstallBin,
        '--runtime', 'electron',
        '--target', OPTIONS.electronVersion,
        '--platform', process.platform,
        '--arch', process.arch,
        '--force',
      ],
      {
        cwd: OPTIONS.sqliteDir,
        stdio: 'inherit',
        timeout: SQLITE_ABI_INSTALL_TIMEOUT_MS,
      },
    ]);
  });

  it('trusts a successful post-install probe even when the installer exits non-zero', () => {
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 7, stderr: 'late cleanup failed' })
      .mockReturnValueOnce({ status: 0 });

    expect(ensureSqliteElectronAbi({ ...OPTIONS, spawn })).toBe(0);
  });

  it('rebuilds better-sqlite3 from source when no Electron prebuild exists', () => {
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 });

    expect(ensureSqliteElectronAbi({ ...OPTIONS, spawn })).toBe(0);
    expect(spawn.mock.calls[3]).toEqual([
      OPTIONS.execPath,
      [
        OPTIONS.electronRebuildBin,
        '--version', OPTIONS.electronVersion,
        '--module-dir', OPTIONS.pcRoot,
        '--which-module', 'better-sqlite3',
        '--force',
        '--build-from-source',
      ],
      {
        cwd: OPTIONS.pcRoot,
        env: OPTIONS.rebuildEnv,
        stdio: 'inherit',
        timeout: SQLITE_ABI_REBUILD_TIMEOUT_MS,
      },
    ]);
  });

  it('returns a stable failure and emits a diagnostic probe when repair stays broken', () => {
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: null, signal: 'SIGTERM' })
      .mockReturnValueOnce({
        status: null,
        error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
      })
      .mockReturnValueOnce({ status: 1, stderr: 'still incompatible\nextra detail' })
      .mockReturnValueOnce({ status: 1, stderr: 'rebuild failed\nextra detail' })
      .mockReturnValueOnce({ status: 1, stderr: 'still incompatible\nextra detail' })
      .mockReturnValueOnce({ status: 1, stderr: 'still incompatible\nextra detail' });
    const logError = vi.fn();

    expect(ensureSqliteElectronAbi({ ...OPTIONS, spawn, logError })).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(6);
    expect(logError).toHaveBeenCalledTimes(2);
    expect(logError.mock.calls[0][0]).toContain('source rebuild also failed');
    expect(logError.mock.calls[1][0]).toContain('still incompatible');
    expect(logError.mock.calls.flat().join('\n')).not.toContain('extra detail');
  });
});
