/**
 * Startup-triggered metacognitive reflection.
 *
 * Replaces the old per-turn trigger in `model/core-agent/client.ts`. Runs
 * once shortly after app boot, with a 48-hour per-agent cooldown so we
 * don't reflect on the same agent twice in a session.
 *
 * Flow:
 *   1. Enumerate `_default` (catches all `normal` conversations) + every
 *      custom and builtin agent for the active user.
 *   2. Read `<uid>/local/config/reflection-state.json` for cooldown gates.
 *   3. For each eligible agent (cooldown passed), build a runner bound to
 *      that agent and call `runner.runReflection(periodicReviewPrompt)`.
 *   4. On success, stamp `lastReflectedAt[agentId]` and persist.
 *
 * Iteration is sequential — no point hammering the API in parallel for
 * background work, and reflection per agent already takes single-digit
 * seconds at most.
 */

import * as fs from 'node:fs';
import { userReflectionStateFile, userLocalConfigDir } from '../paths';
import { writeJsonSync } from '../storage';
import { createLogger } from '../logger';
import { listAgents } from './agents';
import * as metacognition from './metacognition';
import { buildAgentReflectionDigest } from './reflection-digest';
import { buildRunner } from '../model/core-agent/runner';

const log = createLogger('reflection-trigger');

export const COOLDOWN_HOURS = 48;
export const STARTUP_DELAY_MS = 30_000;
/** Sentinel agent id covering all `normal` (no-agent) conversations. */
export const DEFAULT_AGENT_ID = '_default';
/** Default digest lookback window for first-ever reflection (no prior stamp). */
export const DEFAULT_LOOKBACK_HOURS = 7 * 24;

export interface ReflectionState {
  /** ISO timestamp per agent id (or `_default`). */
  lastReflectedAt: Record<string, string>;
}

const EMPTY_STATE: ReflectionState = { lastReflectedAt: {} };

// ── State IO ─────────────────────────────────────────────────────────────

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
    // Filter out non-string values defensively.
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
  const file = userReflectionStateFile(uid);
  writeJsonSync(file, state);
}

// ── Eligibility (pure) ───────────────────────────────────────────────────

/**
 * Filter `agentIds` down to those past their cooldown.
 *
 * - Agent never reflected → eligible.
 * - Agent reflected within `cooldownHours` of `now` → skipped.
 * - Stale/invalid timestamp → eligible (defensive).
 */
export function pickEligibleAgents(
  agentIds: string[],
  state: ReflectionState,
  now: number,
  cooldownHours: number = COOLDOWN_HOURS,
): string[] {
  const cooldownMs = cooldownHours * 3600 * 1000;
  const eligible: string[] = [];
  for (const id of agentIds) {
    const lastIso = state.lastReflectedAt[id];
    if (!lastIso) {
      eligible.push(id);
      continue;
    }
    const lastMs = Date.parse(lastIso);
    if (Number.isNaN(lastMs)) {
      eligible.push(id);
      continue;
    }
    if (now - lastMs >= cooldownMs) {
      eligible.push(id);
    }
  }
  return eligible;
}

// ── Reflection invocation ────────────────────────────────────────────────

export type ReflectFn = (uid: string, agentId: string, sinceMs: number) => Promise<void>;

/**
 * Build a runner bound to `agentId` and run a periodic-review reflection.
 * `sinceMs` is the start of the activity window the digest aggregates over
 * (typically the last reflection's timestamp; 7 days back for first-ever).
 * Throws on auth/provider/LLM failure — orchestrator catches per-agent.
 */
