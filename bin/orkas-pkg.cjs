#!/usr/bin/env node
/**
 * Orkas external-package installer CLI.
 *
 * Invoked by the LLM bash tool (guided by the `package-installer` system
 * skill) as:
 *   "$ORKAS_NODE" "$ORKAS_PC_DIR/bin/orkas-pkg.cjs" <command> [args...]
 *
 * Commands:
 *   install <git-url-or-local-path> [--name <name>] [--consent-deps]
 *   consent-deps <name>     — record consent + install deps for an
 *                             already-installed package (D3 second step)
 *   enable  <name>
 *   disable <name>
 *   update  <name>
 *   remove  <name>
 *   skill-write <name>      — write an auto-authored companion usage SKILL.md
 *                             (content on stdin) for a CLI-only package, under
 *                             `<uid>/local/package_skills/<name>/`
 *   list
 *   info <name>
 *
 * Owns the WRITE side of the `<uid>/local/packages/` domain: clone, scan,
 * consented dependency install, `_registry.json` lifecycle, and `.bin/`
 * shim generation. Also owns the WRITE side of the sibling
 * `<uid>/local/package_skills/` companion-skill domain (skill-write / pruned
 * on remove). The main process only READS both domains
 * (`features/packages.ts`, `features/package_skills.ts`) — keep the registry
 * schema in sync with that module's doc block.
 *
 * Design constraints (docs/plans/open-ecosystem-architecture.md §A):
 *   - The package tree is hosted VERBATIM. Never rewrite SKILL.md, never
 *     normalize frontmatter, never write Orkas metadata inside the package.
 *   - Dependency install (npm/pip) only runs with explicit consent: the
 *     `--consent-deps` flag on install, or the recorded `deps_consent`
 *     flag on update (D3: ask once per package, remember).
 *   - Projects with neither a SKILL.md shape nor CLI entry points are
 *     rejected — agent-driven-only projects are out of scope.
 *
 * Standalone CommonJS like run-skill.cjs: no imports from src/main (this
 * runs out-of-process under Electron-as-Node or stock node).
 *
 * Env inputs:
 *   ORKAS_UID             — active user id (set in the bash sandbox env).
 *                           Fallback: users.json dev_current_user_id /
 *                           current_user_id, then 'anonymous'.
 *   ORKAS_WORKSPACE_ROOT  — data root (ORKAS_WS_ROOT honoured as alias;
 *                           default ~/.orkas/data).
 *   ORKAS_PYTHON          — optional bundled Python executable used for
 *                           Python package venv creation.
 *   ORKAS_UV              — optional bundled uv executable used for Python
 *                           package dependency installs.
 *   ORKAS_VENV_ROOT       — optional shared machine-local venv root.
 *                           Defaults to `<ORKAS_WORKSPACE_ROOT>/venv`.
 *                           Python envs/caches live under `python/`; npm
 *                           cache/prefix live under `node/`.
 *   ORKAS_BUNDLED_NODE    — optional bundled stock Node executable for
 *                           third-party package CLI shims. ORKAS_NODE is
 *                           reserved for Orkas internal Electron-as-Node.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REGISTRY_VERSION = 1;
const LOCK_STALE_MS = 10 * 60 * 1000;
const PKG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function out(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function die(exitCode, message, extra) {
  const payload = { ok: false, error: message };
  if (extra) Object.assign(payload, extra);
  process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(exitCode);
}

// ── Roots ────────────────────────────────────────────────────────────────

function wsRoot() {
  return process.env.ORKAS_WORKSPACE_ROOT
    || process.env.ORKAS_WS_ROOT
    || path.join(os.homedir(), '.orkas', 'data');
}

function sharedVenvRoot() { return process.env.ORKAS_VENV_ROOT || path.join(wsRoot(), 'venv'); }
function pythonVenvRoot() { return path.join(sharedVenvRoot(), 'python'); }
function nodeVenvRoot() { return path.join(sharedVenvRoot(), 'node'); }
function pythonVenvCacheEnv() {
  return {
    ORKAS_VENV_ROOT: sharedVenvRoot(),
    UV_CACHE_DIR: process.env.UV_CACHE_DIR || path.join(pythonVenvRoot(), 'cache', 'uv'),
    PIP_CACHE_DIR: process.env.PIP_CACHE_DIR || path.join(pythonVenvRoot(), 'cache', 'pip'),
  };
}
function nodePackageEnv() {
  return {
    ORKAS_VENV_ROOT: sharedVenvRoot(),
    // Package installs must remain inside the Orkas-managed data root. Desktop
    // launches can inherit machine/user npm settings (especially on Windows),
    // which otherwise redirect cache/prefix writes into global shared state.
    NPM_CONFIG_CACHE: path.join(nodeVenvRoot(), 'cache', 'npm'),
    NPM_CONFIG_PREFIX: path.join(nodeVenvRoot(), 'prefix'),
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}

function resolveUid() {
  const envUid = (process.env.ORKAS_UID || '').trim();
  if (envUid && !envUid.includes('/') && !envUid.includes('\\')) return envUid;
  try {
    const users = JSON.parse(fs.readFileSync(path.join(wsRoot(), 'users.json'), 'utf8'));
    const uid = users.dev_current_user_id || users.current_user_id;
    if (typeof uid === 'string' && uid) return uid;
  } catch { /* fall through */ }
  return 'anonymous';
}

function packagesDir(uid) { return path.join(wsRoot(), uid, 'local', 'packages'); }
function registryFile(uid) { return path.join(packagesDir(uid), '_registry.json'); }
function binDir(uid) { return path.join(packagesDir(uid), '.bin'); }
// Companion usage skills for CLI-only packages live OUTSIDE the verbatim
// packages tree (so this CLI never writes Orkas files into a cloned repo) and
// outside cloud/ (machine-specific, never synced). Read in main via
// `features/package_skills.ts`. Keyed to the package by dir name.
function packageSkillsDir(uid) { return path.join(wsRoot(), uid, 'local', 'package_skills'); }
function packageSkillDir(uid, name) { return path.join(packageSkillsDir(uid), name); }

