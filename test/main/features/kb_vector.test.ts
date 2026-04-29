import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// kb_vector opens a per-uid sqlite database under <uid>/cloud/contexts/.kb/.
// Each test resets ORKAS_WORKSPACE_ROOT + the module graph so the per-uid
// cache map doesn't leak handles across runs.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'kbtest';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kb-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  try {
    const kb = await import('../../../src/main/features/kb_vector');
    kb.closeAllKb();
  } catch { /* ignore */ }
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadKb() {
  return import('../../../src/main/features/kb_vector');
}

// Build an arbitrary 512-dim vector that's roughly aligned with `seed` so
// fabricated similarity assertions stay predictable. The first 3 dims encode
// seed; the rest are zero. sqlite-vec uses L2 over raw vectors.
function fakeVec(a: number, b = 0, c = 0): number[] {
  const v = new Array(512).fill(0);
  v[0] = a;
  v[1] = b;
  v[2] = c;
  return v;
}

describe('kb_vector › openKb / schema', () => {
  it('creates tables + config file on first open', async () => {
    const kb = await loadKb();
    const paths = await import('../../../src/main/paths');

    const handle = kb.openKb(TEST_UID);
    expect(fs.existsSync(handle.dbPath)).toBe(true);
    expect(fs.existsSync(paths.userKbConfigPath(TEST_UID))).toBe(true);

    const tables = handle.db.prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`,
    ).all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('kb_files');
    expect(names).toContain('kb_chunks');
    expect(names).toContain('kb_vec');
  });

  it('writes config with locked embedder + dim', async () => {
    const kb = await loadKb();
    const paths = await import('../../../src/main/paths');
    kb.openKb(TEST_UID);
    const cfg = JSON.parse(fs.readFileSync(paths.userKbConfigPath(TEST_UID), 'utf8'));
    expect(cfg.embedder).toBe(kb.KB_EMBEDDER);
    expect(cfg.dim).toBe(kb.KB_DIM);
  });

  it('reuses cached handle on second open', async () => {
    const kb = await loadKb();
    const a = kb.openKb(TEST_UID);
    const b = kb.openKb(TEST_UID);
    // Adapter returns fresh wrapper objects on each call, but the underlying
    // better-sqlite3 Database handle is cached in the store — same instance.
    expect(a.db).toBe(b.db);
  });

  it('rejects a pre-existing config with wrong dim', async () => {
    const kb = await loadKb();
    const paths = await import('../../../src/main/paths');
    fs.mkdirSync(paths.userKbDir(TEST_UID), { recursive: true });
    fs.writeFileSync(
      paths.userKbConfigPath(TEST_UID),
      JSON.stringify({ embedder: 'other', dim: 768 }),
    );
    expect(() => kb.openKb(TEST_UID)).toThrow(/config mismatch/);
  });
});

describe('kb_vector › upsertFile', () => {
  it('inserts file + chunks + vectors on first call', async () => {
    const kb = await loadKb();
    await kb.upsertFile(TEST_UID, {
      relPath: 'a.md',
      kind: 'text',
      bytes: 100,
      mtime: 1,
      sha1: 'aaa',
      chunks: [
        { title: 't1', content: 'c1', embedding: fakeVec(1) },
        { title: 't2', content: 'c2', embedding: fakeVec(0, 1) },
      ],
    });

    const { db } = kb.openKb(TEST_UID);
    const f = db.prepare(`SELECT * FROM kb_files WHERE rel_path='a.md'`).get() as { chunks: number; status: string };
    expect(f.chunks).toBe(2);
    expect(f.status).toBe('ready');

    const chunkCount = (db.prepare(`SELECT COUNT(*) AS n FROM kb_chunks`).get() as { n: number }).n;
    expect(chunkCount).toBe(2);
    const vecCount = (db.prepare(`SELECT COUNT(*) AS n FROM kb_vec`).get() as { n: number }).n;
    expect(vecCount).toBe(2);
  });

  it('replaces old chunks on re-upsert (no orphans)', async () => {
    const kb = await loadKb();
    await kb.upsertFile(TEST_UID, {
      relPath: 'a.md', kind: 'text', bytes: 100, mtime: 1, sha1: 'v1',
      chunks: [
        { title: 'old1', content: 'old1', embedding: fakeVec(1) },
        { title: 'old2', content: 'old2', embedding: fakeVec(2) },
        { title: 'old3', content: 'old3', embedding: fakeVec(3) },
      ],
    });
    await kb.upsertFile(TEST_UID, {
      relPath: 'a.md', kind: 'text', bytes: 120, mtime: 2, sha1: 'v2',
      chunks: [
        { title: 'new1', content: 'new1', embedding: fakeVec(5) },
      ],
    });

    const { db } = kb.openKb(TEST_UID);
    const f = db.prepare(`SELECT chunks, sha1, bytes FROM kb_files WHERE rel_path='a.md'`).get() as { chunks: number; sha1: string; bytes: number };
    expect(f.chunks).toBe(1);
    expect(f.sha1).toBe('v2');
    expect(f.bytes).toBe(120);

    const chunkRows = db.prepare(`SELECT title FROM kb_chunks`).all() as Array<{ title: string }>;
    expect(chunkRows.map((r) => r.title)).toEqual(['new1']);
    const vecCount = (db.prepare(`SELECT COUNT(*) AS n FROM kb_vec`).get() as { n: number }).n;
    expect(vecCount).toBe(1);
  });

  it('rejects embedding with wrong dim', async () => {
    const kb = await loadKb();
    await expect(kb.upsertFile(TEST_UID, {
      relPath: 'bad.md', kind: 'text', bytes: 10, mtime: 1, sha1: 'x',
      chunks: [{ title: 't', content: 'c', embedding: [1, 2, 3] }],
    })).rejects.toThrow(/embedding dim mismatch/);
  });
});

describe('kb_vector › deleteFile', () => {
  it('removes row + chunks + vectors and returns true', async () => {
    const kb = await loadKb();
    await kb.upsertFile(TEST_UID, {
      relPath: 'a.md', kind: 'text', bytes: 10, mtime: 1, sha1: 'x',
      chunks: [{ title: 't', content: 'c', embedding: fakeVec(1) }],
    });
    const ok = await kb.deleteFile(TEST_UID, 'a.md');
    expect(ok).toBe(true);

    const { db } = kb.openKb(TEST_UID);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM kb_files`).get() as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM kb_chunks`).get() as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM kb_vec`).get() as { n: number }).n).toBe(0);
  });

  it('returns false for unknown path', async () => {
    const kb = await loadKb();
    const ok = await kb.deleteFile(TEST_UID, 'nope.md');
    expect(ok).toBe(false);
  });
});

