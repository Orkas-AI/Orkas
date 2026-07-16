/**
 * Reflection orchestrator — the single trigger for metacognitive reflection.
 *
 * Replaces the old startup-only `reflection-trigger.ts` and the per-turn
 * `runner.evaluateReflection` path. Per `Common/docs/plans/reflection-redesign.md`:
 *
 *   - One scheduler: fire after the measured startup window (offset via
 *     util/boot_init.ts) and every `CYCLE_INTERVAL_MS` thereafter via a
 *     setTimeout chain.
 *   - Per-agent gating: 4h min cooldown, dirty gate (signals.jsonl or
 *     session jsonl newer than lastReflectedAt), 7-day max-gap fallback.
 *   - Per-cycle cap: at most `MAX_AGENTS_PER_CYCLE`; eligible-but-deferred
 *     agents wait for the next cycle (no agents lost).
 *   - Sequential execution; failures isolate per-agent and don't advance
 *     `lastReflectedAt`, so the next cycle retries.
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
import { querySignals } from './expert_signals';
import { buildRunner } from '../model/core-agent/runner';
import { cloudSessionFileFor } from '../util/project-layout';
import { getLanguage } from './config';
import { getLocaleMeta } from '../i18n';
import { scheduleBootBackground, type ScheduledBootBackgroundTask } from '../util/boot_init';

const log = createLogger('reflection-orchestrator');

// ── Constants (per plan §2.1) ────────────────────────────────────────────

/** Interval between cycles after the first. */
export const CYCLE_INTERVAL_MS = 12 * 3600 * 1000;
/** Minimum gap between reflections for the same agent (anti-thrash). */
export const MIN_COOLDOWN_MS = 4 * 3600 * 1000;
/** Maximum gap — force a sanity reflection even when no signals/activity. */
export const MAX_GAP_MS = 7 * 24 * 3600 * 1000;
/** Default initial lookback window for never-reflected agents. */
export const DEFAULT_LOOKBACK_MS = 48 * 3600 * 1000;
/** Per-cycle agent cap — defer overflow to next cycle. */
export const MAX_AGENTS_PER_CYCLE = 5;
/** Sentinel agent id covering all `normal` (no-agent-bound) conversations. */
export const DEFAULT_AGENT_ID = '_default';

// ── State IO (kept compatible with old reflection-state.json) ────────────

export interface ReflectionState {
  /** ISO timestamp per agent id (or `_default`). */
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
  reason: 'dirty' | 'max_gap' | 'never_reflected';
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

    if (hasLast && now - lastMs >= MAX_GAP_MS) {
      out.push({ agentId: id, sinceMs: lastMs, reason: 'max_gap' });
      continue;
    }

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
    const sigs = await querySignals({
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

export type ReflectFn = (uid: string, agentId: string, sinceMs: number) => Promise<void>;

/** Build the reflection prompt for one agent and run it. Throws on failure
 *  so the caller can decide whether to stamp `lastReflectedAt` (success)
 *  or leave it (retry next cycle). */
async function realReflectForAgent(uid: string, agentId: string, sinceMs: number): Promise<void> {
  const runnerAgentId = agentId === DEFAULT_AGENT_ID ? '' : agentId;

  // Ephemeral session — runReflection uses an in-memory session (not the
  // jsonl) so this id is just a label for the LLM-archive devtools.
  const tail = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sessionId = `reflect-${tail}`;

  const { runner } = await buildRunner({ sessionId, userId: uid, agentId: runnerAgentId });

  const transcriptResult = await buildTranscript(uid, agentId, sinceMs);
  if (!transcriptResult.text) {
    // Dirty gate said yes but transcript came back empty (race / sweep / etc.).
    // Skip without stamping — next cycle's dirty check decides again.
    log.info(`reflect ${agentId}: transcript empty (considered=${transcriptResult.stats.convsConsidered}), skipping`);
    throw new Error('transcript empty after dirty gate');
  }

  const ca = await import('#core-agent');
  const comp = metacognition.readContent(agentId, 'competence');
  const strat = metacognition.readContent(agentId, 'strategies');
  const languageName = getLocaleMeta(getLanguage()).llmName;
  const prompt = ca.buildReviewPrompt(comp.content || '', strat.content || '', transcriptResult.text, languageName);

  // `runReflection` swallows provider/LLM/loop errors and returns ''; an
  // empty response is treated as a failed reflection (cooldown not stamped).
  const responseText = await runner.runReflection(prompt);
  if (!responseText || !responseText.trim()) {
    throw new Error('reflection returned empty (provider/LLM error or max loops; see core-agent log)');
  }

  log.info(`reflect ${agentId}: ok (transcript ${transcriptResult.stats.convsIncluded}/${transcriptResult.stats.convsConsidered} convs, ~${transcriptResult.stats.estimatedTokens} tokens)`);
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
  if (!metacognition.isFeatureEnabled()) {
    log.debug('metacognition disabled, skipping cycle');
    return 0;
  }
  fs.mkdirSync(userLocalConfigDir(uid), { recursive: true });

  const now = (opts.now ?? Date.now)();
  const reflect = opts.reflect ?? realReflectForAgent;
  const dirtyFn = opts.isDirty ?? isAgentDirty;

  let agents: Awaited<ReturnType<typeof listAgents>> = [];
  try { agents = await listAgents(); }
  catch (err) { log.warn(`listAgents failed: ${(err as Error).message}`); }

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
  for (const { agentId, sinceMs, reason } of eligible) {
    if (opts.signal?.aborted) break;
    try {
      await reflect(uid, agentId, sinceMs);
      // Stamp success — read fresh state in case another writer touched it.
      const next = readReflectionState(uid);
      next.lastReflectedAt[agentId] = new Date(now).toISOString();
      writeReflectionState(uid, next);
      completed += 1;
      log.info(`reflect ${agentId}: completed (${reason})`);
    } catch (err) {
      log.warn(`reflect ${agentId}: failed (${reason}): ${(err as Error).message}`);
    }
  }
  log.info(`cycle end: ${completed}/${eligible.length} agent(s) completed`);
  return completed;
}

// ── Loop control ─────────────────────────────────────────────────────────

export interface LoopHandle {
  /** Cancel the next scheduled cycle. Any in-flight cycle continues to
   *  completion (no preemption). */
  stop(): void;
}

/** Start the reflection loop: run one cycle now, then every
 *  `CYCLE_INTERVAL_MS` until stopped. The boot path itself is offset beyond
 *  startup by util/boot_init.ts before it calls this function. */
export function startReflectionLoop(uid: string, opts: RunCycleOpts = {}): LoopHandle {
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
      maxSliceMs: 30_000,
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
