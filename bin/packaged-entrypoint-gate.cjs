#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

// Closed-world contract for CommonJS files under bin/. Runtime entrypoints are
// unpacked beside app.asar because the main process and connector transports
// spawn them by filesystem path. Build-only or dormant files must never expand
// the app's executable surface just because package.json includes bin/**/*.
const CONNECTOR_CATALOG_ENTRYPOINTS = Object.freeze([
  'bing-webmaster-mcp-server.cjs',
  'gcal-mcp-server.cjs',
  'gdocs-mcp-server.cjs',
  'gmail-mcp-server.cjs',
  'google-workspace-mcp-server.cjs',
  'gsearch-console-mcp-server.cjs',
  'gsheets-mcp-server.cjs',
  'gtasks-mcp-server.cjs',
]);

const CONNECTOR_CATALOG_SOURCE_FILES = Object.freeze([
  'src/main/features/connectors/catalog.ts',
  'src/main/features/connectors/catalog-google.ts',
]);
const GOOGLE_CONNECTOR_CATALOG_SOURCE = 'src/main/features/connectors/catalog-google.ts';

const INTERNAL_ENTRYPOINT_CONSUMERS = Object.freeze({
  'orkas-bridge.cjs': Object.freeze([
    'src/main/features/local_agents/bridge.ts',
    'src/main/features/local_agents/runner.ts',
  ]),
  'orkas-pkg.cjs': Object.freeze([
    'src/main/features/packages.ts',
    'src/main/model/core-agent/local-tools.ts',
  ]),
  'run-skill.cjs': Object.freeze([
    'src/main/model/core-agent/client.ts',
    'src/main/model/core-agent/local-tools.ts',
  ]),
});

// Every local connector process that can be launched by a released catalog
// entry. Composio is selected by manager.ts rather than a stdio catalog
// template, so include every internal entrypoint consumed by connector code
// before the entrypoints inferred from catalog transports.
const CONNECTOR_RUNTIME_ENTRYPOINTS = Object.freeze([
  ...Object.entries(INTERNAL_ENTRYPOINT_CONSUMERS)
    .filter(([, consumers]) => consumers.some(
      (relativeFile) => relativeFile.startsWith('src/main/features/connectors/'),
    ))
    .map(([name]) => name)
    .sort(),
  ...CONNECTOR_CATALOG_ENTRYPOINTS,
]);

const CONNECTOR_RUNTIME_SMOKE_PROFILES = Object.freeze([
  Object.freeze({ name: 'direct', env: Object.freeze({ ORKAS_PROXY_MODE: 'direct' }) }),
  Object.freeze({
    name: 'env-proxy',
    env: Object.freeze({
      ORKAS_PROXY_MODE: 'env',
      ORKAS_PROXY_HTTP_URL: 'http://127.0.0.1:9',
      ORKAS_PROXY_HTTPS_URL: 'http://127.0.0.1:9',
      ORKAS_PROXY_NO_PROXY: 'localhost,127.0.0.1,::1',
    }),
  }),
]);

