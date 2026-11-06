import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

let root: string;
let previous: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-history-worker-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
});
afterEach(async () => {
  await (await import('../../../src/main/features/conversation-history-client')).closeConversationHistoryWorker();
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const row = (id: string, output = '') => ({ id, from: 'commander', to: ['user'], ts: '2026-09-23',
  text: `完整消息 ${id} \\(x^2\\)`, process: [{ type: 'event', event: { stream: 'tool',
    data: { name: 'bash', phase: 'end', output } } }] });


const gate = () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
};
function historySource(name: string, output = '') {
  const file = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(file, JSON.stringify(row(name, output)) + '\n');
  return file;
}

it.each([
  { lane: 'live', warm: false }, { lane: 'navigation', warm: false },
  { lane: 'live', warm: true }, { lane: 'navigation', warm: true },
] as const)('waits for all history cleanup before $lane work resumes (warm=$warm)', async ({ lane, warm }) => {
  const client = await import('../../../src/main/features/conversation-history-client');
  const cache = await import('../../../src/main/features/conversation_history_cache');
  const realRequest = client.ConversationHistoryWorker.prototype.request;
  const realClose = client.ConversationHistoryWorker.prototype.close;
  const owners = new Set<any>(), released = gate();
  const posted: string[] = [];
  let closingStarted = false, closed = false, prematureDispatch = false;
  vi.spyOn(client.ConversationHistoryWorker.prototype, 'request').mockImplementation(function(command) {
    if (closingStarted && !closed) prematureDispatch = true;
    owners.add(this); posted.push(command.kind); return realRequest.call(this, command);
  });
  const sourceFile = historySource('late-shutdown', 'Preserved complete output '.repeat(1000));
  const original = fs.readFileSync(sourceFile);
  await cache.readConversationHistoryPage('user', sourceFile, 1);
  const request = () => lane === 'live'
    ? cache.projectLiveConversationHistoryRecords('user', sourceFile, [row('late-live')])
    : client.turnIndexRequest({ kind: 'turns', userId: 'user', cid: 'late-shutdown', sourceFile });
  if (warm) await request();
  const admitted = [...posted];
  const oldOwners = [...owners];
  vi.spyOn(client.ConversationHistoryWorker.prototype, 'close').mockImplementation(async function() {
    await realClose.call(this); await released.pending;
  });
  closingStarted = true;
  const closing = client.closeConversationHistoryWorker();
  void closing.then(() => { closed = true; });
  const late = request();
  const outcome = Promise.allSettled([late]);
  try {
    await vi.waitFor(() => expect(oldOwners.every(owner => owner.worker.threadId === -1)).toBe(true));
    const beforeRelease = [...posted];
    released.release(); await closing;
    const results = await outcome;
    expect(beforeRelease).toEqual(admitted);
    expect(prematureDispatch).toBe(false);
    expect(results[0].status).toBe('fulfilled');
    expect(oldOwners.every(owner => owner.worker.threadId === -1)).toBe(true);
    expect(fs.readFileSync(sourceFile)).toEqual(original);
    if (lane === 'live') {
      expect((await cache.projectLiveConversationHistoryRecords('user', sourceFile, [row('fresh-live')]))[0].id).toBe('fresh-live');
    } else {
      const fresh = await client.turnIndexRequest<any>({ kind: 'turns', userId: 'user', cid: 'late-shutdown', sourceFile });
      expect(fresh.total).toBe(0);
    }
  } finally { released.release(); await Promise.allSettled([closing, late]); }
});

it('keeps every live process item inline and isolates its queue from persisted-history reads', async () => {
  const client = await import('../../../src/main/features/conversation-history-client');
  const real = client.ConversationHistoryWorker.prototype.request;
  const lanes: Record<string, unknown> = {};
  const spy = vi.spyOn(client.ConversationHistoryWorker.prototype, 'request').mockImplementation(function(command) {
    lanes[command.kind] = this;
    return real.call(this, command);
  });
  try {
    const cache = await import('../../../src/main/features/conversation_history_cache');
    const process = Array.from({ length: 2500 }, (_, n) => ({ type: 'progress', text: `event-${n}` }));
    const file = path.join(root, 'live.jsonl');
    const [live] = await cache.projectLiveConversationHistoryRecords('user', file, [{ ...row(''), process } as any]);
    await cache.readConversationHistoryPage('user', file, 10);
    expect(live.process).toEqual(process);
    expect(live.process_parts).toBeUndefined();
    expect(lanes.project).not.toBe(lanes.page);
    expect(fs.existsSync(file)).toBe(false);
  } finally { spy.mockRestore(); }
});

it('orders cache clearing after already-admitted live projections', async () => {
  const client = await import('../../../src/main/features/conversation-history-client');
  const real = client.ConversationHistoryWorker.prototype.request;
  let release!: () => void, purgePosted = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(client.ConversationHistoryWorker.prototype, 'request').mockImplementation(function(command) {
    if (command.kind === 'purge') purgePosted = true;
    if (command.kind === 'project') return gate.then(() => real.call(this, command));
    return real.call(this, command);
  });
  const cache = await import('../../../src/main/features/conversation_history_cache');
  const file = path.join(root, 'clear-live.jsonl');
  const projection = cache.projectLiveConversationHistoryRecords('user', file, [row('', 'complete output '.repeat(1000))]);
  const purge = cache.purgeConversationHistoryCache('user', file);
  try {
    await Promise.resolve();
    const ordered = !purgePosted;
    release();
    const [record] = await projection;
    const output = (record.process![0] as any).event.data.result_path;
    await purge;
    expect(ordered).toBe(true);
    expect(fs.existsSync(output)).toBe(false);
  } finally { release(); await Promise.allSettled([projection, purge]); spy.mockRestore(); }
});

it('does not turn a failed cache clear into a live-query failure', async () => {
  const client = await import('../../../src/main/features/conversation-history-client');
  const real = client.ConversationHistoryWorker.prototype.request;
  const spy = vi.spyOn(client.ConversationHistoryWorker.prototype, 'request').mockImplementation(function(command) {
    return command.kind === 'purge' ? Promise.reject(new Error('injected clear failure')) : real.call(this, command);
  });
  try {
    const cache = await import('../../../src/main/features/conversation_history_cache');
    const file = path.join(root, 'failed-clear.jsonl');
    const clear = cache.purgeConversationHistoryCache('user', file);
    const live = cache.projectLiveConversationHistoryRecords('user', file, [row('unchanged')]);
    await expect(clear).rejects.toThrow('injected clear failure');
    expect((await live)[0].id).toBe('unchanged');
  } finally { spy.mockRestore(); }
});

it('cancels delayed projection and clear work at shutdown without reopening a worker', async () => {
  const client = await import('../../../src/main/features/conversation-history-client');
  const real = client.ConversationHistoryWorker.prototype.request;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const commands: string[] = [];
  const spy = vi.spyOn(client.ConversationHistoryWorker.prototype, 'request').mockImplementation(function(command) {
    commands.push(command.kind);
    return command.kind === 'project' ? gate.then(() => real.call(this, command)) : real.call(this, command);
  });
  const cache = await import('../../../src/main/features/conversation_history_cache');
  const file = path.join(root, 'closing-live.jsonl');
  const live = cache.projectLiveConversationHistoryRecords('user', file, [row('cancelled')]);
  const clear = cache.purgeConversationHistoryCache('user', file);
  const settled = Promise.allSettled([live, clear]);
  try {
    await client.closeConversationHistoryWorker();
    release();
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    expect(commands).toEqual(['project']);
    expect((await cache.projectLiveConversationHistoryRecords('user', file, [row('fresh')]))[0].id).toBe('fresh');
  } finally { release(); await settled; spy.mockRestore(); }
});

it('reads cold/older pages without main-thread spill I/O and preserves exact expandable output', async () => {
  const file = path.join(root, 'history.jsonl');
  const output = '完整工具输出\n'.repeat(20_000);
  const source = Array.from({ length: 12 }, (_, i) => JSON.stringify(row(`m${i}`, output + i))).join('\n') + '\n';
  fs.writeFileSync(file, source);
  const cache = await import('../../../src/main/features/conversation_history_cache');
  const write = vi.spyOn(fs, 'writeFileSync');
  try {
    const latest = await cache.readConversationHistoryPage('user', file, 10);
    const older = await cache.readConversationHistoryPage('user', file, 10, latest.nextCursor);
    expect(write).not.toHaveBeenCalled();
    expect([...older.records, ...latest.records].map(r => r.id)).toEqual(Array.from({ length: 12 }, (_, i) => `m${i}`));
    expect(older.nextCursor).toBeNull();
    const data = (latest.records[0].process![0] as any).event.data;
    expect(data.output).toBeUndefined();
    expect(fs.readFileSync(data.result_path, 'utf8')).toBe(output + '2');
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
  } finally { write.mockRestore(); }
});

it('bounds search windows and preserves bidirectional byte cursors across malformed, deleted and Unicode records', async () => {
  const file = path.join(root, 'window.jsonl');
  const rows = Array.from({ length: 35 }, (_, i) => ({ ...row(`m${i}`, '工具'.repeat(1000)), ...(i === 22 ? { deleted_at: 'today' } : {}) }));
  const lines = rows.map(r => JSON.stringify(r));
  lines.splice(5, 0, '{malformed');
  fs.writeFileSync(file, lines.join('\n'));
  const cache = await import('../../../src/main/features/conversation_history_cache');
  const page = await cache.readConversationHistoryWindow('user', file, 20);
  expect(page.records.map(r => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 20}`));
  expect(page.records[2].deleted_at).toBe('today');
  expect(page.records[9].text).toBe('完整消息 m29 \\(x^2\\)');
  const following = await cache.readConversationHistoryWindow('user', file, 0, 10, page.followingCursor!);
  expect(following.records.map(r => r.id)).toEqual(['m30', 'm31', 'm32', 'm33', 'm34']);
  expect(following.followingCursor).toBeNull();
  const earlier = await cache.readConversationHistoryPage('user', file, 10, page.previousCursor);
  expect(earlier.records.map(r => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 10}`));
});

