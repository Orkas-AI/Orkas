/**
 * Registry of local CLI coding agents Orkas can spawn.
 *
 * Discovery rules per CLI:
 *   1. ORKAS_<TYPE>_PATH env var, if set → use as-is (still validated).
 *   2. Else `whichBin(defaultBin)` scans PATH plus standard GUI-app
 *      fallback dirs (`~/.local/bin`, Homebrew locations, etc.).
 *   3. If found, run the CLI's documented version probe and `checkMinVersion`.
 *
 * The External-agent create panel uses `findAllInstalled` before this full
 * validation pass. That path-only pass never spawns a CLI process, so the
 * picker can show installed candidates immediately while version validation
 * continues independently for each CLI in the background.
 *
 * Results are cached for the lifetime of the main process. Pass
 * `{ force: true }` to refresh the cache (the External-agent create panel
 * does this on every entry, and runner.ts does it before execution so a
 * recently-deleted binary doesn't slip through).
 *
 * `LOCAL_CLI_CAPABILITIES` is the canonical backend inventory everywhere
 * (spec.runtime.cli, IPC payloads, context materialization, persist
 * meta.json). Adding a backend requires declaring its conversation semantics
 * here before discovery or dispatch can use it.
 */

import { createLogger } from '../../logger.js';
import { whichBin, whichBins } from './which.js';
import {
  checkMinVersion,
  compareSemver,
  detectVersion,
  detectVersionResult,
  parseSemver,
  type Semver,
  type VersionProbeResult,
} from './version.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const log = createLogger('local-agents');

/** How a backend continues a conversation across one-shot CLI processes.
 * `native` means the CLI exposes an explicit resume operation/flag;
 * `session-id` means reusing the same deterministic id is the continuation
 * contract; `none` means the host must bridge visible history into a fresh
 * session instead of suppressing it behind an unusable stored handle. */
export type LocalCliResumeStrategy = 'native' | 'session-id' | 'none';

export type LocalCliInstructionChannel = 'native' | 'user-message';
export type LocalCliDurableInstructionScope = 'invocation' | 'session';

export interface LocalCliCapabilities {
  resume: LocalCliResumeStrategy;
  /** Native means the backend exposes a system/developer instruction field.
   * User-message backends receive the durable bootstrap in their first turn. */
  instructionChannel: LocalCliInstructionChannel;
  /** Whether unchanged durable instructions survive a new CLI process that
   * resumes the same session. Claude append-system-prompt is invocation-scoped;
   * Codex developer instructions and user-message bootstraps live in-session. */
  durableInstructionScope: LocalCliDurableInstructionScope;
  /** Whether Orkas should route the process through its project-directory
   * picker/XML protocol instead of the generic user workspace. */
  codingProjectDirectory: boolean;
  /** Whether the runner can attach the per-run Orkas MCP bridge. */
  orkasBridge: boolean;
}

/** Canonical CLI inventory and context/session contract. */
export const LOCAL_CLI_CAPABILITIES = {
  claude: {
    resume: 'native',
    instructionChannel: 'native',
    durableInstructionScope: 'invocation',
    codingProjectDirectory: true,
    orkasBridge: true,
  },
  codex: {
    resume: 'native',
    instructionChannel: 'native',
    durableInstructionScope: 'session',
    codingProjectDirectory: true,
    orkasBridge: true,
  },
  openclaw: {
    resume: 'session-id',
    instructionChannel: 'user-message',
    durableInstructionScope: 'session',
    codingProjectDirectory: false,
    orkasBridge: false,
  },
  opencode: {
    resume: 'native',
    instructionChannel: 'user-message',
    durableInstructionScope: 'session',
    codingProjectDirectory: false,
    orkasBridge: false,
  },
  hermes: {
    resume: 'none',
    instructionChannel: 'user-message',
    durableInstructionScope: 'invocation',
    codingProjectDirectory: false,
    orkasBridge: false,
  },
} as const satisfies Record<string, LocalCliCapabilities>;

