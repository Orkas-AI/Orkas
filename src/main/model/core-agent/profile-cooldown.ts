/**
 * In-process cooldown map for auth-profiles whose key hit a credential/account
 * failure (401 / 403 / 429 / 402 — see `auth-error.ts::classifyKeyFailure`).
 *
 * When a profile fails with a key-specific error:
 *   1. `rotating-provider.ts` marks the profile cooled-down here.
 *   2. `features/auth.ts::pickChatEntry` / `pickChatEntryGroup` skip
 *      cooled-down profiles so subsequent requests don't even try them.
 *   3. `features/auth.ts::addApiKey` / successful `testConnection` clear
 *      the cooldown — user intervention wins over auto-cooldown.
 *
 * State is in-memory only (process-local). Restart resets everything. We
 * don't persist because:
 *   - Cooldown is a short-horizon hint (10 min), not a durable decision.
 *   - Avoid disk I/O on every failure path.
 *   - A fresh process is a reasonable moment to re-probe.
 */

import { createLogger } from '../../logger';
import type { KeyFailureKind } from './auth-error';

const log = createLogger('auth-cooldown');

/** Default cooldown duration: 10 minutes. Tests override via parameter. */
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

interface CooldownEntry {
  cooledUntil: number;
  kind: Exclude<KeyFailureKind, 'network'>;
  reason: string;
}

const state = new Map<string, CooldownEntry>();

/** For tests / forced resets (e.g. on uid switch). */
export function _clearAll(): void {
  state.clear();
}

/**
 * Mark a profile as cooled-down. `durationMs` overridable for testing;
 * defaults to 10 min. Subsequent calls on the same profileId replace the
 * entry (fresh cooldown window starts from now).
 */
export function markCooldown(
  profileId: string,
  kind: KeyFailureKind,
  reason: string,
  durationMs?: number,
): void {
  if (!profileId) return;
  if (kind === 'network') {
    log.info(`skip cooldown profile=${profileId} kind=network reason=${reason.slice(0, 120)}`);
    return;
  }
  const ms = durationMs ?? DEFAULT_COOLDOWN_MS;
  const cooledUntil = Date.now() + Math.max(0, ms);
  state.set(profileId, { cooledUntil, kind, reason });
  log.info(`cooldown profile=${profileId} kind=${kind} ms=${ms} reason=${reason.slice(0, 120)}`);
}

/**
 * True if the profile is currently cooled down. Expired entries are
 * lazily swept on read, so long-lived processes don't leak entries.
 */
export function isCooledDown(profileId: string): boolean {
  if (!profileId) return false;
  const entry = state.get(profileId);
  if (!entry) return false;
  if (Date.now() >= entry.cooledUntil) {
    state.delete(profileId);
    return false;
  }
  return true;
}

/** Inspect the current cooldown entry (or undefined). Used by diagnostics. */
export function getCooldown(profileId: string): Readonly<CooldownEntry> | undefined {
  const entry = state.get(profileId);
  if (!entry) return undefined;
  if (Date.now() >= entry.cooledUntil) {
    state.delete(profileId);
    return undefined;
  }
  return entry;
}

/**
 * Remove a profile from cooldown. Called when the user edits the key or
 * a successful testConnection runs — their manual intervention overrides
 * the auto-cooldown.
 */
export function clearCooldown(profileId: string): void {
  if (!profileId) return;
  if (state.delete(profileId)) {
    log.info(`cleared cooldown profile=${profileId}`);
  }
}

/** List cooled-down profile ids + metadata (sorted by cooledUntil asc). */
export function listCooldowns(): { profileId: string; cooledUntil: number; kind: Exclude<KeyFailureKind, 'network'>; reason: string }[] {
  const now = Date.now();
  const out: { profileId: string; cooledUntil: number; kind: Exclude<KeyFailureKind, 'network'>; reason: string }[] = [];
  for (const [pid, entry] of state) {
    if (now >= entry.cooledUntil) {
      state.delete(pid);
      continue;
    }
    out.push({ profileId: pid, ...entry });
  }
  out.sort((a, b) => a.cooledUntil - b.cooledUntil);
  return out;
}
