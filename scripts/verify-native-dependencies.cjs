#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { probeSharp, probeSqlite } = require('./native-dependency-probe.cjs');

const MINIMUM_NODE_VERSION = '22.12.0';
const PROBE_TIMEOUT_MS = 60_000;
const root = path.resolve(__dirname, '..');

// Built-ins only: this preflight also runs before node_modules exists.
function assertBootstrapNode(version = process.versions.node) {
  const parts = String(version).split('.');
  const valid = parts.length === 3 && parts.every(part => /^\d+$/.test(part));
  if (!valid || Number(parts[0]) < 22 || (Number(parts[0]) === 22 && Number(parts[1]) < 12)) {
    throw new Error(`Node.js ${MINIMUM_NODE_VERSION}+ is required to prepare native dependencies; use Node.js 24 LTS and retry.`);
  }
}

function verifyNativeDependencies({ packageRoot = root, spawn = spawnSync, env = process.env } = {}) {
  assertBootstrapNode();
  const requirePackage = createRequire(path.join(packageRoot, 'package.json'));
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package-lock.json'), 'utf8')); }
  catch { throw new Error('Cannot read package-lock.json; restore the checkout lockfile, then run npm run native:repair.'); }
  for (const name of ['electron', 'better-sqlite3', 'sqlite-vec', 'sharp']) {
    const expected = lock.packages?.[`node_modules/${name}`]?.version;
    let installed;
    try { installed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'node_modules', name, 'package.json'), 'utf8')).version; }
    catch { /* handled as an incomplete installation below */ }
    if (!expected || installed !== expected) {
      throw new Error(`${name} does not match package-lock.json; run npm run native:repair in this checkout.`);
    }
  }
  const electronVersion = lock.packages['node_modules/electron'].version;
  let electronPath;
  try { electronPath = requirePackage('electron'); }
  catch { throw new Error('Electron is not installed correctly; run npm run native:repair in this checkout.'); }
  // Use the target Electron's require, never this system Node's addon loader.
  const script = `
    const { createRequire } = require('node:module');
    const requirePackage = createRequire(${JSON.stringify(path.join(packageRoot, 'package.json'))});
    (async () => {
      const sqlite = await (${probeSqlite.toString()})(requirePackage);
      const sharp = await (${probeSharp.toString()})(requirePackage);
      console.log(JSON.stringify({status:'passed', ...sqlite, ...sharp,
        platform:process.platform, arch:process.arch, electron:process.versions.electron,
        node:process.versions.node, modules:process.versions.modules, napi:process.versions.napi}));
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  const result = spawn(electronPath, ['-e', script], {
    cwd: packageRoot, env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  let record;
  try { record = JSON.parse(String(result.stdout || '').trim()); } catch { /* fail closed */ }
  if (result.error || result.status !== 0 || String(result.stderr || '').trim()
    || record?.status !== 'passed' || record.electron !== electronVersion
    || record.platform !== process.platform || record.arch !== process.arch
    || typeof record.sqliteVec !== 'string' || !record.sqliteVec
    || record.vectorDistance !== 5 || record.sharp !== 'png-2x2') {
    // Only relay the bounded messages authored by our probe. Native stderr can
    // contain private paths; unknown loader failures keep the recovery context.
    const known = ['better-sqlite3', 'sqlite-vec', 'sharp'].find(name =>
      String(result.stderr || '').startsWith(`${name} could not complete`));
    const reason = result.error?.code === 'ETIMEDOUT' ? 'timed out' : 'failed';
    throw new Error(`Native dependency verification ${reason}${known ? ` (${known})` : ''} for Electron ${electronVersion} on ${process.platform}-${process.arch}. Run npm run native:repair; check optional packages, the target architecture and system shared libraries.`);
  }
  return record;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--host-only')) throw new Error('Use --host-only or no arguments.');
    assertBootstrapNode();
    if (process.argv[2] !== '--host-only') console.log(JSON.stringify(verifyNativeDependencies()));
  } catch (error) {
    console.error(`[native-deps] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { MINIMUM_NODE_VERSION, PROBE_TIMEOUT_MS, assertBootstrapNode, verifyNativeDependencies };
