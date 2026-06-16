/**
 * External packages — read-side accessor for the `<uid>/local/packages/`
 * domain (verbatim third-party repos; see paths.ts and
 * docs/plans/open-ecosystem-architecture.md §A).
 *
 * Write-side lives in `bin/orkas-pkg.cjs` (the bash-driven installer CLI,
 * standalone CJS like run-skill.cjs). The contract between the two is the
 * `_registry.json` schema below. Main-process code must treat the whole
 * packages tree as read-only: never normalize package contents, never
 * reconcile, never write the registry from here. The installer runs
 * out-of-process, so reads here are always fresh-from-disk (no cache) —
 * registry files are tiny and read at most once per chat turn.
 *
 * Registry schema (v1), `<uid>/local/packages/_registry.json`:
 * ```
 * {
 *   "version": 1,
 *   "packages": [{
 *     "name": "hyperframes",            // dir name under packages/
 *     "repo_url": "https://github.com/...",
 *     "commit": "<sha>",
 *     "kind": "skill" | "cli" | "both",
 *     "skill_roots": [".", "skills"],   // rel dirs whose children (or self) hold SKILL.md
 *     "bin_entries": [{"name": "hyperframes", "target": "bin/cli.js", "runtime": "node"}],
 *     "deps_consent": true,             // D3: user approved dependency installs for this package
 *     "enabled": true,
 *     "installed_at": "<iso>", "updated_at": "<iso>"
 *   }]
 * }
 * ```
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { userPackagesDir, userPackageDir, userPackagesRegistryFile, userPackagesBinDir, PC_ROOT } from '../paths';
import { createLogger } from '../logger';
import { companionSkillFileExists } from './package_skills';

const log = createLogger('packages');

export interface PackageBinEntry {
  name: string;
  target: string;
  runtime: 'node' | 'python' | 'sh';
}

export interface PackageEntry {
  name: string;
  repo_url?: string;
  commit?: string;
  kind: 'skill' | 'cli' | 'both';
  skill_roots: string[];
  bin_entries: PackageBinEntry[];
  deps_consent?: boolean;
  enabled: boolean;
  installed_at?: string;
  updated_at?: string;
}

export interface PackagesRegistry {
  version: number;
  packages: PackageEntry[];
}

function emptyRegistry(): PackagesRegistry {
  return { version: 1, packages: [] };
}

/** A package name is a single safe path segment (it becomes a dir name). */
function isSafePackageName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

function sanitiseEntry(raw: unknown): PackageEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (!isSafePackageName(e.name)) return null;
  const kind = e.kind === 'skill' || e.kind === 'cli' || e.kind === 'both' ? e.kind : null;
  if (!kind) return null;
  const skillRoots = Array.isArray(e.skill_roots)
    ? e.skill_roots.filter((r): r is string =>
      typeof r === 'string' && !path.isAbsolute(r) && !r.split(/[\\/]/).includes('..'))
    : [];
  const binEntries: PackageBinEntry[] = [];
  if (Array.isArray(e.bin_entries)) {
    for (const b of e.bin_entries) {
      if (!b || typeof b !== 'object') continue;
      const { name, target, runtime } = b as Record<string, unknown>;
      if (!isSafePackageName(name)) continue;
      if (typeof target !== 'string' || path.isAbsolute(target) || target.split(/[\\/]/).includes('..')) continue;
      if (runtime !== 'node' && runtime !== 'python' && runtime !== 'sh') continue;
      binEntries.push({ name, target, runtime });
    }
  }
  return {
    name: e.name,
    ...(typeof e.repo_url === 'string' ? { repo_url: e.repo_url } : {}),
    ...(typeof e.commit === 'string' ? { commit: e.commit } : {}),
    kind,
    skill_roots: skillRoots,
    bin_entries: binEntries,
    ...(typeof e.deps_consent === 'boolean' ? { deps_consent: e.deps_consent } : {}),
    enabled: e.enabled !== false,
    ...(typeof e.installed_at === 'string' ? { installed_at: e.installed_at } : {}),
    ...(typeof e.updated_at === 'string' ? { updated_at: e.updated_at } : {}),
  };
}

