import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  MINIMUM_GLIBC,
  assertLinuxHost,
  processFailureReason,
  requiredLinuxPackages,
  verifyPackageContract,
  versionAtLeast,
} = require(path.join(process.cwd(), 'scripts', 'verify-linux-source-dependencies.cjs')) as {
  MINIMUM_GLIBC: string;
  assertLinuxHost: (input: {
    platform: NodeJS.Platform;
    arch: string;
    nodeVersion: string;
    glibcVersionRuntime: string;
  }) => readonly string[];
  processFailureReason: (result: {
    error?: Error;
    status?: number | null;
    stderr?: string;
    stdout?: string;
  }) => string;
  requiredLinuxPackages: (arch: string) => readonly string[];
  verifyPackageContract: (root: string, arch: string) => readonly string[];
  versionAtLeast: (actual: string, minimum: string) => boolean;
};

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fakePackageRoot(arch: 'x64' | 'arm64'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-linux-deps-'));
  tempRoots.push(root);
  const packages: Record<string, { version: string }> = {};
  for (const packageName of requiredLinuxPackages(arch)) {
    packages[`node_modules/${packageName}`] = { version: '1.2.3' };
    writeJson(
      path.join(root, 'node_modules', ...packageName.split('/'), 'package.json'),
      { name: packageName, version: '1.2.3' },
    );
  }
  writeJson(path.join(root, 'package-lock.json'), { packages });
  const onnx = path.join(
    root,
    'node_modules',
    'fastembed',
    'node_modules',
    'onnxruntime-node',
  );
  writeJson(path.join(onnx, 'package.json'), { name: 'onnxruntime-node', version: '1.21.0' });
  const onnxHost = path.join(onnx, 'bin', 'napi-v3', 'linux', arch);
  fs.mkdirSync(onnxHost, { recursive: true });
  fs.writeFileSync(path.join(onnxHost, 'onnxruntime_binding.node'), 'elf');
  fs.writeFileSync(path.join(onnxHost, 'libonnxruntime.so.1'), 'elf');
  return root;
}

