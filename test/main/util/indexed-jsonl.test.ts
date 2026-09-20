import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getIndexedJsonl, readIndexedJsonlRecords } from '../../../src/main/util/indexed-jsonl';
import { appendJsonlAtomic, readJsonlWindow, writeTextAtomicSync } from '../../../src/main/storage';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-indexed-history-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
const metadata = (record: { id: string }) => ({ id: record.id });

describe('indexed JSONL history reads', () => {
  it('keeps valid-record numbering and exact UTF-8 source bytes across malformed rows', async () => {
    const file = path.join(directory, 'history.jsonl');
    const records = [{ id: 'a', text: '用户🧾' }, { id: 'b', text: 'quoted\n"input"' }];
    fs.writeFileSync(file, '\n' + JSON.stringify(records[0]) + '\nmalformed\n' + JSON.stringify(records[1]) + '\n');
    const index = await getIndexedJsonl(file, metadata);
    expect(index.entries.map(entry => entry.index)).toEqual([0, 1]);
    expect(index.entries.map(entry => entry.metadata)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(await readIndexedJsonlRecords(file, index, index.entries)).toEqual(records);
  });

  it('extends known appends, invalidates rewritten sources and rejects stale read snapshots', async () => {
    const file = path.join(directory, 'history.jsonl');
    await appendJsonlAtomic(file, { id: 'a', text: 'original' });
    const first = await getIndexedJsonl(file, metadata);
    await appendJsonlAtomic(file, { id: 'b', text: 'appended' });
    const extended = await getIndexedJsonl(file, metadata);
    expect(extended.entries).toBe(first.entries); // append extends existing offsets, no rescan
    expect(extended.entries.map(entry => entry.metadata.id)).toEqual(['a', 'b']);
    expect(await readIndexedJsonlRecords(file, extended, [extended.entries[1]])).toEqual([{ id: 'b', text: 'appended' }]);
    await writeTextAtomicSync(file, JSON.stringify({ id: 'replacement', text: 'sync rewrote the log' }) + '\n');
    await expect(readIndexedJsonlRecords(file, extended, [extended.entries[0]])).rejects.toThrow('Conversation changed');
    const rewritten = await getIndexedJsonl(file, metadata);
    expect(rewritten.entries.map(entry => entry.metadata.id)).toEqual(['replacement']);
  });

  it('shares a cold scan and retains no complete output bodies in the index', async () => {
    const file = path.join(directory, 'history.jsonl');
    fs.writeFileSync(file, JSON.stringify({ id: 'a', text: 'PRIVATE_BODY'.repeat(10_000) }) + '\n');
    const indexes = await Promise.all(Array.from({ length: 8 }, () => getIndexedJsonl(file, metadata)));
    expect(indexes.every(index => index === indexes[0])).toBe(true);
    expect(JSON.stringify(indexes[0])).not.toContain('PRIVATE_BODY');
  });

  it('compares repeated exact lookups with the former full-history read on a 20 MB transcript', async () => {
    const file = path.join(directory, 'history.jsonl');
    const body = 'x'.repeat(10_000);
    fs.writeFileSync(file, Array.from({ length: 2_000 }, (_, i) => JSON.stringify({ id: `m${i}`, text: body })).join('\n') + '\n');
    const start = performance.now();
    for (let i = 0; i < 10; i++) {
      const old = await readJsonlWindow<{ id: string }>(file, 0, Number.MAX_SAFE_INTEGER);
      expect(old.records[1_000].id).toBe('m1000');
    }
    const legacyMs = performance.now() - start;
    const cold = performance.now();
    const index = await getIndexedJsonl(file, metadata);
    const coldMs = performance.now() - cold;
    const warm = performance.now();
    for (let i = 0; i < 10; i++) {
      const current = await getIndexedJsonl(file, metadata);
      const records = await readIndexedJsonlRecords<{ id: string }>(file, current, [current.entries[1_000]]);
      expect(records[0].id).toBe('m1000');
    }
    const warmMs = performance.now() - warm;
    expect(index.entries[1_000].bytes * 10).toBeLessThan(fs.statSync(file).size);
    console.info('history-read-performance', { records: 2_000, bytes: fs.statSync(file).size, repetitions: 10,
      legacyMs: Math.round(legacyMs), coldMs: Math.round(coldMs), warmMs: Math.round(warmMs),
      warmReadBytes: index.entries[1_000].bytes * 10 });
  });
});
