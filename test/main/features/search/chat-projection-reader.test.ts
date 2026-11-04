import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

let root: string, previous: string | undefined;
const uid = 'projection-user', cid = 'history';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-projection-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
});
afterEach(async () => {
  await (await import('../../../../src/main/features/search/indexer')).flushAll();
  (await import('../../../../src/main/features/search/chat_store')).closeAllChatStores();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

it('uses durable public projections after a reader restart, extends proven appends, and rejects replaced or deleted sources', async () => {
  const storage = await import('../../../../src/main/storage');
  const indexer = await import('../../../../src/main/features/search/indexer');
  const store = await import('../../../../src/main/features/search/chat_store');
  const reader = await import('../../../../src/main/features/search/chat-snippets');
  const { indexedJsonlStamp } = await import('../../../../src/main/util/indexed-jsonl');
  const file = path.join(root, uid, 'cloud/chats', cid + '.jsonl');
  const original = { id: 'original', text: '电商领域旧文', process: [
    { type: 'event', event: { stream: 'reasoning', data: { text: 'PRIVATE '.repeat(100_000) } } },
    { type: 'progress', text: '公开证据 电商领域' },
  ] };
  const append = async (record: object) => {
    const receipt = await storage.appendJsonlAtomic(file, record, true);
    await indexer.indexChatMessage(uid, cid, receipt.msgIndex, receipt.source!);
  };
  const read = () => reader.readChatSnippets(file, new Set([0, 1]), ['电商'], undefined, { userId: uid, cid });
  await append(original);
  expect(store.readChatProjection(uid, cid, 0, await indexedJsonlStamp(file))!.length).toBeLessThan(1024);
  await reader.closeChatSnippetReader();
  expect((await read()).get(0)).toMatchObject({ msg_id: 'original', process_index: 1, process_snippet: '[process 1] 公开证据 电商领域' });
  await append({ id: 'appended', text: '电商领域追加' });
  // A verified append advances the source proof for earlier projections too.
  expect(store.readChatProjection(uid, cid, 0, await indexedJsonlStamp(file))).toBeDefined();
  expect((await read()).get(1)?.snippet).toBe('电商领域追加');

  const before = fs.statSync(file);
  const replacement = fs.readFileSync(file, 'utf8').replace('旧文', '新文');
  fs.writeFileSync(file + '.new', replacement);
  fs.utimesSync(file + '.new', before.atime, before.mtime);
  fs.renameSync(file + '.new', file);
  expect(store.readChatProjection(uid, cid, 0, await indexedJsonlStamp(file))).toBeUndefined();
  await reader.closeChatSnippetReader();
  expect((await read()).get(0)?.snippet).toContain('电商领域新文');
  fs.unlinkSync(file);
  expect((await read()).size).toBe(0);
  store.deleteConversation(uid, cid);
  expect(store.readProjectionStamp(uid, cid)).toBeUndefined();
});

it('falls back to complete source snippets when a current projection is corrupt', async () => {
  const storage = await import('../../../../src/main/storage');
  const indexer = await import('../../../../src/main/features/search/indexer');
  const store = await import('../../../../src/main/features/search/chat_store');
  const reader = await import('../../../../src/main/features/search/chat-snippets');
  const file = path.join(root, uid, 'cloud/chats', cid + '.jsonl');
  const receipt = await storage.appendJsonlAtomic(file, { text: '电商领域完整正文' }, true);
  await indexer.indexChatMessage(uid, cid, 0, receipt.source!);
  const db = new Database(store.chatStorePath(uid));
  try { db.prepare('UPDATE chat_projections SET payload = ?').run(Buffer.from('corrupt')); }
  finally { db.close(); }
  expect((await reader.readChatSnippets(file, new Set([0]), ['电商'], undefined, { userId: uid, cid })).get(0)?.snippet)
    .toBe('电商领域完整正文');
});

it('keeps identical conversation coordinates isolated across accounts and reader restarts', async () => {
  const storage = await import('../../../../src/main/storage');
  const indexer = await import('../../../../src/main/features/search/indexer');
  const reader = await import('../../../../src/main/features/search/chat-snippets');
  const store = await import('../../../../src/main/features/search/chat_store');
  const { indexedJsonlStamp } = await import('../../../../src/main/util/indexed-jsonl');
  const { projectChatSnippet } = await import('../../../../src/main/features/search/snippet');
  const accounts = [uid, 'another-user'];
  const records = accounts.map((account, i) => ({ id: `${account}-message`, text: `电商领域 account ${i}` }));
  const files = accounts.map(account => path.join(root, account, 'cloud/chats', cid + '.jsonl'));
  for (let i = 0; i < accounts.length; i++) {
    const receipt = await storage.appendJsonlAtomic(files[i], records[i], true);
    await indexer.indexChatMessage(accounts[i], cid, 0, receipt.source!);
  }
  for (const i of [0, 1, 0, 1]) {
    expect(store.readChatProjection(accounts[i], cid, 0, await indexedJsonlStamp(files[i]))).toBeDefined();
    const rows = await reader.readChatSnippets(files[i], new Set([0]), ['电商'], undefined, { userId: accounts[i], cid });
    expect(rows.get(0)).toEqual(projectChatSnippet(records[i], ['电商']));
    if (i === 1) await reader.closeChatSnippetReader();
  }
});

it('adds projections to a legacy index without rewriting postings and keeps partial cache rows untrusted', async () => {
  const store = await import('../../../../src/main/features/search/chat_store');
  const { buildChatProjection } = await import('../../../../src/main/features/search/chat-projection');
  const docs = ['firstmarker', 'secondmarker'].map((text, msgIndex) => ({
    cid, msgIndex, text, role: 'user', time: '2026-10-30T00:00:00Z',
    projection: buildChatProjection({ text }).payload,
  }));
  store.writeRebuildBatch(uid, cid, docs.map(({ projection, ...doc }) => doc), { mtime: 1, size: 20, next: 2 }, true, true);
  const original = store.postingsFor(uid, 'firstmarker');
  const db = new Database(store.chatStorePath(uid));
  try {
    db.exec("CREATE TRIGGER no_retokenize BEFORE DELETE ON chat_postings BEGIN SELECT RAISE(ABORT, 'do not rewrite valid postings'); END");
    store.writeRebuildBatch(uid, cid, [docs[0]], { mtime: 1, size: 20, next: 1 }, true, false, 'source-stamp', true);
    expect(store.readChatProjection(uid, cid, 0, 'source-stamp')).toBeUndefined();
    expect(store.readRebuildCursor(uid, cid)).toMatchObject({ projectionStamp: 'source-stamp', projectionOnly: true });
    store.writeRebuildBatch(uid, cid, [docs[1]], { mtime: 1, size: 20, next: 2 }, false, true, 'source-stamp', true);
    expect(store.postingsFor(uid, 'firstmarker')).toEqual(original);
    expect(store.readChatProjection(uid, cid, 0, 'source-stamp')).toEqual(docs[0].projection);
    expect(store.readChatProjection(uid, cid, 1, 'source-stamp')).toEqual(docs[1].projection);
    expect(store.readRebuildCursor(uid, cid)).toBeUndefined();
  } finally { db.close(); }
});

it('avoids history reads and full cache scans for cold summaries, with negative controls', async () => {
  const { Worker } = await import('node:worker_threads');
  const storage = await import('../../../../src/main/storage');
  const indexer = await import('../../../../src/main/features/search/indexer');
  const store = await import('../../../../src/main/features/search/chat_store');
  const { indexedJsonlStamp } = await import('../../../../src/main/util/indexed-jsonl');
  const file = path.join(root, uid, 'cloud/chats', cid + '.jsonl');
  const record = { text: '电商领域结论 ' + 'summary '.repeat(20), process: [
    { type: 'progress', text: '电商早期线索' },
    // The pure projection case owns the >16 MB boundary. Here 24 independent
    // blocks suffice to expose a full-scan regression through the real worker.
    ...Array.from({ length: 24 }, (_, i) => ({ type: 'progress', text: `step${i} ` + 'UNRELATED_OUTPUT '.repeat(8_000) })),
    { type: 'progress', text: '电商领域公开证据' },
    { type: 'progress', text: '电商领域后来的同分证据' },
  ] };
  const receipt = await storage.appendJsonlAtomic(file, record, true);
  await indexer.indexChatMessage(uid, cid, 0, receipt.source!);
  await indexer.flushAll();
  const read = async (cached: boolean) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs'), fsp = require('node:fs/promises');
      let reads = 0, irrelevantInflations = 0;
      const zlib = require('node:zlib'), inflate = zlib.inflateRawSync;
      zlib.inflateRawSync = function(...args) {
        const result = inflate.apply(this, args);
        if (result.includes(Buffer.from('UNRELATED_OUTPUT'))) irrelevantInflations++;
        return result;
      };
      for (const [owner, name] of [[fs, 'createReadStream'], [fsp, 'open']]) {
        const original = owner[name]; owner[name] = function(file, ...args) {
          if (String(file) === workerData.file) { reads++; throw Error('History body unavailable'); }
          return original.call(this, file, ...args);
        };
      }
      const post = parentPort.postMessage.bind(parentPort);
      parentPort.postMessage = message => post({ ...message, reads, irrelevantInflations });
      require(workerData.entry);
    `, { eval: true, execArgv: [], workerData: { file, entry: path.resolve(__dirname, '../../../../src/main/features/search/chat-snippet-entry.js') },
      env: { ...process.env, ORKAS_WORKSPACE_ROOT: root } });
    try {
      return await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('Cold summary worker timed out')), 10_000);
        worker.once('error', error => { clearTimeout(timeout); reject(error); });
        worker.once('message', result => { clearTimeout(timeout); resolve(result); });
        // No entry covers every token: pruning must work even without the
        // early-return path, and the later best match must retain its position.
        worker.postMessage({ id: 1, file, indexes: [0], tokens: ['电商', '领域', 'absent'], ...(cached ? { source: { userId: uid, cid } } : {}) });
      });
    } finally { await worker.terminate(); }
  };
  const control = await read(false);
  expect(control.reads).toBeGreaterThan(0);
  expect(control.rows).toEqual([]);
  const cached = await read(true);
  expect(cached.reads).toBe(0);
  const { projectChatSnippet } = await import('../../../../src/main/features/search/snippet');
  const expected = projectChatSnippet(record, ['电商', '领域', 'absent']);
  expect(expected?.process_index).toBe(25);
  expect(cached.rows[0][1]).toEqual(expected);

  // Supported unfiltered blocks return the same answer but do unnecessary
  // work. This distinguishes a performance regression from incorrect output.
  const payload = store.readChatProjection(uid, cid, 0, await indexedJsonlStamp(file))!;
  const headerSize = payload.readUInt32LE(0);
  const header = JSON.parse(payload.subarray(4, 4 + headerSize).toString());
  header.process = header.process.map(([offset, bytes]: number[]) => [offset, bytes]);
  const encoded = Buffer.from(JSON.stringify(header)), length = Buffer.alloc(4);
  length.writeUInt32LE(encoded.length);
  const db = new Database(store.chatStorePath(uid));
  try {
    db.prepare('UPDATE chat_projections SET payload = ? WHERE cid = ? AND msg_index = 0')
      .run(Buffer.concat([length, encoded, payload.subarray(4 + headerSize)]), cid);
  } finally { db.close(); }
  const unfiltered = await read(true);
  expect(unfiltered.reads).toBe(0);
  expect(unfiltered.rows[0][1]).toEqual(expected);
  expect(unfiltered.irrelevantInflations).toBeGreaterThan(0);
  // Filters may have false positives. Require actual work reduction without
  // binding the case to a hash layout or machine-specific millisecond budget.
  expect(cached.irrelevantInflations).toBeLessThan(unfiltered.irrelevantInflations);
});
