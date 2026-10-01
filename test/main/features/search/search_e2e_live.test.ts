import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const warnings = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({
  info: vi.fn(), debug: vi.fn(), warn: (...args: unknown[]) => warnings.push(args), error: (...args: unknown[]) => warnings.push(args),
}) }));
let root: string;
let previousRoot: string | undefined;
let ix: typeof import('../../../../src/main/features/search/indexer');
let store: typeof import('../../../../src/main/features/search/chat_store');
let storage: typeof import('../../../../src/main/storage');
let search: typeof import('../../../../src/main/features/search');
const uid = 'live-worker';
function file(cid: string) { return path.join(root, uid, 'cloud/chats', `${cid}.jsonl`); }
async function append(cid: string, message: object) {
  return storage.appendJsonlAtomic(file(cid), message, true);
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-live-search-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  warnings.length = 0;
  (await import('../../../../src/main/features/users')).activateUser(uid);
  (await import('../../../../src/main/util/boot_init')).configureBootAdmission({ isRuntimeBusy: () => true });
  ix = await import('../../../../src/main/features/search/indexer');
  store = await import('../../../../src/main/features/search/chat_store');
  storage = await import('../../../../src/main/storage');
  search = await import('../../../../src/main/features/search');
  await ix.reconcileChatsIndex(uid);
});
afterEach(async () => {
  await ix.flushAll();
  (await import('../../../../src/main/util/boot_init'))._resetForTests();
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
  expect(warnings.splice(0), 'all worker failures must be asserted by their scenario').toEqual([]);
});

it('immediately searches the full tool-output tail while live indexing leaves the main timer responsive', async () => {
  const warm = await append('warm', { text: 'warmmarker' });
  await ix.indexChatMessage(uid, 'warm', warm.msgIndex, warm.source!);
  await search.searchChatsWithStatus(uid, 'warmmarker');
  const vocabulary = Array.from({ length: 100_000 }, (_, i) => `word${String(i).padStart(6, '0')}`).join(' ') + ' ';
  const text = vocabulary.repeat(5) + 'livetailmarker';
  const message = { from: 'assistant', ts: 't', text: 'Finished', process: [
    { type: 'event', event: { stream: 'tool', data: { type: 'tool_result', output: text } } },
    { type: 'event', event: { stream: 'thinking', data: { text: 'privatethoughtmarker' } } },
  ] };
  const row = await append('large', message);
  // Negative control executes the original main-thread projection and writer.
  const controlStart = performance.now();
  let controlGap = 0;
  const controlTimer = new Promise<void>(resolve => setTimeout(() => {
    controlGap = performance.now() - controlStart; resolve();
  }, 0));
  const controlCpuStart = process.cpuUsage();
  store.upsertDoc('control', { cid: 'large', msgIndex: 0, role: 'assistant', time: 't', text: ix.readMsgText(message) });
  const controlCpu = process.cpuUsage(controlCpuStart);
  await controlTimer;
  store.closeChatStore('control');
  const { ChatRebuildWorker } = await import('../../../../src/main/features/search/chat-rebuild');
  const messages = vi.spyOn(ChatRebuildWorker.prototype, 'indexMessage');
  let last = performance.now();
  const gaps: number[] = [];
  const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 5);
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  try {
    ix.indexChatMessageDeferred(uid, 'large', row.msgIndex, row.source!);
    const page = await search.searchChatsWithStatus(uid, 'livetailmarker');
    expect(page.results).toHaveLength(1);
    expect(page.results[0].cid).toBe('large');
    expect(page.indexComplete).toBe(true);
  } finally { clearInterval(timer); await ix.drainDeferredChatWrites(); }
  const cpu = process.cpuUsage(cpuStart);
  const maxGap = Math.max(...gaps);
  expect(gaps.length).toBeGreaterThan(5);
  expect(maxGap).toBeLessThan(150);
  expect(maxGap).toBeLessThan(controlGap / 2);
  expect(store.postingsFor(uid, 'word099999')).toHaveLength(1);
  expect(store.postingsFor(uid, 'privatethoughtmarker')).toHaveLength(0);
  expect(messages).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(messages.mock.calls[0][0]).length, 'no large structured clone on main').toBeLessThan(1024);
  expect(store.readFileWatermark(uid, 'large')).toMatchObject({ next: 1, size: row.source!.size });
  console.info('search live worker performance', JSON.stringify({ characters: text.length,
    control_main_gap_ms: Math.round(controlGap), control_cpu_ms: Math.round((controlCpu.user + controlCpu.system) / 1000),
    worker_total_ms: Math.round(performance.now() - started), main_max_gap_ms: Math.round(maxGap),
    process_cpu_ms: Math.round((cpu.user + cpu.system) / 1000), rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024) }));
});

