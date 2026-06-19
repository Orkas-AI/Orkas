#!/usr/bin/env node
/**
 * Ensure Orkas' pinned Python/uv runtime exists.
 *
 * Build-time use:
 *   node bin/ensure-runtime.cjs --root resources/runtime --platform darwin --arch arm64
 *
 * The production app never calls this script at runtime. Dev launchers and
 * electron-builder hooks call it before boot/packaging so packaged apps only
 * consume already-present resources.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const MARKER = '.orkas-runtime.json';
const KINDS = ['python', 'uv'];
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function die(message, extra) {
  const payload = { ok: false, error: message };
  if (extra) Object.assign(payload, extra);
  process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    platform: process.platform,
    arch: process.arch,
    root: '',
    manifest: '',
    check: false,
    noDownload: false,
    quiet: false,
    all: false,
    kinds: KINDS.slice(),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--platform') opts.platform = argv[++i] || '';
    else if (arg === '--arch') opts.arch = argv[++i] || '';
    else if (arg === '--root') opts.root = path.resolve(argv[++i] || '');
    else if (arg === '--manifest') opts.manifest = path.resolve(argv[++i] || '');
    else if (arg === '--check') opts.check = true;
    else if (arg === '--no-download') opts.noDownload = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--kind') {
      const kind = argv[++i] || '';
      if (!KINDS.includes(kind)) die(`unsupported runtime kind: ${kind}`);
      opts.kinds = [kind];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Usage: ensure-runtime.cjs [--platform p --arch a] [--root dir]',
        '                          [--check] [--no-download] [--quiet]',
        '                          [--kind python|uv] [--all]',
        '',
        'Default --root is resources/runtime. Production app startup must not',
        'call this script; dev launchers and packaging hooks call it before boot.',
        '',
      ].join('\n'));
      process.exit(0);
    } else {
      die(`unknown argument: ${arg}`);
    }
  }
  if (!opts.platform || !opts.arch) die('platform and arch are required');
  return opts;
}

function pcRoot() {
  return path.resolve(__dirname, '..');
}

function defaultResourceRoot() {
  if (process.env.ORKAS_RUNTIME_DIR) return path.resolve(process.env.ORKAS_RUNTIME_DIR);
  const rp = process.resourcesPath;
  if (rp && !rp.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`)) {
    return path.join(rp, 'runtime');
  }
  return path.join(pcRoot(), 'resources', 'runtime');
}

function manifestPath(opts) {
  const candidates = [
    opts.manifest,
    path.join(defaultResourceRoot(), 'manifest.json'),
    path.join(pcRoot(), 'resources', 'runtime', 'manifest.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try next */
    }
  }
  die('runtime manifest not found', { candidates });
}

function readManifest(opts) {
  const file = manifestPath(opts);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, manifest: parsed };
  } catch (err) {
    die('failed to read runtime manifest', { file, error: err.message });
  }
}

function platformKey(platform, arch) {
  return `${platform}-${arch}`;
}

function assetFor(manifest, kind, key) {
  return manifest[kind] && manifest[kind].assets && manifest[kind].assets[key];
}

function runtimeDir(root, kind, key) {
  return path.join(root, kind, key);
}

function currentDir(root, kind) {
  return path.join(root, kind, 'current');
}

function markerFile(dir) {
  return path.join(dir, MARKER);
}

function relPath(root, rel) {
  return path.join(root, ...String(rel || '').split(/[\\/]/).filter(Boolean));
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readMarker(dir) {
  try { return JSON.parse(fs.readFileSync(markerFile(dir), 'utf8')); } catch { return null; }
}

function markerMatches(marker, kind, key, spec, asset) {
  return !!marker
    && marker.kind === kind
    && marker.platformKey === key
    && marker.version === spec.version
    && marker.asset === asset.name
    && marker.sha256 === asset.sha256
    && marker.size === asset.size;
}

function statusInRoot(root, kind, key, spec, asset) {
  let unverified = null;
  for (const dir of [currentDir(root, kind), runtimeDir(root, kind, key)]) {
    const executable = relPath(dir, asset.executable);
    const marker = readMarker(dir);
    if (isFile(executable) && markerMatches(marker, kind, key, spec, asset)) {
      return { ok: true, status: 'ready', root, dir, executable, verified: true };
    }
    if (isFile(executable)) {
      unverified ||= { ok: false, status: 'unverified', root, dir, executable, verified: false };
    }
  }
  if (unverified) return unverified;
  return { ok: false, status: 'missing', root, dir: runtimeDir(root, kind, key), executable: relPath(runtimeDir(root, kind, key), asset.executable), verified: false };
}

function log(opts, msg, meta) {
  if (opts.quiet) return;
  if (meta) process.stderr.write(`${msg} ${JSON.stringify(meta)}\n`);
  else process.stderr.write(`${msg}\n`);
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const request = (currentUrl, redirectsLeft) => {
      const req = https.get(currentUrl, { headers: { 'User-Agent': 'OrkasRuntime/1.0' } }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          request(new URL(res.headers.location, currentUrl).toString(), redirectsLeft - 1);
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`download failed with HTTP ${code}`));
          return;
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      });
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        req.destroy(new Error('download timed out'));
      });
      req.on('error', reject);
      const timer = setInterval(() => {
        if (Date.now() - started > DOWNLOAD_TIMEOUT_MS) {
          clearInterval(timer);
          req.destroy(new Error('download timed out'));
        }
      }, 1_000);
      timer.unref?.();
      req.on('close', () => clearInterval(timer));
    };
    request(url, 5);
  });
}

