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
 *   tool_progress → {type:'event', event:{stream:'tool', data:{phase:'progress', id, name, message}}}
 *   tool_end   → {type:'event', event:{stream:'tool', data:{phase:'end', id, name, isError, result_preview}}}
 *                + optional errorCode/errorSeverity for recoverable guard rails
 *   retry      → {type:'progress', text: 'retrying · <friendly reason>'} —
 *                the raw reason (e.g. undici "terminated", "fetch failed",
 *                "ECONNRESET") is mapped to a user-facing string via
 *                `friendlyRetryReason`
 *   provider_fallback → non-blocking credential warning; the run continues
 *                       on the next configured candidate
 *   context_status → {type:'progress', text: '<message>'}
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
import { parseSkillPath } from '../../features/expert_signals/skill_path';
import { userAgentsDir, userMarketplaceAgentsDir, userSystemSkillsDir } from '../../paths';
import { providerLabel } from '../provider_catalog';
import * as path from 'node:path';

const log = createLogger('model');

type CA = typeof import('#core-agent');
type AgentRunEvent = CA extends { AgentRunner: infer _ } ? import('#core-agent').AgentRunEvent : never;

export interface MapCoreAgentEventsOptions {
  userId?: string;
  /** UI-only metadata collected while rendering the skills prompt block.
   *  This avoids a second skill scan and does not change model-visible text. */
  skillDisplayNameById?: ReadonlyMap<string, string>;
  /** UI-only metadata collected before the run starts. Used to label
   *  read_file(agent.json) process rows without scanning agents again. */
  agentDisplayNameById?: ReadonlyMap<string, string>;
}

export interface SkillReadEventMetadata {
  skill_id: string;
  skill_name: string;
  skill_system: 'A.custom' | 'A.platform' | 'B' | 'system';
}

export interface AgentReadEventMetadata {
  agent_id: string;
  agent_name: string;
  agent_system: 'custom' | 'marketplace';
}

type AgentErrorMeta = {
  kind: 'auth' | 'rate_limit' | 'context_overflow' | 'timeout' | 'provider_error';
  code?: string;
};

function modelFailureDetails(
  error: AgentErrorMeta,
  hasVisibleText: boolean,
): Pick<StreamEvent, 'failureKind' | 'failureCode' | 'failurePhase'> {
  const code = String(error.code || '').trim().toUpperCase();
  let failureCode = 'provider_error';
  let failurePhase: NonNullable<StreamEvent['failurePhase']> = hasVisibleText ? 'model_text' : 'provider_wait';

  if (code === 'PROVIDER_NO_FIRST_EVENT_TIMEOUT') failureCode = 'provider_no_first_event';
  else if (code === 'PROVIDER_NETWORK_EXHAUSTED' || /^(ECONN|ENET|EAI_|ETIMEDOUT|UND_ERR_)/.test(code)) failureCode = 'provider_network';
  else if (code === 'NO_PROVIDER') failureCode = 'provider_not_configured';
  else if (error.kind === 'auth' || code === 'PROVIDER_AUTH_EXHAUSTED') failureCode = 'provider_auth';
  else if (error.kind === 'rate_limit' || code === 'PROVIDER_RATE_LIMIT_EXHAUSTED') failureCode = 'provider_rate_limit';
  else if (error.kind === 'context_overflow') {
    failureCode = 'context_overflow';
    failurePhase = 'compaction';
  } else if (error.kind === 'timeout') failureCode = 'provider_timeout';
  else if (/BALANCE|QUOTA|CREDIT|FUNDS|PAYMENT/.test(code)) failureCode = 'provider_balance';
  else if (/PERMISSION|FORBIDDEN|PLAN_REQUIRED|SUBSCRIPTION/.test(code)) failureCode = 'provider_permission';
  else if (/INVALID_REQUEST|INVALID_ARGUMENT|INVALID_SCHEMA|MODEL_NOT_FOUND|UNSUPPORTED_MODEL/.test(code)) failureCode = 'provider_request';

  return { failureKind: 'model', failureCode, failurePhase };
}

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

