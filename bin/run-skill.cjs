#!/usr/bin/env node
/**
 * Orkas skill runner.
 *
 * Invoked by LLM bash tool as:
 *   "$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" <skill-id-or-name> <script-basename> [-- args...]
 *
 * Dispatches by file extension so the LLM uses one invocation form regardless
 * of skill language:
 *   .ts / .mjs / .js — require() with tsx/cjs hook, call default export as
 *                       `async (args) => result`, JSON.stringify result to stdout.
 *   .py              — spawn shared data/venv package Python, else nearest
 *                       package `.venv`, else `ORKAS_PYTHON`, else system
 *                       Python (`python3`; Windows: `py -3` then `python`),
 *                       inherit stdio, exit with child code.
 *   .ps1             — spawn PowerShell (Windows-native script).
 *   .cmd / .bat      — spawn `cmd.exe` (Windows-native batch script).
 *   .sh              — spawn `bash` (Windows: Git Bash only; WSL is not
 *                       auto-selected),
 *   .rb              — spawn `ruby`, inherit stdio, exit with child's code.
 *
 * Resolution order (matches SkillRegistry — see model/core-agent/skill-registry.ts):
 *   1. <uid>/cloud/skills/<id>/scripts/<basename>.<ext>            (custom)
 *   2. <uid>/local/marketplace/skills/<id>/scripts/<basename>.<ext> (installed)
 *   3. Current-agent private installed roots when ORKAS_AGENT_ID is set:
 *      <uid>/local/marketplace/agents/<agent-id>/skills/<id>/scripts/<basename>.<ext>
 *      <uid>/cloud/agents/<agent-id>/private_skills/<id>/scripts/<basename>.<ext>
 *   4. External-package skill roots from <uid>/local/packages/_registry.json
 *      (enabled packages only; `.` roots resolve against the packages dir)
 *   5. Global roots: ~/.claude/skills, ~/.codex/skills (interop, read-only)
 *   6. Same roots by SKILL.md frontmatter `name` when dir id != authored name
 *   For each candidate dir we try extensions in platform-specific order.
 *
 * Dependency resolution for scripts living under an external package (or any
 * skill dir that vendors its own deps): the NEAREST `node_modules` walking up
 * from the skill dir is prepended to NODE_PATH ahead of PC/node_modules, and
 * Python package deps prefer the shared machine-local data/venv interpreter
 * keyed by package source+commit; legacy/vendored `.venv` dirs still work as
 * fallback. The package tree itself is never modified.
 *
 * Env inputs:
 *   ORKAS_PC_DIR          — points at PC root (or asar.unpacked equivalent).
 *   ORKAS_UID             — active user id. When present, only that user's
 *                           cloud / marketplace / package skill dirs are
 *                           scanned.
 *   ORKAS_AGENT_ID        — current acting agent id. When present, only this
 *                           agent's private installed skill roots are scanned.
 *   ORKAS_WORKSPACE_ROOT  — canonical workspace-data root (set by main process
 *                           in install-data-root.ts). ORKAS_WS_ROOT is honoured
 *                           as a back-compat alias. When neither is set the
 *                           platform default ~/.orkas/data is used.
 *   ORKAS_RUN_SKILL_DIR   — optional trusted caller allow-list override:
 *                           resolve only inside this concrete skill dir.
 *   ORKAS_PYTHON          — optional bundled Python executable injected by
 *                           the main process when resources/runtime is
 *                           available.
 *   ORKAS_VENV_ROOT       — optional shared venv root. Defaults to
 *                           `<ORKAS_WORKSPACE_ROOT>/venv`.
 *   ELECTRON_RUN_AS_NODE  — set to 1 when running through Electron binary.
 *
 * This file is CommonJS so it can be required directly without import-hook
 * gymnastics. .ts skill scripts use ESM-style default export.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SCRIPT_EXTS = ['py', 'ts', 'mjs', 'js', 'ps1', 'cmd', 'bat', 'sh', 'rb'];
const PKG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function scriptExtsForPlatform(platform = process.platform) {
  if (platform === 'win32') return SCRIPT_EXTS;
  return ['py', 'ts', 'mjs', 'js', 'sh', 'rb', 'ps1'];
}

function die(exitCode, message, extra) {
  const payload = { ok: false, error: message };
  if (extra) Object.assign(payload, extra);
  process.stderr.write(JSON.stringify(payload) + '\n');
  process.exit(exitCode);
}

function parseArgs(argv) {
  // argv[0]=node, argv[1]=run-skill.cjs, argv[2]=skill-id, argv[3]=script
  const args = argv.slice(2);
  if (args.length < 2) {
    die(64, 'usage: run-skill.cjs <skill-id> <script-basename> [-- <script args>]');
  }
  const [skillId, scriptBase, ...rest] = args;
  if (scriptBase.includes('/') || scriptBase.includes('\\') || scriptBase === '.' || scriptBase === '..') {
    die(64, 'script basename must not contain path separators');
  }
  // Everything after `--` (or all of `rest`, whichever) is the script's args.
  let scriptArgs;
  const dashIdx = rest.indexOf('--');
  scriptArgs = dashIdx === -1 ? rest : rest.slice(dashIdx + 1);
  return { skillId, scriptBase, scriptArgs };
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function workspaceRoot() {
  return process.env.ORKAS_WORKSPACE_ROOT
    || process.env.ORKAS_WS_ROOT
    || path.join(require('os').homedir(), '.orkas', 'data');
}

function sharedVenvRoot() {
  return process.env.ORKAS_VENV_ROOT || path.join(workspaceRoot(), 'venv');
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

function pushUnique(arr, seen, value) {
  const resolved = path.resolve(value);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  arr.push(value);
}

function safePathSegment(value) {
  const text = String(value || '').trim();
  if (!text || text === '.' || text === '..') return '';
  if (text.includes('/') || text.includes('\\') || text.includes('\0') || text.includes('..')) return '';
  return text;
}

function parseFrontmatterScalar(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s[0] === '"') {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\') {
        const next = s[++i];
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else if (next != null) out += next;
        continue;
      }
      if (ch === '"') return out;
      out += ch;
    }
    return s;
  }
  if (s[0] === "'") {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (ch === "'" && s[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      if (ch === "'") return out;
      out += ch;
    }
    return s;
  }
  return s;
}

function readSkillDisplayName(skillDir) {
  try {
    const md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    if (!md.startsWith('---')) return '';
    const end = md.indexOf('\n---', 3);
    if (end === -1) return '';
    const lines = md.slice(3, end).split('\n');
    for (const line of lines) {
      if (!line || !line.trim() || /^\s/.test(line)) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx <= 0) continue;
      const key = line.slice(0, colonIdx).trim();
      if (key !== 'name') continue;
      return parseFrontmatterScalar(line.slice(colonIdx + 1));
    }
  } catch {
    /* unreadable skill metadata is ignored; direct id lookup may still work */
  }
  return '';
}

