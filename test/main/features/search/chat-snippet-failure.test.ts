import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const state = vi.hoisted(() => ({ workers: [] as any[], warn: vi.fn() }));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ warn: state.warn }) }));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    commands: any[] = [];
    constructor() { super(); state.workers.push(this); }
    ref() {}
    unref() {}
    postMessage(command: unknown) { this.commands.push(command); }
    terminate() { return Promise.resolve(0); }
  },
}));

afterEach(async () => {
  await (await import('../../../../src/main/features/search/chat-snippets')).closeChatSnippetReader();
  vi.restoreAllMocks();
});

it('fails pending and queued reads on worker failure without leaking source details or causing a restart storm', async () => {
  const { readChatSnippets } = await import('../../../../src/main/features/search/chat-snippets');
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const pending = Promise.allSettled(Array.from({ length: 20 }, () => readChatSnippets('source', new Set([0]), ['needle'])));
  await vi.waitFor(() => expect(state.workers[0]?.commands).toHaveLength(4));
  state.workers[0].emit('error', new Error('private source content'));
  const outcomes = await pending;
  expect(outcomes.every(result => result.status === 'rejected')).toBe(true);
  expect(outcomes.map(result => result.status === 'rejected' ? String(result.reason) : '').join(' ')).not.toContain('private');
  expect(state.workers).toHaveLength(1);
  expect(state.warn.mock.calls).toEqual([['chat snippet worker stopped; retry deferred']]);
  now += 30_001;
  const recovered = readChatSnippets('source', new Set([0]), ['needle']);
  await vi.waitFor(() => expect(state.workers).toHaveLength(2));
  const command = state.workers[1].commands[0];
  state.workers[1].emit('message', { id: command.id, rows: [[0, { snippet: 'needle', visible: true }]] });
  expect((await recovered).get(0)?.snippet).toBe('needle');
});

it.each([false, true])('lets another conversation finish while its neighbor is held or fails (failure=%s)', async failure => {
  const { readChatSnippets } = await import('../../../../src/main/features/search/chat-snippets');
  const before = state.workers.length;
  const slow = readChatSnippets('slow-source', new Set([0]), ['needle']);
  const fast = readChatSnippets('fast-source', new Set([0]), ['needle']);
  const settled = Promise.allSettled([slow, fast]);
  try {
    await vi.waitFor(() => expect(state.workers.length - before).toBe(2));
    if (failure) state.workers.slice(before).find(worker => worker.commands.some(command => command.file === 'slow-source'))
      .emit('error', new Error('private failed neighbor'));
    const fastWorker = state.workers.slice(before).find(worker => worker.commands.some(command => command.file === 'fast-source'));
    const command = fastWorker.commands.find(command => command.file === 'fast-source');
    fastWorker.emit('message', { id: command.id, rows: [[0, { snippet: 'fast needle', visible: true }]] });
    expect((await fast).get(0)?.snippet).toBe('fast needle');
    if (failure) {
      const fresh = readChatSnippets('fresh-source', new Set([0]), ['needle']).catch(() => undefined);
      await vi.waitFor(() => expect(fastWorker.commands.some(command => command.file === 'fresh-source')).toBe(true));
      const command = fastWorker.commands.find(command => command.file === 'fresh-source');
      fastWorker.emit('message', { id: command.id, rows: [[0, { snippet: 'fresh needle', visible: true }]] });
      expect((await fresh)?.get(0)?.snippet).toBe('fresh needle');
      expect(state.workers.length - before).toBe(2);
    }
  } finally {
    for (const worker of state.workers.slice(before)) for (const command of worker.commands) {
      worker.emit('message', { id: command.id, rows: [] });
    }
    await settled;
  }
});
