/**
 * Event mapper — translates core-agent `AgentRunEvent` objects into the
 * Orkas `StreamEvent` shape that `features/*` + the renderer already
 * consume (see `main/model/client.ts`'s StreamEvent export, and the
 * `_IPC_ROUTES` + renderer `process` handling in renderer/app.js).
 *
 * Mapping rules:
 *   text_delta → native phases pass through; phase-less provider text is
 *                classified from structured model-round/tool events (never
 *                from natural-language content). Tool-using rounds become
 *                commentary; terminal rounds become final_answer.
 *   thinking   → structured reasoning lifecycle; this boundary sanitizes
 *                provider reasoning before UI/persistence, coalesces live
 *                updates, bounds their preview, and preserves full terminal text
 *   tool_delta → first named/id-bearing delta emits the visible
 *                {phase:'start'} milestone before argument assembly
 *   tool_start → emits {phase:'progress'} with complete input when an early
 *                milestone exists, otherwise falls back to {phase:'start'}
 *   tool_progress → {type:'event', event:{stream:'tool', data:{phase:'progress', id, name, message}}}
 *   tool_end   → {type:'event', event:{stream:'tool', data:{phase:'end', id, name, isError, result_preview}}}
 *                + optional errorCode/errorSeverity for recoverable guard rails
 *   retry      → {type:'progress', text: 'retrying · <friendly reason>'} —
 *                the raw reason (e.g. undici "terminated", "fetch failed",
 *                "ECONNRESET") is mapped to a user-facing string via
 *                `friendlyRetryReason`
 *   provider_fallback → non-blocking credential warning; the run continues
 *                       on the next configured candidate
 *   context_status → {type:'event', event:{stream:'context', data:{phase,...}}}
 *                    — semantic only; renderer localizes the phase
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
import { performance } from 'node:perf_hooks';
import {
  classifyTransientNetworkError,
  isStorageFullError,
} from '../../../core-agent/src/shared/errors';
import { classifyKeyFailure, type KeyFailureKind } from './auth-error';
import { sanitizeLogTextForUpload } from '../../util/log-sanitize';
import { redactPaths } from '../../util/redact';

const log = createLogger('model');

type CA = typeof import('#core-agent');
type AgentRunEvent = CA extends { AgentRunner: infer _ } ? import('#core-agent').AgentRunEvent : never;

/** Convert provider reasoning into a safe, complete single-line process-pane
 * detail. Callers use patches for live transport so completeness does not
 * multiply IPC volume as the reasoning grows. */
export function sanitizePublicReasoningSummary(value: unknown): string {
  return redactPaths(sanitizeLogTextForUpload(String(value ?? '')))
    .replace(/\s+/g, ' ')
    .trim();
}

const REASONING_PROGRESS_INTERVAL_MS = 250;
const MAX_LIVE_REASONING_SUMMARY_CHARS = 2_048;

