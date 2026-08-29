/**
 * OpenCode CLI backend.
 *
 * Correct invocation (per multica `opencode.go`; my earlier
 * `_text.ts` template was wrong — opencode doesn't take stdin and
 * `--print` isn't a flag):
 *
 *   opencode run --format json --dir <absolute-cwd> [--session <id>] <prompt>
 *
 * Notes:
 *   - Prompt is passed as the LAST positional argv (NOT stdin).
 *   - The selected project directory is passed explicitly because OpenCode
 *     otherwise prefers an inherited PWD over the process cwd.
 *   - Model selection is left to OpenCode's own configuration.
 *   - Resume: `--session <id>` (different flag name from claude).
 *   - Output: NDJSON events on stdout. We care about:
 *       step_start, text (part.text), tool_use (part.tool/callID/state),
 *       error (error.data.message), step_finish (token usage).
 *   - sessionID may appear at top-level event or under part.
 */

import * as path from 'node:path';
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
  isFileReadToolName,
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
    let textOut = '';
    let resultStatus: 'completed' | 'failed' | undefined;
    let resultError: string | undefined;
    let observedSessionId: string | undefined;
    // Most-recent per-step usage snapshot; step_finish events fire
    // throughout the turn, each carrying the cumulative-so-far. We
    // forward the latest as `done.usage` at termination.
    let lastUsage: Record<string, number | string> | undefined;

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

    // opencode reads prompt from argv; close stdin so it doesn't wait.
    child.stdin.end();

    const splitter = new LineSplitter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      splitter.push(chunk, line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let obj: any;
        try { obj = JSON.parse(trimmed); }
        catch {
          // Non-NDJSON line on stdout — surface so users see CLI's
          // own logging / startup banner instead of a silent gap.
          opts.onEvent({ type: 'raw-line', line: trimmed });
          return;
        }
        const ev = mapOpencodeEvent(obj);
        if (ev?.captureSessionId) observedSessionId = ev.captureSessionId;
        const events = ev?.events || (ev?.event ? [ev.event] : []);
        for (const event of events) {
          opts.onEvent(event);
          if (event.type === 'text-delta' && typeof (event as any).text === 'string') {
            textOut += (event as any).text as string;
          }
          if (event.type === 'status' && (event as any).status === 'usage') {
            const u = (event as any).usage;
            if (u && typeof u === 'object') lastUsage = u;
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
        watchdog.disarm();
        detachAbort();
        opts.onEvent({
          type: 'done', status,
          durationMs: Date.now() - startedAt,
          sessionId: observedSessionId,
          ...(lastUsage ? { usage: lastUsage } : {}),
          ...extra,
        });
        resolve();
      };
      child.on('error', err => {
        log.warn('spawn error', { error: logErrorSummary(err) });
        finish('failed', { error: (err as Error).message, stderrTail: tail.toString() });
      });
      child.on('close', code => {
        if (opts.signal.aborted) return finish('cancelled', { output: textOut });
        if (watchdog.fired()) return finish('timeout', { error: `cli ${watchdog.reason()}`, output: textOut, stderrTail: tail.toString() });
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

export function buildOpencodeArgs(opts: Pick<BackendRunOptions,
  'resumeSessionId' | 'customArgs' | 'prompt' | 'modelOverride' | 'thinkingLevel' | 'cwd'
>): string[] {
  const args = [
    'run',
    '--format', 'json',
    '--dangerously-skip-permissions',
  ];
  if (opts.resumeSessionId) args.push('--session', opts.resumeSessionId);
  if (opts.modelOverride) args.push('--model', opts.modelOverride);
  if (opts.thinkingLevel) args.push('--variant', opts.thinkingLevel);
  // Put the host-owned flag before custom arguments so a user-supplied `--`
  // terminator cannot turn it into prompt text. Stale custom --dir variants
  // are removed below, so there is still exactly one authoritative value.
  args.push('--dir', path.resolve(opts.cwd));
  if (opts.customArgs && opts.customArgs.length) {
    args.push(...withoutCustomProjectDir(opts.customArgs));
  }
  args.push(opts.prompt);
  return args;
}

/** Remove stale user-saved directory overrides before custom arguments are
 * appended. Keeping both relies on OpenCode's duplicate
 * flag precedence, which has changed between CLI parsers and can silently run
 * a task in the wrong project. */
function withoutCustomProjectDir(customArgs: readonly string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < customArgs.length; index += 1) {
    const arg = customArgs[index];
    if (arg === '--dir') {
      // Drop the paired stale value, but preserve a following option when
      // this custom flag was left dangling (`--dir --verbose`).
      if (index + 1 < customArgs.length && !customArgs[index + 1].startsWith('-')) index += 1;
      continue;
    }
    if (arg.startsWith('--dir=')) continue;
    filtered.push(arg);
  }
  return filtered;
}

/** Pure mapper for opencode NDJSON events. Exposed for unit testing. */
export function mapOpencodeEvent(obj: any):
  | undefined
  | {
      event?: LocalEvent;
      events?: LocalEvent[];
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
      const input = minimalOpencodeToolInput(state.input);
      // Current OpenCode JSON output commonly emits only the terminal tool
      // state. Keep non-terminal states compatible with older builds, while
      // making every terminal record self-contained for replay/rendering.
      if (
        status === 'completed'
        || status === 'success'
        || status === 'done'
        || status === 'error'
        || status === 'failed'
      ) {
        const output = typeof state.output === 'string'
          ? state.output
          : (state.output != null ? JSON.stringify(state.output) : '');
        const durationMs = opencodeToolDurationMs(state.time);
        const error = opencodeToolError(state.error);
        const isError = status === 'error' || status === 'failed' || !!error;
        const toolEvent: LocalEvent = {
          type: 'tool-event',
          tool: String(part.tool || 'tool'),
          callId: String(part.callID || part.id || ''),
          phase: 'result',
          ...(input ? { input } : {}),
          output,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(error ? { error } : {}),
          ...(isError ? { isError: true } : {}),
        };
        const mediaItems = opencodeImageAttachments(state.attachments);
        // Same guard as the claude backend: a file-read tool's attachments are
        // the file it read, not media the agent produced.
        if (mediaItems.length && !isFileReadToolName(part.tool)) {
          out!.event = toolEvent;
          out!.events = [toolEvent, {
            type: 'media-output',
            source: 'opencode',
            callId: String(part.callID || part.id || ''),
            items: mediaItems,
          }];
        } else {
          out!.event = toolEvent;
        }
      } else {
        out!.event = {
          type: 'tool-event',
          tool: String(part.tool || 'tool'),
          callId: String(part.callID || part.id || ''),
          phase: 'use',
          input: input ?? {},
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
    case 'step_finish': {
      // Carries per-step token usage. Surface as a status:'usage' event
      // when we can pull numbers out, so the rail renders a live
      // running counter; otherwise fall back to a debug log so users
      // still see that a step completed.
      const usage = extractOpencodeUsage(obj.part || obj);
      if (usage) {
        out!.event = { type: 'status', status: 'usage', usage };
      } else {
        out!.event = {
          type: 'log',
          level: 'debug',
          message: `step_finish: ${JSON.stringify(obj.part || obj).slice(0, 160)}`,
          source: 'opencode',
        };
      }
      return out;
    }
    case 'step_start':
      out!.event = { type: 'status', status: 'running' };
      return out;
    default:
      // Genuinely unknown opencode event — keep visible at level=info
      // so we notice when the wire format drifts (matches the codex
      // treatment).
      if (typeof obj.type === 'string' && obj.type) {
        out!.event = {
          type: 'log',
          level: 'info',
          message: `${obj.type}: ${JSON.stringify(obj).slice(0, 200)}`,
          source: 'opencode',
        };
        return out;
      }
      return out!.captureSessionId ? out : undefined;
  }
}

function opencodeImageAttachments(raw: unknown): Array<Record<string, string>> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): Array<Record<string, string>> => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const attachment = entry as Record<string, unknown>;
    const mediaType = typeof attachment.mime === 'string' ? attachment.mime.trim() : '';
    const uri = typeof attachment.url === 'string' ? attachment.url.trim() : '';
    if (!mediaType.toLowerCase().startsWith('image/') || !uri) return [];
    const name = typeof attachment.filename === 'string' ? attachment.filename.trim() : '';
    return [{ uri, mediaType, ...(name ? { name } : {}) }];
  });
}

