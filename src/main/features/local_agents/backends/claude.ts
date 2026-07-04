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
import { logErrorSummary } from '../../../util/log-redact.js';
import {
  type LocalBackend,
  type BackendRunOptions,
  type LocalEvent,
  StderrTail,
  spawnCli,
  bindAbort,
  armKillWatchdog,
  LineSplitter,
  levelOrInfo,
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
    let resultText = '';
    let resultStatus: 'completed' | 'failed' | undefined;
    let resultError: string | undefined;
    let resultUsage: Record<string, number | string> | undefined;
    /** Running token tally accumulated from each `assistant` block's
     *  `message.usage` (mirrors multica's per-model map). The final
     *  `result.usage` claude itself emits is authoritative and overwrites
     *  this when the turn ends; in the meantime accUsage drives the
     *  live `status:'usage'` row. */
    let accUsage: Record<string, number | string> | undefined;
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

    const watchdog = armKillWatchdog(child, {
      timeoutMs: opts.timeoutMs,
      idleKillMs: opts.idleKillMs,
      lastEventAt: opts.lastEventAt,
    });

    // Build and send the single user message, but keep stdin OPEN —
    // claude code's stream-json protocol uses stdin for two channels:
    //   1. The user message that kicks off the turn (one and done).
    //   2. `control_response` records replying to claude's
    //      `control_request` (tool-use permission, hook gates). Even
    //      with `--permission-mode bypassPermissions`, MCP tools / user
    //      hooks still gate via this channel and the process blocks
    //      waiting for a stdin response we never send if we close
    //      stdin here. That's the "silent hang for 20 minutes" symptom
    //      users report — fix by writing the prompt without `.end()`
    //      and closing stdin only once we see the terminal `result`
    //      record (handled below in mapClaudeEvent's 'result' branch
    //      via the closeStdin callback).
    const inputLine = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: opts.prompt }],
      },
    }) + '\n';
    child.stdin.write(inputLine);

    /** Auto-allow control_request — claude code asks for tool-use /
     *  hook permission through this channel. We're a daemon-style
     *  dispatcher (no interactive UI yet for approval), so the only
     *  sane response is to allow and surface a permission-request
     *  event to the rail for visibility. Schema mirrors multica's
     *  daemon (`server/pkg/agent/claude.go::handleControlRequest`). */
    const respondToControlRequest = (msg: any): void => {
      const req = msg?.request || {};
      const inputMap = (req.input && typeof req.input === 'object') ? req.input : {};
      const response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response: {
            behavior: 'allow',
            updatedInput: inputMap,
          },
        },
      };
      try {
        child.stdin.write(JSON.stringify(response) + '\n');
      } catch (err) {
        log.warn('claude control_response write failed', { error: logErrorSummary(err) });
      }
    };

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
          // Non-JSON stdout — two distinct paths:
          //   - Before sessionId: surface as text-delta so a pre-stream
          //     banner / startup error still lands in the user bubble
          //     even when the CLI never gets far enough to talk
          //     stream-json. This is the only signal the user has when
          //     the CLI itself failed to boot.
          //   - After sessionId: emit as raw-line. Banner, MCP startup
          //     warnings, --verbose debug noise — direct-terminal users
          //     see these every run; previously we dropped them
          //     silently after session_id was captured, which is the
          //     "Orkas shows less than the terminal" symptom users
          //     reported. Raw-line renders as a kind-meta row in the
          //     process rail.
          if (!sessionId) opts.onEvent({ type: 'text-delta', text: trimmed + '\n' });
          else opts.onEvent({ type: 'raw-line', line: trimmed });
          return;
        }
        // Side-channel: control_request needs a stdin write back AND a
        // rail event. Handled outside mapClaudeEvent so the mapper
        // stays a pure translator (no I/O, easier to unit-test).
        if (obj?.type === 'control_request') {
          respondToControlRequest(obj);
          opts.onEvent({
            type: 'permission-request',
            id: String(obj.request_id || ''),
            tool: String(obj?.request?.tool_name || ''),
            input: obj?.request?.input ?? {},
            autoDecided: 'allow',
            reason: 'bypass',
          });
          return;
        }
        // Side-channel: each `assistant` block carries a `message.usage`
        // snapshot for that turn-piece. Multica accumulates these per
        // model and reports a flat total at the end. We do the same
        // accumulation AND additionally emit a streaming
        // `status:'usage'` event so the rail shows a live token
        // counter (matches the codex / opencode parity — claude only
        // emits one usage record otherwise, at the terminal result).
        if (obj?.type === 'assistant' && obj?.message?.usage) {
          const inc = extractClaudeUsage({ usage: obj.message.usage, message: { model: obj.message.model } });
          if (inc) {
            accUsage = mergeUsage(accUsage, inc);
            opts.onEvent({ type: 'status', status: 'usage', usage: accUsage });
          }
        }
        const ev = mapClaudeEvent(obj, sessionId, partialState);
        if (ev?.captureSession && obj.session_id) sessionId = String(obj.session_id);
        if (ev?.event) opts.onEvent(ev.event);
        if (ev?.terminal) {
          resultStatus = ev.terminal.status;
          resultText = ev.terminal.text;
          resultError = ev.terminal.error;
          resultUsage = ev.terminal.usage as typeof resultUsage;
          // Terminal record received — close stdin so the CLI's
          // post-result cleanup can exit (we kept it open through the
          // run to handle control_request). EPIPE on this write is
          // safe; base.ts's stdin.on('error') swallows it.
          try { child.stdin.end(); } catch { /* already gone */ }
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
        watchdog.disarm();
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
        log.warn('claude spawn error', { error: logErrorSummary(err) });
        finish('failed', { error: (err as Error).message, stderrTail: tail.toString() });
      });
      child.on('close', code => {
        if (opts.signal.aborted) return finish('cancelled');
        if (watchdog.fired()) return finish('timeout', { error: `claude ${watchdog.reason()}`, stderrTail: tail.toString() });
        if (code === 0 && resultStatus === 'completed') {
          return finish('completed', { output: resultText, usage: resultUsage });
        }
        // Non-zero exit OR result subtype indicated error — surface tail.
        const err = resultError
          || (code !== 0 ? `claude exited with code ${code}` : 'claude reported error in result');
        finish('failed', { error: err, output: resultText, stderrTail: tail.toString(), usage: resultUsage });
      });
    });
  },
};

