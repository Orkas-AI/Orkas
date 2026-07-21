/**
 * OfficeCLI engine wrapper.
 *
 * OfficeCLI is a single self-contained native binary (embedded .NET runtime,
 * no MS Office / LibreOffice needed) vendored under `resources/officecli/` by
 * `scripts/fetch-officecli.cjs` and shipped via electron-builder
 * `extraResources`. It is the built-in engine for reading / creating / editing
 * / rendering docx/xlsx/pptx. This module is the ONLY place that spawns it.
 *
 * Resident processes: most OfficeCLI subcommands (create / batch / view / …)
 * spin up a per-file `__resident-serve__` daemon to keep the document in
 * memory for faster follow-up commands. That daemon DETACHES and outlives the
 * command process, so a tool that touches a file MUST `closeOfficeFile()` it
 * when done (in a finally) or the daemons accumulate. There is no upstream
 * "close all" — see `closeAllOfficeResidents()` for the app-shutdown sweep
 * (best-effort; hardening).
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { officeCliBinaryPath } from '../../paths';
import { createLogger } from '../../logger';
import { killProcessTree } from '../../../core-agent/src/sandbox/executor';

const log = createLogger('office-engine');

export type OfficeCliResult = { code: number; stdout: string; stderr: string };

export class OfficeCliError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OfficeCliError';
    this.code = code;
  }
}

export interface RunOfficeCliOpts {
  /** Working directory for the spawned process. */
  cwd: string;
  /** Abort signal — kills the command process (not the detached resident). */
  signal?: AbortSignal;
  /** Hard timeout in ms (default 60s). */
  timeoutMs?: number;
  /** UTF-8 text piped to stdin (used by `batch` when no --input is given). */
  stdin?: string;
  /** Combined stdout/stderr capture ceiling (default 16 MiB). */
  maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

let availableCache: boolean | null = null;

export function _resetOfficeCliAvailableForTest(): void {
  availableCache = null;
}

/** True when a usable OfficeCLI binary is present for this platform/arch.
 *  Only the POSITIVE result is cached — in dev the binary is fetched on demand
 *  (`npm run officecli:fetch`), so caching a negative from an early call would
 *  wedge every office tool as missing for the whole session. In a packed build
 *  the binary is present from first call, so this caches as before. */
export function officeCliAvailable(): boolean {
  if (availableCache === true) return true;
  const bin = officeCliBinaryPath();
  const ok = !!bin && fs.existsSync(bin);
  if (ok) availableCache = true;
  else log.warn(`OfficeCLI binary unavailable (${bin ?? `no asset for ${process.platform}-${process.arch}`})`);
  return ok;
}

/** Spawn the OfficeCLI binary with `args`. Resolves on process exit with the
 *  captured stdout/stderr (any exit code — callers inspect `code`); rejects
 *  only on spawn failure or timeout. */
export function runOfficeCli(args: string[], opts: RunOfficeCliOpts): Promise<OfficeCliResult> {
  const bin = officeCliBinaryPath();
  if (!bin) {
    return Promise.reject(
      new OfficeCliError('E_OFFICE_ENGINE_MISSING', `no OfficeCLI binary for ${process.platform}-${process.arch}`),
    );
  }
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxOutputBytes = Math.max(1, opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  if (opts.signal?.aborted) {
    return Promise.reject(new OfficeCliError('E_OFFICE_ABORTED', `OfficeCLI aborted before start: ${args[0]}`));
  }

  return new Promise<OfficeCliResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        detached: process.platform !== 'win32',
        // OfficeCLI enables background self-updates by default. Orkas vendors
        // a hash-pinned binary, so letting it replace itself at runtime defeats
        // that pin and can swap versions in the middle of a create/batch flow.
        // Always prefer the version shipped with Orkas; upgrades belong to the
        // dependency/release pipeline, never an end-user document operation.
        env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new OfficeCliError('E_OFFICE_SPAWN', (err as Error).message));
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    let outputBytes = 0;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (code: string, message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new OfficeCliError(code, message));
    };
    const terminate = () => {
      try { killProcessTree(child, 'SIGKILL'); } catch { /* best effort */ }
    };
    const onAbort = () => {
      terminate();
      fail('E_OFFICE_ABORTED', `OfficeCLI aborted: ${args[0]}`);
    };
    const capture = (chunks: Buffer[], chunk: Buffer | string) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += data.length;
      if (outputBytes > maxOutputBytes) {
        terminate();
        fail('E_OFFICE_OUTPUT_LIMIT', `OfficeCLI output exceeded ${maxOutputBytes} bytes: ${args[0]}`);
        return;
      }
      chunks.push(data);
    };

    timer = setTimeout(() => {
      terminate();
      fail('E_OFFICE_TIMEOUT', `OfficeCLI timed out after ${timeoutMs}ms: ${args[0]}`);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (c: Buffer | string) => capture(outChunks, c));
    child.stderr?.on('data', (c: Buffer | string) => capture(errChunks, c));
    child.stdin?.on('error', (err: Error) => fail('E_OFFICE_STDIN', `OfficeCLI stdin failed: ${err.message}`));

    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
      if (opts.signal.aborted) onAbort();
    }

    // Always close stdin: `batch` reads JSON from it; commands that ignore
    // stdin are unaffected by an immediate EOF.
    if (!settled) {
      try {
        if (opts.stdin !== undefined) child.stdin?.write(opts.stdin);
        child.stdin?.end();
      } catch (err) {
        fail('E_OFFICE_STDIN', `OfficeCLI stdin failed: ${(err as Error).message}`);
      }
    }

    child.on('error', (err: Error) => {
      fail('E_OFFICE_SPAWN', err.message);
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
  });
}

/** Stop the resident daemon holding `file` in memory. Best-effort, never
 *  throws — call in a `finally` after a tool finishes with a document. */
export async function closeOfficeFile(file: string, cwd: string): Promise<void> {
  try {
    await runOfficeCli(['close', file], { cwd, timeoutMs: 10_000 });
  } catch (err) {
    log.warn(`close resident ${file}: ${(err as Error).message}`);
  }
}

/** Reap ANY lingering OfficeCLI resident daemons. Per-file `closeOfficeFile`
 *  in each tool's `finally` covers the normal path; this is the backstop for a
 *  hard crash that skipped the finally. Call at startup (clean prior-session
 *  leaks) and on app quit. Synchronous + best-effort; single-instance lock
 *  guarantees no concurrent legitimate instance to disturb. */
export function closeAllOfficeResidents(): void {
  const bin = officeCliBinaryPath();
  if (!bin) return;
  try {
    if (process.platform === 'win32') {
      // Match-by-cmdline is unreliable on Windows; at startup/quit killing every
      // process of our bundled exe by image name is safe (no concurrent instance).
      const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
      // Use Windows path semantics explicitly. Besides making this branch
      // deterministic in cross-host tests, it avoids ever passing a full
      // `C:\\...` path to taskkill when the value originated outside the host
      // path module (for example packaged metadata or a cross-build step).
      spawnSync(taskkill, ['/F', '/T', '/IM', path.win32.basename(bin)], {
        timeout: 5_000,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      // Scope strictly to OUR binary's resident daemons, not any other officecli.
      // `pkill -f` treats the pattern as an extended regex, so escape the binary
      // path (an install dir with `()[]` etc. would otherwise fail to match and
      // silently leak residents, or match too broadly).
      const escaped = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      spawnSync('pkill', ['-f', `${escaped} __resident-serve__`], { timeout: 5_000, stdio: 'ignore' });
    }
  } catch (err) {
    log.warn(`resident sweep: ${(err as Error).message}`);
  }
}
