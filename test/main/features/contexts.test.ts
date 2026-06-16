import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * contexts.ts tests for the single-region user-owned model. Mocks
 * kb_indexer + search so mutation side-effects don't pull in fastembed /
 * sqlite-vec at module load — we're testing the filesystem + path-safety
 * contract here, not indexer behaviour (covered in kb_indexer.test.ts).
 */

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

const kbEnqueueCalls: Array<{ userId: string; relPath: string; op: string }> = [];
vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: (userId: string, relPath: string, op = 'upsert') => {
    kbEnqueueCalls.push({ userId, relPath, op });
  },
  // Surface a no-op kbEvents so code paths that import it don't NPE.
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));

const searchCalls: Array<{ action: string; userId: string; path: string }> = [];
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: (userId: string, path: string) => {
    searchCalls.push({ action: 'upsert', userId, path });
  },
  dropContext: (userId: string, path: string) => {
    searchCalls.push({ action: 'drop', userId, path });
  },
  // Minimal no-op stubs for other helpers that contexts.ts doesn't use.
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-contexts-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  kbEnqueueCalls.length = 0;
  searchCalls.length = 0;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadContexts() {
  // Pin i18n to zh so assertions on Chinese error substrings stay stable.
  const i18n = await import('../../../src/main/i18n');
  i18n.setCurrentLang('zh');
  return import('../../../src/main/features/contexts');
}

function ctxRoot(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'contexts');
}

function writeFile(rel: string, body: string | Buffer): void {
  const full = path.join(ctxRoot(), rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

describe('contexts › path safety', () => {
  it('writeContextFile rejects path traversal', async () => {
    const c = await loadContexts();
    const r = c.writeContextFile('../evil.md', 'x');
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/invalid path|escapes/i);
  });

  it('writeContextFile rejects double-dot segment', async () => {
    const c = await loadContexts();
    const r = c.writeContextFile('foo/../bar.md', 'x');
    expect(r.ok).toBe(false);
  });

  it('writeContextFile rejects dot-prefixed segment (reserved .kb/ etc)', async () => {
    const c = await loadContexts();
    const r = c.writeContextFile('.kb/evil.md', 'x');
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/hidden/i);
  });

  it('uploadContextFile rejects traversal', async () => {
    const c = await loadContexts();
    const r = c.uploadContextFile('../evil.pdf', Buffer.from([1, 2, 3]));
    expect(r.ok).toBe(false);
  });

  it('createContextDir rejects dot-prefixed', async () => {
    const c = await loadContexts();
    const r = c.createContextDir('.hidden');
    expect(r.ok).toBe(false);
  });

  it('updateContextFile refuses to touch _INDEX.md', async () => {
    writeFile('_INDEX.md', '# idx');
    const c = await loadContexts();
    const r = c.updateContextFile('_INDEX.md', 'tampered');
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('系统索引');
  });
});

describe('contexts › writeContextFile', () => {
  it('creates nested dirs as needed', async () => {
    const c = await loadContexts();
    const r = c.writeContextFile('domain/sub/note.md', '# Note\nbody');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(ctxRoot(), 'domain/sub/note.md'), 'utf8')).toBe('# Note\nbody');
  });

  it('accepts every text extension in the whitelist', async () => {
    const c = await loadContexts();
    const exts = ['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log'];
    for (const ext of exts) {
      const r = c.writeContextFile(`f${ext}`, 'content');
      expect(r.ok, ext).toBe(true);
    }
  });

  it('rejects binary extensions (use uploadContextFile)', async () => {
    const c = await loadContexts();
    const r = c.writeContextFile('bad.pdf', 'x');
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('.pdf');
  });

  it('triggers kb_indexer enqueue + search upsert', async () => {
    const c = await loadContexts();
    c.writeContextFile('note.md', '# note');
    expect(kbEnqueueCalls).toContainEqual({ userId: TEST_UID, relPath: 'note.md', op: 'upsert' });
    expect(searchCalls).toContainEqual({ action: 'upsert', userId: TEST_UID, path: 'note.md' });
  });

  it('does not enqueue for _INDEX.md writes', async () => {
    const c = await loadContexts();
    c.writeContextFile('_INDEX.md', '# idx');
    expect(kbEnqueueCalls).toHaveLength(0);
  });
});

