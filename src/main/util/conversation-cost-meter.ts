/**
 * Per-conversation cumulative token meter — a coarse cost BACKSTOP, not a
 * budget allocator.
 *
 * The turn-count guards (`MAX_WORKER_TURNS`, the identical-turn hard stop) bound
 * how many turns a runtime takes, but not the COST of a task: one user request
 * can fan out to many nested agent turns, each burning a large context, and a
 * near-duplicate spin can churn turns that each cost real tokens. This meter
 * adds one number — cumulative in+out tokens for the current task — so the
 * worker loop can hard-stop a task that has burned an unreasonable amount before
 * starting the next turn. It deliberately does NOT allocate per-agent budgets or
 * price by model; it only catches the pathological "this single task burned a
 * huge amount" case.
 *
 * Accumulation happens at the model-run chokepoint (model/core-agent/client.ts),
 * the only place that sees EVERY run — top-level, commander, agents, and the
 * in-process nested/anonymous workers. Reset happens on each new USER message (a
 * fresh task gets a fresh allowance). Lives in util/ so both the model layer
 * (recorder) and the group-chat feature (enforcer) can use it without a
 * dependency-direction violation. Pure in-memory; nothing is persisted.
 */

/** Default per-task ceiling (input+output tokens). Generous on purpose — far
 *  above any normal heavy task (deep research, video), so it only trips on a
 *  runaway. Override with ORKAS_MAX_TASK_TOKENS (0 or negative disables). */
const DEFAULT_MAX_TASK_TOKENS = 25_000_000;

function resolveMaxTaskTokens(): number {
  const raw = process.env.ORKAS_MAX_TASK_TOKENS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_TASK_TOKENS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_TASK_TOKENS;
  return n; // <= 0 disables the backstop (checked in isOverTaskBudget)
}

// cid → cumulative in+out tokens for the current task.
const _taskTokens = new Map<string, number>();

/** Record one model run's token usage against a conversation's current task.
 *  No-op without a cid (anonymous/reflection/memory sessions that don't belong
 *  to a user conversation). Uses input+output as the cost proxy: cache-read
 *  tokens are ~10% the price, so excluding them keeps the meter aligned with
 *  real spend without per-model pricing. */
export function recordUsageTokens(cid: string | undefined, usage: {
  inputTokens?: number; outputTokens?: number; totalTokens?: number;
} | undefined): void {
  if (!cid || !usage) return;
  const total = Number.isFinite(usage.totalTokens)
    ? Number(usage.totalTokens)
    : (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0);
  if (!(total > 0)) return;
  _taskTokens.set(cid, (_taskTokens.get(cid) || 0) + total);
}

/** Cumulative in+out tokens for a conversation's current task. */
export function taskTokens(cid: string): number {
  return _taskTokens.get(cid) || 0;
}

/** Clear a conversation's task meter — call when a new user message starts a
 *  fresh task, and when the conversation is torn down. */
export function resetTaskTokens(cid: string): void {
  _taskTokens.delete(cid);
}

/** True iff the conversation's current task has burned past the backstop
 *  ceiling. Always false when the ceiling is disabled (<= 0). */
export function isOverTaskBudget(cid: string): boolean {
  const max = resolveMaxTaskTokens();
  if (max <= 0) return false;
  return taskTokens(cid) >= max;
}

/** Current ceiling (for logging / tests). */
export function maxTaskTokens(): number {
  return resolveMaxTaskTokens();
}