const TOOL_INPUT_STREAM_START_NAMES = new Set([
  'write_file',
  'edit_file',
  'create_artifact',
  'markdown_to_pdf',
  'html_to_pdf',
]);

function partialJsonStringField(source: string, field: string): string {
  if (!source) return '';
  const re = new RegExp(`"${field}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)`);
  const m = re.exec(source);
  if (!m) return '';
  try {
    return JSON.parse(`"${m[1].replace(/"$/, '')}"`);
  } catch {
    return m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
  }
}

/**
 * When `util/tool-result-cap.ts` spills an oversized in-process tool
 * result to disk, it rewrites `result.content` into a
 * `<persisted-output ref="..." ...>` marker. New runners carry the backing
 * path as model-hidden `tool_end.persistedOutput` metadata. This legacy parser
 * remains for old persisted sessions/events whose marker embedded the path.
 *
 * Returns `{ path, size }` when the marker is present, `null` otherwise
 * (most tool calls don't spill — their result is just the raw output
 * string, exposed directly through the `output` field on the event).
 *
 * Exposed for unit testing.
 */
export function extractPersistedOutputPath(result: string): { path: string; size: number } | null {
  if (!result || typeof result !== 'string') return null;
  // Match the opening tag only; the body and closing tag can be huge.
  // tool-result-cap.ts owns the format — keep this regex in sync.
  const m = /<persisted-output\b[^>]*?\bsize="(\d+)"[^>]*?\bpath="([^"]+)"/.exec(result);
  if (!m) return null;
  return { path: m[2], size: Number(m[1]) };
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
  if (/\bcodex sse response headers timed out after \d+ms\b|\bsse response headers timed out\b|\bresponse headers? (timed out|timeout)\b|\bheaders? (timed out|timeout)\b|\btimed out\b|\btimeout\b|etimedout|und_err_connect_timeout|und_err_headers_timeout|und_err_body_timeout/.test(r)) {
    return t('errors.network.timeout');
  }
  if (/\bterminated\b|stream ended without finish_reason|missing finish_reason|without finish_reason|missing final (chunk|event)|without final (chunk|event)|socket (hang up|closed|close)|fetch failed|websocket (error|closed|close)|\bws (error|closed|close)\b|connection (closed|close|reset|dropped|terminated)|stream (closed|close|interrupted|disconnected|reset|terminated)|premature close|err_stream_premature_close|econnreset|epipe|und_err_socket/.test(r)) {
    return t('errors.network.connection_dropped');
  }
  if (/rate.?limit|429|too many requests/.test(r)) return t('errors.network.rate_limited');
  if (/\b500\b|internal server error/.test(r)) return t('errors.network.server_error');
  if (/\b529\b|overloaded/.test(r)) return t('errors.network.overloaded');
  if (/econnrefused/.test(r)) return t('errors.network.refused');
  if (/enetunreach|enetdown|eai_again/.test(r)) return t('errors.network.unreachable');
  return t('errors.network');
}

function localizeKnownRunnerText(text: string): string {
  const trimmed = String(text || '').trim();
  if (trimmed === '(Tool loop limit reached)') return t('model.tool_loop_limit_reached');
  if (trimmed === 'Run aborted') return t('model.run_aborted');
  if (trimmed === 'Max retries exceeded') return t('model.max_retries_exceeded');
  if (trimmed === 'empty response') return t('model.empty_response');
  return text;
}

function toolInputPath(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return '';
  const p = (input as Record<string, unknown>).path;
  return typeof p === 'string' ? p : '';
}

export function skillReadMetadataForToolStart(
  toolName: string,
  input: unknown,
  opts: MapCoreAgentEventsOptions = {},
): SkillReadEventMetadata | null {
  if (toolName !== 'read_file' || !opts.userId) return null;
  const p = toolInputPath(input);
  if (!p) return null;

  // Product-protocol and owner-private skills are intentionally absent from
  // the public skill registry, so parse their runtime roots before falling
  // back to the expert-signal parser. The metadata here is UI-only: carrying
  // it from tool_start to tool_end prevents the process pane from exposing a
  // full internal path or a persisted-output marker for these reads.
  const hidden = parseHiddenSkillReadPath(p, opts.userId);
  if (hidden) {
    return {
      skill_id: hidden.skill_id,
      skill_name: hidden.skill_id,
      skill_system: hidden.system,
    };
  }

  const parsed = parseSkillPath(p, opts.userId);
  if (!parsed) return null;
  const display = opts.skillDisplayNameById?.get(parsed.skill_id) || parsed.skill_id;
  return {
    skill_id: parsed.skill_id,
    skill_name: display,
    skill_system: parsed.system,
  };
}