it('accepts a queued append prefix, advances over empty rows, and isolates accounts', async () => {
  const rows = await Promise.all([
    append('ordered', { role: 'user', content: 'firstmarker 中文', time: 't1' }),
    append('ordered', { from: 'assistant', text: '', ts: 't2' }),
    append('ordered', { from: 'user', text: 'lastmarker', ts: 't3' }),
  ]);
  // All receipts see a file that has grown by the time the first is read.
  for (const row of rows.sort((a, b) => a.msgIndex - b.msgIndex)) ix.indexChatMessageDeferred(uid, 'ordered', row.msgIndex, row.source!);
  await ix.drainDeferredChatWrites(uid);
  expect(store.readFileWatermark(uid, 'ordered')).toMatchObject({ next: 3, size: fs.statSync(file('ordered')).size });
  expect(store.docCount(uid)).toBe(2);
  expect((await ix.reconcileChatsIndex(uid)).updated, 'contiguous live writes need no history rebuild').toBe(0);
  expect((await search.searchChatsWithStatus(uid, 'lastmarker')).results).toHaveLength(1);
  expect((await search.searchChatsWithStatus('other-account', 'lastmarker')).results).toHaveLength(0);
});

it.each(['replace', 'delete'] as const)('rejects a stale byte receipt after source %s and recovers from disk', async action => {
  const row = await append('changed', { text: 'obsoleteword' });
  if (action === 'replace') {
    fs.renameSync(file('changed'), file('old'));
    fs.writeFileSync(file('changed'), JSON.stringify({ text: 'replacementword' }) + '\n');
    fs.unlinkSync(file('old'));
  } else fs.unlinkSync(file('changed'));
  await ix.indexChatMessage(uid, 'changed', row.msgIndex, row.source!);
  expect(store.postingsFor(uid, 'obsoleteword')).toHaveLength(0);
  expect(store.readFileWatermark(uid, 'changed')).toBeUndefined();
  expect(await ix.isChatsIndexCurrent(uid)).toBe(false);
  expect((await ix.reconcileChatsIndex(uid)).complete).toBe(true);
  expect(store.postingsFor(uid, 'replacementword')).toHaveLength(action === 'replace' ? 1 : 0);
});

it('rolls back postings when the watermark write fails, then repairs after reopening', async () => {
  const row = await append('failed', { text: 'recoverablemarker' });
  const db = new Database(store.chatStorePath(uid));
  try {
    db.exec("CREATE TRIGGER fail_watermark BEFORE INSERT ON chat_files BEGIN SELECT RAISE(ABORT, 'private fault detail'); END");
    await ix.indexChatMessage(uid, 'failed', row.msgIndex, row.source!);
    expect(store.docCount(uid)).toBe(0);
    expect(store.postingsFor(uid, 'recoverablemarker')).toHaveLength(0);
    expect(store.readFileWatermark(uid, 'failed')).toBeUndefined();
    expect(store.readSourceStamp(uid)).toBeUndefined();
    expect(ix.hasPendingChatRepair(uid)).toBe(true);
    expect(warnings.splice(0)).toEqual([['index chat message failed', expect.any(Object)]]);
    db.exec('DROP TRIGGER fail_watermark');
  } finally { db.close(); }
  await ix.flushAll();
  expect((await ix.reconcileChatsIndex(uid)).complete).toBe(true);
  expect(store.postingsFor(uid, 'recoverablemarker')).toHaveLength(1);
  expect(store.readFileWatermark(uid, 'failed')?.next).toBe(1);
});

it('keeps a cancelled queued append visibly incomplete when another conversation is deleted', async () => {
  const prefix = await append('kept', { text: 'prefixmarker' });
  await ix.indexChatMessage(uid, 'kept', prefix.msgIndex, prefix.source!);
  const removed = await append('removed', { text: 'removedmarker' });
  await ix.indexChatMessage(uid, 'removed', removed.msgIndex, removed.source!);
  await ix.reconcileChatsIndex(uid);
  const queued = await append('kept', { text: 'queuedmarker' });
  ix.indexChatMessageDeferred(uid, 'kept', queued.msgIndex, queued.source!);
  fs.unlinkSync(file('removed'));
  await ix.dropChatConversation(uid, 'removed');
  await ix.drainDeferredChatWrites(uid);
  expect(store.readSourceStamp(uid)).toBeUndefined();
  expect(await ix.isChatsIndexCurrent(uid)).toBe(false);
  expect(store.postingsFor(uid, 'removedmarker')).toHaveLength(0);
  expect((await ix.reconcileChatsIndex(uid)).complete).toBe(true);
  expect(store.postingsFor(uid, 'prefixmarker')).toHaveLength(1);
  expect(store.postingsFor(uid, 'queuedmarker')).toHaveLength(1);
});

