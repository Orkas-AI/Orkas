/**
 * Claude Code backend. Runs `claude -p --output-format stream-json
 * --input-format stream-json --verbose` and feeds a single user
 * message on stdin, then closes stdin. Output is one JSON object per
 * line; we recognize:
 *
 *   {"type":"system","subtype":"init", session_id, cwd, ...}
 *   {"type":"assistant","message":{ "content":[{type:"text", text}, {type:"tool_use",...}, {type:"thinking",...}] }}
 *   {"type":"user","message":{ "content":[{type:"tool_result", tool_use_id, content}] }}
 *   {"type":"result","subtype":"success"|"error_*", result, total_cost_usd, duration_ms, ...}
 *
 * Non-conforming lines (banner text, debug noise) are silently dropped
 * so a noisy CLI version doesn't bork a run.
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

const log = createLogger('local-agents:claude');

export const claudeBackend: LocalBackend = {
  async run(opts: BackendRunOptions): Promise<void> {
    const args = buildClaudeArgs(opts);
    const child = spawnCli(opts.binPath, args, opts.cwd);
    const detachAbort = bindAbort(child, opts.signal);
    const tail = new StderrTail();
    const startedAt = Date.now();

    let sessionId: string | undefined;
    let exited = false;
    let timedOut = false;
    let resultText = '';
    let resultStatus: 'completed' | 'failed' | undefined;
    let resultError: string | undefined;
    // Tracks whether we've seen a real stream_event with text content
    // — gates whether we can safely skip the assistant block's text
    // (which would otherwise duplicate the streamed body). Old claude
    // versions that ignore `--include-partial-messages` never emit
    // stream_events; in that case we fall back to emitting from the
    // assistant block so the user still sees the final text.
    const partialState = { sawTextStreamEvent: false };

    opts.onEvent({
      type: 'process-info',
      pid: child.pid ?? -1,
      cwd: opts.cwd,
      cmd: opts.binPath,
      args,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 10_000).unref();
    }, opts.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    // Build and send the single user message, then close stdin so
    // claude knows there's no follow-up turn coming.
    const inputLine = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: opts.prompt }],
      },
    }) + '\n';
    child.stdin.end(inputLine);

    // stdout: line-buffered JSON parsing.
    const splitter = new LineSplitter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      splitter.push(chunk, line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let obj: any;
        try { obj = JSON.parse(trimmed); }
        catch {
          // Pre-stream banner / debug noise — surface as text-delta
          // when nothing else has arrived yet so users still see why
          // the CLI is unhappy. After we have a session id, drop.
          if (!sessionId) opts.onEvent({ type: 'text-delta', text: trimmed + '\n' });
          return;
        }
        const ev = mapClaudeEvent(obj, sessionId, partialState);
        if (ev?.captureSession && obj.session_id) sessionId = String(obj.session_id);
        if (ev?.event) opts.onEvent(ev.event);
        if (ev?.terminal) {
          resultStatus = ev.terminal.status;
          resultText = ev.terminal.text;
          resultError = ev.terminal.error;
        }
      });
    });
    child.stdout.on('end', () => splitter.flush(line => {
      const trimmed = line.trim();
      if (trimmed) opts.onEvent({ type: 'text-delta', text: trimmed });
    }));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      tail.push(chunk);
      // Emit one event per stderr line so live UI can show progress.
      for (const line of chunk.split(/\r?\n/)) {
        if (line) opts.onEvent({ type: 'stderr-line', line });
      }
    });

    return new Promise<void>(resolve => {
      const finish = (status: 'completed' | 'failed' | 'cancelled' | 'timeout', extra: Partial<LocalEvent> = {}) => {
        if (exited) return;
        exited = true;
        clearTimeout(timer);
        detachAbort();
        const durationMs = Date.now() - startedAt;
        opts.onEvent({
          type: 'done',
          status,
          durationMs,
          sessionId,
          ...extra,
        });
        resolve();
      };

      child.on('error', err => {
        log.warn('claude spawn error', { error: (err as Error).message });
        finish('failed', { error: (err as Error).message, stderrTail: tail.toString() });
      });
      child.on('close', code => {
        if (opts.signal.aborted) return finish('cancelled');
        if (timedOut) return finish('timeout', { error: `claude exceeded ${opts.timeoutMs}ms`, stderrTail: tail.toString() });
        if (code === 0 && resultStatus === 'completed') return finish('completed', { output: resultText });
        // Non-zero exit OR result subtype indicated error — surface tail.
        const err = resultError
          || (code !== 0 ? `claude exited with code ${code}` : 'claude reported error in result');
        finish('failed', { error: err, output: resultText, stderrTail: tail.toString() });
      });
    });
  },
};

/** Args mirroring the multica skeleton, distilled to what we actually
 *  use in v1: stream-json in/out, `--print` (non-interactive),
 *  bypass permissions for daemon-style execution, optional model. */
