/** Real cleanup, task-board scheduling/storage, archive/delete/restore.
 * The bus boundary settles a synthetic live execution without a model request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

const bus = vi.hoisted(() => ({ quiet: false, abort: vi.fn() }));
const logs = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../src/main/features/group_chat/bus', () => ({
  abort: (...args: any[]) => bus.abort(...args),
  isQuiescent: () => bus.quiet,
  dropConv: vi.fn(async () => {}),
  // The real archive/restore dependencies import the facade's event exports;
  // no event admission is part of this filesystem persistence scenario.
  subscribe: vi.fn(() => { throw new Error('Unexpected bus subscription'); }),
  submitCliAsyncInput: vi.fn(() => { throw new Error('Unexpected CLI input'); }),
  subscribeTaskTerminals: vi.fn(() => { throw new Error('Unexpected task subscription'); }),
}));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => logs }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const uid = 'cleanup-board-user';
const cid = 'selected-history';
const old = '2020-01-01T00:00:00Z';
let root: string;
let previousRoot: string | undefined;
let releaseAll: Array<() => void> = [];
let pendingRemovals: Promise<unknown>[] = [];
function tracked<T>(pending: Promise<T>): Promise<T> { pendingRemovals.push(pending); return pending; }

beforeEach(async () => {
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  root = '';
  releaseAll = []; pendingRemovals = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cleanup-board-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules(); vi.clearAllMocks(); bus.quiet = false; releaseAll = []; pendingRemovals = [];
  const users = await import('../../../src/main/features/users');
  users.activateUser(uid);
  (await import('../../../src/main/features/group_chat/task_board'))._resetForTest();
});
afterEach(async () => {
  const failures: unknown[] = [];
  const attempt = async (operation: () => unknown | Promise<unknown>) => {
    try { await operation(); } catch (error) { failures.push(error); }
  };
  try {
    // Release every controlled writer first, including a failed/unrelated
    // branch. A failing test must never leave cleanup waiting on its gate.
    for (const release of releaseAll) await attempt(release);
    await attempt(() => Promise.allSettled(pendingRemovals));
    await attempt(async () => {
      const board = await import('../../../src/main/features/group_chat/task_board');
      try { await board.flushBoards(); }
      finally { board._resetForTest(); }
    });
  } finally {
    // Failure to flush or import an owner cannot skip resource/environment
    // restoration. Keep all failures, including independent log failures.
    await attempt(() => vi.restoreAllMocks());
    await attempt(() => syncBuiltinESMExports());
    try {
      await attempt(() => drainMainRuntimeForTest());
    } finally {
      if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
      else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
      if (root) await attempt(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    }
  }
  // There are no expected WARN/ERROR events in these scenarios. The synthetic
  // bus owns no provider stream, so the original E2E's abort warnings do not
  // apply here. Inspect all captured messages if either independent gate fails.
  await attempt(() => expect(logs.error.mock.calls, 'Unexpected captured main-process errors').toEqual([]));
  await attempt(() => expect(logs.warn.mock.calls, 'Unreviewed captured main-process warnings').toEqual([]));
  if (failures.length) throw new AggregateError(failures, 'Cleanup persistence case teardown or captured logs failed');
});

async function seed() {
  const chats = await import('../../../src/main/features/chats');
  const board = await import('../../../src/main/features/group_chat/task_board');
  const { conversationLayout } = await import('../../../src/main/util/project-layout');
  const created = await chats.createConversation(uid, { conversationId: cid, title: 'History to recycle' });
  expect(created).toMatchObject({ conversation_id: cid, kind: 'normal' });
  const layout = conversationLayout(uid, cid);
  const tasksFile = path.join(layout.groupDir, 'tasks.json');
  const task = await board.createTask(uid, cid, {
    assignee: 'commander', createdBy: 'user', running: true,
    instruction: 'Keep this stopped history recoverable', sourceMsgId: 'original-input',
  });
  await board.flushBoards();
  fs.writeFileSync(layout.stateFile, JSON.stringify({ status: 'running', in_flight: ['commander'], last_active_at: old }));
  fs.writeFileSync(layout.messageFile, JSON.stringify({
    id: 'original-input', from: 'user', to: ['commander'], text: 'Keep this stopped history recoverable', ts: old,
  }) + '\n');
  // Match the live E2E fixture: age persisted data while the real in-memory
  // task stays live. No model response or expected terminal is injected.
  for (const file of [path.join(path.dirname(layout.groupDir), '_index.json'), path.join(layout.groupDir, 'meta.json'), tasksFile]) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const row of Array.isArray(data) ? data : [data]) {
      if (row.conversation_id && row.conversation_id !== cid) continue;
      for (const key of ['created_at', 'updated_at', 'last_active_at', 'started_at', 'ended_at']) if (row[key]) row[key] = old;
    }
    fs.writeFileSync(file, JSON.stringify(data));
  }
  chats.invalidateConversationCaches(uid);
  return { chats, board, layout, tasksFile, task };
}

/** Hold a real atomic writer after its tmp bytes exist but before publication.
 * This is the same existing filesystem seam used by task-board.test.ts.
 * No scheduler/board mutation is replaced.
 */
