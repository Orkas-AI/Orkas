#!/usr/bin/env node
/**
 * Fail fast when node_modules has drifted from package-lock.json.
 *
 * This repository takes frequent parallel pushes, so a merge routinely advances
 * the lockfile while the working tree keeps whatever was installed earlier. The
 * resulting test failures are actively misleading: a stale SDK made
 * `provider_catalog` report that it could not resolve `claude-fable-5`, which
 * reads as a broken model catalog rather than an uninstalled dependency.
 *
 * Only direct dependencies are compared, and only their installed version
 * against the lockfile's resolved version. Transitive drift surfaces through
 * the same direct packages in practice, and walking the whole tree would cost
 * more than the check is worth on every test run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PC_ROOT = path.resolve(HERE, '..');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @returns {{ checked: number, drifted: Array<{name: string, expected: string, installed: string｜null}> }}
 */
export function installedDependencyDrift(pcRoot = DEFAULT_PC_ROOT) {
  const pkg = readJson(path.join(pcRoot, 'package.json'));
  const lock = readJson(path.join(pcRoot, 'package-lock.json'));
  if (!pkg || !lock?.packages) return { checked: 0, drifted: [] };

  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const drifted = [];
  let checked = 0;

  for (const name of declared) {
    const entry = lock.packages[`node_modules/${name}`];
    const expected = entry?.version;
    if (!expected) continue;
    // Optional packages are legitimately absent on platforms they do not build
    // for, so their absence is not drift.
    if (entry.optional) continue;
    const installedPkg = readJson(path.join(pcRoot, 'node_modules', name, 'package.json'));
    // A missing package.json means the dependency is absent entirely, which is
    // as much drift as a version mismatch.
    const installed = installedPkg?.version ?? null;
    checked++;
    if (installed !== expected) drifted.push({ name, expected, installed });
  }

  return { checked, drifted };
}

export function formatDriftReport(drifted) {
  const lines = [
    '',
    'Installed dependencies do not match package-lock.json:',
    ...drifted.map(({ name, expected, installed }) => (
      `  ${name}: lockfile ${expected}, installed ${installed ?? '(missing)'}`
    )),
    '',
    'Run `npm install` before the tests. Skipping it produces failures that',
    'look like product bugs — a stale SDK reports missing models, a stale',
    'native addon reports an ABI error — instead of naming the real cause.',
    '',
  ];
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { drifted } = installedDependencyDrift();
  if (drifted.length) {
    process.stderr.write(formatDriftReport(drifted));
    process.exit(1);
  }
}