function collectSkillDirs(skillRef) {
  const forcedDir = process.env.ORKAS_RUN_SKILL_DIR;
  if (forcedDir) {
    const resolved = path.resolve(forcedDir);
    if (!isDir(resolved)) {
      die(66, 'allowed skill dir is not available', { dir: resolved });
    }
    return [resolved];
  }

  const wsRoot = workspaceRoot();
  // Candidate skill dirs — mirror SkillRegistry's trusted + current-agent
  // private resolution. Agent-private dirs are included only when ORKAS_UID
  // scopes the user and ORKAS_AGENT_ID names the acting agent; otherwise
  // commander/other agents cannot execute another agent's bundled skills.
  //
  // Per-user skills live under <ws>/<uid>/cloud/skills/<id> and
  // <ws>/<uid>/local/marketplace/skills/<id>. uid can be numeric or a UUID,
  // so we scan every subdirectory rather than regex-matching. Skip the deny-
  // list approach (had to hand-maintain a list of `logs / config / ...`
  // sibling names that would drift the moment a new top-level data dir gets
  // added under PC/CLAUDE.md §4); instead, only KEEP an entry if it actually
  // contains the skill under one of the two SkillRegistry-aware shapes. This
  // is the strict invariant — a real uid dir always has one of those shapes
  // when the skill is installed for that user; any sibling dir that doesn't
  // is irrelevant by construction.
  const roots = [];
  const directDirs = [];
  const directSeen = new Set();
  function addRoot(root) {
    if (isDir(root)) roots.push(root);
  }
  function addDirect(root) {
    const candidate = path.join(root, skillRef);
    if (isDir(candidate)) pushUnique(directDirs, directSeen, candidate);
  }
  // External-package skill roots come from the per-uid packages registry —
  // registry-driven, not a blind scan, so disabled packages stay invisible.
  // Schema contract: src/main/features/packages.ts.
  function packageSkillRoots(uidDir) {
    const packagesRoot = path.join(uidDir, 'local', 'packages');
    const roots = [];
    let registry;
    try {
      registry = JSON.parse(fs.readFileSync(path.join(packagesRoot, '_registry.json'), 'utf8'));
    } catch { return roots; }
    if (!registry || !Array.isArray(registry.packages)) return roots;
    for (const pkg of registry.packages) {
      if (!pkg || typeof pkg.name !== 'string' || pkg.enabled === false) continue;
      if (/[\\/]|\.\./.test(pkg.name)) continue;
      for (const rel of Array.isArray(pkg.skill_roots) ? pkg.skill_roots : []) {
        if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) continue;
        roots.push(rel === '.' ? packagesRoot : path.join(packagesRoot, pkg.name, rel));
      }
    }
    return roots;
  }

  const envAgentId = safePathSegment(process.env.ORKAS_AGENT_ID);

  function addUidDir(uidDir, includeAgentPrivate = false) {
    const cloudRoot = path.join(uidDir, 'cloud', 'skills');
    const marketplaceRoot = path.join(uidDir, 'local', 'marketplace', 'skills');
    addRoot(cloudRoot);
    addRoot(marketplaceRoot);
    addDirect(cloudRoot);
    addDirect(marketplaceRoot);
    if (includeAgentPrivate && envAgentId) {
      const marketplaceAgentSkillsRoot = path.join(uidDir, 'local', 'marketplace', 'agents', envAgentId, 'skills');
      const customAgentPrivateSkillsRoot = path.join(uidDir, 'cloud', 'agents', envAgentId, 'private_skills');
      addRoot(marketplaceAgentSkillsRoot);
      addRoot(customAgentPrivateSkillsRoot);
      addDirect(marketplaceAgentSkillsRoot);
      addDirect(customAgentPrivateSkillsRoot);
    }
    for (const pkgRoot of packageSkillRoots(uidDir)) {
      addRoot(pkgRoot);
      addDirect(pkgRoot);
    }
  }

  const envUid = (process.env.ORKAS_UID || '').trim();
  if (envUid && !/[\\/]/.test(envUid) && envUid !== '.' && envUid !== '..') {
    addUidDir(path.join(wsRoot, envUid), true);
  } else {
    try {
      for (const entry of fs.readdirSync(wsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        addUidDir(path.join(wsRoot, entry.name));
      }
    } catch {
      /* no data dir yet */
    }
  }
  // Global roots last — lowest priority, mirroring SkillRegistry's open tier.
  // Keep this list in sync with paths.ts::globalSkillRoots(); a root listed
  // there but missing here is advertised/readable yet its scripts fail to run.
  for (const globalRoot of [
    path.join(require('os').homedir(), '.claude', 'skills'),
    path.join(require('os').homedir(), '.codex', 'skills'),
  ]) {
    addRoot(globalRoot);
    addDirect(globalRoot);
  }
  if (directDirs.length) return directDirs;

  const aliasDirs = [];
  const aliasSeen = new Set();
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      if (readSkillDisplayName(dir) === skillRef) {
        pushUnique(aliasDirs, aliasSeen, dir);
      }
    }
  }
  return aliasDirs;
}