// ── Registry IO ──────────────────────────────────────────────────────────

function readRegistry(uid) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile(uid), 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.packages)) {
      return { version: REGISTRY_VERSION, packages: parsed.packages };
    }
  } catch { /* missing or corrupt → empty */ }
  return { version: REGISTRY_VERSION, packages: [] };
}

function writeRegistry(uid, registry) {
  const p = registryFile(uid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

async function withRegistryLock(uid, fn) {
  fs.mkdirSync(packagesDir(uid), { recursive: true });
  const lockPath = path.join(packagesDir(uid), '_registry.lock');
  let fd = null;
  // `die()` calls process.exit, which skips `finally` — the exit hook is the
  // path that guarantees the lock never outlives the process (a leftover
  // lock would block every orkas-pkg call for LOCK_STALE_MS).
  const releaseLock = () => {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } fd = null; }
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  };
  process.on('exit', releaseLock);
  try {
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        let stale = false;
        try { stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { stale = true; }
        if (!stale) {
          process.removeListener('exit', releaseLock); // not our lock — leave it
          die(75, 'another orkas-pkg operation is in progress; retry shortly', { lock: lockPath });
        }
        try { fs.unlinkSync(lockPath); } catch { /* raced */ }
        fd = fs.openSync(lockPath, 'wx');
      } else {
        throw e;
      }
    }
    fs.writeSync(fd, String(process.pid));
    // `await` so an async fn (e.g. a GitHub tarball download) completes BEFORE
    // the lock is released in `finally`; a bare `return fn()` would release the
    // lock the instant fn returned its promise, while network I/O was still in
    // flight. The exit hook still guards against the lock outliving the process.
    return await fn();
  } finally {
    releaseLock();
    process.removeListener('exit', releaseLock);
  }
}

// ── Subprocess helpers ───────────────────────────────────────────────────

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, {
    cwd: opts && opts.cwd,
    encoding: 'utf8',
    timeout: (opts && opts.timeoutMs) || 10 * 60 * 1000,
    env: { ...process.env, ...((opts && opts.env) || {}) },
    // npm/pip/git progress goes to our stderr so the bash tool surfaces it.
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      die(76, `required command not found: ${cmd}`, { cmd, hint: `install ${cmd} and retry` });
    }
    die(76, `${cmd} failed to start: ${res.error.message}`, { cmd, args });
  }
  return res;
}

function runOrDie(cmd, args, opts, what) {
  const res = run(cmd, args, opts);
  if (res.status !== 0) {
    die(1, `${what} failed (${cmd} exited ${res.status})`, { cmd, args, stdout: (res.stdout || '').slice(-2000) });
  }
  return res;
}

function npmInvocation(args) {
  if (process.platform !== 'win32') return { cmd: 'npm', args };
  // npm is a command shim on Windows, not a native executable. Launch it
  // through ComSpec with fixed, app-owned arguments; spawnSync('npm') cannot
  // execute npm.cmd directly and fails before dependency consent can run.
  return {
    cmd: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd', ...args],
  };
}

// ── Capability scan ──────────────────────────────────────────────────────

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
// No-follow regular-file check: used on the (untrusted) package tree so a
// symlinked SKILL.md is never treated as a real file. See assertNoSymlinks.
function isRegularFileNoFollow(p) { try { return fs.lstatSync(p).isFile(); } catch { return false; } }

/**
 * Fail-closed defense against symlink escape. A public repo (tarball or clone)
 * may legitimately carry symlinks; our statSync-based scan/read and the
 * cwd-in-package skill execution would follow them OUT of the package tree
 * (e.g. `SKILL.md -> ~/.ssh/id_rsa` exfiltrating the target's content into the
 * prompt, or a relative symlink resolving outside the sandbox). Reject any
 * symlink member before the tree is scanned/promoted. `.git` is git-managed
 * metadata we never read, so the top-level `.git` is skipped to avoid false
 * positives. Returns the first offending path relative to `root`, or null.
 */
function findSymlink(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) return path.relative(root, abs) || entry.name;
      if (entry.isDirectory()) {
        if (dir === root && entry.name === '.git') continue;
        stack.push(abs);
      }
    }
  }
  return null;
}

function assertNoSymlinks(root, action) {
  const sl = findSymlink(root);
  if (sl) {
    die(1, `refusing to ${action || 'install'}: package contains a symbolic link, which could read files outside the package`, { path: sl });
  }
}

function commandFromEnv(value) {
  if (!value) return null;
  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    return isFile(value) ? value : null;
  }
  return value;
}

function pythonCommand() {
  const configured = commandFromEnv(process.env.ORKAS_PYTHON);
  if (configured) return { cmd: configured, args: [], label: '$ORKAS_PYTHON' };
  if (process.platform === 'win32') return { cmd: 'python', args: [], label: 'python' };
  return { cmd: 'python3', args: [], label: 'python3' };
}

function uvCommand() {
  const configured = commandFromEnv(process.env.ORKAS_UV);
  if (configured) return configured;
  return null;
}

function venvPythonPath(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

function venvPipPath(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'pip.exe')
    : path.join(venvDir, 'bin', 'pip');
}

function venvConsoleScriptPath(venvDir, name) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', `${name}.exe`)
    : path.join(venvDir, 'bin', name);
}

function shortHash(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 12);
}

function packageVenvKey(pkg) {
  const rawName = (pkg && pkg.name) || 'package';
  const name = PKG_NAME_RE.test(rawName) ? rawName : 'package';
  const basis = [name, (pkg && pkg.repo_url) || '', (pkg && pkg.commit) || ''].join('\n');
  return `${name}-${shortHash(basis)}`;
}