function parseHiddenSkillReadPath(
  absPath: string,
  uid: string,
): { system: 'system' | 'B'; skill_id: string } | null {
  const abs = path.resolve(absPath);
  if (path.basename(abs) !== 'SKILL.md') return null;

  const system = _skillSegmentsUnderRoot(abs, userSystemSkillsDir(uid), 1);
  if (system) return { system: 'system', skill_id: system[0] };

  // Platform/builtin agent-private skills:
  // <uid>/local/marketplace/agents/<aid>/skills/<sid>/SKILL.md
  const platformPrivate = _skillSegmentsUnderRoot(abs, userMarketplaceAgentsDir(uid), 3);
  if (platformPrivate?.[1] === 'skills') {
    return { system: 'B', skill_id: platformPrivate[2] };
  }

  // Custom owner-private skills use `private_skills`; self-evolved `skills`
  // under the same agent root are already handled by parseSkillPath().
  const customPrivate = _skillSegmentsUnderRoot(abs, userAgentsDir(uid), 3);
  if (customPrivate?.[1] === 'private_skills') {
    return { system: 'B', skill_id: customPrivate[2] };
  }

  return null;
}

function _skillSegmentsUnderRoot(abs: string, root: string, expectedDirSegments: number): string[] | null {
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const segments = rel.split(path.sep);
  if (segments.length !== expectedDirSegments + 1 || segments[segments.length - 1] !== 'SKILL.md') {
    return null;
  }
  return segments.slice(0, expectedDirSegments);
}

export function agentReadMetadataForToolStart(
  toolName: string,
  input: unknown,
  opts: MapCoreAgentEventsOptions = {},
): AgentReadEventMetadata | null {
  if (toolName !== 'read_file' || !opts.userId) return null;
  const p = toolInputPath(input);
  if (!p) return null;
  const parsed = parseAgentJsonPath(p, opts.userId);
  if (!parsed) return null;
  const display = opts.agentDisplayNameById?.get(parsed.agent_id) || parsed.agent_id;
  return {
    agent_id: parsed.agent_id,
    agent_name: display,
    agent_system: parsed.system,
  };
}

function skillReadEventFields(meta: SkillReadEventMetadata | null): Record<string, unknown> {
  if (!meta) return {};
  return {
    skill_id: meta.skill_id,
    skill_name: meta.skill_name,
    skill_system: meta.skill_system,
    skill_file: 'SKILL.md',
  };
}

function agentReadEventFields(meta: AgentReadEventMetadata | null): Record<string, unknown> {
  if (!meta) return {};
  return {
    agent_id: meta.agent_id,
    agent_name: meta.agent_name,
    agent_system: meta.agent_system,
    agent_file: 'agent.json',
  };
}

function parseAgentJsonPath(absPath: string, uid: string): { system: 'custom' | 'marketplace'; agent_id: string } | null {
  if (!absPath || !uid) return null;
  const abs = path.resolve(absPath);
  if (path.basename(abs) !== 'agent.json') return null;

  const custom = _tryAgentUnderRoot(abs, userAgentsDir(uid));
  if (custom) return { system: 'custom', agent_id: custom };

  const marketplace = _tryAgentUnderRoot(abs, userMarketplaceAgentsDir(uid));
  if (marketplace) return { system: 'marketplace', agent_id: marketplace };

  return null;
}

function _tryAgentUnderRoot(abs: string, root: string): string | null {
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const segments = rel.split(path.sep);
  if (segments.length !== 2 || segments[1] !== 'agent.json') return null;
  return segments[0] || null;
}

/**
 * Consume a core-agent event stream and yield Orkas-shape events.
 * Does NOT yield the terminal `{type:'done'}` — the caller appends that
 * in its own `finally` (same pattern as the openclaw client).
 */
