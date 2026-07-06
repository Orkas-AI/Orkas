/**
 * Registry of local CLI coding agents Orkas can spawn.
 *
 * Discovery rules per CLI:
 *   1. ORKAS_<TYPE>_PATH env var, if set → use as-is (still validated).
 *   2. Else `whichBin(defaultBin)` scans PATH plus standard GUI-app
 *      fallback dirs (`~/.local/bin`, Homebrew locations, etc.).
 *   3. If found, run `<path> --version` and `checkMinVersion`.
 *
 * Results are cached for 60s to keep the create/edit panel snappy
 * across re-renders. Pass `{ force: true }` to bypass the cache (used
 * by execute-time pre-flight check in runner.ts so a recently-deleted
 * binary doesn't slip through).
 *
 * `LocalCliType` is the canonical key everywhere (spec.runtime.cli,
 * IPC payloads, persist meta.json) — keep it in sync with backends/.
 */

import { createLogger } from '../../logger.js';
import { whichBin } from './which.js';
import { checkMinVersion, detectVersion, parseSemver } from './version.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const log = createLogger('local-agents');

/** Canonical CLI type names. New backends add an entry here + in BIN_NAMES + ENV_KEYS. */
export const LOCAL_CLI_TYPES = ['claude', 'codex', 'openclaw', 'opencode', 'hermes'] as const;

export type LocalCliType = (typeof LOCAL_CLI_TYPES)[number];

/** Default executable name on PATH for each CLI. */
const BIN_NAMES: Record<LocalCliType, string> = {
  claude: 'claude',
  codex: 'codex',
  openclaw: 'openclaw',
  opencode: 'opencode',
  hermes: 'hermes',
};

/** Env var to override default binary path per CLI. */
const ENV_KEYS: Record<LocalCliType, string> = {
  claude: 'ORKAS_CLAUDE_PATH',
  codex: 'ORKAS_CODEX_PATH',
  openclaw: 'ORKAS_OPENCLAW_PATH',
  opencode: 'ORKAS_OPENCODE_PATH',
  hermes: 'ORKAS_HERMES_PATH',
};

function defaultSearchDirs(type: LocalCliType): string[] {
  const home = os.homedir();
  const dirs: string[] = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '');
    if (type === 'codex' && localAppData) {
      dirs.push(path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'));
    }
    return dirs;
  }
  if (home) {
    // macOS GUI apps do not source ~/.zprofile, but Codex standalone
    // installs its visible command here by default.
    dirs.push(path.join(home, '.local', 'bin'));
    dirs.push(path.join(home, 'bin'));
  }
  dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  if (type === 'codex' && process.platform === 'darwin') {
    dirs.push('/Applications/Codex.app/Contents/Resources');
  }
  return dirs;
}

async function detectCodexPackageVersion(binPath: string): Promise<string | null> {
  let dir: string;
  try { dir = path.dirname(await fs.realpath(binPath)); }
  catch { dir = path.dirname(binPath); }

  for (let i = 0; i < 6; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      if (pkg?.name === '@openai/codex' && typeof pkg.version === 'string') {
        const sv = parseSemver(pkg.version);
        if (sv) return `${sv.major}.${sv.minor}.${sv.patch}`;
      }
    } catch {
      // Keep walking toward the npm package root.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Detection result for a single CLI. */
export type LocalCliEntry = {
  type: LocalCliType;
  /** Absolute path to the binary, or null when unavailable. */
  path: string | null;
  /** Parsed `MAJOR.MINOR.PATCH` from `--version`, or null. */
  version: string | null;
  /** True only when path resolved AND version check passed. */
  available: boolean;
  /**
   * Populated when `available === false` to explain why:
   * "not_found" (no PATH match), "version_too_old" (below MIN_VERSIONS),
   * or "version_unknown" (binary exists but `--version` returned nothing).
   */
  error?: 'not_found' | 'version_too_old' | 'version_unknown';
  /** Human-readable detail when error is set; safe to show in UI. */
  errorDetail?: string;
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; entries: LocalCliEntry[] } | null = null;

/**
 * Detect all known CLIs (parallel). Returns one entry per type, including
 * unavailable ones — UI filters to `available === true` for the picker.
 */
export async function detectAll(opts: { force?: boolean } = {}): Promise<LocalCliEntry[]> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.entries;
  }
  const entries = await Promise.all(LOCAL_CLI_TYPES.map(t => detectOne(t)));
  cache = { at: Date.now(), entries };
  log.info('detected local CLIs', {
    available: entries.filter(e => e.available).map(e => e.type),
    missing: entries.filter(e => !e.available).map(e => e.type),
  });
  return entries;
}

/**
 * Detect a single CLI. Skips the cache by design — callers that need
 * cache should go through detectAll.
 */
export async function detectOne(type: LocalCliType): Promise<LocalCliEntry> {
  const envPath = process.env[ENV_KEYS[type]]?.trim();
  const candidate = envPath && envPath.length > 0 ? envPath : BIN_NAMES[type];
  const resolved = await whichBin(candidate, {
    extraDirs: envPath ? [] : defaultSearchDirs(type),
  });
  if (!resolved) {
    return {
      type, path: null, version: null, available: false,
      error: 'not_found',
      errorDetail: envPath
        ? `${ENV_KEYS[type]}=${envPath} not found on PATH or filesystem`
        : `${BIN_NAMES[type]} not found on PATH or standard CLI install locations`,
    };
  }
  // The npm @openai/codex wrapper can hang on `--version` in GUI-launched
  // environments. Prefer its package.json version when available; fall back to
  // the normal subprocess probe for standalone/non-npm installs.
  const version = type === 'codex'
    ? (await detectCodexPackageVersion(resolved)) || await detectVersion(resolved)
    : await detectVersion(resolved);
  if (!version) {
    return {
      type, path: resolved, version: null, available: false,
      error: 'version_unknown',
      errorDetail: `\`${resolved} --version\` produced no parsable output`,
    };
  }
  const minErr = checkMinVersion(type, version);
  if (minErr) {
    return {
      type, path: resolved, version, available: false,
      error: 'version_too_old',
      errorDetail: minErr,
    };
  }
  return { type, path: resolved, version, available: true };
}

/** Clear the cache; mainly for tests and the IPC `force: true` path. */
export function invalidateCache(): void {
  cache = null;
}
