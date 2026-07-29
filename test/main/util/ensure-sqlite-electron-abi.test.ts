import { describe, expect, it, vi } from 'vitest';

import {
  ensureSqliteElectronAbi,
  SQLITE_ABI_INSTALL_TIMEOUT_MS,
  SQLITE_ABI_PROBE_TIMEOUT_MS,
} from '../../../scripts/ensure-sqlite-electron-abi.mjs';

const OPTIONS = {
  execPath: '/runtime/node',
  electronCli: '/app/node_modules/electron/cli.js',
  electronVersion: '41.10.2',
  nativeAddon: '/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  pcRoot: '/app',
  prebuildInstallBin: '/app/node_modules/prebuild-install/bin.js',
  sqliteDir: '/app/node_modules/better-sqlite3',
};

describe('SQLite Electron ABI repair orchestration', () => {
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

  it('returns a stable failure and emits a diagnostic probe when repair stays broken', () => {
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: null, signal: 'SIGTERM' })
      .mockReturnValueOnce({
        status: null,
        error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
      })
      .mockReturnValueOnce({ status: 1, stderr: 'still incompatible\nextra detail' })
      .mockReturnValueOnce({ status: 1, stderr: 'still incompatible\nextra detail' });
    const logError = vi.fn();

    expect(ensureSqliteElectronAbi({ ...OPTIONS, spawn, logError })).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(logError).toHaveBeenCalledTimes(2);
    expect(logError.mock.calls[0][0]).toContain('timed out');
    expect(logError.mock.calls[1][0]).toContain('still incompatible');
    expect(logError.mock.calls.flat().join('\n')).not.toContain('extra detail');
  });
});