function packageVenvDir(pkg) {
  return path.join(pythonVenvRoot(), 'packages', packageVenvKey(pkg), '.venv');
}

/** Candidate rel dirs whose children (or, for '.', the dir itself) hold SKILL.md. */
const SKILL_ROOT_CANDIDATES = ['skills', path.join('.claude', 'skills')];
const PACKAGE_BIN_DIR_CANDIDATES = ['npm/bin', 'bin'];

function scanSkillRoots(pkgDir) {
  const roots = [];
  // No-follow checks (defense-in-depth alongside assertNoSymlinks): a symlinked
  // SKILL.md must never count as a skill root. `entry.isDirectory()` from
  // readdir withFileTypes is already lstat-based, so a symlinked dir is skipped.
  if (isRegularFileNoFollow(path.join(pkgDir, 'SKILL.md'))) roots.push('.');
  for (const rel of SKILL_ROOT_CANDIDATES) {
    const abs = path.join(pkgDir, rel);
    if (!isDir(abs)) continue;
    let hasSkill = false;
    try {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory() && isRegularFileNoFollow(path.join(abs, entry.name, 'SKILL.md'))) { hasSkill = true; break; }
      }
    } catch { /* unreadable → skip */ }
    if (hasSkill) roots.push(rel.split(path.sep).join('/'));
  }
  return roots;
}

