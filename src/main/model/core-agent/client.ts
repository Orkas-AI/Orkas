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
 *   - Per-session Mutex + 5-slot global Semaphore (`util/locks`)
 *   - Idle watchdog: no event for `idleTimeout` seconds → abort
 *   - External AbortSignal honored
 *   - Returned event shapes + final reply accumulation
 */

import {
  sessionLock, globalSlots,
  type Releaser,
} from '../../util/locks';
import type { AgentTool } from '#core-agent';
import { createLogger } from '../../logger';
import { logErrorRef, logErrorSummary, logPathRef, maskId } from '../../util/log-redact';

const log = createLogger('model');
import { genConversationId } from '../../storage';
import type { ChatOptions, ChatResult, StreamEvent } from '../client';

import { buildRunner, type ToolDefSnapshot } from './runner';
import { mapCoreAgentEvents } from './event-mapper';
import { getSession as _getCachedSession } from './session-store';
import { app } from 'electron';
import * as fs from 'node:fs';
import * as paths from '../../paths';
import { getCurrentLang } from '../../i18n';
import { bundledRuntimeEnv, bundledRuntimePathEntries } from '../../util/bundled-runtime';

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
 * Env vars injected into the sandbox child process so skill scripts can
 * run under Electron-as-Node:
 *   - `ORKAS_NODE` = Electron binary path (runs as stock Node because of
 *     `ELECTRON_RUN_AS_NODE=1` in the child env)
 *   - `ORKAS_PC_DIR` = PC root, rewritten to `app.asar.unpacked` in
 *     packaged mode so `bin/run-skill.cjs` + tsx + skills resolve on real disk
 *   - `ORKAS_WORKSPACE_ROOT` = canonical data root so `run-skill.cjs` can
 *     find installed per-user skills under `<uid>/local/marketplace/skills`
 *   - `ORKAS_PYTHON` / `ORKAS_UV` / `ORKAS_BUNDLED_NODE` = optional bundled
 *     runtimes under resources/runtime. `ORKAS_NODE` intentionally remains
 *     Electron-as-Node for Orkas internal scripts; package CLIs use bundled
 *     Node via PATH / `ORKAS_BUNDLED_NODE`.
 *   - `ORKAS_VENV_ROOT` = shared machine-local dependency env root under
 *     data/venv, plus uv/pip/npm cache dirs there so package installs survive
 *     app updates and are reused across Orkas accounts on this device
 *   - `ELECTRON_RUN_AS_NODE` = makes the Electron binary boot as Node
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
  _skillSandboxEnvStatic = {
    ORKAS_NODE: process.execPath,
    ORKAS_PC_DIR: pcDir,
    ORKAS_WORKSPACE_ROOT: paths.WS_ROOT,
    ELECTRON_RUN_AS_NODE: '1',
  };
  return _skillSandboxEnvStatic;
}

/**
 * Per-turn sandbox env = cached static part + uid-derived dynamic part
 * (never cached module-level — CLAUDE.md §4):
 *   - `ORKAS_UID` = the turn's user id, so `bin/orkas-pkg.cjs` (and other
 *     bash-driven CLIs) resolve the right per-user data tree without
 *     parsing users.json.
   *   - `ORKAS_PATH_PREPEND` = bundled runtime bins plus enabled external
   *     package CLI dirs (`.bin`, package-local bin fallbacks) when present.
   *     Composed into PATH by the sandbox executor (see core-agent
   *     sandbox/executor.ts) so the augmented brew/system PATH is preserved.
 */
