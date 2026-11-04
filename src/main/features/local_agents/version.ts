/**
 * Version probe + minimum-version gate for local CLI agents.
 *
 * Two pure functions (parseSemver / checkMinVersion) for unit-testing,
 * and one subprocess call (detectVersion) that runs the caller-provided
 * version command (defaulting to `<bin> --version`)
 * and extracts the first `[v]MAJOR.MINOR.PATCH` token from stdout/stderr.
 *
 * Every registered CLI has a floor tied to the adapter's verified protocol
 * and mandatory dependencies. Optional parameters retain separate boundaries.
 */

import { spawn } from 'node:child_process';
import { killProcessTree } from './backends/base.js';
import { buildCliSpawnEnv, resolveCliCommand } from './spawn-command.js';
import type { LocalCliType } from './registry.js';

/** Oldest supported adapter contracts, not model-release dates. */
export const MIN_VERSIONS: Readonly<Record<LocalCliType, string>> = {
  // claude --output-format stream-json + --print are stable from 2.x.
  claude: '2.0.0',
  // Orkas talks to Codex through the app-server JSON-RPC contract. Keep this
  // floor pinned to the oldest protocol version validated by Orkas; the model
  // catalog in Settings is a separate concern and must not determine CLI
  // compatibility.
  codex: '0.145.0',
  // OpenCode's run --auto --format json transport, session continuation and
  // per-run MCP configuration are validated from this release line.
  opencode: '1.18.0',
  // The native configuration/MCP overlay is verified against 2026.4.11;
  // see openclaw.ts and the zero-model canaries recorded in 92a3944ff.
  openclaw: '2026.4.11',
  // ACP protocolVersion=1 and sessionUpdate envelopes observed with Hermes
  // 0.9 are the baseline used by _acp.ts, not a claim about earlier releases.
  hermes: '0.9.0',
};

/** Anthropic's upstream CHANGELOG.md, 2.1.81: --bare was introduced for
 * scripted print calls. Older supported versions must not receive it or run
 * a non-bare catalog probe that could start user hooks/plugins. */
export const CLAUDE_BARE_MIN_VERSION = '2.1.81';

const VERSION_RE = /v?(\d+)\.(\d+)\.(\d+)/;
const VERSION_TOKEN_RE = /v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/;

export type Semver = { major: number; minor: number; patch: number };

/** Parse the first MAJOR.MINOR.PATCH triple in `raw`; null if not found. */
export function parseSemver(raw: string): Semver | null {
  if (typeof raw !== 'string') return null;
  const m = VERSION_RE.exec(raw);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/** Lexicographic compare across major / minor / patch. Returns -1/0/1. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** Unknown versions cannot establish support for an optional parameter. */
export function cliVersionAtLeast(detected: string | null | undefined, minimum: string): boolean {
  const got = detected ? parseSemver(detected) : null;
  const min = parseSemver(minimum);
  return !!got && !!min && (compareSemver(got, min) > 0
    || (compareSemver(got, min) === 0 && !VERSION_TOKEN_RE.exec(detected || '')?.[4]));
}

/**
 * Returns null when `detected` meets the minimum for `cli`, or an
 * explanatory string otherwise. Unregistered CLIs have no contract here;
 * registered CLIs must supply a recognized version before dispatch.
 */
export function checkMinVersion(cli: string, detected: string | null): string | null {
  const minRaw = Object.prototype.hasOwnProperty.call(MIN_VERSIONS, cli)
    ? MIN_VERSIONS[cli as LocalCliType] : undefined;
  if (!minRaw) return null;
  const min = parseSemver(minRaw);
  const got = detected ? parseSemver(detected) : null;
  if (!min || !got) return `${cli} version could not be verified against required minimum ${minRaw}`;
  if (compareSemver(got, min) < 0) {
    return `${cli} ${detected} is below required minimum ${minRaw}`;
  }
  return null;
}

export type VersionProbeResult =
  | {
      status: 'success';
      /** Core MAJOR.MINOR.PATCH retained for minimum-version checks. */
      version: string;
      /** Full semantic version when the CLI reports a prerelease. */
      fullVersion?: string;
      prerelease?: true;
    }
  | { status: 'timeout' | 'failed'; version: null };

/**
 * Run the configured version probe and preserve whether a missing version was
 * caused specifically by the process deadline. Other failures (spawn error,
 * non-zero exit, empty/unparseable output, or excessive output) remain
 * intentionally grouped as `failed`; callers only need a distinct timeout
 * state for accurate user-facing recovery copy.
 */
let activeProbes = 0;
const probeWaiters: Array<() => void> = [];
async function acquireProbe(waitMs: number): Promise<(() => void) | null> {
  if (activeProbes < 2) activeProbes += 1;
  else {
    const admitted = await new Promise<boolean>(resolve => {
      const next = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => {
        const index = probeWaiters.indexOf(next);
        if (index >= 0) probeWaiters.splice(index, 1);
        resolve(false);
      }, waitMs);
      timer.unref?.();
      probeWaiters.push(next);
    });
    if (!admitted) return null;
  }
  return () => {
    const next = probeWaiters.shift();
    if (next) next();
    else activeProbes -= 1;
  };
}