const CONNECTOR_RUNTIME_SMOKE_REQUEST = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 'orkas-packaged-connector-smoke',
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'orkas-package-gate', version: '1.0.0' },
  },
})}\n`;

const PACKAGED_BIN_ENTRYPOINTS = Object.freeze([
  ...CONNECTOR_CATALOG_ENTRYPOINTS,
  ...Object.keys(INTERNAL_ENTRYPOINT_CONSUMERS),
].sort());

// Runtime-loaded helpers are packaged beside entrypoints but are not spawnable
// surfaces themselves. App-owned connector entrypoints load this proxy
// bootstrap so their fetch can follow the route selected by Electron main.
const PACKAGED_BIN_HELPERS = Object.freeze([
  'proxy-bootstrap.cjs',
]);

const DORMANT_BIN_FILES = Object.freeze([]);

const BUILD_ONLY_BIN_FILES = Object.freeze([
  'builtin-resource-gate.cjs',
  'ensure-runtime.cjs',
  'native-package-gate.cjs',
  'officecli-policy-gate.cjs',
  'packaged-dependency-gate.cjs',
  'packaged-entrypoint-gate.cjs',
  'packaged-resource-gate.cjs',
  'runtime-gate.cjs',
]);

// run-skill.cjs directly loads tsx/cjs. The remaining packages are tsx's real
// transpilation/resolution chain, including the JS launcher that selects the
// target @esbuild executable covered by native-package-gate.cjs.
const PACKAGED_JS_LOADER_FILES = Object.freeze([
  { packageName: 'tsx', entry: 'dist/cjs/index.cjs' },
  { packageName: 'get-tsconfig', entry: 'dist/index.cjs' },
  { packageName: 'resolve-pkg-maps', entry: 'dist/index.cjs' },
  { packageName: 'esbuild', entry: 'lib/main.js' },
]);

// Connector adapters are spawned from app.asar.unpacked/bin. Node resolves
// their npm imports from app.asar.unpacked/node_modules, not from the sibling
// app.asar archive, so every package loaded by the MCP server/stdio/type path
// must be unpacked as one closed runtime. The source lock keeps AJV under the
// SDK while electron-builder flattens it at the packaged root; the other
// packages are hoisted by npm. undici covers the explicit-proxy branch in
// proxy-bootstrap.cjs.
const PACKAGED_MCP_RUNTIME_UNPACK_GLOBS = Object.freeze([
  'node_modules/@modelcontextprotocol/sdk/**/*',
  'node_modules/ajv/**/*',
  'node_modules/ajv-formats/**/*',
  'node_modules/zod/**/*',
  'node_modules/zod-to-json-schema/**/*',
  'node_modules/fast-deep-equal/**/*',
  'node_modules/fast-uri/**/*',
  'node_modules/json-schema-traverse/**/*',
  'node_modules/undici/**/*',
]);

const PACKAGED_MCP_RUNTIME_FILES = Object.freeze([
  {
    lockPath: 'node_modules/@modelcontextprotocol/sdk',
    packageName: '@modelcontextprotocol/sdk',
    entries: ['dist/cjs/server/index.js', 'dist/cjs/server/stdio.js', 'dist/cjs/types.js'],
  },
  {
    lockPath: 'node_modules/@modelcontextprotocol/sdk/node_modules/ajv',
    packagedPath: 'node_modules/ajv',
    packageName: 'ajv',
    entries: ['dist/ajv.js'],
  },
  {
    lockPath: 'node_modules/@modelcontextprotocol/sdk/node_modules/ajv-formats',
    packagedPath: 'node_modules/ajv-formats',
    packageName: 'ajv-formats',
    entries: ['dist/index.js'],
  },
  { lockPath: 'node_modules/zod', packageName: 'zod', entries: ['index.cjs'] },
  {
    lockPath: 'node_modules/zod-to-json-schema',
    packageName: 'zod-to-json-schema',
    entries: ['dist/cjs/index.js'],
  },
  {
    lockPath: 'node_modules/fast-deep-equal',
    packageName: 'fast-deep-equal',
    entries: ['index.js'],
  },
  { lockPath: 'node_modules/fast-uri', packageName: 'fast-uri', entries: ['index.js'] },
  {
    lockPath: 'node_modules/json-schema-traverse',
    packageName: 'json-schema-traverse',
    entries: ['index.js'],
  },
  { lockPath: 'node_modules/undici', packageName: 'undici', entries: ['index.js'] },
]);

function slash(value) {
  return value.split(path.sep).join('/');
}

function isFile(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function requiredFile(label, file) {
  if (!isFile(file)) {
    throw new Error(`[packaged-entrypoint-gate] missing ${label}: ${file}`);
  }
}

function readJson(label, file) {
  requiredFile(label, file);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`[packaged-entrypoint-gate] invalid ${label}: ${file}: ${err.message}`);
  }
}

function assertCommonJsSyntax(label, file) {
  const source = fs.readFileSync(file, 'utf8').replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
  try {
    new vm.Script(Module.wrap(source), { filename: file });
  } catch (err) {
    throw new Error(`[packaged-entrypoint-gate] invalid ${label} syntax: ${file}: ${err.message}`);
  }
}

function packageLockVersion(packageLock, packageName) {
  return packageLockPathVersion(packageLock, `node_modules/${packageName}`);
}

function packageLockPathVersion(packageLock, lockPath) {
  const version = packageLock?.packages?.[lockPath]?.version;
  if (!version) {
    throw new Error(`[packaged-entrypoint-gate] package-lock.json missing ${lockPath}`);
  }
  return String(version);
}

function sourceBinFiles(projectRoot) {
  const binRoot = path.join(projectRoot, 'bin');
  if (!fs.existsSync(binRoot) || !fs.statSync(binRoot).isDirectory()) {
    throw new Error(`[packaged-entrypoint-gate] missing source bin directory: ${binRoot}`);
  }
  return fs.readdirSync(binRoot, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
}

function assertExactFiles(label, actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((name) => !actualSet.has(name));
  const unexpected = [...actualSet].filter((name) => !expectedSet.has(name));
  if (missing.length || unexpected.length) {
    const details = [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      unexpected.length ? `unregistered: ${unexpected.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`[packaged-entrypoint-gate] ${label} does not match the contract (${details})`);
  }
}

