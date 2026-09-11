/**
 * core-agent-backed implementation of `chatWithModel` / `streamChatWithModel`.
 *
 * Signatures match `main/model/client.ts` (the openclaw client) so feature
 * code (`features/chats`, `features/skills`, `features/agents`,
 * `features/contexts_organizer`) can stay unchanged — the dispatcher in
 * `model/client.ts` routes between the two backends based on
 * `process.env.ORKAS_MODEL_BACKEND`.
 *
 * Compared to the openclaw client, this one is all in-process:
 *   - No subprocess spawn
 *   - No JSON-block output parsing
 *   - No preload/bridge hooks — events come straight from core-agent
 *   - Session = `PersistentSession` file under <WS_ROOT>/<user>/sessions/
 *
 * What stays the same:
 *   - Per-session Mutex + 10-slot global Semaphore (`util/locks`)
 *   - Phase-aware idle watchdogs for provider wait, text, tool input, and tools
 *   - External AbortSignal honored
 *   - Returned event shapes + final reply accumulation
 */

import {
  sessionLock, globalSlots,
  type Releaser,
} from '../../util/locks';
import type {
  AgentRunConvergenceSignal,
  AgentRunTimings,
  AgentTool,
  ServerModelFallbackReason,
} from '#core-agent';
import { createLogger } from '../../logger';
import { AGENT_EXECUTION_IDLE_MS, agentExecutionDeadline } from '../../util/agent-execution-budget';
import { logErrorRef, logErrorSummary, logPathRef, maskId } from '../../util/log-redact';
import { recordUsageTokens } from '../../util/conversation-cost-meter';

const log = createLogger('model');
import { genConversationId } from '../../storage';
import type { ChatOptions, ChatResult, StreamEvent } from '../client';

import {
  buildRunner,
  type ToolDefSnapshot,
  type ToolSurfaceTelemetrySnapshot,
} from './runner';
import type { SkillSelectionInput } from './skill-registry';
import { mapCoreAgentEvents } from './event-mapper';
import {
  evictEphemeralSession,
  getSessionForUser as _getCachedSessionForUser,
  sessionKindOf,
} from './session-store';
import { getSession as _getCachedSession } from './session-store';
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as paths from '../../paths';
import { getCurrentLang, t } from '../../i18n';
import { bundledRuntimeEnv, bundledRuntimePathEntries } from '../../util/bundled-runtime';
import { resolveBackgroundNodeRuntime, withBackgroundNodeEnv } from '../../util/background-node';

interface NoopRecorder {
  record(event: unknown): void;
  setActiveCandidate(info: unknown): void;
  finish(output: unknown): void;
}

function startRecording(_input: unknown): NoopRecorder {
  return {
    record() {},
    setActiveCandidate() {},
    finish() {},
  };
}