function runCommand(cmd, args, opts) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: opts.timeoutMs || 5 * 60 * 1000,
  });
  if (res.error) return { ok: false, error: res.error.message, status: null, stderr: res.stderr || '' };
  if (res.status !== 0) return { ok: false, error: `${cmd} exited ${res.status}`, status: res.status, stderr: res.stderr || '' };
  return { ok: true, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function extractArchive(archive, extractDir, asset, opts) {
  fs.mkdirSync(extractDir, { recursive: true });
  const tarArgs = asset.archive === 'tar.gz'
    ? ['-xzf', archive, '-C', extractDir]
    : ['-xf', archive, '-C', extractDir];
  let res = runCommand('tar', tarArgs, opts);
  if (res.ok) return;

  if (asset.archive === 'zip') {
    if (process.platform === 'win32') {
      const command = [
        'Expand-Archive',
        '-LiteralPath', JSON.stringify(archive),
        '-DestinationPath', JSON.stringify(extractDir),
        '-Force',
      ].join(' ');
      res = runCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], opts);
      if (res.ok) return;
    } else {
      res = runCommand('unzip', ['-q', archive, '-d', extractDir], opts);
      if (res.ok) return;
    }
  }

  die('failed to extract runtime archive', { archive, error: res.error, stderr: String(res.stderr || '').slice(-1200) });
}

function findByBasename(root, names) {
  const wanted = new Set(names);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && wanted.has(entry.name)) return p;
    }
  }
  return '';
}

function copyTree(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

function preparePayload(kind, extractDir, payloadDir, asset) {
  fs.rmSync(payloadDir, { recursive: true, force: true });
  fs.mkdirSync(payloadDir, { recursive: true });

  if (kind === 'uv') {
    const exeName = path.basename(asset.executable);
    const exe = findByBasename(extractDir, [exeName]);
    if (!exe) die('uv executable missing from archive', { archiveAsset: asset.name, executable: exeName });
    const dest = relPath(payloadDir, asset.executable);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(exe, dest);
    try { fs.chmodSync(dest, 0o755); } catch { /* chmod is best-effort on Windows */ }

    const uvxName = exeName === 'uv.exe' ? 'uvx.exe' : 'uvx';
    const uvx = findByBasename(extractDir, [uvxName]);
    if (uvx) {
      const uvxDest = path.join(payloadDir, uvxName);
      fs.copyFileSync(uvx, uvxDest);
      try { fs.chmodSync(uvxDest, 0o755); } catch { /* best-effort */ }
    }
    return;
  }

  copyTree(extractDir, payloadDir);
}

function doctorDir(dir, kind, asset, opts) {
  const executable = relPath(dir, asset.executable);
  if (isFile(executable)) {
    try { fs.chmodSync(executable, 0o755); } catch { /* best-effort */ }
  }
  if (kind === 'python') {
    for (const rel of ['python/bin/python', 'python/bin/python3', 'bin/python', 'bin/python3']) {
      const p = relPath(dir, rel);
      if (isFile(p)) {
        try { fs.chmodSync(p, 0o755); } catch { /* best-effort */ }
      }
    }
  }
  if (opts.platform === 'darwin') {
    runCommand('xattr', ['-dr', 'com.apple.quarantine', dir], { ...opts, quiet: true, timeoutMs: 30_000 });
  }
}

function writeMarker(dir, kind, key, spec, asset) {
  fs.writeFileSync(markerFile(dir), JSON.stringify({
    schema: 1,
    kind,
    platformKey: key,
    version: spec.version,
    source: spec.source,
    release: spec.release,
    asset: asset.name,
    sha256: asset.sha256,
    size: asset.size,
    installedAt: new Date().toISOString(),
  }, null, 2));
}

function replaceDir(dest, payloadDir) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const backup = `${dest}.bak-${process.pid}-${Date.now()}`;
  const hadDest = isDir(dest);
  if (hadDest) fs.renameSync(dest, backup);
  try {
    fs.renameSync(payloadDir, dest);
    if (hadDest) fs.rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
    if (hadDest && isDir(backup)) {
      try { fs.renameSync(backup, dest); } catch { /* ignore */ }
    }
    throw err;
  }
}

