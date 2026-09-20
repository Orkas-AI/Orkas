import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const gate = vi.hoisted(() => ({ wait: null as Promise<void> | null, entered: null as (() => void) | null }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const readFile = async (...args: any[]) => {
    if (String(args[0]).endsWith('c2.jsonl') && gate.wait) {
      gate.entered?.();
      await gate.wait;
    }
    return (actual.readFile as any)(...args);
  };
  return { ...actual, readFile, default: { ...actual, readFile } };
});
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
let root: string;
let oldRoot: string | undefined;
function write(cid: string, text: string) {
  const file = path.join(root, 'u1/cloud/chats', `${cid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ role: 'user', content: text, time: 't' }) + '\n');
}
function hold() {
  let release!: () => void;
  gate.wait = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { gate.entered = r; });
  return { release, entered };
}
beforeEach(async () => {
  oldRoot = process.env.ORKAS_WORKSPACE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-migration-probe-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  gate.wait = null;
  gate.entered = null;
  (await import('../../../../src/main/features/users')).activateUser('u1');
});
afterEach(async () => {
  const search = await import('../../../../src/main/features/search');
  search.__searchTestHooks.cancelChatRepair('u1');
  (await import('../../../../src/main/util/boot_init'))._resetForTests();
  await search.flushAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env.ORKAS_WORKSPACE_ROOT = oldRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

function legacySnapshot() {
  const file = path.join(root, 'u1/local/search/chats.idx.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
  fs.writeFileSync(`${file}.tmp`, 'interrupted old flush');
  return file;
}

it('keeps the old files on interruption and resumes a large conversation after restart', async () => {
  const messages = Array.from({ length: 70 }, (_, i) => ({ role: 'user', content: `record${i}`, time: 't' }));
  write('c1', 'placeholder');
  fs.writeFileSync(path.join(root, 'u1/cloud/chats/c1.jsonl'), messages.map(m => JSON.stringify(m)).join('\n') + '\n');
  const legacy = legacySnapshot();
  const search = await import('../../../../src/main/features/search');
  const ix = await import('../../../../src/main/features/search/indexer');
  const store = await import('../../../../src/main/features/search/chat_store');
  const controller = new AbortController();
  const real = store.writeRebuildBatch;
  const spy = vi.spyOn(store, 'writeRebuildBatch').mockImplementation((...args) => {
    real(...args); controller.abort();
  });
  expect((await ix.reconcileChatsIndex('u1', controller.signal)).complete).toBe(false);
  expect(store.docCount('u1')).toBe(16);
  expect(store.readFileWatermark('u1', 'c1')).toBeUndefined();
  expect(store.readRebuildCursor('u1', 'c1')?.next).toBe(16);
  expect(fs.existsSync(legacy)).toBe(true);
  expect(fs.existsSync(`${legacy}.tmp`)).toBe(true);
  spy.mockRestore();
  await search.flushAll();
  vi.resetModules();
  const resumedStore = await import('../../../../src/main/features/search/chat_store');
  const resumedIx = await import('../../../../src/main/features/search/indexer');
  const batches = vi.spyOn(resumedStore, 'writeRebuildBatch');
  expect((await resumedIx.reconcileChatsIndex('u1')).complete).toBe(true);
  expect(batches.mock.calls[0][2][0].msgIndex, 'resume the committed prefix, not a fresh rebuild').toBe(16);
  expect(resumedStore.docCount('u1')).toBe(70);
  expect(resumedStore.postingsFor('u1', 'record0')).toHaveLength(1);
  expect(resumedStore.postingsFor('u1', 'record69')).toHaveLength(1);
  expect(fs.existsSync(legacy)).toBe(false);
  expect(fs.existsSync(`${legacy}.tmp`)).toBe(false);
  expect(resumedStore.hasCompletedRebuild('u1')).toBe(true);
});

it('defers new messages without blocking search and catches them up before marking ready', async () => {
  write('c1', 'oldmarker'); write('c2', 'historymarker');
  const legacy = legacySnapshot();
  const search = await import('../../../../src/main/features/search');
  const ix = await import('../../../../src/main/features/search/indexer');
  const store = await import('../../../../src/main/features/search/chat_store');
  const h = hold();
  const migrating = ix.reconcileChatsIndex('u1');
  await h.entered;
  const msg = { role: 'user', content: 'freshmarker', time: 't2' };
  fs.appendFileSync(path.join(root, 'u1/cloud/chats/c1.jsonl'), JSON.stringify(msg) + '\n');
  ix.indexChatMessageDeferred('u1', 'c1', 1, msg);
  try {
    // These promises must settle while the source read is still parked.
    await ix.drainDeferredChatWrites();
    expect(store.postingsFor('u1', 'freshmarker')).toHaveLength(0);
    expect(await search.searchChatsWithStatus('u1', 'freshmarker')).toEqual({ results: [], indexComplete: false });
    expect((await search.searchChatsWithStatus('u1', 'oldmarker')).results).toHaveLength(1);
    expect(fs.existsSync(legacy)).toBe(true);
  } finally { h.release(); }
  expect((await migrating).complete).toBe(false);
  expect(store.hasCompletedRebuild('u1')).toBe(false);
  expect((await ix.reconcileChatsIndex('u1')).complete).toBe(true);
  expect((await search.searchChatsWithStatus('u1', 'freshmarker')).results).toHaveLength(1);
  expect(fs.existsSync(legacy)).toBe(false);
  const live = { role: 'user', content: 'livemarker', time: 't3' };
  fs.appendFileSync(path.join(root, 'u1/cloud/chats/c1.jsonl'), JSON.stringify(live) + '\n');
  ix.indexChatMessageDeferred('u1', 'c1', 2, live);
  expect((await search.searchChatsWithStatus('u1', 'livemarker')).indexComplete).toBe(true);
  expect(store.postingsFor('u1', 'livemarker')).toHaveLength(1);
});

it('defers an append before startup migration even when it targets an unindexed old conversation', async () => {
  write('c1', 'oldmarker'); legacySnapshot();
  const ix = await import('../../../../src/main/features/search/indexer');
  const store = await import('../../../../src/main/features/search/chat_store');
  const msg = { role: 'user', content: 'newmarker', time: 't2' };
  fs.appendFileSync(path.join(root, 'u1/cloud/chats/c1.jsonl'), JSON.stringify(msg) + '\n');
  await ix.indexChatMessage('u1', 'c1', 1, msg);
  expect(store.docCount('u1')).toBe(0);
  expect(ix.hasPendingChatRepair('u1')).toBe(true);
  await ix.reconcileChatsIndex('u1');
  expect(store.docCount('u1')).toBe(2);
});

it('does not rebuild a cold index on the search path and returns coverage to global search', async () => {
  write('c1', 'coldmarker');
  const boot = await import('../../../../src/main/util/boot_init');
  boot.configureBootAdmission({ isRuntimeBusy: () => true });
  const search = await import('../../../../src/main/features/search');
  const store = await import('../../../../src/main/features/search/chat_store');
  const page = await search.searchAll('u1', 'coldmarker', { scope: 'chat' });
  expect(page).toMatchObject({ results: [], chat_index_complete: false });
  expect(store.docCount('u1')).toBe(0);
  expect(search.__searchTestHooks.hasPendingChatRepair('u1')).toBe(true);
});

it('automatically resumes an interrupted startup slice only after the runtime becomes idle', async () => {
  write('c1', 'firstmarker'); write('c2', 'lastmarker'); legacySnapshot();
  const search = await import('../../../../src/main/features/search');
  const store = await import('../../../../src/main/features/search/chat_store');
  const boot = await import('../../../../src/main/util/boot_init');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 5_000);
  let busy = false;
  boot.configureBootAdmission({ isRuntimeBusy: () => busy });
  const controller = new AbortController();
  const real = store.writeRebuildBatch;
  const spy = vi.spyOn(store, 'writeRebuildBatch').mockImplementationOnce((...args) => {
    real(...args); controller.abort(); busy = true;
  });
  await search.reconcileActive(controller.signal);
  expect(store.hasCompletedRebuild('u1')).toBe(false);
  expect(search.__searchTestHooks.hasPendingChatRepair('u1')).toBe(true);
  await new Promise(r => setTimeout(r, 1_100));
  expect(store.hasCompletedRebuild('u1')).toBe(false);
  busy = false;
  await vi.waitFor(() => expect(store.hasCompletedRebuild('u1')).toBe(true), { timeout: 4_000 });
  expect(store.postingsFor('u1', 'lastmarker')).toHaveLength(1);
  spy.mockRestore();
});

it('rechecks a sync replacement and deletion that arrive while another file is migrating', async () => {
  write('c1', 'obsoleteword'); write('c2', 'deletedword'); legacySnapshot();
  const ix = await import('../../../../src/main/features/search/indexer');
  const search = await import('../../../../src/main/features/search');
  const store = await import('../../../../src/main/features/search/chat_store');
  const h = hold();
  const run = ix.reconcileChatsIndex('u1');
  await h.entered;
  write('c1', 'synchronizedword');
  fs.unlinkSync(path.join(root, 'u1/cloud/chats/c2.jsonl'));
  search.invalidateChatsIndex('u1');
  await ix.dropChatConversation('u1', 'c2');
  h.release();
  expect((await run).complete).toBe(false);
  expect((await ix.reconcileChatsIndex('u1')).complete).toBe(true);
  expect(store.postingsFor('u1', 'obsoleteword')).toHaveLength(0);
  expect(store.postingsFor('u1', 'deletedword')).toHaveLength(0);
  expect(store.postingsFor('u1', 'synchronizedword')).toHaveLength(1);
});

it('preserves old files and retries after a failed batch instead of declaring success', async () => {
  write('c1', 'recoverymarker');
  const legacy = legacySnapshot();
  const search = await import('../../../../src/main/features/search');
  const store = await import('../../../../src/main/features/search/chat_store');
  vi.spyOn(store, 'writeRebuildBatch').mockImplementationOnce(() => { throw new Error('injected write failure'); });
  await search.reconcileActive();
  expect(store.hasCompletedRebuild('u1')).toBe(false);
  expect(fs.existsSync(legacy)).toBe(true);
  expect(search.__searchTestHooks.hasPendingChatRepair('u1')).toBe(true);
  await search.reconcileActive();
  expect(store.hasCompletedRebuild('u1')).toBe(true);
  expect(store.postingsFor('u1', 'recoverymarker')).toHaveLength(1);
  expect(fs.existsSync(legacy)).toBe(false);
});

it('schedules local catch-up after sync without requiring a search', async () => {
  write('c1', 'originalword');
  const ix = await import('../../../../src/main/features/search/indexer');
  const search = await import('../../../../src/main/features/search');
  const store = await import('../../../../src/main/features/search/chat_store');
  const boot = await import('../../../../src/main/util/boot_init');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 5_000);
  await ix.reconcileChatsIndex('u1');
  write('c1', 'pulledword');
  search.invalidateChatsIndex('u1');
  expect(ix.isChatsIndexTrusted('u1')).toBe(false);
  await vi.waitFor(() => expect(store.postingsFor('u1', 'pulledword')).toHaveLength(1), { timeout: 4_000 });
  expect(store.postingsFor('u1', 'originalword')).toHaveLength(0);
});

it('does not certify a source replaced after its read but before its final batch settles', async () => {
  write('c1', 'oldsourceword');
  const legacy = legacySnapshot();
  const ix = await import('../../../../src/main/features/search/indexer');
  const store = await import('../../../../src/main/features/search/chat_store');
  const real = store.writeRebuildBatch;
  vi.spyOn(store, 'writeRebuildBatch').mockImplementationOnce((...args) => {
    real(...args);
    // A sync file write can precede the end-of-pass invalidation event.
    write('c1', 'replacementword');
  });
  expect((await ix.reconcileChatsIndex('u1')).complete).toBe(false);
  expect(fs.existsSync(legacy)).toBe(true);
  expect((await ix.reconcileChatsIndex('u1')).complete).toBe(true);
  expect(store.postingsFor('u1', 'oldsourceword')).toHaveLength(0);
  expect(store.postingsFor('u1', 'replacementword')).toHaveLength(1);
});