export async function* stopStreamOnAbort<T>(
  events: AsyncIterable<T>,
  signal: AbortSignal,
  label = 'stream',
  flushBeforeAbort?: () => T | null | undefined,
): AsyncGenerator<T, void, unknown> {
  const iterator = events[Symbol.asyncIterator]();
  const aborted = Symbol('aborted');
  let abortListener: (() => void) | null = null;
  const abortPromise = new Promise<typeof aborted>((resolve) => {
    abortListener = () => resolve(aborted);
    if (signal.aborted) resolve(aborted);
    else signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    while (true) {
      const next = iterator.next();
      const result = await Promise.race([next, abortPromise]);
      if (result === aborted) {
        try {
          const pending = flushBeforeAbort?.();
          if (pending !== null && pending !== undefined) yield pending;
        } catch (err) {
          log.warn('abortable stream flush failed', { label, error: logErrorSummary(err) });
        }
        const ret = iterator.return?.();
        if (ret) {
          void Promise.resolve(ret).catch((err) => {
            log.warn('abortable stream return failed', { label, error: logErrorSummary(err) });
          });
        }
        return;
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

/**
 * Env vars injected into the sandbox child process so skill scripts can run
 * under Orkas's bundled stock Node:
 *   - `ORKAS_NODE` / `ORKAS_BUNDLED_NODE` = bundled Node binary path
 *   - `ORKAS_PC_DIR` = PC root, rewritten to `app.asar.unpacked` in
 *     packaged mode so `bin/run-skill.cjs` + tsx + skills resolve on real disk
 *   - `ORKAS_WORKSPACE_ROOT` = canonical data root so `run-skill.cjs` can
 *     find installed per-user skills under `<uid>/local/marketplace/skills`
 *   - `ORKAS_PYTHON` / `ORKAS_UV` = optional bundled runtimes under
 *     resources/runtime.
 *   - `ORKAS_VENV_ROOT` = shared machine-local dependency env root under
 *     data/venv, plus uv/pip/npm cache dirs there so package installs survive
 *     app updates and are reused across Orkas accounts on this device.
 *
 * Injected via `AgentRunParams.sandboxEnv` → `ToolContext.state.sandboxEnv`
 * → `SandboxExecutor.config.env`, so the env only reaches the bash-tool
 * child process. Never set on the host `process.env`: that would leak to
 * Electron's own GPU/renderer/utility helpers and crash the app at boot.
 */
let _skillSandboxEnvStatic: Record<string, string> | null = null;
function buildSkillSandboxEnvStatic(): Record<string, string> {
  if (_skillSandboxEnvStatic) return _skillSandboxEnvStatic;
  // `app` is undefined when running under vitest (no Electron runtime). Treat
  // missing/!isPackaged the same — dev layout has everything on real disk.
  const isPackaged = !!app && app.isPackaged;
  const pcDir = isPackaged
    ? paths.PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked')
    : paths.PC_ROOT;
  const nodeRuntime = resolveBackgroundNodeRuntime();
  _skillSandboxEnvStatic = withBackgroundNodeEnv({
    ORKAS_PC_DIR: pcDir,
    ORKAS_WORKSPACE_ROOT: paths.WS_ROOT,
  }, nodeRuntime);
  return _skillSandboxEnvStatic;
}

/**
 * Per-turn sandbox env = cached static part + uid-derived dynamic part
 * (never cached module-level — CLAUDE.md §4):
 *   - `ORKAS_UID` = the turn's user id, so `bin/orkas-pkg.cjs` (and other
 *     bash-driven CLIs) resolve the right per-user data tree without
 *     parsing users.json.
 *   - `ORKAS_AGENT_ID` = the current acting agent id, so `bin/run-skill.cjs`
 *     can resolve agent-private installed skills from the per-user data tree.
 *   - `ORKAS_GLOBAL_SKILL_ROOTS_ENABLED` = current account preference, so the
 *     standalone Skill runner enforces the same global-root boundary as the
 *     registry instead of independently scanning hidden roots.
 *   - `ORKAS_PATH_PREPEND` = bundled runtime bins plus enabled external
 *     package CLI dirs (`.bin`, package-local bin fallbacks) when present.
 *     Composed into PATH by the sandbox executor (see core-agent
 *     sandbox/executor.ts) so the augmented brew/system PATH is preserved.
 */
function safeAgentEnvId(agentId?: string): string {
  const text = String(agentId || '').trim();
  if (!text || text === '.' || text === '..') return '';
  if (text.includes('/') || text.includes('\\') || text.includes('\0') || text.includes('..')) return '';
  return text;
}

export function buildSkillSandboxEnv(userId?: string, agentId?: string): Record<string, string> {
  const env = { ...buildSkillSandboxEnvStatic(), ...bundledRuntimeEnv() };
  env.ORKAS_UI_LANG = getCurrentLang();
  env.ORKAS_VENV_ROOT = paths.VENV_ROOT;
  env.ORKAS_PYTHON_VENV_ROOT = paths.PYTHON_VENV_ROOT;
  env.UV_CACHE_DIR = paths.PYTHON_VENV_UV_CACHE_DIR;
  env.PIP_CACHE_DIR = paths.PYTHON_VENV_PIP_CACHE_DIR;
  env.NPM_CONFIG_CACHE = paths.NODE_NPM_CACHE_DIR;
  env.NPM_CONFIG_PREFIX = paths.NODE_NPM_PREFIX_DIR;
  env.NPM_CONFIG_FUND = 'false';
  env.NPM_CONFIG_AUDIT = 'false';
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  const pathEntries = bundledRuntimePathEntries();
  try {
    if (fs.statSync(paths.NODE_NPM_GLOBAL_BIN_DIR).isDirectory()) {
      pathEntries.push(paths.NODE_NPM_GLOBAL_BIN_DIR);
    }
  } catch { /* npm global shims are created on demand */ }
  try {
    if (fs.statSync(paths.PYTHON_VENV_BIN_DIR).isDirectory()) {
      pathEntries.push(paths.PYTHON_VENV_BIN_DIR);
    }
  } catch { /* shared venv shims are created on demand */ }
  if (userId) {
    env.ORKAS_UID = userId;
    const safeAgentId = safeAgentEnvId(agentId);
    if (safeAgentId) env.ORKAS_AGENT_ID = safeAgentId;
    try {
      const preferences = JSON.parse(
        fs.readFileSync(paths.userPreferencesFile(userId), 'utf8'),
      ) as { global_skill_roots_enabled?: unknown };
      env.ORKAS_GLOBAL_SKILL_ROOTS_ENABLED = preferences.global_skill_roots_enabled === false
        ? '0'
        : '1';
    } catch {
      // Preserve the product default when preferences are not available during
      // early boot or when the preference file is missing/malformed.
      env.ORKAS_GLOBAL_SKILL_ROOTS_ENABLED = '1';
    }
    try {
      // Lazy require keeps module-load order safe (client.ts loads before
      // some features in boot paths) and avoids a static feature import in
      // the model layer beyond what's already here.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const pkgs = require('../../features/packages') as typeof import('../../features/packages');
      if (typeof pkgs.packagePathEntriesIfActive === 'function') {
        pathEntries.push(...pkgs.packagePathEntriesIfActive(userId));
      } else {
        const binDir = pkgs.packagesBinDirIfActive(userId);
        if (binDir) pathEntries.push(binDir);
      }
    } catch { /* packages feature unavailable → no shim PATH this turn */ }
  }
  if (pathEntries.length) {
    env.ORKAS_PATH_PREPEND = pathEntries.join(process.platform === 'win32' ? ';' : ':');
  }
  return env;
}

type ActiveSessionAbort = {
  abort: () => void;
};

const activeSessionAborts = new Map<string, Set<ActiveSessionAbort>>();

function activeSessionAbortKey(userId: string, sessionId: string): string {
  return `${userId}\0${sessionId}`;
}

function sessionIdFromActiveAbortKey(key: string): string {
  const separator = key.indexOf('\0');
  return separator >= 0 ? key.slice(separator + 1) : key;
}

function userIdFromActiveAbortKey(key: string): string {
  const separator = key.indexOf('\0');
  return separator >= 0 ? key.slice(0, separator) : '';
}

function addActiveSessionAbort(userId: string, sessionId: string, entry: ActiveSessionAbort): void {
  const key = activeSessionAbortKey(userId, sessionId);
  let set = activeSessionAborts.get(key);
  if (!set) {
    set = new Set();
    activeSessionAborts.set(key, set);
  }
  set.add(entry);
}

function removeActiveSessionAbort(userId: string, sessionId: string, entry: ActiveSessionAbort): void {
  const key = activeSessionAbortKey(userId, sessionId);
  const set = activeSessionAborts.get(key);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) activeSessionAborts.delete(key);
}

function abortActiveSessionByKey(key: string): number {
  const set = activeSessionAborts.get(key);
  if (!set || set.size === 0) return 0;
  let count = 0;
  for (const entry of Array.from(set)) {
    try {
      entry.abort();
      count += 1;
    } catch { /* already aborted */ }
  }
  return count;
}

export function abortActiveSession(sessionId: string, userId?: string): number {
  if (userId) return abortActiveSessionByKey(activeSessionAbortKey(userId, sessionId));

  let count = 0;
  for (const key of Array.from(activeSessionAborts.keys())) {
    if (sessionIdFromActiveAbortKey(key) === sessionId) {
      count += abortActiveSessionByKey(key);
    }
  }
  return count;
}

export function abortActiveSessionsForConversation(cid: string, userId?: string): number {
  if (!cid) return 0;
  let count = 0;
  const commanderSession = `gconv-${cid}`;
  const memberPrefix = `gmember-${cid}-`;
  // Anonymous in-process `run_worker` sub-runs stream on `gworker-<cid>-<id>`
  // sessions (see state.ts::buildGworkerSessionId). They are NOT in
  // state.workers, so the bus's state.workers abort loop never touches them;
  // this by-cid fallback is the safety net for exactly that — include the
  // worker prefix so a Stop also kills any in-flight anonymous worker call.
  const workerPrefix = `gworker-${cid}-`;
  for (const key of Array.from(activeSessionAborts.keys())) {
    if (userId && userIdFromActiveAbortKey(key) !== userId) continue;
    const sessionId = sessionIdFromActiveAbortKey(key);
    if (sessionId === commanderSession || sessionId.startsWith(memberPrefix) || sessionId.startsWith(workerPrefix)) {
      count += abortActiveSessionByKey(key);
    }
  }
  return count;
}

type SafeUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
};

/** Unbounded numeric aggregate for local evaluation. Detailed provider rounds
 * stay capped, but their Token total must not disappear when a long or failed
 * run exceeds that diagnostic cap. */
export interface ProviderUsageAggregate {
  observedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

/** Privacy-bounded request evidence retained only by local Model Eval runs.
 * Prompt text, tool arguments, model output, paths, and provider identifiers
 * are deliberately absent. */
export interface ProviderRoundPlanMutationEvidence {
  action: 'update' | 'set_statuses' | 'append_step' | 'set_status' | 'clear' | 'replace';
  /** Revision 1 is the first explicit milestone plan; revision 0 is the
   * host-created objective-only anchor. */
  initialExplicitPlan: boolean;
  stepCount: number;
  changedStepCount: number;
  noOp: boolean;
}

export interface ProviderRoundEvidence {
  planMutations?: ProviderRoundPlanMutationEvidence[];
  index: number;
  durationMs: number;
  outcome: 'completed' | 'failed';
  stopReason?: string;
  textChars?: number;
  usage?: SafeUsage;
  toolNames: string[];
}

export type LiveRunTimingPhase = 'provider' | 'tool' | 'compaction' | 'retry_wait' | 'other';

export type LiveRunTimingState = {
  phase: LiveRunTimingPhase;
  phaseStartedAtMs: number;
  providerMs: number;
  toolMs: number;
  compactionMs: number;
  retryWaitMs: number;
  otherMs: number;
};

function liveTimingKey(phase: LiveRunTimingPhase): keyof AgentRunTimings {
  if (phase === 'provider') return 'providerMs';
  if (phase === 'tool') return 'toolMs';
  if (phase === 'compaction') return 'compactionMs';
  if (phase === 'retry_wait') return 'retryWaitMs';
  return 'otherMs';
}

export function createLiveRunTimings(startedAtMs = Date.now()): LiveRunTimingState {
  return {
    phase: 'other',
    phaseStartedAtMs: startedAtMs,
    providerMs: 0,
    toolMs: 0,
    compactionMs: 0,
    retryWaitMs: 0,
    otherMs: 0,
  };
}

export function transitionLiveRunTimings(
  state: LiveRunTimingState,
  phase: LiveRunTimingPhase,
  nowMs = Date.now(),
): void {
  const elapsed = Math.max(0, nowMs - state.phaseStartedAtMs);
  const key = liveTimingKey(state.phase);
  state[key] += elapsed;
  state.phase = phase;
  state.phaseStartedAtMs = nowMs;
}

export function snapshotLiveRunTimings(
  state: LiveRunTimingState,
  nowMs = Date.now(),
): AgentRunTimings {
  const snapshot: AgentRunTimings = {
    providerMs: state.providerMs,
    toolMs: state.toolMs,
    compactionMs: state.compactionMs,
    retryWaitMs: state.retryWaitMs,
    otherMs: state.otherMs,
  };
  snapshot[liveTimingKey(state.phase)] += Math.max(0, nowMs - state.phaseStartedAtMs);
  return snapshot;
}

export function modelRunTimingSummaryForLog(
  totalMs: number,
  timings: AgentRunTimings,
): {
  total_ms: number;
  provider_ms: number;
  tool_ms: number;
  compaction_ms: number;
  retry_wait_ms: number;
  other_ms: number;
} {
  const boundedMs = (value: number): number => (
    Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
  );
  const providerMs = boundedMs(timings.providerMs);
  const toolMs = boundedMs(timings.toolMs);
  const compactionMs = boundedMs(timings.compactionMs);
  const retryWaitMs = boundedMs(timings.retryWaitMs);
  let otherMs = boundedMs(timings.otherMs);
  const observedTotalMs = boundedMs(totalMs);
  const attributedMs = providerMs + toolMs + compactionMs + retryWaitMs + otherMs;

  // Successful runs prefer the runner's precise phase timings, whose clock
  // starts after host-side setup. Attribute that pre-run residual to `other`
  // so this single terminal record reconciles to the observed reply duration.
  if (attributedMs < observedTotalMs) otherMs += observedTotalMs - attributedMs;

  return {
    total_ms: Math.max(
      observedTotalMs,
      providerMs + toolMs + compactionMs + retryWaitMs + otherMs,
    ),
    provider_ms: providerMs,
    tool_ms: toolMs,
    compaction_ms: compactionMs,
    retry_wait_ms: retryWaitMs,
    other_ms: otherMs,
  };
}

function liveRunFailurePhase(phase: LiveRunTimingPhase): StreamEvent['failurePhase'] {
  if (phase === 'tool') return 'tool';
  if (phase === 'compaction') return 'compaction';
  if (phase === 'other') return 'preflight';
  return 'provider_wait';
}

type ToolRunLogCounter = {
  starts: number;
  progress: number;
  ends: number;
  errors: number;
};

type ToolTimelineLogEntry = {
  seq: number;
  elapsedMs: number;
  tool: string;
  phase: 'start' | 'progress' | 'end';
  call_id?: string;
  is_error?: boolean;
  result_chars?: number;
};

type RunTimelineLogEntry = {
  seq: number;
  elapsedMs: number;
  event: string;
  detail?: string;
};

export interface ModelRunLogDiagnostics {
  startedAtMs: number;
  rawEventCount: number;
  streamEventCount: number;
  textDeltaEvents: number;
  textDeltaChars: number;
  clientDeltaEvents: number;
  clientDeltaChars: number;
  progressEvents: number;
  eventPayloads: number;
  finalEvents: number;
  errorEvents: number;
  retryCount: number;
  compactionCount: number;
  compactionAttemptCount: number;
  compactionFailureCount: number;
  /** Context-gate interventions on this run's event stream: provider-overflow
   * recoveries that retried, emergency folds applied pre-model, and emergency
   * passes that found nothing left to drop (the known L3 blind spot). */
  overflowRecoveryCount: number;
  emergencyFoldCount: number;
  emergencyNoDropCount: number;
  /** Re-read accounting summed over measured compaction spans (the runner
   * reports it from a run's second compaction on): reads seen, re-reads of an
   * already-read path, and byte-identical re-reads. Fleet calibration input
   * for the derived context-budget ceilings. */
  rereadReads: number;
  rereadPaths: number;
  rereadIdentical: number;
  providerCallCount: number;
  providerCallMaxMs: number;
  providerSlowCallCount: number;
  structuredReasoningCallCount: number;
  literalThinkContentCallCount: number;
  providerUsage: ProviderUsageAggregate;
  providerRounds: ProviderRoundEvidence[];
  providerRoundsTruncated: number;
  toolDeltaCount: number;
  toolStarts: number;
  toolProgress: number;
  toolEnds: number;
  toolErrors: number;
  /** Tool-returned failures, excluding runner/runtime exceptions. */
  toolResultErrors: number;
  /** Tool-returned failures followed by a later successful call to the same
   * tool operation. This is deliberately sequence-based: a sibling call that
   * was already running when the failure arrived cannot count as recovery.
   * The inverse is only "no same-operation recovery was observed"; it does
   * not prove that the task-level blocker remained unresolved because the
   * model may have completed through a different operation or tool. */
  toolResultErrorsRecovered: number;
  toolEventSequence: number;
  toolStartSequenceById: Record<string, number>;
  toolRecoveryKeyById: Record<string, string>;
  toolRecoveryFallbackKeyById: Record<string, string>;
  pendingToolResultErrorSequences: Record<string, number[]>;
  firstRawEventMs?: number;
  /** First model-produced event (text or tool-call construction), excluding
   * host retry/fallback/context bookkeeping. */
  firstModelEventMs?: number;
  /** First usable model content (text or tool call). A terminal empty `done`
   * does not satisfy this. */
  firstContentMs?: number;
  firstClientEventMs?: number;
  firstTextDeltaMs?: number;
  firstToolMs?: number;
  doneRawEventMs?: number;
  providerDurationMs?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorKind?: string;
  usage?: SafeUsage;
  resultTextChars?: number;
  resultContentBlocks?: number;
  toolLoops?: number;
  skillsLoadedCount?: number;
  transientToolErrors?: number;
  permanentToolErrors?: number;
  lastCompactionTokensBefore?: number;
  lastCompactionTokensAfter?: number;
  retryKinds: Record<string, number>;
  providerFallbackCount: number;
  providerFallbackAuthCount: number;
  providerFallbackTimeoutCount: number;
  serverFallbackCount: number;
  serverFallbackReason?: ServerModelFallbackReason;
  effectiveModel?: string;
  providerCandidateCount: number;
  providerAvailableCandidateCount: number;
  providerEmptyCount: number;
  providerEmptyTransportCount: number;
  providerEmptyNormalCount: number;
  providerEmptySafetyCount: number;
  providerEmptyUnknownCount: number;
  providerEmptyTerminalCount: number;
  providerEmptyOutputTokens: number;
  lastFallbackCandidateIndex: number;
  toolCounts: Record<string, ToolRunLogCounter>;
  toolTimeline: ToolTimelineLogEntry[];
  toolTimelineTruncated: number;
  runTimeline: RunTimelineLogEntry[];
  runTimelineTruncated: number;
  rawTextTimelineRecorded: boolean;
  clientDeltaTimelineRecorded: boolean;
  seenToolDeltaIds: Record<string, boolean>;
}

function sessionKindForLog(sessionId: string | undefined): string {
  const raw = String(sessionId || '');
  return raw ? (sessionKindOf(raw) || 'unknown') : '';
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function boundedServerFallbackReason(value: unknown): ServerModelFallbackReason {
  const reason = String(value || '').trim().toLowerCase();
  switch (reason) {
    case 'rate_limited':
    case 'transport_error':
    case 'configuration_error':
    case 'not_configured':
    case 'upstream_error':
    case 'empty_response':
    case 'unavailable':
      return reason;
    default:
      return 'unknown';
  }
}

function safeUsageForLog(usage: unknown): SafeUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const out: SafeUsage = {};
  const inputTokens = finiteNumber(u.inputTokens);
  const outputTokens = finiteNumber(u.outputTokens);
  const cacheReadTokens = finiteNumber(u.cacheReadTokens);
  const cacheWriteTokens = finiteNumber(u.cacheWriteTokens);
  const totalTokens = finiteNumber(u.totalTokens);
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) out.cacheWriteTokens = cacheWriteTokens;
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  return Object.keys(out).length ? out : undefined;
}

const MAX_PROVIDER_ROUND_PLAN_MUTATIONS = 4;
const SAFE_PLAN_MUTATION_ACTIONS = new Set<ProviderRoundPlanMutationEvidence['action']>(['update', 'set_statuses', 'append_step', 'set_status', 'clear', 'replace']);

function safePlanMutationForLog(event: Record<string, unknown>): ProviderRoundPlanMutationEvidence | undefined {
  if (event.isError || event.name !== 'manage_execution_plan' || typeof event.result !== 'string') return undefined;
  try {
    const parsed = JSON.parse(event.result) as Record<string, unknown>;
    const action = String(parsed.action || '') as ProviderRoundPlanMutationEvidence['action'];
    if (parsed.ok !== true || !SAFE_PLAN_MUTATION_ACTIONS.has(action)) return undefined;
    const revision = Math.max(0, Math.round(finiteNumber(parsed.revision) || 0));
    const updatedStepIds = Array.isArray(parsed.updated_step_ids)
      ? parsed.updated_step_ids.slice(0, 12)
      : [];
    const noOp = parsed.unchanged === true || parsed.updated === false || parsed.appended === false;
    return {
      action,
      initialExplicitPlan: action === 'update' && revision === 1 && !noOp,
      stepCount: Math.max(0, Math.round(finiteNumber(parsed.step_count) || 0)),
      changedStepCount: updatedStepIds.length,
      noOp,
    };
  } catch {
    return undefined;
  }
}

export function createModelRunLogDiagnostics(nowMs = Date.now()): ModelRunLogDiagnostics {
  return {
    startedAtMs: nowMs,
    rawEventCount: 0,
    streamEventCount: 0,
    textDeltaEvents: 0,
    textDeltaChars: 0,
    clientDeltaEvents: 0,
    clientDeltaChars: 0,
    progressEvents: 0,
    eventPayloads: 0,
    finalEvents: 0,
    errorEvents: 0,
    retryCount: 0,
    compactionCount: 0,
    compactionAttemptCount: 0,
    compactionFailureCount: 0,
    overflowRecoveryCount: 0,
    emergencyFoldCount: 0,
    emergencyNoDropCount: 0,
    rereadReads: 0,
    rereadPaths: 0,
    rereadIdentical: 0,
    providerCallCount: 0,
    providerCallMaxMs: 0,
    providerSlowCallCount: 0,
    structuredReasoningCallCount: 0,
    literalThinkContentCallCount: 0,
    providerUsage: {
      observedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    providerRounds: [],
    providerRoundsTruncated: 0,
    toolDeltaCount: 0,
    toolStarts: 0,
    toolProgress: 0,
    toolEnds: 0,
    toolErrors: 0,
    toolResultErrors: 0,
    toolResultErrorsRecovered: 0,
    toolEventSequence: 0,
    toolStartSequenceById: {},
    toolRecoveryKeyById: {},
    toolRecoveryFallbackKeyById: {},
    pendingToolResultErrorSequences: {},
    retryKinds: {},
    providerFallbackCount: 0,
    providerFallbackAuthCount: 0,
    providerFallbackTimeoutCount: 0,
    serverFallbackCount: 0,
    providerCandidateCount: 0,
    providerAvailableCandidateCount: 0,
    providerEmptyCount: 0,
    providerEmptyTransportCount: 0,
    providerEmptyNormalCount: 0,
    providerEmptySafetyCount: 0,
    providerEmptyUnknownCount: 0,
    providerEmptyTerminalCount: 0,
    providerEmptyOutputTokens: 0,
    lastFallbackCandidateIndex: 0,
    toolCounts: {},
    toolTimeline: [],
    toolTimelineTruncated: 0,
    runTimeline: [],
    runTimelineTruncated: 0,
    rawTextTimelineRecorded: false,
    clientDeltaTimelineRecorded: false,
    seenToolDeltaIds: {},
  };
}

function noteElapsedOnce(target: ModelRunLogDiagnostics, key: keyof ModelRunLogDiagnostics, nowMs: number): void {
  if (target[key] !== undefined) return;
  (target as unknown as Record<string, unknown>)[key as string] = Math.max(0, nowMs - target.startedAtMs);
}

function addProviderUsage(target: ProviderUsageAggregate, usage: SafeUsage | undefined): void {
  if (!usage) return;
  target.observedCalls += 1;
  target.inputTokens += Math.max(0, usage.inputTokens ?? 0);
  target.outputTokens += Math.max(0, usage.outputTokens ?? 0);
  target.cacheReadTokens += Math.max(0, usage.cacheReadTokens ?? 0);
  target.cacheWriteTokens += Math.max(0, usage.cacheWriteTokens ?? 0);
  target.totalTokens += Math.max(
    0,
    usage.totalTokens
      ?? ((usage.inputTokens ?? 0)
        + (usage.outputTokens ?? 0)
        + (usage.cacheReadTokens ?? 0)
        + (usage.cacheWriteTokens ?? 0)),
  );
}

function toolCounter(stats: ModelRunLogDiagnostics, rawName: unknown): ToolRunLogCounter {
  const name = String(rawName || 'unknown').slice(0, 80) || 'unknown';
  if (!stats.toolCounts[name]) {
    stats.toolCounts[name] = { starts: 0, progress: 0, ends: 0, errors: 0 };
  }
  return stats.toolCounts[name];
}

const MAX_TOOL_TIMELINE_LOG_ENTRIES = 80;
const MAX_RUN_TIMELINE_LOG_ENTRIES = 120;
const MAX_PROVIDER_ROUND_EVIDENCE = 64;
const MAX_PROVIDER_ROUND_TOOL_NAMES = 16;

function safeToolNameForLog(rawName: unknown): string {
  return String(rawName || 'unknown').slice(0, 80) || 'unknown';
}

type ToolRecoveryIdentity = {
  primaryKey: string;
  fallbackKey?: string;
};

const TOOL_OPERATION_SELECTOR_KEYS = new Set(['op', 'action', 'operation', 'tool_name']);

/** A low-cardinality operation identity used only inside one model run to
 * correlate an error with a later corrective call. Argument values are
 * intentionally excluded: they can contain private data and a correction
 * normally changes those values. When an invalid call omitted its operation
 * selector, its top-level schema shape is a conservative fallback for a retry
 * that supplies the selector. */
function toolRecoveryIdentity(rawName: unknown, rawInput: unknown): ToolRecoveryIdentity {
  const name = safeToolNameForLog(rawName);
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return { primaryKey: name };
  }
  const input = rawInput as Record<string, unknown>;
  const shape = Object.keys(input)
    .filter((key) => !TOOL_OPERATION_SELECTOR_KEYS.has(key))
    .sort()
    .join(',');
  const shapeKey = shape ? `${name}:shape=${shape}` : undefined;
  for (const key of TOOL_OPERATION_SELECTOR_KEYS) {
    const value = typeof input[key] === 'string' ? input[key].trim().slice(0, 80) : '';
    if (value) {
      return {
        primaryKey: `${name}:${key}=${value}`,
        ...(shapeKey ? { fallbackKey: shapeKey } : {}),
      };
    }
  }
  return { primaryKey: shapeKey || name };
}

function toolCallIdentity(rawId: unknown): string {
  return String(rawId || '');
}

function recordToolResultRecovery(
  stats: ModelRunLogDiagnostics,
  event: Record<string, unknown>,
  isReturnedError: boolean,
): void {
  const id = toolCallIdentity(event.id);
  const startedSequence = (id && stats.toolStartSequenceById[id]) || (stats.toolEventSequence + 1);
  const completedSequence = ++stats.toolEventSequence;
  const fallbackIdentity = toolRecoveryIdentity(event.name, undefined);
  const recoveryKey = (id && stats.toolRecoveryKeyById[id]) || fallbackIdentity.primaryKey;
  const recoveryFallbackKey = id ? stats.toolRecoveryFallbackKeyById[id] : undefined;
  if (id) {
    delete stats.toolStartSequenceById[id];
    delete stats.toolRecoveryKeyById[id];
    delete stats.toolRecoveryFallbackKeyById[id];
  }
  if (isReturnedError) {
    stats.toolResultErrors += 1;
    (stats.pendingToolResultErrorSequences[recoveryKey] ||= []).push(completedSequence);
    return;
  }
  if (event.isError) return;
  const candidateKeys = [...new Set([recoveryKey, recoveryFallbackKey].filter(Boolean) as string[])];
  for (const candidateKey of candidateKeys) {
    const pending = stats.pendingToolResultErrorSequences[candidateKey] || [];
    const recovered = pending.filter((failedSequence) => failedSequence < startedSequence).length;
    if (!recovered) continue;
    stats.toolResultErrorsRecovered += recovered;
    const unresolved = pending.filter((failedSequence) => failedSequence >= startedSequence);
    if (unresolved.length) stats.pendingToolResultErrorSequences[candidateKey] = unresolved;
    else delete stats.pendingToolResultErrorSequences[candidateKey];
  }
}

function noteToolTimelineForLog(
  stats: ModelRunLogDiagnostics,
  ev: Record<string, unknown>,
  phase: ToolTimelineLogEntry['phase'],
  nowMs: number,
): void {
  if (stats.toolTimeline.length >= MAX_TOOL_TIMELINE_LOG_ENTRIES) {
    stats.toolTimelineTruncated += 1;
    return;
  }
  const entry: ToolTimelineLogEntry = {
    seq: stats.toolTimeline.length + stats.toolTimelineTruncated + 1,
    elapsedMs: Math.max(0, nowMs - stats.startedAtMs),
    tool: safeToolNameForLog(ev.name),
    phase,
  };
  const rawId = ev.id;
  if (rawId !== undefined && rawId !== null && String(rawId)) entry.call_id = maskId(rawId);
  if (phase === 'end') {
    if (ev.isError !== undefined) entry.is_error = !!ev.isError;
    if (typeof ev.result === 'string') entry.result_chars = ev.result.length;
  }
  stats.toolTimeline.push(entry);
}

function noteRunTimelineForLog(
  stats: ModelRunLogDiagnostics,
  event: string,
  nowMs: number,
  detail?: string,
): void {
  if (stats.runTimeline.length >= MAX_RUN_TIMELINE_LOG_ENTRIES) {
    stats.runTimelineTruncated += 1;
    return;
  }
  stats.runTimeline.push({
    seq: stats.runTimeline.length + stats.runTimelineTruncated + 1,
    elapsedMs: Math.max(0, nowMs - stats.startedAtMs),
    event,
    ...(detail ? { detail } : {}),
  });
}

function formatRunTimelineEntryForLog(entry: RunTimelineLogEntry): string {
  return [
    `#${entry.seq}`,
    `+${entry.elapsedMs}ms`,
    entry.event,
    entry.detail,
  ].filter(Boolean).join(' ');
}

function formatToolTimelineEntryForLog(entry: ToolTimelineLogEntry): string {
  const parts = [
    `#${entry.seq}`,
    `+${entry.elapsedMs}ms`,
    entry.tool,
    entry.phase,
  ];
  if (entry.call_id) parts.push(`call=${entry.call_id}`);
  if (entry.is_error !== undefined) parts.push(`error=${entry.is_error ? 'true' : 'false'}`);
  if (entry.result_chars !== undefined) parts.push(`result_chars=${entry.result_chars}`);
  return parts.join(' ');
}

function retryKindForLog(rawReason: unknown): string {
  const reason = String(rawReason || '').toLowerCase();
  if (!reason) return 'unknown';
  if (reason.includes('empty response')) return 'empty_response';
  if (reason.includes('rate') || reason.includes('429')) return 'rate_limit';
  if (reason.includes('timeout') || reason.includes('timed out') || reason.includes('etimedout')) return 'timeout';
  if (reason.includes('abort')) return 'aborted';
  if (reason.includes('network') || reason.includes('fetch') || reason.includes('econn') || reason.includes('socket')) return 'network';
  if (reason.includes('auth') || reason.includes('unauthorized') || reason.includes('forbidden') || reason.includes('401') || reason.includes('403')) return 'auth';
  if (reason.includes('context')) return 'context';
  if (reason.includes('overload') || reason.includes('busy') || reason.includes('503') || reason.includes('502')) return 'overloaded';
  return 'provider';
}

export function recordModelRawEventForLog(stats: ModelRunLogDiagnostics, ev: unknown, nowMs = Date.now()): void {
  if (!stats || !ev || typeof ev !== 'object') return;
  stats.rawEventCount += 1;
  noteElapsedOnce(stats, 'firstRawEventMs', nowMs);
  const e = ev as Record<string, unknown>;
  switch (e.type) {
    case 'thinking': {
      const phase = String(e.phase || 'progress').slice(0, 16);
      const chars = Math.max(0, Math.round(finiteNumber(e.chars) || 0));
      // Reasoning proves that the model is alive, but it is not answer/tool
      // content and must not contaminate first-content latency. Log only size;
      // the mapper owns the separately sanitized process-pane representation.
      noteElapsedOnce(stats, 'firstModelEventMs', nowMs);
      noteRunTimelineForLog(stats, `thinking_${phase}`, nowMs, `chars=${chars}`);
      break;
    }
    case 'text_delta': {
      stats.textDeltaEvents += 1;
      stats.textDeltaChars += typeof e.text === 'string' ? e.text.length : 0;
      noteElapsedOnce(stats, 'firstTextDeltaMs', nowMs);
      noteElapsedOnce(stats, 'firstModelEventMs', nowMs);
      noteElapsedOnce(stats, 'firstContentMs', nowMs);
      if (!stats.rawTextTimelineRecorded) {
        stats.rawTextTimelineRecorded = true;
        noteRunTimelineForLog(stats, 'raw_text_delta', nowMs, `chars=${typeof e.text === 'string' ? e.text.length : 0}`);
      }
      break;
    }
    case 'tool_delta': {
      stats.toolDeltaCount += 1;
      noteElapsedOnce(stats, 'firstModelEventMs', nowMs);
      noteElapsedOnce(stats, 'firstContentMs', nowMs);
      const rawId = String(e.id || '');
      const key = rawId || `unknown-${stats.toolDeltaCount}`;
      if (!stats.seenToolDeltaIds[key]) {
        stats.seenToolDeltaIds[key] = true;
        const inputBytes = finiteNumber(e.inputBytes);
        noteRunTimelineForLog(
          stats,
          'tool_input_delta',
          nowMs,
          [
            `tool=${safeToolNameForLog(e.name)}`,
            rawId ? `call=${maskId(rawId)}` : '',
            inputBytes !== undefined ? `input_bytes=${inputBytes}` : '',
          ].filter(Boolean).join(' '),
        );
      }
      break;
    }
    case 'tool_start': {
      stats.toolStarts += 1;
      stats.toolEventSequence += 1;
      const providerRound = stats.providerRounds.at(-1);
      const providerRoundTool = safeToolNameForLog(e.name);
      if (providerRound
          && providerRound.toolNames.length < MAX_PROVIDER_ROUND_TOOL_NAMES
          && !providerRound.toolNames.includes(providerRoundTool)) {
        providerRound.toolNames.push(providerRoundTool);
      }
      const id = toolCallIdentity(e.id);
      if (id) {
        const recoveryIdentity = toolRecoveryIdentity(e.name, e.input);
        stats.toolStartSequenceById[id] = stats.toolEventSequence;
        stats.toolRecoveryKeyById[id] = recoveryIdentity.primaryKey;
        if (recoveryIdentity.fallbackKey) {
          stats.toolRecoveryFallbackKeyById[id] = recoveryIdentity.fallbackKey;
        }
      }
      toolCounter(stats, e.name).starts += 1;
      noteToolTimelineForLog(stats, e, 'start', nowMs);
      noteRunTimelineForLog(stats, 'tool_start', nowMs, `tool=${safeToolNameForLog(e.name)} call=${maskId(e.id)}`);
      noteElapsedOnce(stats, 'firstToolMs', nowMs);
      noteElapsedOnce(stats, 'firstModelEventMs', nowMs);
      noteElapsedOnce(stats, 'firstContentMs', nowMs);
      break;
    }
    case 'tool_progress': {
      stats.toolProgress += 1;
      toolCounter(stats, e.name).progress += 1;
      noteToolTimelineForLog(stats, e, 'progress', nowMs);
      noteRunTimelineForLog(stats, 'tool_progress', nowMs, `tool=${safeToolNameForLog(e.name)} call=${maskId(e.id)}`);
      break;
    }
    case 'tool_end': {
      stats.toolEnds += 1;
      const c = toolCounter(stats, e.name);
      c.ends += 1;
      if (e.isError && e.errorSeverity !== 'recoverable') {
        stats.toolErrors += 1;
        c.errors += 1;
      }
      noteToolTimelineForLog(stats, e, 'end', nowMs);
      noteRunTimelineForLog(
        stats,
        'tool_end',
        nowMs,
        `tool=${safeToolNameForLog(e.name)} call=${maskId(e.id)} error=${e.isError ? 'true' : 'false'}${e.errorSeverity ? ` severity=${e.errorSeverity}` : ''}`,
      );
      const runtimeException = ['tool_execution_exception', 'tool_execution_stalled', 'tool_result_processing_exception'].includes(String(e.errorCode || ''));
      recordToolResultRecovery(stats, e, !!e.isError && e.errorSeverity !== 'recoverable' && !runtimeException);
      const planMutation = safePlanMutationForLog(e);
      const providerRound = stats.providerRounds.at(-1);
      if (planMutation && providerRound) {
        providerRound.planMutations = [...(providerRound.planMutations || []), planMutation].slice(0, MAX_PROVIDER_ROUND_PLAN_MUTATIONS);
      }
      break;
    }
    case 'retry': {
      stats.retryCount += 1;
      const kind = retryKindForLog(e.reason);
      stats.retryKinds[kind] = (stats.retryKinds[kind] || 0) + 1;
      const attempt = finiteNumber(e.attempt);
      noteRunTimelineForLog(stats, 'retry', nowMs, `kind=${kind}${attempt !== undefined ? ` attempt=${attempt}` : ''}`);
      break;
    }
    case 'provider_fallback': {
      stats.providerFallbackCount += 1;
      if (e.reason === 'auth') stats.providerFallbackAuthCount += 1;
      if (e.reason === 'no_first_event_timeout') stats.providerFallbackTimeoutCount += 1;
      stats.providerCandidateCount = Math.max(
        stats.providerCandidateCount,
        Math.max(0, Math.round(finiteNumber(e.candidateCount) || 0)),
      );
      stats.lastFallbackCandidateIndex = Math.max(
        stats.lastFallbackCandidateIndex,
        Math.max(0, Math.round(finiteNumber(e.candidateIndex) || 0)),
      );
      noteRunTimelineForLog(
        stats,
        'provider_fallback',
        nowMs,
        [
          `reason=${String(e.reason || 'unknown').slice(0, 64)}`,
          stats.lastFallbackCandidateIndex ? `candidate=${stats.lastFallbackCandidateIndex}` : '',
          stats.providerCandidateCount ? `of=${stats.providerCandidateCount}` : '',
        ].filter(Boolean).join(' '),
      );
      break;
    }
    case 'provider_call': {
      const durationMs = Math.max(0, Math.round(finiteNumber(e.durationMs) || 0));
      const usage = safeUsageForLog(e.usage);
      stats.providerCallCount += 1;
      addProviderUsage(stats.providerUsage, usage);
      const reasoningBoundary = e.reasoningBoundary && typeof e.reasoningBoundary === 'object'
        ? e.reasoningBoundary as Record<string, unknown>
        : {};
      if (reasoningBoundary.structured === true) stats.structuredReasoningCallCount += 1;
      if (reasoningBoundary.literalLeadingText === true) stats.literalThinkContentCallCount += 1;
      stats.providerCallMaxMs = Math.max(stats.providerCallMaxMs, durationMs);
      if (durationMs >= 60_000) stats.providerSlowCallCount += 1;
      if (stats.providerRounds.length < MAX_PROVIDER_ROUND_EVIDENCE) {
        stats.providerRounds.push({
          index: stats.providerCallCount,
          durationMs,
          outcome: e.outcome === 'failed' ? 'failed' : 'completed',
          ...(typeof e.stopReason === 'string' && e.stopReason
            ? { stopReason: e.stopReason.slice(0, 64) }
            : {}),
          ...(Math.max(0, Math.round(finiteNumber(e.textChars) || 0)) > 0
            ? { textChars: Math.max(0, Math.round(finiteNumber(e.textChars) || 0)) }
            : {}),
          ...(usage ? { usage } : {}),
          toolNames: [],
        });
      } else {
        stats.providerRoundsTruncated += 1;
      }
      noteRunTimelineForLog(
        stats,
        'provider_call',
        nowMs,
        `outcome=${String(e.outcome || 'unknown')} duration_ms=${durationMs}`,
      );
      break;
    }
    case 'provider_empty': {
      stats.providerEmptyCount += 1;
      const kind = String(e.kind || 'unknown_empty');
      if (kind === 'transport_empty') stats.providerEmptyTransportCount += 1;
      else if (kind === 'normal_end_empty') stats.providerEmptyNormalCount += 1;
      else if (kind === 'safety_filtered_empty') stats.providerEmptySafetyCount += 1;
      else stats.providerEmptyUnknownCount += 1;
      if (e.terminalEventSeen) stats.providerEmptyTerminalCount += 1;
      const usage = e.usage && typeof e.usage === 'object'
        ? e.usage as Record<string, unknown>
        : {};
      stats.providerEmptyOutputTokens += Math.max(
        0,
        Math.round(finiteNumber(usage.outputTokens) || 0),
      );
      stats.providerCandidateCount = Math.max(
        stats.providerCandidateCount,
        Math.max(0, Math.round(finiteNumber(e.candidateCount) || 0)),
      );
      noteRunTimelineForLog(
        stats,
        'provider_empty',
        nowMs,
        `kind=${kind} terminal=${e.terminalEventSeen ? 'true' : 'false'}`,
      );
      break;
    }
    case 'compaction': {
      stats.compactionCount += 1;
      stats.lastCompactionTokensBefore = finiteNumber(e.tokensBefore) ?? stats.lastCompactionTokensBefore;
      stats.lastCompactionTokensAfter = finiteNumber(e.tokensAfter) ?? stats.lastCompactionTokensAfter;
      noteRunTimelineForLog(
        stats,
        'compaction',
        nowMs,
        [
          stats.lastCompactionTokensBefore !== undefined ? `before=${stats.lastCompactionTokensBefore}` : '',
          stats.lastCompactionTokensAfter !== undefined ? `after=${stats.lastCompactionTokensAfter}` : '',
        ].filter(Boolean).join(' '),
      );
      break;
    }
    case 'context_status': {
      const phase = typeof e.phase === 'string' ? e.phase : '';
      if (phase.endsWith('_start')) stats.compactionAttemptCount += 1;
      if (phase.endsWith('_failed')) stats.compactionFailureCount += 1;
      const statusData = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, unknown>;
      // Context-gate hits, per phase. An overflow whose recovery found nothing
      // is not counted here: that run terminates with error_code
      // context_overflow, which already carries the signal.
      if (phase === 'overflow_recovery' && statusData.result === 'retried') stats.overflowRecoveryCount += 1;
      if (phase === 'emergency_reduction' && statusData.result === 'applied') stats.emergencyFoldCount += 1;
      if (phase === 'emergency_reduction' && statusData.result === 'nothing_to_drop') stats.emergencyNoDropCount += 1;
      if (phase === 'history_summary_start' || phase === 'active_process_compaction_start') {
        stats.rereadReads += Math.max(0, Math.round(finiteNumber(statusData.readsSinceLastCompaction) ?? 0));
        stats.rereadPaths += Math.max(0, Math.round(finiteNumber(statusData.rereadPaths) ?? 0));
        stats.rereadIdentical += Math.max(0, Math.round(finiteNumber(statusData.rereadIdenticalContent) ?? 0));
      }
      noteRunTimelineForLog(
        stats,
        'context_status',
        nowMs,
        [phase, e.data && typeof e.data === 'object'
          ? String((e.data as Record<string, unknown>).disabledReason || '')
          : ''].filter(Boolean).join(' '),
      );
      break;
    }
    case 'done': {
      noteElapsedOnce(stats, 'firstModelEventMs', nowMs);
      noteElapsedOnce(stats, 'doneRawEventMs', nowMs);
      const result = e.result as { meta?: Record<string, unknown> } | undefined;
      const meta = result?.meta || {};
      stats.usage = safeUsageForLog(meta.usage) || stats.usage;
      stats.providerDurationMs = finiteNumber(meta.durationMs) ?? stats.providerDurationMs;
      stats.provider = typeof meta.provider === 'string' ? meta.provider : stats.provider;
      stats.model = typeof meta.model === 'string' ? meta.model : stats.model;
      stats.stopReason = typeof meta.stopReason === 'string' ? meta.stopReason : stats.stopReason;
      stats.toolLoops = finiteNumber(meta.toolLoops) ?? stats.toolLoops;
      stats.skillsLoadedCount = Array.isArray(meta.skillsLoaded) ? meta.skillsLoaded.length : stats.skillsLoadedCount;
      stats.transientToolErrors = finiteNumber(meta.transientToolErrors) ?? stats.transientToolErrors;
      stats.permanentToolErrors = finiteNumber(meta.permanentToolErrors) ?? stats.permanentToolErrors;
      stats.resultTextChars = typeof (e.result as { text?: unknown } | undefined)?.text === 'string'
        ? ((e.result as { text: string }).text.length)
        : stats.resultTextChars;
      stats.resultContentBlocks = Array.isArray((e.result as { content?: unknown } | undefined)?.content)
        ? ((e.result as { content: unknown[] }).content.length)
        : stats.resultContentBlocks;
      if ((stats.resultTextChars || 0) > 0 || (stats.resultContentBlocks || 0) > 0) {
        noteElapsedOnce(stats, 'firstContentMs', nowMs);
      }
      const err = meta.error as Record<string, unknown> | undefined;
      stats.errorKind = typeof err?.kind === 'string' ? err.kind : stats.errorKind;
      noteRunTimelineForLog(
        stats,
        'raw_done',
        nowMs,
        [
          stats.stopReason ? `stop=${stats.stopReason}` : '',
          stats.resultTextChars !== undefined ? `text_chars=${stats.resultTextChars}` : '',
          stats.errorKind ? `error_kind=${stats.errorKind}` : '',
        ].filter(Boolean).join(' '),
      );
      break;
    }
    default:
      break;
  }
}

export function recordModelStreamEventForLog(stats: ModelRunLogDiagnostics, ev: StreamEvent, nowMs = Date.now()): void {
  if (!stats || !ev) return;
  stats.streamEventCount += 1;
  noteElapsedOnce(stats, 'firstClientEventMs', nowMs);
  switch (ev.type) {
    case 'delta':
      stats.clientDeltaEvents += 1;
      stats.clientDeltaChars += typeof ev.text === 'string' ? ev.text.length : 0;
      if (!stats.clientDeltaTimelineRecorded) {
        stats.clientDeltaTimelineRecorded = true;
        noteRunTimelineForLog(stats, 'client_delta', nowMs, `chars=${typeof ev.text === 'string' ? ev.text.length : 0}`);
      }
      break;
    case 'progress':
      stats.progressEvents += 1;
      break;
    case 'event':
      stats.eventPayloads += 1;
      break;
    case 'final':
      stats.finalEvents += 1;
      noteRunTimelineForLog(stats, 'client_final', nowMs, `chars=${typeof ev.text === 'string' ? ev.text.length : 0}`);
      break;
    case 'error':
      stats.errorEvents += 1;
      noteRunTimelineForLog(stats, 'client_error', nowMs, `chars=${typeof ev.text === 'string' ? ev.text.length : 0} aborted=${ev.aborted ? 'true' : 'false'}`);
      break;
    case 'done':
      noteRunTimelineForLog(stats, 'client_done', nowMs);
      break;
    default:
      break;
  }
}

export function summarizeModelRunForLog(stats: ModelRunLogDiagnostics, nowMs = Date.now()): Record<string, unknown> {
  const toolNames = Object.keys(stats.toolCounts).sort();
  const toolResultErrorsWithoutObservedRecovery = Math.max(
    0,
    stats.toolResultErrors - stats.toolResultErrorsRecovered,
  );
  return {
    durationMs: Math.max(0, nowMs - stats.startedAtMs),
    rawEventCount: stats.rawEventCount,
    streamEventCount: stats.streamEventCount,
    textDeltaEvents: stats.textDeltaEvents,
    textDeltaChars: stats.textDeltaChars,
    clientDeltaEvents: stats.clientDeltaEvents,
    clientDeltaChars: stats.clientDeltaChars,
    progressEvents: stats.progressEvents,
    eventPayloads: stats.eventPayloads,
    finalEvents: stats.finalEvents,
    errorEvents: stats.errorEvents,
    retryCount: stats.retryCount,
    compactionCount: stats.compactionCount,
    compactionAttemptCount: stats.compactionAttemptCount,
    compactionFailureCount: stats.compactionFailureCount,
    overflowRecoveryCount: stats.overflowRecoveryCount,
    emergencyFoldCount: stats.emergencyFoldCount,
    emergencyNoDropCount: stats.emergencyNoDropCount,
    rereadReads: stats.rereadReads,
    rereadPaths: stats.rereadPaths,
    rereadIdentical: stats.rereadIdentical,
    providerCallCount: stats.providerCallCount,
    providerCallMaxMs: stats.providerCallMaxMs,
    providerSlowCallCount: stats.providerSlowCallCount,
    structuredReasoningCallCount: stats.structuredReasoningCallCount,
    literalThinkContentCallCount: stats.literalThinkContentCallCount,
    providerUsage: { ...stats.providerUsage },
    toolDeltaCount: stats.toolDeltaCount,
    toolStarts: stats.toolStarts,
    toolProgress: stats.toolProgress,
    toolEnds: stats.toolEnds,
    toolErrors: stats.toolErrors,
    toolResultErrors: stats.toolResultErrors,
    toolResultErrorsRecovered: stats.toolResultErrorsRecovered,
    toolResultErrorsWithoutObservedRecovery,
    // Backward-compatible log alias. Consumers must not interpret this as a
    // task-level unresolved blocker.
    toolResultErrorsUnresolved: toolResultErrorsWithoutObservedRecovery,
    toolNames,
    toolCounts: stats.toolCounts,
    toolTimeline: stats.toolTimeline.map(formatToolTimelineEntryForLog),
    toolTimelineTruncated: stats.toolTimelineTruncated,
    firstRawEventMs: stats.firstRawEventMs,
    firstModelEventMs: stats.firstModelEventMs,
    firstContentMs: stats.firstContentMs,
    firstClientEventMs: stats.firstClientEventMs,
    firstTextDeltaMs: stats.firstTextDeltaMs,
    firstToolMs: stats.firstToolMs,
    doneRawEventMs: stats.doneRawEventMs,
    providerDurationMs: stats.providerDurationMs,
    provider: stats.provider,
    model: stats.model,
    stopReason: stats.stopReason,
    errorKind: stats.errorKind,
    usage: stats.usage,
    resultTextChars: stats.resultTextChars,
    resultContentBlocks: stats.resultContentBlocks,
    toolLoops: stats.toolLoops,
    skillsLoadedCount: stats.skillsLoadedCount,
    transientToolErrors: stats.transientToolErrors,
    permanentToolErrors: stats.permanentToolErrors,
    lastCompactionTokensBefore: stats.lastCompactionTokensBefore,
    lastCompactionTokensAfter: stats.lastCompactionTokensAfter,
    retryKinds: stats.retryKinds,
    providerFallbackCount: stats.providerFallbackCount,
    providerFallbackAuthCount: stats.providerFallbackAuthCount,
    providerFallbackTimeoutCount: stats.providerFallbackTimeoutCount,
    serverFallbackCount: stats.serverFallbackCount,
    serverFallbackReason: stats.serverFallbackReason,
    effectiveModel: stats.effectiveModel,
    providerCandidateCount: stats.providerCandidateCount,
    providerAvailableCandidateCount: stats.providerAvailableCandidateCount,
    providerEmptyCount: stats.providerEmptyCount,
    providerEmptyTransportCount: stats.providerEmptyTransportCount,
    providerEmptyNormalCount: stats.providerEmptyNormalCount,
    providerEmptySafetyCount: stats.providerEmptySafetyCount,
    providerEmptyUnknownCount: stats.providerEmptyUnknownCount,
    providerEmptyTerminalCount: stats.providerEmptyTerminalCount,
    providerEmptyOutputTokens: stats.providerEmptyOutputTokens,
    lastFallbackCandidateIndex: stats.lastFallbackCandidateIndex,
    runTimeline: stats.runTimeline.map(formatRunTimelineEntryForLog),
    runTimelineTruncated: stats.runTimelineTruncated,
  };
}

function providerCategoryForTelemetry(providerId?: string): string {
  const text = String(providerId || '').trim().toLowerCase();
  if (!text) return 'unknown';
  const patterns: Array<[string, RegExp]> = [
    ['openai', /\b(openai|chatgpt|gpt)\b/],
    ['anthropic', /\b(anthropic|claude)\b/],
    ['google', /\b(google|gemini|vertex)\b/],
    ['xai', /\b(xai|grok)\b/],
    ['deepseek', /\bdeepseek\b/],
    ['qwen', /\b(qwen|dashscope|aliyun)\b/],
    ['doubao', /\b(doubao|volc|bytedance)\b/],
    ['moonshot', /\b(moonshot|kimi)\b/],
    ['zhipu', /\b(zhipu|glm|zai|z-ai)\b/],
    ['minimax', /\bminimax\b/],
    ['mistral', /\bmistral\b/],
    ['openrouter', /\bopenrouter\b/],
    ['azure', /\bazure\b/],
    ['bedrock', /\bbedrock\b/],
    ['ollama', /\bollama\b/],
    ['lmstudio', /\b(lmstudio|lm-studio)\b/],
    ['siliconflow', /\bsiliconflow\b/],
  ];
  for (const [category, pattern] of patterns) {
    if (pattern.test(text)) return category;
  }
  return 'custom';
}

function modelFamilyForTelemetry(modelId?: string, providerId?: string): string {
  const providerText = String(providerId || '').trim().toLowerCase();
  const modelText = String(modelId || '').trim().toLowerCase();
  if (!modelText && !providerText) return 'unknown';
  const text = `${providerText} ${modelText}`;
  const patterns: Array<[string, RegExp]> = [
    ['gpt', /\b(gpt|o[1-9]|chatgpt)\b/],
    ['claude', /\bclaude\b/],
    ['gemini', /\bgemini\b/],
    ['grok', /\bgrok\b/],
    ['deepseek', /\bdeepseek\b/],
    ['qwen', /\bqwen\b/],
    ['doubao', /\bdoubao\b/],
    ['kimi', /\b(kimi|moonshot)\b/],
    ['glm', /\b(glm|zhipu)\b/],
    ['minimax', /\bminimax\b/],
    ['mistral', /\bmistral\b/],
    ['mimo', /\bmimo\b/],
  ];
  for (const [family, pattern] of patterns) {
    if (pattern.test(text)) return family;
  }
  return 'other';
}

export function modelRunIdsForTelemetry(
  activeProviderId?: string,
  activeModelId?: string,
  responseProviderId?: string,
  responseModelId?: string,
): { providerId: string; modelId: string } {
  const configuredProvider = String(activeProviderId || '').trim();
  const configuredModel = String(activeModelId || '').trim();
  return {
    providerId: String(responseProviderId || '').trim() || configuredProvider,
    modelId: String(responseModelId || '').trim() || configuredModel,
  };
}

function toolCountBucketForTelemetry(count: number): string {
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  if (n === 0) return '0';
  if (n <= 5) return '1-5';
  if (n <= 20) return '6-20';
  if (n <= 50) return '21-50';
  return '51+';
}

function agentRunResultEventForTelemetry(input: {
  status: 'completed' | 'stopped' | 'waiting_input' | 'aborted' | 'idle_timeout' | 'error' | 'empty';
  durationMs: number;
  providerId?: string;
  modelId?: string;
  toolCount: number;
  nested: boolean;
  idleWindowSec?: number;
  idleTimeoutSec?: number;
  streamIdleTimeoutSec?: number;
  timings?: AgentRunTimings;
  failureCode?: string;
  failureRawCode?: string;
  failurePhase?: StreamEvent['failurePhase'];
}): StreamEvent {
  const result = input.status === 'completed' || input.status === 'waiting_input'
    ? 'success'
    : (input.status === 'stopped' ? 'stopped' : (input.status === 'aborted' ? 'aborted' : 'failure'));
  const errorCode = input.status === 'completed' || input.status === 'stopped' || input.status === 'waiting_input'
    ? ''
    : (input.failureCode || (input.status === 'empty' ? 'empty_response' : input.status));
  const data: Record<string, unknown> = {
    result,
    provider: providerCategoryForTelemetry(input.providerId),
    model: modelFamilyForTelemetry(input.modelId, input.providerId),
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    run_kind: input.nested ? 'nested' : 'top_level',
    has_tools: input.toolCount > 0,
    tool_count_bucket: toolCountBucketForTelemetry(input.toolCount),
  };
  if (Number.isFinite(input.idleTimeoutSec)) data.idle_timeout_sec = Math.max(0, Math.round(input.idleTimeoutSec || 0));
  if (Number.isFinite(input.streamIdleTimeoutSec)) data.stream_idle_timeout_sec = Math.max(0, Math.round(input.streamIdleTimeoutSec || 0));
  if (Number.isFinite(input.idleWindowSec)) data.idle_window_sec = Math.max(0, Math.round(input.idleWindowSec || 0));
  if (input.failurePhase) data.failure_phase = input.failurePhase;
  if (input.timings) {
    data.provider_ms = Math.max(0, Math.round(input.timings.providerMs));
    data.tool_ms = Math.max(0, Math.round(input.timings.toolMs));
    data.compaction_ms = Math.max(0, Math.round(input.timings.compactionMs));
    data.retry_wait_ms = Math.max(0, Math.round(input.timings.retryWaitMs));
    data.other_ms = Math.max(0, Math.round(input.timings.otherMs));
  }
  if (errorCode) data.error_code = errorCode;
  return { type: 'event', event: { stream: 'agent_run_result', data } };
}

export function modelTurnContextForLog(input: {
  userId?: string;
  sessionId?: string;
  cid?: string;
  turnId?: string;
  agentId?: string;
  projectId?: string;
  workingDir?: string;
  message?: string;
  systemPrompt?: string;
  images?: readonly unknown[];
  attachmentMetadata?: { hasAttachments?: boolean; attachmentTypes?: readonly string[] };
  historyResources?: readonly unknown[];
  idleTimeout?: number;
  toolInputIdleTimeout?: number;
  streamIdleTimeout?: number;
  providerWaitIdleTimeout?: number;
  maxToolLoops?: number;
  skillList?: readonly string[];
  toolList?: readonly string[];
  toolSurfaceMode?: 'scoped' | 'legacy_all';
  forceOpenSkillRefs?: readonly SkillSelectionInput[];
  extraTools?: readonly AgentTool[];
  extraRoots?: readonly string[];
  readOnlyExtraRoots?: readonly string[];
  fileReadOnlyExtraRoots?: readonly string[];
  cacheRetention?: string;
  thinkingLevel?: string;
  nested?: boolean;
  hasAbortSignal?: boolean;
  drainSteer?: unknown;
  providerId?: string;
  modelId?: string;
  profileId?: string;
  entryId?: string;
  resolvedSystemPrompt?: string;
  turnEphemeral?: string;
  toolDefs?: readonly ToolDefSnapshot[];
  buildDurationMs?: number;
}): Record<string, unknown> {
  const sessionKind = sessionKindForLog(input.sessionId);
  const toolDefs = input.toolDefs || [];
  const toolDefinitionChars = toolDefs.reduce((total, tool) => total + JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }).length, 0);
  const toolSourceCounts = toolDefs.reduce<Record<string, number>>((acc, t) => {
    const source = t?.source || 'unknown';
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
  return {
    user_id: maskId(input.userId),
    session_id: maskId(input.sessionId),
    session_kind: sessionKind,
    cid: maskId(input.cid),
    turn_id: maskId(input.turnId),
    agent_id: maskId(input.agentId),
    project_id: maskId(input.projectId),
    provider: input.providerId || undefined,
    model: input.modelId || undefined,
    profile_id: maskId(input.profileId),
    entry_id: maskId(input.entryId),
    message_chars: String(input.message || '').length,
    system_prompt_chars: String(input.systemPrompt || '').length,
    resolved_system_prompt_chars: input.resolvedSystemPrompt ? input.resolvedSystemPrompt.length : undefined,
    turn_ephemeral_chars: input.turnEphemeral ? input.turnEphemeral.length : undefined,
    image_count: Array.isArray(input.images) ? input.images.length : 0,
    has_attachments: input.attachmentMetadata?.hasAttachments,
    attachment_types: input.attachmentMetadata?.attachmentTypes ? [...input.attachmentMetadata.attachmentTypes].slice(0, 20) : undefined,
    history_resource_count: Array.isArray(input.historyResources) ? input.historyResources.length : 0,
    has_working_dir: !!input.workingDir,
    working_dir: input.workingDir ? logPathRef(input.workingDir) : undefined,
    idle_timeout_sec: input.idleTimeout,
    tool_input_idle_timeout_sec: input.toolInputIdleTimeout,
    stream_idle_timeout_sec: input.streamIdleTimeout,
    provider_wait_idle_timeout_sec: input.providerWaitIdleTimeout,
    max_tool_loops: input.maxToolLoops,
    // A named Agent without authored skill_list metadata does not receive the
    // Commander's full trusted roster. Its effective resident baseline is its
    // own private Skills; other shared Skills remain lazy behind skill_search.
    skill_list_mode: input.skillList === undefined
      ? (sessionKind === 'gmember' ? 'agent_defaults' : 'all')
      : 'allowlist',
    skill_list_count: input.skillList === undefined ? undefined : input.skillList.length,
    tool_list_mode: input.toolList === undefined ? 'legacy' : 'scoped',
    tool_list_count: input.toolList === undefined ? undefined : input.toolList.length,
    tool_surface_mode: input.toolSurfaceMode,
    force_open_skill_count: input.forceOpenSkillRefs?.length,
    extra_tool_count: input.extraTools?.length || 0,
    extra_root_count: input.extraRoots?.length || 0,
    read_only_extra_root_count: input.readOnlyExtraRoots?.length || 0,
    file_read_only_extra_root_count: input.fileReadOnlyExtraRoots?.length || 0,
    cache_retention: input.cacheRetention || undefined,
    thinking_level: input.thinkingLevel || undefined,
    nested: !!input.nested,
    has_abort_signal: !!input.hasAbortSignal,
    has_drain_steer: typeof input.drainSteer === 'function',
    tool_count: toolDefs.length,
    tool_definition_chars: toolDefinitionChars,
    tool_source_counts: toolSourceCounts,
    tool_names: toolDefs.map((t) => t.name).filter(Boolean).sort().slice(0, 80),
    tool_names_truncated: toolDefs.length > 80,
    build_duration_ms: input.buildDurationMs,
  };
}

/**
 * Stream chat using core-agent. Yields the same events as the openclaw
 * client so existing consumers don't care which backend is live.
 */
export async function* streamChatWithModel(opts: ChatOptions): AsyncGenerator<StreamEvent, void, unknown> {
  const runStartedAt = Date.now();
  const liveRunTimings = createLiveRunTimings(runStartedAt);
  const {
    userId, message,
    sessionId = `anon-${genConversationId().slice(0, 8)}`,
    conversationHistory,
    resumeActiveTurn = false,
    systemPrompt,
    agentName,
    workingDir,
    images,
    attachmentMetadata,
    historyResources,
    idleTimeout = AGENT_EXECUTION_IDLE_MS / 1000,
    toolInputIdleTimeout = idleTimeout,
    streamIdleTimeout = idleTimeout,
    providerWaitIdleTimeout = idleTimeout,
    executionDeadlineAt = agentExecutionDeadline(),
    maxToolLoops,
    elapsedConvergenceMs,
    abortSignal = null,
    skillList,
    systemSkillList,
    toolList,
    agentToolDependencyAuthoring = false,
    forceOpenSkillRefs,
    runtimeSkillBindings,
    runtimeGrantedToolGroups,
    extraTools,
    extraRoots,
    readOnlyExtraRoots,
    fileReadOnlyExtraRoots,
    runtimeReadOnlyRoots,
    richSteerEnabled = false,
    agentId,
    cid,
    conversationTitle,
    conversationTitleUpdatedAt,
    turnId,
    historyBoundaryMessageId,
    projectId,
    onFileWritten,
    onOutputsPublished,
    hasProducedPath,
    onArtifactCreated,
    onCustomConnectorAdded,
    onSkillAdvertised,
    onSkillInvoked,
    cacheRetention,
    thinkingLevel,
    nested = false,
    drainSteer,
    terminalTextGuard,
  } = opts;

  const diagnostics = createModelRunLogDiagnostics();
  let turnLogContext = modelTurnContextForLog({
    userId,
    sessionId,
    cid,
    turnId,
    agentId,
    projectId,
    workingDir,
    message,
    systemPrompt,
    images,
    attachmentMetadata,
    historyResources,
    idleTimeout,
    toolInputIdleTimeout,
    streamIdleTimeout,
    providerWaitIdleTimeout,
    maxToolLoops,
    skillList,
    toolList,
    forceOpenSkillRefs,
    extraTools,
    extraRoots,
    readOnlyExtraRoots,
    fileReadOnlyExtraRoots,
    cacheRetention,
    thinkingLevel,
    nested,
    hasAbortSignal: !!abortSignal,
    drainSteer,
  });
  const maskedSessionId = maskId(sessionId);
  const turnTag = `session=${maskedSessionId}`;

  // Acquire session lock first (scoped to this conversation), then one of
  // the global slots. Release in reverse order in `finally`. Both releases
  // go through idempotent wrappers so the abort-triggered immediate
  // release (see `onExternalAbort` / idle watchdog) and the generator's
  // natural `finally` can't both flip the Mutex and get into an
  // inconsistent state — whichever fires second is a no-op. We only log
  // release when `reason !== 'finally'` (i.e. an abort path) so the happy
  // path stays quiet.
  let _releaseSession: Releaser | undefined;
  let _slotRelease: Releaser | undefined;
  let sessionReleased = false;
  let slotReleased = false;
  let sessionLockWaitMs = 0;
  let globalSlotWaitMs = 0;
  let runnerBuildMs = 0;

  const releaseSessionOnce = (reason: string): void => {
    if (sessionReleased) return;
    sessionReleased = true;
    if (reason !== 'finally') log.info('release session-lock', { session_id: maskedSessionId, reason });
    try { _releaseSession?.(); } catch (err) { log.warn('release session-lock failed', { error: logErrorRef(err) }); }
  };
  const releaseSlotOnce = (reason: string): void => {
    if (slotReleased) return;
    slotReleased = true;
    if (reason !== 'finally') log.info('release global-slot', { session_id: maskedSessionId, reason });
    try { _slotRelease?.(); } catch (err) { log.warn('release global-slot failed', { error: logErrorRef(err) }); }
  };

  log.info('model turn queued', turnLogContext);
  const sessionLockWaitStartedAt = Date.now();
  _releaseSession = await sessionLock(`${userId}\0${sessionId}`).acquire();
  sessionLockWaitMs = Math.max(0, Date.now() - sessionLockWaitStartedAt);
  if (nested) {
    // G8d nested sub-run: do NOT take a global slot — the parent turn already
    // holds one, and acquiring another here would deadlock when the slot pool
    // is exhausted (parent holds a slot, blocks on the child's slot, no slot
    // ever frees). Bounded by the caller's dispatch cap instead. Mark the slot
    // released so every slot-release path (abort / idle / finally) is a no-op.
    slotReleased = true;
  } else {
    const globalSlotWaitStartedAt = Date.now();
    const [, slotRelease] = await globalSlots.acquire();
    globalSlotWaitMs = Math.max(0, Date.now() - globalSlotWaitStartedAt);
    _slotRelease = slotRelease;
  }
  log.info('model turn locks acquired', {
    ...turnLogContext,
    lock_wait_ms: sessionLockWaitMs + globalSlotWaitMs,
    session_lock_wait_ms: sessionLockWaitMs,
    global_slot_wait_ms: globalSlotWaitMs,
    global_slot_acquired: !nested,
  });

  // Build an AbortController that fires when the active phase's idle window
  // expires or the caller's external abortSignal fires.
  // core-agent honors the signal via params.signal on every provider call.
  //
  // On either abort we release the session + global-slot locks **immediately**,
  // not waiting for the generator's `finally` to run. Some provider stream
  // implementations (observed with pi-ai's WebSocket/SSE transports) don't
  // respond to `signal.aborted` promptly, so the `await iter.next()` stays
  // parked and the generator's `finally` never runs — which would leave the
  // session lock permanently held and the next turn stuck in "thinking". Since
  // `releaseXxxOnce` is idempotent, the `finally` block calling it again
  // is a no-op.
  const controller = new AbortController();
  let idleTimer: NodeJS.Timeout | null = null;
  let idleHit = false;
  let wallHit = false;
  const userWaitingTools = new Set<string>();
  let externalAbort = false;
  let directSessionAbort = false;
  // All phases default to the shared idle policy. Retain phase diagnostics and
  // explicit caller overrides for bounded component requests. Runner-owned
  // tools first get a recoverable per-tool timeout; the host backstop remains
  // slightly later. Executor-owned delegation is bounded by its child runtime.
  let toolDepth = 0;
  const activeToolTimeoutOwners = new Map<string, "runner" | "executor">();
  const assemblingToolCallIds = new Set<string>();
  let toolInputLastDeltaAt = 0;
  let modelTextStreamActive = false;
  let idleHitWindow = idleTimeout;
  const idleTimeoutText = () => idleHitWindow === AGENT_EXECUTION_IDLE_MS / 1000
    ? t('agent.execution_idle_timeout')
    : t('agent.execution_idle_timeout_seconds', { seconds: String(idleHitWindow) });
  let idleHitPhase: NonNullable<StreamEvent['failurePhase']> = 'provider_wait';
  const activeAbortEntry: ActiveSessionAbort = {
    abort: () => {
      directSessionAbort = true;
      log.info('direct session abort; releasing locks immediately', { session_id: maskedSessionId });
      controller.abort();
      releaseSlotOnce('session-abort');
      releaseSessionOnce('session-abort');
    },
  };
  addActiveSessionAbort(userId, sessionId, activeAbortEntry);

  // For runner-owned tools, keep the session-level tier strictly behind the
  // per-tool watchdog; both derive from the same configured idleTimeout.
  const TOOL_PHASE_BACKSTOP_RATIO = 1.15;
  const toolIdleTimeoutMs = Math.max(1, Math.round(idleTimeout * 1000));
  const toolPhaseBackstopMs = Math.max(
    toolIdleTimeoutMs + 1,
    Math.ceil(toolIdleTimeoutMs * TOOL_PHASE_BACKSTOP_RATIO),
  );
  const resetIdle = () => {
    if (controller.signal.aborted) return;
    if (idleTimer) clearTimeout(idleTimer);
    if (userWaitingTools.size > 0) {
      idleTimer = null;
      return;
    }
    const assemblingToolCall = assemblingToolCallIds.size > 0;
    const toolExecuting = toolDepth > 0;
    const executorOwnedToolsOnly = toolExecuting
      && activeToolTimeoutOwners.size === toolDepth
      && [...activeToolTimeoutOwners.values()].every((owner) => owner === "executor");
    // A synchronous delegation tool is already bounded by its Agent/Worker/CLI
    // executor. Do not stack a Commander session deadline on top of it. The
    // external abort listener remains active and still cancels the child.
    if (executorOwnedToolsOnly) {
      idleTimer = null;
      return;
    }
    // Phase overrides cannot widen argument/provider waits beyond the base
    // bound. Delegation has no stacked idle deadline; its child owns progress.
    const window = toolExecuting
      ? toolPhaseBackstopMs / 1000
      : assemblingToolCall
        ? Math.min(idleTimeout, toolInputIdleTimeout)
        : modelTextStreamActive
          ? streamIdleTimeout
          : Math.min(idleTimeout, providerWaitIdleTimeout);
    const phase: NonNullable<StreamEvent['failurePhase']> = toolDepth > 0
      ? 'tool'
      : (assemblingToolCall ? 'tool_input' : (modelTextStreamActive ? 'model_text' : 'provider_wait'));
    // Mapped or unrelated raw events may call resetIdle while arguments are
    // assembling. Preserve a true no-tool-delta deadline instead of extending
    // it for those events; only the timestamp updated by `tool_delta` renews it.
    const delayMs = assemblingToolCall && toolInputLastDeltaAt > 0
      ? Math.max(0, (window * 1000) - (Date.now() - toolInputLastDeltaAt))
      : window * 1000;
    idleTimer = setTimeout(() => {
      if (controller.signal.aborted) return;
      idleHit = true;
      idleHitWindow = window;
      idleHitPhase = phase;
      log.warn('idle-watchdog fired; aborting and releasing locks', {
        session_id: maskedSessionId,
        idle_seconds: window,
        phase,
      });
      controller.abort();
      releaseSlotOnce('idle-watchdog');
      releaseSessionOnce('idle-watchdog');
    }, delayMs);
  };
  resetIdle();
  const wallTimer = setTimeout(() => {
    if (controller.signal.aborted) return;
    wallHit = true;
    controller.abort();
    releaseSlotOnce('wall-watchdog');
    releaseSessionOnce('wall-watchdog');
  }, Math.max(0, executionDeadlineAt - Date.now()));
  wallTimer.unref?.();

  const onExternalAbort = () => {
    externalAbort = true;
    log.info('external abort; releasing locks immediately', { session_id: maskedSessionId });
    controller.abort();
    releaseSlotOnce('external-abort');
    releaseSessionOnce('external-abort');
  };
  if (abortSignal) {
    if (abortSignal.aborted) onExternalAbort();
    else abortSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const recorder: ReturnType<typeof startRecording> = startRecording(null);
  let agentRunResult: import('#core-agent').AgentRunResult | null = null;
  let finalText = '';
  let errText: string | null = null;
  let abortedFlag = false;
  let terminalFailureCode = '';
  let terminalFailureRawCode = '';
  let terminalFailurePhase: StreamEvent['failurePhase'];
  // Set only after runner construction and all host-side preflight gates pass.
  // This is the taxonomy boundary between setup/config failures and failures
  // produced by an attempted model run; do not replace it with text matching.
  let modelRunStarted = false;
  let activeProviderId = '';
  let activeModelId = '';
  let activeToolCount = 0;
  try {

    // Called back when pi-ai's onPayload hook injects the native web
    // search tool — write the event straight into the recorder so the
    // devtools archive's events[] shows
    // `progress/native_search/injected`. The recorder is instantiated
    // after buildRunner, but onPayload only fires after
    // runner.runStream, by which time the recorder is ready, so the
    // closure can simply read the outer `let` variable.
    const buildStartedAt = Date.now();
    log.info('model turn build start', turnLogContext);
    const built = await buildRunner({
      sessionId,
      systemPrompt,
      userId,
      agentId,
      ...(conversationHistory ? { conversationHistory } : {}),
      ...(resumeActiveTurn ? { resumeActiveTurn: true } : {}),
      ...(agentName ? { agentName } : {}),
      ...(maxToolLoops ? { maxToolLoops } : {}),
      // The per-tool stall watchdog derives from the same session idleTimeout
      // so the tool-phase backstop above stays strictly behind it: a stalled
      // tool fails as one recoverable tool error, never as a dead turn.
      toolIdleTimeoutMs,
      ...(elapsedConvergenceMs != null ? { elapsedConvergenceMs } : {}),
      providerFirstEventTimeoutMs: Math.max(1, streamIdleTimeout * 1000),
      ...(cid ? { cid } : {}),
      ...(conversationTitle ? { conversationTitle } : {}),
      ...(conversationTitleUpdatedAt ? { conversationTitleUpdatedAt } : {}),
      ...(turnId ? { turnId } : {}),
      ...(historyBoundaryMessageId ? { historyBoundaryMessageId } : {}),
      ...(message ? { userMessage: message } : {}),
      ...(attachmentMetadata ? { attachmentMetadata } : {}),
      ...(projectId ? { projectId } : {}),
      ...(skillList !== undefined ? { skillList } : {}),
      ...(systemSkillList !== undefined ? { systemSkillList: [...systemSkillList] } : {}),
      ...(toolList !== undefined ? { toolList } : {}),
      ...(agentToolDependencyAuthoring ? { agentToolDependencyAuthoring: true } : {}),
      ...(forceOpenSkillRefs && forceOpenSkillRefs.length ? { forceOpenSkillRefs } : {}),
      ...(runtimeSkillBindings ? { runtimeSkillBindings } : {}),
      ...(runtimeGrantedToolGroups ? { runtimeGrantedToolGroups } : {}),
      ...(extraTools && extraTools.length ? { extraTools } : {}),
      ...(extraRoots && extraRoots.length ? { extraRoots } : {}),
      ...(readOnlyExtraRoots && readOnlyExtraRoots.length ? { readOnlyExtraRoots } : {}),
      ...(fileReadOnlyExtraRoots && fileReadOnlyExtraRoots.length ? { fileReadOnlyExtraRoots } : {}),
      ...(runtimeReadOnlyRoots ? { runtimeReadOnlyRoots } : {}),
      ...(richSteerEnabled ? { richSteerEnabled: true } : {}),
      ...(onFileWritten ? { onFileWritten } : {}),
      ...(onOutputsPublished ? { onOutputsPublished } : {}),
      ...(hasProducedPath ? { hasProducedPath } : {}),
      ...(onArtifactCreated ? { onArtifactCreated } : {}),
      ...(onCustomConnectorAdded ? { onCustomConnectorAdded } : {}),
      ...(onSkillAdvertised ? { onSkillAdvertised } : {}),
      ...(onSkillInvoked ? { onSkillInvoked } : {}),
      onNativeSearchInjected: (info) => {
        recorder.record({
          type: 'progress',
          event: { stream: 'native_search', data: { phase: 'injected', ...info } },
        });
      },
      // rotating-provider commits / surfaced-error candidate notice. Rewrite
      // the archive row so model / provider / profile reflect the candidate
      // that actually owned this call's visible outcome, not the rotating-
      // provider's primary label. Recorder may not be set yet at the moment
      // buildRunner eagerly constructs the rotating-provider; fires at runtime
      // when complete()/stream() actually picks a candidate, so the recorder
      // is always live by then.
      onCandidateChosen: (info) => {
        recorder.setActiveCandidate(info);
      },
      onCandidatesObserved: (info) => {
        diagnostics.providerCandidateCount = Math.max(
          diagnostics.providerCandidateCount,
          Math.max(0, Math.round(Number(info.candidateCount) || 0)),
        );
        diagnostics.providerAvailableCandidateCount = Math.max(
          0,
          Math.round(Number(info.availableCandidateCount) || 0),
        );
      },
    }).finally(() => {
      runnerBuildMs = Math.max(0, Date.now() - buildStartedAt);
    });
    const {
      runner,
      failureTrackingScope,
      providerId,
      modelId,
      toolSurfaceMode,
      toolSurfaceTelemetry,
      resolvedSystemPrompt,
      turnEphemeral,
      profileId,
      entryId,
      toolDefs,
      skillDisplayNameById,
      skillMetadataByReadRef,
      agentDisplayNameById,
      connectorDisplayNameById,
    } = built;
    activeProviderId = providerId || '';
    activeModelId = modelId || '';
    activeToolCount = toolDefs.length;
    turnLogContext = modelTurnContextForLog({
      userId,
      sessionId,
      cid,
      turnId,
      agentId,
      projectId,
      workingDir,
      message,
      systemPrompt,
      images,
      attachmentMetadata,
      historyResources,
      idleTimeout,
      toolInputIdleTimeout,
      streamIdleTimeout,
      providerWaitIdleTimeout,
      maxToolLoops,
      skillList,
      toolList,
      toolSurfaceMode,
      forceOpenSkillRefs,
      extraTools,
      extraRoots,
      readOnlyExtraRoots,
      fileReadOnlyExtraRoots,
      cacheRetention,
      thinkingLevel,
      nested,
      hasAbortSignal: !!abortSignal,
      drainSteer,
      providerId,
      modelId,
      profileId,
      entryId,
      resolvedSystemPrompt,
      turnEphemeral,
      toolDefs,
      buildDurationMs: runnerBuildMs,
    });
    log.info('model turn ready', turnLogContext);

    startRecording({
      userId,
      sessionId,
      input: {
        message,
        systemPrompt: resolvedSystemPrompt,
        model: modelId,
        provider: providerId,
        profileId,
        entryId,
        tools: toolDefs,
      },
      context: {
        ...(agentId ? { agentId } : {}),
        ...(cid ? { cid } : {}),
        ...(workingDir ? { workingDir } : {}),
        // skillList: undefined → no allowlist (full listing); preserve as null
        // so the renderer can distinguish "all skills" from "explicit []".
        skillList: skillList === undefined ? null : [...skillList],
        ...(extraRoots && extraRoots.length ? { extraRoots: [...extraRoots] } : {}),
        ...(readOnlyExtraRoots && readOnlyExtraRoots.length ? { readOnlyExtraRoots: [...readOnlyExtraRoots] } : {}),
        ...(fileReadOnlyExtraRoots && fileReadOnlyExtraRoots.length ? { fileReadOnlyExtraRoots: [...fileReadOnlyExtraRoots] } : {}),
        ...(cacheRetention ? { cacheRetention } : {}),
        idleTimeoutSec: idleTimeout,
        ...(images && images.length ? { imageCount: images.length } : {}),
        ...(attachmentMetadata ? {
          attachmentMetadata: {
            hasAttachments: !!attachmentMetadata.hasAttachments,
            attachmentTypes: [...(attachmentMetadata.attachmentTypes || [])],
          },
        } : {}),
        ...(historyResources && historyResources.length ? { historyResourceCount: historyResources.length } : {}),
        ...(abortSignal ? { hasAbortSignal: true } : {}),
      },
    });

    const sandboxEnv = buildSkillSandboxEnv(userId, agentId);

    log.info('model turn run start', turnLogContext);
    const requestMetadata = attachmentMetadata ? { attachmentMetadata } : {};

    if (Date.now() >= executionDeadlineAt) {
      wallHit = true;
      controller.abort();
      throw new Error('Agent execution deadline reached before provider dispatch');
    }
    modelRunStarted = true;
    transitionLiveRunTimings(liveRunTimings, 'provider');
    const rawEvents = runner.runStream({
      message,
      ...(resumeActiveTurn ? { resumeActiveTurn: true } : {}),
      signal: controller.signal,
      sandboxEnv,
      ...(workingDir ? { workingDir } : {}),
      ...(turnEphemeral ? { turnEphemeral } : {}),
      ...(images && images.length ? { images } : {}),
      ...(historyResources && historyResources.length ? { historyResources } : {}),
      ...(Object.keys(requestMetadata).length ? { requestMetadata } : {}),
      ...(cacheRetention ? { cacheRetention } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(drainSteer ? { drainSteer } : {}),
      ...(terminalTextGuard ? { terminalTextGuard } : {}),
    });

    // Wrap raw events to capture the AgentRunResult for post-run reflection.
    async function* captureResult(events: AsyncIterable<import('#core-agent').AgentRunEvent>) {
      for await (const ev of events) {
        const liveNow = Date.now();
        if (liveRunTimings.phase === 'retry_wait' && ev.type !== 'retry') {
          transitionLiveRunTimings(liveRunTimings, 'provider', liveNow);
        }
        if (ev.type === 'context_status') {
          if (ev.phase.endsWith('_start')) {
            transitionLiveRunTimings(liveRunTimings, 'compaction', liveNow);
          } else if (liveRunTimings.phase === 'compaction') {
            transitionLiveRunTimings(liveRunTimings, 'provider', liveNow);
          }
        } else if (ev.type === 'retry') {
          transitionLiveRunTimings(liveRunTimings, 'retry_wait', liveNow);
        } else if (ev.type === 'tool_start' && toolDepth === 0) {
          transitionLiveRunTimings(liveRunTimings, 'tool', liveNow);
        }
        recordModelRawEventForLog(diagnostics, ev);
        if (ev.type === 'done') agentRunResult = ev.result;
        // Track tool-execution phase from the RAW events (stable discriminants)
        // so the idle watchdog uses the long window while a tool is in flight.
        // tool_start fires before the tool body awaits and tool_end after, so
        // toolDepth > 0 spans the whole (possibly silent) tool execution.
        else if (ev.type === 'text_delta') {
          modelTextStreamActive = true;
        } else if (ev.type === 'thinking') {
          // Reasoning deltas use the longer provider-wait idle window. The
          // raw events still reset that watchdog on every chunk below.
          modelTextStreamActive = false;
        } else if (ev.type === 'tool_delta') {
          modelTextStreamActive = false;
          assemblingToolCallIds.add(ev.id || 'stream_tool');
          toolInputLastDeltaAt = Date.now();
        } else if (ev.type === 'tool_start') {
          modelTextStreamActive = false;
          assemblingToolCallIds.clear();
          toolInputLastDeltaAt = 0;
          toolDepth += 1;
          activeToolTimeoutOwners.set(
            ev.id,
            ev.executionTimeoutOwner === 'executor' ? 'executor' : 'runner',
          );
        } else if (ev.type === 'tool_end') {
          userWaitingTools.delete(ev.id);
          modelTextStreamActive = false;
          assemblingToolCallIds.delete(ev.id || 'stream_tool');
          if (assemblingToolCallIds.size === 0) toolInputLastDeltaAt = 0;
          activeToolTimeoutOwners.delete(ev.id);
          toolDepth = Math.max(0, toolDepth - 1);
          if (toolDepth === 0 && liveRunTimings.phase === 'tool') {
            transitionLiveRunTimings(liveRunTimings, 'provider', liveNow);
          }
        }
        // Some raw events intentionally do not map to visible UI events
        // (e.g. an empty tool-input delta before a large write_file argument).
        // They are still provider activity and must refresh the watchdog.
        let resumedUserWait = false;
        if (ev.type === 'tool_progress') {
          if (ev.data?.userAction === true) userWaitingTools.add(ev.id);
          else resumedUserWait = userWaitingTools.delete(ev.id);
        }
        // UI-only heartbeats cannot extend a stalled execution. User-action
        // progress pauses the idle timer until the tool resumes or completes.
        if (resumedUserWait || ev.type !== 'tool_progress' || ev.data?.heartbeat !== true || ev.data?.userAction === true) resetIdle();
        yield ev;
      }
    }

    // The event mapper yields Orkas-shape events and handles the
    // terminal final/error synthesis. Only raw protocol events own liveness.
    let eventCount = 0;
    let flushReasoningBeforeAbort: (() => StreamEvent | null) | null = null;
    const mappedEvents = mapCoreAgentEvents(captureResult(rawEvents), {
      userId,
      failureTrackingScope,
      isDev: false,
      workingDir,
      skillDisplayNameById,
      skillMetadataByReadRef,
      agentDisplayNameById,
      connectorDisplayNameById,
      registerReasoningAbortFlush: (flush) => { flushReasoningBeforeAbort = flush; },
    });
    const abortableEvents = stopStreamOnAbort(
      mappedEvents,
      controller.signal,
      turnTag,
      () => flushReasoningBeforeAbort?.() ?? null,
    );
    for await (const ev of abortableEvents) {
      eventCount += 1;
      // The watchdog supplies the single classified terminal error below.
      if (ev.type === 'error' && (wallHit || idleHit)) continue;
      let outgoing: StreamEvent = ev;
      if (ev.type === 'error' && !(ev as StreamEvent).aborted) {
        terminalFailureCode = (ev as StreamEvent).failureCode || 'model_stream_error';
        terminalFailureRawCode = (ev as StreamEvent).failureRawCode || '';
        terminalFailurePhase = (ev as StreamEvent).failurePhase || (finalText ? 'model_text' : 'provider_wait');
        outgoing = {
          ...ev,
          failureKind: (ev as StreamEvent).failureKind || 'model',
          failureCode: terminalFailureCode,
          failurePhase: terminalFailurePhase,
        };
      }
      recordModelStreamEventForLog(diagnostics, outgoing);
      recorder.record(outgoing as any);
      if (outgoing.type === 'final') finalText = outgoing.text || finalText;
      if (outgoing.type === 'error') {
        errText = outgoing.text || errText;
        if (outgoing.aborted) abortedFlag = true;
      }
      // NOTE: compaction summaries are deliberately NOT mined into cross-session
      // memory. That hook persisted transient task progress (the summary is
      // work-in-progress, not durable user facts) into MEMORY.md. Memory is now
      // written only by the explicit `cross_session_memory` tool.
      yield outgoing;
    }
    log.info('model turn stream drained', {
      ...turnLogContext,
      mapped_events: eventCount,
      final_chars: finalText.length,
      has_error: !!errText,
      diagnostics: summarizeModelRunForLog(diagnostics),
    });

    // Metacognitive reflection is no longer triggered per-turn — it now
    // runs from the background orchestrator on a 12h cycle. See
    // `features/reflection-orchestrator.ts`. Keeping `agentRunResult`
    // captured above for the recorder/archive payload.

    if (externalAbort || directSessionAbort) {
      // mapCoreAgentEvents may have already yielded 'error: empty response'
      // for the short-circuit; tag the stream as aborted for the client.
      abortedFlag = true;
      const abortEvent: StreamEvent = { type: 'error', text: 'aborted', aborted: true };
      recordModelStreamEventForLog(diagnostics, abortEvent);
      recorder.record(abortEvent as any);
      yield abortEvent;
    } else if (wallHit) {
      errText = t('agent.execution_wall_timeout');
      terminalFailureCode = 'execution_wall_timeout';
      const wallEvent: StreamEvent = { type: 'error', text: errText, failureKind: 'model', failureCode: terminalFailureCode };
      recordModelStreamEventForLog(diagnostics, wallEvent);
      recorder.record(wallEvent as any);
      yield wallEvent;
    } else if (idleHit) {
      errText = idleTimeoutText();
      terminalFailureCode = 'idle_timeout';
      terminalFailurePhase = idleHitPhase;
      const idleEvent: StreamEvent = {
        type: 'error',
        text: errText,
        failureKind: 'model',
        failureCode: 'idle_timeout',
        failurePhase: idleHitPhase,
      };
      recordModelStreamEventForLog(diagnostics, idleEvent);
      recorder.record(idleEvent as any);
      yield idleEvent;
    }
  } catch (err) {
    if (wallHit) {
      errText = t('agent.execution_wall_timeout');
      terminalFailureCode = 'execution_wall_timeout';
      const wallEvent: StreamEvent = { type: 'error', text: errText, failureKind: 'model', failureCode: terminalFailureCode };
      recordModelStreamEventForLog(diagnostics, wallEvent);
      recorder.record(wallEvent as any);
      yield wallEvent;
    } else if (idleHit) {
      errText = idleTimeoutText();
      terminalFailureCode = 'idle_timeout';
      terminalFailurePhase = idleHitPhase;
      log.warn('model turn idle timeout surfaced after stream error', { ...turnLogContext, error: logErrorSummary(err) });
      const idleEvent: StreamEvent = {
        type: 'error',
        text: errText,
        failureKind: 'model',
        failureCode: 'idle_timeout',
        failurePhase: idleHitPhase,
      };
      recordModelStreamEventForLog(diagnostics, idleEvent);
      recorder.record(idleEvent as any);
      yield idleEvent;
    } else if (externalAbort || directSessionAbort || controller.signal.aborted) {
      errText = 'aborted';
      abortedFlag = true;
      log.info('model turn aborted', turnLogContext);
      const abortEvent: StreamEvent = { type: 'error', text: errText, aborted: true };
      recordModelStreamEventForLog(diagnostics, abortEvent);
      recorder.record(abortEvent as any);
      yield abortEvent;
    } else {
      errText = (err as Error).message || String(err);
      terminalFailureCode = modelRunStarted ? 'model_stream_error' : 'model_preflight';
      terminalFailurePhase = modelRunStarted ? 'provider_wait' : 'preflight';
      log.error('model turn stream error', { ...turnLogContext, error: logErrorSummary(err) });
      const errorEvent: StreamEvent = {
        type: 'error',
        text: errText,
        failureKind: modelRunStarted ? 'model' : 'config',
        failureCode: terminalFailureCode,
        failurePhase: terminalFailurePhase,
      };
      recordModelStreamEventForLog(diagnostics, errorEvent);
      recorder.record(errorEvent as any);
      yield errorEvent;
    }
  } finally {
    removeActiveSessionAbort(userId, sessionId, activeAbortEntry);
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(wallTimer);
    if (abortSignal) abortSignal.removeEventListener?.('abort', onExternalAbort);
    // Heal orphan tool_use in the cached session before releasing the
    // per-session lock. The PersistentSession instance is cached per
    // sessionId (session-store.ts) and survives across turns, so the
    // constructor's load-time heal doesn't fire again once a turn aborts
    // mid-tool-execution. Without this, the next turn would reuse a
    // memory-resident session whose last assistant message has an
    // unmatched tool_use — provider APIs silently hang on that shape,
    // which surfaces as a "thinking" state that never ends. Heal is idempotent and
    // a no-op on healthy sessions, so running it unconditionally every
    // turn is safe.
    try {
      const cached = await _getCachedSessionForUser(userId, sessionId);
      if (cached && typeof (cached as { healAndPersist?: () => boolean }).healAndPersist === 'function') {
        if (cached.healAndPersist()) {
          const report = typeof (cached as { getLastToolProtocolRepairReport?: () => unknown }).getLastToolProtocolRepairReport === 'function'
            ? (cached as { getLastToolProtocolRepairReport: () => Record<string, unknown> }).getLastToolProtocolRepairReport()
            : {};
          const invalid = Number(report.synthesizedOrphanResults || 0) > 0
            || Number(report.droppedUnmatchedResults || 0) > 0;
          if (invalid) {
            log.warn('repaired invalid tool protocol after turn', { session_id: maskedSessionId, ...report });
          } else {
            log.info('normalized parallel tool results after turn', { session_id: maskedSessionId, ...report });
          }
        }
      }
    } catch (err) {
      log.warn('post-turn heal failed', { ...turnLogContext, error: logErrorRef(err) });
    }
    // One-shot sessions (anon / gworker / reflect / extract-img /
    // memory-extract) are never resumed by anyone, and their ids are minted
    // fresh per run — without eviction the session-store cache retains one
    // full transcript per background run forever. Runs AFTER healAndPersist
    // (which re-caches via getSession) and before the lock release, so no
    // concurrent turn can be holding the evicted instance. Conversation-backed
    // kinds are a no-op inside evictEphemeralSession.
    try { evictEphemeralSession(userId, sessionId); }
    catch (err) { log.warn('ephemeral session evict failed', { session_id: maskedSessionId, error: logErrorRef(err) }); }
    releaseSlotOnce('finally');
    releaseSessionOnce('finally');
    const doneEvent: StreamEvent = { type: 'done' };
    recordModelStreamEventForLog(diagnostics, doneEvent);
    const terminalStatus = abortedFlag
      ? 'aborted'
      : (errText
          ? (idleHit ? 'idle_timeout' : 'error')
          : (agentRunResult?.meta.termination?.status === 'waiting_input'
              ? 'waiting_input'
              : (agentRunResult?.meta.termination?.status === 'stopped'
                  ? 'stopped'
                  : (finalText ? 'completed' : 'empty'))));
    const telemetryIds = modelRunIdsForTelemetry(
      activeProviderId,
      activeModelId,
      diagnostics.provider,
      diagnostics.model,
    );
    yield agentRunResultEventForTelemetry({
      status: terminalStatus,
      durationMs: Date.now() - runStartedAt,
      providerId: telemetryIds.providerId,
      modelId: telemetryIds.modelId,
      toolCount: activeToolCount,
      nested,
      idleWindowSec: idleHit ? idleHitWindow : undefined,
      idleTimeoutSec: idleTimeout,
      streamIdleTimeoutSec: streamIdleTimeout,
      timings: agentRunResult?.meta.timings || snapshotLiveRunTimings(liveRunTimings),
      failureCode: terminalFailureCode || undefined,
      failureRawCode: terminalFailureRawCode || undefined,
      failurePhase: terminalFailurePhase
        || (terminalStatus === 'aborted' ? liveRunFailurePhase(liveRunTimings.phase) : undefined),
    });
    const timingSummary = modelRunTimingSummaryForLog(
      Date.now() - runStartedAt,
      agentRunResult?.meta.timings || snapshotLiveRunTimings(liveRunTimings),
    );
    log.info('model turn finish', {
      ...turnLogContext,
      status: terminalStatus,
      aborted: abortedFlag,
      idle_hit: idleHit,
      idle_window_sec: idleHit ? idleHitWindow : undefined,
      final_chars: finalText.length,
      has_error: !!errText,
      error: errText ? logErrorRef(new Error(errText)) : undefined,
      timings: timingSummary,
      diagnostics: summarizeModelRunForLog(diagnostics),
    });
    recordUsageTokens(cid, { inputTokens: diagnostics.usage?.inputTokens ?? 0, outputTokens: diagnostics.usage?.outputTokens ?? 0 });
    try { recorder.finish({ text: finalText, aborted: abortedFlag, error: errText }); }
    catch (err) { log.warn('archive finish failed', { error: logErrorRef(err) }); }
    yield doneEvent;
  }
}

/** Blocking chat — drains the stream and picks up the final/error event. */
export async function chatWithModel(opts: ChatOptions): Promise<ChatResult> {
  let finalText: string | null = null;
  let partialText = '';
  let errText: string | null = null;
  let aborted = false;
  for await (const ev of streamChatWithModel(opts)) {
    if (ev.type === 'delta' && typeof ev.text === 'string') partialText += ev.text;
    else if (ev.type === 'final') finalText = ev.text || '';
    else if (ev.type === 'error' && !errText) errText = ev.text || '';
    if (ev.aborted) aborted = true;
  }
  if (finalText) return { ok: true, text: finalText, error: '', aborted: false };
  return {
    ok: false,
    text: partialText,
    error: errText || 'unknown error',
    aborted,
  };
}
