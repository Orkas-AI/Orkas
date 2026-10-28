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
 * Older builds emit this envelope on stderr; newer builds can use stdout.
 * Both channels are decoded as buffered native replies. Only diagnostics outside
 * the consumed envelope reach the process rail. Total captured output is bounded
 * to 8 MiB; an overrun fails the dispatch instead of retaining unlimited memory.
 * OpenClaw reply delivery remains buffered rather than token streaming.
 */

import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
  stripAnsi,
  LineSplitter,
  reapCliAfterProtocolTerminal,
} from './base.js';

import { prepareOpenclawBridge } from './openclaw-bridge.js';

const log = createLogger('local-agents:openclaw');

export const openclawBackend: LocalBackend = {
  async run(opts: BackendRunOptions): Promise<void> {
    const sessionId = opts.resumeSessionId || crypto.randomUUID();
    const args = buildOpenclawArgs(opts, sessionId);
    const bridgeConfig = await prepareOpenclawBridge(opts);
    try {
      const child = spawnCli(opts.binPath, args, opts.cwd, bridgeConfig.env);
      const detachAbort = bindAbort(child, opts.signal);
      const tail = new StderrTail();
      const startedAt = Date.now();

      let exited = false;
      let fullStdout = '';
      let pendingStderr = '';
      let replyPending = false;
      let capturedBytes = 0;
      let outputOverflow = false;
      // Native replies are buffered envelopes, not token streams. Bound both
      // channels together, including malformed/unterminated output.
      const accept = (chunk: string) => {
        if (outputOverflow) return false;
        capturedBytes += Buffer.byteLength(chunk);
        if (capturedBytes <= 8 * 1024 * 1024) return true;
        outputOverflow = true;
        reapCliAfterProtocolTerminal(child, 0);
        return false;
      };

      opts.onEvent({
        type: 'process-info',
        pid: child.pid ?? -1,
        cwd: opts.cwd,
        cmd: opts.binPath,
        args,
      });

      const watchdog = armKillWatchdog(child, {
        timeoutMs: opts.timeoutMs,
        deadlineAt: opts.deadlineAt,
        idleKillMs: opts.idleKillMs,
        lastEventAt: opts.lastEventAt,
      });

      // openclaw doesn't read stdin; close so it doesn't wait.
      child.stdin.end();

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (accept(chunk)) fullStdout += chunk;
      });
      const stderrLines = new LineSplitter();
      const stderrLine = (raw: string) => {
        const line = stripAnsi(raw);
        if (!replyPending && line.trim().startsWith('{')) {
          try {
            const record = JSON.parse(line);
            replyPending = Array.isArray(record?.payloads) || record?.ok === false || (typeof record?.error === 'string' && !record.level && !record._meta);
          } catch { replyPending = true; }
        }
        if (replyPending) pendingStderr += line + '\n';
        else if (line.trim()) opts.onEvent({ type: 'stderr-line', line });
      };
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (!accept(chunk)) return;
        tail.push(chunk);
        stderrLines.push(chunk, stderrLine);
      });

      return await new Promise<void>(resolve => {
        const finish = (status: 'completed' | 'failed' | 'cancelled' | 'timeout', extra: Record<string, unknown> = {}) => {
          if (exited) return;
          exited = true;
          watchdog.disarm();
          detachAbort();
          opts.onEvent({
            type: 'done', status,
            durationMs: Date.now() - startedAt,
            ...extra,
          });
          resolve();
        };
        child.on('error', err => {
          log.warn('spawn error', { error: logErrorSummary(err) });
          finish('failed', {
            error: (err as Error).message,
            stderrTail: tail.toString(),
            failureKind: 'cli_spawn',
            retrySafe: true,
          });
        });
        child.on('close', code => {
          stderrLines.flush(stderrLine);
          if (opts.signal.aborted) return finish('cancelled');
          if (watchdog.fired()) return finish('timeout', { timeoutKind: watchdog.fired(), error: `cli ${watchdog.reason()}`, stderrTail: tail.toString() });

          if (outputOverflow) return finish('failed', { error: 'OpenClaw output exceeded the supported size.' });
          const stdoutReply = parseOpenclawReply(fullStdout);
          const stderrReply = parseOpenclawReply(pendingStderr);
          const parsed = stdoutReply || stderrReply;
          for (const text of [stdoutReply?.diagnostics ?? fullStdout, stderrReply?.diagnostics ?? pendingStderr]) {
            for (const line of text.split(/\r?\n/)) if (line.trim()) opts.onEvent({ type: 'stderr-line', line });
          }
          const replyText = parsed?.text || '';
          const media = parsed?.media || [];
          const files = parsed?.files || [];
          const sid = parsed?.sessionId || sessionId;

          if (replyText) {
            // Surface the reply as a single text-delta so the standard
            // delta-streaming path in bus.ts populates the bubble. (It
            // arrives at end-of-run, not token-by-token — see file header.)
            opts.onEvent({ type: 'text-delta', text: replyText });
          }
          if (media.length) {
            opts.onEvent({
              type: 'media-output',
              source: 'openclaw',
              items: media.map(uri => ({ uri })),
            });
          }
          if (files.length) {
            // OpenClaw's structured attachment envelope can point at arbitrary
            // documents (PDF/Office/etc.), not only previewable image/video
            // media. Keep those paths on the generic produced-file channel; the
            // group-chat boundary validates cwd ownership and existence before
            // exposing them in the deliverable footer.
            opts.onEvent({
              type: 'file-change',
              source: 'openclaw_attachment',
              paths: files,
            });
          }

          const usage = parsed?.usage;
          if (code === 0 && !parsed?.error && (replyText || media.length || files.length)) {
            return finish('completed', { output: replyText, sessionId: sid, ...(usage ? { usage } : {}) });
          }
          if (code === 0 && !parsed?.error && !replyText && !media.length && !files.length) {
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
    } finally { bridgeConfig.cleanup(); }
  },
};

export function buildOpenclawArgs(opts: Pick<BackendRunOptions,
  'resumeSessionId' | 'customArgs' | 'prompt' | 'timeoutMs' | 'modelOverride' | 'thinkingLevel' | 'cliFlags'
>, sessionId: string): string[] {
  // Per `openclaw agent --help` (2026.4.11):
  //   --local      run embedded agent (no gateway daemon needed)
  //   --json       structured output (lands on stderr in this version)
  //   --session-id required for any deterministic session
  //   --message    prompt body (argv, NOT stdin)
  // Optional: --timeout overrides the 600s default. Keep it aligned with the outer watchdog
  //   so the CLI does not self-timeout before Orkas' long-task cap.
  const args = ['agent', '--local', '--json', '--session-id', sessionId];
  if (opts.modelOverride) args.push('--model', opts.modelOverride);
  if (opts.thinkingLevel) args.push('--thinking', opts.thinkingLevel);
  if (opts.customArgs && opts.customArgs.length) args.push(...opts.customArgs);
  if (!hasOpenclawTimeoutArg(opts.customArgs)
    && (opts.cliFlags === undefined || opts.cliFlags.includes('--timeout'))) {
    args.push('--timeout', String(Math.max(1, Math.ceil(opts.timeoutMs / 1000))));
  }
  args.push('--message', opts.prompt);
  return args;
}

function hasOpenclawTimeoutArg(args: string[] | undefined): boolean {
  return (args || []).some((arg) => arg === '--timeout' || arg.startsWith('--timeout='));
}

/**
 * Decode a native top-level payload/error envelope from either output channel.
 * Reverse balancing scans once, ignores nested look-alikes, and retains text
 * outside the consumed envelope as diagnostics. This accepts diagnostic noise
 * around the reply without treating arbitrary stdout as model-authored text.
 *
 * Exposed for unit testing.
 */
export function parseOpenclawReply(stderrText: string):
  | null
  | { text: string; media: string[]; files: string[]; sessionId?: string; error?: string; usage?: Record<string, number | string>; diagnostics?: string } {
  if (!stderrText) return null;
  const clean = stripAnsi(stderrText);

  // Reverse balancing visits each byte once and parses disjoint top-level
  // objects only. Nested payload-like objects are not native reply envelopes.
  for (const { start, end } of openclawEnvelopeCandidates(clean)) {
    const candidate = clean.slice(start, end + 1);
    let obj: any;
    try { obj = JSON.parse(candidate); } catch { continue; }
    if (obj && typeof obj === 'object' && Array.isArray(obj.payloads)) {
      const text = (obj.payloads as any[])
        .map(p => (p && typeof p.text === 'string') ? p.text : '')
        .filter(s => s.length)
        .join('\n');
      const mediaCandidates = (obj.payloads as any[]).flatMap((payload): string[] => {
        if (!payload || typeof payload !== 'object') return [];
        return [payload.media, payload.mediaUrl, payload.mediaUrls]
          .flatMap(openclawStringValues)
          .map(value => value.trim())
          .filter(Boolean);
      });
      const explicitFileCandidates = (obj.payloads as any[]).flatMap((payload): string[] => {
        if (!payload || typeof payload !== 'object') return [];
        return [payload.path, payload.filePath]
          .flatMap(openclawStringValues)
          .map(value => value.trim())
          .filter(Boolean);
      });
      const media: string[] = [];
      const files: string[] = [];
      for (const candidate of mediaCandidates) {
        const localPath = openclawLocalAttachmentPath(candidate);
        if (localPath) files.push(localPath);
        else media.push(candidate);
      }
      files.push(...explicitFileCandidates);
      const sessionId = obj.meta?.agentMeta?.sessionId
        || obj.meta?.sessionId
        || undefined;
      const usage = _extractOpenclawUsage(
        obj.meta?.agentMeta?.usage || obj.meta?.usage,
        obj.meta?.agentMeta?.model || obj.meta?.agentMeta?.provider,
      );
      return {
        diagnostics: clean.slice(0, start) + clean.slice(end + 1),
        ...(obj.ok === false ? { error: typeof obj.error === 'string' ? obj.error : typeof obj.error?.message === 'string' ? obj.error.message : 'OpenClaw reported a failed run.' } : {}),
        text,
        media: Array.from(new Set(media)),
        files: Array.from(new Set(files)),
        sessionId,
        ...(usage ? { usage } : {}),
      };
    }
    if (obj && typeof obj === 'object' && ((typeof obj.error === 'string' && !obj.level && !obj._meta) || obj.ok === false)) {
      return { text: '', media: [], files: [], diagnostics: clean.slice(0, start) + clean.slice(end + 1),
        error: typeof obj.error === 'string' ? obj.error : typeof obj.error?.message === 'string' ? obj.error.message : 'OpenClaw reported a failed run.' };
    }
  }
  return null;
}

function openclawStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function openclawLocalAttachmentPath(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  if (/^file:/iu.test(candidate)) {
    try { return fileURLToPath(candidate); } catch { return candidate; }
  }
  if (/^(?:https?:|data:)/iu.test(candidate)) return null;
  // Treat another URI scheme as media rather than resolving it relative to
  // cwd. Exclude Windows drive paths (`C:\...`) from the scheme check.
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(candidate) && !/^[A-Za-z]:[\\/]/u.test(candidate)) {
    return null;
  }
  return candidate;
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

function* openclawEnvelopeCandidates(text: string): Generator<{ start: number; end: number }> {
  const stack: string[] = [];
  let end = -1;
  let inString = false;
  for (let i = text.length - 1; i >= 0; i--) {
    const char = text[i];
    if (char === '"') {
      if (!stack.length && !inString) continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '}' || char === ']') {
      if (!stack.length) end = i;
      stack.push(char);
    } else if (char === '{' || char === '[') {
      const expected = char === '{' ? '}' : ']';
      if (stack.at(-1) !== expected) { stack.length = 0; end = -1; continue; }
      stack.pop();
      if (!stack.length && char === '{' && end >= i) yield { start: i, end };
    }
  }
}