it('bounds a stalled live queue and catches all durable messages up without certifying a gap', async () => {
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(await append('burst', { text: `burstmarker${i}` }));
  const { ChatRebuildWorker } = await import('../../../../src/main/features/search/chat-rebuild');
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const real = ChatRebuildWorker.prototype.indexMessage;
  const calls = vi.spyOn(ChatRebuildWorker.prototype, 'indexMessage').mockImplementationOnce(async function(message) {
    entered(); await gate; return real.call(this, message);
  });
  ix.indexChatMessageDeferred(uid, 'burst', rows[0].msgIndex, rows[0].source!);
  await started;
  try {
    for (const row of rows.slice(1)) ix.indexChatMessageDeferred(uid, 'burst', row.msgIndex, row.source!);
    expect(ix.hasPendingChatRepair(uid)).toBe(true);
    expect(ix.isChatsIndexTrusted(uid)).toBe(false);
  } finally { release(); }
  await ix.drainDeferredChatWrites(uid);
  expect(calls.mock.calls.length).toBeLessThan(rows.length);
  expect(store.readFileWatermark(uid, 'burst')).toBeUndefined();
  expect((await ix.reconcileChatsIndex(uid)).complete).toBe(true);
  expect(store.docCount(uid)).toBe(300);
  expect(store.postingsFor(uid, 'burstmarker0')).toHaveLength(1);
  expect(store.postingsFor(uid, 'burstmarker299')).toHaveLength(1);
});

it('does not resurrect readiness when sync replaces history during the final worker handoff', async () => {
  await append('finalizing', { text: 'oldhandoffmarker' });
  const { ChatRebuildWorker } = await import('../../../../src/main/features/search/chat-rebuild');
  const real = ChatRebuildWorker.prototype.markComplete;
  vi.spyOn(ChatRebuildWorker.prototype, 'markComplete').mockImplementationOnce(async function(stamp) {
    await real.call(this, stamp);
    const before = fs.statSync(file('finalizing'));
    fs.writeFileSync(file('finalizing'), JSON.stringify({ text: 'newhandoffmarker' }) + '\n');
    // This race concerns the completion handoff. Ensure the replacement has a
    // distinct source fingerprint even on hosts that coalesce rapid mtimes.
    fs.utimesSync(file('finalizing'), before.atime, new Date(before.mtimeMs + 1_000));
    ix.invalidateChatsIndex(uid);
  });
  expect((await ix.reconcileChatsIndex(uid)).complete).toBe(false);
  expect(store.readSourceStamp(uid)).toBeUndefined();
  expect(ix.isChatsIndexTrusted(uid)).toBe(false);
  expect((await ix.reconcileChatsIndex(uid)).complete).toBe(true);
  expect(store.postingsFor(uid, 'oldhandoffmarker')).toHaveLength(0);
  expect(store.postingsFor(uid, 'newhandoffmarker')).toHaveLength(1);
});

it('keeps a fully indexed conversation searchable when optional disk compaction fails', async () => {
  await append('compact', { text: 'compactionmarker' });
  const db = new Database(store.chatStorePath(uid));
  try {
    db.exec('CREATE TABLE reclaim_fixture (body BLOB); INSERT INTO reclaim_fixture VALUES (zeroblob(40000000)); DROP TABLE reclaim_fixture');
  } finally { db.close(); }
  const { ChatRebuildWorker } = await import('../../../../src/main/features/search/chat-rebuild');
  vi.spyOn(ChatRebuildWorker.prototype, 'compact').mockRejectedValueOnce(new Error('injected vacuum failure'));
  expect((await ix.reconcileChatsIndex(uid)).complete).toBe(true);
  expect(ix.isChatsIndexTrusted(uid)).toBe(true);
  expect((await search.searchChatsWithStatus(uid, 'compactionmarker')).results).toHaveLength(1);
  expect(warnings.splice(0)).toEqual([['chat store vacuum failed', expect.any(Object)]]);
});

it('backs off an unavailable writer instead of retrying every queued message, then repairs all sources', async () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(await append('unavailable', { text: `retrymarker${i}` }));
  const { ChatRebuildWorker } = await import('../../../../src/main/features/search/chat-rebuild');
  const write = vi.spyOn(ChatRebuildWorker.prototype, 'indexMessage').mockRejectedValue(new Error('worker unavailable'));
  const invalidate = vi.spyOn(ChatRebuildWorker.prototype, 'invalidate').mockRejectedValue(new Error('worker unavailable'));
  for (const row of rows) ix.indexChatMessageDeferred(uid, 'unavailable', row.msgIndex, row.source!);
  await ix.drainDeferredChatWrites(uid);
  expect(write).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(warnings.splice(0)).toEqual([['index chat message failed', expect.any(Object)]]);
  expect(store.docCount(uid)).toBe(0);
  expect(ix.isChatsIndexTrusted(uid)).toBe(false);
  expect(ix.hasPendingChatRepair(uid)).toBe(true);
  write.mockRestore(); invalidate.mockRestore();
  expect((await ix.reconcileChatsIndex(uid)).complete).toBe(true);
  expect(store.docCount(uid)).toBe(30);
  expect(store.postingsFor(uid, 'retrymarker29')).toHaveLength(1);
});

