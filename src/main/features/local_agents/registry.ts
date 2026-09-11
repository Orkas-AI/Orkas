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
import * as fs from 'node:fs';
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
export type LocalCliActiveRunIngress = 'codex-app-server' | 'stream-json' | 'none';
/** Per-Agent override of the external CLI's own permission posture. Missing
 * runtime state maps to `inherit`, so a newly created Agent follows the CLI's
 * native default instead of Orkas' separate local-operation setting. */
export type LocalCliPermissionPolicy = 'inherit' | 'ask' | 'full_access';

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
  /** Whether this backend may read and update the calling Agent's durable
   * memory. Keep this independent from the wider bridge capability: adding a
   * bridge transport must not implicitly opt a backend into Agent memory. */
  agentMemory: boolean;
  /** Transport contract for accepting another user message before the current
   * native CLI process/turn finishes. This is a framework capability, not a
   * model allowlist. */
  activeRunIngress: LocalCliActiveRunIngress;
  /** Policies the adapter can apply without rewriting global CLI config. */
  permissionPolicies: readonly LocalCliPermissionPolicy[];
}

/** Canonical CLI inventory and context/session contract. */
export const LOCAL_CLI_CAPABILITIES = {
  claude: {
    resume: 'native',
    instructionChannel: 'native',
    durableInstructionScope: 'invocation',
    codingProjectDirectory: true,
    orkasBridge: true,
    agentMemory: true,
    activeRunIngress: 'stream-json',
    permissionPolicies: ['inherit', 'ask', 'full_access'],
  },
  codex: {
    resume: 'native',
    instructionChannel: 'native',
    durableInstructionScope: 'session',
    codingProjectDirectory: true,
    orkasBridge: true,
    agentMemory: true,
    activeRunIngress: 'codex-app-server',
    permissionPolicies: ['inherit', 'ask', 'full_access'],
  },
  openclaw: {
    resume: 'session-id',
    instructionChannel: 'user-message',
    durableInstructionScope: 'session',
    codingProjectDirectory: false,
    orkasBridge: false,
    agentMemory: false,
    activeRunIngress: 'none',
    permissionPolicies: ['inherit'],
  },
  opencode: {
    resume: 'native',
    instructionChannel: 'user-message',
    durableInstructionScope: 'session',
    codingProjectDirectory: true,
    orkasBridge: true,
    agentMemory: false,
    activeRunIngress: 'none',
    // OpenCode's one-shot run transport has no interactive approval return
    // channel. Run it in its supported automatic mode and do not expose a
    // selector that suggests Orkas can pause and answer a native prompt.
    permissionPolicies: ['full_access'],
  },
  hermes: {
    resume: 'none',
    instructionChannel: 'user-message',
    durableInstructionScope: 'invocation',
    codingProjectDirectory: false,
    orkasBridge: false,
    agentMemory: false,
    activeRunIngress: 'none',
    permissionPolicies: ['inherit', 'ask', 'full_access'],
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
  agentMemory: false,
  activeRunIngress: 'none',
  permissionPolicies: ['inherit'] as const,
});

export function localCliCapabilities(cli: string | undefined): Readonly<LocalCliCapabilities> {
  if (cli && Object.prototype.hasOwnProperty.call(LOCAL_CLI_CAPABILITIES, cli)) {
    return LOCAL_CLI_CAPABILITIES[cli as LocalCliType];
  }
  return UNKNOWN_CLI_CAPABILITIES;
}

export function localCliSupportsAgentMemory(cli: string | undefined): boolean {
  return localCliCapabilities(cli).agentMemory;
}

export function localCliPermissionPolicies(
  cli: string | undefined,
): readonly LocalCliPermissionPolicy[] {
  return localCliCapabilities(cli).permissionPolicies;
}

/** Effective policy when an Agent has no persisted override. Most CLIs
 * inherit their own defaults; a fixed-policy adapter publishes its sole
 * supported policy instead. */
export function localCliDefaultPermissionPolicy(
  cli: string | undefined,
): LocalCliPermissionPolicy {
  const policies = localCliPermissionPolicies(cli);
  return policies.includes('inherit') ? 'inherit' : policies[0] || 'inherit';
}