function scanNodeBinEntries(pkgDir) {
  const entries = [];
  let pkgJson = null;
  try { pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')); } catch { return entries; }
  if (!pkgJson || typeof pkgJson !== 'object') return entries;
  const bin = pkgJson.bin;
  if (typeof bin === 'string') {
    const name = typeof pkgJson.name === 'string' ? pkgJson.name.replace(/^@[^/]+\//, '') : '';
    if (PKG_NAME_RE.test(name)) entries.push({ name, target: bin, runtime: 'node' });
  } else if (bin && typeof bin === 'object') {
    for (const [name, target] of Object.entries(bin)) {
      if (PKG_NAME_RE.test(name) && typeof target === 'string') entries.push({ name, target, runtime: 'node' });
    }
  }
  return entries.filter((e) => !path.isAbsolute(e.target) && !e.target.split(/[\\/]/).includes('..'));
}

/**
 * `[project.scripts]` console entries from pyproject.toml. Naive
 * line-oriented TOML section walk — enough for the `name = "module:func"`
 * shape; anything fancier is ignored. Targets keep the legacy package-local
 * `.venv` shape for registry compatibility; shim generation resolves shared
 * `data/venv` console scripts first.
 */
function scanPythonBinEntries(pkgDir) {
  const entries = [];
  let toml;
  try { toml = fs.readFileSync(path.join(pkgDir, 'pyproject.toml'), 'utf8'); } catch { return entries; }
  const lines = toml.split(/\r?\n/);
  let inScripts = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[/.test(trimmed)) {
      inScripts = trimmed === '[project.scripts]';
      continue;
    }
    if (!inScripts || !trimmed || trimmed.startsWith('#')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(trimmed);
    if (!m) continue;
    const name = m[1];
    const target = process.platform === 'win32'
      ? path.join('.venv', 'Scripts', `${name}.exe`)
      : path.join('.venv', 'bin', name);
    entries.push({ name, target: target.split(path.sep).join('/'), runtime: 'python' });
  }
  return entries;
}

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function scanNativeBinEntries(pkgDir) {
  const entries = [];
  const seen = new Set();
  for (const relDir of PACKAGE_BIN_DIR_CANDIDATES) {
    const absDir = path.join(pkgDir, relDir);
    let dirents;
    try { dirents = fs.readdirSync(absDir, { withFileTypes: true }); } catch { continue; }
    for (const dirent of dirents) {
      if (!dirent.isFile()) continue;
      // Windows has no executable mode bit. Only extensions that CreateProcess
      // or cmd.exe can actually launch count as native entries; treating every
      // file under a generic `bin/` directory as executable registered README,
      // source, and package.json files as bogus CLIs.
      if (process.platform === 'win32' && !/\.(?:exe|com|cmd|bat)$/i.test(dirent.name)) continue;
      let name = dirent.name;
      if (process.platform === 'win32') name = name.replace(/\.(?:exe|com|cmd|bat)$/i, '');
      if (!PKG_NAME_RE.test(name) || seen.has(name)) continue;
      const abs = path.join(absDir, dirent.name);
      if (!isExecutableFile(abs)) continue;
      seen.add(name);
      entries.push({
        name,
        target: path.join(relDir, dirent.name).split(path.sep).join('/'),
        runtime: 'native',
      });
    }
  }
  return entries;
}

function scanPackage(pkgDir) {
  const skillRoots = scanSkillRoots(pkgDir);
  const binEntries = [...scanNodeBinEntries(pkgDir), ...scanPythonBinEntries(pkgDir), ...scanNativeBinEntries(pkgDir)];
  let kind = null;
  if (skillRoots.length && binEntries.length) kind = 'both';
  else if (skillRoots.length) kind = 'skill';
  else if (binEntries.length) kind = 'cli';
  return { kind, skillRoots, binEntries };
}

// ── Dependency install ───────────────────────────────────────────────────

function hasNodeDeps(pkgDir) {
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    return !!(pkgJson && (pkgJson.dependencies || pkgJson.optionalDependencies));
  } catch { return false; }
}

function hasPythonProject(pkgDir) {
  return isFile(path.join(pkgDir, 'pyproject.toml')) || isFile(path.join(pkgDir, 'setup.py'));
}

function describeDepCommands(pkgDir, pkgMeta) {
  const cmds = [];
  if (hasNodeDeps(pkgDir)) {
    cmds.push(isFile(path.join(pkgDir, 'package-lock.json')) ? 'npm ci --omit=dev' : 'npm install --omit=dev');
  }
  if (hasPythonProject(pkgDir)) {
    const venv = packageVenvDir(pkgMeta);
    const uv = uvCommand();
    if (uv) {
      const venvCmd = process.env.ORKAS_PYTHON
        ? `$ORKAS_UV venv --python $ORKAS_PYTHON "${venv}"`
        : `$ORKAS_UV venv "${venv}"`;
      cmds.push(`${venvCmd} && $ORKAS_UV pip install --python "${venvPythonPath(venv)}" .`);
    } else {
      cmds.push(`${pythonCommand().label} -m venv "${venv}" && "${venvPipPath(venv)}" install .`);
    }
  }
  return cmds;
}

function installDeps(pkgDir, pkgMeta) {
  const performed = [];
  if (hasNodeDeps(pkgDir)) {
    // npm writes package-local node_modules under <data>/<uid>/local/packages,
    // while cache/prefix live under <data>/venv/node so app updates never
    // overwrite installed dependencies or npm's reusable cache.
    const useCi = isFile(path.join(pkgDir, 'package-lock.json'));
    const args = [useCi ? 'ci' : 'install', '--omit=dev', '--no-fund', '--no-audit'];
    const label = useCi ? 'npm ci' : 'npm install';
    const npm = npmInvocation(args);
    runOrDie(npm.cmd, npm.args, { cwd: pkgDir, env: nodePackageEnv() }, label);
    performed.push(`${label} --omit=dev`);
  }
  if (hasPythonProject(pkgDir)) {
    const venv = packageVenvDir(pkgMeta);
    const cacheEnv = pythonVenvCacheEnv();
    fs.mkdirSync(path.dirname(venv), { recursive: true });
    const uv = uvCommand();
    if (uv) {
      if (!isDir(venv)) {
        const args = ['venv'];
        if (process.env.ORKAS_PYTHON) args.push('--python', process.env.ORKAS_PYTHON);
        args.push(venv);
        runOrDie(uv, args, { cwd: pkgDir, env: cacheEnv }, 'uv venv');
      }
      runOrDie(uv, ['pip', 'install', '--python', venvPythonPath(venv), '.'], { cwd: pkgDir, env: cacheEnv }, 'uv pip install');
      performed.push('uv pip install .');
    } else {
      const py = pythonCommand();
      if (!isDir(venv)) runOrDie(py.cmd, [...py.args, '-m', 'venv', venv], { cwd: pkgDir, env: cacheEnv }, 'venv creation');
      runOrDie(venvPipPath(venv), ['install', '.'], { cwd: pkgDir, env: cacheEnv }, 'pip install');
      performed.push('pip install .');
    }
  }
  return performed;
}

// ── Shims ────────────────────────────────────────────────────────────────

/** Regenerate `.bin/` from the full registry — idempotent, drop-and-rebuild. */
function regenerateShims(uid, registry) {
  const dir = binDir(uid);
  fs.rmSync(dir, { recursive: true, force: true });
  const wanted = [];
  for (const pkg of registry.packages) {
    if (pkg.enabled === false) continue;
    for (const entry of pkg.bin_entries || []) {
      let targetAbs = path.join(packagesDir(uid), pkg.name, entry.target);
      if (entry.runtime === 'python') {
        const sharedTarget = venvConsoleScriptPath(packageVenvDir(pkg), entry.name);
        targetAbs = isFile(sharedTarget) ? sharedTarget : targetAbs;
        // Python console scripts only exist after dependency install — skip
        // until either the shared venv or a legacy package-local venv has one.
        if (!isFile(targetAbs)) continue;
      }
      wanted.push({ pkg: pkg.name, ...entry, targetAbs });
    }
  }
  if (!wanted.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  const created = [];
  for (const w of wanted) {
    const shPath = path.join(dir, w.name);
    if (w.runtime === 'node') {
      // Package CLIs should run under the bundled stock Node/npm toolchain, not
      // ORKAS_NODE (Electron-as-Node), so runtime behavior matches installs.
      fs.writeFileSync(shPath, `#!/bin/sh\nexec "\${ORKAS_BUNDLED_NODE:-node}" "${w.targetAbs}" "$@"\n`, { mode: 0o755 });
      fs.writeFileSync(`${shPath}.cmd`, `@echo off\r\nif defined ORKAS_BUNDLED_NODE ("%ORKAS_BUNDLED_NODE%" "${w.targetAbs}" %*) else (node "${w.targetAbs}" %*)\r\n`);
    } else {
      fs.writeFileSync(shPath, `#!/bin/sh\nexec "${w.targetAbs}" "$@"\n`, { mode: 0o755 });
      fs.writeFileSync(`${shPath}.cmd`, `@echo off\r\n"${w.targetAbs}" %*\r\n`);
    }
    created.push(w.name);
  }
  return created;
}

// ── Git helpers ──────────────────────────────────────────────────────────

function headCommit(pkgDir) {
  const res = run('git', ['rev-parse', 'HEAD'], { cwd: pkgDir });
  return res.status === 0 ? String(res.stdout || '').trim() : '';
}

function deriveName(source) {
  const tail = source.replace(/\/+$/, '').split(/[/\\]/).pop() || '';
  return tail.replace(/\.git$/i, '');
}

// ── Source routing & git-free GitHub fetch ────────────────────────────────
//
// "Has git → git; no git → tarball; private repo → git". A user without git
// can still install a PUBLIC GitHub repo: we download the source tarball over
// plain https (no git binary). Anything that genuinely needs git (private
// repos, non-GitHub git URLs, local git clones) keeps the git path. This is
// purely additive — the git clone path below is unchanged for anyone who has
// git, so existing installs do not regress.

/** Classify an install source. Returns { kind, owner?, repo?, ref? }. */
// GitHub owner/repo charset (per GitHub's own rules); reject `..` so a crafted
// identifier can't become a path-traversal segment in the API URL.
function validGithubId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9._-]+$/.test(s) && !s.includes('..');
}