it('releases an idle writer and reopens it for the next append without losing the committed prefix', async () => {
  await ix.flushAll();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { ChatRebuildWorker } = await import('../../../../src/main/features/search/chat-rebuild');
  const real = ChatRebuildWorker.prototype.indexMessage;
  const writers: InstanceType<typeof ChatRebuildWorker>[] = [];
  vi.spyOn(ChatRebuildWorker.prototype, 'indexMessage').mockImplementation(function(message) {
    writers.push(this); return real.call(this, message);
  });
  try {
    const first = await append('idle', { text: 'beforeidlemarker' });
    await ix.indexChatMessage(uid, 'idle', first.msgIndex, first.source!);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writers[0].available).toBe(false);
    await writers[0].close();
    const next = await append('idle', { text: 'afteridlemarker' });
    await ix.indexChatMessage(uid, 'idle', next.msgIndex, next.source!);
    expect(writers[1]).not.toBe(writers[0]);
    expect(store.readFileWatermark(uid, 'idle')?.next).toBe(2);
    expect(store.postingsFor(uid, 'beforeidlemarker')).toHaveLength(1);
    expect(store.postingsFor(uid, 'afteridlemarker')).toHaveLength(1);
  } finally { await ix.flushAll(); vi.useRealTimers(); }
});

it.each(['terminate', 'invalidate-and-delete'] as const)('recovers from %s during a real live SQLite transaction without blocking main', async action => {
  const old = await append('deleted', { text: 'deletedmarker' });
  await ix.indexChatMessage(uid, 'deleted', old.msgIndex, old.source!);
  const text = Array.from({ length: 180_000 }, (_, i) => `uniqueterm${i}`).join(' ');
  const row = await append('active', { text: text + ' activemarker' });
  const { ChatRebuildWorker } = await import('../../../../src/main/features/search/chat-rebuild');
  const real = ChatRebuildWorker.prototype.indexMessage;
  let activeWorker: any;
  vi.spyOn(ChatRebuildWorker.prototype, 'indexMessage').mockImplementation(function(message) {
    activeWorker = this;
    return real.call(this, message);
  });
  const db = new Database(store.chatStorePath(uid));
  db.pragma('busy_timeout = 0');
  const run = ix.indexChatMessage(uid, 'active', row.msgIndex, row.source!);
  let deletion: Promise<void> | undefined;
  try {
    await vi.waitFor(() => {
      let busy = false;
      try { db.exec('BEGIN IMMEDIATE; ROLLBACK'); }
      catch (error) { if ((error as any).code === 'SQLITE_BUSY') busy = true; else throw error; }
      expect(busy, 'inject while a native writer holds the lock').toBe(true);
    }, { timeout: 5_000, interval: 5 });
    const gaps: number[] = [];
    let last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 5);
    try {
      if (action === 'terminate') await activeWorker.worker.terminate();
      else {
        // Mutation calls themselves may not wait synchronously on SQLite.
        const start = performance.now();
        fs.unlinkSync(file('deleted'));
        fs.writeFileSync(file('active'), JSON.stringify({ text: 'synchronizedmarker' }) + '\n');
        ix.invalidateChatsIndex(uid);
        deletion = ix.dropChatConversation(uid, 'deleted');
        expect(performance.now() - start).toBeLessThan(100);
      }
      await run;
      await deletion;
    } finally { clearInterval(timer); }
    expect(Math.max(0, ...gaps)).toBeLessThan(150);
    expect(store.readFileWatermark(uid, 'active')).toBeUndefined();
    expect(store.readSourceStamp(uid)).toBeUndefined();
    expect(ix.isChatsIndexTrusted(uid)).toBe(false);
    if (action === 'terminate') {
      expect(store.postingsFor(uid, 'activemarker')).toHaveLength(0);
      expect(warnings.splice(0)).toEqual([['index chat message failed', expect.any(Object)]]);
    } else expect(store.postingsFor(uid, 'deletedmarker')).toHaveLength(0);
  } finally { await run; await deletion; db.close(); }
  await ix.flushAll();
  expect((await ix.reconcileChatsIndex(uid)).complete).toBe(true);
  expect(store.postingsFor(uid, action === 'terminate' ? 'activemarker' : 'synchronizedmarker')).toHaveLength(1);
  if (action === 'invalidate-and-delete') {
    expect(store.postingsFor(uid, 'activemarker')).toHaveLength(0);
    expect(store.postingsFor(uid, 'deletedmarker')).toHaveLength(0);
  }
});
