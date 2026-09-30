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
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const row = (id: string, output = '') => ({ id, from: 'commander', to: ['user'], ts: '2026-09-23',
  text: `完整消息 ${id} \\(x^2\\)`, process: [{ type: 'event', event: { stream: 'tool',
    data: { name: 'bash', phase: 'end', output } } }] });

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