function verifyBuildFilesConfig(build) {
  const files = Array.isArray(build?.files) ? build.files.map(String) : [];
  const asarUnpack = Array.isArray(build?.asarUnpack) ? build.asarUnpack.map(String) : [];
  if (!files.includes('bin/**/*')) {
    throw new Error('[packaged-entrypoint-gate] build.files must include bin/**/*');
  }
  if (!asarUnpack.includes('bin/**/*')) {
    throw new Error('[packaged-entrypoint-gate] build.asarUnpack must include bin/**/*');
  }
  for (const glob of PACKAGED_MCP_RUNTIME_UNPACK_GLOBS) {
    if (!files.includes(glob)) {
      throw new Error(`[packaged-entrypoint-gate] build.files must include ${glob}`);
    }
    if (!asarUnpack.includes(glob)) {
      throw new Error(`[packaged-entrypoint-gate] build.asarUnpack must include ${glob}`);
    }
  }

  const expectedExclusions = [...BUILD_ONLY_BIN_FILES, ...DORMANT_BIN_FILES]
    .map((name) => `!bin/${name}`)
    .sort();
  const actualExclusions = files.filter((entry) => entry.startsWith('!bin/')).sort();
  assertExactFiles('build-only bin exclusions', actualExclusions, expectedExclusions);
  return expectedExclusions;
}