async function realReflectForAgent(uid: string, agentId: string, sinceMs: number): Promise<void> {
  // `_default` corresponds to "no agent bound" in the chat layer.
  const runnerAgentId = agentId === DEFAULT_AGENT_ID ? '' : agentId;

  // Disposable session id — the reflection runs in an in-memory Session
  // (created by AgentRunner.runReflection), so the persistent jsonl
  // created by buildRunner stays empty. Acceptable: same pattern as
  // organizer/extract-img kinds (§5).
  const tail = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sessionId = `${uid}-reflect-${tail}`;

  const { runner } = await buildRunner({
    sessionId,
    userId: uid,
    agentId: runnerAgentId,
  });

  // Aggregate recent activity into a markdown digest so the LLM reflects
  // on actual events instead of just rereading its own self-assessment.
  const digest = await buildAgentReflectionDigest(uid, agentId, sinceMs);

  // Build a periodic-review prompt directly — bypasses evaluateReflection's
  // signal-based gating (we're triggered by time, not by metrics).
  const ca = await import('#core-agent');
  const comp = metacognition.readContent(agentId, 'competence');
  const strat = metacognition.readContent(agentId, 'strategies');
  const prompt = ca.buildAdaptiveReviewPrompt(
    'periodic_review',
    comp.content || '',
    strat.content || '',
    undefined,
    digest,
  );

  // `runReflection` swallows provider/LLM/loop-exhaustion errors and returns
  // `''` instead of throwing (see core-agent runner.ts: line 687/745/749).
  // 空串 = 实际什么都没跑成功，不应消耗 48h 冷却。LLM 真的判断"无需改动"
  // 也会回至少一句话的解释（非空），所以 trim 后空白视作失败。具体失败原因
  // 在 core-agent 日志里（log.error / log.warn 都打了），这里抛 generic 错。
  const responseText = await runner.runReflection(prompt);
  if (!responseText || !responseText.trim()) {
    throw new Error('reflection returned empty (provider/LLM error or max loops; see core-agent log)');
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────────

export interface RunStartupReflectionsOpts {
  /** Override the per-agent reflection call (test seam). */
  reflect?: ReflectFn;
  /** Override `Date.now()` for tests. */
  now?: () => number;
  /** Override the cooldown window for tests. */
  cooldownHours?: number;
}

/**
 * Top-level entry. Called once after boot completes (with delay). Safe to
 * call concurrently — each agent's reflection awaits in sequence so the
 * function as a whole serializes naturally.
 */
export async function runStartupReflections(uid: string, opts: RunStartupReflectionsOpts = {}): Promise<void> {
  if (!uid) {
    log.debug('no active uid, skipping startup reflection');
    return;
  }
  if (!metacognition.isFeatureEnabled()) {
    log.debug('metacognition disabled, skipping startup reflection');
    return;
  }
  // Make sure local/config exists for first-boot users so writeReflectionState doesn't race.
  fs.mkdirSync(userLocalConfigDir(uid), { recursive: true });

  const now = (opts.now ?? Date.now)();
  const reflect = opts.reflect ?? realReflectForAgent;
  const cooldownHours = opts.cooldownHours ?? COOLDOWN_HOURS;

  let agents: Awaited<ReturnType<typeof listAgents>> = [];
  try {
    agents = await listAgents();
  } catch (err) {
    log.warn(`listAgents failed: ${(err as Error).message}`);
  }
  // `_default` first so the most common bucket gets attention even if a
  // long agent list later in the loop fails.
  const agentIds = [DEFAULT_AGENT_ID, ...agents.map((a) => a.agent_id)];

  const state = readReflectionState(uid);
  const eligible = pickEligibleAgents(agentIds, state, now, cooldownHours);

  if (eligible.length === 0) {
    log.info(`startup reflection: nothing eligible (${agentIds.length} agents, all within ${cooldownHours}h cooldown)`);
    return;
  }
  log.info(`startup reflection: ${eligible.length}/${agentIds.length} agent(s) eligible`);

  const defaultLookbackMs = DEFAULT_LOOKBACK_HOURS * 3600 * 1000;
  for (const agentId of eligible) {
    // Window for the activity digest: since last reflection, or default
    // lookback for first-ever (so we don't drag in ancient sessions).
    const lastIso = state.lastReflectedAt[agentId];
    const lastMs = lastIso ? Date.parse(lastIso) : NaN;
    const sinceMs = Number.isNaN(lastMs) ? now - defaultLookbackMs : lastMs;

    try {
      await reflect(uid, agentId, sinceMs);
      // Stamp success — read fresh state in case another writer touched it.
      const next = readReflectionState(uid);
      next.lastReflectedAt[agentId] = new Date(now).toISOString();
      writeReflectionState(uid, next);
      log.info(`reflection completed for agent ${agentId}`);
    } catch (err) {
      log.error(`reflection failed for agent ${agentId}: ${(err as Error).message}`);
      // Don't update lastReflectedAt — retry on next startup.
    }
  }
}
