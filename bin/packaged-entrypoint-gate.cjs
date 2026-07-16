#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

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
  const lockPath = `node_modules/${packageName}`;
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
  return expected;
}

function requiredPackagedEntrypointVerificationEntries() {
  return [
    ...PACKAGED_BIN_ENTRYPOINTS.map((name) => `entrypoint:bin/${name}`),
    ...PACKAGED_BIN_HELPERS.map((name) => `helper:bin/${name}`),
    ...PACKAGED_JS_LOADER_FILES.map((spec) => `loader:${spec.packageName}`),
  ];
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
  PACKAGED_BIN_HELPERS,
  CONNECTOR_CATALOG_SOURCE_FILES,
  DORMANT_BIN_FILES,
  GOOGLE_CONNECTOR_CATALOG_SOURCE,
  INTERNAL_ENTRYPOINT_CONSUMERS,
  PACKAGED_BIN_ENTRYPOINTS,
  PACKAGED_JS_LOADER_FILES,
  requiredPackagedEntrypointVerificationEntries,
  verifyBuildFilesConfig,
  verifyPackagedEntrypointPayload,
  verifySourceEntrypointContract,
};
