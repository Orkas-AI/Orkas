import { BULK_MAIN_GAP_LIMIT_MS } from '../../../helpers/latency-budget';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-snippets-')); });
afterEach(async () => {
  await (await import('../../../../src/main/features/search/chat-snippets')).closeChatSnippetReader();
  fs.rmSync(root, { recursive: true, force: true });
});
const body = (text: string) => JSON.stringify({ id: 'message', text }) + '\n';

it('releases an active cancelled read and allows a replacement query to finish', async () => {
  const { readChatSnippets } = await import('../../../../src/main/features/search/chat-snippets');
  const file = path.join(root, 'cancel.jsonl');
  fs.writeFileSync(file, body('needle ' + 'large '.repeat(5_000_000)));
  const controller = new AbortController();
  const old = readChatSnippets(file, new Set([0]), ['needle'], controller.signal);
  // Dispatch the read before cancelling, covering work already sent to a worker.
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  expect((await old).size).toBe(0);
  const next = path.join(root, 'next.jsonl'); fs.writeFileSync(next, body('replacement'));
  expect((await readChatSnippets(next, new Set([0]), ['replacement'])).get(0)?.snippet).toBe('replacement');
});

it('keeps another request on the same source alive when one consumer cancels', async () => {
  const { readChatSnippets } = await import('../../../../src/main/features/search/chat-snippets');
  const file = path.join(root, 'shared.jsonl'); fs.writeFileSync(file, body('needle shared'));
  const controller = new AbortController();
  const first = readChatSnippets(file, new Set([0]), ['needle'], controller.signal);
  const retained = readChatSnippets(file, new Set([0]), ['shared']);
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  expect((await first).size).toBe(0);
  expect((await retained).get(0)?.snippet).toBe('needle shared');
});

it('refreshes cached snippets after append, same-size replacement and deletion, isolated by source', async () => {
  const { readChatSnippets } = await import('../../../../src/main/features/search/chat-snippets');
  const file = path.join(root, 'first.jsonl'), other = path.join(root, 'second.jsonl');
  fs.writeFileSync(file, body('needle old')); fs.writeFileSync(other, body('needle elsewhere'));
  const read = (source = file) => readChatSnippets(source, new Set([0, 1]), ['needle']);
  expect((await read()).get(0)?.snippet).toBe('needle old');
  expect((await read()).get(0)?.snippet).toBe('needle old');
  expect((await read(other)).get(0)?.snippet).toBe('needle elsewhere');
  fs.appendFileSync(file, body('needle appended'));
  expect((await read()).get(1)?.snippet).toBe('needle appended');
  fs.writeFileSync(path.join(root, 'replacement'), body('needle new'));
  fs.renameSync(path.join(root, 'replacement'), file);
  expect([...(await read()).values()].map(row => row?.snippet)).toEqual(['needle new']);
  // The awaited response owns no open source stream, including on Windows.
  fs.unlinkSync(file);
  expect((await read()).size).toBe(0);
});

it('releases a queued batch at shutdown and can open a fresh reader afterwards', async () => {
  const { readChatSnippets, closeChatSnippetReader } = await import('../../../../src/main/features/search/chat-snippets');
  const file = path.join(root, 'queue.jsonl'); fs.writeFileSync(file, body('needle'));
  const requests = Array.from({ length: 20 }, () => readChatSnippets(file, new Set([0]), ['needle']));
  // Attach handlers before closing to prove cancellation cannot leak rejected
  // promises or leave queued reads resurrecting a worker after shutdown.
  const settled = Promise.allSettled(requests);
  await closeChatSnippetReader();
  expect((await settled).every(result => result.status === 'rejected')).toBe(true);
  expect((await readChatSnippets(file, new Set([0]), ['needle'])).get(0)?.snippet).toBe('needle');
});

it('returns bounded snippets and keeps main responsive while parsing a large cold execution record', async () => {
  const { readChatSnippets } = await import('../../../../src/main/features/search/chat-snippets');
  const file = path.join(root, 'large.jsonl');
  const prefix = 'needle ' + 'visible '.repeat(40);
  const event = (output: string) => ({ type: 'event', event: { stream: 'tool', data: { output } } });
  fs.writeFileSync(file, JSON.stringify({ id: 'large', text: prefix, process: [
    event(prefix), event('unrelated '.repeat(3_000_000)),
  ] }) + '\n');
  const gaps: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 5);
  const started = performance.now();
  let rows;
  try { rows = await readChatSnippets(file, new Set([0]), ['needle']); }
  finally { clearInterval(timer); }
  expect(rows.get(0)).toMatchObject({ msg_id: 'large', visible: true, has_process: true });
  expect(rows.get(0)?.snippet).toContain('needle');
  expect(rows.get(0)?.process_snippet).toContain('needle');
  expect(JSON.stringify([...rows]).length).toBeLessThan(512);
  expect(gaps.length).toBeGreaterThan(3);
  expect(Math.max(...gaps)).toBeLessThan(BULK_MAIN_GAP_LIMIT_MS);
  console.info('search snippet worker performance', JSON.stringify({ source_bytes: fs.statSync(file).size,
    elapsed_ms: Math.round(performance.now() - started), main_max_gap_ms: Math.round(Math.max(...gaps)),
    response_chars: JSON.stringify([...rows]).length }));
});

it('measures an independent conversation behind multiple large cold histories', async () => {
  const { readChatSnippets } = await import('../../../../src/main/features/search/chat-snippets');
  const largeBody = JSON.stringify({ id: 'large', text: 'needle body', process: [
    { type: 'event', event: { stream: 'tool', data: { output: 'unrelated '.repeat(2_000_000) } } },
  ] }) + '\n';
  const files = ['large-a', 'large-b', 'small'].map(name => path.join(root, name + '.jsonl'));
  files.forEach((file, index) => fs.writeFileSync(file, index < 2 ? largeBody : body('needle small')));
  const cpu = process.cpuUsage(), started = performance.now();
  let fastMs = 0;
  const reads = files.map((file, index) => readChatSnippets(file, new Set([0]), ['needle']).then(rows => {
    if (index === 2) fastMs = performance.now() - started;
    expect(rows.get(0)?.snippet).toContain('needle');
  }));
  await Promise.all(reads);
  const used = process.cpuUsage(cpu);
  console.info('parallel conversation measurement', JSON.stringify({ files: 3, large_source_bytes: fs.statSync(files[0]).size,
    fast_ms: Math.round(fastMs), total_ms: Math.round(performance.now() - started), cpu_ms: Math.round((used.user + used.system) / 1000),
    rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024) }));
});