it('invalidates replaced sources, isolates accounts and orders purge after reads', async () => {
  const file = path.join(root, 'replace.jsonl');
  fs.writeFileSync(file, JSON.stringify(row('old', 'a'.repeat(2000))) + '\n');
  const cache = await import('../../../src/main/features/conversation_history_cache');
  const first = await cache.readConversationHistoryPage('one', file, 10);
  const replacement = path.join(root, 'replacement');
  fs.writeFileSync(replacement, JSON.stringify(row('new', 'b'.repeat(2000))) + '\n');
  fs.renameSync(replacement, file);
  const next = await cache.readConversationHistoryPage('one', file, 10);
  const other = await cache.readConversationHistoryPage('two', file, 10);
  expect(first.records[0].id).toBe('old');
  expect(next.records[0].id).toBe('new');
  const resultPath = (page: typeof next) => (page.records[0].process![0] as any).event.data.result_path;
  expect(resultPath(next)).not.toBe(resultPath(other));
  expect(fs.readFileSync(resultPath(next), 'utf8')).toBe('b'.repeat(2000));
  const read = cache.readConversationHistoryPage('one', file, 10);
  const purge = cache.purgeConversationHistoryCache('one', file);
  await Promise.all([read, purge]);
  expect(fs.existsSync(resultPath(next))).toBe(false);
  expect(fs.existsSync(resultPath(other))).toBe(true);
  expect(fs.existsSync(file)).toBe(true);
});

