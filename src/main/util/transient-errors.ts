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
 * Pattern is intentionally scoped to provider transport / gateway failures:
 * undici / fetch / DNS / socket-layer signals, stream drops, request/header
 * timeouts, rate-limit throttles, and upstream 5xx families. Spec-missing /
 * LLM gibberish / parse failures / sandbox rejections are all permanent by
 * construction — they don't go away on retry, and they ARE the failures where
 * a loaded skill might have misled the model (the signal that
 * `skill_ineffective` exists to catch).
 */

const TRANSIENT_ERR_PATTERNS =
  /\bcodex sse response headers timed out after \d+ms\b|\bsse response headers timed out\b|\bresponse headers? (timed out|timeout)\b|\bheaders? (timed out|timeout)\b|\brequest timed out\b|\btimed out\b|\btimeout\b|etimedout|und_err_connect_timeout|und_err_headers_timeout|und_err_body_timeout|\bterminated\b|\bfetch failed\b|socket (hang up|closed|close)|websocket (error|closed|close)|\bws (error|closed|close)\b|connection (closed|close|reset|dropped|terminated)|stream (closed|close|interrupted|disconnected|reset|terminated)|premature close|err_stream_premature_close|\b(read )?(econnreset|epipe)\b|\bund_err_socket\b|network.?(error|failure)|enetunreach|enetdown|eai_again|econnrefused|\b(502|503|504|520|521|522|523|524|529|598|599)\b|bad gateway|service unavailable|gateway timeout|overloaded|upstream.?connect|connection.?refused|rate.?limit|too many requests|\b429\b|\b500\b|internal server error/i;

export function isTransientError(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return TRANSIENT_ERR_PATTERNS.test(reason);
}
