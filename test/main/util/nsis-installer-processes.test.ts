import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInstallerFixtures, exerciseNsisInstaller, resolveNsisTool, type InstallerFixtures, type CleanupFixture } from '../../helpers/nsis-installer-scenario';

const pcRoot = path.resolve(__dirname, '../../..');

describe('public NSIS compiler selection', () => {
  it.each(['darwin', 'win32'] as const)('uses the standard installed compiler on %s without private build dependencies', platform => {
    expect(resolveNsisTool({}, platform)).toEqual({ path: platform === 'win32' ? 'makensis.exe' : 'makensis' });
  });

  it.each(['darwin', 'win32', 'linux'] as const)('supports the explicit electron-builder compiler directory on %s', platform => {
    const directory = path.resolve(os.tmpdir(), 'public-nsis-toolchain');
    expect(resolveNsisTool({ ELECTRON_BUILDER_NSIS_DIR: directory }, platform)).toEqual({
      path: path.join(directory, platform === 'darwin' ? 'mac' : platform === 'win32' ? 'Bin' : 'linux',
        platform === 'win32' ? 'makensis.exe' : 'makensis'),
      env: { NSISDIR: directory },
    });
  });

  it('lets an explicit compiler override directory discovery while preserving its resource root', () => {
    const compiler = path.resolve(os.tmpdir(), 'public-nsis', 'makensis');
    const directory = path.resolve(os.tmpdir(), 'public-nsis-toolchain');
    expect(resolveNsisTool({ ORKAS_TEST_MAKENSIS: compiler, ELECTRON_BUILDER_NSIS_DIR: directory })).toEqual({
      path: compiler, env: { NSISDIR: directory },
    });
  });

  it.each(['ORKAS_TEST_MAKENSIS', 'ELECTRON_BUILDER_NSIS_DIR'])('rejects an ambiguous relative %s configuration', key => {
    expect(() => resolveNsisTool({ [key]: 'relative-toolchain' })).toThrow('must be an absolute');
  });

  it('fails compilation when the configured compiler is absent instead of skipping the contract', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-missing-nsis-'));
    try {
      await expect(buildInstallerFixtures(pcRoot, directory, {
        path: path.join(directory, 'absent-compiler'),
      })).rejects.toThrow('NSIS compiler unavailable');
      expect(fs.existsSync(path.join(directory, 'real.exe'))).toBe(false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

describe.skipIf(!['darwin', 'win32'].includes(process.platform))('compiled NSIS update installation', () => {
  let root: string;
  let fixtures: InstallerFixtures;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-nsis-fixtures-'));
    fixtures = await buildInstallerFixtures(pcRoot, root);
  }, 60_000);
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('compiles the production hook and explicit failure controls with the configured public toolchain', () => {
    expect(Object.keys(fixtures)).toEqual(['real', 'failed', 'timeout', 'disabled']);
    console.info('NSIS compilation proof:', JSON.stringify(Object.entries(fixtures).map(([fault, file]) => {
      const bytes = fs.readFileSync(file);
      return { fault, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    })));
  });

  it.runIf(process.platform === 'win32').each<CleanupFixture>(['real', 'failed', 'timeout'])(
    'preserves the old installation on %s cleanup and safely installs on retry', async fault => {
      const result = await exerciseNsisInstaller(process.env.ORKAS_TEST_NODE!, fixtures, fault);
      expect(result).toMatchObject({ installedVersion: 2, siblingPreserved: true, userDataPreserved: true });
      console.info('NSIS installation proof:', JSON.stringify(result));
    }, 60_000,
  );

  it.runIf(process.platform === 'win32')('rejects a false-success control with cleanup disabled, then recovers', async () => {
    const result = await exerciseNsisInstaller(process.env.ORKAS_TEST_NODE!, fixtures, 'disabled');
    console.info('NSIS false-success control rejected:', JSON.stringify(result));
  }, 60_000);
});
