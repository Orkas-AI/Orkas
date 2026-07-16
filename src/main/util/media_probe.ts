import { spawn } from 'node:child_process';

import { bundledFfmpegPaths } from './bundled-runtime';

const FFPROBE_TIMEOUT_MS = 30_000;

function parsePositiveDuration(text: string): number | null {
  const value = Number(text.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

function runProbe(bin: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { ...(signal ? { signal } : {}) });
    } catch {
      resolve({ code: -1, stdout: '' });
      return;
    }

    const out: string[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, FFPROBE_TIMEOUT_MS);
    timer.unref?.();

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out.join('') });
    };

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')));
    child.stdin?.end();
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code));
  });
}

async function probeDuration(ffprobe: string, args: string[], signal?: AbortSignal): Promise<number | null> {
  if (signal?.aborted) return null;
  const result = await runProbe(ffprobe, args, signal);
  if (signal?.aborted || result.code !== 0) return null;
  return parsePositiveDuration(result.stdout);
}

/** Best-effort media duration probe using the platform-bundled ffprobe. */
export async function probeMediaDurationSec(inputAbsPath: string, signal?: AbortSignal): Promise<number | null> {
  const ffprobe = bundledFfmpegPaths().ffprobe;
  if (!ffprobe) return null;

  const formatDuration = await probeDuration(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    inputAbsPath,
  ], signal);
  if (formatDuration !== null) return formatDuration;

  return probeDuration(ffprobe, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=duration',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    inputAbsPath,
  ], signal);
}