export function buildSkillSandboxEnv(userId?: string): Record<string, string> {
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

function addActiveSessionAbort(sessionId: string, entry: ActiveSessionAbort): void {
  let set = activeSessionAborts.get(sessionId);
  if (!set) {
    set = new Set();
    activeSessionAborts.set(sessionId, set);
  }
  set.add(entry);
}

function removeActiveSessionAbort(sessionId: string, entry: ActiveSessionAbort): void {
  const set = activeSessionAborts.get(sessionId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) activeSessionAborts.delete(sessionId);
}

export function abortActiveSession(sessionId: string): number {
  const set = activeSessionAborts.get(sessionId);
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

export function abortActiveSessionsForConversation(cid: string): number {
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
  for (const sessionId of Array.from(activeSessionAborts.keys())) {
    if (sessionId === commanderSession || sessionId.startsWith(memberPrefix) || sessionId.startsWith(workerPrefix)) {
      count += abortActiveSession(sessionId);
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
  toolDeltaCount: number;
  toolStarts: number;
  toolProgress: number;
  toolEnds: number;
  toolErrors: number;
  firstRawEventMs?: number;
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
  const idx = raw.indexOf('-');
  return idx > 0 ? raw.slice(0, idx) : (raw ? 'unknown' : '');
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
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
    toolDeltaCount: 0,
    toolStarts: 0,
    toolProgress: 0,
    toolEnds: 0,
    toolErrors: 0,
    retryKinds: {},
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

function toolCounter(stats: ModelRunLogDiagnostics, rawName: unknown): ToolRunLogCounter {
  const name = String(rawName || 'unknown').slice(0, 80) || 'unknown';
  if (!stats.toolCounts[name]) {
    stats.toolCounts[name] = { starts: 0, progress: 0, ends: 0, errors: 0 };
  }
  return stats.toolCounts[name];
}

const MAX_TOOL_TIMELINE_LOG_ENTRIES = 80;
const MAX_RUN_TIMELINE_LOG_ENTRIES = 120;

function safeToolNameForLog(rawName: unknown): string {
  return String(rawName || 'unknown').slice(0, 80) || 'unknown';
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
    case 'text_delta': {
      stats.textDeltaEvents += 1;
      stats.textDeltaChars += typeof e.text === 'string' ? e.text.length : 0;
      noteElapsedOnce(stats, 'firstTextDeltaMs', nowMs);
      if (!stats.rawTextTimelineRecorded) {
        stats.rawTextTimelineRecorded = true;
        noteRunTimelineForLog(stats, 'raw_text_delta', nowMs, `chars=${typeof e.text === 'string' ? e.text.length : 0}`);
      }
      break;
    }
    case 'tool_delta': {
      stats.toolDeltaCount += 1;
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
      toolCounter(stats, e.name).starts += 1;
      noteToolTimelineForLog(stats, e, 'start', nowMs);
      noteRunTimelineForLog(stats, 'tool_start', nowMs, `tool=${safeToolNameForLog(e.name)} call=${maskId(e.id)}`);
      noteElapsedOnce(stats, 'firstToolMs', nowMs);
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
      if (e.isError) {
        stats.toolErrors += 1;
        c.errors += 1;
      }
      noteToolTimelineForLog(stats, e, 'end', nowMs);
      noteRunTimelineForLog(
        stats,
        'tool_end',
        nowMs,
        `tool=${safeToolNameForLog(e.name)} call=${maskId(e.id)} error=${e.isError ? 'true' : 'false'}`,
      );
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
    case 'done': {
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
    toolDeltaCount: stats.toolDeltaCount,
    toolStarts: stats.toolStarts,
    toolProgress: stats.toolProgress,
    toolEnds: stats.toolEnds,
    toolErrors: stats.toolErrors,
    toolNames,
    toolCounts: stats.toolCounts,
    toolTimeline: stats.toolTimeline.map(formatToolTimelineEntryForLog),
    toolTimelineTruncated: stats.toolTimelineTruncated,
    firstRawEventMs: stats.firstRawEventMs,
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
    runTimeline: stats.runTimeline.map(formatRunTimelineEntryForLog),
    runTimelineTruncated: stats.runTimelineTruncated,
  };
}

export function modelTurnContextForLog(input: {
  userId?: string;
  sessionId?: string;
  cid?: string;
  agentId?: string;
  projectId?: string;
  workingDir?: string;
  message?: string;
  systemPrompt?: string;
  images?: readonly unknown[];
  attachmentMetadata?: { hasAttachments?: boolean; attachmentTypes?: readonly string[] };
  idleTimeout?: number;
  streamIdleTimeout?: number;
  maxToolLoops?: number;
  skillList?: readonly string[];
  forceOpenSkillRefs?: readonly string[];
  projectAllowedSkillIds?: readonly string[];
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
  toolDefs?: readonly ToolDefSnapshot[];
  buildDurationMs?: number;
}): Record<string, unknown> {
  const toolDefs = input.toolDefs || [];
  const toolSourceCounts = toolDefs.reduce<Record<string, number>>((acc, t) => {
    const source = t?.source || 'unknown';
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
  return {
    user_id: maskId(input.userId),
    session_id: maskId(input.sessionId),
    session_kind: sessionKindForLog(input.sessionId),
    cid: maskId(input.cid),
    agent_id: maskId(input.agentId),
    project_id: maskId(input.projectId),
    provider: input.providerId || undefined,
    model: input.modelId || undefined,
    profile_id: maskId(input.profileId),
    entry_id: maskId(input.entryId),
    message_chars: String(input.message || '').length,
    system_prompt_chars: String(input.systemPrompt || '').length,
    resolved_system_prompt_chars: input.resolvedSystemPrompt ? input.resolvedSystemPrompt.length : undefined,
    image_count: Array.isArray(input.images) ? input.images.length : 0,
    has_attachments: input.attachmentMetadata?.hasAttachments,
    attachment_types: input.attachmentMetadata?.attachmentTypes ? [...input.attachmentMetadata.attachmentTypes].slice(0, 20) : undefined,
    has_working_dir: !!input.workingDir,
    working_dir: input.workingDir ? logPathRef(input.workingDir) : undefined,
    idle_timeout_sec: input.idleTimeout,
    stream_idle_timeout_sec: input.streamIdleTimeout,
    max_tool_loops: input.maxToolLoops,
    skill_list_mode: input.skillList === undefined ? 'all' : 'allowlist',
    skill_list_count: input.skillList === undefined ? undefined : input.skillList.length,
    force_open_skill_count: input.forceOpenSkillRefs?.length,
    project_skill_allowlist_count: input.projectAllowedSkillIds?.length,
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
  const {
    userId, message,
    sessionId = `anon-${genConversationId().slice(0, 8)}`,
    systemPrompt,
    agentName,
    workingDir,
    images,
    attachmentMetadata,
    idleTimeout = 1800,
    streamIdleTimeout = 180,
    maxToolLoops,
    abortSignal = null,
    skillList,
    forceOpenSkillRefs,
    projectAllowedSkillIds,
    extraTools,
    extraRoots,
    readOnlyExtraRoots,
    fileReadOnlyExtraRoots,
    agentId,
    cid,
    turnId,
    projectId,
    onFileWritten,
    hasProducedPath,
    onArtifactCreated,
    onSkillAdvertised,
    onSkillInvoked,
    cacheRetention,
    thinkingLevel,
    nested = false,
    drainSteer,
  } = opts;

  const diagnostics = createModelRunLogDiagnostics();
  let turnLogContext = modelTurnContextForLog({
    userId,
    sessionId,
    cid,
    agentId,
    projectId,
    workingDir,
    message,
    systemPrompt,
    images,
    attachmentMetadata,
    idleTimeout,
    streamIdleTimeout,
    maxToolLoops,
    skillList,
    forceOpenSkillRefs,
    projectAllowedSkillIds,
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

  const lockWaitStartedAt = Date.now();
  log.info('model turn queued', turnLogContext);
  _releaseSession = await sessionLock(sessionId).acquire();
  if (nested) {
    // G8d nested sub-run: do NOT take a global slot — the parent turn already
    // holds one, and acquiring another here would deadlock when the slot pool
    // is exhausted (parent holds a slot, blocks on the child's slot, no slot
    // ever frees). Bounded by the caller's dispatch cap instead. Mark the slot
    // released so every slot-release path (abort / idle / finally) is a no-op.
    slotReleased = true;
  } else {
    const [, slotRelease] = await globalSlots.acquire();
    _slotRelease = slotRelease;
  }
  log.info('model turn locks acquired', {
    ...turnLogContext,
    lock_wait_ms: Date.now() - lockWaitStartedAt,
    global_slot_acquired: !nested,
  });

  // Build an AbortController that fires when:
  //   (a) no event has been produced for idleTimeout seconds, OR
  //   (b) the caller's external abortSignal fires
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
  let externalAbort = false;
  let directSessionAbort = false;
  // Phase-aware idle watchdog. `toolDepth` > 0 means a tool is executing (a
  // long/silent download is normal there — bash heartbeats + core-agent's
  // per-tool watchdog handle that), so we use the long `idleTimeout`.
  // `assemblingToolCallIds` covers the model-side gap after a streamed tool
  // call begins but before core-agent has the complete JSON needed to emit
  // `tool_start`; large `write_file` payloads can legitimately be silent there.
  // Only when we're waiting for the MODEL to stream ordinary tokens with no tool
  // activity — and the stream has already started (`sawFirstEvent`, so a slow
  // first token / cold start still gets the long window) — do we apply the short
  // `streamIdleTimeout`, which catches a provider stream that started then went
  // silent mid-generation. `idleHitWindow` records which window actually fired
  // for the surfaced error text.
  let toolDepth = 0;
  const assemblingToolCallIds = new Set<string>();
  let sawFirstEvent = false;
  let idleHitWindow = idleTimeout;
  const activeAbortEntry: ActiveSessionAbort = {
    abort: () => {
      directSessionAbort = true;
      log.info('direct session abort; releasing locks immediately', { session_id: maskedSessionId });
      controller.abort();
      releaseSlotOnce('session-abort');
      releaseSessionOnce('session-abort');
    },
  };
  addActiveSessionAbort(sessionId, activeAbortEntry);

  const resetIdle = () => {
    if (controller.signal.aborted) return;
    if (idleTimer) clearTimeout(idleTimer);
    const assemblingToolCall = assemblingToolCallIds.size > 0;
    const inToolPhase = toolDepth > 0 || assemblingToolCall;
    const window = !inToolPhase && sawFirstEvent ? streamIdleTimeout : idleTimeout;
    idleTimer = setTimeout(() => {
      idleHit = true;
      idleHitWindow = window;
      log.warn('idle-watchdog fired; aborting and releasing locks', {
        session_id: maskedSessionId,
        idle_seconds: window,
        phase: toolDepth > 0 ? 'tool' : (assemblingToolCall ? 'tool_input' : 'model'),
      });
      controller.abort();
      releaseSlotOnce('idle-watchdog');
      releaseSessionOnce('idle-watchdog');
    }, window * 1000);
  };
  resetIdle();

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
  let finalText = '';
  let errText: string | null = null;
  let abortedFlag = false;

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
      ...(agentName ? { agentName } : {}),
      ...(maxToolLoops ? { maxToolLoops } : {}),
      ...(cid ? { cid } : {}),
      ...(turnId ? { turnId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(skillList !== undefined ? { skillList } : {}),
      ...(forceOpenSkillRefs && forceOpenSkillRefs.length ? { forceOpenSkillRefs } : {}),
      ...(projectAllowedSkillIds !== undefined ? { projectAllowedSkillIds } : {}),
      ...(extraTools && extraTools.length ? { extraTools } : {}),
      ...(extraRoots && extraRoots.length ? { extraRoots } : {}),
      ...(readOnlyExtraRoots && readOnlyExtraRoots.length ? { readOnlyExtraRoots } : {}),
      ...(fileReadOnlyExtraRoots && fileReadOnlyExtraRoots.length ? { fileReadOnlyExtraRoots } : {}),
      ...(onFileWritten ? { onFileWritten } : {}),
      ...(hasProducedPath ? { hasProducedPath } : {}),
      ...(onArtifactCreated ? { onArtifactCreated } : {}),
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
    });
    const { runner, providerId, modelId, resolvedSystemPrompt, profileId, entryId, toolDefs, skillDisplayNameById, agentDisplayNameById } = built;
    turnLogContext = modelTurnContextForLog({
      userId,
      sessionId,
      cid,
      agentId,
      projectId,
      workingDir,
      message,
      systemPrompt,
      images,
      attachmentMetadata,
      idleTimeout,
      streamIdleTimeout,
      maxToolLoops,
      skillList,
      forceOpenSkillRefs,
      projectAllowedSkillIds,
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
      toolDefs,
      buildDurationMs: Date.now() - buildStartedAt,
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
        ...(abortSignal ? { hasAbortSignal: true } : {}),
      },
    });

    const sandboxEnv = buildSkillSandboxEnv(userId);

    log.info('model turn run start', turnLogContext);
    const rawEvents = runner.runStream({
      message,
      signal: controller.signal,
      sandboxEnv,
      ...(workingDir ? { workingDir } : {}),
      ...(images && images.length ? { images } : {}),
      ...(attachmentMetadata ? { requestMetadata: { attachmentMetadata } } : {}),
      ...(cacheRetention ? { cacheRetention } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(drainSteer ? { drainSteer } : {}),
    });

    // Wrap raw events to capture the AgentRunResult for post-run reflection.
    let agentRunResult: import('#core-agent').AgentRunResult | null = null;
    async function* captureResult(events: AsyncIterable<import('#core-agent').AgentRunEvent>) {
      for await (const ev of events) {
        recordModelRawEventForLog(diagnostics, ev);
        if (ev.type === 'done') agentRunResult = ev.result;
        // Track tool-execution phase from the RAW events (stable discriminants)
        // so the idle watchdog uses the long window while a tool is in flight.
        // tool_start fires before the tool body awaits and tool_end after, so
        // toolDepth > 0 spans the whole (possibly silent) tool execution.
        else if (ev.type === 'tool_delta') {
          assemblingToolCallIds.add(ev.id || 'stream_tool');
        } else if (ev.type === 'tool_start') {
          assemblingToolCallIds.clear();
          toolDepth += 1;
        } else if (ev.type === 'tool_end') {
          assemblingToolCallIds.delete(ev.id || 'stream_tool');
          toolDepth = Math.max(0, toolDepth - 1);
        }
        // Some raw events intentionally do not map to visible UI events
        // (e.g. an empty tool-input delta before a large write_file argument).
        // They are still provider activity and must refresh the watchdog.
        sawFirstEvent = true;
        resetIdle();
        yield ev;
      }
    }

    // The event mapper yields Orkas-shape events and handles the
    // terminal final/error synthesis. We re-yield every event it produces,
    // resetting the idle timer on each one.
    let eventCount = 0;
    const mappedEvents = mapCoreAgentEvents(captureResult(rawEvents), { userId, skillDisplayNameById, agentDisplayNameById });
    for await (const ev of stopStreamOnAbort(mappedEvents, controller.signal, turnTag)) {
      // Mark BEFORE resetIdle so the short model-stream window applies once the
      // stream has started (a slow first token still gets the long cold-start
      // window — see resetIdle).
      sawFirstEvent = true;
      resetIdle();
      eventCount += 1;
      recordModelStreamEventForLog(diagnostics, ev);
      recorder.record(ev as any);
      if (ev.type === 'final') finalText = (ev as any).text || finalText;
      if (ev.type === 'error') { errText = (ev as any).text || errText; if ((ev as any).aborted) abortedFlag = true; }
      // NOTE: compaction summaries are deliberately NOT mined into cross-session
      // memory. That hook persisted transient task progress (the summary is
      // work-in-progress, not durable user facts) into MEMORY.md. Memory is now
      // written only by the explicit `cross_session_memory` tool.
      yield ev;
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
    void agentRunResult;

    if (externalAbort || directSessionAbort) {
      // mapCoreAgentEvents may have already yielded 'error: empty response'
      // for the short-circuit; tag the stream as aborted for the client.
      abortedFlag = true;
      const abortEvent: StreamEvent = { type: 'error', text: 'aborted', aborted: true };
      recordModelStreamEventForLog(diagnostics, abortEvent);
      recorder.record(abortEvent as any);
      yield abortEvent;
    } else if (idleHit) {
      errText = errText || `Model exceeded ${idleHitWindow}s with no response (aborted)`;
      const idleEvent: StreamEvent = { type: 'error', text: errText };
      recordModelStreamEventForLog(diagnostics, idleEvent);
      recorder.record(idleEvent as any);
      yield idleEvent;
    }
  } catch (err) {
    if (idleHit) {
      errText = `Model exceeded ${idleHitWindow}s with no response (aborted)`;
      log.warn('model turn idle timeout surfaced after stream error', { ...turnLogContext, error: logErrorSummary(err) });
      const idleEvent: StreamEvent = { type: 'error', text: errText };
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
      log.error('model turn stream error', { ...turnLogContext, error: logErrorSummary(err) });
      const errorEvent: StreamEvent = { type: 'error', text: errText };
      recordModelStreamEventForLog(diagnostics, errorEvent);
      recorder.record(errorEvent as any);
      yield errorEvent;
    }
  } finally {
    removeActiveSessionAbort(sessionId, activeAbortEntry);
    if (idleTimer) clearTimeout(idleTimer);
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
      const cached = await _getCachedSession(sessionId);
      if (cached && typeof (cached as { healAndPersist?: () => boolean }).healAndPersist === 'function') {
        if (cached.healAndPersist()) {
          log.warn('healed orphan tool_use after turn', { session_id: maskedSessionId });
        }
      }
    } catch (err) {
      log.warn('post-turn heal failed', { ...turnLogContext, error: logErrorRef(err) });
    }
    releaseSlotOnce('finally');
    releaseSessionOnce('finally');
    const doneEvent: StreamEvent = { type: 'done' };
    recordModelStreamEventForLog(diagnostics, doneEvent);
    const terminalStatus = abortedFlag
      ? 'aborted'
      : (errText ? (idleHit ? 'idle_timeout' : 'error') : (finalText ? 'completed' : 'empty'));
    log.info('model turn finish', {
      ...turnLogContext,
      status: terminalStatus,
      aborted: abortedFlag,
      idle_hit: idleHit,
      idle_window_sec: idleHit ? idleHitWindow : undefined,
      final_chars: finalText.length,
      has_error: !!errText,
      error: errText ? logErrorRef(new Error(errText)) : undefined,
      diagnostics: summarizeModelRunForLog(diagnostics),
    });
    try { recorder.finish({ text: finalText, aborted: abortedFlag, error: errText }); }
    catch (err) { log.warn('debug recorder finish failed', { error: logErrorRef(err) }); }
    yield doneEvent;
  }
}

/** Blocking chat — drains the stream and picks up the final/error event. */
export async function chatWithModel(opts: ChatOptions): Promise<ChatResult> {
  let finalText: string | null = null;
  let errText: string | null = null;
  let aborted = false;
  for await (const ev of streamChatWithModel(opts)) {
    if (ev.type === 'final') finalText = ev.text || '';
    else if (ev.type === 'error' && !errText) errText = ev.text || '';
    if (ev.aborted) aborted = true;
  }
  if (finalText) return { ok: true, text: finalText, error: '', aborted: false };
  return { ok: false, text: '', error: errText || 'unknown error', aborted };
}
