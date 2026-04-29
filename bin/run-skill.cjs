#!/usr/bin/env node
/**
 * Orkas skill runner.
 *
 * Invoked by LLM bash tool as:
 *   $ORKAS_NODE $ORKAS_PC_DIR/bin/run-skill.cjs <skill-id> <script-basename> [-- args...]
 *
 * Dispatches by file extension so the LLM uses one invocation form regardless
 * of skill language:
 *   .ts / .mjs / .js — require() with tsx/cjs hook, call default export as
 *                       `async (args) => result`, JSON.stringify result to stdout.
 *   .py              — spawn `python3` (Windows: `py -3` then `python`),
 *                       inherit stdio, exit with child's code.
 *   .sh              — spawn `bash`, inherit stdio, exit with child's code.
 *   .rb              — spawn `ruby`, inherit stdio, exit with child's code.
 *
 * Resolution order:
 *   1. <uid>/cloud/skills/<id>/scripts/<basename>.<ext>   (custom)
 *   2. data/builtin/skills/<id>/scripts/<basename>.<ext>  (builtin runtime)
 *   3. <PC>/src/builtin/skills/<id>/scripts/<basename>.<ext> (dev / asar.unpacked)
 *   For each candidate dir we try ts → mjs → js → py → sh → rb in order.
 *
 * Env inputs:
 *   ORKAS_PC_DIR   — points at PC root (or asar.unpacked equivalent).
 *   ORKAS_WS_ROOT  — optional override for data/ root.
 *   ELECTRON_RUN_AS_NODE — set to 1 when running through Electron binary.
 *
 * This file is CommonJS so it can be required directly without import-hook
 * gymnastics. .ts skill scripts use ESM-style default export.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT_EXTS = ['py', 'ts', 'mjs', 'js', 'sh', 'rb'];

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
  // Everything after `--` (or all of `rest`, whichever) is the script's args.
  let scriptArgs;
  const dashIdx = rest.indexOf('--');
  scriptArgs = dashIdx === -1 ? rest : rest.slice(dashIdx + 1);
  return { skillId, scriptBase, scriptArgs };
}

function locateSkillScript(skillId, scriptBase) {
  const wsRoot = process.env.ORKAS_WS_ROOT
    || (process.env.ORKAS_PC_DIR ? path.join(process.env.ORKAS_PC_DIR, 'data') : null)
    || path.join(require('os').homedir(), 'Library', 'Application Support', 'Orkas', 'data');
  // Candidate skill dirs — match SkillRegistry's [<uid>/cloud/skills, data/builtin/skills]
  // resolution, plus a dev/source-tree fallback for builtins.
  const skillDirs = [];
  // Custom skills live under data/<uid>/cloud/skills/<id>/. We don't know the
  // active uid here, so scan every uid dir we can find. In practice there's
  // one active user so this is a 1-element scan.
  try {
    for (const entry of fs.readdirSync(wsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      skillDirs.push(path.join(wsRoot, entry.name, 'cloud', 'skills', skillId));
    }
  } catch { /* no data dir yet */ }
  skillDirs.push(path.join(wsRoot, 'builtin', 'skills', skillId));
  if (process.env.ORKAS_PC_DIR) {
    skillDirs.push(path.join(process.env.ORKAS_PC_DIR, 'src', 'builtin', 'skills', skillId));
  }
  const candidates = [];
  for (const dir of skillDirs) {
    for (const ext of SCRIPT_EXTS) {
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
  die(66, `skill script not found: ${skillId}/${scriptBase}.{${SCRIPT_EXTS.join(',')}}`, {
    searched: candidates,
    hint: 'check skill id and script name; ORKAS_PC_DIR / ORKAS_WS_ROOT env',
  });
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
    if (isWin) {
      const tryPy = trySpawn('py', ['-3', scriptPath, ...scriptArgs], skillDir, skillId);
      if (tryPy.spawned) return; // spawned() means we already wired it up + will exit
      cmd = 'python';
    } else {
      cmd = 'python3';
    }
  } else if (ext === 'sh') {
    cmd = isWin ? 'bash' : 'bash';   // Git Bash / WSL on Windows
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
    });
  } catch (e) {
    if (fatalOnEnoent) die(76, `failed to spawn ${cmd}: ${e && e.message}`);
    return { spawned: false };
  }
  child.on('error', (e) => {
    if (e && e.code === 'ENOENT' && !fatalOnEnoent) return; // caller will retry
    die(76, `failed to spawn ${cmd}: ${e && e.message}`, { cmd, argv });
  });
  child.on('exit', (code, signal) => {
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
  const pcNodeModules = path.join(process.env.ORKAS_PC_DIR, 'node_modules');
  process.env.NODE_PATH = process.env.NODE_PATH
    ? `${pcNodeModules}${path.delimiter}${process.env.NODE_PATH}`
    : pcNodeModules;
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