describe('contexts › content-level dedup', () => {
  it('rejects upload with sha1 matching a different existing path', async () => {
    const c = await loadContexts();
    // Seed: write real PDF bytes at /work/a.pdf so the KB flow produces a
    // kb_files row (indexer is mocked, so we seed kb_vector directly).
    const buf = Buffer.from('%PDF-1.4\n%%EOF\n'); // minimal PDF-ish payload
    const up1 = c.uploadContextFile('work/a.pdf', buf);
    expect(up1.ok).toBe(true);

    // Insert a ready kb_files row so findBySha1 has something to match on.
    const kb = await import('../../../src/main/features/kb_vector');
    const crypto = await import('node:crypto');
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    await kb.upsertFile(TEST_UID, {
      relPath: 'work/a.pdf', kind: 'pdf', bytes: buf.length, mtime: 1, sha1,
      chunks: [{ title: 't', content: 'c', embedding: new Array(512).fill(0) }],
    });

    // Now upload identical bytes at a different path → must reject.
    const up2 = c.uploadContextFile('archive/dup.pdf', buf);
    expect(up2.ok).toBe(false);
    expect((up2 as { ok: false; error: string }).error).toMatch(/work\/a\.pdf/);
    // Sanity: file should NOT be written to disk.
    expect(fs.existsSync(path.join(ctxRoot(), 'archive/dup.pdf'))).toBe(false);
  });

  it('rejects re-upload of identical content to the same path too', async () => {
    // Policy: no duplicate bytes anywhere — even re-uploading the same file
    // to its original path should prompt the user rather than silently no-op.
    const c = await loadContexts();
    const buf = Buffer.from('%PDF-1.4\n%%EOF\n');
    expect(c.uploadContextFile('work/a.pdf', buf).ok).toBe(true);

    const kb = await import('../../../src/main/features/kb_vector');
    const crypto = await import('node:crypto');
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    await kb.upsertFile(TEST_UID, {
      relPath: 'work/a.pdf', kind: 'pdf', bytes: buf.length, mtime: 1, sha1,
      chunks: [{ title: 't', content: 'c', embedding: new Array(512).fill(0) }],
    });

    const up2 = c.uploadContextFile('work/a.pdf', buf);
    expect(up2.ok).toBe(false);
    expect((up2 as { ok: false; error: string }).error).toMatch(/work\/a\.pdf/);
  });

  it('rejects writeContextFile with sha1 matching a different existing path', async () => {
    const c = await loadContexts();
    const content = '# Hello\n\nshared note body';
    expect(c.writeContextFile('notes/a.md', content).ok).toBe(true);

    const kb = await import('../../../src/main/features/kb_vector');
    const crypto = await import('node:crypto');
    const sha1 = crypto.createHash('sha1').update(content, 'utf8').digest('hex');
    await kb.upsertFile(TEST_UID, {
      relPath: 'notes/a.md', kind: 'text', bytes: Buffer.byteLength(content), mtime: 1, sha1,
      chunks: [{ title: 't', content, embedding: new Array(512).fill(0) }],
    });

    const w2 = c.writeContextFile('archive/copy.md', content);
    expect(w2.ok).toBe(false);
    expect((w2 as { ok: false; error: string }).error).toMatch(/notes\/a\.md/);
  });

  it('allows empty content write/upload without dedup check', async () => {
    const c = await loadContexts();
    // Two empty files at different paths — sha1 of '' is meaningless, don't
    // false-positive on empty stubs users create as placeholders.
    expect(c.writeContextFile('a.md', '').ok).toBe(true);
    expect(c.writeContextFile('b.md', '').ok).toBe(true);
  });

  it('allows writes and uploads when duplicate lookup is unavailable', async () => {
    const kb = await import('../../../src/main/features/kb_vector');
    const spy = vi.spyOn(kb, 'findBySha1').mockImplementation(() => {
      throw new Error('sqlite-vec load failed: 找不到指定的模块。');
    });

    try {
      const c = await loadContexts();
      const written = c.writeContextFile('LICENSE.electron.txt', 'license body');
      const uploaded = c.uploadContextFile('upload.txt', Buffer.from('upload body'));

      expect(written.ok).toBe(true);
      expect(uploaded.ok).toBe(true);
      expect(fs.existsSync(path.join(ctxRoot(), 'LICENSE.electron.txt'))).toBe(true);
      expect(fs.existsSync(path.join(ctxRoot(), 'upload.txt'))).toBe(true);
      expect(kbEnqueueCalls).toContainEqual({ userId: TEST_UID, relPath: 'LICENSE.electron.txt', op: 'upsert' });
      expect(kbEnqueueCalls).toContainEqual({ userId: TEST_UID, relPath: 'upload.txt', op: 'upsert' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('contexts › uploadContextFile', () => {
  it('accepts pdf bytes', async () => {
    const c = await loadContexts();
    const r = c.uploadContextFile('doc.pdf', Buffer.from('%PDF-1.4\n'));
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(ctxRoot(), 'doc.pdf'))).toBe(true);
  });

  it('accepts image bytes (non-UTF8 ok)', async () => {
    const c = await loadContexts();
    const r = c.uploadContextFile('img.png', Buffer.from([0xff, 0x80, 0x00, 0x13]));
    expect(r.ok).toBe(true);
  });

  it('rejects unsupported extension', async () => {
    const c = await loadContexts();
    const r = c.uploadContextFile('malware.exe', Buffer.from([0]));
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('仅支持以下格式');
  });

  it('triggers kb_indexer enqueue', async () => {
    const c = await loadContexts();
    c.uploadContextFile('note.pdf', Buffer.from('x'));
    expect(kbEnqueueCalls).toContainEqual({ userId: TEST_UID, relPath: 'note.pdf', op: 'upsert' });
  });
});

describe('contexts › deleteContextTarget', () => {
  it('removes a file + enqueues delete', async () => {
    writeFile('a.md', '# a');
    const c = await loadContexts();
    const r = c.deleteContextTarget('a.md');
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(ctxRoot(), 'a.md'))).toBe(false);
    expect(kbEnqueueCalls).toContainEqual({ userId: TEST_UID, relPath: 'a.md', op: 'delete' });
  });

  it('recursively removes a dir and enqueues deletes for each file', async () => {
    writeFile('domain/a.md', '# a');
    writeFile('domain/b.pdf', 'PDF');
    const c = await loadContexts();
    const r = c.deleteContextTarget('domain');
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(ctxRoot(), 'domain'))).toBe(false);
    const deletes = kbEnqueueCalls.filter((c) => c.op === 'delete').map((c) => c.relPath).sort();
    expect(deletes).toEqual(['domain/a.md', 'domain/b.pdf']);
  });

  it('returns error on missing target', async () => {
    const c = await loadContexts();
    const r = c.deleteContextTarget('missing.md');
    expect(r.ok).toBe(false);
  });

  it('refuses to touch _INDEX.md', async () => {
    writeFile('_INDEX.md', '# idx');
    const c = await loadContexts();
    const r = c.deleteContextTarget('_INDEX.md');
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('系统索引');
  });
});

describe('contexts › renameContextEntry', () => {
  it('renames a file and re-enqueues under new path', async () => {
    writeFile('old.md', '# body');
    const c = await loadContexts();
    const r = c.renameContextEntry('old.md', 'new.md');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(ctxRoot(), 'new.md'), 'utf8')).toBe('# body');
    const ops = kbEnqueueCalls.map((c) => `${c.op}:${c.relPath}`).sort();
    expect(ops).toContain('delete:old.md');
    expect(ops).toContain('upsert:new.md');
  });

  it('refuses extension change to unsupported', async () => {
    writeFile('old.md', '# body');
    const c = await loadContexts();
    const r = c.renameContextEntry('old.md', 'new.exe');
    expect(r.ok).toBe(false);
  });

  it('allows extension change within allowed set (md → txt)', async () => {
    writeFile('old.md', 'hi');
    const c = await loadContexts();
    const r = c.renameContextEntry('old.md', 'new.txt');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(ctxRoot(), 'new.txt'), 'utf8')).toBe('hi');
  });

  it('refuses when destination already exists', async () => {
    writeFile('a.md', 'a');
    writeFile('b.md', 'b');
    const c = await loadContexts();
    const r = c.renameContextEntry('a.md', 'b.md');
    expect(r.ok).toBe(false);
  });
});