describe('Linux source dependency contract', () => {
  it.each(['x64', 'arm64'] as const)('accepts a supported glibc Linux %s host', (arch) => {
    expect(assertLinuxHost({
      platform: 'linux',
      arch,
      nodeVersion: '24.17.0',
      glibcVersionRuntime: MINIMUM_GLIBC,
    })).toContain(`host:linux-${arch}`);
  });

  it('fails before downloads on musl, old glibc, old Node, and unsupported architectures', () => {
    expect(() => assertLinuxHost({
      platform: 'linux', arch: 'x64', nodeVersion: '24.17.0', glibcVersionRuntime: '',
    })).toThrow(/musl-based Linux distributions are not supported/);
    expect(() => assertLinuxHost({
      platform: 'linux', arch: 'x64', nodeVersion: '24.17.0', glibcVersionRuntime: '2.33',
    })).toThrow(/glibc 2\.34\+ is required/);
    expect(() => assertLinuxHost({
      platform: 'linux', arch: 'x64', nodeVersion: '18.20.0', glibcVersionRuntime: '2.39',
    })).toThrow(/Node\.js 20\+ is required/);
    expect(() => assertLinuxHost({
      platform: 'linux', arch: 'riscv64', nodeVersion: '24.17.0', glibcVersionRuntime: '2.39',
    })).toThrow(/support x64 and arm64/);
  });

  it('uses GNU native packages for both supported architectures', () => {
    expect(requiredLinuxPackages('x64')).toContain('@anush008/tokenizers-linux-x64-gnu');
    expect(requiredLinuxPackages('arm64')).toContain('@anush008/tokenizers-linux-arm64-gnu');
    expect(requiredLinuxPackages('arm64')).not.toContain('@anush008/tokenizers-linux-arm64-musl');
  });

  it.each(['x64', 'arm64'] as const)('accepts a complete locked Linux %s package set', (arch) => {
    const root = fakePackageRoot(arch);
    expect(verifyPackageContract(root, arch)).toContain(`package:onnxruntime-node:linux-${arch}`);
  });

  it('rejects a missing arm64 tokenizer binding instead of deferring failure to Library use', () => {
    const root = fakePackageRoot('arm64');
    fs.rmSync(path.join(root, 'node_modules', '@anush008', 'tokenizers-linux-arm64-gnu'), {
      recursive: true,
      force: true,
    });
    expect(() => verifyPackageContract(root, 'arm64')).toThrow(/tokenizers-linux-arm64-gnu.*missing or invalid/);
  });

  it('keeps version comparison at the documented glibc boundary', () => {
    expect(versionAtLeast('2.34', '2.34')).toBe(true);
    expect(versionAtLeast('2.39', '2.34')).toBe(true);
    expect(versionAtLeast('2.33', '2.34')).toBe(false);
    expect(versionAtLeast('unknown', '2.34')).toBe(false);
  });

  it('turns a dynamic-loader failure into an actionable dependency error', () => {
    expect(processFailureReason({
      status: 127,
      stderr: '/checkout/node_modules/electron/electron: error while loading shared libraries: libgtk-3.so.0: cannot open shared object file',
    })).toBe(
      'missing Linux shared library libgtk-3.so.0; install the Electron runtime library from your distribution and retry',
    );
  });

  it('locks the tokenizer release that publishes GNU x64 and arm64 binaries', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'));
    expect(packageJson.overrides['@anush008/tokenizers']).toBe('0.6.0');
    expect(lock.packages['node_modules/@anush008/tokenizers']?.version).toBe('0.6.0');
    expect(lock.packages['node_modules/@anush008/tokenizers-linux-x64-gnu']?.version).toBe('0.6.0');
    expect(lock.packages['node_modules/@anush008/tokenizers-linux-arm64-gnu']?.version).toBe('0.6.0');
    expect(packageJson.build.linux).toBeUndefined();
  });

  it('keeps real x64 and arm64 source journeys in Linux CI', () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), '.github', 'workflows', 'linux-source-smoke.yml'),
      'utf8',
    );
    expect(workflow).toContain('runner: ubuntu-22.04');
    expect(workflow).toContain('runner: ubuntu-22.04-arm');
    expect(workflow).toMatch(/run:\s+npm ci\s*$/m);
    expect(workflow).not.toContain('npm ci --ignore-scripts');
    expect(workflow).toContain('node scripts/ensure-dev-dependencies.cjs');
    expect(workflow).toContain('xvfb-run --auto-servernum npm run test:platform-native');
    expect(workflow).toContain('ORKAS_E2E_SHOW_WINDOW=1 xvfb-run --auto-servernum');
    expect(workflow).toContain('test/e2e/app_e2e_smoke.spec.ts');
    expect(workflow).toContain('xvfb-run --auto-servernum npm run test:linux-source');
    expect(workflow).toContain('npm run test:linux-whisper');
    expect(workflow).toContain('npm run test:linux-ocr');

    const nativeRunner = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'run-platform-native-tests.mjs'),
      'utf8',
    );
    expect(nativeRunner).toContain("['win32', 'darwin', 'linux']");
    expect(nativeRunner).toContain('test/main/util/linux-source-dependencies.test.ts');

    const dependencyProvisioner = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'ensure-dev-dependencies.cjs'),
      'utf8',
    );
    expect(dependencyProvisioner).toContain("run('Linux host preflight'");
    expect(dependencyProvisioner).toContain("run('Linux source dependencies'");

    expect(workflow.indexOf('node scripts/ensure-dev-dependencies.cjs')).toBeLessThan(
      workflow.indexOf('xvfb-run --auto-servernum npm run test:platform-native'),
    );

    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.sh'), 'utf8');
    expect(launcher).toContain('Node.js 20+ is required to bootstrap the source checkout');
    expect(launcher).toContain('verify-linux-source-dependencies.cjs\" --host-only');
  });
});