const OPENCODE_COMMAND_INPUT_KEYS = ['command', 'cmd', 'script'] as const;
const OPENCODE_PATH_INPUT_KEYS = ['path', 'file', 'file_path', 'filePath', 'filename'] as const;
const MAX_OPENCODE_TOOL_INPUT_CHARS = 4_096;
const MAX_OPENCODE_TOOL_INPUT_FILES = 64;

/** Preserve only the input facts needed for a concise command/file process row.
 * OpenCode completed events can carry the full write body inside `state.input`;
 * that body must not enter persisted process events. */
function minimalOpencodeToolInput(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of [...OPENCODE_COMMAND_INPUT_KEYS, ...OPENCODE_PATH_INPUT_KEYS]) {
    const value = boundedOpencodeToolInputString(source[key]);
    if (value) out[key] = value;
  }

  if (Array.isArray(source.files)) {
    const files = source.files.slice(0, MAX_OPENCODE_TOOL_INPUT_FILES).flatMap((entry): unknown[] => {
      const stringPath = boundedOpencodeToolInputString(entry);
      if (stringPath) return [stringPath];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const file = entry as Record<string, unknown>;
      const pathOnly: Record<string, string> = {};
      for (const key of OPENCODE_PATH_INPUT_KEYS) {
        const value = boundedOpencodeToolInputString(file[key]);
        if (value) pathOnly[key] = value;
      }
      return Object.keys(pathOnly).length ? [pathOnly] : [];
    });
    if (files.length) out.files = files;
  }

  return Object.keys(out).length ? out : undefined;
}