function classifySource(source) {
  const s = String(source || '').trim();
  if (!s) return { kind: 'git' };
  if (isDir(s)) return { kind: 'local' };

  // ssh form: git@github.com:owner/repo(.git)?
  let m = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(s);
  if (m && validGithubId(m[1]) && validGithubId(m[2])) return { kind: 'github', owner: m[1], repo: m[2] };

  // https / scheme-less: [https://][www.]github.com/owner/repo[/tree/<ref>][#<ref>]
  m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/([^?#]*))?(?:[?#](.*))?$/i.exec(s);
  if (m && validGithubId(m[1]) && validGithubId(m[2].replace(/\.git$/i, ''))) {
    const owner = m[1];
    const repo = m[2].replace(/\.git$/i, '');
    const rest = m[3] || '';
    const frag = m[4] || '';
    let ref = '';
    const treeM = /^tree\/(.+)$/.exec(rest);
    if (treeM) ref = decodeURIComponent(treeM[1]);
    else if (frag) ref = decodeURIComponent(frag);
    return { kind: 'github', owner, repo, ...(ref ? { ref } : {}) };
  }

  // Any other git URL (gitlab, self-hosted, bare ssh) → git path.
  return { kind: 'git' };
}

function gitAvailable() {
  const res = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  return !res.error && res.status === 0;
}

/**
 * GitHub's API tarball endpoint 302-redirects to codeload with the default
 * branch already resolved, so we don't have to guess main/master. httpsDownload
 * follows the redirect. A User-Agent is mandatory or api.github.com returns 403.
 */
function githubTarballUrl(cls) {
  const owner = encodeURIComponent(String(cls.owner || ''));
  const repo = encodeURIComponent(String(cls.repo || '').replace(/\.git$/i, ''));
  const base = `https://api.github.com/repos/${owner}/${repo}/tarball`;
  if (!cls.ref) return base;
  // ref may legitimately contain `/` (e.g. feature/branch); encode each segment
  // but keep the separators, and reject traversal/empty segments so the ref can
  // never steer the request path off the named repo's /tarball endpoint.
  const segs = String(cls.ref).split('/');
  if (segs.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    die(1, `invalid ref: ${cls.ref}`, { ref: cls.ref });
  }
  return `${base}/${segs.map(encodeURIComponent).join('/')}`;
}

// Cap the tarball size: a model-controlled URL must not be able to stream an
// arbitrarily large body (or gzip-bomb on extract) and fill the disk under the
// registry lock. 500MB is generous for any real source repo tarball.
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
// Defense-in-depth: only follow redirects to GitHub-owned hosts. The initial
// request is pinned to api.github.com, which only redirects to codeload; this
// stops an open-redirect from steering the fetch elsewhere if that ever changes.
function isGithubHost(hostname) {
  return /(^|\.)github\.com$/i.test(hostname) || /(^|\.)githubusercontent\.com$/i.test(hostname);
}

function httpsDownload(url, dest) {
  const TIMEOUT_MS = 10 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const request = (currentUrl, redirectsLeft) => {
      // User-Agent is mandatory for api.github.com (403 without it). Do NOT
      // send an `Accept: application/octet-stream` — the API tarball endpoint
      // rejects it with 415; its default Accept already 302s to the tarball.
      const req = https.get(
        currentUrl,
        { headers: { 'User-Agent': 'orkas-pkg' } },
        (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) { reject(new Error('too many redirects')); return; }
            let next;
            try { next = new URL(res.headers.location, currentUrl); } catch { reject(new Error('bad redirect target')); return; }
            if (next.protocol !== 'https:' || !isGithubHost(next.hostname)) {
              reject(new Error(`refusing redirect to ${next.protocol}//${next.hostname}`));
              return;
            }
            request(next.toString(), redirectsLeft - 1);
            return;
          }
          if (code !== 200) { res.resume(); reject(new Error(`download failed with HTTP ${code}`)); return; }
          const declared = Number(res.headers['content-length'] || 0);
          if (declared && declared > MAX_DOWNLOAD_BYTES) {
            res.resume();
            reject(new Error(`download too large: ${declared} bytes (cap ${MAX_DOWNLOAD_BYTES})`));
            return;
          }
          const out = fs.createWriteStream(dest);
          let received = 0;
          res.on('data', (chunk) => {
            received += chunk.length;
            if (received > MAX_DOWNLOAD_BYTES) {
              req.destroy(new Error(`download exceeded size cap (${MAX_DOWNLOAD_BYTES} bytes)`));
              out.destroy();
            }
          });
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve()));
          out.on('error', reject);
        },
      );
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('download timed out')));
      req.on('error', reject);
    };
    request(url, 5);
  });
}

/**
 * Extract a GitHub source tarball into `destDir`. GitHub tarballs wrap
 * everything in a single `<repo>-<sha>/` directory; we flatten that away and
 * recover the commit sha from its name (a tarball has no `.git` to query).
 * Relies on `tar` (bundled on macOS/Linux and Windows 10 1803+).
 */
