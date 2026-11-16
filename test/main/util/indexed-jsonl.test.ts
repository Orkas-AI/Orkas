import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getIndexedJsonl, readIndexedJsonlRecords, mapIndexedJsonlRecords } from '../../../src/main/util/indexed-jsonl';
import { appendJsonlAtomic, readJsonlWindow, writeTextAtomicSync } from '../../../src/main/storage';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-indexed-history-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
const metadata = (record: { id: string }) => ({ id: record.id });

describe('indexed JSONL history reads', () => {
  it('reads a warm contiguous selection with bounded IO while preserving every message', async () => {
    const file = path.join(directory, 'contiguous.jsonl');
    const records = Array.from({ length: 2048 }, (_, i) => ({ id: `m${i}`, text: `用户🧾 ${i} ` + 'x'.repeat(80) }));
    const source = records.map(row => JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(file, source);
    const index = await getIndexedJsonl(file, metadata);
    const open = fsp.open;
    const samples: Array<{ wallMs: number; cpuMs: number; reads: number; bytes: number; maxReadBytes: number }> = [];
    let reads = 0, bytes = 0, maxReadBytes = 0, closes = 0;
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await (open as any)(...args);
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      handle.read = async (...args: any[]) => {
        reads++; maxReadBytes = Math.max(maxReadBytes, args[2]);
        const result = await (read as any)(...args); bytes += result.bytesRead; return result;
      };
      handle.close = async () => { closes++; await close(); };
      return handle;
    });
    for (let i = 0; i < 5; i++) {
      reads = bytes = maxReadBytes = 0;
      const start = performance.now(), cpu = process.cpuUsage();
      const result = await readIndexedJsonlRecords(file, index, index.entries);
      const used = process.cpuUsage(cpu);
      samples.push({ wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000, reads, bytes, maxReadBytes });
      expect(result).toEqual(records);
    }
    console.info('indexed-contiguous-performance', JSON.stringify({ records: records.length,
      sourceBytes: Buffer.byteLength(source), samples, scope: 'warm exact source read; real filesystem; not UI latency or peak RSS' }));
    expect(closes).toBe(5);
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
    for (const sample of samples) {
      expect(sample.bytes).toBeLessThanOrEqual(Buffer.byteLength(source));
      expect(sample.maxReadBytes).toBeLessThanOrEqual(64 * 1024);
      expect(sample.reads, 'Adjacent small records must not require one filesystem request per message').toBeLessThan(records.length / 10);
    }
  });

  it('preserves sparse, duplicate and reordered selections around large and malformed records', async () => {
    const file = path.join(directory, 'sparse.jsonl');
    const records = [{ id: 'first', text: 'first' }, { id: 'large', text: '用户🧾'.repeat(30_000) },
      { id: 'third', text: 'third' }, { id: 'last', text: 'last' }];
    const source = records.map(row => JSON.stringify(row)).join('\r\ninvalid\r\n') + '\r\n';
    fs.writeFileSync(file, source);
    const index = await getIndexedJsonl(file, metadata);
    const wanted = [3, 0, 0, 1, 2, 3];
    expect(await readIndexedJsonlRecords(file, index, wanted.map(i => index.entries[i])))
      .toEqual(wanted.map(i => records[i]));
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
  });

  it.each(['short', 'cancel_before', 'cancel', 'error', 'truncate'] as const)('closes the source and preserves projection/cancellation boundaries on %s reads', async fault => {
    const file = path.join(directory, 'fault.jsonl');
    const records = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, text: 'message' }));
    const source = records.map(row => JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(file, source);
    const index = await getIndexedJsonl(file, metadata), open = fsp.open;
    let closes = 0, reads = 0;
    const signal = { aborted: fault === 'cancel_before' }, projected: string[] = [];
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await (open as any)(...args);
      if (fault === 'truncate') fs.truncateSync(file, index.entries[1].offset);
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      handle.read = async (buffer: Buffer, offset: number, length: number, position: number) => {
        reads++;
        if (fault === 'error' && position >= index.entries[1].offset) throw Object.assign(new Error('Synthetic read failure'), { code: 'EIO' });
        return read(buffer, offset, fault === 'error' ? Math.min(length, index.entries[1].offset - position)
          : fault === 'short' ? Math.min(length, 7) : length, position);
      };
      handle.close = async () => { closes++; await close(); };
      return handle;
    });
    const result = readIndexedJsonlRecords(file, index, index.entries, row => {
      projected.push(row.id);
      if (fault === 'cancel') signal.aborted = true;
      return row;
    }, signal);
    if (fault === 'short') expect(await result).toEqual(records);
    else {
      await expect(result).rejects.toThrow(fault.startsWith('cancel') ? 'History read cancelled'
        : fault === 'truncate' ? 'Conversation record is incomplete' : 'Synthetic read failure');
      expect(projected).toEqual(fault === 'cancel_before' ? [] : ['m0']);
      if (fault === 'cancel_before') expect(reads).toBe(0);
    }
    expect(closes).toBe(1);
    if (fault !== 'truncate') expect(fs.readFileSync(file, 'utf8')).toBe(source);
  });

  it('reads only the requested prefix, projects cold records once, and closes the source before returning', async () => {
    const file = path.join(directory, 'prefix.jsonl');
    fs.writeFileSync(file, '\ninvalid\n' + JSON.stringify({ id: 'first', text: '用户🧾' }) + '\n' +
      JSON.stringify({ id: 'second', text: 'evidence' }) + '\n' +
      JSON.stringify({ id: 'large-tail', text: 'x'.repeat(4_000_000) }) + '\n');
    const reader = vi.mocked(fs.createReadStream); reader.mockClear();
    const project = vi.fn((row: { id: string }) => row.id);
    expect([...await mapIndexedJsonlRecords(file, new Set([1, 0]), project)])
      .toEqual([[0, 'first'], [1, 'second']]);
    expect(project.mock.calls.map(([row]) => row.id)).toEqual(['first', 'second']);
    const streams = reader.mock.results.map(result => result.value as fs.ReadStream);
    expect(streams.every(stream => stream.closed)).toBe(true);
    expect(streams.reduce((sum, stream) => sum + stream.bytesRead, 0)).toBeLessThan(256 * 1024);
    // A later history request must extend the prefix, never mistake it for
    // the complete conversation or count a malformed row as a message.
    expect([...await mapIndexedJsonlRecords(file, new Set([2]), row => row.id)])
      .toEqual([[2, 'large-tail']]);
    expect((await getIndexedJsonl(file, metadata)).entries).toHaveLength(3);
  });

  it('keeps a normal search working set warm beyond 32 conversations without retaining source bodies', async () => {
    const files = Array.from({ length: 96 }, (_, index) => path.join(directory, `${index}.jsonl`));
    for (const [index, file] of files.entries()) {
      fs.writeFileSync(file, JSON.stringify({ id: String(index), text: 'private body' }) + '\n');
      await mapIndexedJsonlRecords(file, new Set([0]), row => row.id);
    }
    const reader = vi.mocked(fs.createReadStream); reader.mockClear();
    for (const [index, file] of files.entries()) {
      expect([...await mapIndexedJsonlRecords(file, new Set([0]), row => row.id)]).toEqual([[0, String(index)]]);
    }
    expect(reader.mock.results, 'repeat lookup must seek selected rows instead of rescanning each source').toHaveLength(0);
  });

  it('does not skip an unscanned suffix after append, and rejects rewritten or missing source data', async () => {
    const file = path.join(directory, 'changing.jsonl');
    fs.writeFileSync(file, '{"id":"a"}\ninvalid\n{"id":"b"}\n');
    expect([...await mapIndexedJsonlRecords(file, new Set([0]), row => row.id)]).toEqual([[0, 'a']]);
    await appendJsonlAtomic(file, { id: 'c' });
    expect([...await mapIndexedJsonlRecords(file, new Set([1, 2]), row => row.id)]).toEqual([[1, 'b'], [2, 'c']]);
    fs.writeFileSync(file, '{"id":"new"}\n');
    expect([...await mapIndexedJsonlRecords(file, new Set([0, 2]), row => row.id)]).toEqual([[0, 'new']]);
    fs.writeFileSync(file, '{"id":"race"}\n');
    await expect(mapIndexedJsonlRecords(file, new Set([0]), row => {
      fs.writeFileSync(file, '{"id":"changed during read"}\n'); return row.id;
    })).rejects.toThrow('Conversation changed');
    fs.unlinkSync(file);
    expect([...await mapIndexedJsonlRecords(file, new Set([0]), row => row.id)]).toEqual([]);
  });

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
