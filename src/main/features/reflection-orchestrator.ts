/**
 * Reflection orchestrator — the single trigger for metacognitive reflection.
 *
 * Replaces the old startup-only `reflection-trigger.ts` and the per-turn
 * `runner.evaluateReflection` path. Per `Common/docs/plans/reflection-redesign.md`:
 *
 *   - One scheduler: fire after the measured startup window (offset via
 *     util/boot_init.ts) and every `CYCLE_INTERVAL_MS` thereafter via a
 *     setTimeout chain.
 *   - Per-agent gating: 4h min cooldown plus the dirty gate (signals.jsonl or
 *     session jsonl newer than the last examination). Activity is the only
 *     reason to reflect: the former 7-day max-gap fallback forced a cycle for
 *     idle agents whose transcript is empty by construction, and because a
 *     failure never advanced the timestamp those agents re-occupied the cap
 *     every cycle forever — 21 consecutive cycles produced 0 reflections on
 *     the machine this was diagnosed on, all five slots held by the same
 *     idle agents.
 *   - Per-cycle cap: at most `MAX_AGENTS_PER_CYCLE`; eligible-but-deferred
 *     agents wait for the next cycle (no agents lost).
 *   - Sequential execution, bounded per agent (`PER_AGENT_TIMEOUT_MS`) and
 *     yielding between agents when the user returns. A transient failure
 *     (provider, cancellation, unreadable sources) does not advance the
 *     timestamp, so the next cycle retries. An examined window does advance
 *     it — whether it produced an update, nothing worth saving, or held no
 *     activity — because re-reading the same span can only reach the same
 *     conclusion while starving agents that do have new activity.
 *
 * Background work; every cycle enters through the shared boot/background
 * admission queue. Tests inject `reflect`, `now`, and timing knobs via
 * `runOneCycle`.
 */

import * as fs from 'node:fs';
import { userReflectionStateFile, userLocalConfigDir } from '../paths';
import { writeJsonSync } from '../storage';
import { createLogger } from '../logger';
import { logErrorRef } from '../util/log-redact';
import { listAgents } from './agents';
import { listConversations, type Conversation } from './chats';
import * as metacognition from './metacognition';
import { buildTranscript, listAgentGmemberFiles } from './reflection-transcript';
import { querySignalsForUser } from './expert_signals';
import { buildRunner } from '../model/core-agent/runner';
import { cloudSessionFileFor } from '../util/project-layout';
import { resolveLanguageForUser } from './config';
import { getLocaleMeta } from '../i18n';
import { scheduleBootBackground, isBootAdmissionIdle, type ScheduledBootBackgroundTask } from '../util/boot_init';
import { registerUserSwitchHook } from './user-switch-hooks';
import { getActiveUserId } from './users';
type ReflectionErrorCode =
  | 'transcript_unavailable'
  | 'empty_response'
  | 'cancelled'
  | 'runner_unavailable'
  | 'unknown';

const log = createLogger('reflection-orchestrator');

// ── Constants (per plan §2.1) ────────────────────────────────────────────

/** Interval between cycles after the first. */
export const CYCLE_INTERVAL_MS = 12 * 3600 * 1000;
/** Minimum gap between reflections for the same agent (anti-thrash). */
export const MIN_COOLDOWN_MS = 4 * 3600 * 1000;
/** Default initial lookback window for never-reflected agents. */
export const DEFAULT_LOOKBACK_MS = 48 * 3600 * 1000;
/** Per-cycle agent cap — defer overflow to next cycle. */
export const MAX_AGENTS_PER_CYCLE = 5;
/** Ceiling for one agent's reflection. A real one (read both meta files,
 *  write an update) measured ~25s; the pathological bound is five model
 *  calls. Exceeding it fails that agent alone — the cycle continues. */
export const PER_AGENT_TIMEOUT_MS = 120 * 1000;
/** Sentinel agent id covering all `normal` (no-agent-bound) conversations. */
export const DEFAULT_AGENT_ID = '_default';

// ── State IO (kept compatible with old reflection-state.json) ────────────

