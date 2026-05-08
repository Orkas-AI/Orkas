/**
 * Generic "stream stdout as text" backend factory. Used by CLIs whose
 * non-interactive mode prints the model's reply as plain text on
 * stdout (codex / openclaw / opencode in v1). The factory turns
 * per-CLI argv decisions into a reusable backend with the same
 * cancellation, timeout, and `done` semantics as the structured
 * backends.
 *
 * What this trades off vs structured stream-json parsing:
 *   - We don't get tool-use / tool-result events; the entire body
 *     arrives as a single text-delta stream.
 *   - We don't see thinking blocks separately.
 *   - Failures from inside the CLI's output are detected only by
 *     non-zero exit code; partial-success runs surface as completed
 *     with the body as-is.
 * Step 7+ can swap any of these CLIs to a structured backend (e.g.
 * `opencode run --print --json`) without touching the runner.
 */

import { createLogger } from '../../../logger.js';
import {
  type LocalBackend,
  type BackendRunOptions,
  StderrTail,
  spawnCli,
  bindAbort,
} from './base.js';

export interface TextBackendDef {
  /** Logger scope name, e.g. `'local-agents:codex'`. */
  logName: string;
  /** Build the argv passed to the CLI. Receives the full opts so it
   *  can inject `--model`, append `customArgs`, etc. */
  buildArgs(opts: BackendRunOptions): string[];
  /** When true, the prompt is written to stdin (then stdin closes);
   *  when false the caller already encoded it into argv. */
  promptOnStdin: boolean;
}

export function makeTextBackend(def: TextBackendDef): LocalBackend {
  const log = createLogger(def.logName);
  return {
    async run(opts: BackendRunOptions): Promise<void> {
      const args = def.buildArgs(opts);
      const child = spawnCli(opts.binPath, args, opts.cwd);
      const detachAbort = bindAbort(child, opts.signal);
      const tail = new StderrTail();
      const startedAt = Date.now();

      let exited = false;
      let timedOut = false;
      let outBody = '';

      opts.onEvent({
        type: 'process-info',
        pid: child.pid ?? -1,
        cwd: opts.cwd,
        cmd: opts.binPath,
        args,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 10_000).unref();
      }, opts.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      if (def.promptOnStdin) {
        // Write & close so the CLI knows there's no further input.
        child.stdin.end(opts.prompt);
      } else {
        child.stdin.end();
      }

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        outBody += chunk;
        opts.onEvent({ type: 'text-delta', text: chunk });
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        tail.push(chunk);
        for (const line of chunk.split(/\r?\n/)) {
          if (line) opts.onEvent({ type: 'stderr-line', line });
        }
      });

      return new Promise<void>(resolve => {
        const finish = (status: 'completed' | 'failed' | 'cancelled' | 'timeout', extra: Record<string, unknown> = {}) => {
          if (exited) return;
          exited = true;
          clearTimeout(timer);
          detachAbort();
          opts.onEvent({
            type: 'done',
            status,
            durationMs: Date.now() - startedAt,
            ...extra,
          });
          resolve();
        };
        child.on('error', err => {
          log.warn('spawn error', { error: (err as Error).message });
          finish('failed', { error: (err as Error).message, stderrTail: tail.toString() });
        });
        child.on('close', code => {
          if (opts.signal.aborted) return finish('cancelled', { output: outBody });
          if (timedOut) return finish('timeout', { error: `cli exceeded ${opts.timeoutMs}ms`, output: outBody, stderrTail: tail.toString() });
          if (code === 0) return finish('completed', { output: outBody });
          finish('failed', {
            error: `cli exited with code ${code}`,
            output: outBody,
            stderrTail: tail.toString(),
          });
        });
      });
    },
  };
}