async function arrangeDeferredStop(unrelated = false) {
  const seeded = await seed();
  const { board, layout, tasksFile, task } = seeded;
  const state = await import('../../../src/main/features/group_chat/state');
  const cleanup = await import('../../../src/main/features/task_cleanup');
  const recycle = await import('../../../src/main/features/recycle_bin');
  const { isAtomicWriteTempPath } = await import('../../../src/main/storage');
  const preview = await cleanup.preview(uid, { days: 30 });
  expect(preview.rows).toEqual([expect.objectContaining({ cid, selectable: true, blocked: 'busy' })]);
  const targetWritten = deferred(), targetRelease = deferred();
  const unrelatedWritten = deferred(), unrelatedRelease = deferred();
  const broadFlush = deferred();
  releaseAll.push(targetRelease.resolve, unrelatedRelease.resolve);
  const trace: string[] = [];
  let armed = false, stopReturned = false, targetPublished = false, otherPublished = false;
  const otherFile = path.join(path.dirname(layout.groupDir), 'unrelated-history', 'tasks.json');
  const writeFile = fs.promises.writeFile.bind(fs.promises);
  vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
    await writeFile(...args);
    const file = String(args[0]);
    if (armed && file.startsWith(tasksFile + '.') && isAtomicWriteTempPath(file)) {
      trace.push('selected terminal tmp bytes ready'); targetWritten.resolve();
      await targetRelease.promise;
    }
    if (unrelated && file.startsWith(otherFile + '.') && isAtomicWriteTempPath(file)) {
      unrelatedWritten.resolve(); await unrelatedRelease.promise;
    }
  });
  const renameSync = fs.renameSync.bind(fs);
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    renameSync(from, to);
    if (armed && String(to) === tasksFile && isAtomicWriteTempPath(String(from))) { targetPublished = true; trace.push('selected terminal snapshot published'); }
    if (String(to) === otherFile && isAtomicWriteTempPath(String(from))) otherPublished = true;
  });
  const flush = board.flushBoards.bind(board);
  // Release the controlled writer if the cleanup requests its existing owner
  // barrier. This hook only controls I/O completion, never supplies a result.
  // The proposed optional selector must preserve default all-board behavior.
  vi.spyOn(board, 'flushBoards').mockImplementation(async (...args: any[]) => {
    if (stopReturned) {
      targetRelease.resolve();
      const scope = args[0];
      if (unrelated && (!scope || scope.uid !== uid || scope.cid !== cid)) broadFlush.resolve();
    }
    await (flush as any)(...args);
  });
  const stat = fs.promises.stat.bind(fs.promises);
  vi.spyOn(fs.promises, 'stat').mockImplementation((async (...args: any[]) => {
    const captured = await (stat as any)(...args);
    if (armed && stopReturned && String(args[0]) === tasksFile && !targetPublished) {
      // Valid concurrent schedule: the first receipt has already read old
      // metadata when the actual end-of-tick terminal write is published.
      trace.push('receipt sampled unpublished selected snapshot ' + JSON.stringify({ size: captured.size, mtimeMs: captured.mtimeMs, ctimeMs: captured.ctimeMs }));
      if (unrelated) broadFlush.resolve();
      targetRelease.resolve();
      await (flush as any)({ uid, cid });
      const published = await (stat as any)(...args);
      trace.push('published selected snapshot ' + JSON.stringify({ size: published.size, mtimeMs: published.mtimeMs, ctimeMs: published.ctimeMs }));
      return captured;
    }
    return captured;
  }) as any);
  syncBuiltinESMExports();
  if (unrelated) {
    await board.createTask(uid, 'unrelated-history', {
      assignee: 'agent-other', createdBy: 'user', running: true, instruction: 'Unrelated live work',
    });
    // The unrelated writer is deliberately still blocked when cleanup ends.
    await unrelatedWritten.promise;
  }
  bus.abort.mockImplementation(async () => {
    await state.setStatus(uid, cid, 'aborted');
    armed = true;
    await board.finishTask(uid, cid, task.task_id, 'cancelled');
    // Real scheduleFlush has started its writer, but it is not durable yet.
    await targetWritten.promise;
    bus.quiet = true; stopReturned = true; trace.push('Stop returned with terminal write pending');
  });
  const originalText = fs.readFileSync(layout.messageFile, 'utf8');
  return { ...seeded, cleanup, recycle, preview, originalText, trace, broadFlush,
    targetPublished: () => targetPublished, otherPublished: () => otherPublished };
}