export interface ReflectionState {
  /** ISO timestamp per agent id (or `_default`): when this agent's activity
   *  window was last examined. It is the baseline for the next transcript and
   *  for the cooldown, so it also advances when the examination found nothing
   *  to reflect on. The field name is kept for on-disk compatibility with
   *  existing `reflection-state.json` files. */
  lastReflectedAt: Record<string, string>;
}

export function readReflectionState(uid: string): ReflectionState {
  const file = userReflectionStateFile(uid);
  if (!fs.existsSync(file)) return { lastReflectedAt: {} };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.lastReflectedAt || typeof data.lastReflectedAt !== 'object') {
      log.warn(`reflection-state.json malformed for uid ${uid}, treating as empty`);
      return { lastReflectedAt: {} };
    }
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(data.lastReflectedAt as Record<string, unknown>)) {
      if (typeof v === 'string') clean[k] = v;
    }
    return { lastReflectedAt: clean };
  } catch (err) {
    log.warn(`reflection-state.json parse failed for uid ${uid}: ${(err as Error).message}, treating as empty`);
    return { lastReflectedAt: {} };
  }
}

export function writeReflectionState(uid: string, state: ReflectionState): void {
  writeJsonSync(userReflectionStateFile(uid), state);
}

// ── Eligibility & dirty gate (pure / IO) ────────────────────────────────

interface AgentDecision {
  agentId: string;
  /** Lower bound for activity to include in the next reflection's transcript. */
  sinceMs: number;
  /** Why we picked this agent (logged when we actually run). */
  reason: 'dirty' | 'never_reflected';
}

/** Decide which agents are due for reflection in this cycle.
 *  Pure-ish wrt to `state` (read once, ts compared in-memory); the dirty
 *  check is delegated to `isDirty` so tests can stub it. */
export async function pickAgentsForCycle(
  uid: string,
  agentIds: string[],
  state: ReflectionState,
  now: number,
  isDirty: (uid: string, agentId: string, sinceMs: number) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<AgentDecision[]> {
  const out: AgentDecision[] = [];
  for (const id of agentIds) {
    if (signal?.aborted) break;
    const lastIso = state.lastReflectedAt[id];
    const lastMs = lastIso ? Date.parse(lastIso) : NaN;
    const hasLast = !Number.isNaN(lastMs);

    if (hasLast && now - lastMs < MIN_COOLDOWN_MS) continue;        // cooldown

    const sinceMs = hasLast ? lastMs : now - DEFAULT_LOOKBACK_MS;
    if (await isDirty(uid, id, sinceMs)) {
      out.push({ agentId: id, sinceMs, reason: hasLast ? 'dirty' : 'never_reflected' });
    }
  }

  // Apply per-cycle cap: most-stale (earliest lastReflectedAt) first; ties broken
  // by ordering of agentIds (we already put _default first). Never-reflected
  // agents sort earliest (Date.parse(undefined) = NaN → treat as 0).
  out.sort((a, b) => {
    const aLast = Date.parse(state.lastReflectedAt[a.agentId] || '') || 0;
    const bLast = Date.parse(state.lastReflectedAt[b.agentId] || '') || 0;
    return aLast - bLast;
  });

  if (out.length > MAX_AGENTS_PER_CYCLE) {
    const deferred = out.length - MAX_AGENTS_PER_CYCLE;
    log.info(`cycle: ${out.length} eligible, capping at ${MAX_AGENTS_PER_CYCLE}, deferring ${deferred} to next cycle`);
    return out.slice(0, MAX_AGENTS_PER_CYCLE);
  }
  return out;
}

/** Dirty check: an agent is dirty if signals.jsonl has any entry attributed
 *  to it since `sinceMs`, OR if any of its session jsonl files has a turn
 *  newer than `sinceMs`. */
export async function isAgentDirty(uid: string, agentId: string, sinceMs: number): Promise<boolean> {
  const isDefault = agentId === DEFAULT_AGENT_ID;

  // (1) signals.jsonl probe
  try {
    const sigs = await querySignalsForUser(uid, {
      since: new Date(sinceMs).toISOString(),
      aid: isDefault ? null : agentId,
      limit: 1,
    });
    if (sigs.length > 0) return true;
  } catch (err) {
    log.warn(`isAgentDirty: querySignals failed agent=${agentId}: ${(err as Error).message}`);
  }

  // (2) session jsonl mtime probe.
  //   - `_default`: scan gconv-* of convs with no bound agent (commander = "agent").
  //   - Specific agent: scan its gmember-*-<aid>.jsonl files directly. This
  //     bypasses `conv.agent_id` (UI-hint, "starting agent") and catches
  //     dispatched-in convs the previous design missed.
  if (isDefault) {
    let convs: Conversation[] = [];
    try { convs = await listConversations(uid); }
    catch (err) {
      log.warn(`isAgentDirty: listConversations failed: ${(err as Error).message}`);
      return false;
    }
    for (const c of convs) {
      if (c.agent_id) continue;
      if (_sessionNewerThan(uid, c.session_id, sinceMs)) return true;
    }
  } else {
    for (const { file } of listAgentGmemberFiles(uid, agentId)) {
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs >= sinceMs) return true;
      } catch { /* skip unreadable file */ }
    }
  }
  return false;
}

