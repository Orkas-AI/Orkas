import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

// Pass-through by default. One case needs to hold a single `stat` so two
// deferred upserts would reach the index out of order; the namespace of a
// built-in cannot be spied, so the seam lives here.
const statHook = vi.hoisted(() => ({ holdNextChatStat: false, holdMs: 40 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const stat = (async (target: unknown, ...rest: unknown[]) => {
    if (statHook.holdNextChatStat && String(target).endsWith('c1.jsonl')) {
      statHook.holdNextChatStat = false;
      await new Promise((resolve) => setTimeout(resolve, statHook.holdMs));
    }
    return (actual.stat as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof actual.stat;
  return { ...actual, default: { ...actual, stat }, stat };
});

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// indexer.ts pulls path constants from paths.ts at module load. Each test sets
// ORKAS_WORKSPACE_ROOT before resetting the module graph so a fresh tmp WS
// is in effect. Flush the previous indexer before resetting its module graph;
// resetModules alone does not cancel its delayed writes.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-indexer-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  await (await loadIndexer()).flushAll();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadIndexer() {
  return import('../../../../src/main/features/search/indexer');
}

// The chat index moved from a JSON snapshot to `chat_store`; these read the
// same facts the cases used to read off `entry.idx`.
async function loadChatStore() {
  return import('../../../../src/main/features/search/chat_store');
}
async function chatDocIds(uid = 'u1'): Promise<string[]> {
  return (await loadChatStore())._allDocsForTests(uid).map((d) => d.docId);
}
async function chatDoc(uid: string, cid: string, msgIndex: number) {
  return (await loadChatStore())._allDocsForTests(uid)
    .find((d) => d.cid === cid && d.msgIndex === msgIndex);
}
async function chatTermIsIndexed(uid: string, term: string): Promise<boolean> {
  return (await loadChatStore()).postingsFor(uid, term).length > 0;
}

function writeContext(rel: string, body: string): void {
  const full = path.join(tmpDir, TEST_UID, 'cloud', 'contexts', rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function writeChat(uid: string, cid: string, messages: unknown[]): void {
  const dir = path.join(tmpDir, uid, 'cloud', 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cid}.jsonl`);
  fs.writeFileSync(file, messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
}

function appendChat(uid: string, cid: string, message: unknown): void {
  const file = path.join(tmpDir, uid, 'cloud', 'chats', `${cid}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(message) + '\n');
}

describe('search/indexer › reconcileContextsIndex', () => {
  it('returns silently when CONTEXTS_DIR is missing', async () => {
    const ix = await loadIndexer();
    await expect(ix.reconcileContextsIndex()).resolves.toEqual({ scanned: 0, updated: 0, deleted: 0 });
  });

  it('indexes files by relPath (directory + filename), not body content', async () => {
    writeContext('notes.md', '# Hello World\n\nSome body text with keyword foobar.');
    writeContext('sub/recipe.md', '# Second\n\nmore content');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();

    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(Object.keys(entry.idx.files).sort()).toEqual(['notes.md', 'sub/recipe.md']);
    // title is basename — no body read, no first-heading lookup
    expect(entry.idx.docs['notes.md']?.title).toBe('notes.md');
    expect(entry.idx.docs['sub/recipe.md']?.title).toBe('recipe.md');
    // path tokens are indexed (directory + filename stem)
    expect(entry.idx.postings['notes']).toBeDefined();
    expect(entry.idx.postings['sub']).toBeDefined();
    expect(entry.idx.postings['recipe']).toBeDefined();
    // body tokens are NOT indexed
    expect(entry.idx.postings['foobar']).toBeUndefined();
    expect(entry.idx.postings['hello']).toBeUndefined();
  });

  it('includes non-markdown files (pdf/docx/images) by filename', async () => {
    writeContext('annual-report.pdf', 'BINARY');
    writeContext('slides/q4.docx', 'BINARY');
    writeContext('photo.jpg', 'BINARY');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(Object.keys(entry.idx.files).sort()).toEqual(['annual-report.pdf', 'photo.jpg', 'slides/q4.docx']);
    expect(entry.idx.postings['annual']).toBeDefined();
    expect(entry.idx.postings['report']).toBeDefined();
    expect(entry.idx.postings['slides']).toBeDefined();
    expect(entry.idx.postings['photo']).toBeDefined();
  });

  it('drops docs whose source file disappeared', async () => {
    writeContext('a.md', '# A\nbody alpha');
    writeContext('b.md', '# B\nbody beta');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    fs.rmSync(path.join(tmpDir, TEST_UID, 'cloud', 'contexts', 'b.md'));
    await ix.reconcileContextsIndex();
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(entry.idx.files['b.md']).toBeUndefined();
    expect(entry.idx.docs['b.md']).toBeUndefined();
  });

  it('skips files whose mtime+size matches a prior run', async () => {
    writeContext('a.md', '# A\nunchanged');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    const firstTokens = Object.keys(entry.idx.postings).length;
    // Second reconcile shouldn't duplicate postings
    await ix.reconcileContextsIndex();
    const secondTokens = Object.keys(entry.idx.postings).length;
    expect(secondTokens).toBe(firstTokens);
    // posting list for any token should still only have one entry for this doc
    for (const list of Object.values(entry.idx.postings)) {
      expect(list.filter((e) => e[0] === 'a.md').length).toBeLessThanOrEqual(1);
    }
  });

  it('ignores dotfiles and _INDEX.md', async () => {
    writeContext('_INDEX.md', '# index');
    writeContext('.hidden.md', '# hidden');
    writeContext('visible.md', '# visible');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(Object.keys(entry.idx.files)).toEqual(['visible.md']);
  });

  it('does not delete context docs from a cancelled partial scan', async () => {
    writeContext('a.md', '# A');
    writeContext('b.md', '# B');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    fs.rmSync(path.join(tmpDir, TEST_UID, 'cloud', 'contexts', 'b.md'));
    const controller = new AbortController();
    controller.abort();

    const result = await ix.reconcileContextsIndex(TEST_UID, controller.signal);
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(result.cancelled).toBe(true);
    expect(entry.idx.docs['b.md']).toBeDefined();
  });
});

describe('search/indexer › reconcileChatsIndex', () => {
  it('returns silently when user has no chats dir', async () => {
    const ix = await loadIndexer();
    await expect(ix.reconcileChatsIndex('u1')).resolves.toEqual({ scanned: 0, updated: 0, deleted: 0, complete: true });
  });

  it('indexes each jsonl message as a separate doc', async () => {
    writeChat('u1', 'c1', [
      { role: 'user', content: 'tell me about foobar', time: 't1' },
      { role: 'assistant', content: 'foobar is great', time: 't2' },
    ]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');
    expect((await chatDocIds()).sort()).toEqual(['chat:c1:0', 'chat:c1:1']);
    expect((await loadChatStore()).postingsFor('u1', 'foobar')).toHaveLength(2);  // two docs
  });

  it('uses the compact conversation catalog to validate a reconciled snapshot', async () => {
    writeChat('u1', 'c1', [{ role: 'user', content: 'catalog marker', time: 't' }]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');

    expect(await ix.isChatsIndexCurrent('u1')).toBe(true);

    // Normal app writes and sync pulls update the aggregate index. That
    // lightweight change must make the query path choose a full reconcile.
    fs.writeFileSync(path.join(tmpDir, 'u1', 'cloud', 'chats', '_index.json'), JSON.stringify([
      { conversation_id: 'c1', title: 'renamed by sync' },
    ]));
    expect(await ix.isChatsIndexCurrent('u1')).toBe(false);
  });

  it('skips messages with empty or non-string content', async () => {
    writeChat('u1', 'c1', [
      { role: 'user', content: '', time: 't1' },
      { role: 'system', content: 42, time: 't2' },
      { role: 'user', content: 'real text here', time: 't3' },
    ]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');
    expect(await chatDocIds()).toEqual(['chat:c1:2']);
  });

  it('does not delete chat docs from a cancelled partial scan', async () => {
    writeChat('u1', 'c1', [{ role: 'user', content: 'one', time: 't' }]);
    writeChat('u1', 'c2', [{ role: 'user', content: 'two', time: 't' }]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');
    fs.rmSync(path.join(tmpDir, 'u1', 'cloud', 'chats', 'c2.jsonl'));
    const controller = new AbortController();
    controller.abort();

    const result = await ix.reconcileChatsIndex('u1', controller.signal);
    expect(result.cancelled).toBe(true);
    expect(await chatDocIds()).toContain('chat:c2:0');
  });
});

// A conversation is only searchable if every message in it was read at least
// once. The incremental writer sees one message but records the whole file's
// mtime+size, which is also the only thing `reconcileChatsIndex` looks at to
// decide "already indexed" — so a file the reconciler never finished can be
// certified complete by the next message the user sends, and the rest of that
// conversation stops being searchable with no error anywhere. Observed in the
// field as a 260-message conversation with only its last 16 messages indexed.
describe('search/indexer › chat index completeness across incremental appends', () => {
  it('closes snippet readers before returning an early history match', async () => {
    writeChat(TEST_UID, 'c1', [
      { from: 'user', text: 'quokka first match' },
      { from: 'user', text: 'unrelated trailing row' },
    ]);
    await (await loadIndexer()).reconcileChatsIndex(TEST_UID);
    const search = await import('../../../../src/main/features/search/index');
    const reader = vi.mocked(fs.createReadStream);
    reader.mockClear();
    const hits = await search.searchChats(TEST_UID, 'quokka');
    const streams = reader.mock.results.filter(result => result.type === 'return')
      .map(result => result.value as fs.ReadStream);
    try {
      expect(hits.map(hit => hit.msg_index)).toEqual([0]);
      expect(streams.length).toBeGreaterThan(0);
      expect(streams.every(stream => stream.closed)).toBe(true);
    } finally {
      await Promise.all(streams.filter(stream => !stream.closed)
        .map(stream => new Promise<void>(resolve => stream.once('close', resolve))));
    }
  });

  it('keeps history the index never read reachable after a later message arrives', async () => {
    // History exists on disk but no reconcile ever covered this file.
    writeChat('u1', 'c1', [
      { from: 'user', ts: 't1', text: 'quokka research notes' },
      { from: 'commander', ts: 't2', text: 'quokka habitat summary' },
    ]);
    const ix = await loadIndexer();

    // The user sends one more message; only the hot path sees it.
    appendChat('u1', 'c1', { from: 'user', ts: 't3', text: 'unrelated followup' });
    await ix.indexChatMessage('u1', 'c1', 2, { from: 'user', ts: 't3', text: 'unrelated followup' });
    await ix.reconcileChatsIndex('u1');

    const s = await import('../../../../src/main/features/search/index');
    const hits = await s.searchChats('u1', 'quokka');
    expect(hits.map((hit) => hit.msg_index).sort()).toEqual([0, 1]);
  });

  it('leaves a contiguous append certified so reconcile does not re-read the file', async () => {
    writeChat('u1', 'c1', [{ from: 'user', ts: 't1', text: 'first message' }]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');

    appendChat('u1', 'c1', { from: 'commander', ts: 't2', text: 'second message' });
    await ix.indexChatMessage('u1', 'c1', 1, { from: 'commander', ts: 't2', text: 'second message' });

    // Re-tokenizing a multi-megabyte conversation on every search is exactly
    // what the incremental writer exists to avoid; the fix must not cost that.
    await expect(ix.reconcileChatsIndex('u1')).resolves.toMatchObject({ updated: 0 });
  });

  it('hands the file back to the reconciler when an append skips a position', async () => {
    writeChat('u1', 'c1', [{ from: 'user', ts: 't1', text: 'first message' }]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');

    // Message 1 never reached the index (failed write, crash, foreign writer);
    // message 2 must not certify the file over that hole.
    appendChat('u1', 'c1', { from: 'commander', ts: 't2', text: 'lost porcupine message' });
    appendChat('u1', 'c1', { from: 'user', ts: 't3', text: 'later message' });
    await ix.indexChatMessage('u1', 'c1', 2, { from: 'user', ts: 't3', text: 'later message' });

    expect(await ix.isChatsIndexCurrent('u1')).toBe(false);
    await expect(ix.reconcileChatsIndex('u1')).resolves.toMatchObject({ updated: 1 });
    const s = await import('../../../../src/main/features/search/index');
    expect(await s.searchChats('u1', 'porcupine')).toHaveLength(1);
  });
});

describe('search/indexer › indexChatMessage (hot path)', () => {
  it('adds a doc for the appended message without re-reading the jsonl', async () => {
    writeChat('u1', 'c1', [{ role: 'user', content: 'existing', time: 't1' }]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');

    // Append index 1 directly — simulates the chats.appendMessage hook
    await ix.indexChatMessage('u1', 'c1', 1, {
      role: 'assistant',
      content: 'fresh keyword',
      time: 't2',
    });
    expect(await chatDocIds()).toContain('chat:c1:1');
    expect(await chatTermIsIndexed('u1', 'fresh')).toBe(true);
  });

  it('is a no-op for empty content', async () => {
    const ix = await loadIndexer();
    await ix.indexChatMessage('u1', 'c1', 0, { role: 'user', content: '', time: 't' });
    expect(await chatDocIds()).toEqual([]);
  });
});

describe('search/indexer › indexChatMessageDeferred', () => {
  // A message append is what paints the sender's own chat bubble, so the
  // index must not sit in front of it: loading a large snapshot measured
  // ~950ms on a real profile. The write still has to happen, in order, and
  // still has to be visible to whoever reads next.
  it('hands the caller back before the upsert lands, then applies it on drain', async () => {
    const ix = await loadIndexer();

    ix.indexChatMessageDeferred('u1', 'c1', 0, { role: 'user', content: 'deferred keyword', time: 't1' });
    // Synchronous return: nothing is in the index yet.
    expect(await chatDocIds()).toEqual([]);

    await ix.drainDeferredChatWrites();
    expect(await chatDocIds()).toEqual(['chat:c1:0']);
    expect(await chatTermIsIndexed('u1', 'deferred')).toBe(true);
  });

  it('keeps appends contiguous so the file is not handed back to the reconciler', async () => {
    // Each upsert stats the file before taking the index lock, so writes
    // started together can reach the index out of order. A gap in the
    // watermark drops the file's entry and forces a whole-history re-read.
    writeChat('u1', 'c1', [
      { role: 'user', content: 'first', time: 't1' },
      { role: 'assistant', content: 'second', time: 't2' },
      { role: 'user', content: 'third', time: 't3' },
    ]);
    const ix = await loadIndexer();

    // Hold the first upsert's stat so a later one would overtake it unless the
    // deferred writes are chained. Without the delay both orders look alike
    // and the case cannot fail.
    statHook.holdNextChatStat = true;

    for (const [i, content] of ['first', 'second', 'third'].entries()) {
      ix.indexChatMessageDeferred('u1', 'c1', i, { role: 'user', content, time: `t${i}` });
    }
    await ix.drainDeferredChatWrites();
    expect(statHook.holdNextChatStat, 'the stat delay must have been exercised').toBe(false);

    const store = await loadChatStore();
    const watermark = store.readFileWatermark('u1', 'c1');
    expect(watermark, 'a released file means the writes landed out of order').toBeDefined();
    expect(watermark!.next).toBe(3);
    for (const term of ['first', 'second', 'third']) {
      expect(await chatTermIsIndexed('u1', term), `${term} must be indexed`).toBe(true);
    }
  });

  it('lets a search see a message whose index write has not run yet', async () => {
    // Deferring the write only moves the cost; it must not make a just-sent
    // message unsearchable. The reader settles the chain before it looks.
    writeChat('u1', 'c1', [{ role: 'user', content: 'pangolin sighting', time: 't1' }]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');

    // Park the upsert so it is provably still pending when the search starts;
    // otherwise the write would land first and the case could not fail.
    statHook.holdNextChatStat = true;
    statHook.holdMs = 400;
    ix.indexChatMessageDeferred('u1', 'c1', 1, { role: 'assistant', content: 'quokka reply', time: 't2' });
    const search = await import('../../../../src/main/features/search/index');
    const results = await search.searchChats('u1', 'quokka');
    statHook.holdMs = 40;
    expect(statHook.holdNextChatStat, 'the upsert must have been parked').toBe(false);
    expect(results.length, 'the reader must drain pending index writes').toBeGreaterThan(0);
  });

  it('drains to completion even when an upsert fails', async () => {
    const ix = await loadIndexer();
    // One upsert fails at the storage layer; its successor must still land.
    const store = await loadChatStore();
    const realUpsert = store.upsertDoc;
    let failed = false;
    vi.spyOn(store, 'upsertDoc').mockImplementation(((uid: string, doc: never) => {
      if (!failed) { failed = true; throw new Error('disk full'); }
      return realUpsert(uid, doc);
    }) as typeof store.upsertDoc);

    ix.indexChatMessageDeferred('u1', 'c1', 0, { role: 'user', content: 'alpha', time: 't1' });
    ix.indexChatMessageDeferred('u1', 'c1', 1, { role: 'user', content: 'beta', time: 't2' });
    await expect(ix.drainDeferredChatWrites()).resolves.toBeUndefined();

    expect(failed, 'the first upsert must have failed').toBe(true);
    expect(await chatTermIsIndexed('u1', 'beta'),
      'a failed neighbour must not strand later appends').toBe(true);
  });
});

// Persistence shape changed during the bus refactor: legacy `<cid>.jsonl`
// stored `{ role, content, time }`; current group-chat jsonl stores
// `{ id, ts, from, to, mentions, text, ... }` (GroupMessage). The chat
// indexer must read both — without the fallback, every post-refactor
// conversation gets `_msgText() === ''` and is silently skipped, surfacing
// to the user as "conversation messages can't be searched". This describe
// pins both shapes so the fallback in `_msgText` / `_msgRole` / `_msgTime`
// can't regress unnoticed.
describe('search/indexer › chat message shapes (legacy + group-chat)', () => {
  it('reconcileChatsIndex indexes group-chat shape (`{from, ts, text, ...}`)', async () => {
    writeChat('u1', 'c1', [
      { id: 'm0', ts: '2026-01-01T00:00:00Z', from: 'user',      to: ['commander'], mentions: [], text: 'pangolin sighting' },
      { id: 'm1', ts: '2026-01-01T00:00:01Z', from: 'commander', to: ['user'],      text: 'noted' },
    ]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');
    // Both messages indexed — `from` becomes role, `ts` becomes time, `text` is the body.
    expect(await chatDoc('u1', 'c1', 0)).toMatchObject({ role: 'user', time: '2026-01-01T00:00:00Z' });
    expect(await chatDoc('u1', 'c1', 1)).toMatchObject({ role: 'commander', time: '2026-01-01T00:00:01Z' });
    // Body tokens reachable via the postings list.
    expect(await chatTermIsIndexed('u1', 'pangolin')).toBe(true);
    expect(await chatTermIsIndexed('u1', 'noted')).toBe(true);
  });

  it('indexChatMessage hot-path accepts group-chat shape', async () => {
    const ix = await loadIndexer();
    await ix.indexChatMessage('u1', 'c1', 0, {
      from: 'user', ts: 't', text: 'fresh group message',
    } as any);
    expect(await chatDoc('u1', 'c1', 0)).toMatchObject({ role: 'user', time: 't' });
    expect(await chatTermIsIndexed('u1', 'fresh')).toBe(true);
  });

  it('legacy shape still works (regression guard for `{role, content, time}`)', async () => {
    // Old conversations written before the bus refactor stay searchable.
    writeChat('u1', 'c2', [
      { role: 'user',      content: 'legacy alpha', time: 't1' },
      { role: 'assistant', content: 'legacy beta',  time: 't2' },
    ]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');
    expect(await chatDoc('u1', 'c2', 0)).toMatchObject({ role: 'user', time: 't1' });
    expect(await chatTermIsIndexed('u1', 'legacy')).toBe(true);
  });
});

describe('search/indexer › a leftover JSON snapshot cannot suppress the store', () => {
  it('ignores chats.idx.json claiming the file is indexed and rebuilds from jsonl', async () => {
    // Every existing profile still has the retired snapshot on disk, and some
    // of them claim a conversation was indexed while holding no documents for
    // it (the old `_msgText` returned '' for group-chat shape). Whatever that
    // file says, the store decides what is indexed — otherwise the migration
    // would inherit exactly the gaps it is meant to repair.
    writeChat('u1', 'cstale', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], text: 'searchable token zebrafish' },
    ]);
    const paths = await import('../../../../src/main/paths');
    const idxPath = paths.userChatsIndexPath('u1');
    fs.mkdirSync(path.dirname(idxPath), { recursive: true });
    fs.writeFileSync(idxPath, JSON.stringify({
      version: 3, kind: 'chat',
      files: { cstale: { mtime: 0, size: 0, next: 1 } },  // claims indexed
      docs: {}, postings: {},                              // but holds nothing
    }));

    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');

    expect(await chatDocIds()).toEqual(['chat:cstale:0']);
    expect(await chatTermIsIndexed('u1', 'zebrafish')).toBe(true);
  });
});

describe('search/indexer › dropChatConversation', () => {
  it('removes every doc under the conversation id', async () => {
    writeChat('u1', 'c1', [
      { role: 'user', content: 'alpha', time: 't1' },
      { role: 'assistant', content: 'beta', time: 't2' },
    ]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');
    await ix.dropChatConversation('u1', 'c1');
    const store = await loadChatStore();
    expect(store.readFileWatermark('u1', 'c1')).toBeUndefined();
    expect(await chatDocIds()).toEqual([]);
  });
});

describe('search/indexer › upsertContext / dropContext', () => {
  it('upsert indexes path tokens, not body tokens', async () => {
    writeContext('notes/squirrel.md', '# A\nkeyword unrelatedbodyword');
    const ix = await loadIndexer();
    ix.upsertContext(TEST_UID, 'notes/squirrel.md');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(entry.idx.files['notes/squirrel.md']).toBeDefined();
    expect(entry.idx.postings['squirrel']).toBeDefined();
    expect(entry.idx.postings['notes']).toBeDefined();
    expect(entry.idx.postings['unrelatedbodyword']).toBeUndefined();
  });

  it('drop removes the doc', async () => {
    writeContext('a.md', '# A\nsome body');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    ix.dropContext(TEST_UID, 'a.md');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(entry.idx.files['a.md']).toBeUndefined();
  });
});

// 锁住 `9529d52c` 改的 spec:技能编辑 / 智能体编辑会话**不**进 search 索引。
// 之前老版本有 reconcileSkillChatsIndex / reconcileAgentChatsIndex 会按 skill_id
// 建索引,现在被剔除——search 只索引 contexts + 主对话 + agent/skill 本体规格。
// 下次如有人把这两条索引函数复活,或者新人改 reconcileAll 时不小心把 skill_chats
// 加回扫描列表,这里负责拦截。
describe('search/indexer › skill / agent edit chats are out of search scope', () => {
  it('does not expose `reconcileSkillChatsIndex` / `reconcileAgentChatsIndex`', async () => {
    const ix = await loadIndexer();
    expect((ix as Record<string, unknown>).reconcileSkillChatsIndex).toBeUndefined();
    expect((ix as Record<string, unknown>).reconcileAgentChatsIndex).toBeUndefined();
    expect((ix as Record<string, unknown>).indexSkillChatMessage).toBeUndefined();
    expect((ix as Record<string, unknown>).indexAgentChatMessage).toBeUndefined();
  });
});

describe('search/indexer › flushAll', () => {
  it('persists dirty indexes to disk', async () => {
    writeContext('a.md', '# A\nbody');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    await ix.flushAll();
    const paths = await import('../../../../src/main/paths');
    const idxPath = paths.userContextsIndexPath(TEST_UID);
    expect(fs.existsSync(idxPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    expect(raw.kind).toBe('context');
    expect(raw.files['a.md']).toBeDefined();
  });
});

describe('partial chat index deletion', () => {
  it.each(['direct', 'reconcile'] as const)('removes all stale hits after a watermark gap and %s deletion', async (mode) => {
    writeChat('u1', 'removed', [{ from: 'user', text: 'initial message' }]);
    writeChat('u1', 'retained', [{ from: 'user', text: 'retained quokka' }]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');
    appendChat('u1', 'removed', { from: 'user', text: 'unobserved row' });
    const latest = { from: 'user', text: 'deleted quokka' };
    appendChat('u1', 'removed', latest);
    await ix.indexChatMessage('u1', 'removed', 2, latest);
    fs.unlinkSync(path.join(tmpDir, 'u1', 'cloud', 'chats', 'removed.jsonl'));
    if (mode === 'direct') {
      await ix.dropChatConversation('u1', 'removed');
      const paths = await import('../../../../src/main/paths');
      const { idx } = await ix.getEntry(paths.userChatsIndexPath('u1'), 'chat');
      expect(Object.values(idx.docs).some(doc => doc.fileKey === 'removed')).toBe(false);
    }
    await ix.reconcileChatsIndex('u1');
    const search = await import('../../../../src/main/features/search/index');
    expect((await search.searchChats('u1', 'quokka')).map(hit => hit.cid)).toEqual(['retained']);
    const paths = await import('../../../../src/main/paths');
    const { idx } = await ix.getEntry(paths.userChatsIndexPath('u1'), 'chat');
    expect(Object.values(idx.docs).some(doc => doc.fileKey === 'removed')).toBe(false);
  });
});
