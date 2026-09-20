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
 *     yielding immediately when foreground tasks arrive. Busy attempts retry
 *     once after ten minutes; the next normal cycle is fourteen hours later.
 *     Cancellation never stamps an attempt. A transient failure
 *     (provider, unreadable sources) does not advance the
 *     timestamp, so the next cycle retries — but it does stamp the attempt:
 *     cooldown and cap ordering key off the last attempt, and the cooldown
 *     doubles per consecutive failure, so a failing agent cannot hold the
 *     head of the queue every cycle. After `MAX_FAILURE_STREAK` failures in
 *     a row the window is given up (baseline advanced) instead of replaying
 *     the same input forever. An examined window does advance the baseline
 *     — whether it produced an update, nothing worth saving, or held no
 *     activity — because re-reading the same span can only reach the same
 *     conclusion while starving agents that do have new activity.
 *   - A cycle is skipped outright while every configured model candidate
 *     is cooling down: running it could only burn a failed attempt per
 *     agent, and the dirty scan plus runner build before the first model
 *     call are not free.
 *
 * Background work; every cycle enters through the shared boot/background
 * admission queue. Tests inject `reflect`, `now`, and timing knobs via
 * `runOneCycle`.
 */

import * as fs from 'node:fs';
import type { ToolResult } from '#core-agent';
import { beginReflection, isReflectionYield } from './reflection-coordination';
import { userReflectionStateFile, userLocalConfigDir } from '../paths';
import { writeJsonSync } from '../storage';
import { createLogger } from '../logger';
import { logErrorSummary, maskId } from '../util/log-redact';
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
  | 'timeout'
  | 'runner_unavailable'
  | 'no_provider'
  | 'max_loops'
  | 'model_unavailable'
  | 'llm_error'
  | 'unknown';

const log = createLogger('reflection-orchestrator');

// ── Constants (per plan §2.1) ────────────────────────────────────────────

/** Interval between cycles after the first. */
export const CYCLE_INTERVAL_MS = 14 * 3600 * 1000;
/** One foreground-work deferral per cycle, including interruption after start. */
export const BUSY_RETRY_MS = 10 * 60 * 1000;
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
/** Consecutive failures after which an agent's current window is given up
 *  (baseline advanced) rather than retried again forever. */
export const MAX_FAILURE_STREAK = 3;
/** Upper bound on the failure backoff exponent: 4h × 2^n, so 64h at most. */
const MAX_BACKOFF_EXPONENT = 4;
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
  /** ISO timestamp per agent id: when this agent was last attempted, whether
   *  or not it succeeded. Cooldown and cap ordering use the later of this and
   *  `lastReflectedAt`, so an agent that keeps failing goes to the back of the
   *  queue instead of re-occupying a cap slot every cycle. Absent in state
   *  files written before this field existed. */
  lastAttemptAt?: Record<string, string>;
  /** Consecutive failed attempts per agent id. Cleared on success and when
   *  the window is given up after `MAX_FAILURE_STREAK`. */
  failureStreak?: Record<string, number>;
}

function cleanIsoMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') clean[k] = v;
  }
  return Object.keys(clean).length ? clean : undefined;
}

function cleanCountMap(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) clean[k] = v;
  }
  return Object.keys(clean).length ? clean : undefined;
}

export function readReflectionState(uid: string): ReflectionState {
  const file = userReflectionStateFile(uid);
  if (!fs.existsSync(file)) return { lastReflectedAt: {} };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.lastReflectedAt || typeof data.lastReflectedAt !== 'object') {
      log.warn('reflection-state.json malformed; treating as empty', {
        user_id: maskId(uid),
      });
      return { lastReflectedAt: {} };
    }
    const clean = cleanIsoMap(data.lastReflectedAt) ?? {};
    const lastAttemptAt = cleanIsoMap(data.lastAttemptAt);
    const failureStreak = cleanCountMap(data.failureStreak);
    return {
      lastReflectedAt: clean,
      ...(lastAttemptAt ? { lastAttemptAt } : {}),
      ...(failureStreak ? { failureStreak } : {}),
    };
  } catch (err) {
    log.warn('reflection-state.json parse failed; treating as empty', {
      user_id: maskId(uid),
      error: logErrorSummary(err),
    });
    return { lastReflectedAt: {} };
  }
}

