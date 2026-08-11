import type { ActorKind } from './state';

/**
 * Per-turn runtime budgets for dispatched actors, kept out of bus.ts so they
 * are unit-testable and cannot silently drift.
 *
 * core-agent's schema default is currently 100 (config/schema.ts). Named agent
 * workers (VideoStudio, DeepResearcher) pin that same production budget here so
 * a future schema-default change cannot silently shorten their gate-bounded,
 * tool-heavy turns. The commander gets a larger orchestration budget because it
 * may coordinate several such workflows. Graceful wrap-up at the cap,
 * loop_detection, and the 30-min idle watchdog still bound true runaways.
 * Ephemeral workers ('worker') continue to follow the schema default.
 */
export const COMMANDER_MAX_TOOL_LOOPS = 120;
export const AGENT_MAX_TOOL_LOOPS = 100;
export const OFFICE_WORKER_AGENT_ID = 'a19101ba698a';
export const OFFICE_WORKER_ELAPSED_CONVERGENCE_MS = 3 * 60 * 1000;

/**
 * Per-turn tool-round budget for a dispatched actor, or `undefined` to let
 * core-agent apply its schema default. Pure — pinned by unit tests so the
 * named-agent budget cannot silently drift with the schema default.
 */
export function maxToolLoopsForActorKind(kind: ActorKind): number | undefined {
  if (kind === 'commander') return COMMANDER_MAX_TOOL_LOOPS;
  if (kind === 'agent') return AGENT_MAX_TOOL_LOOPS;
  return undefined; // 'worker' (ephemeral) / 'user' → schema default
}

/**
 * Optional actor-specific threshold for the runner's one-time elapsed
 * convergence reminder. This is deliberately a soft control: it asks the model
 * to finish the smallest valid deliverable, but does not stop the turn or lower
 * its hard tool-loop budget.
 */
export function elapsedConvergenceMsForActor(
  kind: ActorKind,
  actorId: string,
): number | undefined {
  if (kind === 'agent' && actorId === OFFICE_WORKER_AGENT_ID) {
    return OFFICE_WORKER_ELAPSED_CONVERGENCE_MS;
  }
  return undefined;
}
