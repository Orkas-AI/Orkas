/**
 * Run a local CLI agent for one dispatch.
 *
 * Invariants:
 *   - Single spawn entry point for the whole project. `bus.ts` must
 *     route here; `features/*` must not call `child_process.spawn`
 *     directly for CLI agents.
 *   - Pre-flight `detectOne` re-probes the binary even if the cached
 *     entry says available — the user might have uninstalled it
 *     mid-conversation. A miss yields `done({status: 'missing_cli'})`
 *     before any persistence happens.
 *   - Persistence wraps every backend event so `events.jsonl` is the
 *     authoritative replay log. Output text is also appended to
 *     output.txt as it streams; the final body lands in meta.json.
 *   - The runner never throws on the happy path; failures are reported
 *     through the same `onEvent({type:'done', status:'failed', ...})`
 *     channel so the caller has a single completion contract.
 */

import { createLogger } from '../../logger.js';
import { logErrorRef, logErrorSummary, logPathRef, maskId } from '../../util/log-redact.js';
import { detectOne, type LocalCliEntry, type LocalCliType } from './registry.js';
import { claudeBackend } from './backends/claude.js';
import { codexBackend } from './backends/codex.js';
import { openclawBackend } from './backends/openclaw.js';
import { opencodeBackend } from './backends/opencode.js';
import { hermesBackend } from './backends/hermes.js';
import { type LocalBackend, type LocalEvent } from './backends/base.js';
import * as persist from './persist.js';
import { sessionToolResultsDir } from '../../paths.js';
import { maybeSpillToolResult } from '../../util/tool-result-cap.js';

const log = createLogger('local-agents:runner');

/** Hard wall-clock cap for a single CLI dispatch — zombie insurance
 *  only. The hang detector is the idle-kill below, so this can be
 *  generous: healthy coding dispatches routinely pass 20 minutes
 *  (builds, model downloads, renders). The old 20-min value doubled as
 *  the hang detector and killed an actively-working 20-min claude turn
 *  (run 1dffe7c48d18). Override via ORKAS_LOCAL_AGENT_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Backends with no mid-run event stream can't be idle-killed (silence
 *  is normal for them), so they keep a long-but-bounded wall-clock cap
 *  as their only hang bound. */
const BACKEND_TIMEOUT_MS: Partial<Record<LocalCliType, number>> = {
  openclaw: 60 * 60 * 1000,
};

function resolveTimeoutMs(cli: LocalCliType): number {
  const fallback = BACKEND_TIMEOUT_MS[cli] ?? DEFAULT_TIMEOUT_MS;
  const raw = process.env.ORKAS_LOCAL_AGENT_TIMEOUT_MS;
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1000) return fallback;
  return n;
}

/** Kill the CLI when it emits NO events for this long. This is the
 *  actual hang detector (vs the wall cap above). Long quiet stretches
 *  are real — a single Bash tool call sat silent ~10 min downloading a
 *  whisper model — so the default stays comfortably above them.
 *  Override via ORKAS_LOCAL_AGENT_IDLE_KILL_MS; 0 disables. */
const DEFAULT_IDLE_KILL_MS = 30 * 60 * 1000;

/** Idle-kill is meaningless for backends that emit nothing mid-run
 *  (their silence carries no hang signal) — disable it there and rely
 *  on the per-backend wall cap instead. */
const BACKEND_IDLE_KILL_DISABLED: Partial<Record<LocalCliType, boolean>> = {
  openclaw: true,
};

function resolveIdleKillMs(cli: LocalCliType): number | undefined {
  if (BACKEND_IDLE_KILL_DISABLED[cli]) return undefined;
  const raw = process.env.ORKAS_LOCAL_AGENT_IDLE_KILL_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      if (n <= 0) return undefined;          // explicit disable
      if (n >= 60_000) return n;             // floor guards against drumming kills
    }
  }
  return DEFAULT_IDLE_KILL_MS;
}

/** How long the runner waits without seeing ANY backend event before
 *  emitting an `idle` heartbeat. The ticker below fires every
 *  `IDLE_TICK_MS`; the first emit happens once
 *  `now - lastEventAt > threshold`. Default 90 s because a thinking
 *  turn between tool calls runs ~10-40 s — 90 s comfortably skips real
 *  activity and catches genuine stalls. */