export function writeReflectionState(uid: string, state: ReflectionState): void {
  writeJsonSync(userReflectionStateFile(uid), state);
}

function parseIsoMs(iso: string | undefined): number {
  return iso ? Date.parse(iso) : NaN;
}

/** Later of the last examination and the last attempt; `-Infinity` when the
 *  agent has never been touched. This is the timestamp cooldown and cap
 *  ordering compare against. */
function lastTouchedMs(state: ReflectionState, agentId: string): number {
  const reflected = parseIsoMs(state.lastReflectedAt[agentId]);
  const attempted = parseIsoMs(state.lastAttemptAt?.[agentId]);
  return Math.max(
    Number.isNaN(reflected) ? -Infinity : reflected,
    Number.isNaN(attempted) ? -Infinity : attempted,
  );
}

/** Cooldown for an agent given its consecutive-failure streak: the base
 *  4h, doubling per failure so a broken model or transcript is not retried
 *  on every cycle. */
export function cooldownForStreak(streak: number): number {
  const exponent = Math.min(Math.max(0, Math.floor(streak)), MAX_BACKOFF_EXPONENT);
  return MIN_COOLDOWN_MS * (2 ** exponent);
}

/** Record an attempt on `state` in place. Returns the failure streak after
 *  this attempt (0 on success). */
