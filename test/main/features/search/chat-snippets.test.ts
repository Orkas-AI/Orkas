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
  expect(Math.max(...gaps)).toBeLessThan(300);
  console.info('search snippet worker performance', JSON.stringify({ source_bytes: fs.statSync(file).size,
    elapsed_ms: Math.round(performance.now() - started), main_max_gap_ms: Math.round(Math.max(...gaps)),
    response_chars: JSON.stringify([...rows]).length }));
});