const DEFAULT_IDLE_MS = 90 * 1000;
const DEFAULT_IDLE_TICK_MS = 30 * 1000;
/** Lower bound on user-supplied / backend-supplied idle thresholds so a
 *  misconfigured value can't drum the rail every second. Tests can
 *  shrink this through `ORKAS_LOCAL_AGENT_IDLE_MIN_MS` to exercise the
 *  heartbeat at a manageable speed; production never sets it. */
const MIN_IDLE_MS_DEFAULT = 30 * 1000;

function envNum(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function resolveIdleMs(backendHint: number | undefined): number {
  const minMs = envNum('ORKAS_LOCAL_AGENT_IDLE_MIN_MS') ?? MIN_IDLE_MS_DEFAULT;
  const candidates: Array<number | undefined> = [
    backendHint,
    envNum('ORKAS_LOCAL_AGENT_IDLE_MS'),
  ];
  for (const c of candidates) {
    if (c !== undefined && c >= minMs) return c;
  }
  return Math.max(DEFAULT_IDLE_MS, minMs);
}

function resolveIdleTickMs(idleMs: number): number {
  // Tick at most every 30 s; for very short thresholds (tests, or a
  // future short-idleMs backend) divide so the user sees ~3 pulses
  // before the threshold is reached.
  return Math.min(DEFAULT_IDLE_TICK_MS, Math.max(50, Math.floor(idleMs / 3)));
}

/** Default idle threshold per backend. Override only when the backend
 *  semantics deviate from "streams events through the turn"; openclaw
 *  emits no mid-run stream, so use the normal 90s/30s heartbeat cadence
 *  instead of the older 30s/10s cadence that was too noisy for long runs. */
const BACKEND_IDLE_MS: Partial<Record<LocalCliType, number>> = {
  openclaw: DEFAULT_IDLE_MS,
};

const BACKENDS: Partial<Record<LocalCliType, LocalBackend>> = {
  claude: claudeBackend,
  codex: codexBackend,
  openclaw: openclawBackend,
  opencode: opencodeBackend,
  hermes: hermesBackend,
};

/** CLIs with a supported MCP-config injection path (claude:
 *  `--mcp-config`; codex: `-c mcp_servers.…`). Others run without the
 *  bridge until an injection mechanism exists for them. */
function _bridgeSupported(cli: LocalCliType): boolean {
  return cli === 'claude' || cli === 'codex';
}

/** Appended to the CLI agent's system prompt when the bridge is live.
 *  Runtime-generated (not a tracked prompt md); keep it to capability
 *  discovery — the tool descriptions carry the details. */
const BRIDGE_SYSTEM_PROMPT =
  'You are running inside Orkas, the user\'s agent workspace. An MCP server named "orkas" is '
  + 'connected: it lists and reads the user\'s Orkas skills (orkas_list_skills / orkas_read_skill / '
  + 'orkas_run_skill), reaches their connected services (orkas_list_connector_tools / '
  + 'orkas_call_connector_tool — calls may wait for the user to approve a permission prompt in '
  + 'Orkas), and browses/searches their knowledge base (orkas_kb_list / orkas_kb_search / '
  + 'orkas_kb_read). Prefer these '
  + 'tools when the task involves the user\'s skills, services, or library content.';

type LocalToolRunCounter = {
  use: number;
  result: number;
  other: number;
};

type LocalToolTimelineLogEntry = {
  seq: number;
  elapsedMs: number;
  tool: string;
  phase: 'use' | 'result' | 'other';
  call_id?: string;
  is_error?: boolean;
  output_chars?: number;
  spilled?: boolean;
};

type LocalEventTimelineLogEntry = {
  seq: number;
  elapsedMs: number;
  event: string;
  detail?: string;
};

export interface LocalAgentRunLogDiagnostics {
  startedAtMs: number;
  eventCount: number;
  eventTypes: Record<string, number>;
  textDeltaChars: number;
  thinkingChars: number;
  stderrLines: number;
  stderrChars: number;
  rawLines: number;
  rawChars: number;
  idleEvents: number;
  maxIdleStalledMs: number;
  permissionRequests: number;
  permissionAutoAllow: number;
  permissionAutoDeny: number;
  fileChangeEvents: number;
  fileChangePathCount: number;
  logLevels: Record<string, number>;
  toolEvents: number;
  toolResultEvents: number;
  spilledToolResults: number;
  toolCounts: Record<string, LocalToolRunCounter>;
  firstEventMs?: number;
  firstTextDeltaMs?: number;
  firstToolMs?: number;
  doneEventMs?: number;
  terminalStatus?: string;
  terminalError: boolean;
  usage?: Record<string, number>;
  toolTimeline: LocalToolTimelineLogEntry[];
  toolTimelineTruncated: number;
  eventTimeline: LocalEventTimelineLogEntry[];
  eventTimelineTruncated: number;
  textDeltaTimelineRecorded: boolean;
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function safeUsageForLog(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const allowed = new Set([
    'input', 'output', 'total',
    'inputTokens', 'outputTokens', 'totalTokens',
    'cacheRead', 'cacheCreate', 'cacheWrite',
    'cacheReadTokens', 'cacheWriteTokens',
    'costUsd', 'totalCostUsd',
  ]);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    const n = finiteNumber(raw);
    if (n !== undefined) out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

export function createLocalAgentRunLogDiagnostics(nowMs = Date.now()): LocalAgentRunLogDiagnostics {
  return {
    startedAtMs: nowMs,
    eventCount: 0,
    eventTypes: {},
    textDeltaChars: 0,
    thinkingChars: 0,
    stderrLines: 0,
    stderrChars: 0,
    rawLines: 0,
    rawChars: 0,
    idleEvents: 0,
    maxIdleStalledMs: 0,
    permissionRequests: 0,
    permissionAutoAllow: 0,
    permissionAutoDeny: 0,
    fileChangeEvents: 0,
    fileChangePathCount: 0,
    logLevels: {},
    toolEvents: 0,
    toolResultEvents: 0,
    spilledToolResults: 0,
    toolCounts: {},
    terminalError: false,
    toolTimeline: [],
    toolTimelineTruncated: 0,
    eventTimeline: [],
    eventTimelineTruncated: 0,
    textDeltaTimelineRecorded: false,
  };
}

function noteElapsedOnce(target: LocalAgentRunLogDiagnostics, key: keyof LocalAgentRunLogDiagnostics, nowMs: number): void {
  if (target[key] !== undefined) return;
  (target as unknown as Record<string, unknown>)[key as string] = Math.max(0, nowMs - target.startedAtMs);
}

function localToolCounter(stats: LocalAgentRunLogDiagnostics, rawName: unknown): LocalToolRunCounter {
  const name = String(rawName || 'unknown').slice(0, 80) || 'unknown';
  if (!stats.toolCounts[name]) stats.toolCounts[name] = { use: 0, result: 0, other: 0 };
  return stats.toolCounts[name];
}

const MAX_TOOL_TIMELINE_LOG_ENTRIES = 80;
const MAX_EVENT_TIMELINE_LOG_ENTRIES = 120;

function safeToolNameForLog(rawName: unknown): string {
  return String(rawName || 'unknown').slice(0, 80) || 'unknown';
}

function safeLocalToolPhaseForLog(rawPhase: unknown): LocalToolTimelineLogEntry['phase'] {
  const phase = String(rawPhase || '');
  if (phase === 'use' || phase === 'result') return phase;
  return 'other';
}

function noteLocalToolTimelineForLog(stats: LocalAgentRunLogDiagnostics, e: LocalEvent, nowMs: number): void {
  if (stats.toolTimeline.length >= MAX_TOOL_TIMELINE_LOG_ENTRIES) {
    stats.toolTimelineTruncated += 1;
    return;
  }
  const phase = safeLocalToolPhaseForLog(e.phase);
  const entry: LocalToolTimelineLogEntry = {
    seq: stats.toolTimeline.length + stats.toolTimelineTruncated + 1,
    elapsedMs: Math.max(0, nowMs - stats.startedAtMs),
    tool: safeToolNameForLog(e.tool),
    phase,
  };
  const callId = e.callId;
  if (callId !== undefined && callId !== null && String(callId)) entry.call_id = maskId(callId);
  const isError = !!e.isError || !!e.error;
  if (isError) entry.is_error = true;
  if (phase === 'result') {
    if (typeof e.output === 'string') entry.output_chars = e.output.length;
    entry.spilled = !!e.outputPath;
  }
  stats.toolTimeline.push(entry);
}

function noteLocalEventTimelineForLog(
  stats: LocalAgentRunLogDiagnostics,
  event: string,
  nowMs: number,
  detail?: string,
): void {
  if (stats.eventTimeline.length >= MAX_EVENT_TIMELINE_LOG_ENTRIES) {
    stats.eventTimelineTruncated += 1;
    return;
  }
  stats.eventTimeline.push({
    seq: stats.eventTimeline.length + stats.eventTimelineTruncated + 1,
    elapsedMs: Math.max(0, nowMs - stats.startedAtMs),
    event,
    ...(detail ? { detail } : {}),
  });
}

function formatLocalEventTimelineEntryForLog(entry: LocalEventTimelineLogEntry): string {
  return [
    `#${entry.seq}`,
    `+${entry.elapsedMs}ms`,
    entry.event,
    entry.detail,
  ].filter(Boolean).join(' ');
}

function formatLocalToolTimelineEntryForLog(entry: LocalToolTimelineLogEntry): string {
  const parts = [
    `#${entry.seq}`,
    `+${entry.elapsedMs}ms`,
    entry.tool,
    entry.phase,
  ];
  if (entry.call_id) parts.push(`call=${entry.call_id}`);
  if (entry.is_error !== undefined) parts.push(`error=${entry.is_error ? 'true' : 'false'}`);
  if (entry.output_chars !== undefined) parts.push(`output_chars=${entry.output_chars}`);
  if (entry.spilled !== undefined) parts.push(`spilled=${entry.spilled ? 'true' : 'false'}`);
  return parts.join(' ');
}

export function recordLocalAgentEventForLog(stats: LocalAgentRunLogDiagnostics, e: LocalEvent, nowMs = Date.now()): void {
  if (!stats || !e) return;
  stats.eventCount += 1;
  stats.eventTypes[e.type] = (stats.eventTypes[e.type] || 0) + 1;
  noteElapsedOnce(stats, 'firstEventMs', nowMs);

  switch (e.type) {
    case 'process-info':
      noteLocalEventTimelineForLog(stats, 'process_info', nowMs, `pid=${finiteNumber(e.pid) ?? 'unknown'}`);
      break;
    case 'text-delta':
      stats.textDeltaChars += typeof e.text === 'string' ? e.text.length : 0;
      noteElapsedOnce(stats, 'firstTextDeltaMs', nowMs);
      if (!stats.textDeltaTimelineRecorded) {
        stats.textDeltaTimelineRecorded = true;
        noteLocalEventTimelineForLog(stats, 'text_delta', nowMs, `chars=${typeof e.text === 'string' ? e.text.length : 0}`);
      }
      break;
    case 'thinking':
      stats.thinkingChars += typeof e.text === 'string' ? e.text.length : 0;
      noteLocalEventTimelineForLog(stats, 'thinking', nowMs, `chars=${typeof e.text === 'string' ? e.text.length : 0}`);
      break;
    case 'stderr-line':
      stats.stderrLines += 1;
      stats.stderrChars += typeof e.line === 'string' ? e.line.length : 0;
      if (stats.stderrLines === 1) noteLocalEventTimelineForLog(stats, 'stderr_line', nowMs, `chars=${typeof e.line === 'string' ? e.line.length : 0}`);
      break;
    case 'raw-line':
      stats.rawLines += 1;
      stats.rawChars += typeof e.line === 'string' ? e.line.length : 0;
      if (stats.rawLines === 1) noteLocalEventTimelineForLog(stats, 'raw_line', nowMs, `chars=${typeof e.line === 'string' ? e.line.length : 0}`);
      break;
    case 'idle': {
      stats.idleEvents += 1;
      const stalledMs = finiteNumber(e.stalledMs) || 0;
      stats.maxIdleStalledMs = Math.max(stats.maxIdleStalledMs, stalledMs);
      noteLocalEventTimelineForLog(stats, 'idle', nowMs, `stalled_ms=${stalledMs}`);
      break;
    }
    case 'permission-request':
      stats.permissionRequests += 1;
      if (e.autoDecided === 'allow') stats.permissionAutoAllow += 1;
      if (e.autoDecided === 'deny') stats.permissionAutoDeny += 1;
      noteLocalEventTimelineForLog(
        stats,
        'permission_request',
        nowMs,
        `tool=${safeToolNameForLog(e.tool)} auto=${String(e.autoDecided || 'manual')}`,
      );
      break;
    case 'file-change':
      stats.fileChangeEvents += 1;
      stats.fileChangePathCount += Array.isArray(e.paths) ? e.paths.length : 0;
      noteLocalEventTimelineForLog(stats, 'file_change', nowMs, `paths=${Array.isArray(e.paths) ? e.paths.length : 0}`);
      break;
    case 'log': {
      const level = String(e.level || 'info').toLowerCase();
      stats.logLevels[level] = (stats.logLevels[level] || 0) + 1;
      noteLocalEventTimelineForLog(stats, 'log', nowMs, `level=${level}`);
      break;
    }
    case 'tool-event': {
      stats.toolEvents += 1;
      const counter = localToolCounter(stats, e.tool);
      const phase = String(e.phase || '');
      if (phase === 'use') counter.use += 1;
      else if (phase === 'result') {
        counter.result += 1;
        stats.toolResultEvents += 1;
        if (e.outputPath) stats.spilledToolResults += 1;
      } else {
        counter.other += 1;
      }
      noteLocalToolTimelineForLog(stats, e, nowMs);
      noteLocalEventTimelineForLog(stats, 'tool_event', nowMs, `tool=${safeToolNameForLog(e.tool)} phase=${safeLocalToolPhaseForLog(e.phase)}`);
      noteElapsedOnce(stats, 'firstToolMs', nowMs);
      break;
    }
    case 'status':
      stats.usage = safeUsageForLog(e.usage) || stats.usage;
      noteLocalEventTimelineForLog(stats, 'status', nowMs, `status=${String(e.status || '')}`);
      break;
    case 'done':
      noteElapsedOnce(stats, 'doneEventMs', nowMs);
      stats.terminalStatus = typeof e.status === 'string' ? e.status : stats.terminalStatus;
      stats.terminalError = !!e.error;
      stats.usage = safeUsageForLog(e.usage) || stats.usage;
      noteLocalEventTimelineForLog(stats, 'done', nowMs, `status=${String(e.status || '')} error=${e.error ? 'true' : 'false'}`);
      break;
    default:
      break;
  }
}

export function summarizeLocalAgentRunForLog(stats: LocalAgentRunLogDiagnostics, nowMs = Date.now()): Record<string, unknown> {
  return {
    durationMs: Math.max(0, nowMs - stats.startedAtMs),
    eventCount: stats.eventCount,
    eventTypes: stats.eventTypes,
    textDeltaChars: stats.textDeltaChars,
    thinkingChars: stats.thinkingChars,
    stderrLines: stats.stderrLines,
    stderrChars: stats.stderrChars,
    rawLines: stats.rawLines,
    rawChars: stats.rawChars,
    idleEvents: stats.idleEvents,
    maxIdleStalledMs: stats.maxIdleStalledMs,
    permissionRequests: stats.permissionRequests,
    permissionAutoAllow: stats.permissionAutoAllow,
    permissionAutoDeny: stats.permissionAutoDeny,
    fileChangeEvents: stats.fileChangeEvents,
    fileChangePathCount: stats.fileChangePathCount,
    logLevels: stats.logLevels,
    toolEvents: stats.toolEvents,
    toolResultEvents: stats.toolResultEvents,
    spilledToolResults: stats.spilledToolResults,
    toolNames: Object.keys(stats.toolCounts).sort(),
    toolCounts: stats.toolCounts,
    toolTimeline: stats.toolTimeline.map(formatLocalToolTimelineEntryForLog),
    toolTimelineTruncated: stats.toolTimelineTruncated,
    eventTimeline: stats.eventTimeline.map(formatLocalEventTimelineEntryForLog),
    eventTimelineTruncated: stats.eventTimelineTruncated,
    firstEventMs: stats.firstEventMs,
    firstTextDeltaMs: stats.firstTextDeltaMs,
    firstToolMs: stats.firstToolMs,
    doneEventMs: stats.doneEventMs,
    terminalStatus: stats.terminalStatus,
    terminalError: stats.terminalError,
    usage: stats.usage,
  };
}

export function localAgentRunContextForLog(opts: {
  uid?: string;
  cid?: string;
  agentId?: string;
  projectId?: string;
  cli?: LocalCliType;
  model?: string;
  customArgs?: readonly string[];
  resumeSessionId?: string;
  prompt?: string;
  cwd?: string;
  runId?: string;
  cliAvailable?: boolean;
  cliVersion?: string | null;
  bridgeSupported?: boolean;
  timeoutMs?: number;
  idleKillMs?: number;
  idleMs?: number;
}): Record<string, unknown> {
  return {
    run_id: maskId(opts.runId),
    user_id: maskId(opts.uid),
    cid: maskId(opts.cid),
    agent_id: maskId(opts.agentId),
    project_id: maskId(opts.projectId),
    cli: opts.cli,
    model: opts.model || undefined,
    cli_available: opts.cliAvailable,
    cli_version: opts.cliVersion || undefined,
    bridge_supported: opts.bridgeSupported,
    custom_arg_count: opts.customArgs?.length || 0,
    has_resume_session: !!opts.resumeSessionId,
    prompt_chars: String(opts.prompt || '').length,
    has_cwd: !!opts.cwd,
    cwd: opts.cwd ? logPathRef(opts.cwd) : undefined,
    timeout_ms: opts.timeoutMs,
    idle_kill_ms: opts.idleKillMs,
    idle_ms: opts.idleMs,
  };
}

export interface RunCliAgentOpts {
  uid: string;
  cid: string;
  agentId: string;
  /** Display name for permission dialogs; falls back to agentId. */
  agentName?: string;
  /** Conversation project scope, when the CLI turn belongs to a project. */
  projectId?: string;
  cli: LocalCliType;
  model?: string;
  customArgs?: string[];
  /** If set, the dispatch resumes a CLI-side session (claude
   *  `--resume <id>`) and the caller has already trimmed the prompt
   *  to "just the new turn" content — the CLI provides the prior
   *  context out of its own memory. The backend ignores the field
   *  when it doesn't support resume. */
  resumeSessionId?: string;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  /** Forwarded each backend event verbatim, after persistence. */
  onEvent: (e: LocalEvent) => void;
}

export interface RunCliAgentResult {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'missing_cli';
  output?: string;
  error?: string;
  cliError?: LocalCliEntry['error'];
  cliPath?: string;
  cliVersion?: string;
}

export async function run(opts: RunCliAgentOpts): Promise<RunCliAgentResult> {
  const backend = BACKENDS[opts.cli];
  let runLogContext = localAgentRunContextForLog({
    uid: opts.uid,
    cid: opts.cid,
    agentId: opts.agentId,
    projectId: opts.projectId,
    cli: opts.cli,
    model: opts.model,
    customArgs: opts.customArgs,
    resumeSessionId: opts.resumeSessionId,
    prompt: opts.prompt,
    cwd: opts.cwd,
    bridgeSupported: _bridgeSupported(opts.cli),
  });
  if (!backend) {
    log.warn('local agent backend missing', runLogContext);
    const err = `local CLI backend not implemented: ${opts.cli}`;
    opts.onEvent({ type: 'done', status: 'failed', error: err });
    return { runId: '', status: 'failed', error: err };
  }

  // Pre-flight probe (cache-busting). A user might have uninstalled
  // the CLI between create-time detection and now.
  const entry = await detectOne(opts.cli);
  if (!entry.available || !entry.path) {
    return _missing(opts, entry);
  }

  const timeoutMs = resolveTimeoutMs(opts.cli);
  const idleKillMs = resolveIdleKillMs(opts.cli);
  const idleThresholdMs = resolveIdleMs(BACKEND_IDLE_MS[opts.cli]);

  const handle = await persist.start(opts.uid, {
    agentId: opts.agentId,
    cid: opts.cid,
    cli: opts.cli,
    model: opts.model,
    cliPath: entry.path,
    prompt: opts.prompt,
  });
  const startedAtMs = Date.now();
  const runDiagnostics = createLocalAgentRunLogDiagnostics(startedAtMs);
  const startedAtIso = new Date(startedAtMs).toISOString();
  runLogContext = localAgentRunContextForLog({
    uid: opts.uid,
    cid: opts.cid,
    agentId: opts.agentId,
    projectId: opts.projectId,
    cli: opts.cli,
    model: opts.model,
    customArgs: opts.customArgs,
    resumeSessionId: opts.resumeSessionId,
    prompt: opts.prompt,
    cwd: opts.cwd,
    runId: handle.runId,
    cliAvailable: entry.available,
    cliVersion: entry.version,
    bridgeSupported: _bridgeSupported(opts.cli),
    timeoutMs,
    idleKillMs,
    idleMs: idleThresholdMs,
  });
  log.info('local agent run start', runLogContext);

  // Wrapper writes events to disk before forwarding upstream so that
  // a renderer crash mid-run still leaves a complete jsonl trail.
  let streamedOutput = '';
  let terminal: { status: RunCliAgentResult['status']; output?: string; error?: string; sessionId?: string } | null = null;
  // CLI dispatch session id. The per-session spill dir is anchored on
  // this so sweep / read paths can find the file again.
  const cliSessionId = `cli-${opts.cli}-${handle.runId}`;
  const spillDir = sessionToolResultsDir(opts.uid, cliSessionId);
  let lastEventAt = Date.now();
  const onEvent = (e: LocalEvent) => {
    // Self-emitted idle pulses don't count as "the CLI did something"
    // — without this carve-out we'd reset our own deadline and stop
    // pulsing during a real stall.
    if (e.type !== 'idle') lastEventAt = Date.now();
    // Tool-event result phase: spill oversized output to disk before
    // it lands in events.jsonl / the renderer stream. Above the estimated
    // inline-token budget the raw output bloats the persistence log and the
    // renderer memory; the spill keeps a bounded preview inline (matching
    // the in-process tool-result spill format) and exposes the full
    // path via `outputPath` for click-to-expand. Backends don't know
    // about this — they always emit the full output.
    if (e.type === 'tool-event' && (e as any).phase === 'result' && typeof (e as any).output === 'string') {
      const { output, outputPath } = maybeSpillToolResult({
        toolResultsDir: spillDir,
        toolName: String((e as any).tool || 'tool'),
        callId: String((e as any).callId || ''),
        output: (e as any).output as string,
      });
      // Rewrite in place so the persisted event and the forwarded
      // event match exactly — no divergence between disk replay and
      // live render.
      (e as any).output = output;
      if (outputPath) (e as any).outputPath = outputPath;
    }
    recordLocalAgentEventForLog(runDiagnostics, e);
    persist.append(handle, e);
    if (e.type === 'text-delta' && typeof e.text === 'string') {
      streamedOutput += e.text;
      persist.appendOutput(handle, e.text);
    }
    if (e.type === 'done') {
      terminal = {
        status: (e.status as RunCliAgentResult['status']) || 'failed',
        output: typeof e.output === 'string' ? e.output : undefined,
        error: typeof e.error === 'string' ? e.error : undefined,
        sessionId: typeof e.sessionId === 'string' ? e.sessionId : undefined,
      };
    }
    opts.onEvent(e);
  };

  // Idle ticker — purely informational; never kills the process itself.
  // Killing is the backend watchdog's job (idle-kill at `idleKillMs` +
  // wall cap, see resolveIdleKillMs/resolveTimeoutMs above); this
  // threshold sits far below the kill window so the user sees a steady
  // drumbeat ("○ no output for 30s" repeated) well before any kill,
  // rather than a single heartbeat that ages out.
  const idleTickMs = resolveIdleTickMs(idleThresholdMs);
  const idleTimer = setInterval(() => {
    if (terminal) return;  // run already finished, don't keep pulsing
    const stalledMs = Date.now() - lastEventAt;
    if (stalledMs > idleThresholdMs) {
      onEvent({ type: 'idle', stalledMs });
    }
  }, idleTickMs);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();

  // orkas-bridge (plan §D): per-run host exposing the user's Orkas
  // skills / connectors / KB to the CLI agent over a local socket. Bridge
  // failures never fail the dispatch — the CLI just runs without the
  // `orkas` MCP server, same as before the bridge existed.
  let bridge: import('./bridge').BridgeHandle | null = null;
  if (_bridgeSupported(opts.cli) && process.env.ORKAS_BRIDGE_DISABLED !== '1') {
    try {
      const [{ startBridge }, { buildSkillSandboxEnv }] = await Promise.all([
        import('./bridge.js'),
        import('../../model/core-agent/client.js'),
      ]);
      bridge = await startBridge({
        uid: opts.uid,
        cid: opts.cid,
        agentId: opts.agentId,
        agentName: opts.agentName || opts.agentId,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        runId: handle.runId,
        configDir: handle.dir,
        sandboxEnv: buildSkillSandboxEnv(opts.uid, opts.agentId),
      });
      log.info('local agent bridge ready', runLogContext);
    } catch (err) {
      log.warn('bridge start failed — running without orkas MCP server', {
        ...runLogContext,
        error: logErrorRef(err),
      });
    }
  }

  try {
    await backend.run({
      binPath: entry.path,
      prompt: opts.prompt,
      cwd: opts.cwd,
      model: opts.model,
      customArgs: opts.customArgs,
      resumeSessionId: opts.resumeSessionId,
      signal: opts.signal,
      onEvent,
      timeoutMs,
      idleKillMs,
      // Activity clock for the backend's idle-kill watchdog. Reads the
      // same `lastEventAt` the idle heartbeat uses (self-emitted idle
      // pulses excluded), so heartbeat rows always precede a kill.
      lastEventAt: () => lastEventAt,
      idleMs: BACKEND_IDLE_MS[opts.cli],
      ...(bridge ? {
        bridge: {
          mcpConfigPath: bridge.mcpConfigPath,
          server: {
            command: bridge.serverEnv.ORKAS_NODE || process.execPath,
            args: [`${bridge.serverEnv.ORKAS_PC_DIR}/bin/orkas-bridge.cjs`],
            env: bridge.serverEnv,
          },
          appendSystemPrompt: BRIDGE_SYSTEM_PROMPT,
        },
      } : {}),
    });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.error('local agent backend threw', { ...runLogContext, error: logErrorSummary(err) });
    if (!terminal) {
      onEvent({ type: 'done', status: 'failed', error: msg });
    }
  } finally {
    if (bridge) {
      try { await bridge.close(); }
      catch (err) { log.warn('bridge close failed', { ...runLogContext, error: logErrorRef(err) }); }
    }
  }

  clearInterval(idleTimer);

  // Backends are required to emit a `done` — if missing, treat as
  // failure so callers don't hang on an absent terminal event.
  if (!terminal) {
    onEvent({ type: 'done', status: 'failed', error: 'backend exited without terminal event' });
    terminal = { status: 'failed', error: 'backend exited without terminal event' };
  }

  const finalOutput = terminal.output ?? streamedOutput;
  const endedAtMs = Date.now();
  await persist.finalize(handle, {
    status: terminal.status,
    output: finalOutput,
    error: terminal.error,
    sessionId: terminal.sessionId,
    durationMs: endedAtMs - startedAtMs,
  });
  log.info('local agent run finish', {
    ...runLogContext,
    status: terminal.status,
    output_chars: finalOutput?.length ?? 0,
    has_error: !!terminal.error,
    error: terminal.error ? logErrorRef(new Error(terminal.error)) : undefined,
    duration_ms: endedAtMs - startedAtMs,
    diagnostics: summarizeLocalAgentRunForLog(runDiagnostics, endedAtMs),
  });
  return { runId: handle.runId, status: terminal.status, output: finalOutput, error: terminal.error };
}

async function _missing(opts: RunCliAgentOpts, entry: LocalCliEntry): Promise<RunCliAgentResult> {
  const err = entry.errorDetail || `local CLI '${opts.cli}' is not installed or not on PATH`;
  log.warn('local agent cli missing', {
    ...localAgentRunContextForLog({
      uid: opts.uid,
      cid: opts.cid,
      agentId: opts.agentId,
      projectId: opts.projectId,
      cli: opts.cli,
      model: opts.model,
      customArgs: opts.customArgs,
      resumeSessionId: opts.resumeSessionId,
      prompt: opts.prompt,
      cwd: opts.cwd,
      cliAvailable: entry.available,
      cliVersion: entry.version,
      bridgeSupported: _bridgeSupported(opts.cli),
    }),
    error: logErrorRef(new Error(err)),
  });
  opts.onEvent({
    type: 'done',
    status: 'missing_cli',
    error: err,
    cliError: entry.error || 'not_found',
    ...(entry.path ? { cliPath: entry.path } : {}),
    ...(entry.version ? { cliVersion: entry.version } : {}),
  });
  return {
    runId: '',
    status: 'missing_cli',
    error: err,
    cliError: entry.error || 'not_found',
    ...(entry.path ? { cliPath: entry.path } : {}),
    ...(entry.version ? { cliVersion: entry.version } : {}),
  };
}
