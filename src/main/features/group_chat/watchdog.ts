/**
 * Group-chat watchdog — periodically scans every conversation and pings
 * commander for self-diagnosis when a long task has gone silent.
 *
 * Triggers a ping when ALL of:
 *   - state.json says the conversation is `running` (some worker active or
 *     just finished and waiting on the next dispatch)
 *   - plan.md has at least one `in_progress` step (a long task is in
 *     flight, not a one-shot reply)
 *   - `state.last_active_at` is older than `STALE_THRESHOLD_MS` (default
 *     10 minutes — tunable)
 *
 * Implementation notes:
 *   - **One global interval** for the whole process (not per-cid). Each
 *     tick walks the on-disk index of every uid; cheap because state.json
 *     reads are tiny + we early-bail on idle convs.
 *   - The ping is fire-and-forget into commander's queue (see
 *     `bus.pingCommanderForWatchdog`); commander wakes up, re-reads plan,
 *     decides what to do, replies. If it judges "false positive" it can
 *     stay silent — the ping itself never appears in the group jsonl.
 *   - Threshold + interval are constants here for now; if user feedback
 *     wants UI control later it's a one-line lift to read from
 *     preferences.json.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { WS_ROOT, userChatsDir } from '../../paths';
import { readState } from './state';
import { readPlan } from './plan';
import { pingCommanderForWatchdog } from './bus';
import { createLogger } from '../../logger';

const log = createLogger('group_chat.watchdog');

/** How often the watchdog scans every conv. Cheap (state.json reads) so
 *  60s gives prompt response without flooding the disk. */
const WATCHDOG_INTERVAL_MS = 60_000;

/** Conversation must have been silent at least this long while a plan
 *  step is `in_progress` for the ping to fire. 10 minutes is the
 *  user-facing default; shorter values risk pinging during legit slow
 *  network ops, longer values delay recovery on real stalls. */
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

/** Cooldown between consecutive watchdog pings for the same cid so a
 *  conversation that's genuinely user-paused doesn't get pinged on every
 *  tick. Reset by any new bus enqueue (which bumps last_active_at). */
const PING_COOLDOWN_MS = 5 * 60 * 1000;

let _interval: NodeJS.Timeout | null = null;
const _lastPingedAt = new Map<string, number>(); // `${uid}:${cid}` → ms

interface IndexEntry {
  conversation_id: string;
}

async function _readConvIndex(uid: string): Promise<string[]> {
  const file = path.join(userChatsDir(uid), '_index.json');
  if (!fs.existsSync(file)) return [];
  try {
    const raw = await fsp.readFile(file, 'utf-8');
    const data = JSON.parse(raw);
    const items: IndexEntry[] = Array.isArray(data) ? data
      : (data && Array.isArray(data.items) ? data.items : []);
    return items.map((c) => c.conversation_id).filter((s): s is string => typeof s === 'string');
  } catch (err) {
    log.warn(`read index failed user=${uid}: ${(err as Error).message}`);
    return [];
  }
}

async function _scanUid(uid: string): Promise<void> {
  const cids = await _readConvIndex(uid);
  if (!cids.length) return;
  const now = Date.now();
  for (const cid of cids) {
    let s;
    try { s = await readState(uid, cid); }
    catch { continue; }
    if (s.status !== 'running') continue;
    const lastActive = Date.parse(s.last_active_at);
    if (!Number.isFinite(lastActive)) continue;
    if (now - lastActive < STALE_THRESHOLD_MS) continue;

    const plan = await readPlan(uid, cid);
    if (!plan) continue;
    const inProgress = plan.steps.find((step) => step.status === 'in_progress');
    if (!inProgress) continue;

    const key = `${uid}:${cid}`;
    const prev = _lastPingedAt.get(key) || 0;
    if (now - prev < PING_COOLDOWN_MS) continue;

    const idleMin = Math.round((now - lastActive) / 60_000);
    const reason = `The task has been idle for ${idleMin} minutes with no progress. Current in_progress step: Step ${inProgress.index} "${inProgress.title}"${inProgress.assignee ? ` (assigned to ${inProgress.assignee})` : ''}. Please review the state and decide whether to keep going, confirm with the user, or mark it failed.`;
    try {
      const fired = await pingCommanderForWatchdog(uid, cid, reason);
      if (fired) _lastPingedAt.set(key, now);
    } catch (err) {
      log.warn(`ping failed user=${uid} cid=${cid}: ${(err as Error).message}`);
    }
  }
}

async function _tick(): Promise<void> {
  if (!fs.existsSync(WS_ROOT)) return;
  let entries;
  try { entries = await fsp.readdir(WS_ROOT, { withFileTypes: true }); }
  catch (err) { log.warn(`scan WS_ROOT failed: ${(err as Error).message}`); return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const uid = entry.name;
    // Reject the well-known top-level non-uid dirs early; uid is generated
    // by `genUserId()` (8 digits) so we filter to digit-only strings.
    if (!/^\d{4,16}$/.test(uid)) continue;
    try { await _scanUid(uid); }
    catch (err) { log.warn(`scan failed user=${uid}: ${(err as Error).message}`); }
  }
}

export function startWatchdog(): void {
  if (_interval) return; // already running
  _interval = setInterval(() => {
    _tick().catch((err) => log.warn(`tick threw: ${(err as Error).message}`));
  }, WATCHDOG_INTERVAL_MS);
  // Don't keep the event loop alive on this timer alone — Electron main
  // has other reasons to stay up; the watchdog just rides along.
  if (typeof _interval.unref === 'function') _interval.unref();
  log.info(`watchdog started interval=${WATCHDOG_INTERVAL_MS}ms threshold=${STALE_THRESHOLD_MS}ms`);
}

export function stopWatchdog(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
  _lastPingedAt.clear();
}
