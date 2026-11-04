/** Account-bound memory writes for the tool, CLI bridge, IPC and Agent editor.
 * Memory changes only through these explicit edits: a full store refuses
 * growth and the caller (normally the current model) consolidates it with
 * replace/remove. Nothing merges, drops or evicts entries in the background.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { addEntry, removeEntry, replaceEntry, applyMemoryBatch, type MemoryOpResult, type MemoryScope } from './memory';
import { projectMemoryFile, userLocalConfigDir } from '../paths';
import { getActiveUserId } from './users';
import { fileEditLock } from '../util/locks';

interface WriteOptions { signal?: AbortSignal }

function cancelledWrite(): MemoryOpResult {
  // An old IPC/tool reply must not carry the previous account's memory into
  // the newly active account's view.
  return { ok: false, error: 'memory write cancelled', entries: [], usage: { current: 0, limit: 0 } };
}

function write(uid: string, target: MemoryScope, opts: WriteOptions, op: () => MemoryOpResult): Promise<MemoryOpResult> {
  if (opts.signal?.aborted || getActiveUserId() !== uid) return Promise.resolve(cancelledWrite());
  if (typeof target === 'object' && 'project' in target) {
    // A shared reader must close its Windows handle before synchronous atomic
    // replacement. Wait asynchronously; never hold the lock during publication.
    return fileEditLock(projectMemoryFile(uid, target.project)).runExclusive(() => {
      if (opts.signal?.aborted || getActiveUserId() !== uid) return cancelledWrite();
      return op();
    });
  }
  return Promise.resolve(op());
}

export function addMemoryEntry(uid: string, target: MemoryScope, content: string, opts: WriteOptions = {}): Promise<MemoryOpResult> {
  return write(uid, target, opts, () => addEntry(uid, target, content));
}

export function replaceMemoryEntry(
  uid: string, target: MemoryScope, oldText: string, content: string, opts: WriteOptions = {},
): Promise<MemoryOpResult> {
  return write(uid, target, opts, () => replaceEntry(uid, target, oldText, content));
}

export function removeMemoryEntry(uid: string, target: MemoryScope, oldText: string, opts: WriteOptions = {}): Promise<MemoryOpResult> {
  return write(uid, target, opts, () => removeEntry(uid, target, oldText));
}

export async function batchMemoryEntries(
  uid: string, target: MemoryScope, expectedRevision: unknown, operations: unknown, opts: WriteOptions = {},
): Promise<MemoryOpResult> {
  const active = () => !opts.signal?.aborted && getActiveUserId() === uid;
  if (!active()) return cancelledWrite();
  const commit = () => active() ? applyMemoryBatch(uid, target, expectedRevision, operations, active) : cancelledWrite();
  const saved = typeof target === 'object' && 'project' in target
    ? await fileEditLock(projectMemoryFile(uid, target.project)).runExclusive(commit)
    : commit();
  if (getActiveUserId() !== uid) return cancelledWrite();
  // A no-op batch has nothing to publish. Existing single saves retain their
  // explicit offline-publication retry behavior.
  return saved;
}

/** Delete the local state of the retired automatic maintenance: its schedule
 *  file and recovery copies (private memory text). Canonical memory is untouched. */
export async function removeRetiredMemoryMaintenanceState(uid: string): Promise<void> {
  const root = userLocalConfigDir(uid);
  await fs.promises.rm(path.join(root, 'memory-backups'), { recursive: true, force: true });
  await fs.promises.rm(path.join(root, 'memory-maintenance.json'), { force: true });
}
