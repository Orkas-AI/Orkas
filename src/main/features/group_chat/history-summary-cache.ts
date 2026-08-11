/**
 * Conversation-level rolling-history summary cache.
 *
 * Canonical group dialogue is shared, while each Commander / named Agent has
 * an independent execution Session. This cache lets those Sessions reuse one
 * model-produced summary after they independently reach the normal compaction
 * threshold. Active checkpoints, tool resources, plans, and private facts are
 * never stored here.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex, type MutexInterface } from 'async-mutex';
import type {
  SharedHistorySummaryCache,
  SharedHistorySummaryCheckpoint,
} from '#core-agent';
import { readJson, readJsonl, safeId, writeJson } from '../../storage';
import { userLocalCacheDir } from '../../paths';
import { conversationMessageReadFile } from '../../util/project-layout';
import type { GroupMessage } from './visibility';

type StoredHistorySummaryV1 = SharedHistorySummaryCheckpoint & {
  version: 1;
  source: string;
  canonicalFileIdentity: string;
  updatedAt: number;
};

const locks = new Map<string, MutexInterface>();

function cacheLock(uid: string, cid: string): MutexInterface {
  const key = `${uid}\0${cid}`;
  let lock = locks.get(key);
  if (!lock) {
    lock = new Mutex();
    locks.set(key, lock);
  }
  return lock;
}

function cacheFile(uid: string, cid: string): string {
  return path.join(userLocalCacheDir(uid), 'conversation-history-summaries', `${cid}.json`);
}

function canonicalFileIdentity(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return '';
  }
}

function abortError(): Error {
  const error = new Error('history summary cache wait aborted');
  error.name = 'AbortError';
  return error;
}

async function acquireAbortable(
  lock: MutexInterface,
  signal?: AbortSignal,
): Promise<() => void> {
  if (!signal) return lock.acquire();
  if (signal.aborted) throw abortError();
  const pending = lock.acquire();
  const aborted = Symbol('aborted');
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<typeof aborted>((resolve) => {
    onAbort = () => resolve(aborted);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const result = await Promise.race([pending, abortPromise]);
  if (onAbort) signal.removeEventListener('abort', onAbort);
  if (result === aborted) {
    pending.then((release) => release()).catch(() => {});
    throw abortError();
  }
  return result;
}

function validStoredSummary(value: unknown, source: string): value is StoredHistorySummaryV1 {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StoredHistorySummaryV1>;
  return item.version === 1
    && item.source === source
    && typeof item.summary === 'string'
    && item.summary.trim().length > 0
    && item.summary.length <= 1_000_000
    && Number.isSafeInteger(item.throughTurnId)
    && (item.throughTurnId ?? 0) > 0
    && typeof item.throughMessageId === 'string'
    && safeId(item.throughMessageId)
    && typeof item.canonicalFileIdentity === 'string';
}

async function canonicalBoundary(
  uid: string,
  cid: string,
  throughTurnId: number,
): Promise<{ messageId: string; fileIdentity: string } | null> {
  if (!Number.isSafeInteger(throughTurnId) || throughTurnId < 1) return null;
  const file = conversationMessageReadFile(uid, cid);
  const identityBefore = canonicalFileIdentity(file);
  if (!identityBefore) return null;
  const rows = await readJsonl<GroupMessage>(file, 100_000);
  const identityAfter = canonicalFileIdentity(file);
  if (!identityAfter || identityAfter !== identityBefore) return null;
  const boundary = rows.filter((row) => row.from === 'user')[throughTurnId - 1];
  if (!boundary || boundary.deleted_at || !safeId(boundary.id)) return null;
  return { messageId: boundary.id, fileIdentity: identityAfter };
}

/** Build a local, derived cache for one canonical group conversation. */
export function createConversationHistorySummaryCache(input: {
  uid: string;
  cid: string;
  source: string;
}): SharedHistorySummaryCache | null {
  const { uid, cid, source } = input;
  if (!uid || !safeId(cid) || source !== `group-main-v1:${cid}`) return null;
  const file = cacheFile(uid, cid);
  const lock = cacheLock(uid, cid);
  return {
    source,
    acquire: (signal) => acquireAbortable(lock, signal),
    async read() {
      const stored = await readJson<unknown>(file);
      if (!validStoredSummary(stored, source)) return null;
      const boundary = await canonicalBoundary(uid, cid, stored.throughTurnId);
      if (
        !boundary
        || boundary.messageId !== stored.throughMessageId
        || boundary.fileIdentity !== stored.canonicalFileIdentity
      ) {
        return null;
      }
      return {
        summary: stored.summary,
        throughTurnId: stored.throughTurnId,
        throughMessageId: stored.throughMessageId,
      };
    },
    async write(value) {
      if (!value.summary.trim()) throw new Error('shared history summary is empty');
      if (value.summary.length > 1_000_000) {
        throw new Error('shared history summary is too large');
      }
      const boundary = await canonicalBoundary(uid, cid, value.throughTurnId);
      if (!boundary) throw new Error('shared history summary boundary is unavailable');
      const stored: StoredHistorySummaryV1 = {
        version: 1,
        source,
        summary: value.summary.trim(),
        throughTurnId: value.throughTurnId,
        throughMessageId: boundary.messageId,
        canonicalFileIdentity: boundary.fileIdentity,
        updatedAt: Date.now(),
      };
      await writeJson(file, stored);
      return {
        summary: stored.summary,
        throughTurnId: stored.throughTurnId,
        throughMessageId: stored.throughMessageId,
      };
    },
  };
}

/** Invalidate the derived summary after canonical history is edited/deleted. */
export async function clearConversationHistorySummary(
  uid: string,
  cid: string,
): Promise<void> {
  if (!uid || !safeId(cid)) return;
  const lock = cacheLock(uid, cid);
  await lock.runExclusive(async () => {
    await fsp.rm(cacheFile(uid, cid), { force: true });
  });
}