export async function* mapCoreAgentEvents(
  events: AsyncIterable<AgentRunEvent>,
  opts: MapCoreAgentEventsOptions = {},
): AsyncGenerator<StreamEvent, { finalText: string; error: string | null }, unknown> {
  let finalText = '';
  let error: string | null = null;
  let failureDetails: Pick<StreamEvent, 'failureKind' | 'failureCode' | 'failurePhase'> | null = null;
  const skillReadByToolId = new Map<string, SkillReadEventMetadata>();
  const agentReadByToolId = new Map<string, AgentReadEventMetadata>();
  const earlyToolStarts = new Set<string>();
  const toolDeltaNames = new Map<string, string>();
  const toolDeltaInputPreviews = new Map<string, string>();

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

      case 'tool_delta': {
        const id = ev.id || 'stream_tool';
        const name = String(ev.name || toolDeltaNames.get(id) || '');
        if (name) toolDeltaNames.set(id, name);
        if (!name || !TOOL_INPUT_STREAM_START_NAMES.has(name) || earlyToolStarts.has(id)) break;
        const delta = String(ev.inputDelta || '');
        if (!delta) break;
        const inputPreview = (toolDeltaInputPreviews.get(id) || '') + delta;
        toolDeltaInputPreviews.set(id, inputPreview.slice(0, 8192));
        const pathHint = partialJsonStringField(inputPreview, 'path')
          || partialJsonStringField(inputPreview, 'filename')
          || partialJsonStringField(inputPreview, 'title');
        if (!pathHint) break;
        earlyToolStarts.add(id);
        yield {
          type: 'event',
          event: {
            stream: 'tool',
            data: {
              phase: 'start',
              id,
              name,
              ...(pathHint ? { arguments: { path: pathHint } } : {}),
            },
          },
        };
        break;
      }

      case 'tool_start': {
        toolDeltaNames.delete(ev.id);
        toolDeltaInputPreviews.delete(ev.id);
        const skillMeta = skillReadMetadataForToolStart(ev.name, ev.input, opts);
        if (skillMeta) skillReadByToolId.set(ev.id, skillMeta);
        const agentMeta = agentReadMetadataForToolStart(ev.name, ev.input, opts);
        if (agentMeta) agentReadByToolId.set(ev.id, agentMeta);
        if (earlyToolStarts.has(ev.id)) break;
        yield {
          type: 'event',
          event: {
            stream: 'tool',
            data: {
              phase: 'start',
              id: ev.id,
              name: ev.name,
              arguments: ev.input,
              ...skillReadEventFields(skillMeta),
              ...agentReadEventFields(agentMeta),
            },
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

      case 'tool_progress': {
        yield {
          type: 'event',
          event: {
            stream: 'tool',
            data: {
              phase: 'progress',
              id: ev.id,
              name: ev.name,
              message: ev.message,
              ...(ev.phase ? { progress_phase: ev.phase } : {}),
              ...(ev.data ? { progress_data: ev.data } : {}),
            },
          },
        };
        break;
      }

      case 'tool_end': {
        const rawResult = ev.result || '';
        const preview = resultPreview(rawResult);
        earlyToolStarts.delete(ev.id);
        toolDeltaNames.delete(ev.id);
        toolDeltaInputPreviews.delete(ev.id);
        const skillMeta = skillReadByToolId.get(ev.id) || null;
        skillReadByToolId.delete(ev.id);
        const agentMeta = agentReadByToolId.get(ev.id) || null;
        agentReadByToolId.delete(ev.id);
        // Two click-to-expand storage paths, decided here:
        //   - oversized → util/tool-result-cap.ts already spilled to disk and
        //     tool_end carries model-hidden persistedOutput metadata. Pass its
        //     absolute path so the renderer reads back via
        //     localAgents.readToolResult IPC.
        //   - normal    → rawResult IS the full body (within its token budget).
        //     Pass it inline so the renderer stashes on the row and
        //     renders directly without IO. The model already saw this
        //     same body — sending it twice (event + persistent session) stays
        //     within the configured inline budget.
        const spill = ev.persistedOutput
          ? { path: ev.persistedOutput.path, size: ev.persistedOutput.size }
          : extractPersistedOutputPath(rawResult);
        const data: Record<string, unknown> = {
          phase: 'end',
          id: ev.id,
          name: ev.name,
          isError: !!ev.isError,
          result_preview: preview,
          ...(Number.isFinite(ev.durationMs) ? { duration_ms: Math.max(0, Math.round(ev.durationMs!)) } : {}),
          ...(ev.errorCode ? { errorCode: ev.errorCode } : {}),
          ...(ev.errorSeverity ? { errorSeverity: ev.errorSeverity } : {}),
          ...skillReadEventFields(skillMeta),
          ...agentReadEventFields(agentMeta),
        };
        if (spill) {
          data.result_path = spill.path;
          data.result_size = spill.size;
        } else if (rawResult) {
          data.output = rawResult;
        }
        yield {
          type: 'event',
          event: {
            stream: 'tool',
            data,
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
        yield {
          type: 'progress',
          text: `${prefix}·${friendly}`,
          event: {
            stream: 'runtime',
            data: {
              phase: 'retrying',
              attempt: Math.max(1, Math.round(Number(ev.attempt) || 1)),
              ...(Number.isFinite(Number(ev.waitMs)) ? { wait_ms: Math.max(0, Math.round(Number(ev.waitMs))) } : {}),
            },
          },
        };
        break;
      }

      case 'provider_fallback': {
        yield {
          type: 'progress',
          text: t(
            ev.reason === 'no_first_event_timeout' ? 'model.timeout_fallback' : 'model.credential_fallback',
            { provider: providerLabel(ev.providerId) },
          ),
          event: {
            stream: 'provider',
            data: { phase: 'fallback', reason: ev.reason, provider_id: ev.providerId },
          },
        };
        break;
      }

      case 'context_status': {
        yield {
          type: 'progress',
          text: ev.message,
          event: { stream: 'context', data: { phase: ev.phase, ...(ev.data || {}) } },
        };
        break;
      }

      case 'compaction':
        yield {
          type: 'progress',
          text: `compacted ${ev.tokensBefore}→${ev.tokensAfter} tokens`,
          event: {
            stream: 'compaction',
            data: {
              tokensBefore: ev.tokensBefore,
              tokensAfter: ev.tokensAfter,
              ...(ev.summary ? { summary: ev.summary } : {}),
              ...(ev.usage ? { usage: ev.usage as unknown as Record<string, unknown> } : {}),
              ...(Number.isFinite(ev.durationMs) ? { duration_ms: Math.max(0, Math.round(ev.durationMs!)) } : {}),
            },
          },
        };
        break;

      case 'done': {
        const result = ev.result;
        // Forward the accumulated token usage (input / output / cache read /
        // cache write) so downstream consumers — today just the dev archiver,
        // tomorrow a cost meter — can observe per-call spend. The devtools
        // panel displays cacheRead/inputTokens ratio as cache hit rate. For
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
          error = localizeKnownRunnerText(result.meta.error.message || 'unknown error');
          failureDetails = modelFailureDetails(result.meta.error, finalText.length > 0);
          // meta.error is `{kind, message}` — cause/stack live on the
          // ProviderError that runner.ts already logged via `log.warn(...)`
          // on the retry path. Keep this line focused on what survives.
          log.warn('core-agent done with error', {
            error_chars: error.length,
            kind: result.meta.error.kind,
            model: result.meta.model,
            provider: result.meta.provider,
            durationMs: result.meta.durationMs,
          });
        } else {
          // Prefer the explicit `result.text` over our accumulated delta —
          // the runner may have trimmed trailing whitespace etc.
          if (result.text) finalText = localizeKnownRunnerText(result.text);
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
    yield { type: 'error', text: error, ...failureDetails };
  } else if (finalText) {
    yield { type: 'final', text: finalText };
  } else {
    yield {
      type: 'error',
      text: localizeKnownRunnerText('empty response'),
      failureKind: 'model',
      failureCode: 'empty_response',
      failurePhase: 'provider_wait',
    };
  }

  return { finalText, error };
}