function boundedLiveReasoningSummary(value: unknown): string {
  const sanitized = sanitizePublicReasoningSummary(value);
  if (sanitized.length <= MAX_LIVE_REASONING_SUMMARY_CHARS) return sanitized;
  return `…${sanitized.slice(-(MAX_LIVE_REASONING_SUMMARY_CHARS - 1))}`;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

export interface MapCoreAgentEventsOptions {
  userId?: string;
  /** Opaque identity of the persisted model session that owns this run.
   *  Repeated-failure guidance is isolated by object identity and is released
   *  automatically when the session cache releases the underlying session. */
  failureTrackingScope: object;
  /** Whether development-only process diagnostics may be rendered. Defaults
   *  to false so a missing caller option cannot expose internal routing. */
  isDev?: boolean;
  /** Active run root. Used only to attach semantic UI metadata; the path is
   *  never copied into the additional field or exposed as a new log value. */
  workingDir?: string;
  /** UI-only metadata collected while rendering the skills prompt block.
   *  This avoids a second skill scan and does not change model-visible text. */
  skillDisplayNameById?: ReadonlyMap<string, string>;
  /** UI-only Skill identity collected for each run-scoped `@skill/<read-ref>`.
   *  Values deliberately omit physical roots so process events can label
   *  virtual entry/reference reads without persisting host paths. */
  skillMetadataByReadRef?: ReadonlyMap<string, {
    id: string;
    name: string;
    source: string;
  }>;
  /** UI-only metadata collected before the run starts. Used to label
   *  read_file(agent.json) process rows without scanning agents again. */
  agentDisplayNameById?: ReadonlyMap<string, string>;
  /** UI-only metadata from the exact visible Connector snapshot used to
   * construct the runner. Live list/call checks may refresh the same map. */
  connectorDisplayNameById?: ReadonlyMap<string, string>;
  /** Monotonic lifecycle clock used for persisted per-tool end-to-end timing.
   *  Production uses performance.now(); tests may inject a deterministic clock. */
  nowMs?: () => number;
  /** Registers a privacy-safe terminal reasoning flush for the outer abort
   *  wrapper. The wrapper can stop a wedged provider before another raw event
   *  reaches this mapper, so cancellation must close the live row explicitly. */
  registerReasoningAbortFlush?: (flush: (() => StreamEvent | null) | null) => void;
}

export interface SkillReadEventMetadata {
  skill_id: string;
  skill_name: string;
  skill_system: 'A.custom' | 'A.platform' | 'B' | 'system';
  skill_file: string;
}

export interface AgentReadEventMetadata {
  agent_id: string;
  agent_name: string;
  agent_system: 'custom' | 'marketplace';
}

interface ConnectorEventMetadata {
  connector_id: string;
}

type AgentErrorMeta = {
  kind: 'auth' | 'rate_limit' | 'context_overflow' | 'timeout' | 'provider_error';
  message: string;
  code?: string;
  statusCode?: number;
};

function modelFailureDetails(
  error: AgentErrorMeta,
  hasVisibleText: boolean,
  providerId?: string,
): Pick<StreamEvent, 'failureKind' | 'failureCode' | 'failurePhase' | 'failureRawCode'> {
  const rawCode = String(error.code || '').trim();
  const code = rawCode.toUpperCase();
  const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 0;
  const transientKind = classifyTransientNetworkError(error);
  let failureCode = 'provider_error';
  let failurePhase: NonNullable<StreamEvent['failurePhase']> = hasVisibleText ? 'model_text' : 'provider_wait';

  if (isStorageFullError(error)) failureCode = 'storage_full';
  else if (code === 'OUTPUT_LIMIT') failureCode = 'provider_max_tokens';
  else if (code === 'PROVIDER_RETRIES_EXHAUSTED') failureCode = 'provider_retries_exhausted';
  else if (code === 'PROVIDER_NO_FIRST_EVENT_TIMEOUT') failureCode = 'provider_no_first_event';
  else if (code === 'PROVIDER_EMPTY_NORMAL') failureCode = 'empty_response_normal';
  else if (code === 'PROVIDER_EMPTY_SAFETY') failureCode = 'empty_response_safety';
  else if (code === 'PROVIDER_EMPTY_UNKNOWN') failureCode = 'empty_response_unknown';
  else if (code === 'PROVIDER_EMPTY_TRANSPORT') failureCode = 'provider_network';
  else if (code === 'PROVIDER_EMPTY_RESPONSE') failureCode = 'empty_response_unknown';
  else if (code === 'PROVIDER_NETWORK_EXHAUSTED') failureCode = 'provider_network';
  else if (transientKind === 'timeout') failureCode = 'provider_timeout';
  else if (transientKind === 'connection_dropped' || transientKind === 'network') failureCode = 'provider_network';
  else if (/^(ECONN|ENET|EAI_|ETIMEDOUT|UND_ERR_)/.test(code)) failureCode = 'provider_network';
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
  // An endpoint-level HTTP client rejection (custom/BYOK endpoint gone, bad
  // request without a body, …). The status is syntax-bounded into the code so
  // dashboards can separate "your endpoint is broken" from provider_error.
  else if (statusCode >= 400 && statusCode < 500) failureCode = `provider_http_${statusCode}`;

  // Whatever still lands in the generic bucket keeps the original machine
  // code as sample-only diagnostics so the next reclassification pass works
  // from codes, not error prose.
  const failureRawCode = failureCode === 'provider_error' && rawCode
    ? rawCode.slice(0, 64)
    : undefined;
  return {
    failureKind: 'model',
    failureCode,
    failurePhase,
    ...(failureRawCode ? { failureRawCode } : {}),
  };
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

function localizeKnownRunnerText(text: string, code?: string): string {
  const trimmed = String(text || '').trim();
  if (isStorageFullError({ message: trimmed, code })) return t('errors.storage_full');
  if (/^PROVIDER_EMPTY_(?:RESPONSE|NORMAL|SAFETY|UNKNOWN|TRANSPORT)$/.test(String(code || '').trim().toUpperCase())) {
    return t('model.empty_response');
  }
  if (trimmed === '(Tool loop limit reached)') return t('model.tool_loop_limit_reached');
  if (trimmed === 'Run aborted') return t('model.run_aborted');
  if (trimmed === 'Max retries exceeded') return t('model.max_retries_exceeded');
  if (trimmed === 'empty response') return t('model.empty_response');
  // context_status progress copy (agent/runner.ts::prepareContextBeforeModelCall).
  // The runner emits stable English source strings; visible copy is localized
  // here, the owning i18n chokepoint for runner-generated text.
  if (trimmed === 'Compacting conversation history...') return t('model.context_history_summary_start');
  if (trimmed === 'Conversation history compacted') return t('model.context_history_summary_done');
  if (trimmed === 'Compacting current-turn tool context...') return t('model.context_active_compaction_start');
  if (trimmed === 'Current-turn tool context compacted') return t('model.context_active_compaction_done');
  return text;
}

type ModelFailureTrackingState = {
  customEndpointConsecutiveFailures: number;
  consecutiveMaxTokensFailures: number;
};

/** Session-local terminal-failure guidance. The cached PersistentSession
 * instance is the opaque key in production, so separate accounts,
 * conversations, and actors cannot influence one another. Weak ownership
 * also keeps this diagnostic heuristic aligned with the existing session
 * lifecycle without persisting ids or introducing a second cleanup path. */
let modelFailureTrackingBySession = new WeakMap<object, ModelFailureTrackingState>();

function modelFailureTrackingState(scope: object): ModelFailureTrackingState {
  const existing = modelFailureTrackingBySession.get(scope);
  if (existing) return existing;
  const created = { customEndpointConsecutiveFailures: 0, consecutiveMaxTokensFailures: 0 };
  modelFailureTrackingBySession.set(scope, created);
  return created;
}

/** Consecutive endpoint-level terminal failures for the user-defined custom
 * provider (W4-1). One 4xx can be a transient upstream hiccup; the sampled
 * incident was three consecutive `410 (no body)` runs where the user only
 * ever saw "模型调用失败：410" and left with zero output. From the second
 * consecutive endpoint-level failure the visible error names the real
 * problem — the configured endpoint/key — instead of the bare status. The
 * counter is a session-local UX heuristic and resets on the next successful
 * custom-provider run. */
const CUSTOM_ENDPOINT_FAILURE_THRESHOLD = 2;

const NO_BODY_HTTP_RE = /\b(4\d\d)\s+status code\s*\(\s*no body\s*\)/i;

function isEndpointLevelFailure(error: AgentErrorMeta, failureCode: string): boolean {
  return /^provider_http_4\d\d$/.test(failureCode)
    || NO_BODY_HTTP_RE.test(String(error.message || ''));
}

/** Exposed for unit tests so cases cannot inherit another case's WeakMap. */
export function resetCustomEndpointFailureTracking(): void {
  modelFailureTrackingBySession = new WeakMap<object, ModelFailureTrackingState>();
}

/** Consecutive terminal provider_max_tokens failures (W4-2). One overrun is
 * normal on a long answer; the sampled 8B-model case hit six error turns
 * because a small output cap kept truncating every reply and nothing ever
 * said the MODEL was the problem. From the second consecutive overrun the
 * visible error adds "this model's output cap is small — switch models or
 * split the task". Same session-local heuristic shape as the endpoint counter
 * above. */

function maxTokensAdvice(
  tracking: ModelFailureTrackingState,
  failureCode: string,
): string | null {
  if (failureCode !== 'provider_max_tokens') {
    tracking.consecutiveMaxTokensFailures = 0;
    return null;
  }
  tracking.consecutiveMaxTokensFailures += 1;
  if (tracking.consecutiveMaxTokensFailures < 2) return null;
  return t('errors.model_output_cap_repeated');
}

function customEndpointDiagnostic(
  tracking: ModelFailureTrackingState,
  providerId: string | undefined,
  error: AgentErrorMeta,
  failureCode: string,
): string | null {
  if (providerId !== 'custom') return null;
  if (!isEndpointLevelFailure(error, failureCode)) {
    tracking.customEndpointConsecutiveFailures = 0;
    return null;
  }
  tracking.customEndpointConsecutiveFailures += 1;
  if (tracking.customEndpointConsecutiveFailures < CUSTOM_ENDPOINT_FAILURE_THRESHOLD) return null;
  const status = typeof error.statusCode === 'number'
    ? String(error.statusCode)
    : (NO_BODY_HTTP_RE.exec(String(error.message || ''))?.[1] || '4xx');
  return t('errors.custom_endpoint_suspect', { status });
}

function localizeKnownRunnerError(error: AgentErrorMeta, providerId?: string): string {
  const raw = error.message || 'unknown error';
  const known = localizeKnownRunnerText(raw, error.code);
  if (known !== raw) return known;
  const code = String(error.code || '').trim().toUpperCase();
  const explicitKind: KeyFailureKind | null = /BALANCE|QUOTA|CREDIT|FUNDS|PAYMENT/.test(code)
    ? 'balance'
    : error.kind === 'auth' || code === 'PROVIDER_AUTH_EXHAUSTED'
    ? 'auth'
    : code === 'PROVIDER_PERMISSION_EXHAUSTED'
      ? 'permission'
      : error.kind === 'rate_limit' || code === 'PROVIDER_RATE_LIMIT_EXHAUSTED'
        ? 'rate_limit'
        : code === 'PROVIDER_BALANCE_EXHAUSTED'
          ? 'balance'
          : code === 'PROVIDER_NETWORK_EXHAUSTED'
            ? 'network'
            : classifyKeyFailure({ message: raw, code: error.code });
  if (explicitKind === 'auth') return t('errors.model_auth_unavailable');
  if (explicitKind === 'permission') return t('errors.model_permission_unavailable');
  if (explicitKind === 'rate_limit') return t('errors.model_rate_limited');
  if (explicitKind === 'balance') {
    return providerId
      ? t('errors.model_provider_balance_insufficient_named', { provider: providerLabel(providerId) })
      : t('errors.model_provider_balance_insufficient');
  }
  if (explicitKind === 'network') return t('errors.model_network_unavailable');
  const transientKind = classifyTransientNetworkError(error);
  if (transientKind === 'connection_dropped' || transientKind === 'timeout' || transientKind === 'network') {
    return t('errors.model_network_unavailable');
  }
  return raw.replace(/^Error:\s*/i, '').replace(/\s+/g, ' ').trim() || 'unknown error';
}

function toolInputPath(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return '';
  const p = (input as Record<string, unknown>).path;
  if (typeof p === 'string') return p;
  const paths = (input as Record<string, unknown>).paths;
  if (!Array.isArray(paths) || paths.length !== 1) return '';
  const item = paths[0];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  const nested = (item as Record<string, unknown>).path;
  return typeof nested === 'string' ? nested : '';
}

function toolResourceScopeForStart(
  toolName: string,
  input: unknown,
  workingDir: string | undefined,
): 'current_workspace' | null {
  if (toolName !== 'list_files' || !workingDir) return null;
  const requestedPath = toolInputPath(input);
  if (!requestedPath) return null;
  const root = path.resolve(workingDir);
  const target = path.resolve(root, requestedPath);
  const same = process.platform === 'win32'
    ? root.toLowerCase() === target.toLowerCase()
    : root === target;
  return same ? 'current_workspace' : null;
}

export function skillReadMetadataForToolStart(
  toolName: string,
  input: unknown,
  opts: Partial<MapCoreAgentEventsOptions> = {},
): SkillReadEventMetadata | null {
  if (toolName !== 'read_files' && toolName !== 'read_file') return null;
  const p = toolInputPath(input);
  if (!p) return null;

  const runtime = runtimeSkillReadMetadata(p, opts.skillMetadataByReadRef);
  if (runtime) return runtime;
  if (!opts.userId) return null;

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
      skill_file: 'SKILL.md',
    };
  }

  const parsed = parseSkillPath(p, opts.userId);
  if (!parsed) return null;
  const display = opts.skillDisplayNameById?.get(parsed.skill_id) || parsed.skill_id;
  return {
    skill_id: parsed.skill_id,
    skill_name: display,
    skill_system: parsed.system,
    skill_file: 'SKILL.md',
  };
}

