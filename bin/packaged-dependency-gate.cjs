#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const asar = require('@electron/asar');
const semver = require('semver');

const TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64']);
const PACKAGE_ROOT_PATTERN = /^(?:node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/;

function fail(message) {
  throw new Error(`[packaged-dependency-gate] ${message}`);
}

function targetKey(platform, arch) {
  return `${platform}-${arch}`;
}

function readJson(label, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail(`missing ${label}: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`invalid ${label}: ${file}: ${err.message}`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
}

function sameJson(left, right) {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

function packageRootFromManifestPath(manifestPath) {
  const normalized = String(manifestPath).replace(/^\/+/, '');
  if (normalized === 'package.json') return '';
  if (!normalized.endsWith('/package.json')) return null;
  const packageRoot = normalized.slice(0, -'/package.json'.length);
  return PACKAGE_ROOT_PATTERN.test(packageRoot) ? packageRoot : null;
}

function readAsarJson(appAsar, manifestPath) {
  try {
    return JSON.parse(asar.extractFile(appAsar, manifestPath).toString('utf8'));
  } catch (err) {
    fail(`invalid ${manifestPath} in ${appAsar}: ${err.message}`);
  }
}

function readPackagedManifests(appAsar) {
  if (!fs.existsSync(appAsar) || !fs.statSync(appAsar).isFile()) {
    fail(`missing app.asar: ${appAsar}`);
  }

  let entries;
  try {
    entries = asar.listPackage(appAsar);
  } catch (err) {
    fail(`cannot read app.asar: ${appAsar}: ${err.message}`);
  }

  const manifests = new Map();
  for (const entry of entries) {
    const manifestPath = String(entry).replace(/^\/+/, '');
    const packageRoot = packageRootFromManifestPath(manifestPath);
    if (packageRoot === null) continue;
    if (manifests.has(packageRoot)) {
      fail(`duplicate package manifest root in app.asar: ${packageRoot || '(app root)'}`);
    }
    const manifest = readAsarJson(appAsar, manifestPath);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      fail(`package manifest is not an object: ${manifestPath}`);
    }
    manifests.set(packageRoot, manifest);
  }

  if (!manifests.has('')) fail(`app.asar has no root package.json: ${appAsar}`);
  return manifests;
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  return index >= 0 ? lockPath.slice(index + marker.length) : '';
}

function lockedVersionsByName(lock) {
  const versions = new Map();
  for (const [lockPath, entry] of Object.entries(lock.packages || {})) {
    if (!lockPath || !entry || !entry.version) continue;
    const packageName = String(entry.name || packageNameFromLockPath(lockPath));
    if (!packageName) continue;
    if (!versions.has(packageName)) versions.set(packageName, new Set());
    versions.get(packageName).add(String(entry.version));
  }
  return versions;
}

function validateRootContract(packagedRoot, sourcePackage, lock) {
  const lockRoot = lock.packages?.[''];
  if (!lockRoot) fail('package-lock.json has no root packages entry');

  for (const key of ['name', 'version', 'main', 'dependencies', 'optionalDependencies', 'overrides']) {
    if (!sameJson(packagedRoot[key], sourcePackage[key])) {
      fail(`app.asar root ${key} differs from source package.json`);
    }
  }
  for (const key of ['name', 'version', 'dependencies', 'optionalDependencies']) {
    if (!sameJson(lockRoot[key], sourcePackage[key])) {
      fail(`package-lock.json root ${key} differs from source package.json`);
    }
  }

  const overrides = sourcePackage.overrides || {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    fail('source package.json overrides must be an object');
  }
  for (const [packageName, spec] of Object.entries(overrides)) {
    if (typeof spec !== 'string' || !spec.trim()) {
      fail(`unsupported override for ${packageName}; dependency gate currently requires a non-empty string version/range`);
    }
  }
}

function listMatchesTarget(values, target) {
  if (!Array.isArray(values) || values.length === 0) return true;
  const normalized = values.map(String);
  if (normalized.includes(`!${target}`)) return false;
  const positive = normalized.filter((value) => !value.startsWith('!'));
  return positive.length === 0 || positive.includes(target);
}

function isPlatformSpecific(manifest) {
  return (Array.isArray(manifest.os) && manifest.os.length > 0)
    || (Array.isArray(manifest.cpu) && manifest.cpu.length > 0);
}

function validateTargetCompatibility(record, platform, arch) {
  if (!listMatchesTarget(record.manifest.os, platform)) {
    fail(`${record.name}@${record.version} at ${record.root} is incompatible with target OS ${platform}`);
  }
  if (!listMatchesTarget(record.manifest.cpu, arch)) {
    fail(`${record.name}@${record.version} at ${record.root} is incompatible with target CPU ${arch}`);
  }
}

function packageRecords(manifests, lockedVersions, platform, arch) {
  const records = new Map();
  for (const [root, manifest] of manifests) {
    if (root === '') continue;
    const name = String(manifest.name || '');
    const version = String(manifest.version || '');
    if (!name || !semver.valid(version)) {
      fail(`invalid packaged package identity at ${root}: ${name || '(missing)'}@${version || '(missing)'}`);
    }
    const allowed = lockedVersions.get(name);
    if (!allowed || !allowed.has(version)) {
      fail(`${name}@${version} at ${root} is not present in package-lock.json`);
    }
    const record = {
      root,
      name,
      version,
      manifest,
      platformSpecific: isPlatformSpecific(manifest),
    };
    validateTargetCompatibility(record, platform, arch);
    records.set(root, record);
  }
  return records;
}

function parentPackageRoot(packageRoot) {
  const index = packageRoot.lastIndexOf('/node_modules/');
  return index >= 0 ? packageRoot.slice(0, index) : '';
}

function resolveDependency(records, fromRoot, dependencyName) {
  let current = fromRoot;
  while (true) {
    const candidate = current
      ? `${current}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (records.has(candidate)) return records.get(candidate);
    if (!current) return null;
    current = parentPackageRoot(current);
  }
}

function dependencySpecs(manifest) {
  const specs = new Map();
  for (const [name, spec] of Object.entries(manifest.dependencies || {})) {
    specs.set(name, { name, spec: String(spec), required: true, kind: 'dependency' });
  }
  for (const [name, spec] of Object.entries(manifest.optionalDependencies || {})) {
    specs.set(name, { name, spec: String(spec), required: false, kind: 'optional dependency' });
  }
  for (const [name, spec] of Object.entries(manifest.peerDependencies || {})) {
    if (specs.has(name)) continue;
    const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
    specs.set(name, { name, spec: String(spec), required: !optional, kind: optional ? 'optional peer dependency' : 'peer dependency' });
  }
  return [...specs.values()];
}

function npmAlias(spec) {
  if (!spec.startsWith('npm:')) return null;
  const value = spec.slice('npm:'.length);
  const split = value.lastIndexOf('@');
  if (split <= 0 || split === value.length - 1) {
    fail(`unsupported npm alias dependency spec: ${spec}`);
  }
  return { packageName: value.slice(0, split), range: value.slice(split + 1) };
}

function normalizedSemverRange(spec) {
  if (spec.startsWith('workspace:')) {
    const value = spec.slice('workspace:'.length);
    if (value === '' || value === '*' || value === '^' || value === '~') return '*';
    return value;
  }
  return spec;
}

function isExternallyResolvedSpec(spec) {
  return /^(?:file:|link:|https?:|git(?:\+|:)|github:|gitlab:|bitbucket:)/.test(spec);
}

function validateResolvedVersion(edge, resolved, overrides) {
  const override = Object.prototype.hasOwnProperty.call(overrides, edge.name)
    ? String(overrides[edge.name])
    : '';
  const effectiveSpec = override || edge.spec;
  const alias = npmAlias(effectiveSpec);
  if (alias && resolved.name !== alias.packageName) {
    fail(`${edge.kind} ${edge.name}@${effectiveSpec} resolved to unexpected package ${resolved.name}@${resolved.version} at ${resolved.root}`);
  }
  const rangeText = normalizedSemverRange(alias ? alias.range : effectiveSpec);
  const range = semver.validRange(rangeText);
  if (range) {
    if (!semver.satisfies(resolved.version, range)) {
      const overrideDetail = override ? ` (root override ${edge.name}@${override})` : '';
      fail(`${edge.kind} ${edge.name}@${edge.spec}${overrideDetail} resolved to ${resolved.name}@${resolved.version} at ${resolved.root}`);
    }
  } else if (!isExternallyResolvedSpec(rangeText)) {
    fail(`unsupported dependency range ${edge.name}@${effectiveSpec}; cannot verify packaged version`);
  }
  return override ? 1 : 0;
}

function verifyDirectDependencies(sourcePackage, lock, records) {
  for (const [name, spec] of Object.entries(sourcePackage.dependencies || {})) {
    const record = records.get(`node_modules/${name}`);
    if (!record) fail(`missing direct production dependency ${name}@${spec} from app.asar`);
    const expected = lock.packages?.[`node_modules/${name}`]?.version;
    if (!expected) fail(`package-lock.json has no top-level entry for direct dependency ${name}`);
    if (record.version !== String(expected)) {
      fail(`direct dependency ${name} version mismatch: packaged=${record.version} lock=${expected}`);
    }
  }
}

function verifyResolvedGraph(sourcePackage, rootManifest, records) {
  const overrides = sourcePackage.overrides || {};
  const reachable = new Set();
  const queue = [{ root: '', name: sourcePackage.name, version: sourcePackage.version, manifest: rootManifest }];
  let edgeCount = 0;
  let overrideEdgeCount = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of dependencySpecs(current.manifest)) {
      const resolved = resolveDependency(records, current.root, edge.name);
      if (!resolved) {
        if (!edge.required) continue;
        fail(`${current.name}@${current.version} at ${current.root || '(app root)'} is missing ${edge.kind} ${edge.name}@${edge.spec}`);
      }
      overrideEdgeCount += validateResolvedVersion(edge, resolved, overrides);
      edgeCount += 1;
      if (!reachable.has(resolved.root)) {
        reachable.add(resolved.root);
        queue.push(resolved);
      }
    }
  }

  const unexpected = [...records.values()]
    .filter((record) => !reachable.has(record.root))
    .map((record) => `${record.root} (${record.name}@${record.version})`)
    .sort();
  if (unexpected.length > 0) {
    fail(`unreachable package(s) in app.asar: ${unexpected.join(', ')}`);
  }
  return { edgeCount, overrideEdgeCount };
}

