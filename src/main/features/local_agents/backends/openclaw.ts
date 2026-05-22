/**
 * OpenClaw backend.
 *
 * Empirically verified against `openclaw 2026.4.11`:
 *
 *   openclaw agent --local --json --session-id <id> [--agent <name>]
 *                  [--timeout <seconds>] --message <prompt>
 *
 * — but unlike multica's older reference, this version emits its reply
 * NOT as NDJSON-on-stdout. Instead **all output goes to stderr**:
 *   - Skill / tool warnings prefixed with `[skills]` / `[tools]` …
 *   - At the end, a single pretty-printed JSON object:
 *
 *     {
 *       "payloads": [{ "text": "...", "mediaUrl": null }, ...],
 *       "meta": {
 *         "durationMs": 17149,
 *         "agentMeta": { "sessionId": "...", "provider": "...",
 *                        "model": "...", "usage": {...} }
 *       }
 *     }
 *
 * stdout is empty. So we collect stderr, scan for the trailing JSON
 * block, parse it, and surface `payloads[*].text` as the agent reply +
 * `meta.agentMeta.sessionId` as the resume key. Earlier stderr lines
 * (warnings, tool errors) are still forwarded as `stderr-line` events
 * for visibility in the debug rail.
 *
 * Streaming: openclaw doesn't push partial tokens. The user sees a
 * spinner / process rail until the run ends, then the full reply
 * lands at once. Token-streaming would require openclaw to support
 * NDJSON output mode; not available today.
 */

import * as crypto from 'node:crypto';
import { createLogger } from '../../../logger.js';
import {
  type LocalBackend,
  type BackendRunOptions,
  type LocalEvent,
  StderrTail,
  spawnCli,
  bindAbort,
} from './base.js';

const log = createLogger('local-agents:openclaw');

export const openclawBackend: LocalBackend = {
  async run(opts: BackendRunOptions): Promise<void> {
    const sessionId = opts.resumeSessionId || crypto.randomUUID();
    const args = buildOpenclawArgs(opts, sessionId);
    const child = spawnCli(opts.binPath, args, opts.cwd);
    const detachAbort = bindAbort(child, opts.signal);
    const tail = new StderrTail();
    const startedAt = Date.now();

    let exited = false;
    let timedOut = false;
    // openclaw writes everything to stderr; we accumulate the FULL
    // stderr (no cap — the trailing JSON blob we need to parse can
    // run several KB) AND keep a separate StderrTail for the
    // diagnostic snippet on failure.
    let fullStderr = '';

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

    // openclaw doesn't read stdin; close so it doesn't wait.
    child.stdin.end();

    // stdout is currently always empty for openclaw 2026.4.11 — keep a
    // best-effort listener anyway in case future versions start using
    // it (we'd surface the line as text-delta).
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (chunk) opts.onEvent({ type: 'text-delta', text: chunk });
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      fullStderr += chunk;
      tail.push(chunk);
      // Forward each line for the process rail. Strip ANSI escapes
      // so colored log prefixes don't leak into the UI.
      for (const line of chunk.split(/\r?\n/)) {
        if (line) opts.onEvent({ type: 'stderr-line', line: stripAnsi(line) });
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
          ...extra,
        });
        resolve();
      };
      child.on('error', err => {
        log.warn('spawn error', { error: (err as Error).message });
        finish('failed', { error: (err as Error).message, stderrTail: tail.toString() });
      });
      child.on('close', code => {
        if (opts.signal.aborted) return finish('cancelled');
        if (timedOut) return finish('timeout', { error: `cli exceeded ${opts.timeoutMs}ms`, stderrTail: tail.toString() });

        const parsed = parseOpenclawReply(fullStderr);
        const replyText = parsed?.text || '';
        const sid = parsed?.sessionId || sessionId;

        if (replyText) {
          // Surface the reply as a single text-delta so the standard
          // delta-streaming path in bus.ts populates the bubble. (It
          // arrives at end-of-run, not token-by-token — see file header.)
          opts.onEvent({ type: 'text-delta', text: replyText });
        }

        const usage = parsed?.usage;
        if (code === 0 && replyText) {
          return finish('completed', { output: replyText, sessionId: sid, ...(usage ? { usage } : {}) });
        }
        if (code === 0 && !replyText) {
          // Exit clean but no parseable reply → treat as failed so
          // the user sees an error bubble instead of an empty turn.
          return finish('failed', {
            error: 'openclaw exited cleanly but produced no agent reply (check stderr tail)',
            output: '',
            sessionId: sid,
            stderrTail: tail.toString(),
            ...(usage ? { usage } : {}),
          });
        }
        finish('failed', {
          error: parsed?.error || `openclaw exited with code ${code}`,
          output: replyText,
          sessionId: sid,
          stderrTail: tail.toString(),
          ...(usage ? { usage } : {}),
        });
      });
    });
  },
};