export type LocalCliType = keyof typeof LOCAL_CLI_CAPABILITIES;

/** Canonical CLI type names, derived from the capability inventory. */
export const LOCAL_CLI_TYPES = Object.freeze(
  Object.keys(LOCAL_CLI_CAPABILITIES) as LocalCliType[],
);

const UNKNOWN_CLI_CAPABILITIES: Readonly<LocalCliCapabilities> = Object.freeze({
  resume: 'none',
  instructionChannel: 'user-message',
  durableInstructionScope: 'invocation',
  codingProjectDirectory: false,
  orkasBridge: false,
});

export function localCliCapabilities(cli: string | undefined): Readonly<LocalCliCapabilities> {
  if (cli && Object.prototype.hasOwnProperty.call(LOCAL_CLI_CAPABILITIES, cli)) {
    return LOCAL_CLI_CAPABILITIES[cli as LocalCliType];
  }
  return UNKNOWN_CLI_CAPABILITIES;
}

export function localCliResumeStrategy(cli: string | undefined): LocalCliResumeStrategy {
  return localCliCapabilities(cli).resume;
}

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

/** Documented version probes for each CLI, in compatibility order. */
const VERSION_PROBES: Record<LocalCliType, readonly (readonly string[])[]> = {
  claude: [['--version']],
  codex: [['--version']],
  openclaw: [['--version']],
  opencode: [['--version']],
  // Hermes documents both forms across releases. Prefer the stable
  // subcommand, then tolerate installations that expose only the flag.
  hermes: [['version'], ['--version']],
};

// Version commands are normally quick, but bundled CLIs can take several
// seconds on their first cold start (for example while macOS verifies the
// executable). Keep enough headroom to avoid misclassifying an installed CLI
// as version_timeout while still bounding stale or hung executables.
export const VERSION_PROBE_TIMEOUT_MS = 15_000;