function locateSkillScript(skillId, scriptBase) {
  const skillDirs = collectSkillDirs(skillId);
  const scriptExts = scriptExtsForPlatform();
  const candidates = [];
  for (const dir of skillDirs) {
    for (const ext of scriptExts) {
      candidates.push(path.join(dir, 'scripts', `${scriptBase}.${ext}`));
    }
  }
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  die(66, `skill script not found: ${skillId}/${scriptBase}.{${scriptExts.join(',')}}`, {
    searched: candidates,
    hint: 'check skill id/display name and script name; ORKAS_PC_DIR / ORKAS_WORKSPACE_ROOT env',
  });
}

/**
 * Walk up from `startDir` looking for `relProbe` (e.g. `node_modules` or a
 * `.venv` interpreter), at most `maxLevels` levels — enough to climb from a
 * nested skill dir (`<pkg>/skills/<id>`) to its package root without ever
 * scanning past the data root into unrelated trees.
 */
function findUpwards(startDir, relProbe, maxLevels) {
  let dir = path.resolve(startDir);
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = path.join(dir, relProbe);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* keep climbing */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function existingFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function packageEntryForScript(scriptPath) {
  const root = path.resolve(workspaceRoot());
  const rel = path.relative(root, path.resolve(scriptPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length < 5 || parts[1] !== 'local' || parts[2] !== 'packages') return null;
  const uid = parts[0];
  const pkgName = parts[3];
  if (!PKG_NAME_RE.test(pkgName)) return null;
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(path.join(root, uid, 'local', 'packages', '_registry.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!registry || !Array.isArray(registry.packages)) return null;
  const entry = registry.packages.find((pkg) =>
    pkg && pkg.name === pkgName && pkg.enabled !== false);
  if (!entry) return null;
  return {
    name: pkgName,
    repo_url: typeof entry.repo_url === 'string' ? entry.repo_url : '',
    commit: typeof entry.commit === 'string' ? entry.commit : '',
  };
}

function sharedPackageVenvPython(scriptPath, isWin) {
  const entry = packageEntryForScript(scriptPath);
  if (!entry) return null;
  const venv = path.join(sharedVenvRoot(), 'python', 'packages', packageVenvKey(entry), '.venv');
  const python = isWin
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
  return existingFile(python) ? python : null;
}

function findOnPath(names, env = process.env) {
  const pathValue = env.PATH || env.Path || env.path || '';
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const pathext = process.platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((x) => x.trim()).filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const name of names) {
      const variants = path.extname(name) ? [name] : pathext.map((ext) => `${name}${ext}`);
      for (const variant of variants) {
        const candidate = path.join(dir, variant);
        if (existingFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

function findGitBash() {
  const envCandidates = [
    process.env.ORKAS_GIT_BASH_PATH,
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
  ].filter(Boolean);
  for (const p of envCandidates) {
    if (existingFile(p)) return p;
  }

  const pathCandidate = findOnPath(['bash.exe', 'bash']);
  if (pathCandidate) return pathCandidate;

  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter(Boolean);
  for (const root of roots) {
    for (const rel of [
      path.join('Git', 'bin', 'bash.exe'),
      path.join('Git', 'usr', 'bin', 'bash.exe'),
    ]) {
      const candidate = path.join(root, rel);
      if (existingFile(candidate)) return candidate;
    }
  }
  return null;
}

function findPowerShell() {
  for (const p of [process.env.ORKAS_POWERSHELL_PATH, process.env.POWERSHELL_PATH].filter(Boolean)) {
    if (existingFile(p)) return p;
  }
  return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
}

function commandFromEnv(value) {
  if (!value) return null;
  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    return existingFile(value) ? value : null;
  }
  return value;
}

function findPython(isWin) {
  const configured = commandFromEnv(process.env.ORKAS_PYTHON);
  if (configured) return { cmd: configured, args: [] };
  if (isWin) {
    const pyLauncher = findOnPath(['py.exe', 'py']);
    if (pyLauncher) return { cmd: pyLauncher, args: ['-3'] };
    return { cmd: 'python', args: [] };
  }
  return { cmd: 'python3', args: [] };
}

function registerTsxLoader() {
  if (!process.env.ORKAS_PC_DIR) {
    die(69, 'ORKAS_PC_DIR env not set — cannot locate tsx for .ts transpile');
  }
  // Resolve tsx from PC/node_modules explicitly (subprocess cwd may be
  // anywhere). ORKAS_PC_DIR already points at asar.unpacked in packaged
  // mode, so plain filesystem resolution works.
  const tsxEntry = path.join(process.env.ORKAS_PC_DIR, 'node_modules', 'tsx', 'dist', 'cjs', 'index.cjs');
  try {
    require(tsxEntry);
  } catch (e) {
    die(70, `failed to load tsx/cjs from ${tsxEntry}: ${e && e.message}`);
  }
}

function runViaSubprocess(scriptPath, scriptArgs, skillId) {
  const ext = path.extname(scriptPath).slice(1).toLowerCase();
  const skillDir = path.dirname(path.dirname(scriptPath));
  const isWin = process.platform === 'win32';
  // Pick command + args by extension. For Python on Windows we try `py -3`
  // first (Python launcher, ships with the official installer) and fall back
  // to `python` if missing — handled by trying spawn.
  let cmd; let argv0Args = [];
  if (ext === 'py') {
    // External package skills prefer the shared data/venv interpreter keyed
    // by package source+commit. Legacy/vendored skills can still supply a
    // nearest `.venv` walking up from the skill dir.
    const sharedPython = sharedPackageVenvPython(scriptPath, isWin);
    const venvPython = findUpwards(
      skillDir,
      isWin ? path.join('.venv', 'Scripts', 'python.exe') : path.join('.venv', 'bin', 'python3'),
      3,
    );
    if (sharedPython) {
      cmd = sharedPython;
    } else if (venvPython) {
      cmd = venvPython;
    } else if (isWin) {
      const py = findPython(isWin);
      cmd = py.cmd;
      argv0Args = py.args;
    } else {
      const py = findPython(isWin);
      cmd = py.cmd;
      argv0Args = py.args;
    }
  } else if (ext === 'sh') {
    if (isWin) {
      cmd = findGitBash();
      if (!cmd) {
        die(
          76,
          'Git Bash is required to run .sh skill scripts on native Windows. Install Git for Windows, set ORKAS_GIT_BASH_PATH, or provide a .ps1/.cmd/.py/.js script for this skill.',
          { scriptPath },
        );
      }
    } else {
      cmd = 'bash';
    }
  } else if (ext === 'ps1') {
    cmd = findPowerShell();
    argv0Args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
    ];
  } else if (ext === 'cmd' || ext === 'bat') {
    if (!isWin) die(75, `Windows batch script requires native Windows: ${scriptPath}`);
    cmd = 'cmd.exe';
    argv0Args = ['/d', '/s', '/c'];
  } else if (ext === 'rb') {
    cmd = 'ruby';
  } else {
    die(75, `unsupported subprocess extension: ${ext}`);
  }
  trySpawn(cmd, [...argv0Args, scriptPath, ...scriptArgs], skillDir, skillId, true);
}

function trySpawn(cmd, argv, skillDir, skillId, fatalOnEnoent = false) {
  let child;
  try {
    child = spawn(cmd, argv, {
      stdio: 'inherit',
      env: { ...process.env, ORKAS_SKILL_ID: skillId, ORKAS_SKILL_DIR: skillDir },
      windowsHide: true,
    });
  } catch (e) {
    if (fatalOnEnoent) die(76, `failed to spawn ${cmd}: ${e && e.message}`);
    return { spawned: false };
  }
  child.on('error', (e) => {
    if (e && e.code === 'ENOENT' && !fatalOnEnoent) return; // caller will retry
    die(76, `failed to spawn ${cmd}: ${e && e.message}`, { cmd, argv });
  });
  // `close` follows `exit` after inherited stdio and OS process handles are
  // released. Exiting the runner on `exit` left freshly executed .exe files
  // and temporary skill directories briefly locked on Windows.
  child.on('close', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code == null ? 1 : code);
  });
  return { spawned: true };
}

async function runAsModule(scriptPath, scriptArgs, skillId) {
  registerTsxLoader();

  // Ensure skill scripts can resolve packages from PC/node_modules even when
  // the script lives under data/<uid>/cloud/skills/... (outside PC). NODE_PATH
  // is honoured by Node's module resolution at initial require; this helps any
  // transitive resolver used by tsx + user code.
  //
  // External packages / vendored skills: the NEAREST node_modules walking up
  // from the skill dir ranks FIRST so a package's own pinned deps beat
  // same-name modules in PC/node_modules. PC/node_modules stays as fallback.
  const skillDir = path.dirname(path.dirname(scriptPath));
  const ownNodeModules = findUpwards(skillDir, 'node_modules', 3);
  const pcNodeModules = path.join(process.env.ORKAS_PC_DIR, 'node_modules');
  const nodePathParts = [];
  if (ownNodeModules && path.resolve(ownNodeModules) !== path.resolve(pcNodeModules)) {
    nodePathParts.push(ownNodeModules);
  }
  nodePathParts.push(pcNodeModules);
  if (process.env.NODE_PATH) nodePathParts.push(process.env.NODE_PATH);
  process.env.NODE_PATH = nodePathParts.join(path.delimiter);
  require('node:module').Module._initPaths();

  let mod;
  try {
    mod = require(scriptPath);
  } catch (e) {
    die(71, `failed to load skill script: ${e && (e.stack || e.message)}`, { scriptPath });
  }

  const fn = (mod && (mod.default || mod)) || null;
  if (typeof fn !== 'function') {
    die(72, 'skill script must export default async function(args): Promise<any>', { scriptPath });
  }

  let result;
  try {
    result = await fn({ args: scriptArgs, skillId, skillDir: path.dirname(path.dirname(scriptPath)) });
  } catch (e) {
    die(1, e && (e.stack || e.message), { scriptPath });
  }

  // If the script already printed structured output, respect that and skip
  // appending a duplicate payload. Convention: non-undefined return => we
  // JSON.stringify it to stdout (trailing newline).
  if (result !== undefined) {
    try {
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (e) {
      die(73, `failed to serialize result: ${e && e.message}`);
    }
  }
  process.exit(0);
}

async function main() {
  const { skillId, scriptBase, scriptArgs } = parseArgs(process.argv);
  const scriptPath = locateSkillScript(skillId, scriptBase);

  const ext = path.extname(scriptPath).slice(1).toLowerCase();
  if (ext === 'ts' || ext === 'mjs' || ext === 'js') {
    await runAsModule(scriptPath, scriptArgs, skillId);
  } else {
    runViaSubprocess(scriptPath, scriptArgs, skillId);
  }
}

main();
