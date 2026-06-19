#!/usr/bin/env node
/**
 * Orkas external-package installer CLI.
 *
 * Invoked by the LLM bash tool (guided by the `package-installer` system
 * skill) as:
 *   $ORKAS_NODE $ORKAS_PC_DIR/bin/orkas-pkg.cjs <command> [args...]
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
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

function withRegistryLock(uid, fn) {
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
    return fn();
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
    env: process.env,
    // npm/pip/git progress goes to our stderr so the bash tool surfaces it.
    stdio: ['ignore', 'pipe', 'inherit'],
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

// ── Capability scan ──────────────────────────────────────────────────────

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

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

function venvPythonPath(pkgDir) {
  return process.platform === 'win32'
    ? path.join(pkgDir, '.venv', 'Scripts', 'python.exe')
    : path.join(pkgDir, '.venv', 'bin', 'python');
}

function venvPipPath(pkgDir) {
  return process.platform === 'win32'
    ? path.join(pkgDir, '.venv', 'Scripts', 'pip.exe')
    : path.join(pkgDir, '.venv', 'bin', 'pip');
}

/** Candidate rel dirs whose children (or, for '.', the dir itself) hold SKILL.md. */
const SKILL_ROOT_CANDIDATES = ['skills', path.join('.claude', 'skills')];

function scanSkillRoots(pkgDir) {
  const roots = [];
  if (isFile(path.join(pkgDir, 'SKILL.md'))) roots.push('.');
  for (const rel of SKILL_ROOT_CANDIDATES) {
    const abs = path.join(pkgDir, rel);
    if (!isDir(abs)) continue;
    let hasSkill = false;
    try {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory() && isFile(path.join(abs, entry.name, 'SKILL.md'))) { hasSkill = true; break; }
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
 * shape; anything fancier is ignored. Targets resolve to the venv console
 * script (created by `pip install -e .`), so they only become shims once
 * deps are installed.
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

function scanPackage(pkgDir) {
  const skillRoots = scanSkillRoots(pkgDir);
  const binEntries = [...scanNodeBinEntries(pkgDir), ...scanPythonBinEntries(pkgDir)];
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

function describeDepCommands(pkgDir) {
  const cmds = [];
  if (hasNodeDeps(pkgDir)) cmds.push('npm install --omit=dev');
  if (hasPythonProject(pkgDir)) {
    const uv = uvCommand();
    if (uv) {
      const venvCmd = process.env.ORKAS_PYTHON
        ? '$ORKAS_UV venv --python $ORKAS_PYTHON .venv'
        : '$ORKAS_UV venv .venv';
      cmds.push(`${venvCmd} && $ORKAS_UV pip install --python .venv -e .`);
    } else {
      cmds.push(`${pythonCommand().label} -m venv .venv && ${process.platform === 'win32' ? '.venv\\Scripts\\pip.exe' : '.venv/bin/pip'} install -e .`);
    }
  }
  return cmds;
}

function installDeps(pkgDir) {
  const performed = [];
  if (hasNodeDeps(pkgDir)) {
    runOrDie('npm', ['install', '--omit=dev', '--no-fund', '--no-audit'], { cwd: pkgDir }, 'npm install');
    performed.push('npm install --omit=dev');
  }
  if (hasPythonProject(pkgDir)) {
    const venv = path.join(pkgDir, '.venv');
    const uv = uvCommand();
    if (uv) {
      if (!isDir(venv)) {
        const args = ['venv'];
        if (process.env.ORKAS_PYTHON) args.push('--python', process.env.ORKAS_PYTHON);
        args.push('.venv');
        runOrDie(uv, args, { cwd: pkgDir }, 'uv venv');
      }
      runOrDie(uv, ['pip', 'install', '--python', venvPythonPath(pkgDir), '-e', '.'], { cwd: pkgDir }, 'uv pip install');
      performed.push('uv pip install -e .');
    } else {
      const py = pythonCommand();
      if (!isDir(venv)) runOrDie(py.cmd, [...py.args, '-m', 'venv', '.venv'], { cwd: pkgDir }, 'venv creation');
      runOrDie(venvPipPath(pkgDir), ['install', '-e', '.'], { cwd: pkgDir }, 'pip install');
      performed.push('pip install -e .');
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
      const targetAbs = path.join(packagesDir(uid), pkg.name, entry.target);
      // Python console scripts only exist after pip install -e — skip until then.
      if (entry.runtime === 'python' && !isFile(targetAbs)) continue;
      wanted.push({ pkg: pkg.name, ...entry, targetAbs });
    }
  }
  if (!wanted.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  const created = [];
  for (const w of wanted) {
    const shPath = path.join(dir, w.name);
    if (w.runtime === 'node') {
      // ORKAS_NODE (Electron-as-Node) is in the bash sandbox env; plain
      // `node` is the fallback for hand-run shells.
      fs.writeFileSync(shPath, `#!/bin/sh\nexec "\${ORKAS_NODE:-node}" "${w.targetAbs}" "$@"\n`, { mode: 0o755 });
      fs.writeFileSync(`${shPath}.cmd`, `@echo off\r\nif defined ORKAS_NODE ("%ORKAS_NODE%" "${w.targetAbs}" %*) else (node "${w.targetAbs}" %*)\r\n`);
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
  return withRegistryLock(uid, () => {
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
      runOrDie('git', ['clone', '--depth', '1', source, staging], {}, 'git clone');

      const scan = scanPackage(staging);
      if (!scan.kind) {
        die(65,
          'project is not installable: no SKILL.md (top-level, skills/, or .claude/skills/) '
          + 'and no CLI entry points (package.json bin / pyproject [project.scripts]). '
          + 'Agent-driven-only projects are not supported.',
          { source });
      }

      const depCommands = describeDepCommands(staging);
      let depsInstalled = [];
      if (depCommands.length && consentDeps) {
        depsInstalled = installDeps(staging);
      }

      fs.renameSync(staging, finalDir);

      const now = new Date().toISOString();
      const registry = readRegistry(uid);
      registry.packages = registry.packages.filter((p) => p && p.name !== name);
      registry.packages.push({
        name,
        repo_url: source,
        commit: headCommit(finalDir),
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

    const depsInstalled = installDeps(pkgDir);
    entry.deps_consent = true;
    // Python console-script targets only materialize after pip install -e,
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
  return withRegistryLock(uid, () => {
    const registry = readRegistry(uid);
    const entry = registry.packages.find((p) => p && p.name === name);
    const pkgDir = path.join(packagesDir(uid), name);
    if (!entry || !isDir(pkgDir)) die(66, `package "${name}" is not installed`);

    runOrDie('git', ['pull', '--ff-only'], { cwd: pkgDir }, 'git pull');

    const scan = scanPackage(pkgDir);
    if (!scan.kind) {
      die(65, `after update, "${name}" no longer has a supported skill/CLI shape — leaving files in place; review manually`);
    }
    let depsInstalled = [];
    const depCommands = describeDepCommands(pkgDir);
    if (depCommands.length && entry.deps_consent === true) {
      depsInstalled = installDeps(pkgDir);
    }

    entry.commit = headCommit(pkgDir);
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

function main() {
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

main();