/** Read + sanitise the packages registry. Missing / corrupt → empty. */
export function readPackagesRegistry(uid: string): PackagesRegistry {
  const p = userPackagesRegistryFile(uid);
  try {
    if (!fs.existsSync(p)) return emptyRegistry();
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.packages)) return emptyRegistry();
    const packages = (parsed.packages as unknown[]).map(sanitiseEntry).filter((e): e is PackageEntry => !!e);
    return { version: 1, packages };
  } catch (err) {
    log.warn(`registry read failed, treating as empty: ${(err as Error).message}`);
    return emptyRegistry();
  }
}

/**
 * Absolute SkillLoader roots contributed by enabled packages. A
 * `skill_roots` entry of `"."` means the package dir itself is the skill
 * dir (top-level SKILL.md) — the loader root is then the packages dir, so
 * the loader's `<root>/<id>/SKILL.md` shape resolves with id = package
 * name. Other entries (e.g. `"skills"`) map to `<pkg>/<rel>` roots whose
 * children are skill dirs. De-duplicated, existing dirs only.
 */
export function packageSkillRoots(uid: string, opts: { includeDisabled?: boolean } = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const packagesRoot = userPackagesDir(uid);
  for (const pkg of readPackagesRegistry(uid).packages) {
    if (!opts.includeDisabled && !pkg.enabled) continue;
    for (const rel of pkg.skill_roots) {
      const abs = rel === '.' ? packagesRoot : path.join(userPackageDir(uid, pkg.name), rel);
      const resolved = path.resolve(abs);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      try {
        if (fs.statSync(resolved).isDirectory()) out.push(resolved);
      } catch { /* not materialized yet */ }
    }
  }
  return out;
}

export function enabledPackageSkillRoots(uid: string): string[] {
  return packageSkillRoots(uid);
}

/**
 * One-line environment summary for the commander's `### Environment`
 * runtime block: which external-package CLIs are callable in bash. Kept
 * to installed facts the model cannot discover otherwise — runtime
 * version probing (node/python) is deliberately out (spawn cost per
 * prompt build for information `bash --version` can fetch on demand).
 *
 * Packages that have an auto-authored companion usage skill are skipped:
 * the skill (inlined into `## Available skills`) already documents those
 * binaries, so re-listing the bare names here would be duplicate prompt
 * weight and churn the cache prefix twice.
 */
