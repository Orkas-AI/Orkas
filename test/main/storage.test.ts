import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  nowIso, genUserId, genId12, safeId,
  readJson, readJsonSync, writeJson, writeJsonSync,
  writeTextAtomicSync, appendJsonl, appendJsonlAtomic,
  invalidateLineCount, readJsonl, readJsonlPage, readJsonlPageWithOffsets,
  readJsonlWindow, __storageTestHooks,
} from '../../src/main/storage';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-storage-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function eperm(): NodeJS.ErrnoException {
  const err = new Error('locked by another process') as NodeJS.ErrnoException;
  err.code = 'EPERM';
  return err;
}

describe('storage › timestamps & ids', () => {
  it('nowIso renders local time as YYYY-MM-DDTHH:MM:SS without TZ', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it('genUserId returns a lowercase UUID v4 without hyphens', () => {
    for (let i = 0; i < 50; i++) {
      expect(genUserId()).toMatch(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    }
  });

  it('genId12 returns 12 lowercase hex chars', () => {
    for (let i = 0; i < 50; i++) {
      expect(genId12()).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it('genId12 is unique across many invocations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(genId12());
    expect(seen.size).toBe(1000);
  });
});

describe('storage › safeId guard', () => {
  it.each([
    ['abc-123_XYZ', true],
    ['simple', true],
    ['a', true],
    ['1234', true],
  ])('accepts %s', (value, expected) => {
    expect(safeId(value)).toBe(expected);
  });

  it.each([
    '../etc/passwd',
    'a/b',
    'name with space',
    '',
    'ñ',
    'sub.dot',
  ])('rejects %s', (value) => {
    expect(safeId(value)).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(safeId(undefined)).toBe(false);
    expect(safeId(null)).toBe(false);
    expect(safeId(123)).toBe(false);
    expect(safeId({})).toBe(false);
  });
});

describe('storage › JSON IO', () => {
  it('writeJson + readJson roundtrip preserves UTF-8 and structure', async () => {
    const p = path.join(tmpDir, 'nested', 'a.json');
    const data = { x: 1, 中: '文', arr: [1, 2, 3], nested: { a: true } };
    await writeJson(p, data);
    expect(await readJson(p)).toEqual(data);
  });

  it('writeJson is atomic — no .tmp file left behind', async () => {
    const p = path.join(tmpDir, 'a.json');
    await writeJson(p, { ok: true });
    expect(fs.existsSync(p + '.tmp')).toBe(false);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('writeJson retries transient EPERM rename failures', async () => {
    const p = path.join(tmpDir, 'retry.json');
    let calls = 0;
    fs.writeFileSync(`${p}.tmp`, '{"ok":true}', 'utf8');

    await __storageTestHooks.renameWithRetryUsing(`${p}.tmp`, p, async (from, to) => {
      calls += 1;
      if (calls <= 2) throw eperm();
      await fs.promises.rename(from, to);
    });

    expect(await readJson(p)).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it.each([false, true])('guarded snapshots respect ownership through rename retries (invalidated=%s)', async (invalidate) => {
    const file = path.join(tmpDir, 'snapshot.json');
    fs.writeFileSync(file, JSON.stringify({ revision: 2 }));
    const rename = nativeFs.renameSync.bind(nativeFs);
    let owned = true;
    let attempts = 0;
    const spy = vi.spyOn(nativeFs, 'renameSync').mockImplementation((from, to) => {
      attempts += 1;
      if (attempts < 3) {
        if (invalidate) owned = false;
        throw eperm();
      }
      rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await writeJson(file, { revision: 3 }, { shouldCommit: () => owned });
      expect(readJsonSync(file)).toEqual({ revision: invalidate ? 2 : 3 });
      expect(attempts).toBe(invalidate ? 1 : 3);
      expect(fs.readdirSync(tmpDir)).toEqual(['snapshot.json']);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('readJson returns {} on missing file', async () => {
    expect(await readJson(path.join(tmpDir, 'missing.json'))).toEqual({});
  });

  it('readJson returns {} on malformed JSON', async () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, '{not valid');
    expect(await readJson(p)).toEqual({});
  });

  it('readJsonSync mirrors readJson behavior', () => {
    const p = path.join(tmpDir, 'a.json');
    writeJsonSync(p, { sync: true });
    expect(readJsonSync(p)).toEqual({ sync: true });
    expect(readJsonSync(path.join(tmpDir, 'missing.json'))).toEqual({});
  });

  it('writeTextAtomicSync carries the requested mode onto the target (0600 secrets)', () => {
    const p = path.join(tmpDir, 'secrets.json');
    writeTextAtomicSync(p, '{"s":1}', 'utf8', { mode: 0o600 });
    expect(fs.readFileSync(p, 'utf8')).toBe('{"s":1}');
    // No atomic tmp leftover next to the target.
    expect(fs.readdirSync(tmpDir).filter((n) => n.startsWith('secrets.json.'))).toEqual([]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it('writeJsonSync mkdirs nested parents', () => {
    const p = path.join(tmpDir, 'deeply', 'nested', 'x.json');
    writeJsonSync(p, { ok: 1 });
    expect(fs.existsSync(p)).toBe(true);
  });

  it('writeJsonSync retries transient EPERM rename failures', () => {
    const p = path.join(tmpDir, 'sync-retry.json');
    let calls = 0;
    fs.writeFileSync(`${p}.tmp`, '{"ok":true}', 'utf8');

    __storageTestHooks.renameWithRetrySyncUsing(`${p}.tmp`, p, (from, to) => {
      calls += 1;
      if (calls <= 2) throw eperm();
      fs.renameSync(from, to);
    });

    expect(readJsonSync(p)).toEqual({ ok: true });
    expect(calls).toBe(3);
  });
});

describe('storage › writeTextAtomicSync', () => {
  it('writes text atomically and removes .tmp', () => {
    const p = path.join(tmpDir, 'text.md');
    writeTextAtomicSync(p, '# hello\n');
    expect(fs.readFileSync(p, 'utf8')).toBe('# hello\n');
    expect(fs.existsSync(p + '.tmp')).toBe(false);
  });

  it('mkdirs nested parents', () => {
    const p = path.join(tmpDir, 'a', 'b', 'text.md');
    writeTextAtomicSync(p, 'x');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('respects encoding parameter (latin1)', () => {
    const p = path.join(tmpDir, 'l.txt');
    writeTextAtomicSync(p, 'café', 'latin1');
    expect(fs.readFileSync(p, 'latin1')).toBe('café');
  });
});

describe('storage › JSONL append/read', () => {
  it('appendJsonl + readJsonl roundtrip', async () => {
    const p = path.join(tmpDir, 'log.jsonl');
    for (let i = 0; i < 5; i++) await appendJsonl(p, { i });
    const all = await readJsonl(p);
    expect(all.map((r: any) => r.i)).toEqual([0, 1, 2, 3, 4]);
  });

  it('readJsonl returns last N records', async () => {
    const p = path.join(tmpDir, 'log.jsonl');
    for (let i = 0; i < 10; i++) await appendJsonl(p, { i });
    const last3 = await readJsonl(p, 3);
    expect(last3.map((r: any) => r.i)).toEqual([7, 8, 9]);
  });

  it('reads a bounded tail across disk chunks without parsing an old malformed row', async () => {
    const p = path.join(tmpDir, 'large-log.jsonl');
    const pad = '中'.repeat(12_000);
    const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify({ i, pad }));
    lines.splice(1, 0, '{not json');
    fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');

    const last3 = await readJsonl<{ i: number }>(p, 3);

    expect(last3.map((r) => r.i)).toEqual([9, 10, 11]);
  });

  it('pages backward by byte cursor without rereading or duplicating newer records', async () => {
    const p = path.join(tmpDir, 'paged-log.jsonl');
    const rows = Array.from({ length: 25 }, (_, i) => JSON.stringify({ i, text: `第 ${i} 条` }));
    rows.splice(13, 0, '{malformed');
    fs.writeFileSync(p, rows.join('\n') + '\n', 'utf8');

    const newest = await readJsonlPage<{ i: number }>(p, 10);
    const middle = await readJsonlPage<{ i: number }>(p, 10, newest.nextCursor);
    const oldest = await readJsonlPage<{ i: number }>(p, 10, middle.nextCursor);

    expect(newest.records.map((r) => r.i)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    expect(middle.records.map((r) => r.i)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(oldest.records.map((r) => r.i)).toEqual([0, 1, 2, 3, 4]);
    expect(oldest.nextCursor).toBeNull();
  });

  it('reports source byte offsets for sparse page projections', async () => {
    const p = path.join(tmpDir, 'offset-log.jsonl');
    const rows = [
      JSON.stringify({ i: 0, text: '短' }),
      JSON.stringify({ i: 1, text: 'longer' }),
      JSON.stringify({ i: 2, text: '尾' }),
    ];
    fs.writeFileSync(p, `${rows.join('\n')}\n`, 'utf8');

    const page = await readJsonlPageWithOffsets<{ i: number }>(p, 2);

    expect(page.entries.map(({ record }) => record.i)).toEqual([1, 2]);
    expect(page.entries.map(({ start }) => start)).toEqual([
      Buffer.byteLength(`${rows[0]}\n`, 'utf8'),
      Buffer.byteLength(`${rows[0]}\n${rows[1]}\n`, 'utf8'),
    ]);
    expect(page.nextCursor).toBe(page.entries[0].start);
  });

  it('assembles multi-megabyte tail records without repeatedly copying partial prefixes', async () => {
    const p = path.join(tmpDir, 'wide-records.jsonl');
    const pad = 'x'.repeat(2 * 1024 * 1024);
    const rows = Array.from({ length: 3 }, (_, i) => JSON.stringify({ i, pad }));
    fs.writeFileSync(p, `${rows.join('\n')}\n`, 'utf8');
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      const page = await readJsonlPageWithOffsets<{ i: number }>(p, 2);

      expect(page.entries.map(({ record }) => record.i)).toEqual([1, 2]);
      expect(concat.mock.calls.length).toBeLessThanOrEqual(2);

      concat.mockClear();
      const window = await readJsonlWindow<{ i: number }>(p, 1, 2);
      expect(window.records.map((record) => record.i)).toEqual([1, 2]);
      expect(concat.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      concat.mockRestore();
    }
  });

  it('reads the page containing a parsed-record index in one bounded window', async () => {
    const p = path.join(tmpDir, 'indexed-log.jsonl');
    const pad = '中'.repeat(4_000);
    const rows = Array.from({ length: 30 }, (_, i) => JSON.stringify({ i, text: `${i}:${pad}` }));
    rows.splice(7, 0, '{malformed');
    fs.writeFileSync(p, rows.join('\n') + '\n', 'utf8');

    const targetPage = await readJsonlWindow<{ i: number }>(p, 20, 10);
    const previousPage = await readJsonlPage<{ i: number }>(p, 10, targetPage.previousCursor);

    expect(targetPage.records.map((row) => row.i)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect(previousPage.records.map((row) => row.i)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('continues forward at byte boundaries across large Unicode records and an unterminated tail', async () => {
    const p = path.join(tmpDir, 'forward-log.jsonl');
    const text = '中文🙂'.repeat(20_000);
    fs.writeFileSync(p, JSON.stringify({ i: 0, text }) + '\n{broken\n' +
      JSON.stringify({ i: 1, text }) + '\n' + JSON.stringify({ i: 2, text }));
    const first = await readJsonlWindow<{ i: number; text: string }>(p, 0, 1);
    const second = await readJsonlWindow<{ i: number; text: string }>(p, 0, 1, undefined, first.followingCursor!);
    const third = await readJsonlWindow<{ i: number; text: string }>(p, 0, 1, undefined, second.followingCursor!);
    expect([first.records[0].i, second.records[0].i, third.records[0].i]).toEqual([0, 1, 2]);
    expect(third.records[0].text).toBe(text);
    expect(third.followingCursor).toBeNull();
    expect((await readJsonlPage<{ i: number }>(p, 2, third.previousCursor)).records.map(row => row.i)).toEqual([0, 1]);
  });

  it('reads only the needed tail bytes of a large file, including an older page after new messages arrive', async () => {
    const p = path.join(tmpDir, 'large-paged.jsonl');
    const fd = fs.openSync(p, 'w');
    try {
      for (let i = 0; i < 1024; i++) fs.writeSync(fd, JSON.stringify({ i, text: 'x'.repeat(32768) }) + '\n');
    } finally { fs.closeSync(fd); }
    const size = fs.statSync(p).size;
    expect(size).toBeGreaterThan(32 * 1024 * 1024);
    const open = fs.promises.open.bind(fs.promises);
    const readFile = fs.promises.readFile.bind(fs.promises);
    let bytes = 0;
    let lowestPosition = size;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await (open as any)(...args);
      if (String(args[0]) !== p) return handle;
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs: any[]) => {
        const [, , length, position] = readArgs;
        expect(length).toBeLessThanOrEqual(1024 * 1024);
        lowestPosition = Math.min(lowestPosition, position);
        const result = await read(...readArgs);
        bytes += result.bytesRead;
        expect(bytes, 'A small page must not scan or allocate the complete conversation').toBeLessThan(1024 * 1024);
        return result;
      };
      handle.readFile = async () => { throw new Error('Whole history read is forbidden'); };
      return handle;
    });
    const fileSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation((...args: any[]) => {
      if (String(args[0]) === p) throw new Error('Whole history read is forbidden');
      return (readFile as any)(...args);
    });
    syncBuiltinESMExports();
    try {
      const latest = await readJsonlPage<{ i: number }>(p, 10);
      expect(latest.records.map(r => r.i)).toEqual([1014, 1015, 1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023]);
      expect(bytes).toBeGreaterThan(0);
      expect(lowestPosition).toBeGreaterThan(size - 1024 * 1024);
      fs.appendFileSync(p, JSON.stringify({ i: 1024, text: 'arrived later' }) + '\n');
      bytes = 0;
      lowestPosition = size;
      const older = await readJsonlPage<{ i: number }>(p, 10, latest.nextCursor);
      expect(older.records.map(r => r.i)).toEqual([1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013]);
      expect(bytes).toBeGreaterThan(0);
      expect(lowestPosition).toBeGreaterThan(latest.nextCursor! - 1024 * 1024);
      expect(older.nextCursor).toBeLessThan(latest.nextCursor!);
    } finally { openSpy.mockRestore(); fileSpy.mockRestore(); syncBuiltinESMExports(); }
  });

  it('preserves a huge Unicode record across chunks, malformed rows, CRLF and an unterminated tail', async () => {
    const p = path.join(tmpDir, 'unicode-pages.jsonl');
    const text = '开头😀\n\\(x^2\\) ' + '中文🚀'.repeat(200_000) + ' 完整结尾';
    const prefix = JSON.stringify({ i: 0, text: 'first' }) + '\r\n{malformed}\r\n\r\n';
    const wide = JSON.stringify({ i: 1, text });
    fs.writeFileSync(p, prefix + wide + '\r\n' + JSON.stringify({ i: 2, text: 'last' }));
    const tail = await readJsonlPage<{ i: number; text: string }>(p, 1);
    expect(tail.records).toEqual([{ i: 2, text: 'last' }]);
    expect(tail.nextCursor).toBe(Buffer.byteLength(prefix + wide + '\r\n'));
    const middle = await readJsonlPage<{ i: number; text: string }>(p, 1, tail.nextCursor);
    expect(middle.records).toEqual([{ i: 1, text }]);
    expect(middle.nextCursor).toBe(Buffer.byteLength(prefix));
    const first = await readJsonlPage(p, 1, middle.nextCursor);
    expect(first).toEqual({ records: [{ i: 0, text: 'first' }], nextCursor: null });
  });

  it('projects a search tail as it is read rather than retaining the entire raw window first', async () => {
    const p = path.join(tmpDir, 'projected-window.jsonl');
    const fd = fs.openSync(p, 'w');
    try {
      for (let i = 0; i < 100; i++) fs.writeSync(fd, JSON.stringify({ i, text: 'y'.repeat(65536) }) + '\n');
    } finally { fs.closeSync(fd); }
    const size = fs.statSync(p).size;
    const open = fs.promises.open.bind(fs.promises);
    let lastReadEnd = 0;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await (open as any)(...args);
      if (String(args[0]) !== p) return handle;
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs: any[]) => {
        const result = await read(...readArgs);
        lastReadEnd = readArgs[3] + result.bytesRead;
        return result;
      };
      return handle;
    });
    syncBuiltinESMExports();
    try {
      const projected = await readJsonlWindow<{ i: number; text: string }>(p, 2, Number.MAX_SAFE_INTEGER, record => {
        if (record.i === 2) {
          expect(lastReadEnd).toBeGreaterThan(0);
          expect(lastReadEnd, 'Projection must begin before reading the rest of the source').toBeLessThan(size / 2);
        }
        return { i: record.i, text: 'preview' };
      });
      expect(projected.records).toEqual(Array.from({ length: 98 }, (_, i) => ({ i: i + 2, text: 'preview' })));
      expect(projected.previousCursor).toBeGreaterThan(0);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });

  it('readJsonl skips malformed lines silently', async () => {
    const p = path.join(tmpDir, 'log.jsonl');
    fs.writeFileSync(p, '{"i":1}\n{not json\n{"i":2}\n\n{"i":3}\n');
    const all = await readJsonl(p);
    expect(all.map((r: any) => r.i)).toEqual([1, 2, 3]);
  });

  it('readJsonl returns [] on missing file', async () => {
    expect(await readJsonl(path.join(tmpDir, 'missing.jsonl'))).toEqual([]);
  });
});

describe('storage › appendJsonlAtomic', () => {
  it('returns durable UTF-8 byte ranges in append order without retaining message bodies', async () => {
    const p = path.join(tmpDir, 'receipts.jsonl');
    const messages = [{ text: '你好 🌊' }, { text: 'second' }, { text: '尾部' }];
    const results = await Promise.all(messages.map(message => appendJsonlAtomic(p, message, true)));
    results.sort((a, b) => a.msgIndex - b.msgIndex);
    const bytes = fs.readFileSync(p);
    const stat = fs.statSync(p);
    expect(results.map(result => result.msgIndex)).toEqual([0, 1, 2]);
    for (const [i, result] of results.entries()) {
      const source = result.source!;
      expect(JSON.parse(bytes.subarray(source.offset, source.offset + source.bytes).toString('utf8'))).toEqual(result.record);
      expect(source).toMatchObject({ kind: 'jsonl-append', dev: stat.dev, ino: stat.ino });
      expect(source.offset).toBe(i ? results[i - 1].source!.size : 0);
      expect(source.size).toBe(source.offset + source.bytes);
      expect(JSON.stringify(source)).not.toContain(result.record.text);
    }
  });
  it('returns monotonic msgIndex starting from 0 on fresh file', async () => {
    const p = path.join(tmpDir, 'log.jsonl');
    invalidateLineCount(p);
    const r0 = await appendJsonlAtomic(p, { i: 0 });
    const r1 = await appendJsonlAtomic(p, { i: 1 });
    const r2 = await appendJsonlAtomic(p, { i: 2 });
    expect(r0.msgIndex).toBe(0);
    expect(r1.msgIndex).toBe(1);
    expect(r2.msgIndex).toBe(2);
  });

  it('continues from existing file line count', async () => {
    const p = path.join(tmpDir, 'log.jsonl');
    fs.writeFileSync(p, '{"x":1}\n{"x":2}\n');
    invalidateLineCount(p);
    const r = await appendJsonlAtomic(p, { x: 3 });
    expect(r.msgIndex).toBe(2);
  });

  it('serializes concurrent appends — no duplicate indices', async () => {
    const p = path.join(tmpDir, 'log.jsonl');
    invalidateLineCount(p);
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => appendJsonlAtomic(p, { i }))
    );
    const indices = results.map((r) => r.msgIndex).sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it('invalidateLineCount forces recount from disk', async () => {
    const p = path.join(tmpDir, 'log.jsonl');
    invalidateLineCount(p);
    await appendJsonlAtomic(p, { i: 0 });
    // External truncation (e.g. file was rotated)
    fs.writeFileSync(p, '');
    invalidateLineCount(p);
    const r = await appendJsonlAtomic(p, { i: 1 });
    expect(r.msgIndex).toBe(0);
  });
});
