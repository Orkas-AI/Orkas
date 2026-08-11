import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const asarCli = path.join(path.dirname(require.resolve('@electron/asar/package.json')), 'bin', 'asar.js');
const gate = require('../../../bin/packaged-dependency-gate.cjs') as {
  comparePackagedDependencyInventories(left: any, right: any): string;
  packageRootFromManifestPath(manifestPath: string): string | null;
  verifyPackagedDependencyGraph(options: {
    appAsar: string;
    packageJsonFile: string;
    packageLockFile: string;
    platform: string;
    arch: string;
  }): any;
};

type Manifest = Record<string, any>;
type Fixture = {
  sourcePackage: Manifest;
  packedRoot: Manifest;
  packages: Record<string, Manifest>;
  lock: Manifest;
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-packaged-deps-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fixture(): Fixture {
  const dependencies = {
    alpha: '1.0.0',
    consumer: '1.0.0',
  };
  const overrides = { forced: '2.0.0' };
  const sourcePackage = {
    name: 'dependency-gate-fixture',
    version: '1.0.0',
    main: 'bootstrap.cjs',
    dependencies,
    overrides,
  };
  const packages = {
    'node_modules/alpha': { name: 'alpha', version: '1.0.0' },
    'node_modules/consumer': {
      name: 'consumer',
      version: '1.0.0',
      dependencies: {
        alpha: '^2.0.0',
        forced: '^1.0.0',
      },
      optionalDependencies: {
        'platform-addon': '1.0.0',
      },
    },
    'node_modules/consumer/node_modules/alpha': { name: 'alpha', version: '2.0.0' },
    'node_modules/forced': { name: 'forced', version: '2.0.0' },
    'node_modules/platform-addon': {
      name: 'platform-addon',
      version: '1.0.0',
      os: ['darwin'],
      cpu: ['x64'],
    },
  };
  return {
    sourcePackage,
    packedRoot: structuredClone(sourcePackage),
    packages,
    lock: {
      name: sourcePackage.name,
      version: sourcePackage.version,
      lockfileVersion: 3,
      packages: {
        '': {
          name: sourcePackage.name,
          version: sourcePackage.version,
          dependencies,
        },
        'node_modules/alpha': { version: '1.0.0' },
        'node_modules/consumer': { version: '1.0.0' },
        'node_modules/consumer/node_modules/alpha': { version: '2.0.0' },
        'node_modules/forced': { version: '2.0.0' },
        'node_modules/platform-addon': { version: '1.0.0', os: ['darwin'], cpu: ['x64'] },
      },
    },
  };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function buildFixture(value: Fixture): Promise<{
  appAsar: string;
  packageJsonFile: string;
  packageLockFile: string;
}> {
  const sourceRoot = path.join(tmpDir, 'source');
  const packedRoot = path.join(tmpDir, 'packed');
  const appAsar = path.join(tmpDir, 'app.asar');
  const packageJsonFile = path.join(sourceRoot, 'package.json');
  const packageLockFile = path.join(sourceRoot, 'package-lock.json');
  writeJson(packageJsonFile, value.sourcePackage);
  writeJson(packageLockFile, value.lock);
  writeJson(path.join(packedRoot, 'package.json'), value.packedRoot);
  fs.writeFileSync(path.join(packedRoot, 'bootstrap.cjs'), 'module.exports = {};\n');
  for (const [packageRoot, manifest] of Object.entries(value.packages)) {
    writeJson(path.join(packedRoot, ...packageRoot.split('/'), 'package.json'), manifest);
  }
  execFileSync(process.execPath, [asarCli, 'pack', packedRoot, appAsar]);
  return { appAsar, packageJsonFile, packageLockFile };
}

async function verify(value: Fixture): Promise<any> {
  const paths = await buildFixture(value);
  return gate.verifyPackagedDependencyGraph({
    ...paths,
    platform: 'darwin',
    arch: 'x64',
  });
}

describe('packaged-dependency-gate', () => {
  it('validates the complete packaged graph, nested resolution, optional package, and root override', async () => {
    const result = await verify(fixture());

    expect(result).toMatchObject({
      platform: 'darwin',
      arch: 'x64',
      packageCount: 5,
      edgeCount: 5,
      overrideEdgeCount: 1,
    });
    expect(result.verificationEntry).toBe(
      'dependency:lock-graph:darwin-x64:packages=5:edges=5:overrides=1',
    );
    expect(result.neutralInventory).toEqual({
      'alpha@1.0.0': 1,
      'alpha@2.0.0': 1,
      'consumer@1.0.0': 1,
      'forced@2.0.0': 1,
    });
    expect(result.platformInventory).toEqual({ 'platform-addon@1.0.0': 1 });
  });

  it('rejects a required dependency missing from the packaged resolution chain', async () => {
    const value = fixture();
    value.packages['node_modules/consumer'].dependencies.missing = '^1.0.0';

    await expect(verify(value)).rejects.toThrow(/missing dependency missing@\^1\.0\.0/);
  });

  it('rejects a packaged version that does not exist anywhere in package-lock.json', async () => {
    const value = fixture();
    value.packages['node_modules/forced'].version = '2.0.1';

    await expect(verify(value)).rejects.toThrow(/forced@2\.0\.1.*not present in package-lock\.json/);
  });

  it('rejects a direct dependency version moved to a different locked version', async () => {
    const value = fixture();
    value.packages['node_modules/alpha'].version = '2.0.0';

    await expect(verify(value)).rejects.toThrow(/direct dependency alpha version mismatch: packaged=2\.0\.0 lock=1\.0\.0/);
  });

  it('rejects a resolved version that violates an explicit root override', async () => {
    const value = fixture();
    value.packages['node_modules/forced'].version = '1.5.0';
    value.lock.packages['node_modules/forced'].version = '1.5.0';

    await expect(verify(value)).rejects.toThrow(/root override forced@2\.0\.0.*forced@1\.5\.0/);
  });

  it('rejects packaged root dependency metadata that differs from source package.json', async () => {
    const value = fixture();
    value.packedRoot.dependencies.alpha = '^2.0.0';

    await expect(verify(value)).rejects.toThrow(/app\.asar root dependencies differs from source package\.json/);
  });

  it('rejects lock-known but unreachable packages added to app.asar', async () => {
    const value = fixture();
    value.packages['node_modules/orphan'] = { name: 'orphan', version: '1.0.0' };
    value.lock.packages['node_modules/orphan'] = { version: '1.0.0' };

    await expect(verify(value)).rejects.toThrow(/unreachable package.*node_modules\/orphan/);
  });

  it('compares platform-neutral dependency versions while allowing target-specific packages', () => {
    const x64 = {
      platform: 'darwin',
      arch: 'x64',
      neutralInventory: { 'alpha@1.0.0': 1 },
      crossArchInventory: { 'alpha@1.0.0': 1 },
      platformInventory: { 'native-x64@1.0.0': 1 },
    };
    const arm64 = {
      platform: 'darwin',
      arch: 'arm64',
      neutralInventory: { 'alpha@1.0.0': 1 },
      crossArchInventory: { 'alpha@1.0.0': 1 },
      platformInventory: { 'native-arm64@1.0.0': 1 },
    };

    expect(gate.comparePackagedDependencyInventories(x64, arm64))
      .toBe('dependency:cross-arch-inventory:darwin:x64=arm64:packages=1');
    arm64.crossArchInventory = { 'alpha@1.1.0': 1 };
    expect(() => gate.comparePackagedDependencyInventories(x64, arm64))
      .toThrow(/platform-neutral dependency inventory differs.*alpha@1\.0\.0.*alpha@1\.1\.0/);
  });

  it('recognizes only real node_modules package roots, not fixture package.json files', () => {
    expect(gate.packageRootFromManifestPath('/node_modules/@scope/pkg/package.json'))
      .toBe('node_modules/@scope/pkg');
    expect(gate.packageRootFromManifestPath('/node_modules/pkg/test/fixture/package.json')).toBeNull();
  });
});