function _sessionNewerThan(uid: string, sessionId: string, sinceMs: number): boolean {
  let file: string;
  try { file = cloudSessionFileFor(uid, sessionId); } catch { return false; }
  try {
    const stat = fs.statSync(file);
    return stat.mtimeMs >= sinceMs;
  } catch { return false; }
}

// ── Reflection invocation ────────────────────────────────────────────────

/**
 * How a reflection ended. All three are terminal for this cycle and advance
 * the baseline; only a thrown error means "retry next cycle".
 *
 *   - `reflected`          wrote something durable (metacognition or a skill)
 *   - `nothing_to_save`    read the window, deliberately wrote nothing
 *   - `nothing_to_reflect` the window itself held no activity
 *
 * `nothing_to_save` is a success, not a degraded one: the review prompt tells
 * the model to answer "nothing to save" rather than reflect for its own sake.
 * It is separate from `reflected` because otherwise the cycle aggregate
 * reports "the LLM replied" while claiming to report "the loop produced
 * something" — which is exactly how this feature ran for weeks unnoticed.
 */
export type ReflectOutcome = 'reflected' | 'nothing_to_save' | 'nothing_to_reflect';

export type ReflectFn = (
  uid: string,
  agentId: string,
  sinceMs: number,
  signal?: AbortSignal,
) => Promise<ReflectOutcome>;

/** Tag a failure with a bounded analytics code so the cycle aggregate can
 *  report why without widening the dimension or leaking a raw message. */
function reflectionError(code: ReflectionErrorCode, message: string): Error {
  return Object.assign(new Error(message), { reflectionCode: code });
}

function reflectionErrorCode(err: unknown): ReflectionErrorCode {
  const code = (err as { reflectionCode?: unknown } | null)?.reflectionCode;
  return typeof code === 'string' ? code as ReflectionErrorCode : 'unknown';
}

/** Build the reflection prompt for one agent and run it. Throws only for
 *  failures worth retrying; an examined-but-empty window returns
 *  `nothing_to_reflect` so the caller advances the baseline. */