describe('contexts › createContextDir', () => {
  it('creates a nested dir', async () => {
    const c = await loadContexts();
    const r = c.createContextDir('a/b/c');
    expect(r.ok).toBe(true);
    expect(fs.statSync(path.join(ctxRoot(), 'a/b/c')).isDirectory()).toBe(true);
  });

  it('is idempotent for existing dir', async () => {
    const c = await loadContexts();
    c.createContextDir('x');
    const r = c.createContextDir('x');
    expect(r.ok).toBe(true);
    expect((r as any).existed).toBe(true);
  });

  it('refuses when path exists as a file', async () => {
    writeFile('conflict.md', '');
    const c = await loadContexts();
    const r = c.createContextDir('conflict.md');
    expect(r.ok).toBe(false);
  });
});

describe('contexts › readContextFile', () => {
  it('returns content for an existing text file', async () => {
    writeFile('a.md', '# hello');
    const c = await loadContexts();
    const r = c.readContextFile('a.md');
    expect(r.ok).toBe(true);
    expect((r as any).content).toBe('# hello');
  });

  it('refuses to read binary files as text', async () => {
    writeFile('a.pdf', Buffer.from([0xff]));
    const c = await loadContexts();
    const r = c.readContextFile('a.pdf');
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/binary/);
  });

  it('returns error for missing file', async () => {
    const c = await loadContexts();
    const r = c.readContextFile('nope.md');
    expect(r.ok).toBe(false);
  });
});

