import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  emptyIndex, loadIndex, saveIndex, SCHEMA_VERSION,
  type Index,
} from '../../../../src/main/features/search/storage';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-search-storage-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('search/storage › emptyIndex', () => {
  it('returns the schema version + matching kind', () => {
    const idx = emptyIndex('chat');
    expect(idx.version).toBe(SCHEMA_VERSION);
    expect(idx.kind).toBe('chat');
  });

  it('initializes files / docs / postings as plain bag objects', () => {
    const idx = emptyIndex('context');
    expect(idx.files).toEqual({});
    expect(idx.docs).toEqual({});
    expect(idx.postings).toEqual({});
  });

  it('uses null-prototype objects to avoid prototype pollution', () => {
    const idx = emptyIndex('context');
    expect(Object.getPrototypeOf(idx.files)).toBeNull();
    expect(Object.getPrototypeOf(idx.docs)).toBeNull();
    expect(Object.getPrototypeOf(idx.postings)).toBeNull();
  });
});

describe('search/storage › loadIndex', () => {
  it('returns empty index when file is missing', async () => {
    const idx = await loadIndex(path.join(tmpDir, 'missing.json'), 'chat');
    expect(idx).toEqual(emptyIndex('chat'));
  });

  it('returns empty index when JSON is malformed', async () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, '{not valid');
    const idx = await loadIndex(p, 'chat');
    expect(idx).toEqual(emptyIndex('chat'));
  });

  it('returns empty index when schema version mismatches', async () => {
    const p = path.join(tmpDir, 'old.json');
    fs.writeFileSync(p, JSON.stringify({ version: 1, kind: 'chat', files: {}, docs: {}, postings: {} }));
    const idx = await loadIndex(p, 'chat');
    expect(idx.version).toBe(SCHEMA_VERSION);
    expect(idx.docs).toEqual({});
  });

  it('returns empty index when kind mismatches', async () => {
    const p = path.join(tmpDir, 'wrong-kind.json');
    fs.writeFileSync(p, JSON.stringify({ version: SCHEMA_VERSION, kind: 'chat', files: {}, docs: {}, postings: {} }));
    const idx = await loadIndex(p, 'context');
    expect(idx.kind).toBe('context');
    expect(idx.docs).toEqual({});
  });

  it('loads valid index intact and back-fills missing sub-bags', async () => {
    const p = path.join(tmpDir, 'good.json');
    const stored = {
      version: SCHEMA_VERSION,
      kind: 'context',
      files: { 'a.md': { mtime: 1, size: 100 } },
      docs: { d1: { kind: 'context', fileKey: 'a.md', len: 5 } },
      // postings intentionally omitted to verify back-fill
    };
    fs.writeFileSync(p, JSON.stringify(stored));
    const idx = await loadIndex(p, 'context');
    expect(idx.files['a.md']).toEqual({ mtime: 1, size: 100 });
    expect(idx.docs.d1).toMatchObject({ kind: 'context', fileKey: 'a.md', len: 5 });
    expect(idx.postings).toEqual({});
  });
});

describe('search/storage › saveIndex', () => {
  it('saveIndex + loadIndex roundtrip preserves shape', async () => {
    const p = path.join(tmpDir, 'rt.json');
    const idx: Index = {
      version: SCHEMA_VERSION,
      kind: 'chat',
      files: { 'log.jsonl': { mtime: 42, size: 1024 } },
      docs: { d1: { kind: 'chat', fileKey: 'log.jsonl', len: 10 } as any },
      postings: { hello: [['d1', 3]] },
    };
    await saveIndex(p, idx);
    const loaded = await loadIndex(p, 'chat');
    expect(loaded.files['log.jsonl']).toEqual({ mtime: 42, size: 1024 });
    expect(loaded.docs.d1).toMatchObject({ fileKey: 'log.jsonl', len: 10 });
    expect(loaded.postings.hello).toEqual([['d1', 3]]);
  });

  it('saveIndex is atomic — no .tmp left behind', async () => {
    const p = path.join(tmpDir, 'atomic.json');
    await saveIndex(p, emptyIndex('chat'));
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.existsSync(p + '.tmp')).toBe(false);
  });

  it('saveIndex mkdirs nested parent directories', async () => {
    const p = path.join(tmpDir, 'deep', 'nested', 'idx.json');
    await saveIndex(p, emptyIndex('skill_chat'));
    expect(fs.existsSync(p)).toBe(true);
  });
});