function extractGithubTarball(archivePath, destDir) {
  const extractDir = `${destDir}.x-${process.pid}`;
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    const res = run('tar', ['-xzf', archivePath, '-C', extractDir], { timeoutMs: 5 * 60 * 1000 });
    if (res.status !== 0) {
      die(1, 'failed to extract GitHub tarball', { stdout: (res.stdout || '').slice(-2000) });
    }
    const dirs = fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (dirs.length !== 1) {
      die(1, `unexpected GitHub tarball layout (${dirs.length} top-level entries)`, { archive: archivePath });
    }
    const top = dirs[0].name;
    const m = /-([0-9a-f]{7,40})$/.exec(top);
    const commit = m ? m[1] : '';
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(path.join(extractDir, top), destDir);
    return { commit };
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

/** Download + extract a public GitHub repo into `destDir`. Returns { commit }. */
async function fetchGithubTarballInto(cls, destDir) {
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  const archive = `${destDir}.tgz-${process.pid}`;
  fs.rmSync(archive, { force: true });
  try {
    process.stderr.write(`orkas-pkg: git not used — downloading ${cls.owner}/${cls.repo} tarball\n`);
    await httpsDownload(githubTarballUrl(cls), archive);
    return extractGithubTarball(archive, destDir);
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

/** Atomically replace `dest` with `src` (rename + backup + rollback on error). */
function replaceDirAtomic(dest, src) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const backup = `${dest}.bak-${process.pid}-${Date.now()}`;
  const hadDest = isDir(dest);
  if (hadDest) fs.renameSync(dest, backup);
  try {
    fs.renameSync(src, dest);
    if (hadDest) fs.rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
    if (hadDest && isDir(backup)) {
      try { fs.renameSync(backup, dest); } catch { /* ignore */ }
    }
    throw err;
  }
}

// ── Commands ─────────────────────────────────────────────────────────────

function cmdInstall(args) {
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const nameIdx = args.indexOf('--name');
  const explicitName = nameIdx !== -1 ? args[nameIdx + 1] : '';
  if (explicitName) {
    flags.delete('--name');
    const pi = positional.indexOf(explicitName);
    if (pi !== -1) positional.splice(pi, 1);
  }
  const source = positional[0];
  if (!source) die(64, 'usage: orkas-pkg.cjs install <git-url-or-local-path> [--name <name>] [--consent-deps]');
  const consentDeps = flags.has('--consent-deps');

  const name = explicitName || deriveName(source);
  if (!PKG_NAME_RE.test(name)) {
    die(64, `invalid package name "${name}" — pass --name with [A-Za-z0-9][A-Za-z0-9._-]*`);
  }

  const uid = resolveUid();
  return withRegistryLock(uid, async () => {
    const finalDir = path.join(packagesDir(uid), name);
    if (isDir(finalDir)) {
      die(73, `package "${name}" already exists — use \`orkas-pkg.cjs update ${name}\` or remove it first`);
    }

    // Clone into a staging dir on the same filesystem, scan, then promote.
    const staging = path.join(packagesDir(uid), `.staging-${name}-${process.pid}`);
    fs.rmSync(staging, { recursive: true, force: true });
    // The scan/clone/dep steps below can `die()`, which calls process.exit and
    // skips `finally` — leaving the staging clone behind (a `.staging-*` dir
    // that never gets reclaimed). Mirror the lock's exit-hook pattern so the
    // staging dir is always removed, even on the die() path.
    const cleanupStaging = () => {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* already gone */ }
    };
    process.on('exit', cleanupStaging);
    try {
      const cls = classifySource(source);
      // Protocol allowlist: a non-GitHub `git`-kind source (LLM-controllable)
      // must be a real remote git URL, never `ext::sh -c ...` (arbitrary command
      // execution) or `file://`/bare local paths that clone in-scope-bypassing
      // local dirs. Local directory installs are the separate `local` kind.
      if (cls.kind === 'git' && !/^(https:\/\/|ssh:\/\/|git@)/i.test(source)) {
        die(76,
          'unsupported source: only https:// / ssh:// / git@ git URLs, public GitHub repos, or local directories are allowed',
          { source });
      }
      let commit = '';
      if (gitAvailable()) {
        // Harden the clone: disable the `ext` transport entirely (blocks
        // `ext::sh -c`), restrict `file` to user-initiated top-level only
        // (blocks submodule file:// re-injection), suppress credential prompts,
        // and never recurse submodules (a submodule URL is another injection point).
        const clone = run('git', [
          '-c', 'protocol.ext.allow=never',
          '-c', 'protocol.file.allow=user',
          '-c', 'core.autocrlf=false',
          'clone', '--depth', '1', '--no-recurse-submodules', source, staging,
        ], { env: { GIT_TERMINAL_PROMPT: '0' } });
        if (clone.status === 0) {
          commit = headCommit(staging);
        } else if (cls.kind === 'github') {
          // Git is present but the clone failed (broken git env, credential
          // prompt, network). For a public GitHub repo, fall back to the tarball.
          fs.rmSync(staging, { recursive: true, force: true });
          ({ commit } = await fetchGithubTarballInto(cls, staging));
        } else {
          die(1, `git clone failed (git exited ${clone.status})`, { source, stdout: (clone.stdout || '').slice(-2000) });
        }
      } else if (cls.kind === 'github') {
        ({ commit } = await fetchGithubTarballInto(cls, staging));
      } else {
        die(76,
          'git is required for this source. Without git, only public GitHub '
          + 'repositories can be installed (downloaded as a tarball). Install git, '
          + 'or use a public GitHub URL.',
          { source });
      }

      // Reject before scanning/reading any file in the tree (symlink escape).
      assertNoSymlinks(staging, 'install');
      const scan = scanPackage(staging);
      if (!scan.kind) {
        die(65,
          'project is not installable: no SKILL.md (top-level, skills/, or .claude/skills/) '
          + 'and no CLI entry points (package.json bin / pyproject [project.scripts]). '
          + 'Agent-driven-only projects are not supported.',
          { source });
      }
      const pkgMeta = { name, repo_url: source, commit };
      const depCommands = describeDepCommands(staging, pkgMeta);
      let depsInstalled = [];
      if (depCommands.length && consentDeps) {
        depsInstalled = installDeps(staging, pkgMeta);
      }

      fs.renameSync(staging, finalDir);

      const now = new Date().toISOString();
      const registry = readRegistry(uid);
      registry.packages = registry.packages.filter((p) => p && p.name !== name);
      registry.packages.push({
        name,
        repo_url: source,
        commit,
        kind: scan.kind,
        skill_roots: scan.skillRoots,
        bin_entries: scan.binEntries,
        deps_consent: consentDeps,
        enabled: true,
        installed_at: now,
        updated_at: now,
      });
      writeRegistry(uid, registry);
      const shims = regenerateShims(uid, registry);

      out({
        ok: true,
        action: 'install',
        name,
        kind: scan.kind,
        dir: finalDir,
        skill_roots: scan.skillRoots,
        bin_entries: scan.binEntries.map((b) => b.name),
        shims,
        deps_installed: depsInstalled,
        // D3 consent loop: when deps exist but consent wasn't given, report
        // the exact commands so the commander can show them to the user and
        // re-run with --consent-deps after approval.
        deps_pending_consent: depCommands.length && !consentDeps ? depCommands : [],
      });
    } finally {
      cleanupStaging();
      process.removeListener('exit', cleanupStaging);
    }
  });
}

function cmdConsentDeps(args) {
  const name = args[0];
  if (!name || !PKG_NAME_RE.test(name)) die(64, 'usage: orkas-pkg.cjs consent-deps <name>');
  const uid = resolveUid();
  return withRegistryLock(uid, () => {
    const registry = readRegistry(uid);
    const entry = registry.packages.find((p) => p && p.name === name);
    const pkgDir = path.join(packagesDir(uid), name);
    if (!entry || !isDir(pkgDir)) die(66, `package "${name}" is not installed`);

    if (!entry.commit) entry.commit = headCommit(pkgDir);
    const depsInstalled = installDeps(pkgDir, entry);
    entry.deps_consent = true;
    // Python console-script targets only materialize after dependency install,
    // so rescan bin entries before regenerating shims.
    const scan = scanPackage(pkgDir);
    if (scan.kind) {
      entry.kind = scan.kind;
      entry.skill_roots = scan.skillRoots;
      entry.bin_entries = scan.binEntries;
    }
    entry.updated_at = new Date().toISOString();
    writeRegistry(uid, registry);
    const shims = regenerateShims(uid, registry);

    out({ ok: true, action: 'consent-deps', name, deps_installed: depsInstalled, shims });
  });
}

function cmdUpdate(args) {
  const name = args[0];
  if (!name || !PKG_NAME_RE.test(name)) die(64, 'usage: orkas-pkg.cjs update <name>');
  const uid = resolveUid();
  return withRegistryLock(uid, async () => {
    const registry = readRegistry(uid);
    const entry = registry.packages.find((p) => p && p.name === name);
    const pkgDir = path.join(packagesDir(uid), name);
    if (!entry || !isDir(pkgDir)) die(66, `package "${name}" is not installed`);

    // Route by how it was installed: a `.git` dir means git clone (pull it);
    // otherwise it was a GitHub tarball — re-fetch and atomically swap in place.
    const hasDotGit = isDir(path.join(pkgDir, '.git'));
    let tarballCommit = '';
    if (hasDotGit) {
      const before = headCommit(pkgDir);
      runOrDie('git', ['-c', 'core.autocrlf=false', 'pull', '--ff-only'], { cwd: pkgDir }, 'git pull');
      // Upstream could have introduced a symlink since install; reject + revert
      // so the in-place tree never gains a file that reads outside the package.
      const sl = findSymlink(pkgDir);
      if (sl) {
        if (before) run('git', ['-c', 'core.autocrlf=false', 'reset', '--hard', before], { cwd: pkgDir });
        die(1, 'refusing to update: upstream now contains a symbolic link (reverted to the prior revision)', { path: sl });
      }
    } else {
      const cls = classifySource(entry.repo_url || '');
      if (cls.kind !== 'github') {
        die(65, `cannot update "${name}": it was installed without git and "${entry.repo_url}" is not a GitHub repo — remove and reinstall`);
      }
      const staging = path.join(packagesDir(uid), `.staging-${name}-${process.pid}`);
      fs.rmSync(staging, { recursive: true, force: true });
      const cleanupStaging = () => {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* already gone */ }
      };
      process.on('exit', cleanupStaging);
      try {
        ({ commit: tarballCommit } = await fetchGithubTarballInto(cls, staging));
        // Reject symlinks + validate the new tree BEFORE destroying the current install.
        assertNoSymlinks(staging, 'update');
        if (!scanPackage(staging).kind) {
          die(65, `after update, "${name}" no longer has a supported skill/CLI shape — keeping the current install`);
        }
        replaceDirAtomic(pkgDir, staging);
      } finally {
        cleanupStaging();
        process.removeListener('exit', cleanupStaging);
      }
    }

    const scan = scanPackage(pkgDir);
    if (!scan.kind) {
      die(65, `after update, "${name}" no longer has a supported skill/CLI shape — leaving files in place; review manually`);
    }
    const commit = hasDotGit ? headCommit(pkgDir) : tarballCommit;
    let depsInstalled = [];
    const pkgMeta = { ...entry, commit };
    const depCommands = describeDepCommands(pkgDir, pkgMeta);
    if (depCommands.length && entry.deps_consent === true) {
      depsInstalled = installDeps(pkgDir, pkgMeta);
    }

    entry.commit = commit;
    entry.kind = scan.kind;
    entry.skill_roots = scan.skillRoots;
    entry.bin_entries = scan.binEntries;
    entry.updated_at = new Date().toISOString();
    writeRegistry(uid, registry);
    const shims = regenerateShims(uid, registry);

    out({
      ok: true,
      action: 'update',
      name,
      commit: entry.commit,
      kind: scan.kind,
      skill_roots: scan.skillRoots,
      shims,
      deps_installed: depsInstalled,
      deps_pending_consent: depCommands.length && entry.deps_consent !== true ? depCommands : [],
    });
  });
}

