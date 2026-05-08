/**
 * OpenCode CLI backend.
 *
 * Correct invocation (per multica `opencode.go`; my earlier
 * `_text.ts` template was wrong — opencode doesn't take stdin and
 * `--print` isn't a flag):
 *
 *   opencode run --format json [--model <provider/model>]
 *                [--session <id>] <prompt>
 *
 * Notes:
 *   - Prompt is passed as the LAST positional argv (NOT stdin).
 *   - Resume: `--session <id>` (different flag name from claude).
 *   - Output: NDJSON events on stdout. We care about:
 *       step_start, text (part.text), tool_use (part.tool/callID/state),
 *       error (error.data.message), step_finish (token usage; ignored).
 *   - sessionID may appear at top-level event or under part.
 */

import { createLogger } from '../../../logger.js';
import {
  type LocalBackend,
  type BackendRunOptions,
  type LocalEvent,
  StderrTail,
  spawnCli,
  bindAbort,
  LineSplitter,
} from './base.js';

const log = createLogger('local-agents:opencode');

export const opencodeBackend: LocalBackend = {
  async run(opts: BackendRunOptions): Promise<void> {
    const args = buildOpencodeArgs(opts);
    const child = spawnCli(opts.binPath, args, opts.cwd);
    const detachAbort = bindAbort(child, opts.signal);
    const tail = new StderrTail();
    const startedAt = Date.now();

    let exited = false;
    let timedOut = false;
    let textOut = '';
    let resultStatus: 'completed' | 'failed' | undefined;
    let resultError: string | undefined;
    let observedSessionId: string | undefined;

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

    // opencode reads prompt from argv; close stdin so it doesn't wait.
    child.stdin.end();

    const splitter = new LineSplitter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      splitter.push(chunk, line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let obj: any;
        try { obj = JSON.parse(trimmed); } catch { return; }
        const ev = mapOpencodeEvent(obj);
        if (ev?.captureSessionId) observedSessionId = ev.captureSessionId;
        if (ev?.event) {
          opts.onEvent(ev.event);
          if (ev.event.type === 'text-delta' && typeof (ev.event as any).text === 'string') {
            textOut += (ev.event as any).text as string;
          }
        }
        if (ev?.terminal) {
          resultStatus = ev.terminal.status;
          resultError = ev.terminal.error;
        }
      });
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
          type: 'done', status,
          durationMs: Date.now() - startedAt,
          sessionId: observedSessionId,
          ...extra,
        });
        resolve();
      };
      child.on('error', err => {
        log.warn('spawn error', { error: (err as Error).message });
        finish('failed', { error: (err as Error).message, stderrTail: tail.toString() });
      });
      child.on('close', code => {
        if (opts.signal.aborted) return finish('cancelled', { output: textOut });
        if (timedOut) return finish('timeout', { error: `cli exceeded ${opts.timeoutMs}ms`, output: textOut, stderrTail: tail.toString() });
        if (code === 0 && (resultStatus === 'completed' || resultStatus === undefined)) {
          return finish('completed', { output: textOut });
        }
        const err = resultError
          || (code !== 0 ? `opencode exited with code ${code}` : 'opencode closed without final event');
        finish('failed', { error: err, output: textOut, stderrTail: tail.toString() });
      });
    });
  },
};

function buildOpencodeArgs(opts: BackendRunOptions): string[] {
  const args = ['run', '--format', 'json'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--session', opts.resumeSessionId);
  if (opts.customArgs && opts.customArgs.length) args.push(...opts.customArgs);
  args.push(opts.prompt);
  return args;
}

/** Pure mapper for opencode NDJSON events. Exposed for unit testing. */
export function mapOpencodeEvent(obj: any):
  | undefined
  | {
      event?: LocalEvent;
      captureSessionId?: string;
      terminal?: { status: 'completed' | 'failed'; error?: string };
    } {
  if (!obj || typeof obj !== 'object') return undefined;
  const out: ReturnType<typeof mapOpencodeEvent> = {};
  // SessionID can sit at top level or inside .part — accept either.
  const sid = (typeof obj.sessionID === 'string' && obj.sessionID)
    || (obj.part && typeof obj.part.sessionID === 'string' ? obj.part.sessionID : '');
  if (sid) out!.captureSessionId = sid;
  switch (obj.type) {
    case 'text': {
      const text = obj.part?.text;
      if (typeof text === 'string' && text.length) {
        out!.event = { type: 'text-delta', text };
      }
      return out;
    }
    case 'tool_use': {
      const part = obj.part || {};
      const state = part.state || {};
      const status = String(state.status || '');
      // Two visible phases: when the tool is just invoked vs when its
      // output landed. Map to phase 'use' / 'result' so the renderer
      // shows a use → result transition.
      if (status === 'completed' || status === 'success' || status === 'done') {
        const output = typeof state.output === 'string'
          ? state.output
          : (state.output != null ? JSON.stringify(state.output) : '');
        out!.event = {
          type: 'tool-event',
          tool: String(part.tool || 'tool'),
          callId: String(part.callID || part.id || ''),
          phase: 'result',
          output,
        };
      } else {
        out!.event = {
          type: 'tool-event',
          tool: String(part.tool || 'tool'),
          callId: String(part.callID || part.id || ''),
          phase: 'use',
          input: state.input ?? {},
        };
      }
      return out;
    }
    case 'error': {
      const errObj = obj.error || {};
      const msg = errObj.data?.message || errObj.name || 'opencode reported error';
      out!.terminal = { status: 'failed', error: String(msg) };
      return out;
    }
    case 'step_finish':
      // Token usage event; nothing to surface (we don't track usage
      // for CLI calls in archive context yet).
      return out;
    case 'step_start':
      out!.event = { type: 'status', status: 'running' };
      return out;
    default:
      return out!.captureSessionId ? out : undefined;
  }
}