export function localCliSearchDirs(
  type: LocalCliType,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string[] {
  const dirs: string[] = [];
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || (home ? path.win32.join(home, 'AppData', 'Local') : '');
    const appData = env.APPDATA || (home ? path.win32.join(home, 'AppData', 'Roaming') : '');
    if (appData) dirs.push(path.win32.join(appData, 'npm'));
    if (localAppData) {
      dirs.push(path.win32.join(localAppData, 'Microsoft', 'WindowsApps'));
      dirs.push(path.win32.join(localAppData, 'pnpm'));
    }
    if (home) dirs.push(path.win32.join(home, '.local', 'bin'));
    if (env.VOLTA_HOME) dirs.push(path.win32.join(env.VOLTA_HOME, 'bin'));
    if (env.PNPM_HOME) dirs.push(env.PNPM_HOME);
    if (env.NVM_SYMLINK) dirs.push(env.NVM_SYMLINK);
    if (type === 'codex' && localAppData) {
      dirs.push(path.win32.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'));
    }
    return dirs;
  }
  if (home) {
    // macOS GUI apps do not source ~/.zprofile, but Codex standalone
    // installs its visible command here by default. npm's commonly
    // recommended user prefix is also absent from Finder-launched apps.
    dirs.push(pathApi.join(home, '.local', 'bin'));
    dirs.push(pathApi.join(home, '.npm-global', 'bin'));
    dirs.push(pathApi.join(home, 'bin'));
  }
  if (env.NPM_CONFIG_PREFIX) dirs.push(pathApi.join(env.NPM_CONFIG_PREFIX, 'bin'));
  if (env.VOLTA_HOME) dirs.push(pathApi.join(env.VOLTA_HOME, 'bin'));
  if (env.PNPM_HOME) dirs.push(env.PNPM_HOME);
  dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  if (type === 'codex' && platform === 'darwin') {
    dirs.push('/Applications/Codex.app/Contents/Resources');
    dirs.push('/Applications/ChatGPT.app/Contents/Resources');
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
  /** Parsed `MAJOR.MINOR.PATCH` from the CLI's version probe, or null. */
  version: string | null;
  /** True when selectable. For normal results the version check passed;
   * path-only `validation:'pending'` results are provisionally selectable. */
  available: boolean;
  /** Present only for path-only discovery results shown before validation. */
  validation?: 'pending';
  /**
   * Populated when `available === false` to explain why:
   * "not_found" (no PATH match), "version_too_old" (below MIN_VERSIONS),
   * "version_timeout" (binary exists but its version probe exceeded the
   * deadline), or "version_unknown" (the probe completed without a parsable
   * version).
   */
  error?: 'not_found' | 'version_too_old' | 'version_timeout' | 'version_unknown';
  /** Human-readable detail when error is set; safe to show in UI. */
  errorDetail?: string;
};

export interface DetectLocalCliOptions {
  /** Override automatic fallback directories while preserving PATH lookup.
   * Primarily useful for deterministic probes that must not discover another
   * GUI application's bundled CLI from the host machine. */
  searchDirs?: readonly string[];
  /** Override the production probe deadline for deterministic tests. */
  versionProbeTimeoutMs?: number;
}

let cache: LocalCliEntry[] | null = null;
let detectionInFlight: Promise<LocalCliEntry[]> | null = null;
let cacheGeneration = 0;

/**
 * Find installed CLI executables without running them. This is intentionally
 * uncached: every entry into the External-agent create panel gets a fresh,
 * low-cost filesystem view before the slower version probes begin.
 *
 * A path hit is provisionally `available` so the renderer can show and select
 * it immediately. Callers must replace these `validation:'pending'` entries
 * with `detectOne` or `detectAll` results before treating version
 * compatibility as known.
 */
export async function findAllInstalled(): Promise<LocalCliEntry[]> {
  return Promise.all(LOCAL_CLI_TYPES.map(type => findInstalled(type)));
}

async function findInstalled(type: LocalCliType): Promise<LocalCliEntry> {
  const envPath = process.env[ENV_KEYS[type]]?.trim();
  const candidate = envPath && envPath.length > 0 ? envPath : BIN_NAMES[type];
  const extraDirs = envPath ? [] : localCliSearchDirs(type);
  const resolved = type === 'codex' && !envPath
    ? (await whichBins(candidate, { extraDirs }))[0] ?? null
    : await whichBin(candidate, { extraDirs });

  if (!resolved) {
    return {
      type,
      path: null,
      version: null,
      available: false,
      validation: 'pending',
      error: 'not_found',
      errorDetail: envPath
        ? `${ENV_KEYS[type]}=${envPath} not found on PATH or filesystem`
        : `${BIN_NAMES[type]} not found on PATH or standard CLI install locations`,
    };
  }
  return {
    type,
    path: resolved,
    version: null,
    available: true,
    validation: 'pending',
  };
}

/**
 * Detect all known CLIs (parallel). Returns one entry per type, including
 * unavailable ones — UI filters to `available === true` for the picker.
 */
export async function detectAll(opts: { force?: boolean } = {}): Promise<LocalCliEntry[]> {
  if (!opts.force && cache) return cache;
  // The create modal and an Agent detail can request discovery at nearly the
  // same time. Share the process-heavy pass even when one caller explicitly
  // requested a refresh; a second identical set of version children cannot
  // produce a fresher answer while the first set is still running.
  if (detectionInFlight) return detectionInFlight;
  const generation = cacheGeneration;
  const detection = Promise.all(LOCAL_CLI_TYPES.map(t => detectOne(t)));
  detectionInFlight = detection;
  try {
    const entries = await detection;
    // `localAgents.detect` can invalidate the aggregate cache while this pass
    // is still running. Do not let the older pass repopulate it afterward.
    if (generation === cacheGeneration) {
      cache = entries;
    }
    log.info('detected local CLIs', {
      available: entries.filter(e => e.available).map(e => e.type),
      missing: entries.filter(e => !e.available).map(e => e.type),
    });
    return entries;
  } finally {
    if (detectionInFlight === detection) detectionInFlight = null;
  }
}

/**
 * Detect a single CLI. Skips the cache by design — callers that need
 * cache should go through detectAll.
 */
export async function detectOne(
  type: LocalCliType,
  opts: DetectLocalCliOptions = {},
): Promise<LocalCliEntry> {
  const envPath = process.env[ENV_KEYS[type]]?.trim();
  const candidate = envPath && envPath.length > 0 ? envPath : BIN_NAMES[type];
  const extraDirs = envPath
    ? []
    : (opts.searchDirs ? [...opts.searchDirs] : localCliSearchDirs(type));
  const versionProbeTimeoutMs = Number.isFinite(opts.versionProbeTimeoutMs)
    && Number(opts.versionProbeTimeoutMs) > 0
    ? Number(opts.versionProbeTimeoutMs)
    : VERSION_PROBE_TIMEOUT_MS;
  // Codex Desktop / ChatGPT and standalone Codex intentionally share
  // ~/.codex state. A stale standalone binary can therefore see cache and
  // model configuration written by a newer bundled binary, then fail before
  // the turn starts. For automatic discovery, probe every Codex candidate and
  // choose the newest valid version. Explicit ORKAS_CODEX_PATH remains an
  // exact user override and is never replaced by another installation.
  if (type === 'codex' && !envPath) {
    return detectNewestCodex(
      await whichBins(candidate, { extraDirs }),
      versionProbeTimeoutMs,
    );
  }
  const resolved = await whichBin(candidate, { extraDirs });
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
  const versionProbes = VERSION_PROBES[type];
  let versionResult: VersionProbeResult | null = null;
  let version = type === 'codex' ? await detectCodexPackageVersion(resolved) : null;
  if (!version) {
    versionResult = await detectPreferredVersionResult(
      resolved,
      versionProbes,
      detectVersionResult,
      versionProbeTimeoutMs,
    );
    version = versionResult.version;
  }
  if (!version) {
    const attempted = versionProbes
      .map(args => `\`${resolved} ${args.join(' ')}\``)
      .join(', ');
    const timedOut = versionResult?.status === 'timeout';
    return {
      type, path: resolved, version: null, available: false,
      error: timedOut ? 'version_timeout' : 'version_unknown',
      errorDetail: timedOut
        ? `${attempted} did not finish within ${versionProbeTimeoutMs}ms`
        : `${attempted} produced no parsable output`,
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

type VersionDetector = (
  binPath: string,
  timeoutMs: number,
  versionArgs: readonly string[],
) => Promise<string | null>;

type DetailedVersionDetector = (
  binPath: string,
  timeoutMs: number,
  versionArgs: readonly string[],
) => Promise<VersionProbeResult>;

/**
 * Run compatible version commands concurrently, then retain declaration order
 * as the preference when more than one succeeds. This matters for Hermes:
 * older installations may expose only `--version`, while unrelated/stale
 * `version` commands can hang until the timeout. Serial fallback doubled the
 * complete registry latency without improving the selected result.
 */
export async function detectPreferredVersion(
  binPath: string,
  probes: readonly (readonly string[])[],
  detector: VersionDetector = detectVersion,
): Promise<string | null> {
  if (!probes.length) return null;
  return new Promise(resolve => {
    const settled = probes.map(() => false);
    const versions = probes.map<string | null>(() => null);
    let finished = false;
    const maybeResolve = () => {
      if (finished) return;
      for (let i = 0; i < probes.length; i += 1) {
        // A higher-priority probe is still pending, so a later success cannot
        // become authoritative yet.
        if (!settled[i]) return;
        if (versions[i]) {
          finished = true;
          resolve(versions[i]);
          return;
        }
      }
      finished = true;
      resolve(null);
    };
    probes.forEach((args, index) => {
      void detector(binPath, VERSION_PROBE_TIMEOUT_MS, args)
        .then(version => {
          settled[index] = true;
          versions[index] = version;
          maybeResolve();
        })
        .catch(() => {
          settled[index] = true;
          versions[index] = null;
          maybeResolve();
        });
    });
  });
}

/**
 * Detailed production counterpart to `detectPreferredVersion`. A multi-probe
 * CLI is classified as timed out only when every compatible probe timed out;
 * any completed-but-invalid probe keeps the more accurate version_unknown
 * classification.
 */
export async function detectPreferredVersionResult(
  binPath: string,
  probes: readonly (readonly string[])[],
  detector: DetailedVersionDetector = detectVersionResult,
  timeoutMs = VERSION_PROBE_TIMEOUT_MS,
): Promise<VersionProbeResult> {
  if (!probes.length) return { status: 'failed', version: null };
  return new Promise(resolve => {
    const settled = probes.map(() => false);
    const results = probes.map<VersionProbeResult | null>(() => null);
    let finished = false;
    const maybeResolve = () => {
      if (finished) return;
      for (let i = 0; i < probes.length; i += 1) {
        if (!settled[i]) return;
        const result = results[i];
        if (result?.status === 'success') {
          finished = true;
          resolve(result);
          return;
        }
      }
      finished = true;
      resolve(results.every(result => result?.status === 'timeout')
        ? { status: 'timeout', version: null }
        : { status: 'failed', version: null });
    };
    probes.forEach((args, index) => {
      void detector(binPath, timeoutMs, args)
        .then(result => {
          settled[index] = true;
          results[index] = result;
          maybeResolve();
        })
        .catch(() => {
          settled[index] = true;
          results[index] = { status: 'failed', version: null };
          maybeResolve();
        });
    });
  });
}

async function detectNewestCodex(
  candidates: string[],
  timeoutMs = VERSION_PROBE_TIMEOUT_MS,
): Promise<LocalCliEntry> {
  if (!candidates.length) {
    return {
      type: 'codex', path: null, version: null, available: false,
      error: 'not_found',
      errorDetail: `${BIN_NAMES.codex} not found on PATH or standard CLI install locations`,
    };
  }

  const detected = await Promise.all(candidates.map(async (candidate) => ({
    path: candidate,
    result: await detectVersionResult(
      candidate,
      timeoutMs,
      VERSION_PROBES.codex[0],
    ),
  })));
  const valid: Array<{ path: string; version: string; semver: Semver }> = [];
  for (const entry of detected) {
    const semver = entry.result.version ? parseSemver(entry.result.version) : null;
    if (entry.result.version && semver) {
      valid.push({ path: entry.path, version: entry.result.version, semver });
    }
  }

  if (!valid.length) {
    const timedOut = detected.every(entry => entry.result.status === 'timeout');
    return {
      type: 'codex', path: candidates[0], version: null, available: false,
      error: timedOut ? 'version_timeout' : 'version_unknown',
      errorDetail: timedOut
        ? `Codex version probe timed out for ${candidates.length} installation(s)`
        : `Codex version could not be identified from ${candidates.length} installation(s)`,
    };
  }

  // Stable sort semantics keep PATH/search order as the tiebreaker when two
  // installations report the same semantic version.
  valid.sort((a, b) => compareSemver(b.semver, a.semver));
  const selected = valid[0];
  const minErr = checkMinVersion('codex', selected.version);
  if (minErr) {
    return {
      type: 'codex', path: selected.path, version: selected.version, available: false,
      error: 'version_too_old', errorDetail: minErr,
    };
  }
  return { type: 'codex', path: selected.path, version: selected.version, available: true };
}

/** Clear the cache; mainly for tests and the single-CLI detection IPC path. */
export function invalidateCache(): void {
  cache = null;
  cacheGeneration += 1;
}
