import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// chat_store pulls its path constants from paths.ts at module load, so each
// test points ORKAS_WORKSPACE_ROOT at a fresh workspace before resetting the
// module graph — the same dance the indexer tests do.
let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chat-store-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  const { default: vi } = await import('vitest').then(m => ({ default: m.vi }));
  vi.resetModules();
});

afterEach(async () => {
  const store = await loadStore();
  store.closeAllChatStores();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadStore() {
  return import('../../../../src/main/features/search/chat_store');
}

function doc(cid: string, msgIndex: number, text: string, role = 'user') {
  return { cid, msgIndex, role, time: '2026-09-20T00:00:00Z', text };
}

describe('search/chat_store', () => {
  it('rolls back a failed migration batch together with its cursor and resumes safely', async () => {
    const store = await loadStore();
    const prefix = { mtime: 42, size: 99, next: 1 };
    store.writeRebuildBatch(UID, 'c1', [doc('c1', 0, 'prefixword')], prefix, true, false);
    // The second row violates the unique position after the first row writes.
    expect(() => store.writeRebuildBatch(UID, 'c1', [
      doc('c1', 1, 'rollbackword'), doc('c1', 0, 'duplicateword'),
    ], { ...prefix, next: 3 }, false, true)).toThrow();
    expect(store.readRebuildCursor(UID, 'c1')).toEqual(prefix);
    expect(store.readFileWatermark(UID, 'c1')).toBeUndefined();
    expect(store.postingsFor(UID, 'rollbackword')).toHaveLength(0);
    expect(store.postingsFor(UID, 'prefixword')).toHaveLength(1);
    expect(store.docCount(UID)).toBe(1);
    store.closeAllChatStores();
    expect(store.readRebuildCursor(UID, 'c1')).toEqual(prefix);
    store.writeRebuildBatch(UID, 'c1', [doc('c1', 1, 'resumedword')], { ...prefix, next: 2 }, false, true);
    expect(store.readRebuildCursor(UID, 'c1')).toBeUndefined();
    expect(store.readFileWatermark(UID, 'c1')?.next).toBe(2);
    expect(store.docCount(UID)).toBe(2);
    expect(store.postingsFor(UID, 'resumedword')).toHaveLength(1);
  });

  it('indexes a message so its terms and length are readable', async () => {
    const store = await loadStore();
    store.upsertDoc(UID, doc('c1', 0, 'porcupine sighting near the fence'));

    const postings = store.postingsFor(UID, 'porcupine');
    expect(postings).toHaveLength(1);
    const row = store.docById(UID, postings[0].doc);
    expect(row).toMatchObject({ docId: 'chat:c1:0', cid: 'c1', msgIndex: 0, role: 'user' });
    expect(row!.len).toBe('porcupine sighting near the fence'.length);
    expect(store.docCount(UID)).toBe(1);
  });

  it('carries the term frequency the scorer needs, not just membership', async () => {
    // BM25 weights a repeated term above a single mention; a presence-only
    // index (what FTS5 would hand back) cannot express that difference.
    const store = await loadStore();
    store.upsertDoc(UID, doc('c1', 0, 'quokka quokka quokka elsewhere'));
    store.upsertDoc(UID, doc('c1', 1, 'quokka once'));

    const byTf = new Map(store.postingsFor(UID, 'quokka').map(p => [p.doc, p.tf]));
    const heavy = store.postingsFor(UID, 'elsewhere')[0].doc;
    expect(byTf.get(heavy)).toBe(3);
    expect([...byTf.values()].sort()).toEqual([1, 3]);
  });

  it('re-indexing a position drops the text it replaced', async () => {
    // A replayed or edited message must not keep matching its old wording.
    const store = await loadStore();
    store.upsertDoc(UID, doc('c1', 0, 'pangolin draft'));
    store.upsertDoc(UID, doc('c1', 0, 'numbat final'));

    expect(store.postingsFor(UID, 'pangolin')).toHaveLength(0);
    expect(store.postingsFor(UID, 'numbat')).toHaveLength(1);
    expect(store.docCount(UID), 'the position is one document, not two').toBe(1);
  });

  it('keeps CJK unigrams and bigrams so the query-side anchor still works', async () => {
    // `search/index.ts` restricts candidates to documents holding a query
    // bigram; without the bigram row that filter would return nothing.
    const store = await loadStore();
    store.upsertDoc(UID, doc('c1', 0, '重新设计账号设置'));

    expect(store.postingsFor(UID, '重新')).toHaveLength(1);
    expect(store.postingsFor(UID, '重'), 'unigram').toHaveLength(1);
    expect(store.postingsFor(UID, '设计')).toHaveLength(1);
    expect(store.postingsFor(UID, '账户'), 'a bigram never written must not match').toHaveLength(0);
  });

  it('deleting a conversation removes its documents, postings and watermark', async () => {
    const store = await loadStore();
    store.upsertDoc(UID, doc('c1', 0, 'wombat burrow'));
    store.upsertDoc(UID, doc('c2', 0, 'wombat elsewhere'));
    store.setFileWatermark(UID, 'c1', { mtime: 1, size: 2, next: 1 });

    store.deleteConversation(UID, 'c1');

    expect(store.postingsFor(UID, 'burrow')).toHaveLength(0);
    expect(store.postingsFor(UID, 'wombat'), 'the other conversation survives').toHaveLength(1);
    expect(store.readFileWatermark(UID, 'c1')).toBeUndefined();
    expect(store.docCount(UID)).toBe(1);
  });

  it('replaces a whole conversation in one pass and stamps its watermark', async () => {
    const store = await loadStore();
    store.upsertDoc(UID, doc('c1', 0, 'stale first'));
    store.upsertDoc(UID, doc('c1', 1, 'stale second'));

    store.replaceConversation(UID, 'c1', [
      doc('c1', 0, 'fresh alpha'), doc('c1', 1, 'fresh beta'), doc('c1', 2, 'fresh gamma'),
    ], { mtime: 42, size: 99, next: 3 });

    expect(store.postingsFor(UID, 'stale')).toHaveLength(0);
    expect(store.postingsFor(UID, 'fresh')).toHaveLength(3);
    expect(store.readFileWatermark(UID, 'c1')).toEqual({ mtime: 42, size: 99, next: 3 });
    expect(store.docCount(UID)).toBe(3);
  });

  it('reports document count and mean length, and refreshes them after a write', async () => {
    // Both feed BM25 on every query. A cached aggregate that survives a write
    // would score later queries against a corpus that no longer exists.
    const store = await loadStore();
    store.upsertDoc(UID, doc('c1', 0, 'aa'));          // len 2
    store.upsertDoc(UID, doc('c1', 1, 'bbbbbb'));      // len 6
    expect(store.docCount(UID)).toBe(2);
    expect(store.avgDocLen(UID)).toBe(4);

    store.upsertDoc(UID, doc('c1', 2, 'cccccccccc'));  // len 10
    expect(store.docCount(UID)).toBe(3);
    expect(store.avgDocLen(UID)).toBe(6);

    store.deleteConversation(UID, 'c1');
    expect(store.docCount(UID)).toBe(0);
    expect(store.avgDocLen(UID), 'an empty corpus must not divide by zero').toBe(1);
  });

  it('resolves a scored candidate set in batches without dropping rows', async () => {
    const store = await loadStore();
    for (let i = 0; i < 950; i += 1) store.upsertDoc(UID, doc('c1', i, `token${i} shared`));
    const ids = store.postingsFor(UID, 'shared').map(p => p.doc);
    expect(ids, 'the batching path needs more ids than one statement takes').toHaveLength(950);

    const rows = store.docsByIds(UID, ids);
    expect(rows.size).toBe(950);
    expect([...rows.values()].map(r => r.msgIndex).sort((a, b) => a - b)[949]).toBe(949);
  });

  it('keeps watermarks per conversation and can forget one', async () => {
    const store = await loadStore();
    store.setFileWatermark(UID, 'c1', { mtime: 1.5, size: 10, next: 4 });
    store.setFileWatermark(UID, 'c2', { mtime: 2.5, size: 20, next: 7 });
    expect(store.readAllWatermarks(UID).size).toBe(2);

    store.dropFileWatermark(UID, 'c1');
    expect(store.readFileWatermark(UID, 'c1')).toBeUndefined();
    expect(store.readFileWatermark(UID, 'c2')).toEqual({ mtime: 2.5, size: 20, next: 7 });
  });

  it('joins postings to document length so scoring needs one lookup per term', async () => {
    // BM25 normalizes by document length for every candidate; fetching that
    // length per posting would turn one indexed lookup into hundreds.
    const store = await loadStore();
    store.upsertDoc(UID, doc('c1', 0, 'echidna short'));
    store.upsertDoc(UID, doc('c1', 1, 'echidna ' + 'x'.repeat(200)));

    const rows = store.postingsWithLen(UID, 'echidna').sort((a, b) => a.len - b.len);
    expect(rows).toHaveLength(2);
    expect(rows[0].len).toBe('echidna short'.length);
    expect(rows[1].len).toBe(('echidna ' + 'x'.repeat(200)).length);
    expect(rows.every(r => r.tf === 1)).toBe(true);
  });

  it('remembers the source fingerprint and can clear it', async () => {
    // An index with no fingerprint may not be trusted without a reconcile.
    const store = await loadStore();
    expect(store.readSourceStamp(UID)).toBeUndefined();
    store.writeSourceStamp(UID, 'v1|projects=|a|b');
    expect(store.readSourceStamp(UID)).toBe('v1|projects=|a|b');
    store.writeSourceStamp(UID, undefined);
    expect(store.readSourceStamp(UID)).toBeUndefined();
  });

  it('lists conversations from documents as well as watermarks', async () => {
    // A file released back to the reconciler keeps its documents but loses its
    // watermark; a deleted source must still be reachable for cleanup.
    const store = await loadStore();
    store.upsertDoc(UID, doc('c1', 0, 'alpha'));
    store.setFileWatermark(UID, 'c1', { mtime: 1, size: 1, next: 1 });
    store.upsertDoc(UID, doc('c2', 0, 'beta'));
    store.dropFileWatermark(UID, 'c2');
    store.setFileWatermark(UID, 'c3', { mtime: 1, size: 1, next: 0 });

    expect([...store.indexedConversationIds(UID)].sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('refuses a database written by a different schema version', async () => {
    // A silently accepted mismatch would read the wrong columns and report an
    // empty history as a legitimate result.
    const store = await loadStore();
    store.upsertDoc(UID, doc('c1', 0, 'alpha'));
    const dbPath = store.chatStorePath(UID);
    store.closeAllChatStores();

    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(dbPath);
    raw.pragma(`user_version = ${store.CHAT_STORE_SCHEMA_VERSION + 1}`);
    raw.close();

    const { vi } = await import('vitest');
    vi.resetModules();
    const reopened = await loadStore();
    expect(() => reopened.docCount(UID)).toThrow(/schema version mismatch/);
  });
});