async function realReflectForAgent(
  uid: string,
  agentId: string,
  sinceMs: number,
  signal?: AbortSignal,
): Promise<ReflectOutcome> {
  const runnerAgentId = agentId === DEFAULT_AGENT_ID ? '' : agentId;

  // Ephemeral session — runReflection uses an in-memory session (not the
  // jsonl) so this id is just a label for the LLM-archive devtools.
  const tail = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sessionId = `reflect-${tail}`;

  const { runner } = await buildRunner({ sessionId, userId: uid, agentId: runnerAgentId });
  if (signal?.aborted) throw reflectionError('cancelled', 'reflection cancelled');

  const transcriptResult = await buildTranscript(uid, agentId, sinceMs);
  if (signal?.aborted) throw reflectionError('cancelled', 'reflection cancelled');
  if (transcriptResult.unavailable) {
    // Sources could not be read: an empty transcript here means "unknown",
    // so retry rather than consuming the window.
    throw reflectionError('transcript_unavailable', 'transcript sources unavailable');
  }
  if (!transcriptResult.text) {
    // The window was examined and held nothing a reflection could use — a
    // dirty session file whose in-window content is tool-only, a swept conv,
    // a race. Terminal for this window: the caller advances the baseline so
    // the next cycle looks at new activity instead of re-reading this span.
    log.info(`reflect ${agentId}: no reflectable activity in window (considered=${transcriptResult.stats.convsConsidered})`);
    return 'nothing_to_reflect';
  }

  const ca = await import('#core-agent');
  const comp = metacognition.readContentForUser(uid, agentId, 'competence');
  const strat = metacognition.readContentForUser(uid, agentId, 'strategies');
  const languageName = getLocaleMeta(resolveLanguageForUser(uid)).llmName;
  const prompt = ca.buildReviewPrompt(comp.content || '', strat.content || '', transcriptResult.text, languageName);

  // `runReflection` swallows provider/LLM/loop errors and returns ''; an
  // empty response is treated as a failed reflection (cooldown not stamped).
  let writes = 0;
  const responseText = await runner.runReflection(
    prompt, signal, undefined, undefined, () => { writes += 1; },
  );
  if (!responseText || !responseText.trim()) {
    // Every failure inside `runReflection` collapses to '', including our own
    // deadline, so ask the signal before blaming the provider.
    if (signal?.aborted) throw reflectionError('cancelled', 'reflection cancelled');
    throw reflectionError('empty_response', 'reflection returned empty (provider/LLM error or max loops; see core-agent log)');
  }

  const transcriptStats = `transcript ${transcriptResult.stats.convsIncluded}/${transcriptResult.stats.convsConsidered} convs, ~${transcriptResult.stats.estimatedTokens} tokens`;
  if (writes === 0) {
    // The prompt's own instruction when a window holds no new lesson.
    log.info(`reflect ${agentId}: nothing to save (${transcriptStats})`);
    return 'nothing_to_save';
  }
  log.info(`reflect ${agentId}: ok (wrote ${writes}, ${transcriptStats})`);
  return 'reflected';
}

// ── Cycle ───────────────────────────────────────────────────────────────

export interface RunCycleOpts {
  /** Override reflection invocation (test seam). */
  reflect?: ReflectFn;
  /** Override `Date.now()` (test seam). */
  now?: () => number;
  /** Override dirty check (test seam). */
  isDirty?: (uid: string, agentId: string, sinceMs: number) => Promise<boolean>;
  /** Cooperative cancellation between catalog checks and agent reflections. */
  signal?: AbortSignal;
  /** Override the between-agents idle check (test seam). */
  isIdle?: () => boolean;
  /** Override the per-agent deadline (test seam). */
  perAgentTimeoutMs?: number;
}

/**
 * Bound one agent's reflection without touching its neighbours.
 *
 * The cycle used to run under a single 30s `maxSliceMs`, so one slow agent
 * aborted itself *and* ended the cycle — and the slow agents are precisely
 * the ones reading their files and writing an update, while a "nothing to
 * save" reply finishes in five seconds. Budgeting per agent removes that
 * selection pressure.
 */
async function withDeadline<T>(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parent?.reason);
  parent?.addEventListener('abort', onParentAbort, { once: true });
  if (parent?.aborted) onParentAbort();
  const timer = setTimeout(
    () => controller.abort(new Error('reflection deadline exceeded')),
    Math.max(1, timeoutMs),
  );
  timer.unref?.();
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}

/** Run one reflection cycle: enumerate agents, pick eligible (capped),
 *  reflect sequentially. Returns the count actually reflected — useful for
 *  tests and logging. */