function cmdSetEnabled(args, enabled) {
  const name = args[0];
  if (!name || !PKG_NAME_RE.test(name)) die(64, `usage: orkas-pkg.cjs ${enabled ? 'enable' : 'disable'} <name>`);
  const uid = resolveUid();
  return withRegistryLock(uid, () => {
    const registry = readRegistry(uid);
    const entry = registry.packages.find((p) => p && p.name === name);
    if (!entry) die(66, `package "${name}" is not installed`);
    entry.enabled = enabled;
    entry.updated_at = new Date().toISOString();
    writeRegistry(uid, registry);
    // Shims follow enabled state (disabled package's CLIs disappear from PATH).
    const shims = regenerateShims(uid, registry);
    out({ ok: true, action: enabled ? 'enable' : 'disable', name, shims });
  });
}

/**
 * Minimal SKILL.md frontmatter check for an authored companion. The open-tier
 * loader reads frontmatter leniently, but a card with no name/description is
 * useless — so require a `---`-fenced block with a non-empty `name:` and at
 * least one description field. Not a full YAML parse; just enough to reject an
 * empty or malformed authoring attempt.
 */
function validateCompanionFrontmatter(content) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(content);
  if (!m) return 'SKILL.md must start with a --- frontmatter block';
  const fm = m[1];
  const hasName = /^name:\s*\S/m.test(fm);
  const hasDesc = /^description(?:_zh|_en)?:\s*\S/m.test(fm);
  if (!hasName) return 'frontmatter must include a non-empty `name:`';
  if (!hasDesc) return 'frontmatter must include a `description:` (or description_zh/description_en)';
  return null;
}