export async function detectVersionResult(
  binPath: string,
  timeoutMs = 5000,
  versionArgs: readonly string[] = ['--version'],
): Promise<VersionProbeResult> {
  const release = await acquireProbe(timeoutMs);
  if (!release) return { status: 'timeout', version: null };
  try { return await probeVersion(binPath, timeoutMs, versionArgs); }
  finally { release(); }
}

async function probeVersion(
  binPath: string,
  timeoutMs = 5000,
  versionArgs: readonly string[] = ['--version'],
): Promise<VersionProbeResult> {
  return new Promise(resolve => {
    let settled = false;
    let outputBytes = 0;
    let timer: NodeJS.Timeout | null = null;
    const maxOutputBytes = 64 * 1024;
    const finish = (result: VersionProbeResult, terminate?: NodeJS.Signals) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      // Own cleanup through completion before callers release probe resources
      // or start another discovery. Mark settled first so close cannot replace
      // the original timeout/output-limit result while taskkill is running.
      if (terminate) killProcessTree(child, terminate, { onComplete: () => resolve(result) });
      else resolve(result);
    };

    let stdout = '';
    let stderr = '';
    const launch = resolveCliCommand(binPath, [...versionArgs]);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, {
        env: buildCliSpawnEnv(binPath),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        detached: process.platform !== 'win32',
      });
    } catch {
      finish({ status: 'failed', version: null });
      return;
    }

    const capture = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += data.length;
      if (outputBytes > maxOutputBytes) {
        finish({ status: 'failed', version: null }, 'SIGKILL');
        return;
      }
      if (target === 'stdout') stdout += data.toString('utf8');
      else stderr += data.toString('utf8');
    };
    child.stdout?.on('data', (c: Buffer | string) => capture('stdout', c));
    child.stderr?.on('data', (c: Buffer | string) => capture('stderr', c));

    timer = setTimeout(() => {
      // Windows npm CLIs are .cmd -> node process trees. Killing only the
      // command-shell parent leaves the real CLI (and any probe descendants)
      // running after discovery has already returned.
      finish({ status: 'timeout', version: null }, 'SIGTERM');
    }, timeoutMs);
    timer.unref?.();

    child.on('error', () => finish({ status: 'failed', version: null }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ status: 'failed', version: null });
      // Some wrappers print a banner to stdout and the actual version to
      // stderr. Inspect both streams instead of letting non-empty stdout
      // hide a valid stderr version.
      const text = `${stdout}\n${stderr}`.trim();
      if (!text) return finish({ status: 'failed', version: null });
      const token = VERSION_TOKEN_RE.exec(text);
      const sv = token ? parseSemver(token[0]) : null;
      if (!sv || !token) return finish({ status: 'failed', version: null });
      const prerelease = token[4] ? `-${token[4]}` : '';
      // Return the matched semver string so callers store a clean value
      // (the raw line may carry product names / notes we don't want).
      finish({
        status: 'success',
        version: `${sv.major}.${sv.minor}.${sv.patch}`,
        ...(prerelease
          ? { fullVersion: `${sv.major}.${sv.minor}.${sv.patch}${prerelease}`, prerelease: true as const }
          : {}),
      });
    });
  });
}

/** Backward-compatible version-only view used by callers that do not need to
 * distinguish timeout from other probe failures. */
export async function detectVersion(
  binPath: string,
  timeoutMs = 5000,
  versionArgs: readonly string[] = ['--version'],
): Promise<string | null> {
  return (await detectVersionResult(binPath, timeoutMs, versionArgs)).version;
}