function shouldRunSelfCheck(key) {
  return key === platformKey(process.platform, process.arch);
}

function selfCheck(kind, dir, asset, key, opts) {
  if (!shouldRunSelfCheck(key)) return '';
  const executable = relPath(dir, asset.executable);
  if (!isFile(executable)) die('runtime executable missing after install', { kind, executable });
  const args = ['--version'];
  const res = spawnSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  if (res.error || res.status !== 0) {
    die('runtime executable failed self-check', {
      kind,
      executable,
      error: res.error && res.error.message,
      status: res.status,
      stderr: String(res.stderr || '').slice(-1200),
    });
  }
  const version = String(res.stdout || res.stderr || '').trim();
  log(opts, `runtime ${kind} self-check ok`, { version });
  return version;
}

async function ensureInRoot(root, kind, key, spec, asset, opts) {
  fs.mkdirSync(root, { recursive: true });
  const current = statusInRoot(root, kind, key, spec, asset);
  if (current.ok) return { kind, key, ...current };
  if (opts.check || opts.noDownload) return { kind, key, ...current };

  const dest = runtimeDir(root, kind, key);
  const tmp = fs.mkdtempSync(path.join(root, `.${kind}-${key}-`));
  const archive = path.join(tmp, asset.name);
  const extractDir = path.join(tmp, 'extract');
  const payloadDir = path.join(tmp, 'payload');
  try {
    log(opts, `runtime ${kind}: downloading`, { key, asset: asset.name });
    await downloadFile(asset.url, archive);
    const st = fs.statSync(archive);
    if (st.size !== asset.size) {
      die('runtime archive size mismatch', { kind, key, expected: asset.size, actual: st.size, asset: asset.name });
    }
    const digest = sha256File(archive);
    if (digest !== asset.sha256) {
      die('runtime archive sha256 mismatch', { kind, key, expected: asset.sha256, actual: digest, asset: asset.name });
    }
    extractArchive(archive, extractDir, asset, opts);
    preparePayload(kind, extractDir, payloadDir, asset);
    doctorDir(payloadDir, kind, asset, opts);
    writeMarker(payloadDir, kind, key, spec, asset);
    replaceDir(dest, payloadDir);
    fs.rmSync(tmp, { recursive: true, force: true });
    const versionOutput = selfCheck(kind, dest, asset, key, opts);
    return {
      kind,
      key,
      ok: true,
      status: 'downloaded',
      root,
      dir: dest,
      executable: relPath(dest, asset.executable),
      verified: true,
      versionOutput,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function targetKeys(opts, manifest) {
  if (!opts.all) return [platformKey(opts.platform, opts.arch)];
  const keys = new Set();
  for (const kind of opts.kinds) {
    for (const key of Object.keys((manifest[kind] && manifest[kind].assets) || {})) keys.add(key);
  }
  return Array.from(keys).sort();
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.root) opts.root = defaultResourceRoot();
  const { file: manifestFile, manifest } = readManifest(opts);
  const results = [];
  let ok = true;

  for (const key of targetKeys(opts, manifest)) {
    for (const kind of opts.kinds) {
      const spec = manifest[kind];
      const asset = assetFor(manifest, kind, key);
      if (!spec || !asset) {
        ok = false;
        results.push({ kind, key, ok: false, status: 'unsupported' });
        continue;
      }

      const res = await ensureInRoot(opts.root, kind, key, spec, asset, opts);
      if (!res.ok) ok = false;
      results.push(res);
    }
  }

  const summary = {
    ok,
    manifest: manifestFile,
    platform: opts.platform,
    arch: opts.arch,
    root: opts.root,
    results,
  };
  if (!opts.quiet) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  if (!ok) process.exit(1);
}

main().catch((err) => die('runtime ensure failed', { error: err && err.message }));
