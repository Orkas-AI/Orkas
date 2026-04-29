/**
 * Event mapper — translates core-agent `AgentRunEvent` objects into the
 * Orkas `StreamEvent` shape that `features/*` + the renderer already
 * consume (see `main/model/client.ts`'s StreamEvent export, and the
 * `_IPC_ROUTES` + renderer `process` handling in renderer/app.js).
 *
 * Mapping rules:
 *   text_delta → accumulated into `finalText`; surfaced as {type:'final'} at done
 *   tool_start → {type:'event', event:{stream:'tool', data:{phase:'start', id, name}}}
 *                + a {type:'progress'} line so the UI's log shows it even if
 *                  the process panel filters events
 *   tool_end   → {type:'event', event:{stream:'tool', data:{phase:'end', id, name, isError, result_preview}}}
 *   retry      → {type:'progress', text: '正在重试·<friendly reason>'} — raw
 *                reason (e.g. undici "terminated", "fetch failed", "ECONNRESET")
 *                is mapped to user-facing Chinese via `friendlyRetryReason`
 *   compaction → {type:'progress', text: 'compacted <before>→<after> tokens'}
 *   done (ok)  → {type:'final', text} then {type:'done'}
 *   done (err) → {type:'error', text: meta.error.message} then {type:'done'}
 *
 * The returned generator is ready to be `yield*`'d straight out of
 * `streamChatWithModel`.
 */

import { createLogger } from '../../logger';
import type { StreamEvent } from '../client';

const log = createLogger('model');

type CA = typeof import('#core-agent');
type AgentRunEvent = CA extends { AgentRunner: infer _ } ? import('#core-agent').AgentRunEvent : never;

/**
 * Short tool-result preview for the event log. Kept under ~300 chars so
 * the renderer's process panel doesn't blow up with multi-KB tool outputs
 * (the full body is already in the PersistentSession jsonl if needed).
 */
function resultPreview(s: string, max = 300): string {
  if (!s) return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/**
 * Pick the most human-readable slice of a tool's input for the single-line
 * progress log: bash → command, read/write/list → path, otherwise JSON.
 * The full `input` is still forwarded on the structured event so the UI
 * can render it richer if it wants to.
 */
function inputSummary(name: string, input: unknown, max = 80): string {
  if (input == null) return '';
  const pick = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
  };
  let raw = '';
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    if (name === 'bash') raw = pick(rec.command);
    else if (name === 'read_file' || name === 'write_file' || name === 'list_files') raw = pick(rec.path);
    if (!raw) {
      try { raw = JSON.stringify(input); } catch { raw = String(input); }
    }
  } else {
    raw = String(input);
  }
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/**
 * Translate a raw retry reason (usually `err.message` from core-agent) into
 * a short Chinese phrase the user can actually read. The raw strings come
 * from undici / pi-ai / provider SDKs and are English / code-like; the
 * process panel is user-facing so we map the common families here.
 *
 * Unknown reasons fall back to a generic "网络异常" — the full message is
 * still in `data/logs/` for debugging.
 */
export function friendlyRetryReason(reason: string): string {
  const r = (reason || '').toLowerCase();
  if (!r) return '网络异常';
  // 5xx gateway/upstream failures first — "504 Gateway Timeout" contains
  // the word "timeout" but is really an upstream problem, not our client.
  if (/\b(502|503|504)\b|bad gateway|service unavailable|gateway timeout/.test(r)) {
    return '服务暂时不可用';
  }
  if (/\btimeout\b|etimedout|und_err_connect_timeout|und_err_headers_timeout|und_err_body_timeout/.test(r)) {
    return '响应超时';
  }
  if (/\bterminated\b|socket hang up|fetch failed|econnreset|epipe|und_err_socket/.test(r)) {
    return '连接中断';
  }
  if (/rate.?limit|429|too many requests/.test(r)) return '服务限流';
  if (/\b500\b|internal server error/.test(r)) return '服务端错误';
  if (/\b529\b|overloaded/.test(r)) return '服务繁忙';
  if (/econnrefused/.test(r)) return '连接被拒绝';
  if (/enetunreach|enetdown|eai_again/.test(r)) return '网络不可达';
  return '网络异常';
}

/**
 * Consume a core-agent event stream and yield Orkas-shape events.
 * Does NOT yield the terminal `{type:'done'}` — the caller appends that
 * in its own `finally` (same pattern as the openclaw client).
 */
