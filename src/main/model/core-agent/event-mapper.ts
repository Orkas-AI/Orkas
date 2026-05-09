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
 *   retry      → {type:'progress', text: 'retrying · <friendly reason>'} —
 *                the raw reason (e.g. undici "terminated", "fetch failed",
 *                "ECONNRESET") is mapped to a user-facing string via
 *                `friendlyRetryReason`
 *   compaction → {type:'progress', text: 'compacted <before>→<after> tokens'}
 *   done (ok)  → {type:'final', text} then {type:'done'}
 *   done (err) → {type:'error', text: meta.error.message} then {type:'done'}
 *
 * The returned generator is ready to be `yield*`'d straight out of
 * `streamChatWithModel`.
 */

import { createLogger } from '../../logger';
import { t } from '../../i18n';
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
 * Translate a raw retry reason (usually `err.message` from core-agent) into
 * a short user-facing phrase. The raw strings come from undici / pi-ai /
 * provider SDKs and are English / code-like; the process panel is
 * user-facing so we map the common families here. The actual user-visible
 * string is resolved via i18n (`t()`).
 *
 * Unknown reasons fall back to a generic "network error" — the full
 * message is still in `data/logs/` for debugging.
 */
export function friendlyRetryReason(reason: string): string {
  const r = (reason || '').toLowerCase();
  if (!r) return t('errors.network');
  // 5xx gateway/upstream failures first — "504 Gateway Timeout" contains
  // the word "timeout" but is really an upstream problem, not our client.
  if (/\b(502|503|504)\b|bad gateway|service unavailable|gateway timeout/.test(r)) {
    return t('errors.network.unavailable');
  }
  if (/\btimeout\b|etimedout|und_err_connect_timeout|und_err_headers_timeout|und_err_body_timeout/.test(r)) {
    return t('errors.network.timeout');
  }
  if (/\bterminated\b|socket hang up|fetch failed|econnreset|epipe|und_err_socket/.test(r)) {
    return t('errors.network.connection_dropped');
  }
  if (/rate.?limit|429|too many requests/.test(r)) return t('errors.network.rate_limited');
  if (/\b500\b|internal server error/.test(r)) return t('errors.network.server_error');
  if (/\b529\b|overloaded/.test(r)) return t('errors.network.overloaded');
  if (/econnrefused/.test(r)) return t('errors.network.refused');
  if (/enetunreach|enetdown|eai_again/.test(r)) return t('errors.network.unreachable');
  return t('errors.network');
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
        yield {
          type: 'event',
          event: {
            stream: 'tool',
            data: { phase: 'start', id: ev.id, name: ev.name, arguments: ev.input },
          },
        };
        // The renderer formats the `tool` stream event into a single
        // `■ ${name} · ${phase} · ${detail}` line via `_formatEventLine`.
        // We used to also yield a parallel `progress: ▶ ${name} · ${arg}`
        // line that carried the same info — that produced duplicate rows
        // (one ■ and one ▶) for every tool call. Trust the event-stream
        // rendering as the single source of truth.
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
        // Same dedupe rationale as `tool_start`: the renderer renders the
        // `tool` end event as `■ name · <phase_end> · preview` (or
        // `✗ ...` on isError), where <phase_end> is i18n-resolved by
        // `_formatEventLine::phaseCn`, so the parallel
        // `✓ ${name} · ${preview}` progress yield was a duplicate. Removed.
        // Next assistant text turn (if any) should be visually separated
        // from the previous one — matches the old "join turns with \n\n" rule.
        if (turnStarted) pendingSeparator = true;
        break;
      }

      case 'retry': {
        const friendly = friendlyRetryReason(ev.reason);
        const prefix = ev.attempt <= 1 ? t('model.retrying') : t('model.retrying_n', { attempt: ev.attempt });
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
