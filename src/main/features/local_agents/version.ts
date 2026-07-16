/**
 * Version probe + minimum-version gate for local CLI agents.
 *
 * Two pure functions (parseSemver / checkMinVersion) for unit-testing,
 * and one subprocess call (detectVersion) that runs `<bin> --version`
 * and extracts the first `[v]MAJOR.MINOR.PATCH` token from stdout/stderr.
 *
 * MIN_VERSIONS is intentionally narrow: only CLIs whose stream-json /
 * ACP shape changed in a known-incompatible way before some version are
 * gated here. Adding entries should be paired with a backend that
 * actually relies on the new shape.
 */

import { spawn } from 'node:child_process';
import { resolveCliCommand } from './spawn-command.js';

/** Minimum CLI versions; absent entry = no minimum. */
export const MIN_VERSIONS: Record<string, string> = {
  // claude --output-format stream-json + --print are stable from 2.x.
  claude: '2.0.0',
  // codex `app-server --listen stdio://` was added in 0.100.0.
  codex: '0.100.0',
};

const VERSION_RE = /v?(\d+)\.(\d+)\.(\d+)/;

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

/**
 * Run `<binPath> --version`, return the parsed version string (the raw
 * line we matched, not just the semver), or null on any failure.
 *
 * Timeout is 5s — `--version` should be sub-100ms; anything longer is
 * a hung/wrong binary.
 */
export async function detectVersion(binPath: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let stdout = '';
    let stderr = '';
    const launch = resolveCliCommand(binPath, ['--version']);
    const child = spawn(launch.command, launch.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });

    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      finish(null);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const text = (stdout || stderr || '').trim();
      if (!text) return finish(null);
      const sv = parseSemver(text);
      if (!sv) return finish(null);
      // Return the matched semver string so callers store a clean value
      // (the raw line may carry product names / notes we don't want).
      finish(`${sv.major}.${sv.minor}.${sv.patch}`);
    });
  });
}