describe('contexts › listContextsTree', () => {
  it('lists text + binary files, hides dotfiles + _INDEX.md', async () => {
    writeFile('a.md', '# a');
    writeFile('sub/b.pdf', 'PDF');
    writeFile('.kb/vector.db', 'bin');
    writeFile('_INDEX.md', '# idx');
    const c = await loadContexts();
    const tree = c.listContextsTree();
    const top = tree.map((n) => n.name).sort();
    expect(top).toEqual(['sub', 'a.md'].sort());
    const sub = tree.find((n) => n.name === 'sub')!;
    expect((sub.children || []).map((n) => n.name)).toEqual(['b.pdf']);
  });
});

describe('contexts › frontmatter helpers', () => {
  it('stripLegacyFrontmatter strips leading --- --- block', async () => {
    const c = await loadContexts();
    const body = '---\ntitle: x\n---\n# Real\ntext';
    expect(c.stripLegacyFrontmatter(body)).toBe('# Real\ntext');
  });

  it('firstHeading prefers H1 text, falls back to first non-empty line', async () => {
    const c = await loadContexts();
    expect(c.firstHeading('# My Title\nbody')).toBe('My Title');
    expect(c.firstHeading('\nfirst line\nsecond')).toBe('first line');
  });
});

describe('contexts › rebuildIndex', () => {
  it('writes root _INDEX.md with subdir counts + root files', async () => {
    writeFile('root.md', '# Root');
    writeFile('dom/a.md', '# A');
    writeFile('dom/b.md', '# B');
    const c = await loadContexts();
    c.rebuildIndex();
    const idx = fs.readFileSync(path.join(ctxRoot(), '_INDEX.md'), 'utf8');
    expect(idx).toContain('# 资料库索引');
    expect(idx).toContain('`dom/`');
    expect(idx).toContain('2 篇');
    expect(idx).toContain('root.md');
  });

  it('does NOT write per-subdir _INDEX.md (only root)', async () => {
    writeFile('dom/a.md', '# A');
    const c = await loadContexts();
    c.rebuildIndex();
    expect(fs.existsSync(path.join(ctxRoot(), 'dom', '_INDEX.md'))).toBe(false);
  });

  it('getContextIndexEntries returns flat list of all files', async () => {
    writeFile('a.md', '# A');
    writeFile('sub/b.md', '# B');
    writeFile('sub/c.pdf', 'PDF');
    const c = await loadContexts();
    const entries = await c.getContextIndexEntries();
    expect(entries.map((e) => e.path).sort()).toEqual(['a.md', 'sub/b.md', 'sub/c.pdf']);
  });

});