describe('historical cleanup after deferred task-board persistence', () => {
  it('recycles only after its stopped task is durable and restores the original history and cancelled run', async () => {
    const s = await arrangeDeferredStop();
    // Baseline should fail here with skipped: its own Stop write changes the
    // revision between initial receipt and canDelete. Preserve that failure.
    expect(await tracked(s.cleanup.remove(uid, s.preview.token, cid)), JSON.stringify(s.trace)).toEqual({ status: 'deleted' });
    expect(s.targetPublished()).toBe(true);
    expect(fs.existsSync(s.layout.messageFile)).toBe(false);
    expect(await s.chats.getConversationMetadata(uid, cid)).toBeNull();
    const [batch] = await s.recycle.listRecycleBatches(uid);
    expect(batch.items.map(item => item.path)).toContain(`cloud/chats/${cid}/tasks.json`);
    const restored = await s.recycle.restoreRecycleBatch(uid, batch.id);
    expect(restored.batch?.id).toBe(batch.id);
    expect(restored.failed_paths).toEqual([]);
    expect(restored.restored_paths).toContain(`cloud/chats/${cid}.jsonl`);
    expect(fs.readFileSync(s.layout.messageFile, 'utf8')).toBe(s.originalText);
    expect(JSON.parse(fs.readFileSync(s.tasksFile, 'utf8'))).toEqual([
      expect.objectContaining({ task_id: s.task.task_id, status: 'cancelled', source_msg_id: 'original-input' }),
    ]);
    s.chats.invalidateConversationCaches(uid);
    expect(await s.chats.getConversationMetadata(uid, cid)).toMatchObject({ conversation_id: cid, title: 'History to recycle' });
    expect(bus.quiet).toBe(true);
  });

  it('preserves history and discards its backup if another task snapshot is written after the completed Stop', async () => {
    const s = await arrangeDeferredStop();
    const archive = s.recycle.createAppRecycleBatchForConversation.bind(s.recycle);
    vi.spyOn(s.recycle, 'createAppRecycleBatchForConversation').mockImplementation(async (...args) => {
      const receipt = await archive(...args);
      const rows = JSON.parse(fs.readFileSync(s.tasksFile, 'utf8'));
      rows[0].instruction = 'External change after Stop and during backup';
      fs.writeFileSync(s.tasksFile, JSON.stringify(rows));
      return receipt;
    });
    expect(await tracked(s.cleanup.remove(uid, s.preview.token, cid))).toEqual({ status: 'skipped' });
    // The archive must have really occurred before this external-change guard
    // can pass; otherwise the baseline's earlier false skip could mask it.
    expect(s.recycle.createAppRecycleBatchForConversation).toHaveBeenCalledOnce();
    expect(fs.readFileSync(s.layout.messageFile, 'utf8')).toBe(s.originalText);
    expect(JSON.parse(fs.readFileSync(s.tasksFile, 'utf8'))[0].instruction).toBe('External change after Stop and during backup');
    expect(await s.chats.getConversationMetadata(uid, cid)).not.toBeNull();
    expect(await s.recycle.listRecycleBatches(uid)).toEqual([]);
  });

  it('recycles the selected conversation without waiting for an unrelated blocked board writer', async () => {
    const s = await arrangeDeferredStop(true);
    const pending = tracked(s.cleanup.remove(uid, s.preview.token, cid));
    const result = await Promise.race([
      pending,
      s.broadFlush.promise.then(() => { throw new Error('Cleanup selected an unrelated blocked task-board writer'); }),
    ]);
    expect(result, JSON.stringify(s.trace)).toEqual({ status: 'deleted' });
    expect(s.targetPublished()).toBe(true);
    expect(s.otherPublished()).toBe(false);
    expect(fs.existsSync(s.layout.messageFile)).toBe(false);
    const [batch] = await s.recycle.listRecycleBatches(uid);
    expect(batch.items.some(item => item.path.includes('unrelated-history'))).toBe(false);
  });
});
