import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const asarCli = path.join(path.dirname(require.resolve('@electron/asar/package.json')), 'bin', 'asar.js');
const gate = require('../../../bin/packaged-dependency-gate.cjs') as {
  comparePackagedDependencyInventories(left: any, right: any): string;
  packageRootFromManifestPath(manifestPath: string): string | null;
  verifyNodeRuntimeBuildConfig(sourcePackage: Manifest, lock: Manifest): string[];
  verifySourceDependencyGraph(sourcePackage: Manifest, lock: Manifest, platform: string, arch: string): any;
  verifyInstalledProductionDependencies(root: string, platform: string, arch: string): any;
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

async function buildFixture(value: Fixture, unpack = ''): Promise<{
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
    fs.writeFileSync(path.join(packedRoot, ...packageRoot.split('/'), 'index.js'), 'module.exports = {};\n');
  }
  execFileSync(process.execPath, [asarCli, 'pack', packedRoot, appAsar, ...(unpack ? ['--unpack', unpack] : [])]);
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
  function sourceGraphFixture(): Fixture {
    const value = fixture();
    for (const [root, manifest] of Object.entries(value.packages)) {
      value.lock.packages[root] = { ...manifest };
    }
    value.sourcePackage.devDependencies = { 'build-only': '1.0.0' };
    value.lock.packages[''].devDependencies = { 'build-only': '1.0.0' };
    value.lock.packages['node_modules/build-only'] = { version: '1.0.0', dev: true };
    return value;
  }

  it.each([['darwin', 'x64'], ['darwin', 'arm64'], ['win32', 'x64']])('validates the source graph for %s/%s without requiring other-platform optional packages', (platform, arch) => {
    const value = sourceGraphFixture();
    expect(() => gate.verifySourceDependencyGraph(value.sourcePackage, value.lock, platform, arch)).not.toThrow();
    delete value.lock.packages['node_modules/consumer/node_modules/alpha'];
    expect(() => gate.verifySourceDependencyGraph(value.sourcePackage, value.lock, platform, arch)).toThrow(/alpha/);
  });

  it('rejects root lock drift before packaging', () => {
    const value = sourceGraphFixture();
    value.lock.packages[''].dependencies = { alpha: '1.0.0' };
    expect(() => gate.verifySourceDependencyGraph(value.sourcePackage, value.lock, 'win32', 'x64')).toThrow(/root dependencies/);
  });

  it('rechecks a cached production tree without executing dependencies or requiring dev packages', () => {
    const value = sourceGraphFixture();
    writeJson(path.join(tmpDir, 'package.json'), value.sourcePackage);
    writeJson(path.join(tmpDir, 'package-lock.json'), value.lock);
    for (const [root, manifest] of Object.entries(value.packages)) {
      writeJson(path.join(tmpDir, root, 'package.json'), manifest);
      fs.writeFileSync(path.join(tmpDir, root, 'index.js'), "throw new Error('must not execute during validation');");
    }
    expect(() => gate.verifyInstalledProductionDependencies(tmpDir, 'darwin', 'x64')).not.toThrow();
    fs.rmSync(path.join(tmpDir, 'node_modules/platform-addon'), { recursive: true });
    expect(() => gate.verifyInstalledProductionDependencies(tmpDir, 'darwin', 'x64')).not.toThrow();
    const dependency = path.join(tmpDir, 'node_modules/consumer/node_modules/alpha/package.json');
    writeJson(dependency, { name: 'alpha', version: '2.0.1' });
    expect(() => gate.verifyInstalledProductionDependencies(tmpDir, 'darwin', 'x64')).toThrow(/version/);
    fs.rmSync(path.dirname(dependency), { recursive: true });
    expect(() => gate.verifyInstalledProductionDependencies(tmpDir, 'darwin', 'x64')).toThrow(/alpha/);
  });

  // A valid archive graph is insufficient for the stock Node image process:
  // every dependency it resolves must also exist outside the archive.
  function imageFixture(): Fixture {
    const value = fixture();
    value.sourcePackage.dependencies.sharp = '1.0.0';
    value.packedRoot = structuredClone(value.sourcePackage);
    value.packages['node_modules/sharp'] = {
      name: 'sharp', version: '1.0.0', dependencies: { 'detect-libc': '1.0.0' },
    };
    value.packages['node_modules/detect-libc'] = { name: 'detect-libc', version: '1.0.0' };
    value.lock.packages['node_modules/sharp'] = { version: '1.0.0' };
    value.lock.packages['node_modules/detect-libc'] = { version: '1.0.0' };
    return value;
  }

  it.each(['darwin', 'win32'])('rejects archive-only image dependencies for %s', async (platform) => {
    const value = imageFixture();
    delete value.packages['node_modules/platform-addon'];
    const paths = await buildFixture(value, '**/sharp/**');
    expect(() => gate.verifyPackagedDependencyGraph({ ...paths, platform, arch: 'x64' }))
      .toThrow(/stock Node.*detect-libc.*not unpacked/);
  });

  it('accepts complete Node dependencies while Electron-only packages remain archived', async () => {
    const paths = await buildFixture(imageFixture(), '**/{sharp,detect-libc}/**');
    const result = gate.verifyPackagedDependencyGraph({ ...paths, platform: 'darwin', arch: 'x64' });
    expect(result.nodeRuntimeInventory).toEqual(['node_modules/detect-libc', 'node_modules/sharp']);
    fs.rmSync(`${paths.appAsar}.unpacked/node_modules/detect-libc/index.js`);
    expect(() => gate.verifyPackagedDependencyGraph({ ...paths, platform: 'darwin', arch: 'x64' }))
      .toThrow(/stock Node.*detect-libc\/index.js.*missing/);
  });

  it('discovers a new transitive Node dependency before packaging without a manual leaf list', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'));
    expect(gate.verifyNodeRuntimeBuildConfig(pkg, lock)).toContain('node_modules/detect-libc');
    lock.packages['node_modules/sharp'].dependencies['future-image-codec'] = '^1.0.0';
    lock.packages['node_modules/future-image-codec'] = { version: '1.0.0' };
    expect(() => gate.verifyNodeRuntimeBuildConfig(pkg, lock)).toThrow(/future-image-codec/);
  });

  it.each(['darwin', 'win32'])('requires the resolved PSD writer and nested compression library outside asar on %s', async platform => {
    const value = fixture();
    delete value.packages['node_modules/platform-addon'];
    value.sourcePackage.dependencies['ag-psd'] = '34.1.0';
    value.packedRoot = structuredClone(value.sourcePackage);
    const additions = {
      'node_modules/ag-psd': { name: 'ag-psd', version: '34.1.0', dependencies: { pako: '^2.1.0', 'base64-js': '^1.5.1' } },
      'node_modules/ag-psd/node_modules/pako': { name: 'pako', version: '2.1.0' },
      'node_modules/base64-js': { name: 'base64-js', version: '1.5.1' },
    };
    Object.assign(value.packages, additions); Object.assign(value.lock.packages, additions);
    const paths = await buildFixture(value, '**/{ag-psd,base64-js}/**');
    const options = { ...paths, platform, arch: 'x64' };
    expect(gate.verifyPackagedDependencyGraph(options).nodeRuntimeInventory).toEqual(Object.keys(additions).sort());
    fs.rmSync(`${paths.appAsar}.unpacked/node_modules/ag-psd/node_modules/pako/index.js`);
    expect(() => gate.verifyPackagedDependencyGraph(options)).toThrow(/stock Node.*pako.*missing/);
  });

  it('uses only declared public verifier dependencies when a development dependency is missing', () => {
    const requested: string[] = [];
    const missing = Object.assign(new Error("Cannot find module '@electron/asar'"), { code: 'MODULE_NOT_FOUND' });
    const dependency = (name: string) => {
      requested.push(name);
      if (name === 'node:fs' || name === 'node:path') return require(name);
      throw missing;
    };
    const file = path.join(process.cwd(), 'bin/packaged-dependency-gate.cjs');
    expect(() => vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      require: dependency, __dirname: path.dirname(file), module: { exports: {} },
    }, { filename: 'isolated-dependency-gate.cjs' })).toThrow(missing.message);
    expect(requested).toEqual(['node:fs', 'node:path', '@electron/asar']);
  });

  it('unpacks the complete PSD payload under the public manifest patterns, including extensionless and browser files', async () => {
    const project = process.cwd();
    const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
    const files = [
      ...['package.json', 'LICENSE', 'index.js', 'lib/zlib/README', 'lib/zlib/deflate.js']
        .map(name => `node_modules/ag-psd/node_modules/pako/${name}`),
      ...['package.json', 'LICENSE', 'index.js', 'base64js.min.js'].map(name => `node_modules/base64-js/${name}`),
    ];
    const source = path.join(tmpDir, 'psd-payload');
    const archive = path.join(tmpDir, 'psd-payload.asar');
    for (const file of files) {
      const destination = path.join(source, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(project, file), destination);
    }
    const patterns = pkg.build.asarUnpack.filter((pattern: string) =>
      pattern.startsWith('node_modules/ag-psd/') || pattern.startsWith('node_modules/base64-js/'));
    expect(patterns.length).toBeGreaterThan(0);
    // Use the public project's actual ASAR implementation and declared unpack
    // patterns. The private product-builder toolchain is not a dependency.
    const absolutePatterns = patterns.map((pattern: string) => path.join(source, pattern).split(path.sep).join('/'));
    execFileSync(process.execPath, [asarCli, 'pack', source, archive, '--unpack', `{${absolutePatterns.join(',')}}`], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const asar = require('@electron/asar');
    const hadNoAsar = Object.prototype.hasOwnProperty.call(process, 'noAsar');
    const originalNoAsar = (process as any).noAsar;
    (process as any).noAsar = true;
    try {
      for (const file of files) {
        expect(asar.statFile(archive, file).unpacked, file).toBe(true);
        expect(fs.readFileSync(path.join(`${archive}.unpacked`, file)).equals(fs.readFileSync(path.join(project, file))), file).toBe(true);
      }
    } finally {
      asar.uncache(archive);
      if (hadNoAsar) (process as any).noAsar = originalNoAsar;
      else delete (process as any).noAsar;
    }
  });

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
    expect(gate.packageRootFromManifestPath('\\package.json')).toBe('');
    expect(gate.packageRootFromManifestPath('\\node_modules\\@scope\\pkg\\package.json'))
      .toBe('node_modules/@scope/pkg');
    expect(gate.packageRootFromManifestPath('/node_modules/@scope/pkg/package.json'))
      .toBe('node_modules/@scope/pkg');
    expect(gate.packageRootFromManifestPath('/node_modules/pkg/test/fixture/package.json')).toBeNull();
  });
});