export async function* mapCoreAgentEvents(
  events: AsyncIterable<AgentRunEvent>,
): AsyncGenerator<StreamEvent, { finalText: string; error: string | null }, unknown> {
  let finalText = '';
  let error: string | null = null;

  // Separator between turns (tool-loop interim commentary + final answer).
  // Inserted lazily on the first delta of a new turn so we don't append a
  // stray "\n\n" at the end of the accumulated text.
  let turnStarted = finalText.length > 0;
  let pendingSeparator = false;

  for await (const ev of events) {
    switch (ev.type) {
      case 'text_delta': {
        const piece = ev.text || '';
        if (!piece) break;
        if (pendingSeparator) {
          finalText += '\n\n';
          yield { type: 'delta', text: '\n\n' };
          pendingSeparator = false;
        }
        finalText += piece;
        turnStarted = true;
        // Surface each delta so the renderer can paint text as it arrives.
        yield { type: 'delta', text: piece };
        break;
      }

      case 'tool_start': {
        const argStr = inputSummary(ev.name, ev.input);
        yield {
          type: 'event',
          event: {
            stream: 'tool',
            data: { phase: 'start', id: ev.id, name: ev.name, arguments: ev.input },
          },
        };
        yield {
          type: 'progress',
          text: argStr ? `▶ ${ev.name} · ${argStr}` : `▶ ${ev.name}`,
        };
        break;
      }

      case 'tool_end': {
        const preview = resultPreview(ev.result || '');
        yield {
          type: 'event',
          event: {
            stream: 'tool',
            data: {
              phase: 'end',
              id: ev.id,
              name: ev.name,
              isError: !!ev.isError,
              result_preview: preview,
            },
          },
        };
        const shortPreview = preview.length > 80 ? preview.slice(0, 80) + '…' : preview;
        const marker = ev.isError ? '✗' : '✓';
        const tail = shortPreview ? ` · ${shortPreview}` : (ev.isError ? ' failed' : '');
        yield {
          type: 'progress',
          text: `${marker} ${ev.name}${tail}`,
        };
        // Next assistant text turn (if any) should be visually separated
        // from the previous one — matches the old "join turns with \n\n" rule.
        if (turnStarted) pendingSeparator = true;
        break;
      }

      case 'retry': {
        const friendly = friendlyRetryReason(ev.reason);
        const prefix = ev.attempt <= 1 ? '正在重试' : `正在第 ${ev.attempt} 次重试`;
        yield { type: 'progress', text: `${prefix}·${friendly}` };
        break;
      }

      case 'compaction':
        yield {
          type: 'progress',
          text: `compacted ${ev.tokensBefore}→${ev.tokensAfter} tokens`,
          event: ev.summary ? { stream: 'compaction', data: { summary: ev.summary } } : undefined,
        };
        break;

      case 'done': {
        const result = ev.result;
        // Forward the accumulated token usage (input / output / cache read /
        // cache write) for downstream cost / cache-hit observation. For
        // providers whose pi-ai adapter hard-codes cache fields to 0 (Mistral,
        // openai-responses write side) the value will be 0 — documented
        // behavior, not a bug on our side.
        if (result.meta.usage) {
          yield {
            type: 'event',
            event: { stream: 'usage', data: result.meta.usage as unknown as Record<string, unknown> },
          };
        }
        if (result.meta.error) {
          error = result.meta.error.message || 'unknown error';
          // meta.error is `{kind, message}` — cause/stack live on the
          // ProviderError that runner.ts already logged via `log.warn(...)`
          // on the retry path. Keep this line focused on what survives.
          log.warn('core-agent done with error', {
            error,
            kind: result.meta.error.kind,
            model: result.meta.model,
            provider: result.meta.provider,
            durationMs: result.meta.durationMs,
          });
        } else {
          // Prefer the explicit `result.text` over our accumulated delta —
          // the runner may have trimmed trailing whitespace etc.
          if (result.text) finalText = result.text;
        }
        break;
      }

      default:
        // Unknown event type — ignore rather than throw so a future
        // core-agent release can add events without breaking this client.
        break;
    }
  }

  if (error) {
    yield { type: 'error', text: error };
  } else if (finalText) {
    yield { type: 'final', text: finalText };
  } else {
    yield { type: 'error', text: 'empty response' };
  }

  return { finalText, error };
}
