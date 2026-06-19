import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  nowIso, genUserId, genId12, safeId,
  readJson, readJsonSync, writeJson, writeJsonSync,
  writeTextAtomicSync, appendJsonl, appendJsonlAtomic,
  invalidateLineCount, readJsonl, __storageTestHooks,
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

  it('genUserId returns 8 decimal digits', () => {
    for (let i = 0; i < 50; i++) {
      expect(genUserId()).toMatch(/^\d{8}$/);
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
