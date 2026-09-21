import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
let root: string;
let previousRoot: string | undefined;
const uid = 'worker-user';
function write(cid: string, messages: object[]) {
  const file = path.join(root, uid, 'cloud/chats', `${cid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  return file;
}
beforeEach(async () => {
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-worker-search-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../../src/main/features/users')).activateUser(uid);
  // Tests own explicit reconciliation; query-triggered idle jobs must not race it.
  (await import('../../../../src/main/util/boot_init')).configureBootAdmission({ isRuntimeBusy: () => true });
});
afterEach(async () => {
  await (await import('../../../../src/main/features/search/indexer')).flushAll();
  (await import('../../../../src/main/util/boot_init'))._resetForTests();
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

it('keeps real searches and the main timer responsive while indexing a full multi-MB execution record', async () => {
  const ix = await import('../../../../src/main/features/search/indexer');
  const search = await import('../../../../src/main/features/search');
  const store = await import('../../../../src/main/features/search/chat_store');
  write('existing', [{ role: 'user', content: 'existingmarker', time: 't' }]);
  await ix.reconcileChatsIndex(uid);
  expect((await search.searchChatsWithStatus(uid, 'existingmarker')).results).toHaveLength(1);
  // The old 16-record bound cannot protect against a single large tool result.
  const vocabulary = Array.from({ length: 150_000 }, (_, i) => `term${String(i).padStart(7, '0')}`).join(' ') + ' ';
  const text = vocabulary.repeat(5) + 'tailmarker'; // 9 MB; full tail must survive.
  const processRecord = { from: 'assistant', text: 'Completed', ts: 't', process: [
    { type: 'event', event: { stream: 'tool', data: { type: 'tool_result', output: text } } },
    { type: 'event', event: { stream: 'thinking', data: { text: 'privatereasoningmarker' } } },
  ] };
  write('large', [processRecord]);

  // Negative control: same native tokenizer/postings writer on main. This
  // rejects an async wrapper that still performs the heavy transaction here.
  let controlGap = 0;
  const controlStart = performance.now();
  const controlTimer = new Promise<void>(resolve => setTimeout(() => {
    controlGap = performance.now() - controlStart; resolve();
  }, 0));
  store.writeRebuildBatch('control', 'large', [{ cid: 'large', msgIndex: 0, role: 'assistant', time: 't', text }],
    { mtime: 1, size: text.length, next: 1 }, true, true);
  await controlTimer;
  store.closeChatStore('control');

  const gaps: number[] = [];
  const queries: Array<{ ms: number; count: number; complete: boolean }> = [];
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 10);
  let done = false;
  const startedAt = performance.now();
  const cpu = process.cpuUsage();
  const rebuild = ix.reconcileChatsIndex(uid).finally(() => { done = true; });
  try {
    while (!done) {
      const start = performance.now();
      const page = await search.searchChatsWithStatus(uid, 'existingmarker');
      queries.push({ ms: performance.now() - start, count: page.results.length, complete: page.indexComplete });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect((await rebuild).complete).toBe(true);
  } finally { clearInterval(timer); await rebuild; }
  const elapsed = performance.now() - startedAt;
  const cpuUse = process.cpuUsage(cpu);
  const partial = queries.filter(query => !query.complete);
  expect(partial.length).toBeGreaterThan(3);
  expect(partial.every(query => query.count === 1)).toBe(true);
  const maxGap = Math.max(...gaps);
  const sorted = partial.map(query => query.ms).sort((a, b) => a - b);
  const p95 = sorted[Math.floor((sorted.length - 1) * .95)];
  expect(maxGap, 'main timer remains interactive during the native worker transaction').toBeLessThan(300);
  expect(maxGap, 'negative control must detect main-thread tokenization/writes').toBeLessThan(controlGap / 2);
  expect(p95).toBeLessThan(200);
  expect(store.docCount(uid), 'reader statistics observe external worker commits').toBe(2);
  expect(store.postingsFor(uid, 'tailmarker')).toHaveLength(1);
  expect(store.postingsFor(uid, 'term0149999')).toHaveLength(1);
  expect(store.postingsFor(uid, 'privatereasoningmarker')).toHaveLength(0);
  expect((await search.searchChatsWithStatus(uid, 'tailmarker')).results).toHaveLength(1);
  console.info('search worker performance', JSON.stringify({ characters: text.length,
    control_main_gap_ms: Math.round(controlGap), worker_total_ms: Math.round(elapsed),
    main_max_gap_ms: Math.round(maxGap), query_p95_ms: Math.round(p95), samples: partial.length,
    process_cpu_ms: Math.round((cpuUse.user + cpuUse.system) / 1000), rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024) }));
});

it('rolls back a real worker SQL failure and resumes committed rows with a new worker', async () => {
  const ix = await import('../../../../src/main/features/search/indexer');
  const store = await import('../../../../src/main/features/search/chat_store');
  write('recovery', Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `marker${i}`, time: 't' })));
  const legacy = path.join(root, uid, 'local/search/chats.idx.json');
  expect(store.docCount(uid)).toBe(0); // Open the reader before the worker writes.
  fs.writeFileSync(legacy, '{}');
  const db = new Database(store.chatStorePath(uid));
  try {
    db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON chat_docs WHEN NEW.msg_index = 17 BEGIN SELECT RAISE(ABORT, 'private fixture detail'); END");
    await expect(ix.reconcileChatsIndex(uid)).rejects.toThrow('Chat index rebuild batch failed');
    expect(store.docCount(uid)).toBe(16);
    expect(store.readRebuildCursor(uid, 'recovery')?.next).toBe(16);
    expect(store.postingsFor(uid, 'marker16')).toHaveLength(0);
    expect(store.hasCompletedRebuild(uid)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(true);
    const prefixId = store.postingsFor(uid, 'marker0')[0].doc;
    db.exec('DROP TRIGGER injected_failure');
    await ix.flushAll();
    expect((await ix.reconcileChatsIndex(uid)).complete).toBe(true);
    expect(store.postingsFor(uid, 'marker0')[0].doc).toBe(prefixId);
    expect(store.postingsFor(uid, 'marker39')).toHaveLength(1);
    expect(store.docCount(uid)).toBe(40);
    expect(fs.existsSync(legacy)).toBe(false);
  } finally { db.close(); }
});

it('does not block main invalidation or deletion behind an active worker write transaction', async () => {
  const ix = await import('../../../../src/main/features/search/indexer');
  const store = await import('../../../../src/main/features/search/chat_store');
  const { ChatRebuildWorker } = await import('../../../../src/main/features/search/chat-rebuild');
  const existing = write('existing', [{ role: 'user', content: 'deletemarker', time: 't' }]);
  await ix.reconcileChatsIndex(uid);
  const text = Array.from({ length: 180_000 }, (_, i) => `unique${i}`).join(' ');
  const large = write('large', [{ role: 'user', content: text, time: 't' }]);
  const db = new Database(store.chatStorePath(uid));
  db.pragma('busy_timeout = 0');
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const real = ChatRebuildWorker.prototype.rebuildBatch;
  vi.spyOn(ChatRebuildWorker.prototype, 'rebuildBatch').mockImplementation(function(file) {
    const batch = real.call(this, file); entered(); return batch;
  });
  const run = ix.reconcileChatsIndex(uid);
  try {
    await started;
    await vi.waitFor(() => {
      let busy = false;
      try { db.exec('BEGIN IMMEDIATE; ROLLBACK'); }
      catch (error) { if ((error as any).code === 'SQLITE_BUSY') busy = true; else throw error; }
      expect(busy, 'prove a real writer lock is held, not merely a pending promise').toBe(true);
    }, { timeout: 5_000, interval: 10 });
    const start = performance.now();
    fs.unlinkSync(existing);
    fs.appendFileSync(large, JSON.stringify({ role: 'user', content: 'freshmarker', time: 't2' }) + '\n');
    ix.invalidateChatsIndex(uid);
    ix.indexChatMessageDeferred(uid, 'large', 1, { role: 'user', content: 'freshmarker', time: 't2' });
    await ix.dropChatConversation(uid, 'existing');
    expect(performance.now() - start).toBeLessThan(200);
    expect((await run).complete).toBe(false);
    expect(store.readSourceStamp(uid)).toBeUndefined();
    expect((await ix.reconcileChatsIndex(uid)).complete).toBe(true);
    expect(store.postingsFor(uid, 'deletemarker')).toHaveLength(0);
    expect(store.postingsFor(uid, 'freshmarker')).toHaveLength(1);
    expect(store.docCount(uid)).toBe(2);
  } finally { await run.catch(() => undefined); db.close(); }
});