function buildOpenclawArgs(opts: BackendRunOptions, sessionId: string): string[] {
  // Per `openclaw agent --help` (2026.4.11):
  //   --local      run embedded agent (no gateway daemon needed)
  //   --json       structured output (lands on stderr in this version)
  //   --session-id required for any deterministic session
  //   --message    prompt body (argv, NOT stdin)
  // Optional: --agent <name> selects a pre-registered agent; --timeout
  //   overrides the 600s default.
  const args = ['agent', '--local', '--json', '--session-id', sessionId];
  if (opts.model) args.push('--agent', opts.model);
  if (opts.customArgs && opts.customArgs.length) args.push(...opts.customArgs);
  args.push('--message', opts.prompt);
  return args;
}

/** Strip ANSI color escape sequences. openclaw's `[skills]` /
 *  `[tools]` log lines are colorized; without this every stderr-line
 *  shows up in the UI with raw ESC[36m noise. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

/**
 * Find the trailing pretty-printed JSON object in openclaw's stderr
 * and pull out the user-facing reply + session id. The JSON lands AT
 * THE END of the stream, but earlier output (warnings, tool errors,
 * partial JSON from interrupted tools) means we can't just take the
 * first `{`. Strategy: walk backward from the end of the buffer
 * looking for a `{` whose matching `}` (counting balanced braces)
 * runs through to (or near) the end of the stream — that's the final
 * envelope object. Validate by parsing.
 *
 * Exposed for unit testing.
 */
export function parseOpenclawReply(stderrText: string):
  | null
  | { text: string; sessionId?: string; error?: string; usage?: Record<string, number | string> } {
  if (!stderrText) return null;
  const clean = stripAnsi(stderrText);

  // Walk backward through `{` candidates. The final `{` line in the
  // stream is highly likely to be the start of the reply envelope.
  // We try each candidate from latest to earliest until JSON.parse
  // succeeds AND the result has the shape we expect.
  const opens: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '{') opens.push(i);
  }
  for (let i = opens.length - 1; i >= 0; i--) {
    const start = opens[i];
    const end = findMatchingBrace(clean, start);
    if (end < 0) continue;
    const candidate = clean.slice(start, end + 1);
    let obj: any;
    try { obj = JSON.parse(candidate); } catch { continue; }
    if (obj && typeof obj === 'object' && Array.isArray(obj.payloads)) {
      const text = (obj.payloads as any[])
        .map(p => (p && typeof p.text === 'string') ? p.text : '')
        .filter(s => s.length)
        .join('\n');
      const sessionId = obj.meta?.agentMeta?.sessionId
        || obj.meta?.sessionId
        || undefined;
      const usage = _extractOpenclawUsage(
        obj.meta?.agentMeta?.usage || obj.meta?.usage,
        obj.meta?.agentMeta?.model || obj.meta?.agentMeta?.provider,
      );
      return { text, sessionId, ...(usage ? { usage } : {}) };
    }
    if (obj && typeof obj === 'object' && typeof obj.error === 'string') {
      return { text: '', error: String(obj.error) };
    }
  }
  return null;
}

/** Normalize openclaw's `meta.agentMeta.usage` block (or a fallback at
 *  `meta.usage`) into our shared usage shape. openclaw passes through
 *  whatever the upstream provider returned (Anthropic / OpenAI / etc.),
 *  so the keys are snake_case or camelCase depending on provider. We
 *  accept the most common spellings. Returns undefined when no number
 *  was extractable. Exposed indirectly via parseOpenclawReply tests. */
function _extractOpenclawUsage(
  raw: any,
  model: string | undefined,
): undefined | Record<string, number | string> {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = _num(raw.input_tokens, raw.inputTokens, raw.prompt_tokens);
  const output = _num(raw.output_tokens, raw.outputTokens, raw.completion_tokens);
  const cacheRead = _num(raw.cache_read_input_tokens, raw.cacheReadInputTokens, raw.cached_input_tokens);
  const cacheCreate = _num(raw.cache_creation_input_tokens, raw.cacheCreationInputTokens);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheCreate === undefined) {
    return undefined;
  }
  const out: Record<string, number | string> = {};
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheCreate !== undefined) out.cacheCreate = cacheCreate;
  if (typeof model === 'string' && model) out.model = model;
  return out;
}

function _num(...vals: any[]): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function findMatchingBrace(s: string, openIdx: number): number {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