export async function runOneCycle(uid: string, opts: RunCycleOpts = {}): Promise<number> {
  if (opts.signal?.aborted) return 0;
  if (!uid) {
    log.debug('no active uid, skipping cycle');
    return 0;
  }
  if (!metacognition.isFeatureEnabledForUser(uid)) {
    log.debug('metacognition disabled, skipping cycle');
    return 0;
  }
  fs.mkdirSync(userLocalConfigDir(uid), { recursive: true });

  const startedAt = Date.now();
  const now = (opts.now ?? Date.now)();
  const reflect = opts.reflect ?? realReflectForAgent;
  const dirtyFn = opts.isDirty ?? isAgentDirty;

  let agents: Awaited<ReturnType<typeof listAgents>> = [];
  try { agents = await listAgents(); }
  catch (err) { log.warn(`listAgents failed: ${(err as Error).message}`); }
  if (opts.signal?.aborted) return 0;

  // `_default` first so the most common bucket gets attention even if a
  // long agent list later in the loop hits issues.
  const agentIds = [DEFAULT_AGENT_ID, ...agents.map((a) => a.agent_id)];
  const state = readReflectionState(uid);
  const eligible = await pickAgentsForCycle(uid, agentIds, state, now, dirtyFn, opts.signal);

  if (eligible.length === 0) {
    log.debug(`cycle: nothing eligible (${agentIds.length} agents scanned)`);
    return 0;
  }
  log.info(`cycle start: ${eligible.length}/${agentIds.length} agent(s) eligible`);

  let completed = 0;
  let noChange = 0;
  let empty = 0;
  let failed = 0;
  let dominantError: ReflectionErrorCode | undefined;
  const isIdle = opts.isIdle ?? isBootAdmissionIdle;
  const perAgentTimeoutMs = opts.perAgentTimeoutMs ?? PER_AGENT_TIMEOUT_MS;
  let attempted = 0;
  for (const { agentId, sinceMs, reason } of eligible) {
    if (opts.signal?.aborted) break;
    // Yield between agents, never inside one. Cutting a reflection off throws
    // away the tokens it already spent and leaves it to retry from scratch;
    // deferring it here costs nothing, because a deferred agent keeps its old
    // baseline and therefore leads the next cycle.
    //
    // Never before the first: admission already decided this cycle may run,
    // and it admits a waiting cycle after `maxUserDeferralMs` even while the
    // user is active. Re-asking here would overturn that and let a busy
    // account defer every agent of every cycle indefinitely.
    if (attempted > 0 && !isIdle()) {
      const remaining = eligible.length - attempted;
      log.info(`cycle: user active, deferring ${remaining} remaining agent(s) to next cycle`);
      break;
    }
    attempted += 1;
    try {
      const outcome = await withDeadline(
        opts.signal, perAgentTimeoutMs, (signal) => reflect(uid, agentId, sinceMs, signal),
      );
      // Account switching cancels the old cycle. A provider/tool may resolve
      // after observing cancellation, but that stale work must never earn a
      // cooldown stamp or suppress the new account's next reflection.
      if (opts.signal?.aborted) break;
      // Advance the baseline — read fresh state in case another writer touched
      // it. An empty window advances too: re-reading a span already known to
      // hold nothing cannot succeed, and leaving it would let that agent hold
      // a cap slot against agents that do have activity.
      const next = readReflectionState(uid);
      next.lastReflectedAt[agentId] = new Date(now).toISOString();
      writeReflectionState(uid, next);
      if (outcome === 'reflected') {
        completed += 1;
        log.info(`reflect ${agentId}: completed (${reason})`);
      } else if (outcome === 'nothing_to_save') {
        noChange += 1;
      } else {
        empty += 1;
      }
    } catch (err) {
      failed += 1;
      // First failure wins: cycles are small and sequential, so the earliest
      // code is the most useful single value for a bounded dimension.
      if (!dominantError) dominantError = reflectionErrorCode(err);
      log.warn(`reflect ${agentId}: failed (${reason}): ${(err as Error).message}`);
    }
  }
  const endDetail = [
    noChange ? `${noChange} with nothing to save` : '',
    empty ? `${empty} with no reflectable activity` : '',
  ].filter(Boolean).join(', ');
  log.info(`cycle end: ${completed}/${eligible.length} agent(s) wrote an update${endDetail ? `, ${endDetail}` : ''}`);
  return completed;
}

