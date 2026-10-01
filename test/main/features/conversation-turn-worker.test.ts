import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConversationTurnPage } from '../../../src/main/features/conversation-turn-types';

// Worker threads load actual Node modules; these spies guard only the main
// process against accidentally importing the scanner/cache again.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createReadStream = vi.fn(actual.createReadStream);
  return { ...actual, createReadStream, default: { ...actual, createReadStream } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
let root: string;
let previous: string | undefined;
let client: typeof import('../../../src/main/features/conversation-history-client');
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-turn-worker-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  vi.clearAllMocks();
  client = await import('../../../src/main/features/conversation-history-client');
});
afterEach(async () => {
  await client.closeConversationHistoryWorker();
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function source(name = 'history', count = 32) {
  const file = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(file, Array.from({ length: count }, (_, i) => JSON.stringify({ id: `${name}-${i}`, from: 'user', text: `中文🌟 \\(x^2\\) ${i}` })).join('\n') + '\n');
  return file;
}
const turns = (file: string, before?: number, userId = 'user', projectIdHint?: string) => client.turnIndexRequest<ConversationTurnPage>({
  kind: 'turns', userId, cid: 'chat', sourceFile: file, before, projectIdHint,
});

it('returns only bounded preview pages from a real worker, including restart, without main source/index reads', async () => {
  const file = source();
  const fsp = await import('node:fs/promises');
  vi.mocked(fsp.readFile).mockClear();
  vi.mocked(fs.createReadStream).mockClear();
  const latest = await turns(file);
  expect(latest.total).toBe(32);
  expect(latest.turns).toHaveLength(15);
  expect(latest.turns[0]).toMatchObject({ messageId: 'history-17', turnNo: 18, messageIndex: 17, userPreview: '中文🌟 \\(x^2\\) 17' });
  const middle = await turns(file, latest.nextCursor!);
  const first = await turns(file, middle.nextCursor!);
  expect([...first.turns, ...middle.turns, ...latest.turns].map(t => t.messageIndex)).toEqual(Array.from({ length: 32 }, (_, i) => i));
  expect(first.nextCursor).toBeNull();
  expect((await turns(file, 0)).turns).toEqual([]);
  expect(await turns(file, 999)).toEqual(latest);
  await client.closeConversationHistoryWorker();
  expect(await turns(file)).toEqual(latest);
  expect(fs.createReadStream).not.toHaveBeenCalled();
  expect(fsp.readFile).not.toHaveBeenCalled();
});

it('isolates account/project owners and orders concurrent navigation reads before purge', async () => {
  const global = source('global', 1), project = source('project', 2), other = source('other', 3);
  expect((await turns(global)).turns[0].messageId).toBe('global-0');
  expect((await turns(project, undefined, 'user', 'project')).turns[0].messageId).toBe('project-0');
  expect((await turns(other, undefined, 'other')).turns[0].messageId).toBe('other-0');
  const { userConversationTurnIndexPath } = await import('../../../src/main/paths');
  const reads = Array.from({ length: 8 }, () => turns(global));
  const purge = client.turnIndexRequest({ kind: 'turn-purge', userId: 'user', cid: 'chat', sourceFile: '' });
  expect((await Promise.all(reads)).every(p => p.turns[0].messageId === 'global-0')).toBe(true);
  await purge;
  expect(fs.existsSync(userConversationTurnIndexPath('user', 'chat'))).toBe(false);
  expect(fs.existsSync(userConversationTurnIndexPath('other', 'chat'))).toBe(true);
  fs.unlinkSync(global);
  expect((await turns(global)).turns).toEqual([]);
  expect(fs.existsSync(userConversationTurnIndexPath('user', 'chat'))).toBe(false);
});

it('uses a different worker for interactive history and recovers an interrupted navigation scan', async () => {
  const file = source();
  const real = client.ConversationHistoryWorker.prototype.request;
  const threads = new Map<string, number>();
  let killed = false;
  const request = vi.spyOn(client.ConversationHistoryWorker.prototype, 'request').mockImplementation(function(command) {
    threads.set(command.kind, (this as any).worker.threadId);
    const pending = real.call(this, command);
    if (command.kind === 'turns' && !killed) {
      killed = true;
      void (this as any).worker.terminate();
    }
    return pending;
  });
  const interrupted = turns(file);
  const page = client.historyRequest<any>({ kind: 'page', userId: 'user', sourceFile: file, limit: 1 });
  await expect(interrupted).rejects.toThrow('worker stopped');
  expect((await page).records[0].id).toBe('history-31');
  expect(threads.get('turns')).not.toBe(threads.get('page'));
  request.mockRestore();
  expect((await turns(file)).total).toBe(32);
});

it('bounds navigation bursts and closes every pending caller before allowing a fresh lane', async () => {
  const file = source();
  const requests = Array.from({ length: 129 }, () => turns(file));
  const settled = Promise.allSettled(requests);
  await Promise.all([client.closeConversationHistoryWorker(), client.closeConversationHistoryWorker()]);
  const results = await settled;
  expect(results.every(r => r.status === 'rejected')).toBe(true);
  expect((results[128] as PromiseRejectedResult).reason.message).toBe('Conversation history worker busy');
  expect((await turns(file)).total).toBe(32);
});

it('does not resurrect a lane when shutdown overtakes an interrupted-worker restart', async () => {
  const file = source();
  const real = client.ConversationHistoryWorker.prototype.request;
  let navigation: InstanceType<typeof client.ConversationHistoryWorker> | undefined;
  vi.spyOn(client.ConversationHistoryWorker.prototype, 'request').mockImplementation(function(command) {
    navigation = this;
    return real.call(this, command);
  });
  await turns(file);
  const closing = navigation!.close();
  const restarting = turns(file);
  const rejected = expect(restarting).rejects.toThrow('worker stopped');
  await client.closeConversationHistoryWorker();
  await closing;
  await rejected;
  expect((await turns(file)).total).toBe(32);
});

it('releases an idle navigation heap and reloads the persisted index on the next visit', async () => {
  const file = source();
  const real = client.ConversationHistoryWorker.prototype.request;
  let navigation: InstanceType<typeof client.ConversationHistoryWorker> | undefined;
  vi.spyOn(client.ConversationHistoryWorker.prototype, 'request').mockImplementation(function(command) {
    navigation = this;
    return real.call(this, command);
  });
  const first = await turns(file);
  const initial = navigation!;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    expect(await turns(file)).toEqual(first);
    vi.advanceTimersByTime(30_000);
    expect(initial.available).toBe(false);
  } finally { vi.useRealTimers(); }
  await initial.close();
  expect(await turns(file)).toEqual(first);
  expect(navigation).not.toBe(initial);
});

it('waits for an explicitly closing index writer to exit before a new read creates its replacement', async () => {
  const file = source();
  const real = client.ConversationHistoryWorker.prototype.request;
  let first: InstanceType<typeof client.ConversationHistoryWorker> | undefined;
  let exited = false, replacementBeforeExit = false;
  vi.spyOn(client.ConversationHistoryWorker.prototype, 'request').mockImplementation(function(command) {
    if (!first) first = this;
    else if (this !== first && !exited) replacementBeforeExit = true;
    return real.call(this, command);
  });
  await turns(file);
  (first as any).worker.once('exit', () => { exited = true; });
  const closing = client.closeConversationHistoryWorker();
  const next = turns(file);
  await closing;
  expect((await next).total).toBe(32);
  expect(exited).toBe(true);
  expect(replacementBeforeExit).toBe(false);
});