export function buildEnvSummaryLine(uid: string): string {
  try {
    const names: string[] = [];
    for (const pkg of readPackagesRegistry(uid).packages) {
      if (!pkg.enabled) continue;
      if (companionSkillFileExists(uid, pkg.name)) continue;
      for (const b of pkg.bin_entries) names.push(b.name);
    }
    if (!names.length) return 'No external package CLIs installed.';
    names.sort((a, b) => a.localeCompare(b));
    return `Installed package CLIs (callable directly in \`bash\`): ${names.map((n) => `\`${n}\``).join(', ')}.`;
  } catch {
    return 'No external package CLIs installed.';
  }
}

/**
 * Run an orkas-pkg.cjs subcommand from the main process (UI-initiated
 * enable/disable/update/remove). The CLI is the SINGLE writer of
 * `_registry.json` (CLAUDE.md invariant) — the UI must never edit the
 * registry directly, so management actions funnel through here. Install is
 * intentionally NOT exposed to the UI: it needs the clone + dependency
 * consent flow, which stays on the commander/CLI path.
 */
const PKG_MANAGE_COMMANDS = new Set(['enable', 'disable', 'update', 'remove']);

export interface PackageActionResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

export function runPackageCommand(uid: string, command: string, name: string): Promise<PackageActionResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const safeCommand = typeof command === 'string' ? command : typeof command;
    let settled = false;
    const finish = (result: PackageActionResult) => {
      if (settled) return;
      settled = true;
      const fields = {
        command: safeCommand,
        package_name: name,
        result: result.ok ? 'success' : 'failure',
        duration_ms: Date.now() - startedAt,
        ...(result.error ? { error_message: result.error } : {}),
      };
      if (result.ok) log.info('package action result', fields);
      else log.warn('package action result', fields);
      resolve(result);
    };
    if (!PKG_MANAGE_COMMANDS.has(command)) {
      log.warn('package action rejected', {
        command: safeCommand,
        reason: 'unsupported_command',
        duration_ms: Date.now() - startedAt,
      });
      resolve({ ok: false, stdout: '', error: `unsupported command: ${command}` });
      return;
    }
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      log.warn('package action rejected', {
        command: safeCommand,
        reason: 'invalid_package_name',
        duration_ms: Date.now() - startedAt,
      });
      resolve({ ok: false, stdout: '', error: 'invalid package name' });
      return;
    }
    log.info('package action start', { command, package_name: name });
    // app may be undefined under vitest — same asar.unpacked handling as
    // client.ts::buildSkillSandboxEnv.
    let pcDir = PC_ROOT;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const { app } = require('electron') as typeof import('electron');
      if (app && app.isPackaged) pcDir = PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked');
    } catch { /* not in electron (tests) */ }
    const node = process.execPath;
    const script = path.join(pcDir, 'bin', 'orkas-pkg.cjs');
    const child = spawn(node, [script, command, name], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_UID: uid },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => finish({ ok: false, stdout, error: err.message }));
    child.on('close', (code) => {
      if (code === 0) { finish({ ok: true, stdout }); return; }
      let error = stderr.trim();
      try { const j = JSON.parse(error.slice(error.indexOf('{'))); if (j && j.error) error = j.error; } catch { /* keep raw */ }
      finish({ ok: false, stdout, error: error || `orkas-pkg exited ${code}` });
    });
  });
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function countPackageSkills(uid: string, pkg: PackageEntry): number {
  const pkgDir = userPackageDir(uid, pkg.name);
  const seen = new Set<string>();
  for (const rel of pkg.skill_roots) {
    if (rel === '.') {
      const skillDir = path.resolve(pkgDir);
      if (isFile(path.join(skillDir, 'SKILL.md'))) seen.add(skillDir);
      continue;
    }
    const root = path.join(pkgDir, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.resolve(root, entry.name);
      if (isFile(path.join(skillDir, 'SKILL.md'))) seen.add(skillDir);
    }
  }
  return seen.size;
}

/** Package rows for the management UI. */
export interface PackageUiRow {
  name: string;
  kind: 'skill' | 'cli' | 'both';
  enabled: boolean;
  repo_url?: string;
  commit?: string;
  skill_count: number;
  bin_names: string[];
  updated_at?: string;
}

export function listPackagesForUi(uid: string): PackageUiRow[] {
  return readPackagesRegistry(uid).packages.map((p) => ({
    name: p.name,
    kind: p.kind,
    enabled: p.enabled !== false,
    ...(p.repo_url ? { repo_url: p.repo_url } : {}),
    ...(p.commit ? { commit: p.commit.slice(0, 12) } : {}),
    skill_count: countPackageSkills(uid, p),
    bin_names: p.bin_entries.map((b) => b.name),
    ...(p.updated_at ? { updated_at: p.updated_at } : {}),
  }));
}

/** The shim dir to prepend to the bash tool PATH, or null when no enabled
 *  package ships CLI entries (avoid PATH noise for skill-only installs). */
export function packagesBinDirIfActive(uid: string): string | null {
  const reg = readPackagesRegistry(uid);
  const hasCli = reg.packages.some((p) => p.enabled && p.bin_entries.length > 0);
  if (!hasCli) return null;
  const dir = userPackagesBinDir(uid);
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}
