/**
 * Version probe + minimum-version gate for local CLI agents.
 *
 * Two pure functions (parseSemver / checkMinVersion) for unit-testing,
 * and one subprocess call (detectVersion) that runs the caller-provided
 * version command (defaulting to `<bin> --version`)
 * and extracts the first `[v]MAJOR.MINOR.PATCH` token from stdout/stderr.
 *
 * MIN_VERSIONS is intentionally narrow: only CLIs whose stream-json /
 * ACP shape changed in a known-incompatible way before some version are
 * gated here. Adding entries should be paired with a backend that
 * actually relies on the new shape.
 */

import { spawn } from 'node:child_process';
import { killProcessTree } from './backends/base.js';
import { buildCliSpawnEnv, resolveCliCommand } from './spawn-command.js';

/** Minimum CLI versions; absent entry = no minimum. */
export const MIN_VERSIONS: Record<string, string> = {
  // claude --output-format stream-json + --print are stable from 2.x.
  claude: '2.0.0',
  // Orkas talks to Codex through the app-server JSON-RPC contract. Keep this
  // floor pinned to the oldest protocol version validated by Orkas; the model
  // catalog in Settings is a separate concern and must not determine CLI
  // compatibility.
  codex: '0.145.0',
  // Approval-mode dispatch uses OpenCode's stdio ACP transport so native
  // permission requests can be reviewed in Orkas. This is the oldest release
  // line validated against that session/resume + permission contract.
  opencode: '1.18.0',
};

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

/**
 * Returns null when `detected` meets the minimum for `cli`, or an
 * explanatory string otherwise. Unknown / unparsable inputs return
 * null (no minimum / nothing to gate against) — the goal is to refuse
 * obviously-old binaries, not to be a strict version policy engine.
 */
export function checkMinVersion(cli: string, detected: string | null): string | null {
  const minRaw = MIN_VERSIONS[cli];
  if (!minRaw) return null;
  if (!detected) return null;
  const min = parseSemver(minRaw);
  const got = parseSemver(detected);
  if (!min || !got) return null;
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
export async function detectVersionResult(
  binPath: string,
  timeoutMs = 5000,
  versionArgs: readonly string[] = ['--version'],
): Promise<VersionProbeResult> {
  return new Promise(resolve => {
    let settled = false;
    let outputBytes = 0;
    let timer: NodeJS.Timeout | null = null;
    const maxOutputBytes = 64 * 1024;
    const finish = (result: VersionProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolve(result);
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
        killProcessTree(child, 'SIGKILL');
        finish({ status: 'failed', version: null });
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
      killProcessTree(child, 'SIGTERM');
      finish({ status: 'timeout', version: null });
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
