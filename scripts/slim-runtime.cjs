#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function isRegularFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function isSymlink(file) {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function sameRegularFile(a, b) {
  let aStat;
  let bStat;
  try {
    aStat = fs.statSync(a);
    bStat = fs.statSync(b);
  } catch {
    return false;
  }
  if (!aStat.isFile() || !bStat.isFile()) return false;
  if (aStat.size !== bStat.size) return false;
  return sha256File(a) === sha256File(b);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function relPath(root, rel) {
  return path.join(root, ...String(rel || '').split(/[\\/]/).filter(Boolean));
}

function runtimeKey(platform, arch) {
  return `${platform}-${arch}`;
}

function pythonVersionSuffix(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version || ''));
  return m ? `${m[1]}.${m[2]}` : '';
}

function replaceFileWithSymlink(file, targetName) {
  const tmp = `${file}.symlink-${process.pid}-${Date.now()}`;
  fs.symlinkSync(targetName, tmp);
  fs.renameSync(tmp, file);
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function canonicalTargetPath(canonical) {
  if (!isSymlink(canonical)) return canonical;
  const target = fs.readlinkSync(canonical);
  return path.resolve(path.dirname(canonical), target);
}

function compactPythonLaunchers(runtimeRoot, key, manifest, options = {}) {
  const spec = manifest && manifest.python;
  const asset = spec && spec.assets && spec.assets[key];
  if (!spec || !asset) {
    return { key, changed: [], skipped: [{ reason: 'unsupported-python-runtime', key }] };
  }
  const platform = key.split('-')[0];
  if (platform === 'win32') {
    return { key, changed: [], skipped: [{ reason: 'win32-no-symlink-compaction', key }] };
  }

  const pythonDir = path.join(runtimeRoot, 'python', key);
  const canonical = relPath(pythonDir, asset.executable);
  const binDir = path.dirname(canonical);
  const canonicalName = path.basename(canonical);
  const suffix = pythonVersionSuffix(spec.version);
  const aliases = ['python'];
  if (suffix) aliases.push(`python${suffix}`);

  const changed = [];
  const skipped = [];
  if (!isRegularFile(canonical)) {
    return { key, changed, skipped: [{ reason: 'canonical-python-missing', file: canonical }] };
  }
  const canonicalRealPath = fs.realpathSync(canonical);
  const targetPath = canonicalTargetPath(canonical);

  for (const aliasName of aliases) {
    if (aliasName === canonicalName) continue;
    const alias = path.join(binDir, aliasName);
    if (!fs.existsSync(alias)) {
      skipped.push({ file: alias, reason: 'missing' });
      continue;
    }
    if (samePath(fs.realpathSync(alias), canonicalRealPath)) {
      skipped.push({ file: alias, reason: 'canonical-real-target' });
      continue;
    }
    if (isSymlink(alias)) {
      const target = fs.readlinkSync(alias);
      if (target === canonicalName) {
        skipped.push({ file: alias, reason: 'already-symlink' });
      } else {
        skipped.push({ file: alias, reason: `symlink-target-${target}` });
      }
      continue;
    }
    if (!sameRegularFile(alias, canonicalRealPath)) {
      skipped.push({ file: alias, reason: 'content-differs' });
      continue;
    }
    const target = path.relative(path.dirname(alias), targetPath) || path.basename(targetPath);
    replaceFileWithSymlink(alias, target);
    changed.push({ file: alias, target });
  }

  if (!options.quiet && changed.length) {
    for (const item of changed) {
      console.log(`[slim-runtime] ${path.relative(runtimeRoot, item.file)} -> ${item.target}`);
    }
  }
  return { key, changed, skipped };
}

function slimRuntimeRoot(runtimeRoot, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const manifestPath = options.manifest || path.join(runtimeRoot, 'manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest) throw new Error(`runtime manifest not found or unreadable: ${manifestPath}`);
  const keys = arch === 'universal'
    ? [runtimeKey(platform, 'x64'), runtimeKey(platform, 'arm64')]
    : [runtimeKey(platform, arch)];
  return keys.map(key => compactPythonLaunchers(runtimeRoot, key, manifest, options));
}

function parseArgs(argv) {
  const opts = {
    root: '',
    manifest: '',
    platform: process.platform,
    arch: process.arch,
    quiet: false,
    json: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') opts.root = path.resolve(argv[++i] || '');
    else if (arg === '--manifest') opts.manifest = path.resolve(argv[++i] || '');
    else if (arg === '--platform') opts.platform = argv[++i] || '';
    else if (arg === '--arch') opts.arch = argv[++i] || '';
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: slim-runtime.cjs --root resources/runtime [--platform darwin --arch arm64]',
        '',
        'Safely compacts packaged runtime files without changing the canonical',
        'runtime executable. Currently converts duplicate Python launcher files',
        'to relative symlinks only when their bytes match python3 exactly.',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!opts.root) throw new Error('missing --root');
  if (!opts.platform || !opts.arch) throw new Error('missing --platform/--arch');
  if (opts.json) opts.quiet = true;
  return opts;
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv);
    const results = slimRuntimeRoot(opts.root, opts);
    if (opts.json) console.log(JSON.stringify({ ok: true, results }, null, 2));
  } catch (err) {
    console.error(`[slim-runtime] ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  }
}

module.exports = {
  compactPythonLaunchers,
  slimRuntimeRoot,
};
