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

/** Wall-clock cap for a single CLI dispatch. Override at deploy /
 *  debugging time via env. 20 min covers nontrivial coding tasks
 *  while bounding zombie processes if the CLI hangs. */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

function resolveTimeoutMs(): number {
  const raw = process.env.ORKAS_LOCAL_AGENT_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1000) return DEFAULT_TIMEOUT_MS;
  return n;
}

/** How long the runner waits without seeing ANY backend event before
 *  emitting an `idle` heartbeat. The ticker below fires every
 *  `IDLE_TICK_MS`; the first emit happens once
 *  `now - lastEventAt > threshold`. Default 90 s because a thinking
 *  turn between tool calls runs ~10-40 s — 90 s comfortably skips real
 *  activity and catches genuine stalls. Backends with no streaming at
 *  all (openclaw) pass a smaller value via `BackendRunOptions.idleMs`. */
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
 *  semantics deviate from "streams events through the turn"; today
 *  openclaw is the only one (no streaming at all — see openclaw.ts
 *  header). */
const BACKEND_IDLE_MS: Partial<Record<LocalCliType, number>> = {
  openclaw: 30 * 1000,
};

const BACKENDS: Partial<Record<LocalCliType, LocalBackend>> = {
  claude: claudeBackend,
  codex: codexBackend,
  openclaw: openclawBackend,
  opencode: opencodeBackend,
  hermes: hermesBackend,
};

export interface RunCliAgentOpts {
  uid: string;
  cid: string;
  agentId: string;
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
}

export async function run(opts: RunCliAgentOpts): Promise<RunCliAgentResult> {
  const backend = BACKENDS[opts.cli];
  if (!backend) {
    log.warn('no backend registered for cli', { cli: opts.cli });
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

  const handle = await persist.start(opts.uid, {
    agentId: opts.agentId,
    cid: opts.cid,
    cli: opts.cli,
    model: opts.model,
    cliPath: entry.path,
    prompt: opts.prompt,
  });
  log.info('start', { runId: handle.runId, cli: opts.cli, agentId: opts.agentId, cid: opts.cid, cwd: opts.cwd });
  const startedAtMs = Date.now();

  // Wrapper writes events to disk before forwarding upstream so that
  // a renderer crash mid-run still leaves a complete jsonl trail.
  let streamedOutput = '';
  let terminal: { status: RunCliAgentResult['status']; output?: string; error?: string; sessionId?: string } | null = null;
  // The dev devtools LLM-call archive is stripped from this build; the runtime
  // `local-agent-runs/<runId>/` directory is the only persistence path.
  const idleThresholdMs = resolveIdleMs(BACKEND_IDLE_MS[opts.cli]);
  // CLI dispatch session id (matches the devtools-archive session id
  // built below). The per-session spill dir is anchored on this so
  // sweep / read paths can find the file again.
  const cliSessionId = `cli-${opts.cli}-${handle.runId}`;
  const spillDir = sessionToolResultsDir(opts.uid, cliSessionId);
  let lastEventAt = Date.now();
  const onEvent = (e: LocalEvent) => {
    // Self-emitted idle pulses don't count as "the CLI did something"
    // — without this carve-out we'd reset our own deadline and stop
    // pulsing during a real stall.
    if (e.type !== 'idle') lastEventAt = Date.now();
    // Tool-event result phase: spill oversized output to disk before
    // it lands in events.jsonl / the renderer stream. Above 50 KB the
    // raw bash output bloats the persistence log and the renderer
    // memory; the spill keeps a head+tail preview inline (matching
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

  // Idle ticker — purely informational; never kills the process. The
  // existing 20-minute wall-clock timeout stays the only kill path. We
  // re-emit at IDLE_TICK_MS cadence so the user gets a steady drumbeat
  // ("○ no output for 30s" repeated) confirming the run is still
  // ostensibly alive, rather than a single heartbeat that ages out.
  const idleTickMs = resolveIdleTickMs(idleThresholdMs);
  const idleTimer = setInterval(() => {
    if (terminal) return;  // run already finished, don't keep pulsing
    const stalledMs = Date.now() - lastEventAt;
    if (stalledMs > idleThresholdMs) {
      onEvent({ type: 'idle', stalledMs });
    }
  }, idleTickMs);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();

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
      timeoutMs: resolveTimeoutMs(),
      idleMs: BACKEND_IDLE_MS[opts.cli],
    });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.error('backend threw', { runId: handle.runId, error: msg });
    if (!terminal) {
      onEvent({ type: 'done', status: 'failed', error: msg });
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
  log.info('end', {
    runId: handle.runId, cli: opts.cli, status: terminal.status, bytes: finalOutput?.length ?? 0,
  });
  // The per-run jsonl under `local-agent-runs/<runId>/` (written by `persist`)
  // is the only post-run artifact in this build.
  void entry.version;
  void endedAtMs;
  return { runId: handle.runId, status: terminal.status, output: finalOutput, error: terminal.error };
}

async function _missing(opts: RunCliAgentOpts, entry: LocalCliEntry): Promise<RunCliAgentResult> {
  const err = entry.errorDetail || `local CLI '${opts.cli}' is not installed or not on PATH`;
  log.warn('missing cli', { cli: opts.cli, error: err });
  opts.onEvent({ type: 'done', status: 'missing_cli', error: err });
  return { runId: '', status: 'missing_cli', error: err };
}