describe('kb_vector › search', () => {
  async function seed(kb: typeof import('../../../src/main/features/kb_vector')) {
    await kb.upsertFile(TEST_UID, {
      relPath: 'notes/a.md', kind: 'text', bytes: 10, mtime: 1, sha1: 'a',
      chunks: [
        { title: 'A1', content: 'content A1', embedding: fakeVec(1, 0) },
        { title: 'A2', content: 'content A2', embedding: fakeVec(0, 1) },
      ],
    });
    await kb.upsertFile(TEST_UID, {
      relPath: 'drafts/b.md', kind: 'text', bytes: 10, mtime: 1, sha1: 'b',
      chunks: [
        { title: 'B1', content: 'content B1', embedding: fakeVec(0.9, 0.1) },
      ],
    });
    await kb.upsertFile(TEST_UID, {
      relPath: 'imgs/c.png', kind: 'image', bytes: 10, mtime: 1, sha1: 'c',
      chunks: [
        { title: 'C1', content: 'content C1', embedding: fakeVec(1, 0.01) },
      ],
    });
  }

  it('returns nearest neighbors across files', async () => {
    const kb = await loadKb();
    await seed(kb);
    const hits = kb.search(TEST_UID, fakeVec(1, 0), { k: 3 });
    expect(hits.length).toBe(3);
    // Nearest to (1,0): A1 is exact match, then C1 (1, 0.01), then B1 (0.9, 0.1).
    expect(hits[0].rel_path).toBe('notes/a.md');
    expect(hits[0].chunk_idx).toBe(1);
    expect(hits[0].score).toBeCloseTo(1, 3);
  });

  it('filters by dir', async () => {
    const kb = await loadKb();
    await seed(kb);
    const hits = kb.search(TEST_UID, fakeVec(1, 0), { k: 5, dir: 'notes' });
    expect(hits.every((h) => h.rel_path.startsWith('notes/'))).toBe(true);
    expect(hits.length).toBe(2);
  });

  it('filters by kind', async () => {
    const kb = await loadKb();
    await seed(kb);
    const hits = kb.search(TEST_UID, fakeVec(1, 0), { k: 5, kind: 'image' });
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe('image');
    expect(hits[0].rel_path).toBe('imgs/c.png');
  });

  it('excludes files whose status is not ready', async () => {
    const kb = await loadKb();
    await seed(kb);
    await kb.setFileStatus(TEST_UID, 'notes/a.md', 'processing');
    const hits = kb.search(TEST_UID, fakeVec(1, 0), { k: 5 });
    expect(hits.some((h) => h.rel_path === 'notes/a.md')).toBe(false);
  });
});

describe('kb_vector › status + listing', () => {
  it('statusSummary aggregates by status', async () => {
    const kb = await loadKb();
    await kb.upsertFile(TEST_UID, {
      relPath: 'a.md', kind: 'text', bytes: 10, mtime: 1, sha1: 'a',
      chunks: [{ title: 't', content: 'c', embedding: fakeVec(1) }],
    });
    await kb.setFileStatus(TEST_UID, 'b.md', 'processing', { kind: 'pdf', bytes: 1, mtime: 1, sha1: 'b' });
    await kb.setFileStatus(TEST_UID, 'c.md', 'failed', { kind: 'docx', bytes: 1, mtime: 1, sha1: 'c', error: 'x' });

    const s = kb.statusSummary(TEST_UID);
    expect(s.total).toBe(3);
    expect(s.ready).toBe(1);
    expect(s.processing).toBe(1);
    expect(s.failed).toBe(1);
  });

  it('readFileChunks returns chunks in order', async () => {
    const kb = await loadKb();
    await kb.upsertFile(TEST_UID, {
      relPath: 'a.md', kind: 'text', bytes: 10, mtime: 1, sha1: 'a',
      chunks: [
        { title: 't1', content: 'first', embedding: fakeVec(1) },
        { title: 't2', content: 'second', embedding: fakeVec(2) },
      ],
    });
    const chunks = kb.readFileChunks(TEST_UID, 'a.md');
    expect(chunks.length).toBe(2);
    expect(chunks[0].content).toBe('first');
    expect(chunks[1].content).toBe('second');
  });
});