function verifyRuntimeConsumerReferences(projectRoot) {
  const catalogRefs = [];
  const activeGoogleIds = [];
  const catalogPattern = /\$\{ORKAS_PC_DIR\}\/bin\/([A-Za-z0-9._-]+\.cjs)/g;
  const activeGooglePattern = /requiredGoogleEntry\(['"]([A-Za-z0-9._-]+)['"]\)/g;
  for (const relativeFile of CONNECTOR_CATALOG_SOURCE_FILES) {
    const file = path.join(projectRoot, ...relativeFile.split('/'));
    requiredFile('connector catalog source', file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(catalogPattern)) catalogRefs.push(match[1]);
    for (const match of source.matchAll(activeGooglePattern)) activeGoogleIds.push(match[1]);
  }
  if (activeGoogleIds.length) {
    const googleFile = path.join(projectRoot, ...GOOGLE_CONNECTOR_CATALOG_SOURCE.split('/'));
    requiredFile('Google connector catalog source', googleFile);
    const googleSource = fs.readFileSync(googleFile, 'utf8');
    for (const id of new Set(activeGoogleIds)) {
      const idMarker = `id: '${id}'`;
      const start = googleSource.indexOf(idMarker);
      if (start < 0) {
        throw new Error(`[packaged-entrypoint-gate] active Google connector is missing from catalog-google.ts: ${id}`);
      }
      const next = googleSource.indexOf('\n  {', start + idMarker.length);
      const block = googleSource.slice(start, next < 0 ? googleSource.length : next);
      const adapter = block.match(/\$\{ORKAS_PC_DIR\}\/bin\/([A-Za-z0-9._-]+\.cjs)/)?.[1];
      if (!adapter) {
        throw new Error(`[packaged-entrypoint-gate] active Google connector has no local bin adapter: ${id}`);
      }
      catalogRefs.push(adapter);
    }
  }
  assertExactFiles(
    'active connector catalog entrypoints',
    [...new Set(catalogRefs)].sort(),
    [...CONNECTOR_CATALOG_ENTRYPOINTS].sort(),
  );

  for (const [entrypoint, consumers] of Object.entries(INTERNAL_ENTRYPOINT_CONSUMERS)) {
    for (const relativeFile of consumers) {
      const file = path.join(projectRoot, ...relativeFile.split('/'));
      requiredFile(`${entrypoint} consumer`, file);
      if (!fs.readFileSync(file, 'utf8').includes(entrypoint)) {
        throw new Error(
          `[packaged-entrypoint-gate] ${relativeFile} no longer references runtime entrypoint ${entrypoint}`,
        );
      }
    }
  }
}

function verifySourceEntrypointContract(projectRoot) {
  projectRoot = path.resolve(projectRoot);
  const expected = [
    ...PACKAGED_BIN_ENTRYPOINTS,
    ...PACKAGED_BIN_HELPERS,
    ...BUILD_ONLY_BIN_FILES,
    ...DORMANT_BIN_FILES,
  ].sort();
  assertExactFiles('source bin directory', sourceBinFiles(projectRoot), expected);

  for (const name of expected) {
    assertCommonJsSyntax(`source bin/${name}`, path.join(projectRoot, 'bin', name));
  }

  const packageJson = readJson('package.json', path.join(projectRoot, 'package.json'));
  verifyBuildFilesConfig(packageJson.build);
  verifyRuntimeConsumerReferences(projectRoot);
  const packageLock = readJson('package-lock.json', path.join(projectRoot, 'package-lock.json'));
  for (const spec of PACKAGED_JS_LOADER_FILES) packageLockVersion(packageLock, spec.packageName);
  for (const spec of PACKAGED_MCP_RUNTIME_FILES) packageLockPathVersion(packageLock, spec.lockPath);
  return expected;
}

function requiredPackagedEntrypointVerificationEntries() {
  return [
    ...PACKAGED_BIN_ENTRYPOINTS.map((name) => `entrypoint:bin/${name}`),
    ...PACKAGED_BIN_HELPERS.map((name) => `helper:bin/${name}`),
    ...PACKAGED_JS_LOADER_FILES.map((spec) => `loader:${spec.packageName}`),
    ...PACKAGED_MCP_RUNTIME_FILES.map((spec) => `mcp-runtime:${spec.lockPath}`),
  ];
}

function requiredPackagedConnectorSmokeEntries() {
  return CONNECTOR_RUNTIME_SMOKE_PROFILES.flatMap((profile) => (
    CONNECTOR_RUNTIME_ENTRYPOINTS.map(
      (name) => `connector-smoke:${profile.name}:bin/${name}`,
    )
  ));
}

function boundedOutput(value) {
  const text = String(value || '').trim();
  return text.length <= 1200 ? text : `${text.slice(0, 1200)}…`;
}

function verifyPackagedConnectorRuntime(pcRoot, options = {}) {
  pcRoot = path.resolve(pcRoot);
  const nodeExecutable = path.resolve(options.nodeExecutable || process.execPath);
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1000, Math.min(Number(options.timeoutMs), 30_000))
    : 10_000;
  requiredFile('connector smoke Node executable', nodeExecutable);

  const baseEnv = { ...process.env };
  // The smoke must resolve solely from app.asar.unpacked. Developer/CI module
  // injection would recreate the exact false green that let 1.6.2 ship.
  delete baseEnv.NODE_PATH;
  delete baseEnv.NODE_OPTIONS;
  delete baseEnv.ORKAS_PROXY_MODE;
  delete baseEnv.ORKAS_PROXY_HTTP_URL;
  delete baseEnv.ORKAS_PROXY_HTTPS_URL;
  delete baseEnv.ORKAS_PROXY_NO_PROXY;

  const verified = [];
  for (const profile of CONNECTOR_RUNTIME_SMOKE_PROFILES) {
    for (const name of CONNECTOR_RUNTIME_ENTRYPOINTS) {
      const entry = path.join(pcRoot, 'bin', name);
      requiredFile(`connector runtime entrypoint bin/${name}`, entry);
      const result = spawnSync(nodeExecutable, [entry], {
        cwd: pcRoot,
        env: {
          ...baseEnv,
          ELECTRON_RUN_AS_NODE: '1',
          ...profile.env,
        },
        input: CONNECTOR_RUNTIME_SMOKE_REQUEST,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      const stderr = boundedOutput(result.stderr);
      if (result.error || result.status !== 0) {
        const reason = result.error
          ? result.error.message
          : `exit ${result.status ?? result.signal ?? 'unknown'}`;
        throw new Error(
          `[packaged-entrypoint-gate] connector smoke failed for ${profile.name} bin/${name}: ${reason}`
          + (stderr ? `: ${stderr}` : ''),
        );
      }
      if (stderr) {
        throw new Error(
          `[packaged-entrypoint-gate] connector smoke wrote stderr for ${profile.name} bin/${name}: ${stderr}`,
        );
      }

      const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
      if (lines.length !== 1) {
        throw new Error(
          `[packaged-entrypoint-gate] connector smoke produced invalid stdio for ${profile.name} bin/${name}`,
        );
      }
      let response;
      try {
        response = JSON.parse(lines[0]);
      } catch (err) {
        throw new Error(
          `[packaged-entrypoint-gate] connector smoke returned invalid JSON for ${profile.name} bin/${name}: ${err.message}`,
        );
      }
      if (response?.id !== 'orkas-packaged-connector-smoke'
          || response?.jsonrpc !== '2.0'
          || typeof response?.result?.protocolVersion !== 'string'
          || !response?.result?.serverInfo?.name
          || !response?.result?.capabilities?.tools) {
        throw new Error(
          `[packaged-entrypoint-gate] connector smoke returned invalid initialize response for ${profile.name} bin/${name}`,
        );
      }
      verified.push(`connector-smoke:${profile.name}:bin/${name}`);
    }
  }

  const missingResults = requiredPackagedConnectorSmokeEntries()
    .filter((entry) => !verified.includes(entry));
  if (missingResults.length) {
    throw new Error(`[packaged-entrypoint-gate] connector smoke has no result for: ${missingResults.join(', ')}`);
  }
  return verified;
}

function verifyPackagedEntrypointPayload(pcRoot, options = {}) {
  pcRoot = path.resolve(pcRoot);
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'));
  const binRoot = path.join(pcRoot, 'bin');
  if (!fs.existsSync(binRoot) || !fs.statSync(binRoot).isDirectory()) {
    throw new Error(`[packaged-entrypoint-gate] missing packaged bin directory: ${binRoot}`);
  }
  const actualBinFiles = fs.readdirSync(binRoot, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  assertExactFiles(
    'packaged bin directory',
    actualBinFiles,
    [...PACKAGED_BIN_ENTRYPOINTS, ...PACKAGED_BIN_HELPERS].sort(),
  );

  const verified = [];
  for (const name of PACKAGED_BIN_ENTRYPOINTS) {
    const file = path.join(binRoot, name);
    requiredFile(`runtime entrypoint bin/${name}`, file);
    assertCommonJsSyntax(`runtime entrypoint bin/${name}`, file);
    verified.push(`entrypoint:bin/${name}`);
  }
  for (const name of PACKAGED_BIN_HELPERS) {
    const file = path.join(binRoot, name);
    requiredFile(`runtime helper bin/${name}`, file);
    assertCommonJsSyntax(`runtime helper bin/${name}`, file);
    verified.push(`helper:bin/${name}`);
  }

  const packageLock = options.packageLock
    || readJson('package-lock.json', path.join(projectRoot, 'package-lock.json'));
  const nodeModules = path.join(pcRoot, 'node_modules');
  for (const spec of PACKAGED_JS_LOADER_FILES) {
    const packageDir = path.join(nodeModules, ...spec.packageName.split('/'));
    const packageJson = readJson(`${spec.packageName} package.json`, path.join(packageDir, 'package.json'));
    const expectedVersion = packageLockVersion(packageLock, spec.packageName);
    if (String(packageJson.version || '') !== expectedVersion) {
      throw new Error(
        `[packaged-entrypoint-gate] ${spec.packageName} version mismatch: packaged=${packageJson.version || '(missing)'} lock=${expectedVersion}`,
      );
    }
    const entry = path.join(packageDir, ...spec.entry.split('/'));
    requiredFile(`${spec.packageName} loader ${spec.entry}`, entry);
    assertCommonJsSyntax(`${spec.packageName} loader ${spec.entry}`, entry);
    verified.push(`loader:${spec.packageName}`);
  }

  for (const spec of PACKAGED_MCP_RUNTIME_FILES) {
    const packageDir = path.join(pcRoot, ...(spec.packagedPath || spec.lockPath).split('/'));
    const packageJson = readJson(`${spec.packageName} package.json`, path.join(packageDir, 'package.json'));
    const expectedVersion = packageLockPathVersion(packageLock, spec.lockPath);
    if (String(packageJson.version || '') !== expectedVersion) {
      throw new Error(
        `[packaged-entrypoint-gate] ${spec.lockPath} version mismatch: packaged=${packageJson.version || '(missing)'} lock=${expectedVersion}`,
      );
    }
    for (const relativeEntry of spec.entries) {
      const entry = path.join(packageDir, ...relativeEntry.split('/'));
      requiredFile(`${spec.packageName} runtime ${relativeEntry}`, entry);
      assertCommonJsSyntax(`${spec.packageName} runtime ${relativeEntry}`, entry);
    }
    verified.push(`mcp-runtime:${spec.lockPath}`);
  }

  const missingResults = requiredPackagedEntrypointVerificationEntries()
    .filter((entry) => !verified.includes(entry));
  if (missingResults.length) {
    throw new Error(`[packaged-entrypoint-gate] verifier has no result for: ${missingResults.join(', ')}`);
  }
  return verified;
}

module.exports = {
  BUILD_ONLY_BIN_FILES,
  CONNECTOR_CATALOG_ENTRYPOINTS,
  CONNECTOR_RUNTIME_ENTRYPOINTS,
  CONNECTOR_RUNTIME_SMOKE_PROFILES,
  PACKAGED_BIN_HELPERS,
  CONNECTOR_CATALOG_SOURCE_FILES,
  DORMANT_BIN_FILES,
  GOOGLE_CONNECTOR_CATALOG_SOURCE,
  INTERNAL_ENTRYPOINT_CONSUMERS,
  PACKAGED_BIN_ENTRYPOINTS,
  PACKAGED_JS_LOADER_FILES,
  PACKAGED_MCP_RUNTIME_FILES,
  PACKAGED_MCP_RUNTIME_UNPACK_GLOBS,
  requiredPackagedConnectorSmokeEntries,
  requiredPackagedEntrypointVerificationEntries,
  verifyBuildFilesConfig,
  verifyPackagedConnectorRuntime,
  verifyPackagedEntrypointPayload,
  verifySourceEntrypointContract,
};
