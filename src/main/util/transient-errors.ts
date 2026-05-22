/**
 * Shared classifier for "transient network-class error" vs everything else.
 *
 * Two consumers as of 2026-05-20:
 *   - `features/group_chat/plan_executor.ts::maybeRetryTransient` — caps
 *     plan-step retries to network blips, NEVER retries permanent errors
 *     (would mask config / spec / sandbox issues + send the user-facing
 *     failure bubble into a silent retry loop).
 *   - `features/expert_signals/turn_hooks.ts::SkillTurnBuffer.drainAndEmit`
 *     — `skill_ineffective` is only emitted when a turn's errText is
 *     non-transient, so we don't blame skills for network blips.
 *
 * IMPORTANT — never include `aborted` or `cancelled` in this pattern:
 * user-initiated abort must not be silently retried; the literal string
 * `'aborted by user'` is also explicitly excluded by the guard at the
 * caller site (see `plan_executor.ts::maybeRetryTransient`).
 *
 * Pattern is intentionally narrow: undici / fetch / DNS / socket-layer
 * signals only. Spec-missing / LLM gibberish / parse failures / sandbox
 * rejections are all permanent by construction — they don't go away on
 * retry, and they ARE the failures where a loaded skill might have
 * misled the model (the signal that `skill_ineffective` exists to catch).
 */

const TRANSIENT_ERR_PATTERNS = /\b(terminated|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|EPIPE|network error|Connection closed)\b/i;

export function isTransientError(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return TRANSIENT_ERR_PATTERNS.test(reason);
}