function inventoryCounts(records, predicate) {
  const counts = {};
  for (const record of records.values()) {
    if (!predicate(record)) continue;
    const key = `${record.name}@${record.version}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function verifyPackagedDependencyGraphWithRawFs(options) {
  const { appAsar, packageJsonFile, packageLockFile, platform, arch } = options || {};
  const key = targetKey(platform, arch);
  if (!TARGETS.has(key)) fail(`unsupported packaged dependency target: ${key}`);

  const sourcePackage = readJson('source package.json', packageJsonFile);
  const lock = readJson('source package-lock.json', packageLockFile);
  const manifests = readPackagedManifests(appAsar);
  const rootManifest = manifests.get('');
  validateRootContract(rootManifest, sourcePackage, lock);

  const records = packageRecords(manifests, lockedVersionsByName(lock), platform, arch);
  verifyDirectDependencies(sourcePackage, lock, records);
  const graph = verifyResolvedGraph(sourcePackage, rootManifest, records);
  const packageCount = records.size;

  return {
    platform,
    arch,
    packageCount,
    edgeCount: graph.edgeCount,
    overrideEdgeCount: graph.overrideEdgeCount,
    neutralInventory: inventoryCounts(records, (record) => !record.platformSpecific),
    platformInventory: inventoryCounts(records, (record) => record.platformSpecific),
    // mac x64/arm64 packages that are OS-specific but support both CPUs must
    // still match exactly. Only packages whose cpu contract excludes one of
    // those architectures are allowed to differ across the two builds.
    crossArchInventory: inventoryCounts(
      records,
      (record) => listMatchesTarget(record.manifest.cpu, 'x64')
        && listMatchesTarget(record.manifest.cpu, 'arm64'),
    ),
    verificationEntry: `dependency:lock-graph:${key}:packages=${packageCount}:edges=${graph.edgeCount}:overrides=${graph.overrideEdgeCount}`,
  };
}

function verifyPackagedDependencyGraph(options) {
  // Electron patches fs so a physical *.asar file appears as a directory.
  // afterPack and the release validator normally run in plain Node, but the
  // same verifier is also exercised by Electron-hosted Vitest. Disable that
  // virtual filesystem only while reading the physical archive, then restore
  // the caller's state exactly.
  const hadNoAsar = Object.prototype.hasOwnProperty.call(process, 'noAsar');
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    return verifyPackagedDependencyGraphWithRawFs(options);
  } finally {
    if (hadNoAsar) process.noAsar = previousNoAsar;
    else delete process.noAsar;
  }
}

function formatInventoryDifference(left, right) {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys
    .filter((key) => (left[key] || 0) !== (right[key] || 0))
    .map((key) => `${key} (${left[key] || 0} vs ${right[key] || 0})`);
}

function comparePackagedDependencyInventories(left, right) {
  if (!left || !right) fail('two packaged dependency verification results are required');
  if (left.platform !== right.platform) {
    fail(`cannot compare dependency inventories across platforms: ${left.platform} vs ${right.platform}`);
  }
  const leftInventory = left.crossArchInventory || left.neutralInventory || {};
  const rightInventory = right.crossArchInventory || right.neutralInventory || {};
  const differences = formatInventoryDifference(leftInventory, rightInventory);
  if (differences.length > 0) {
    fail(`platform-neutral dependency inventory differs for ${left.platform}/${left.arch} and ${right.platform}/${right.arch}: ${differences.join(', ')}`);
  }
  return `dependency:cross-arch-inventory:${left.platform}:${left.arch}=${right.arch}:packages=${Object.values(leftInventory).reduce((sum, count) => sum + count, 0)}`;
}

module.exports = {
  TARGETS,
  comparePackagedDependencyInventories,
  packageRootFromManifestPath,
  verifyPackagedDependencyGraph,
};