function recordAttempt(state: ReflectionState, agentId: string, iso: string, ok: boolean): number {
  state.lastAttemptAt = { ...(state.lastAttemptAt ?? {}), [agentId]: iso };
  if (ok) {
    if (state.failureStreak) {
      delete state.failureStreak[agentId];
      if (!Object.keys(state.failureStreak).length) delete state.failureStreak;
    }
    return 0;
  }
  const streak = (state.failureStreak?.[agentId] ?? 0) + 1;
  state.failureStreak = { ...(state.failureStreak ?? {}), [agentId]: streak };
  return streak;
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
    const lastMs = parseIsoMs(state.lastReflectedAt[id]);
    const hasLast = !Number.isNaN(lastMs);

    // Cooldown counts from the last attempt, not the last success, and grows
    // with the failure streak: a failing agent that kept its old baseline
    // used to pass this gate on every cycle and sort to the front below.
    const touchedMs = lastTouchedMs(state, id);
    const streak = state.failureStreak?.[id] ?? 0;
    if (touchedMs > -Infinity && now - touchedMs < cooldownForStreak(streak)) continue;

    const sinceMs = hasLast ? lastMs : now - DEFAULT_LOOKBACK_MS;
    if (await isDirty(uid, id, sinceMs)) {
      out.push({ agentId: id, sinceMs, reason: hasLast ? 'dirty' : 'never_reflected' });
    }
  }

  // Apply per-cycle cap: least recently touched first; ties broken by
  // ordering of agentIds (we already put _default first). Never-touched
  // agents sort earliest. A failed attempt counts as touched, so the same
  // broken agent cannot pin a cap slot cycle after cycle.
  out.sort((a, b) => {
    const aLast = Math.max(lastTouchedMs(state, a.agentId), 0);
    const bLast = Math.max(lastTouchedMs(state, b.agentId), 0);
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
    log.warn('isAgentDirty: querySignals failed', { agent_id: maskId(agentId), error: logErrorSummary(err) });
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
      log.warn('isAgentDirty: listConversations failed', { error: logErrorSummary(err) });
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
  /** Fired once per durable memory write this reflection lands. The caller
   *  needs it for the outcome it cannot read from a rejected race: a run cut
   *  off by the deadline may already have saved its lessons. */
  onDurableWrite?: () => void,
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

/** Why a signal fired: the per-agent deadline tags its abort reason, every
 *  other abort (account switch, background slice, app quit) is a cancel. */
function abortCode(signal: AbortSignal | undefined): ReflectionErrorCode {
  return reflectionErrorCode(signal?.reason) === 'timeout' ? 'timeout' : 'cancelled';
}

/** The rotating provider throws this when every candidate is skipped as
 *  cooling down, i.e. nothing was even attempted. */
function isModelUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /no candidates/i.test(message);
}

/** Map `runReflection`'s failure observation onto the bounded analytics
 *  code. `empty_output` keeps the historical `empty_response` code: it is
 *  the one case where the model genuinely replied with nothing. */
function failureCode(failure: { kind: string; error?: unknown } | undefined): ReflectionErrorCode {
  switch (failure?.kind) {
    case 'no_provider': return 'no_provider';
    case 'max_loops': return 'max_loops';
    case 'llm_error': return isModelUnavailableError(failure?.error) ? 'model_unavailable' : 'llm_error';
    case 'empty_output': return 'empty_response';
    default: return 'empty_response';
  }
}

/** Build the reflection prompt for one agent and run it. Throws only for
 *  failures worth retrying; an examined-but-empty window returns
 *  `nothing_to_reflect` so the caller advances the baseline. */
async function realReflectForAgent(
  uid: string,
  agentId: string,
  sinceMs: number,
  signal?: AbortSignal,
  onDurableWrite?: () => void,
  withToolExecution?: (execute: () => Promise<ToolResult>) => Promise<ToolResult>,
): Promise<ReflectOutcome> {
  const runnerAgentId = agentId === DEFAULT_AGENT_ID ? '' : agentId;

  // Ephemeral session — runReflection uses an in-memory session (not the
  // jsonl) so this id is just a label for the LLM-archive devtools.
  const tail = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sessionId = `reflect-${tail}`;

  let runner: Awaited<ReturnType<typeof buildRunner>>['runner'];
  try {
    ({ runner } = await buildRunner({ sessionId, userId: uid, agentId: runnerAgentId }));
  } catch (err) {
    if (signal?.aborted) throw reflectionError(abortCode(signal), 'reflection cancelled');
    // No usable model entry, expired OAuth, or a similar host-side gate:
    // nothing to retry until the user fixes their configuration.
    throw reflectionError('runner_unavailable', 'runner unavailable');
  }
  if (signal?.aborted) throw reflectionError(abortCode(signal), 'reflection cancelled');

  const ca = await import('#core-agent');
  const comp = metacognition.readContentForUser(uid, agentId, 'competence');
  const strat = metacognition.readContentForUser(uid, agentId, 'strategies');
  const languageName = getLocaleMeta(resolveLanguageForUser(uid)).llmName;
  const fixedPrompt = ca.buildReviewPrompt(comp.content || '', strat.content || '', '', languageName);
  const transcriptResult = await buildTranscript(uid, agentId, sinceMs, runner.getReflectionInputBudget(fixedPrompt));
  if (signal?.aborted) throw reflectionError(abortCode(signal), 'reflection cancelled');
  if (transcriptResult.unavailable || transcriptResult.capacityExceeded) {
    // Unreadable or entirely cropped evidence is not an examined quiet window;
    // retain the existing bounded failure/backoff handling.
    throw reflectionError('transcript_unavailable', transcriptResult.capacityExceeded
      ? 'reflection evidence exceeds input capacity' : 'transcript sources unavailable');
  }
  if (!transcriptResult.text) {
    // The window was examined and held nothing a reflection could use — a
    // dirty session file whose in-window content is tool-only, a swept conv,
    // a race. Terminal for this window: the caller advances the baseline so
    // the next cycle looks at new activity instead of re-reading this span.
    log.info(`reflect ${maskId(agentId)}: no reflectable activity in window (considered=${transcriptResult.stats.convsConsidered})`);
    return 'nothing_to_reflect';
  }

  const prompt = ca.buildReviewPrompt(comp.content || '', strat.content || '', transcriptResult.text, languageName);

  // `runReflection` swallows provider/LLM/loop errors and returns ''; the
  // failure observer is the only way to learn which one it was. An empty
  // response is a failed reflection (baseline not stamped).
  let writes = 0;
  let failure: { kind: string; error?: unknown } | undefined;
  const responseText = await runner.runReflection(
    prompt, signal, undefined, undefined,
    () => { writes += 1; onDurableWrite?.(); },
    (f) => { failure = f; },
    withToolExecution,
  );
  if (!responseText || !responseText.trim()) {
    // Every failure inside `runReflection` collapses to '', including our own
    // deadline, so ask the signal before blaming the provider.
    if (signal?.aborted) throw reflectionError(abortCode(signal), 'reflection cancelled');
    // Loop exhaustion after the durable writes already landed: the lessons
    // are saved, so failing here would re-run the same window next cycle
    // and write them again (2026-08-28 review E1-6).
    if (writes > 0) {
      log.warn('reflection produced no final text after durable writes; counting as reflected', {
        agent_id: maskId(agentId),
        write_count: writes,
      });
      return 'reflected';
    }
    throw reflectionError(
      failureCode(failure),
      `reflection returned empty (${failure?.kind ?? 'unreported'}; see core-agent log)`,
    );
  }

  const transcriptStats = `transcript ${transcriptResult.stats.convsIncluded}/${transcriptResult.stats.convsConsidered} convs, ~${transcriptResult.stats.estimatedTokens} tokens`;
  if (writes === 0) {
    // The prompt's own instruction when a window holds no new lesson.
    log.info(`reflect ${maskId(agentId)}: nothing to save (${transcriptStats})`);
    return 'nothing_to_save';
  }
  log.info(`reflect ${maskId(agentId)}: ok (wrote ${writes}, ${transcriptStats})`);
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
  /** Override the "can a model call succeed right now" gate (test seam). */
  isModelUsable?: () => boolean;
  /** Scheduling observation: foreground work deferred this attempt. */
  onDeferred?: () => void;
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
  let rejectAbort!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onParentAbort = (): void => {
    controller.abort(parent?.reason);
    rejectAbort(parent?.reason ?? reflectionError('cancelled', 'reflection cancelled'));
  };
  parent?.addEventListener('abort', onParentAbort, { once: true });
  if (parent?.aborted) onParentAbort();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = reflectionError('timeout', 'reflection deadline exceeded');
      controller.abort(err);
      reject(err);
    }, Math.max(1, timeoutMs));
    timer.unref?.();
  });
  try {
    const run = controller.signal.aborted ? Promise.reject(controller.signal.reason) : fn(controller.signal);
    return await Promise.race([run, deadline, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}

/** Run one reflection cycle: enumerate agents, pick eligible (capped),
 *  reflect sequentially. Returns the count actually reflected — useful for
 *  tests and logging. */
export async function runOneCycle(uid: string, opts: RunCycleOpts = {}): Promise<number> {
  if (!uid || opts.signal?.aborted || !metacognition.isFeatureEnabledForUser(uid)) return 0;
  // Busy work includes queue/admission gaps. Renderer activity alone does not
  // repeatedly cancel a model call or spend the single ten-minute retry.
  const isIdle = opts.isIdle ?? (() => isBootAdmissionIdle(0));
  if (!isIdle()) { opts.onDeferred?.(); return 0; }
  const lease = beginReflection(uid, opts.signal);
  if (!lease) { opts.onDeferred?.(); return 0; }
  try {
    const reflect: ReflectFn = opts.reflect ?? ((uid, aid, since, signal, onWrite) =>
      realReflectForAgent(uid, aid, since, signal, onWrite, (execute) => lease.runTool(execute, signal)));
    return await runCycle(uid, { ...opts, signal: lease.signal, isIdle, reflect });
  } finally {
    if (isReflectionYield(lease.signal.reason)) opts.onDeferred?.();
    await lease.close();
  }
}

async function runCycle(uid: string, opts: RunCycleOpts): Promise<number> {
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

  const now = (opts.now ?? Date.now)();
  const reflect = opts.reflect ?? realReflectForAgent;
  const dirtyFn = opts.isDirty ?? isAgentDirty;

  // Every configured candidate cooling down means no model call can succeed
  // this cycle: each eligible agent would burn a failed attempt (and its
  // backoff) for nothing, after paying the dirty scan and runner build. Skip
  // without touching any window; the cooldown is short next to the 14h
  // cadence. Nothing configured at all is left to `buildRunner`'s own gate.
  // Managed-provider cooldown inspection is private. Orkas still honors
  // the injectable gate used by deterministic tests and host integrations.
  const isModelUsable = opts.isModelUsable ?? (() => true);
  if (!isModelUsable()) {
    log.info('cycle: every configured model candidate is cooling down, skipping');
    return 0;
  }

  let agents: Awaited<ReturnType<typeof listAgents>> = [];
  try { agents = await listAgents(); }
  catch (err) { log.warn('listAgents failed', { error: logErrorSummary(err) }); }
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
  for (const { agentId, sinceMs, reason } of eligible) {
    if (opts.signal?.aborted) break;
    if (!isIdle()) {
      opts.onDeferred?.();
      break;
    }
    let durableWrites = 0;
    try {
      const outcome = await withDeadline(
        opts.signal, perAgentTimeoutMs,
        (signal) => reflect(uid, agentId, sinceMs, signal, () => { durableWrites += 1; }),
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
      const nowIso = new Date(now).toISOString();
      next.lastReflectedAt[agentId] = nowIso;
      recordAttempt(next, agentId, nowIso, true);
      writeReflectionState(uid, next);
      if (outcome === 'reflected') {
        completed += 1;
        log.info(`reflect ${maskId(agentId)}: completed (${reason})`);
      } else if (outcome === 'nothing_to_save') {
        noChange += 1;
      } else {
        empty += 1;
      }
    } catch (err) {
      if (opts.signal?.aborted) break;
      // The deadline abandons the run instead of waiting for it, so a
      // reflection that already saved lessons before it fired keeps them.
      // Retrying that window would write the same lessons again, which is the
      // reason loop exhaustion after a durable write also counts as reflected
      // (2026-08-28 review E1-6). Stamp the baseline and move on.
      if (reflectionErrorCode(err) === 'timeout' && durableWrites > 0 && !opts.signal?.aborted) {
        const next = readReflectionState(uid);
        const nowIso = new Date(now).toISOString();
        next.lastReflectedAt[agentId] = nowIso;
        recordAttempt(next, agentId, nowIso, true);
        writeReflectionState(uid, next);
        completed += 1;
        log.warn(`reflect ${agentId}: deadline after ${durableWrites} durable write(s); window consumed`);
        continue;
      }
      failed += 1;
      // First failure wins: cycles are small and sequential, so the earliest
      // code is the most useful single value for a bounded dimension.
      if (!dominantError) dominantError = reflectionErrorCode(err);
      log.warn('reflection failed', { agent_id: maskId(agentId), reason, error_code: reflectionErrorCode(err), error: logErrorSummary(err) });
      // A cycle-level cancel (account switch, slice budget) says nothing
      // about this agent, so it neither stamps the attempt nor grows the
      // streak. A per-agent failure does: the baseline stays put so the
      // window is retried, but the attempt timestamp sends the agent to the
      // back of the queue and the streak lengthens its cooldown. After
      // `MAX_FAILURE_STREAK` in a row the window itself is given up — the
      // same transcript failing the same way again is not worth a slot.
      if (!opts.signal?.aborted) {
        const next = readReflectionState(uid);
        const nowIso = new Date(now).toISOString();
        const streak = recordAttempt(next, agentId, nowIso, false);
        if (streak >= MAX_FAILURE_STREAK) {
          next.lastReflectedAt[agentId] = nowIso;
          recordAttempt(next, agentId, nowIso, true);
          log.warn(`reflect ${maskId(agentId)}: ${streak} consecutive failures; giving up this window`);
        }
        writeReflectionState(uid, next);
      }
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

  const scheduleCycle = (delayMs: number, retry = false): void => {
    let deferred = false;
    scheduled = scheduleBootBackground('reflection:cycle', async (signal) => {
      if (stopped || signal?.aborted) return;
      try { await runOneCycle(uid, { ...opts, signal, onDeferred: () => { deferred = true; opts.onDeferred?.(); } }); }
      catch (err) { log.error('cycle threw', { error: logErrorSummary(err) }); }
    }, delayMs, {
      resourceClass: 'model',
      // Inspect busy state once inside runOneCycle; do not wait indefinitely
      // in boot admission, which would bypass the bounded ten-minute retry.
      preferIdle: false,
      // Hang net only. Throttling is `PER_AGENT_TIMEOUT_MS` plus the
      // between-agents idle check: a cycle-wide slice aborts mid-write, and
      // at 30s it could not even seat one real reflection, so it ended cycles
      // after a single agent while reporting the rest as untouched. The net
      // must clear a full cycle of slow agents, or the last ones are cut off
      // on every cycle and never advance: budget the cap × the deadline plus
      // the scan and runner build.
      maxSliceMs: MAX_AGENTS_PER_CYCLE * PER_AGENT_TIMEOUT_MS + 60 * 1000,
    });
    void scheduled.promise.finally(() => {
      scheduled = null;
      if (!stopped) {
        if (deferred && !retry) scheduleCycle(BUSY_RETRY_MS, true);
        else scheduleCycle(CYCLE_INTERVAL_MS);
      }
    });
  };

  // Startup retains its existing trigger; all later attempts use this one chain.
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