// ── Loop control ─────────────────────────────────────────────────────────

export interface LoopHandle {
  /** Cancel scheduled work and abort any in-flight cycle cooperatively. */
  stop(): void;
}

/** Create a raw per-account reflection loop. Lifecycle ownership lives in
 * `startReflectionLoop`, which replaces it when the active account changes. */
function createReflectionLoop(uid: string, opts: RunCycleOpts): LoopHandle {
  let scheduled: ScheduledBootBackgroundTask | null = null;
  let stopped = false;

  const scheduleCycle = (delayMs: number): void => {
    scheduled = scheduleBootBackground('reflection:cycle', async (signal) => {
      if (stopped || signal?.aborted) return;
      try { await runOneCycle(uid, { ...opts, signal }); }
      catch (err) { log.error('cycle threw', { error: logErrorRef(err) }); }
    }, delayMs, {
      resourceClass: 'model',
      preferIdle: true,
      // Hang net only. Throttling is `PER_AGENT_TIMEOUT_MS` plus the
      // between-agents idle check: a cycle-wide slice aborts mid-write, and
      // at 30s it could not even seat one real reflection, so it ended cycles
      // after a single agent while reporting the rest as untouched.
      maxSliceMs: 8 * 60 * 1000,
    });
    void scheduled.promise.finally(() => {
      scheduled = null;
      if (!stopped) scheduleCycle(CYCLE_INTERVAL_MS);
    });
  };

  // Delay makes a cycle eligible; the coordinator still waits for a quiet
  // interaction window before the disk/model work begins.
  scheduleCycle(0);

  return {
    stop() {
      stopped = true;
      scheduled?.cancel();
      scheduled = null;
    },
  };
}

interface ManagedLoop {
  uid: string;
  pendingUid: string | null;
  switchEpoch: number;
  opts: RunCycleOpts;
  raw: LoopHandle;
  stopped: boolean;
}

let activeLoop: ManagedLoop | null = null;

/** Start the reflection loop: run one cycle now, then every
 * `CYCLE_INTERVAL_MS` until stopped. Starting again replaces the previous
 * loop. Account switches abort the old account's work and immediately arm a
 * loop for the new account with the same options. */
export function startReflectionLoop(uid: string, opts: RunCycleOpts = {}): LoopHandle {
  if (activeLoop) {
    activeLoop.stopped = true;
    activeLoop.raw.stop();
  }

  const managed: ManagedLoop = {
    uid,
    pendingUid: null,
    switchEpoch: 0,
    opts,
    raw: { stop() { /* replaced immediately below */ } },
    stopped: false,
  };
  managed.raw = createReflectionLoop(uid, opts);
  activeLoop = managed;

  return {
    stop() {
      if (managed.stopped) return;
      managed.stopped = true;
      managed.switchEpoch += 1;
      managed.pendingUid = null;
      managed.raw.stop();
      if (activeLoop === managed) activeLoop = null;
    },
  };
}

registerUserSwitchHook('reflection-orchestrator', (previousUid, nextUid) => {
  const managed = activeLoop;
  if (!managed
      || managed.stopped
      || (managed.uid !== previousUid && managed.pendingUid !== previousUid)) return;
  managed.raw.stop();
  managed.pendingUid = nextUid;
  managed.switchEpoch += 1;
  const switchEpoch = managed.switchEpoch;
  // Account activation can still be rejected by another safety hook. Arm the
  // next loop only after the synchronous switch commits; the epoch also
  // collapses rapid A→B→C switches into the final active account.
  queueMicrotask(() => {
    if (activeLoop !== managed
        || managed.stopped
        || managed.switchEpoch !== switchEpoch
        || managed.pendingUid !== nextUid) return;
    let activeUid = '';
    try { activeUid = getActiveUserId(); } catch { return; }
    if (activeUid !== nextUid) return;
    managed.uid = nextUid;
    managed.pendingUid = null;
    managed.raw = createReflectionLoop(nextUid, managed.opts);
  });
});