/**
 * Write an auto-authored companion usage SKILL.md for a CLI-only package.
 * Content comes from stdin (the commander pipes a heredoc). This writes
 * OUTSIDE the verbatim package tree, so the "never write into a cloned repo"
 * invariant is preserved. The package must already be installed.
 */
function cmdSkillWrite(args) {
  const name = args[0];
  if (!name || !PKG_NAME_RE.test(name)) die(64, 'usage: orkas-pkg.cjs skill-write <name>  (SKILL.md on stdin)');
  const uid = resolveUid();
  let content = '';
  try {
    content = fs.readFileSync(0, 'utf8');
  } catch {
    die(64, 'skill-write reads SKILL.md from stdin; pipe the content in');
  }
  if (!content.trim()) die(64, 'skill-write: empty stdin (expected SKILL.md content)');
  const fmError = validateCompanionFrontmatter(content);
  if (fmError) die(65, `skill-write: ${fmError}`);
  return withRegistryLock(uid, () => {
    const registry = readRegistry(uid);
    const entry = registry.packages.find((p) => p && p.name === name);
    if (!entry) die(66, `package "${name}" is not installed`);
    const dir = packageSkillDir(uid, name);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'SKILL.md.tmp');
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, path.join(dir, 'SKILL.md'));
    fs.writeFileSync(
      path.join(dir, '_meta.json'),
      JSON.stringify({ source_package: name, generated_at: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
    out({ ok: true, action: 'skill-write', name, skill_path: path.join(dir, 'SKILL.md') });
  });
}

function cmdRemove(args) {
  const name = args[0];
  if (!name || !PKG_NAME_RE.test(name)) die(64, 'usage: orkas-pkg.cjs remove <name>');
  const uid = resolveUid();
  return withRegistryLock(uid, () => {
    const registry = readRegistry(uid);
    const exists = registry.packages.some((p) => p && p.name === name);
    const pkgDir = path.join(packagesDir(uid), name);
    if (!exists && !isDir(pkgDir)) die(66, `package "${name}" is not installed`);
    registry.packages = registry.packages.filter((p) => p && p.name !== name);
    writeRegistry(uid, registry);
    fs.rmSync(pkgDir, { recursive: true, force: true });
    // The companion usage skill is keyed to this package — remove it too so no
    // orphan skill lingers in the open-tier listing.
    fs.rmSync(packageSkillDir(uid, name), { recursive: true, force: true });
    regenerateShims(uid, registry);
    out({ ok: true, action: 'remove', name });
  });
}

function cmdList() {
  const uid = resolveUid();
  const registry = readRegistry(uid);
  out({
    ok: true,
    action: 'list',
    packages: registry.packages.map((p) => ({
      name: p.name,
      kind: p.kind,
      enabled: p.enabled !== false,
      commit: (p.commit || '').slice(0, 12),
      skill_roots: p.skill_roots || [],
      bin_entries: (p.bin_entries || []).map((b) => b.name),
      deps_consent: p.deps_consent === true,
      updated_at: p.updated_at || p.installed_at || '',
    })),
  });
}

function cmdInfo(args) {
  const name = args[0];
  if (!name) die(64, 'usage: orkas-pkg.cjs info <name>');
  const uid = resolveUid();
  const entry = readRegistry(uid).packages.find((p) => p && p.name === name);
  if (!entry) die(66, `package "${name}" is not installed`);
  out({ ok: true, action: 'info', package: entry, dir: path.join(packagesDir(uid), name) });
}

async function main() {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case 'install': return cmdInstall(rest);
    case 'consent-deps': return cmdConsentDeps(rest);
    case 'enable': return cmdSetEnabled(rest, true);
    case 'disable': return cmdSetEnabled(rest, false);
    case 'update': return cmdUpdate(rest);
    case 'remove': return cmdRemove(rest);
    case 'skill-write': return cmdSkillWrite(rest);
    case 'list': return cmdList();
    case 'info': return cmdInfo(rest);
    default:
      die(64, 'usage: orkas-pkg.cjs <install|consent-deps|enable|disable|update|remove|skill-write|list|info> ...');
  }
}

if (require.main === module) {
  main().catch((err) => die(1, 'orkas-pkg failed', { error: err && err.message }));
} else {
  // Required from a test — expose the pure source-routing/fetch helpers without
  // running a command. (Run-as-CLI takes the branch above.)
  module.exports = {
    classifySource, githubTarballUrl, extractGithubTarball,
    findSymlink, isGithubHost, validGithubId,
  };
}