it('rejects an interrupted read and reopens the same history with a fresh worker', async () => {
  const file = path.join(root, 'restart.jsonl');
  fs.writeFileSync(file, JSON.stringify(row('saved')) + '\n');
  const client = await import('../../../src/main/features/conversation-history-client');
  const real = client.ConversationHistoryWorker.prototype.request;
  const request = vi.spyOn(client.ConversationHistoryWorker.prototype, 'request').mockImplementationOnce(function(command) {
    const pending = real.call(this, command);
    // Kill the actual worker rather than exercising only graceful shutdown.
    void (this as any).worker.terminate();
    return pending;
  });
  try {
    const cache = await import('../../../src/main/features/conversation_history_cache');
    await expect(cache.readConversationHistoryPage('user', file, 10)).rejects.toThrow('worker stopped');
    expect((await cache.readConversationHistoryPage('user', file, 10)).records[0].id).toBe('saved');
  } finally { request.mockRestore(); }
});

it('bounds burst admission and settles every admitted caller on shutdown', async () => {
  const { ConversationHistoryWorker } = await import('../../../src/main/features/conversation-history-client');
  const worker = new ConversationHistoryWorker();
  const requests = Array.from({ length: 129 }, () => worker.request({ kind: 'page', userId: 'user', sourceFile: path.join(root, 'missing'), limit: 10 }));
  const settled = Promise.allSettled(requests);
  await worker.close();
  const results = await settled;
  expect(results).toHaveLength(129);
  expect(results.every(result => result.status === 'rejected')).toBe(true);
  expect((results[128] as PromiseRejectedResult).reason.message).toBe('Conversation history worker busy');
});


