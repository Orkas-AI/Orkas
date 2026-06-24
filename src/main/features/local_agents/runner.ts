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
        sandboxEnv: buildSkillSandboxEnv(opts.uid),
      });
    } catch (err) {
      log.warn('bridge start failed — running without orkas MCP server', {
        runId: handle.runId, error: (err as Error).message,
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
      timeoutMs: resolveTimeoutMs(opts.cli),
      idleKillMs: resolveIdleKillMs(opts.cli),
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
    log.error('backend threw', { runId: handle.runId, error: msg });
    if (!terminal) {
      onEvent({ type: 'done', status: 'failed', error: msg });
    }
  } finally {
    if (bridge) {
      try { await bridge.close(); }
      catch (err) { log.warn('bridge close failed', { runId: handle.runId, error: (err as Error).message }); }
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
  return { runId: handle.runId, status: terminal.status, output: finalOutput, error: terminal.error };
}

async function _missing(opts: RunCliAgentOpts, entry: LocalCliEntry): Promise<RunCliAgentResult> {
  const err = entry.errorDetail || `local CLI '${opts.cli}' is not installed or not on PATH`;
  log.warn('missing cli', { cli: opts.cli, error: err });
  opts.onEvent({ type: 'done', status: 'missing_cli', error: err });
  return { runId: '', status: 'missing_cli', error: err };
}