export function localCliSupportsPermissionPolicy(
  cli: string | undefined,
  policy: unknown,
): policy is LocalCliPermissionPolicy {
  return typeof policy === 'string'
    && localCliPermissionPolicies(cli).includes(policy as LocalCliPermissionPolicy);
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
  try { dir = path.dirname(await fs.promises.realpath(binPath)); }
  catch { dir = path.dirname(binPath); }

  for (let i = 0; i < 6; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'));
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
  /** Full reported semantic version when it carries a prerelease suffix. */
  fullVersion?: string;
  prerelease?: true;
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

type CachedCliEntry = {
  entry: LocalCliEntry;
  path: string | null;
  mtimeMs?: number;
  size?: number;
};

/** One cache and one in-flight probe per CLI. Startup warmup, UI discovery,
 * runtime options and dispatch all converge here, so a foreground call can
 * join an idle probe instead of launching a second `--version` child. */
const entryCache = new Map<LocalCliType, CachedCliEntry>();
const probeInFlight = new Map<LocalCliType, Promise<LocalCliEntry>>();
const cacheGeneration = new Map<LocalCliType, number>();
let detectAllInFlight: Promise<LocalCliEntry[]> | null = null;

/** The most recent validated inventory for each CLI. Pools are source-neutral:
 * PATH, standalone installs and bundled app binaries are ranked together.
 * Runtime health is keyed by exact binary identity, so upgrades automatically
 * get a fresh chance without clearing unrelated candidates. */
const candidatePools = new Map<LocalCliType, LocalCliEntry[]>();
const lastKnownGoodKeys = new Map<LocalCliType, string>();
const unhealthyCandidateKeys = new Set<string>();

function candidateKey(entry: Pick<LocalCliEntry, 'type' | 'path' | 'version' | 'fullVersion'>): string {
  return `${entry.type}\u0000${entry.path || ''}\u0000${entry.fullVersion || entry.version || ''}`;
}

function orderCandidates(type: LocalCliType, entries: LocalCliEntry[]): LocalCliEntry[] {
  const ranked = [...entries].sort((a, b) => {
    // A validated stable build is preferred over a numerically newer alpha or
    // beta. Installation source is deliberately not part of the ranking.
    if (!!a.prerelease !== !!b.prerelease) return a.prerelease ? 1 : -1;
    const aa = a.version ? parseSemver(a.version) : null;
    const bb = b.version ? parseSemver(b.version) : null;
    return aa && bb ? compareSemver(bb, aa) : 0;
  });
  const healthy = ranked.filter(entry => !unhealthyCandidateKeys.has(candidateKey(entry)));
  const selectable = healthy.length ? healthy : ranked;
  const lastGoodKey = lastKnownGoodKeys.get(type) || '';
  const lastGoodIndex = selectable.findIndex(entry => candidateKey(entry) === lastGoodKey);
  if (lastGoodIndex > 0) selectable.unshift(...selectable.splice(lastGoodIndex, 1));
  return selectable;
}

/** Return a previously probed fallback without running another version scan. */
export function cachedCliFallbackCandidate(current: LocalCliEntry): LocalCliEntry | null {
  const currentKey = candidateKey(current);
  return orderCandidates(current.type, candidatePools.get(current.type) || [])
    .find(entry => candidateKey(entry) !== currentKey
      && !unhealthyCandidateKeys.has(candidateKey(entry))) || null;
}

/** Runtime health only affects this exact binary version for this app process. */
export function noteCliCandidateFailure(entry: LocalCliEntry): void {
  const key = candidateKey(entry);
  if (!entry.path || !entry.version) return;
  unhealthyCandidateKeys.add(key);
  if (lastKnownGoodKeys.get(entry.type) === key) lastKnownGoodKeys.delete(entry.type);
  if (entryCache.get(entry.type)?.entry
      && candidateKey(entryCache.get(entry.type)!.entry) === key) {
    entryCache.delete(entry.type);
  }
}

export function noteCliCandidateSuccess(entry: LocalCliEntry): void {
  const key = candidateKey(entry);
  if (!entry.path || !entry.version) return;
  unhealthyCandidateKeys.delete(key);
  lastKnownGoodKeys.set(entry.type, key);
  try {
    const stat = fs.statSync(entry.path);
    entryCache.set(entry.type, {
      entry,
      path: entry.path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  } catch { /* successful process already proves the candidate; next call re-probes if it vanished */ }
}

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
  const resolved = envPath
    ? await whichBin(candidate, { extraDirs })
    : (await whichBins(candidate, { extraDirs }))[0] ?? null;

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
  // Keep an aggregate promise for callers that need every result, while the
  // actual ownership stays per CLI. A dispatch can therefore join only its
  // selected CLI without waiting for the slowest member of this batch.
  if (detectAllInFlight) return detectAllInFlight;
  const detection = Promise.all(LOCAL_CLI_TYPES.map(type => resolveCli(type, {
    force: opts.force === true,
  })));
  detectAllInFlight = detection;
  try {
    const entries = await detection;
    log.info('detected local CLIs', {
      available: entries.filter(e => e.available).map(e => e.type),
      missing: entries.filter(e => !e.available).map(e => e.type),
    });
    return entries;
  } finally {
    if (detectAllInFlight === detection) detectAllInFlight = null;
  }
}

function generationFor(type: LocalCliType): number {
  return cacheGeneration.get(type) || 0;
}

async function writeEntryCache(type: LocalCliType, entry: LocalCliEntry): Promise<void> {
  if (!entry.path || !entry.available || entry.validation === 'pending') {
    entryCache.set(type, { entry, path: entry.path });
    return;
  }
  try {
    const stat = await fs.promises.stat(entry.path);
    entryCache.set(type, {
      entry,
      path: entry.path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  } catch {
    // A raced uninstall is handled by the dispatch identity check/spawn. Keep
    // the probed result rather than manufacturing a different error here.
    entryCache.set(type, { entry, path: entry.path });
  }
}

/** Cached, de-duplicated single-CLI resolution used by UI and startup warmup. */
export async function resolveCli(
  type: LocalCliType,
  opts: { force?: boolean } = {},
): Promise<LocalCliEntry> {
  const active = probeInFlight.get(type);
  if (active) return active;
  if (opts.force) invalidateCache(type);
  const cached = entryCache.get(type);
  if (cached) return cached.entry;

  const generation = generationFor(type);
  const probe = detectOne(type).then(async (entry) => {
    if (generationFor(type) === generation) await writeEntryCache(type, entry);
    return entry;
  }).finally(() => {
    if (probeInFlight.get(type) === probe) probeInFlight.delete(type);
  });
  probeInFlight.set(type, probe);
  return probe;
}

/** Dispatch resolution reuses the shared probe only while the selected
 * binary identity is unchanged. Unavailable entries are retried on explicit
 * use so installing a CLI after startup does not require an app restart. */
export async function resolveCliForDispatch(type: LocalCliType): Promise<LocalCliEntry> {
  const active = probeInFlight.get(type);
  if (active) return active;
  const cached = entryCache.get(type);
  if (cached?.entry.available && cached.path && cached.mtimeMs !== undefined && cached.size !== undefined) {
    try {
      const stat = await fs.promises.stat(cached.path);
      if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) return cached.entry;
    } catch { /* binary moved or removed — re-probe below */ }
  }
  invalidateCache(type);
  return resolveCli(type);
}

/** Startup-only idle warmup. Path discovery is process-free; installed CLIs
 * are then probed one type at a time so the idle task does not create a burst
 * of child processes. A foreground resolver can join the current type or
 * start another type immediately without waiting for this loop. */
export async function warmLocalClis(signal?: AbortSignal): Promise<LocalCliEntry[]> {
  const installed = await findAllInstalled();
  const results: LocalCliEntry[] = [];
  for (const presence of installed) {
    if (signal?.aborted) break;
    if (!presence.available) {
      if (!entryCache.has(presence.type)) await writeEntryCache(presence.type, presence);
      results.push(entryCache.get(presence.type)?.entry || presence);
      continue;
    }
    results.push(await resolveCli(presence.type));
  }
  log.info('local CLI idle warmup finished', {
    checked: results.map(entry => entry.type),
    available: results.filter(entry => entry.available).map(entry => entry.type),
    aborted: signal?.aborted === true,
  });
  return results;
}

/**
 * Detect a single CLI. Skips the cache by design — callers that need
 * cache should go through resolveCli or detectAll.
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
  // Automatic discovery probes every installation for every CLI. This keeps
  // source-neutral fallback available to all adapters, while an explicit
  // ORKAS_<TYPE>_PATH remains authoritative and never silently switches.
  if (!envPath) {
    return detectPreferredCandidates(
      type,
      await whichBins(candidate, { extraDirs }),
      versionProbeTimeoutMs,
    );
  }
  candidatePools.set(type, []);
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
  const versionMeta = versionResult?.status === 'success' && versionResult.prerelease
    ? { fullVersion: versionResult.fullVersion, prerelease: true as const }
    : {};
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
      type, path: resolved, version, ...versionMeta, available: false,
      error: 'version_too_old',
      errorDetail: minErr,
    };
  }
  return { type, path: resolved, version, ...versionMeta, available: true };
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

async function detectPreferredCandidates(
  type: LocalCliType,
  candidates: string[],
  timeoutMs = VERSION_PROBE_TIMEOUT_MS,
): Promise<LocalCliEntry> {
  if (!candidates.length) {
    candidatePools.set(type, []);
    return {
      type, path: null, version: null, available: false,
      error: 'not_found',
      errorDetail: `${BIN_NAMES[type]} not found on PATH or standard CLI install locations`,
    };
  }

  const detected = await Promise.all(candidates.map(async (candidate) => ({
    path: candidate,
    result: await detectPreferredVersionResult(
      candidate,
      VERSION_PROBES[type],
      detectVersionResult,
      timeoutMs,
    ),
  })));
  const valid: Array<{ entry: LocalCliEntry; semver: Semver }> = [];
  for (const entry of detected) {
    const semver = entry.result.version ? parseSemver(entry.result.version) : null;
    if (entry.result.version && semver) {
      valid.push({
        entry: {
          type,
          path: entry.path,
          version: entry.result.version,
          ...(entry.result.status === 'success' && entry.result.prerelease
            ? { fullVersion: entry.result.fullVersion, prerelease: true as const }
            : {}),
          available: true,
        },
        semver,
      });
    }
  }

  if (!valid.length) {
    candidatePools.set(type, []);
    const timedOut = detected.every(entry => entry.result.status === 'timeout');
    return {
      type, path: candidates[0], version: null, available: false,
      error: timedOut ? 'version_timeout' : 'version_unknown',
      errorDetail: timedOut
        ? `${type} version probe timed out for ${candidates.length} installation(s)`
        : `${type} version could not be identified from ${candidates.length} installation(s)`,
    };
  }

  // Keep only versions that satisfy the protocol floor in the fallback pool.
  // If none do, report the newest recognized candidate with the old error
  // shape so callers still explain the actual installation problem.
  const compatible = valid
    .filter(candidate => !checkMinVersion(type, candidate.entry.version))
    .map(candidate => candidate.entry);
  const pool = orderCandidates(type, compatible);
  candidatePools.set(type, pool);
  if (pool.length) return pool[0];

  valid.sort((a, b) => compareSemver(b.semver, a.semver));
  const selected = valid[0].entry;
  const minErr = checkMinVersion(type, selected.version);
  if (minErr) {
    return {
      type, path: selected.path, version: selected.version, available: false,
      ...(selected.fullVersion ? { fullVersion: selected.fullVersion, prerelease: true as const } : {}),
      error: 'version_too_old', errorDetail: minErr,
    };
  }
  return selected;
}

/** Clear the cache; mainly for tests and the single-CLI detection IPC path. */
export function invalidateCache(type?: LocalCliType): void {
  const targets = type ? [type] : LOCAL_CLI_TYPES;
  for (const target of targets) {
    entryCache.delete(target);
    candidatePools.delete(target);
    cacheGeneration.set(target, generationFor(target) + 1);
  }
}
