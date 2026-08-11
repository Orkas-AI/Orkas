import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const gate = require('../../../bin/packaged-entrypoint-gate.cjs') as {
  BUILD_ONLY_BIN_FILES: readonly string[];
  CONNECTOR_RUNTIME_ENTRYPOINTS: readonly string[];
  CONNECTOR_RUNTIME_SMOKE_PROFILES: readonly { name: string; env: Record<string, string> }[];
  DORMANT_BIN_FILES: readonly string[];
  PACKAGED_BIN_ENTRYPOINTS: readonly string[];
  PACKAGED_BIN_HELPERS: readonly string[];
  PACKAGED_JS_LOADER_FILES: readonly { packageName: string; entry: string }[];
  PACKAGED_MCP_RUNTIME_FILES: readonly {
    lockPath: string;
    packagedPath?: string;
    packageName: string;
    entries: readonly string[];
  }[];
  PACKAGED_MCP_RUNTIME_UNPACK_GLOBS: readonly string[];
  requiredPackagedConnectorSmokeEntries(): string[];
  requiredPackagedEntrypointVerificationEntries(): string[];
  verifyBuildFilesConfig(build: unknown): string[];
  verifyPackagedConnectorRuntime(root: string): string[];
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
  for (const spec of gate.PACKAGED_MCP_RUNTIME_FILES) {
    const packageDir = path.join(pcRoot, ...(spec.packagedPath || spec.lockPath).split('/'));
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: spec.packageName,
      version: lock.packages[spec.lockPath].version,
    }));
    for (const relativeEntry of spec.entries) {
      const entry = path.join(packageDir, ...relativeEntry.split('/'));
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, 'module.exports = {};\n');
    }
  }
  return pcRoot;
}

function packagedRuntimeFixture(): string {
  const pcRoot = packagedFixture();
  for (const spec of gate.PACKAGED_MCP_RUNTIME_FILES) {
    const sourceDir = path.join(process.cwd(), ...spec.lockPath.split('/'));
    const packageDir = path.join(pcRoot, ...(spec.packagedPath || spec.lockPath).split('/'));
    fs.rmSync(packageDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(packageDir), { recursive: true });
    fs.cpSync(sourceDir, packageDir, { recursive: true });
    if (spec.packageName === '@modelcontextprotocol/sdk') {
      // electron-builder flattens the locked SDK dependencies into the
      // packaged root. Remove the source-only nested fallback so this fixture
      // cannot accidentally resolve a dependency that the package omitted.
      fs.rmSync(path.join(packageDir, 'node_modules'), { recursive: true, force: true });
    }
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
    expect(gate.BUILD_ONLY_BIN_FILES).toContain('packaged-dependency-gate.cjs');
    expect(gate.PACKAGED_BIN_HELPERS).toContain('proxy-bootstrap.cjs');
  });

  it('rejects a build-only helper that is not excluded from the app', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    packageJson.build.files = packageJson.build.files.filter(
      (entry: string) => entry !== '!bin/runtime-gate.cjs',
    );

    expect(() => gate.verifyBuildFilesConfig(packageJson.build)).toThrow(/runtime-gate\.cjs/);
  });

  it.each(['files', 'asarUnpack'] as const)(
    'rejects every MCP runtime glob omitted from build.%s',
    (field) => {
      for (const glob of gate.PACKAGED_MCP_RUNTIME_UNPACK_GLOBS) {
        const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
        packageJson.build[field] = packageJson.build[field].filter((entry: string) => entry !== glob);

        expect(
          () => gate.verifyBuildFilesConfig(packageJson.build),
          `${field} accepted missing connector runtime ${glob}`,
        ).toThrow(new RegExp(`${field} must include ${glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      }
    },
  );

  it('verifies the closed packaged bin tree and complete runtime dependency chains', () => {
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

  it('rejects an incomplete MCP runtime dependency closure', () => {
    const pcRoot = packagedFixture();
    fs.rmSync(path.join(
      pcRoot,
      'node_modules',
      '@modelcontextprotocol',
      'sdk',
      'dist',
      'cjs',
      'server',
      'index.js',
    ));

    expect(() => gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toThrow(/missing @modelcontextprotocol\/sdk runtime dist\/cjs\/server\/index\.js/);
  });

  it('initializes every packaged connector over direct and explicit-proxy stdio', () => {
    const pcRoot = packagedRuntimeFixture();

    expect(gate.verifyPackagedConnectorRuntime(pcRoot))
      .toEqual(gate.requiredPackagedConnectorSmokeEntries());
    expect(gate.requiredPackagedConnectorSmokeEntries()).toHaveLength(
      gate.CONNECTOR_RUNTIME_ENTRYPOINTS.length * gate.CONNECTOR_RUNTIME_SMOKE_PROFILES.length,
    );
  });

  it('reproduces the 1.6.2 failure when the packaged MCP SDK is absent', () => {
    const pcRoot = packagedRuntimeFixture();
    fs.rmSync(path.join(pcRoot, 'node_modules', '@modelcontextprotocol', 'sdk'), {
      recursive: true,
      force: true,
    });

    expect(() => gate.verifyPackagedConnectorRuntime(pcRoot))
      .toThrow(/connector smoke failed for direct bin\/bing-webmaster-mcp-server\.cjs.*@modelcontextprotocol\/sdk/s);
  });

  it('loads the explicit-proxy-only runtime instead of accepting a direct-mode false green', () => {
    const pcRoot = packagedRuntimeFixture();
    fs.rmSync(path.join(pcRoot, 'node_modules', 'undici'), { recursive: true, force: true });

    expect(() => gate.verifyPackagedConnectorRuntime(pcRoot))
      .toThrow(/connector smoke failed for env-proxy bin\/bing-webmaster-mcp-server\.cjs.*undici/s);
  });

  it('rejects a future connector import even before it is added to the manual package list', () => {
    const pcRoot = packagedRuntimeFixture();
    const entry = path.join(pcRoot, 'bin', 'bing-webmaster-mcp-server.cjs');
    const source = fs.readFileSync(entry, 'utf8');
    const shebangEnd = source.indexOf('\n') + 1;
    fs.writeFileSync(
      entry,
      `${source.slice(0, shebangEnd)}require('future-connector-runtime');\n${source.slice(shebangEnd)}`,
    );

    expect(() => gate.verifyPackagedConnectorRuntime(pcRoot))
      .toThrow(/connector smoke failed for direct bin\/bing-webmaster-mcp-server\.cjs.*future-connector-runtime/s);
  });

  it('rejects startup logs that corrupt the connector JSON-RPC stdout channel', () => {
    const pcRoot = packagedRuntimeFixture();
    const entry = path.join(pcRoot, 'bin', 'bing-webmaster-mcp-server.cjs');
    const source = fs.readFileSync(entry, 'utf8');
    const shebangEnd = source.indexOf('\n') + 1;
    fs.writeFileSync(
      entry,
      `${source.slice(0, shebangEnd)}process.stdout.write('unexpected startup log\\n');\n${source.slice(shebangEnd)}`,
    );

    expect(() => gate.verifyPackagedConnectorRuntime(pcRoot))
      .toThrow(/connector smoke produced invalid stdio for direct bin\/bing-webmaster-mcp-server\.cjs/);
  });
});
