import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Creation timestamps and Date.now() need not use the same clock precision.
 * Mark the filesystem boundary, then observe its next tick before launching the
 * writer. Strict comparison rejects pre-run files even in the marker's tick.
 * Constant bounded work; no workspace traversal or timestamp grace interval. */
export async function captureFileCreationFence(directory: string, signal: AbortSignal): Promise<number | undefined> {
  const sample = async (): Promise<number> => {
    const file = path.join(directory, `.orkas-creation-${randomUUID()}`);
    let created = false;
    try {
      await fs.promises.writeFile(file, '', { flag: 'wx', mode: 0o600 });
      created = true;
      return (await fs.promises.stat(file)).birthtimeMs;
    } finally {
      if (created) await fs.promises.unlink(file);
    }
  };
  if (signal.aborted) return undefined;
  try {
    const started = performance.now(), fence = await sample();
    if (!(fence > 0)) return undefined;
    for (let attempt = 0; attempt < 32 && performance.now() - started < 100; attempt++) {
      if (signal.aborted) return undefined;
      if (await sample() > fence) return fence;
      await new Promise<void>(resolve => setTimeout(resolve, 1));
    }
  } catch { /* Unsupported/read-only filesystems cannot establish ownership. */ }
  return undefined;
}

export function isFileCreatedAfterFence(file: string, fence: number | undefined): boolean {
  if (fence === undefined) return false;
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.birthtimeMs > fence;
  } catch { return false; }
}