function buildClaudeArgs(opts: BackendRunOptions): string[] {
  // `--include-partial-messages` is the flag that turns claude code's
  // stream-json output from "one assistant message per completed turn"
  // into "many partial chunks streamed as the model generates". Without
  // it the user sees nothing for tens of seconds and then everything
  // appears at once — same UX as a non-streaming request. Older claude
  // versions silently ignore the flag rather than erroring on it.
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts.customArgs && opts.customArgs.length) args.push(...opts.customArgs);
  return args;
}

/** Translate one parsed claude stream-json record into our event model.
 *  Returns `undefined` when the record is recognized but produces no
 *  user-visible event (e.g. system/init that only seeds the session id).
 *
 *  Two parallel input shapes:
 *    - `type:'stream_event'` — partial-message tokens emitted only when
 *      `--include-partial-messages` is on. These are what give us real
 *      token-by-token streaming; we map their deltas to text-delta /
 *      thinking events.
 *    - `type:'assistant'` — the full message that aggregates everything
 *      streamed above. Emitted at end-of-turn. We **skip text/thinking
 *      content here** (the partials already covered it) but DO surface
 *      tool_use blocks because the partial input_json deltas alone
 *      aren't enough to render a useful tool-event.
 */
export function mapClaudeEvent(
  obj: any,
  _sessionIdSoFar: string | undefined,
  partialState: { sawTextStreamEvent: boolean } = { sawTextStreamEvent: false },
):
  | undefined
  | { event?: LocalEvent; captureSession?: boolean; terminal?: { status: 'completed' | 'failed'; text: string; error?: string } } {
  if (!obj || typeof obj !== 'object') return undefined;
  const type = obj.type;
  if (type === 'system' && obj.subtype === 'init') {
    return { captureSession: true };
  }
  if (type === 'stream_event') {
    const inner = obj.event;
    if (!inner || typeof inner !== 'object') return undefined;
    const innerType = inner.type;
    if (innerType === 'content_block_delta') {
      const d = inner.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text.length) {
        partialState.sawTextStreamEvent = true;
        return { event: { type: 'text-delta', text: d.text } };
      }
      if (d?.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking.length) {
        return { event: { type: 'thinking', text: d.thinking } };
      }
      // input_json_delta carries tool input streamed character-by-
      // character. Useless to render incrementally; we let the
      // assistant block fold it together when the turn finishes.
      return undefined;
    }
    if (innerType === 'content_block_start') {
      const cb = inner.content_block;
      if (cb?.type === 'tool_use') {
        return {
          event: {
            type: 'tool-event',
            tool: String(cb.name || 'unknown'),
            callId: String(cb.id || ''),
            phase: 'use',
            input: cb.input ?? {},
          },
        };
      }
      return undefined;
    }
    return undefined;
  }
  if (type === 'assistant') {
    const content = Array.isArray(obj?.message?.content) ? obj.message.content : [];
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        // Already streamed via stream_event partials → skip to avoid
        // duplicating the body. If the CLI didn't honor the partial
        // flag (older versions), no stream_event with text fired and
        // we fall back to emitting it here so the user still sees the
        // reply.
        if (partialState.sawTextStreamEvent) return undefined;
        return { event: { type: 'text-delta', text: part.text } };
      }
      if (part?.type === 'thinking') {
        if (partialState.sawTextStreamEvent) return undefined;
        if (typeof part.thinking === 'string') {
          return { event: { type: 'thinking', text: part.thinking } };
        }
        return undefined;
      }
      if (part?.type === 'tool_use') {
        return {
          event: {
            type: 'tool-event',
            tool: String(part.name || 'unknown'),
            callId: String(part.id || ''),
            phase: 'use',
            input: part.input ?? {},
          },
        };
      }
    }
    return undefined;
  }
  if (type === 'user') {
    const content = Array.isArray(obj?.message?.content) ? obj.message.content : [];
    for (const part of content) {
      if (part?.type === 'tool_result') {
        const out = typeof part.content === 'string'
          ? part.content
          : Array.isArray(part.content)
            ? part.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
            : '';
        return {
          event: {
            type: 'tool-event',
            tool: 'tool_result',
            callId: String(part.tool_use_id || ''),
            phase: 'result',
            output: out,
          },
        };
      }
    }
    return undefined;
  }
  if (type === 'result') {
    const ok = obj.subtype === 'success';
    const text = typeof obj.result === 'string' ? obj.result : '';
    const error = !ok && typeof obj.error === 'string' ? obj.error : undefined;
    return {
      event: { type: 'status', status: ok ? 'result' : 'error' },
      terminal: { status: ok ? 'completed' : 'failed', text, error },
    };
  }
  return undefined;
}