it('loads a 20 MiB single-record older page without truncating its expandable Unicode output', async () => {
  const file = path.join(root, 'huge-record.jsonl');
  const output = '起始🌟\n' + 'z'.repeat(20 * 1024 * 1024) + '\n完整结束';
  fs.writeFileSync(file, JSON.stringify(row('huge', output)) + '\n' + JSON.stringify(row('latest')) + '\n');
  const digest = async (filePath: string) => {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
  };
  const canonicalHash = await digest(file);
  const cache = await import('../../../src/main/features/conversation_history_cache');
  const latest = await cache.readConversationHistoryPage('user', file, 1);
  expect(latest.records.map(record => record.id)).toEqual(['latest']);
  const older = await cache.readConversationHistoryPage('user', file, 1, latest.nextCursor);
  expect(older.records.map(record => record.id)).toEqual(['huge']);
  expect(older.nextCursor).toBeNull();
  const tool = (older.records[0].process![0] as any).event.data;
  expect(tool.output).toBeUndefined();
  expect(tool.result_size).toBe(Buffer.byteLength(output));
  expect(await digest(tool.result_path)).toBe(createHash('sha256').update(output).digest('hex'));
  expect(await digest(file)).toBe(canonicalHash);
});

// PF-02: parent-page size must not hide nested work or another conversation's wait.
it.each([1000, 30000, 100000])('PF-02 preserves %i nested events across cold/warm reads and queued small conversations', async count => {
  const cache = await import('../../../src/main/features/conversation_history_cache');
  const file = path.join(root, 'nested.jsonl'), small = path.join(root, 'small.jsonl');
  const events = Array.from({ length: count }, (_, n) => ({ type: 'progress', text: `event-${n}-界` }));
  const records = Array.from({ length: 10 }, (_, n) => ({ ...row(`parent-${n}`), process: n === 0 ? events : [] }));
  const canonical = records.map(record => JSON.stringify(record)).join('\n') + '\n';
  fs.writeFileSync(file, canonical); fs.writeFileSync(small, JSON.stringify(row('small')) + '\n');
  await cache.readConversationHistoryPage('user', small, 10); // worker startup excluded
  const start = performance.now();
  const heavy = cache.readConversationHistoryPage('user', file, 10);
  const smallWaits: number[] = [];
  const queued = Array.from({ length: 8 }, () => cache.readConversationHistoryPage('user', small, 10).then(page => {
    smallWaits.push(performance.now() - start); expect(page.records.map(record => record.id)).toEqual(['small']);
  }));
  const cold = await heavy; const coldMs = performance.now() - start; await Promise.all(queued);
  const warmStart = performance.now(); const warm = await cache.readConversationHistoryPage('user', file, 10);
  const warmMs = performance.now() - warmStart;
  expect(warm).toEqual(cold); expect(cold.records.map(record => record.id)).toEqual(records.map(record => record.id));
  const projected = cold.records[0]; const complete: unknown[] = [];
  for (const part of projected.process_parts || []) {
    if (!('ref' in part)) throw new Error('Expected expandable process');
    let cursor: number | null = 0;
    do {
      const page = await cache.readConversationProcessPage('user', file, part.ref, cursor, projected.id);
      complete.push(...page.items); cursor = page.nextCursor;
    } while (cursor !== null);
  }
  if (!projected.process_parts?.length) complete.push(...projected.process || []);
  expect(complete).toEqual(events);
  expect(fs.readFileSync(file, 'utf8')).toBe(canonical);
  console.log('[PF-02 nested history]', JSON.stringify({ parents: 10, events: count, sourceBytes: Buffer.byteLength(canonical),
    coldMs, warmMs, queuedSmallMs: smallWaits, expandedEvents: complete.length,
    scope: 'actual shared history worker; warm OS cache; queue wait includes heavy cold read; no UI/p95 claim' }));
}, 30000);

it('shares pending cleanup, rejects new persisted reads, and reopens unchanged history after release', async () => {
  const client = await import('../../../src/main/features/conversation-history-client');
  const cache = await import('../../../src/main/features/conversation_history_cache');
  const sourceFile = historySource('repeat-close');
  const original = fs.readFileSync(sourceFile);
  await cache.readConversationHistoryPage('user', sourceFile, 1);
  const released = gate();
  const realClose = client.ConversationHistoryWorker.prototype.close;
  vi.spyOn(client.ConversationHistoryWorker.prototype, 'close').mockImplementation(async function() {
    await realClose.call(this);
    await released.pending;
  });
  const closing = client.closeConversationHistoryWorker();
  const repeated = client.closeConversationHistoryWorker();
  const late = client.historyRequest({ kind: 'page', userId: 'user', sourceFile, limit: 1 });
  try {
    expect(repeated).toBe(closing);
    await expect(late).rejects.toThrow('Conversation history worker stopped');
  } finally {
    released.release();
    await Promise.allSettled([closing, repeated, late]);
  }
  expect((await cache.readConversationHistoryPage('user', sourceFile, 1)).records[0].id).toBe('repeat-close');
  expect(fs.readFileSync(sourceFile)).toEqual(original);
});
