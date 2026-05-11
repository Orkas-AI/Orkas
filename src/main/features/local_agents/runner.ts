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
  const onEvent = (e: LocalEvent) => {
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
    });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.error('backend threw', { runId: handle.runId, error: msg });
    if (!terminal) {
      onEvent({ type: 'done', status: 'failed', error: msg });
    }
  }

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
  // The per-run jsonl under `local-agent-runs/<runId>/` (written by
  // `persist`) is the only post-run artifact.
  return { runId: handle.runId, status: terminal.status, output: finalOutput, error: terminal.error };
}

async function _missing(opts: RunCliAgentOpts, entry: LocalCliEntry): Promise<RunCliAgentResult> {
  const err = entry.errorDetail || `local CLI '${opts.cli}' is not installed or not on PATH`;
  log.warn('missing cli', { cli: opts.cli, error: err });
  opts.onEvent({ type: 'done', status: 'missing_cli', error: err });
  return { runId: '', status: 'missing_cli', error: err };
}
