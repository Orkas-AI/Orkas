/**
 * One-shot chat-index cleanup for the pre-tombstone sync bug.
 *
 * Older builds merged `cloud/chats/_index.json` by pure union. If one device
 * deleted `<cid>.jsonl` while another still had the index row, the row could
 * be reintroduced forever as a sidebar ghost. This migration converts stale
 * active index rows whose jsonl is missing (or an old empty placeholder) into
 * record-level `deleted_at` tombstones so the new merge contract can fan the
 * delete out to every device.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userChatsDir, userLocalConfigDir, projectChatsDir, projectChatIndexFile } from '../paths';
import { listProjectIds } from './project-layout';
import { nowIso, safeId, writeJsonSync } from '../storage';
import { createLogger } from '../logger';

const log = createLogger('migrate');

const MIGRATION_TAG = 'chats-index-ghost-tombstones-v2';
const RECENT_MISSING_GRACE_MS = 5 * 60 * 1000;
const EMPTY_FILE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface ChatsGhostCleanupStats {
  scanned: number;
  tombstoned: number;
  alreadyDeleted: number;
  skippedRecent: number;
  warnings: number;
}

function migrationsFile(uid: string): string {
  return path.join(path.dirname(userLocalConfigDir(uid)), '.migrations');
}

function alreadyApplied(uid: string): boolean {
  const f = migrationsFile(uid);
  if (!fs.existsSync(f)) return false;
  try {
    const content = fs.readFileSync(f, 'utf8');
    return content.split('\n').some((line) => line.trim() === MIGRATION_TAG);
  } catch {
    return false;
  }
}

function stamp(uid: string): void {
  const f = migrationsFile(uid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, MIGRATION_TAG + '\n', 'utf8');
}

function tsMs(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function rowAgeMs(row: Record<string, unknown>, nowMs: number): number {
  const last = Math.max(tsMs(row.deleted_at), tsMs(row.updated_at), tsMs(row.created_at));
  return last > 0 ? nowMs - last : Number.POSITIVE_INFINITY;
}

function tombstone(row: Record<string, unknown>, deletedAt: string): void {
  row.deleted_at = deletedAt;
  if (tsMs(row.updated_at) < tsMs(deletedAt)) row.updated_at = deletedAt;
}

export function migrateChatsGhostCleanup(uid: string, nowMs = Date.now()): ChatsGhostCleanupStats {
  const stats: ChatsGhostCleanupStats = {
    scanned: 0,
    tombstoned: 0,
    alreadyDeleted: 0,
    skippedRecent: 0,
    warnings: 0,
  };
  if (alreadyApplied(uid)) return stats;

  const deletedAt = nowIso();
  const roots = [
    { index: path.join(userChatsDir(uid), '_index.json'), dir: userChatsDir(uid) },
    ...listProjectIds(uid).map((pid) => ({ index: projectChatIndexFile(uid, pid), dir: projectChatsDir(uid, pid) })),
  ];
  let foundIndex = false;
  for (const root of roots) {
    const file = root.index;
    if (!fs.existsSync(file)) continue;
    foundIndex = true;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      stats.warnings += 1;
      log.warn(`chat ghost cleanup read/parse failed uid=${uid}: ${(err as Error).message}`);
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    let changed = false;
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const cid = typeof row.conversation_id === 'string' ? row.conversation_id : '';
      if (!safeId(cid)) continue;
      stats.scanned += 1;
      if (typeof row.deleted_at === 'string' && row.deleted_at) {
        stats.alreadyDeleted += 1;
        continue;
      }

      const jsonl = path.join(root.dir, `${cid}.jsonl`);
      let st: fs.Stats | null = null;
      try { st = fs.statSync(jsonl); } catch { /* missing is handled below */ }

      if (!st || !st.isFile()) {
        if (rowAgeMs(row, nowMs) < RECENT_MISSING_GRACE_MS) {
          stats.skippedRecent += 1;
          continue;
        }
        tombstone(row, deletedAt);
        stats.tombstoned += 1;
        changed = true;
        continue;
      }

      if (st.size === 0 && rowAgeMs(row, nowMs) >= EMPTY_FILE_GRACE_MS) {
        tombstone(row, deletedAt);
        stats.tombstoned += 1;
        changed = true;
      }
    }

    if (changed) {
      try {
        writeJsonSync(file, parsed);
        log.info(`chat ghost cleanup uid=${uid} tombstoned=${stats.tombstoned}`);
      } catch (err) {
        stats.warnings += 1;
        log.warn(`chat ghost cleanup write failed uid=${uid}: ${(err as Error).message}`);
      }
    }
  }
  // A first launch can precede the initial cloud pull. Do not consume this
  // one-shot migration until at least one physical index existed, otherwise a
  // later sync can restore the exact ghost rows this pass was meant to clean.
  if (foundIndex) stamp(uid);
  return stats;
}