function boundedOpencodeToolInputString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw
    ? raw.slice(0, MAX_OPENCODE_TOOL_INPUT_CHARS)
    : undefined;
}

function opencodeToolDurationMs(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const time = raw as Record<string, unknown>;
  const start = time.start;
  const end = time.end;
  if (
    typeof start !== 'number'
    || !Number.isFinite(start)
    || typeof end !== 'number'
    || !Number.isFinite(end)
    || end < start
  ) return undefined;
  return end - start;
}

function opencodeToolError(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw || undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const error = raw as Record<string, any>;
  const message = error.data?.message ?? error.message ?? error.name;
  return typeof message === 'string' && message ? message : undefined;
}

/** Extract token usage from an opencode `step_finish` event's `part`
 *  block. Opencode's wire format isn't entirely stable across versions;
 *  we accept the shapes observed in practice (tokens nested under
 *  `tokens.{input,output,cache}`) and inline at the top level.
 *  Exposed for unit testing. */
export function extractOpencodeUsage(part: any): undefined | Record<string, number | string> {
  if (!part || typeof part !== 'object') return undefined;
  const candidates: any[] = [];
  if (part.tokens) candidates.push(part.tokens);
  if (part.usage) candidates.push(part.usage);
  candidates.push(part);
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const input = numOrUndef(c.input, c.inputTokens, c.input_tokens);
    const output = numOrUndef(c.output, c.outputTokens, c.output_tokens);
    const cacheRead = numOrUndef(c.cache, c.cacheRead, c.cache_read, c.cache_read_input_tokens);
    if (input === undefined && output === undefined && cacheRead === undefined) continue;
    const out: Record<string, number | string> = {};
    if (input !== undefined) out.input = input;
    if (output !== undefined) out.output = output;
    if (cacheRead !== undefined) out.cacheRead = cacheRead;
    const model = part.model || part.providerID || part.modelID;
    if (typeof model === 'string' && model) out.model = model;
    return out;
  }
  return undefined;
}

function numOrUndef(...vals: any[]): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}