/** Args mirroring the multica skeleton, distilled to what we actually
 *  use in v1: stream-json in/out, `--print` (non-interactive),
 *  bypass permissions for daemon-style execution, optional model. */
export function buildClaudeArgs(opts: Pick<BackendRunOptions, 'model' | 'resumeSessionId' | 'customArgs' | 'bridge'>): string[] {
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
    '--dangerously-skip-permissions',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  // orkas-bridge: ADD the per-run MCP server alongside the user's own MCP
  // config (no --strict-mcp-config — their servers must keep working), and
  // tell the agent the bridge exists via an appended system prompt.
  if (opts.bridge) {
    args.push('--mcp-config', opts.bridge.mcpConfigPath);
    if (opts.bridge.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.bridge.appendSystemPrompt);
    }
  }
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
  | { event?: LocalEvent; captureSession?: boolean; terminal?: { status: 'completed' | 'failed'; text: string; error?: string; usage?: Record<string, number | string> } } {
  if (!obj || typeof obj !== 'object') return undefined;
  const type = obj.type;
  if (type === 'system' && obj.subtype === 'init') {
    // Surface a running-status pulse alongside capturing the session
    // id. Matches multica's parity: an explicit '▶ running' row tells
    // the user the CLI handshake succeeded and we're now waiting on
    // model output, distinct from the earlier '▶ /path/to/claude'
    // spawn row.
    return {
      captureSession: true,
      event: { type: 'status', status: 'running' },
    };
  }
  if (type === 'log') {
    // claude --verbose emits these for MCP / hook / tool-router
    // internals. We used to drop them as an unknown type; they're
    // exactly the "why is the CLI silent for 20s" signal users were
    // missing.
    const lvl = obj?.log?.level || obj?.level;
    const msg = obj?.log?.message || obj?.message || '';
    if (typeof msg !== 'string' || !msg) return undefined;
    return {
      event: {
        type: 'log',
        level: levelOrInfo(lvl),
        message: msg,
        source: 'claude',
      },
    };
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
      // content_block_start for a tool_use ALWAYS has an empty `input`
      // here — claude streams the actual input character-by-character
      // through `input_json_delta` notifications and folds them at
      // content_block_stop / in the assistant block. Emitting the
      // start event surfaced as a confusing `■ Bash · 开始 · {}`
      // duplicate of the proper `■ Bash · 开始 · {"command":...}` row
      // the assistant block produces a few hundred ms later.
      // Same reason `input_json_delta` is intentionally not rendered
      // (see the content_block_delta branch above) — we wait for the
      // assistant block to emit one row with the complete input.
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
    // Extract usage in the same shape multica daemon does
    // (input_tokens / output_tokens / cache_read_input_tokens /
    // cache_creation_input_tokens). Model lives on the message
    // sibling sometimes; fall back to root `model` if present.
    const usage = extractClaudeUsage(obj);
    // Carry usage on the status event too so the rail can render
    // "● result · in=N out=M cache=K" at turn end — claude only emits
    // usage once (not streaming like codex/opencode), so without this
    // the rail's last row is a bare `● result` and the user has no
    // sense of how much the turn cost. The terminal record carries it
    // alongside for the done event path.
    return {
      event: {
        type: 'status',
        status: ok ? 'result' : 'error',
        ...(usage ? { usage } : {}),
      },
      terminal: { status: ok ? 'completed' : 'failed', text, error, usage },
    };
  }
  return undefined;
}