function runtimeSkillReadMetadata(
  requestedPath: string,
  metadataByReadRef: MapCoreAgentEventsOptions['skillMetadataByReadRef'],
): SkillReadEventMetadata | null {
  if (!metadataByReadRef || !requestedPath.startsWith('@skill/')) return null;
  if (requestedPath.includes('\0') || requestedPath.includes('\\')) return null;
  const tail = requestedPath.slice('@skill/'.length);
  const slash = tail.indexOf('/');
  const ref = slash >= 0 ? tail.slice(0, slash) : tail;
  const relative = slash >= 0 ? tail.slice(slash + 1) : 'SKILL.md';
  if (!ref || !relative) return null;
  const segments = relative.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  const binding = metadataByReadRef.get(ref);
  if (!binding) return null;
  const source = String(binding.source || '');
  const skillSystem: SkillReadEventMetadata['skill_system'] = source === 'system'
    ? 'system'
    : source === 'custom'
      ? 'A.custom'
      : source === 'platform' || source === 'builtin'
        ? 'A.platform'
        : 'B';
  return {
    skill_id: binding.id,
    skill_name: binding.name || binding.id,
    skill_system: skillSystem,
    skill_file: relative,
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
  opts: Partial<MapCoreAgentEventsOptions> = {},
): AgentReadEventMetadata | null {
  if ((toolName !== 'read_files' && toolName !== 'read_file') || !opts.userId) return null;
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
    skill_file: meta.skill_file,
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

function connectorMetadataForToolStart(toolName: string, input: unknown): ConnectorEventMetadata | null {
  if (toolName !== 'list_connector_tools' && toolName !== 'call_connector_tool') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const connectorId = String((input as { connector_id?: unknown }).connector_id || '').trim();
  return connectorId ? { connector_id: connectorId } : null;
}

function connectorEventFields(
  meta: ConnectorEventMetadata | null,
  displayNameById: ReadonlyMap<string, string> | undefined,
): Record<string, unknown> {
  if (!meta) return {};
  const displayName = String(displayNameById?.get(meta.connector_id) || '').trim();
  if (!displayName) return {};
  return {
    connector_id: meta.connector_id,
    connector_name: displayName,
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
  opts: MapCoreAgentEventsOptions,
): AsyncGenerator<StreamEvent, { finalText: string; error: string | null }, unknown> {
  let finalText = '';
  let error: string | null = null;
  let failureDetails: Pick<StreamEvent, 'failureKind' | 'failureCode' | 'failurePhase'> | null = null;
  const skillReadByToolId = new Map<string, SkillReadEventMetadata>();
  const agentReadByToolId = new Map<string, AgentReadEventMetadata>();
  const delegationByToolId = new Map<string, { agent_id: string; agent_name: string }>();
  const connectorByToolId = new Map<string, ConnectorEventMetadata>();
  const earlyToolStarts = new Set<string>();
  const toolDeltaNames = new Map<string, string>();
  const toolLifecycleStartedAt = new Map<string, number>();
  const nowMs = opts.nowMs ?? (() => performance.now());
  const failureTracking = modelFailureTrackingState(opts.failureTrackingScope);
  let thinkingSequence = 0;
  let activeThinkingId = '';
  let activeThinkingChars = 0;
  let activeThinkingText = '';
  let pendingThinkingParts: string[] = [];
  let activeThinkingSummary = '';
  let activeThinkingDirty = false;
  let thinkingProgressEmitted = false;
  let lastThinkingProgressMs = 0;
  let pendingUnphasedText: string[] = [];
  let waitingForInput = false;
  let hasAssistantText = finalText.length > 0;

  type AssistantTextPhase = 'commentary' | 'final_answer';
  const phasedTextEvents = (
    pieces: readonly string[],
    phase: AssistantTextPhase,
  ): StreamEvent[] => {
    const output: StreamEvent[] = [];
    for (const piece of pieces) {
      if (!piece) continue;
      hasAssistantText = true;
      if (phase === 'final_answer') finalText += piece;
      output.push({ type: 'delta', text: piece, phase });
    }
    return output;
  };

  const flushPendingText = (phase: AssistantTextPhase): StreamEvent[] => {
    if (!pendingUnphasedText.length) return [];
    const pieces = pendingUnphasedText;
    pendingUnphasedText = [];
    return phasedTextEvents(pieces, phase);
  };

  const appendThinkingText = (value: string) => {
    if (value) pendingThinkingParts.push(value);
    activeThinkingDirty = true;
  };

  const flushPendingThinkingText = () => {
    if (!pendingThinkingParts.length) return;
    activeThinkingText += pendingThinkingParts.join('');
    pendingThinkingParts = [];
  };

  const startThinking = () => {
    thinkingSequence += 1;
    activeThinkingId = `reasoning-${thinkingSequence}`;
    activeThinkingChars = 0;
    activeThinkingText = '';
    pendingThinkingParts = [];
    activeThinkingSummary = '';
    activeThinkingDirty = false;
    thinkingProgressEmitted = false;
    lastThinkingProgressMs = 0;
    return {
      type: 'event' as const,
      event: {
        stream: 'reasoning',
        data: { phase: 'start', id: activeThinkingId, chars: 0 },
      },
    };
  };

  const flushThinkingProgress = (): StreamEvent | null => {
    if (!activeThinkingId || !activeThinkingDirty) return null;
    flushPendingThinkingText();
    const summary = boundedLiveReasoningSummary(activeThinkingText);
    const summaryFrom = commonPrefixLength(activeThinkingSummary, summary);
    const summaryDelta = summary.slice(summaryFrom);
    activeThinkingSummary = summary;
    activeThinkingDirty = false;
    thinkingProgressEmitted = true;
    lastThinkingProgressMs = nowMs();
    return {
      type: 'event',
      event: {
        stream: 'reasoning',
        data: {
          phase: 'progress',
          id: activeThinkingId,
          chars: activeThinkingChars,
          heartbeat: true,
          ...(summary || summaryFrom > 0
            ? { summary_from: summaryFrom, summary_delta: summaryDelta }
            : {}),
        },
      },
    };
  };

  const endThinking = (reportedChars = 0): StreamEvent | null => {
    if (!activeThinkingId) return null;
    activeThinkingChars = Math.max(
      activeThinkingChars,
      Math.max(0, Math.round(Number(reportedChars) || 0)),
    );
    flushPendingThinkingText();
    const summary = sanitizePublicReasoningSummary(activeThinkingText);
    const event: StreamEvent = {
      type: 'event',
      event: {
        stream: 'reasoning',
        data: {
          phase: 'end',
          id: activeThinkingId,
          chars: activeThinkingChars,
          ...(summary ? { summary } : {}),
        },
      },
    };
    activeThinkingId = '';
    activeThinkingChars = 0;
    activeThinkingText = '';
    pendingThinkingParts = [];
    activeThinkingSummary = '';
    activeThinkingDirty = false;
    thinkingProgressEmitted = false;
    lastThinkingProgressMs = 0;
    return event;
  };

  opts.registerReasoningAbortFlush?.(() => endThinking());

  const eventIterator = events[Symbol.asyncIterator]();
  let nextEvent: Promise<IteratorResult<AgentRunEvent>> | null = null;
  const progressDue = Symbol('reasoning-progress-due');

  try {
    while (true) {
      if (!nextEvent) nextEvent = Promise.resolve(eventIterator.next());
      let next: IteratorResult<AgentRunEvent> | typeof progressDue;
      try {
        if (activeThinkingDirty && thinkingProgressEmitted) {
          const remainingMs = Math.max(
            0,
            REASONING_PROGRESS_INTERVAL_MS - (nowMs() - lastThinkingProgressMs),
          );
          if (remainingMs === 0) {
            next = progressDue;
          } else {
            let timer: ReturnType<typeof setTimeout> | null = null;
            try {
              next = await Promise.race([
                nextEvent,
                new Promise<typeof progressDue>((resolve) => {
                  timer = setTimeout(() => resolve(progressDue), remainingMs);
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          }
        } else {
          next = await nextEvent;
        }
      } catch (err) {
        const terminalReasoning = endThinking();
        if (terminalReasoning) yield terminalReasoning;
        throw err;
      }

      if (next === progressDue) {
        const progress = flushThinkingProgress();
        if (progress) yield progress;
        continue;
      }
      nextEvent = null;
      if (next.done) break;
      const ev = next.value;

      if (ev.type !== 'thinking') {
        const terminalReasoning = endThinking();
        if (terminalReasoning) yield terminalReasoning;
      }
      switch (ev.type) {
      case 'text_delta': {
        const piece = ev.text || '';
        if (!piece) break;
        if (ev.phase === 'commentary' || ev.phase === 'final_answer') {
          for (const event of phasedTextEvents([piece], ev.phase)) yield event;
        } else {
          // Chat Completions, Anthropic Messages, Gemini GenerateContent and
          // other phase-less protocols all expose structured tool boundaries.
          // Hold only this provider round until one of those boundaries tells
          // us whether the text is commentary or the terminal answer.
          pendingUnphasedText.push(piece);
        }
        break;
      }

      case 'text_phase':
        // Responses exposes the item phase as protocol metadata at text_end.
        // It authoritatively classifies the buffered block without delaying
        // until the whole provider request finishes.
        for (const event of flushPendingText(ev.phase)) yield event;
        break;

      case 'thinking': {
        if (ev.phase === 'start') {
          const previousThinking = endThinking();
          if (previousThinking) yield previousThinking;
          yield startThinking();
          break;
        }

        if (!activeThinkingId) yield startThinking();
        if (ev.phase === 'progress') {
          activeThinkingChars += Math.max(0, Math.round(Number(ev.chars) || 0));
          appendThinkingText(ev.text || '');
          if (!thinkingProgressEmitted
              || nowMs() - lastThinkingProgressMs >= REASONING_PROGRESS_INTERVAL_MS) {
            const progress = flushThinkingProgress();
            if (progress) yield progress;
          }
          break;
        }

        const terminalReasoning = endThinking(ev.chars);
        if (terminalReasoning) yield terminalReasoning;
        break;
      }

      case 'tool_delta': {
        // A structured tool-call delta proves that preceding unphased text in
        // this provider round was a user-visible preamble/commentary. This is
        // protocol inference only; no text content is inspected.
        for (const event of flushPendingText('commentary')) yield event;
        const id = String(ev.id || '').trim();
        // An early row is useful only when every later event can address that
        // exact call. Never fall back to a shared or positional identity: two
        // parallel calls with the same name must remain impossible to cross.
        if (!id) break;
        // The first provider event for a tool call is the only accurate
        // end-to-end start boundary. It precedes argument assembly and, for
        // large write/edit calls, can be much earlier than tool execution.
        if (!toolLifecycleStartedAt.has(id)) toolLifecycleStartedAt.set(id, nowMs());
        const name = String(ev.name || toolDeltaNames.get(id) || '');
        if (name) toolDeltaNames.set(id, name);
        if (!name || earlyToolStarts.has(id)) break;
        earlyToolStarts.add(id);
        yield {
          type: 'event',
          event: {
            stream: 'tool',
            data: {
              phase: 'start',
              id,
              name,
            },
          },
        };
        break;
      }

      case 'tool_start': {
        // Non-streaming providers may expose the tool boundary only when
        // execution begins. It is still authoritative structured evidence.
        for (const event of flushPendingText('commentary')) yield event;
        // Providers that do not stream tool-call deltas fall back to the
        // execution boundary. This remains exact for the lifecycle evidence
        // actually available rather than manufacturing model-wait time.
        if (!toolLifecycleStartedAt.has(ev.id)) toolLifecycleStartedAt.set(ev.id, nowMs());
        toolDeltaNames.delete(ev.id);
        const skillMeta = skillReadMetadataForToolStart(ev.name, ev.input, opts);
        if (skillMeta) skillReadByToolId.set(ev.id, skillMeta);
        // Persist UI identity separately from agent.json read metadata so
        // replay does not depend on the currently selected conversation.
        if ((ev.name === 'dispatch_to' || ev.name === 'hand_off_to') && ev.input && typeof ev.input === 'object') {
          const id = String((ev.input as { to?: unknown }).to || '').trim();
          const name = opts.agentDisplayNameById?.get(id);
          if (id && name) delegationByToolId.set(ev.id, { agent_id: id, agent_name: name });
        }
        const agentMeta = agentReadMetadataForToolStart(ev.name, ev.input, opts);
        if (agentMeta) agentReadByToolId.set(ev.id, agentMeta);
        const connectorMeta = connectorMetadataForToolStart(ev.name, ev.input);
        if (connectorMeta) connectorByToolId.set(ev.id, connectorMeta);
        const resourceScope = toolResourceScopeForStart(ev.name, ev.input, opts.workingDir);
        const wasAnnounced = earlyToolStarts.has(ev.id);
        yield {
          type: 'event',
          event: {
            stream: 'tool',
            data: {
              // A streamed call already produced the one countable start
              // milestone. The execution boundary only enriches that same
              // lifecycle row with complete, validated input.
              phase: wasAnnounced ? 'progress' : 'start',
              id: ev.id,
              name: ev.name,
              arguments: ev.input,
              ...(resourceScope ? { resource_scope: resourceScope } : {}),
              ...skillReadEventFields(skillMeta),
              ...agentReadEventFields(agentMeta),
              ...delegationByToolId.get(ev.id),
              ...connectorEventFields(connectorMeta, opts.connectorDisplayNameById),
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
              ...delegationByToolId.get(ev.id),
            },
          },
        };
        break;
      }

      case 'tool_end': {
        const rawResult = ev.result || '';
        const preview = resultPreview(rawResult);
        const lifecycleStartedAt = toolLifecycleStartedAt.get(ev.id);
        toolLifecycleStartedAt.delete(ev.id);
        const executionDurationMs = Number.isFinite(ev.durationMs)
          ? Math.max(0, Math.round(ev.durationMs!))
          : null;
        const observedEndToEndMs = lifecycleStartedAt === undefined
          ? null
          : Math.max(0, Math.round(nowMs() - lifecycleStartedAt));
        // The execution duration is a lower bound for end-to-end time. Taking
        // the maximum protects the persisted UI value from coarse/fake clocks
        // and from an end event delivered in the same clock tick as start.
        const endToEndDurationMs = observedEndToEndMs === null
          ? executionDurationMs
          : Math.max(observedEndToEndMs, executionDurationMs ?? 0);
        earlyToolStarts.delete(ev.id);
        toolDeltaNames.delete(ev.id);
        const skillMeta = skillReadByToolId.get(ev.id) || null;
        skillReadByToolId.delete(ev.id);
        const agentMeta = agentReadByToolId.get(ev.id) || null;
        agentReadByToolId.delete(ev.id);
        const delegationMeta = delegationByToolId.get(ev.id);
        delegationByToolId.delete(ev.id);
        const connectorMeta = connectorByToolId.get(ev.id) || null;
        connectorByToolId.delete(ev.id);
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
          ...(ev.displayName ? { display_name: ev.displayName } : {}),
          ...(executionDurationMs !== null ? { duration_ms: executionDurationMs } : {}),
          ...(endToEndDurationMs !== null ? { end_to_end_duration_ms: endToEndDurationMs } : {}),
          ...(ev.errorCode ? { errorCode: ev.errorCode } : {}),
          ...(ev.errorSeverity ? { errorSeverity: ev.errorSeverity } : {}),
          ...(ev.fileReadBatch ? { fileReadBatch: ev.fileReadBatch } : {}),
          ...(ev.programExecution ? {
            programSourceKind: ev.programExecution.sourceKind,
            programSourceSha256: ev.programExecution.sourceSha256,
            programChildCalls: ev.programExecution.childCalls,
          } : {}),
          ...skillReadEventFields(skillMeta),
          ...agentReadEventFields(agentMeta),
          ...delegationMeta,
          ...connectorEventFields(connectorMeta, opts.connectorDisplayNameById),
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

      case 'images_omitted': {
        // W4-2: without this row the only symptom of a text-only model is
        // the model itself claiming it cannot see the attachment.
        yield {
          type: 'progress',
          text: t('model.images_omitted', { count: ev.count }),
          event: {
            stream: 'provider',
            data: { phase: 'images_omitted', count: ev.count, provider_id: ev.providerId },
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
            data: {
              phase: 'fallback',
              reason: ev.reason,
              provider_id: ev.providerId,
              ...(ev.candidateIndex !== undefined
                ? { candidate_index: Math.max(1, Math.round(ev.candidateIndex)) }
                : {}),
              ...(ev.candidateCount !== undefined
                ? { candidate_count: Math.max(1, Math.round(ev.candidateCount)) }
                : {}),
            },
          },
        };
        break;
      }

      case 'provider_call':
        // `provider_call.stopReason` is the completed model round's structured
        // terminal marker. It covers providers that return a complete tool
        // call without streaming `tool_delta` first.
        for (const event of flushPendingText(
          ev.outcome === 'completed' && ev.stopReason !== 'tool_use'
            ? 'final_answer'
            : 'commentary',
        )) yield event;
        // Internal latency telemetry. The user already sees streamed model
        // output/progress; rendering another row would add noise.
        break;

      case 'context_status': {
        yield {
          type: 'event',
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
        waitingForInput = !result.meta.error && result.meta.termination?.status === 'waiting_input';
        // Some custom/test providers omit provider_call. The run result is the
        // final structured fallback: failures cannot promote partial prose to
        // a final answer; successful no-tool completion can.
        for (const event of flushPendingText(
          result.meta.error ? 'commentary' : 'final_answer',
        )) yield event;
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
          error = localizeKnownRunnerError(result.meta.error, result.meta.provider);
          failureDetails = modelFailureDetails(
            result.meta.error,
            hasAssistantText,
            result.meta.provider,
          );
          const endpointDiagnostic = customEndpointDiagnostic(
            failureTracking,
            result.meta.provider,
            result.meta.error,
            failureDetails.failureCode || '',
          );
          if (endpointDiagnostic) error = endpointDiagnostic;
          const capAdvice = maxTokensAdvice(failureTracking, failureDetails.failureCode || '');
          if (capAdvice) error = `${error} ${capAdvice}`;
          // meta.error is `{kind, message}` — cause/stack live on the
          // ProviderError that runner.ts already logged via `log.warn(...)`
          // on the retry path. Keep this line focused on what survives.
          log.warn('core-agent done with error', {
            error_chars: error.length,
            kind: result.meta.error.kind,
            error_code: result.meta.error.code,
            failure_code: failureDetails.failureCode,
            model: result.meta.model,
            provider: result.meta.provider,
            durationMs: result.meta.durationMs,
          });
        } else {
          // A successful custom-provider run clears the endpoint suspicion.
          if (result.meta.provider === 'custom') {
            failureTracking.customEndpointConsecutiveFailures = 0;
          }
          failureTracking.consecutiveMaxTokensFailures = 0;
          // The runner's terminal-round text is authoritative, including an
          // empty value. Keeping deltas accumulated from an earlier tool round
          // can otherwise turn a preamble into a successful final answer when
          // the post-tool round emitted reasoning only.
          finalText = localizeKnownRunnerText(result.text || '');
          if (
            finalText
            && result.meta.convergenceSignals?.includes('output_limit_unrecovered')
          ) {
            finalText = `${finalText}\n\n${t('model.output_incomplete')}`;
          }
        }
        break;
      }

      default:
        // Unknown event type — ignore rather than throw so a future
        // core-agent release can add events without breaking this client.
        break;
      }
    }
  } finally {
    opts.registerReasoningAbortFlush?.(null);
  }

  // A stream that ended without a provider/done boundary did not establish a
  // final answer. Preserve any partial prose as process commentary instead of
  // guessing from its wording or promoting it to a successful answer.
  for (const event of flushPendingText('commentary')) yield event;

  if (error) {
    yield { type: 'error', text: error, ...failureDetails };
  } else if (finalText) {
    yield { type: 'final', text: finalText };
  } else if (!waitingForInput) {
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
