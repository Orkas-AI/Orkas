/**
 * Registry of local CLI coding agents Orkas can spawn.
 *
 * Discovery rules per CLI:
 *   1. ORKAS_<TYPE>_PATH env var, if set → use as-is (still validated).
 *   2. Else `whichBin(defaultBin)` to scan PATH.
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
import { checkMinVersion, detectVersion } from './version.js';

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
  const resolved = await whichBin(candidate);
  if (!resolved) {
    return {
      type, path: null, version: null, available: false,
      error: 'not_found',
      errorDetail: envPath
        ? `${ENV_KEYS[type]}=${envPath} not found on PATH or filesystem`
        : `${BIN_NAMES[type]} not found on PATH`,
    };
  }
  const version = await detectVersion(resolved);
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
