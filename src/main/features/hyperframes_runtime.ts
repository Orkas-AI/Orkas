/**
 * Shared runtime for the HyperFrames-backed video tools (render_composition /
 * analyze_media / generate_speech). Centralizes: resolving the bundled Node +
 * npx, building the spawn env (PATH prepend, bundled ffmpeg lock, npm cache +
 * offline/retry hardening, shared Python venv on PATH for tts), and a generic
 * capture-spawn for `--json` ops. hyperframes itself is a runtime npx download
 * (deliberately not bundled — see the design plan §6.2); these knobs make that
 * download reliable.
 */

import { spawn } from 'node:child_process';

import {
  bundledNodeExecutable,
  bundledNpxCli,
  bundledRuntimePathEntries,
  bundledFfmpegPaths,
} from '../util/bundled-runtime';
import * as paths from '../paths';

/** Pinned HyperFrames version. Bump deliberately (reproducible + known flags). */
export const HYPERFRAMES_SPEC = 'hyperframes@0.7.3';

/** Resolve the bundled Node + npm `npx-cli.js` to run hyperframes as
 *  `node <npx-cli.js> ...` — robust cross-platform (no shebang/.cmd/shell). */
export function resolveHyperframesRunner(): { node: string; npxCli: string } | null {
  const node = bundledNodeExecutable();
  const npxCli = bundledNpxCli();
  if (!node || !npxCli) return null;
  return { node, npxCli };
}

/** Env for any hyperframes npx invocation. */
export function buildHyperframesEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const sep = process.platform === 'win32' ? ';' : ':';

  const prepend = [...bundledRuntimePathEntries()];
  // Shared Python venv bin → `hyperframes tts` resolves the venv `python` that
  // carries kokoro-onnx. Harmless for render/transcribe (no python shell-out);
  // a non-existent dir is simply ignored by PATH resolution.
  prepend.push(paths.PYTHON_VENV_BIN_DIR);
  if (prepend.length) env.PATH = [...prepend, env.PATH || ''].filter(Boolean).join(sep);

  const ff = bundledFfmpegPaths();
  if (ff.ffmpeg) env.HYPERFRAMES_FFMPEG_PATH = ff.ffmpeg;
  if (ff.ffprobe) env.HYPERFRAMES_FFPROBE_PATH = ff.ffprobe;

  env.NPM_CONFIG_CACHE = paths.NODE_NPM_CACHE_DIR;
  env.NPM_CONFIG_PREFIX = paths.NODE_NPM_PREFIX_DIR;
  env.NPM_CONFIG_FUND = 'false';
  env.NPM_CONFIG_AUDIT = 'false';
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  // Warm cache → zero network; bump retries so a cold-download network blip self-heals.
  env.NPM_CONFIG_PREFER_OFFLINE = 'true';
  env.NPM_CONFIG_FETCH_RETRIES = '4';
  return env;
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Run `npx hyperframes <args>` and capture stdout/stderr. For `--json` ops
 * (inspect / lint / transcribe) where the output is the product. Never rejects.
 */
export function runHyperframesCapture(
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<CaptureResult> {
  const runner = resolveHyperframesRunner();
  if (!runner) {
    return Promise.resolve({ code: -1, stdout: '', stderr: 'E_RUNTIME_MISSING: bundled Node not found', timedOut: false, aborted: false });
  }
  const env = buildHyperframesEnv();
  const fullArgs = [runner.npxCli, '--yes', HYPERFRAMES_SPEC, ...args];
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  return new Promise<CaptureResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(runner.node, fullArgs, { ...(opts.cwd ? { cwd: opts.cwd } : {}), env, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message, timedOut: false, aborted: false });
      return;
    }
    const out: string[] = [];
    const errChunks: string[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c.toString('utf8')));
    child.stdin?.end();
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out.join(''), stderr: err.message, timedOut, aborted: !!opts.signal?.aborted });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out.join(''), stderr: errChunks.join(''), timedOut, aborted: !!opts.signal?.aborted });
    });
  });
}