/** Pull token-usage fields out of a claude-code `type:result` record
 *  into our normalized shape. Returns undefined when no recognizable
 *  numeric fields are present so the caller can omit the `usage` key
 *  rather than emit zeros. Exposed for unit testing.
 *
 *  Reads from THREE root fields:
 *    - `usage.{input,output,cache_read,cache_creation}_input_tokens`
 *    - `total_cost_usd` (claude tracks the dollars itself)
 *    - `message.model` / `model` (string)
 */
export function extractClaudeUsage(obj: any): undefined | {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
  cost?: number;
  model?: string;
} {
  const u = obj?.usage;
  const haveUsage = u && typeof u === 'object';
  const out: Record<string, number | string> = {};
  if (haveUsage) {
    if (typeof u.input_tokens === 'number') out.input = u.input_tokens;
    if (typeof u.output_tokens === 'number') out.output = u.output_tokens;
    if (typeof u.cache_read_input_tokens === 'number') out.cacheRead = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === 'number') out.cacheCreate = u.cache_creation_input_tokens;
  }
  if (typeof obj?.total_cost_usd === 'number' && Number.isFinite(obj.total_cost_usd)) {
    out.cost = obj.total_cost_usd;
  }
  const model = obj?.message?.model || obj?.model;
  if (typeof model === 'string' && model) out.model = model;
  return Object.keys(out).length ? (out as any) : undefined;
}

/** Sum two normalized usage records numeric-field-wise. `model` follows
 *  last-write-wins (multi-model turns are rare but possible). Used by
 *  the claude backend to accumulate per-`assistant`-block snapshots
 *  into a running total — exposed via `status:'usage'` events so the
 *  rail shows a live token counter without waiting for the terminal
 *  result record. Mirrors multica's per-model usage map (we collapse
 *  to a single flat record since the rail only renders one usage row). */
function mergeUsage(
  acc: Record<string, number | string> | undefined,
  inc: Record<string, number | string>,
): Record<string, number | string> {
  const out: Record<string, number | string> = { ...(acc || {}) };
  for (const k of ['input', 'output', 'cacheRead', 'cacheCreate']) {
    const a = typeof out[k] === 'number' ? (out[k] as number) : 0;
    const i = typeof inc[k] === 'number' ? (inc[k] as number) : 0;
    if (a || i) out[k] = a + i;
  }
  if (typeof inc.model === 'string' && inc.model) out.model = inc.model;
  return out;
}
