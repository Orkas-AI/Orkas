import { spawn } from 'node:child_process';

import { killProcessTree } from '../../core-agent/src/sandbox/executor';
import { bundledFfmpegPaths } from './bundled-runtime';

const FFPROBE_TIMEOUT_MS = 30_000;
const FFPROBE_MAX_OUTPUT_BYTES = 1024 * 1024;
type ProbeResult = { code: number | null; stdout: string };
type ProbeRunner = (bin: string, args: string[], signal?: AbortSignal) => Promise<ProbeResult>;

function parsePositiveDuration(text: string): number | null {
  const value = Number(text.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function runMediaProbeProcessForTest(
  bin: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<ProbeResult> {
  if (options.signal?.aborted) return Promise.resolve({ code: -1, stdout: '' });
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ code: -1, stdout: '' });
      return;
    }

    const out: string[] = [];
    let outputBytes = 0;
    let settled = false;
    const timeoutMs = options.timeoutMs ?? FFPROBE_TIMEOUT_MS;
    const maxOutputBytes = Math.max(1, options.maxOutputBytes ?? FFPROBE_MAX_OUTPUT_BYTES);
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      options.signal?.removeEventListener('abort', onAbort);
    };
    const terminate = () => {
      try { killProcessTree(child, 'SIGKILL'); } catch { /* best effort */ }
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, stdout: out.join('') });
    };
    const onAbort = () => {
      terminate();
      finish(-1);
    };

    timer = setTimeout(() => {
      terminate();
      finish(-1);
    }, timeoutMs);
    timer.unref?.();

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate();
        finish(-1);
        return;
      }
      out.push(chunk.toString('utf8'));
    });
    child.stderr?.on('data', () => { /* drain ffprobe diagnostics without retaining them */ });
    child.stdin?.on('error', () => { /* spawn/termination races can close stdin before EOF */ });
    child.stdin?.end();
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code));
  });
}

function runProbe(bin: string, args: string[], signal?: AbortSignal): Promise<ProbeResult> {
  return runMediaProbeProcessForTest(bin, args, { signal });
}

async function probeDuration(
  ffprobe: string,
  args: string[],
  signal: AbortSignal | undefined,
  runner: ProbeRunner,
): Promise<number | null> {
  if (signal?.aborted) return null;
  const result = await runner(ffprobe, args, signal);
  if (signal?.aborted || result.code !== 0) return null;
  return parsePositiveDuration(result.stdout);
}

/** Best-effort media duration probe using the platform-bundled ffprobe. */
export async function probeMediaDurationSec(inputAbsPath: string, signal?: AbortSignal): Promise<number | null> {
  const ffprobe = bundledFfmpegPaths().ffprobe;
  if (!ffprobe) return null;

  return probeMediaDurationWithRunner(ffprobe, inputAbsPath, runProbe, signal);
}

/** Deterministic seam for fallback and subprocess-contract coverage. */
export async function probeMediaDurationWithRunner(
  ffprobe: string,
  inputAbsPath: string,
  runner: ProbeRunner,
  signal?: AbortSignal,
): Promise<number | null> {

  const formatDuration = await probeDuration(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    inputAbsPath,
  ], signal, runner);
  if (formatDuration !== null) return formatDuration;

  return probeDuration(ffprobe, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=duration',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    inputAbsPath,
  ], signal, runner);
}
