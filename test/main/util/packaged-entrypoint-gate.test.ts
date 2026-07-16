import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const gate = require('../../../bin/packaged-entrypoint-gate.cjs') as {
  BUILD_ONLY_BIN_FILES: readonly string[];
  DORMANT_BIN_FILES: readonly string[];
  PACKAGED_BIN_ENTRYPOINTS: readonly string[];
  PACKAGED_BIN_HELPERS: readonly string[];
  PACKAGED_JS_LOADER_FILES: readonly { packageName: string; entry: string }[];
  requiredPackagedEntrypointVerificationEntries(): string[];
  verifyBuildFilesConfig(build: unknown): string[];
  verifyPackagedEntrypointPayload(root: string, options: { projectRoot: string }): string[];
  verifySourceEntrypointContract(root: string): string[];
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-entrypoint-gate-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function packagedFixture(): string {
  const pcRoot = path.join(tmpDir, 'app.asar.unpacked');
  const binRoot = path.join(pcRoot, 'bin');
  fs.mkdirSync(binRoot, { recursive: true });
  for (const name of gate.PACKAGED_BIN_ENTRYPOINTS) {
    fs.copyFileSync(path.join(process.cwd(), 'bin', name), path.join(binRoot, name));
  }
  for (const name of gate.PACKAGED_BIN_HELPERS) {
    fs.copyFileSync(path.join(process.cwd(), 'bin', name), path.join(binRoot, name));
  }

  const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'));
  for (const spec of gate.PACKAGED_JS_LOADER_FILES) {
    const packageDir = path.join(pcRoot, 'node_modules', ...spec.packageName.split('/'));
    const entry = path.join(packageDir, ...spec.entry.split('/'));
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: spec.packageName,
      version: lock.packages[`node_modules/${spec.packageName}`].version,
    }));
    fs.writeFileSync(entry, 'module.exports = {};\n');
  }
  return pcRoot;
}

describe('packaged-entrypoint-gate', () => {
  it('keeps every source bin file classified and package exclusions synchronized', () => {
    const verified = gate.verifySourceEntrypointContract(process.cwd());

    expect(verified).toHaveLength(
      gate.PACKAGED_BIN_ENTRYPOINTS.length
        + gate.PACKAGED_BIN_HELPERS.length
        + gate.BUILD_ONLY_BIN_FILES.length
        + gate.DORMANT_BIN_FILES.length,
    );
    expect(gate.BUILD_ONLY_BIN_FILES).toContain('packaged-entrypoint-gate.cjs');
    expect(gate.PACKAGED_BIN_HELPERS).toContain('proxy-bootstrap.cjs');
  });

  it('rejects a build-only helper that is not excluded from the app', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    packageJson.build.files = packageJson.build.files.filter(
      (entry: string) => entry !== '!bin/runtime-gate.cjs',
    );

    expect(() => gate.verifyBuildFilesConfig(packageJson.build)).toThrow(/runtime-gate\.cjs/);
  });

  it('verifies the closed packaged bin tree and complete TypeScript loader chain', () => {
    const pcRoot = packagedFixture();

    expect(gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toEqual(gate.requiredPackagedEntrypointVerificationEntries());
  });

  it('rejects build-only or newly introduced files in the packaged bin tree', () => {
    const pcRoot = packagedFixture();
    fs.writeFileSync(path.join(pcRoot, 'bin', 'runtime-gate.cjs'), 'module.exports = {};\n');

    expect(() => gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toThrow(/unregistered: runtime-gate\.cjs/);
  });

  it('rejects an incomplete loader chain', () => {
    const pcRoot = packagedFixture();
    fs.rmSync(path.join(pcRoot, 'node_modules', 'esbuild', 'lib', 'main.js'));

    expect(() => gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toThrow(/missing esbuild loader lib\/main\.js/);
  });
});
