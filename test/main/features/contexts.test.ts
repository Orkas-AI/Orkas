import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;
import * as os from 'node:os';
import * as path from 'node:path';
import { makeMinimalPptx, makeMinimalXlsx } from '../../fixtures/make-minimal-office';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: diagnostics.warn, error: vi.fn() }),
}));

// The layout-rendering behavior is covered with a deterministic OfficeCLI mock
// in util/office-preview-rendered.test.ts. Filesystem/context tests exercise the
// lightweight fallback so they do not depend on a platform binary.
vi.mock('../../../src/main/features/office/office_engine', () => ({
  officeCliAvailable: () => false,
  runOfficeCli: vi.fn(),
  closeOfficeFile: vi.fn(),
}));

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

afterEach(async () => {
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadContexts() {
  // Pin i18n to zh so assertions on Chinese error substrings stay stable.
  const i18n = await import('../../../src/main/i18n');
  i18n.setCurrentLang('zh');
  return import('../../../src/main/features/contexts');
}

function ctxRoot(userId = TEST_UID): string {
  return path.join(tmpDir, userId, 'cloud', 'contexts');
}

function writeFile(rel: string, body: string | Buffer, userId = TEST_UID): void {
  const full = path.join(ctxRoot(userId), rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

describe('contexts › path safety', () => {
  it.each(['write', 'update', 'upload'] as const)('preserves the saved Library source after a partial %s failure and permits retry', async (operation) => {
    const c = await loadContexts();
    const name = 'procedure.md';
    expect(c.writeContextFile(name, 'Original complete procedure')).toMatchObject({ ok: true });
    expect(c.updateContextFile(name, 'Current complete procedure')).toMatchObject({ ok: true });
    expect(c.readContextFile(name)).toMatchObject({ content: 'Current complete procedure' });
    const target = fs.realpathSync(path.join(ctxRoot(), name));
    if (process.platform !== 'win32') fs.chmodSync(target, 0o640);
    const enqueueCount = kbEnqueueCalls.length;
    const searchCount = searchCalls.length;
    const originalWrite = fs.writeFileSync;
    const write = vi.spyOn(mutableFs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: any, options: any) => {
      const written = typeof file === 'string' ? path.join(fs.realpathSync(path.dirname(file)), path.basename(file)) : String(file);
      if (written === target || written.startsWith(target + '.')) {
        originalWrite(file, String(data).slice(0, 7), options);
        throw Object.assign(new Error('controlled short write'), { code: 'ENOSPC' });
      }
      return originalWrite(file, data, options);
    }) as typeof fs.writeFileSync);
    syncBuiltinESMExports();
    try {
      const result = operation === 'upload' ? c.uploadContextFile(name, Buffer.from('New complete procedure')) : operation === 'write' ? c.writeContextFile(name, 'New complete procedure') : c.updateContextFile(name, 'New complete procedure');
      expect(result).toMatchObject({ ok: false });
    } finally { write.mockRestore(); syncBuiltinESMExports(); }
    expect(fs.readFileSync(target, 'utf8')).toBe('Current complete procedure');
    expect(c.readContextFile(name)).toMatchObject({ ok: true, content: 'Current complete procedure' });
    expect(fs.readdirSync(ctxRoot()).filter(n => n.startsWith(name))).toEqual([name]);
    expect(kbEnqueueCalls).toHaveLength(enqueueCount);
    expect(searchCalls).toHaveLength(searchCount);
    const retry = operation === 'upload' ? c.uploadContextFile(name, Buffer.from('New complete procedure')) : operation === 'write' ? c.writeContextFile(name, 'New complete procedure') : c.updateContextFile(name, 'New complete procedure');
    expect(retry).toMatchObject({ ok: true });
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    vi.resetModules();
    (await import('../../../src/main/features/users')).activateUser(TEST_UID);
    expect((await loadContexts()).readContextFile(name)).toMatchObject({ ok: true, content: 'New complete procedure' });
  });

  it.runIf(process.platform !== 'win32')('keeps an internal file alias and its target mode when saving text', async () => {
    writeFile('source.md', 'Original procedure');
    const target = path.join(ctxRoot(), 'source.md');
    const alias = path.join(ctxRoot(), 'alias.md');
    fs.chmodSync(target, 0o640);
    fs.symlinkSync(target, alias, 'file');
    const c = await loadContexts();
    for (const operation of ['write', 'update', 'upload']) {
      const body = `${operation} complete procedure`;
      const result = operation === 'upload' ? c.uploadContextFile('alias.md', Buffer.from(body)) : operation === 'write' ? c.writeContextFile('alias.md', body) : c.updateContextFile('alias.md', body);
      expect(result).toMatchObject({ ok: true });
      expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe(body);
      expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    }
  });

  it.runIf(process.platform !== 'win32')('continues to reject overwriting a read-only Library source', async () => {
    writeFile('locked.md', 'Protected procedure');
    const target = path.join(ctxRoot(), 'locked.md');
    fs.chmodSync(target, 0o444);
    try {
      const c = await loadContexts();
      expect(c.writeContextFile('locked.md', 'changed')).toMatchObject({ ok: false });
      expect(c.updateContextFile('locked.md', 'changed')).toMatchObject({ ok: false });
      expect(c.uploadContextFile('locked.md', Buffer.from('changed'))).toMatchObject({ ok: false });
      expect(c.readContextFile('locked.md')).toMatchObject({ content: 'Protected procedure' });
      expect(kbEnqueueCalls).toHaveLength(0);
    } finally { fs.chmodSync(target, 0o644); }
  });

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

  it('uploadContextFile rejects dot-prefixed target', async () => {
    const c = await loadContexts();
    const r = c.uploadContextFile('.orkas-native-deps-verified.json', Buffer.from('{}'));
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/hidden/i);
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
    const exts = ['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log', '.html', '.xml', '.jsonl', '.ndjson', '.rst', '.tex', '.srt', '.vtt'];
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
    expect(up2).toMatchObject({
      ok: false,
      code: 'duplicate_content',
      existingDir: 'work',
    });
    expect((up2 as { ok: false; error: string }).error).not.toMatch(/work|a\.pdf/);
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
    expect(up2).toMatchObject({
      ok: false,
      code: 'duplicate_content',
      existingDir: 'work',
    });
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
    expect(w2).toMatchObject({
      ok: false,
      code: 'duplicate_content',
      existingDir: 'notes',
    });
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
  it('imports a local file by path without a base64/Buffer IPC copy', async () => {
    const source = path.join(tmpDir, 'picked.md');
    fs.writeFileSync(source, '# imported by path', 'utf8');
    const c = await loadContexts();

    const result = await c.importContextFileFromPath('imports/picked.md', source);

    expect(result).toMatchObject({ ok: true, path: 'imports/picked.md' });
    expect(fs.readFileSync(path.join(ctxRoot(), 'imports', 'picked.md'), 'utf8')).toBe('# imported by path');
    expect(kbEnqueueCalls).toContainEqual({ userId: TEST_UID, relPath: 'imports/picked.md', op: 'upsert' });
  });

  it('serializes path imports so concurrent identical content is rejected once', async () => {
    const first = path.join(tmpDir, 'first.md');
    const second = path.join(tmpDir, 'second.md');
    fs.writeFileSync(first, 'same imported content', 'utf8');
    fs.writeFileSync(second, 'same imported content', 'utf8');
    const c = await loadContexts();

    const [a, b] = await Promise.all([
      c.importContextFileFromPath('a.md', first),
      c.importContextFileFromPath('b.md', second),
    ]);

    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((result) => !result.ok)).toMatchObject({ code: 'duplicate_content' });
  });

  it('rejects a symlinked target directory', async () => {
    const source = path.join(tmpDir, 'source.md');
    const outside = path.join(tmpDir, 'outside');
    fs.writeFileSync(source, 'must stay inside Library', 'utf8');
    fs.mkdirSync(ctxRoot(), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    // A directory junction exercises the Windows reparse-point path without
    // requiring Developer Mode or elevated symbolic-link privileges.
    fs.symlinkSync(outside, path.join(ctxRoot(), 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const c = await loadContexts();

    const result = await c.importContextFileFromPath('linked/escape.md', source);

    expect(result).toMatchObject({ ok: false, code: 'E_IMPORT_TARGET_SYMLINK' });
    expect(fs.existsSync(path.join(outside, 'escape.md'))).toBe(false);
  });

  it('does not overwrite a same-name Library file with different imported content', async () => {
    const source = path.join(tmpDir, 'note.md');
    fs.writeFileSync(source, 'new picked content', 'utf8');
    const c = await loadContexts();
    expect(c.writeContextFile('note.md', 'existing Library content').ok).toBe(true);

    const result = await c.importContextFileFromPath('note.md', source);

    expect(result).toMatchObject({ ok: false, code: 'E_IMPORT_TARGET_EXISTS' });
    expect(fs.readFileSync(path.join(ctxRoot(), 'note.md'), 'utf8'))
      .toBe('existing Library content');
    expect(fs.readFileSync(source, 'utf8')).toBe('new picked content');
  });

  it('accepts pdf bytes', async () => {
    const c = await loadContexts();
    const r = c.uploadContextFile('doc.pdf', Buffer.from('%PDF-1.4\n'));
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(ctxRoot(), 'doc.pdf'))).toBe(true);
  });

  it('imports and previews a legacy XLS without changing the workbook', async () => {
    const c = await loadContexts();
    const bytes = fs.readFileSync(path.join(__dirname, '../../fixtures/xls/inventory.xls'));
    expect(c.uploadContextFile('inventory.xls', bytes).ok).toBe(true);
    const preview = await c.readContextOfficeHtml('inventory.xls');
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error('missing preview');
    expect(preview.html).toContain('冷却泵');
    expect(preview.html).toContain('Inventory sentinel 8384');
    expect(preview.html).not.toContain('<script>');
    expect(preview.allowScripts).not.toBe(true);
    expect(fs.readFileSync(path.join(ctxRoot(), 'inventory.xls'))).toEqual(bytes);
  });

  it('accepts modern Office bytes', async () => {
    const c = await loadContexts();
    const sheet = c.uploadContextFile('scores.xlsx', makeMinimalXlsx());
    const deck = c.uploadContextFile('slides.pptx', makeMinimalPptx());
    const macroDeck = c.uploadContextFile('slides-macro.pptm', makeMinimalPptx({ slides: [['Macro deck']] }));

    expect(sheet.ok).toBe(true);
    expect(deck.ok).toBe(true);
    expect(macroDeck.ok).toBe(true);
    expect(fs.existsSync(path.join(ctxRoot(), 'scores.xlsx'))).toBe(true);
    expect(fs.existsSync(path.join(ctxRoot(), 'slides.pptx'))).toBe(true);
    expect(kbEnqueueCalls).toContainEqual({ userId: TEST_UID, relPath: 'scores.xlsx', op: 'upsert' });
    expect(kbEnqueueCalls).toContainEqual({ userId: TEST_UID, relPath: 'slides.pptx', op: 'upsert' });
    expect(kbEnqueueCalls).toContainEqual({ userId: TEST_UID, relPath: 'slides-macro.pptm', op: 'upsert' });
  });

  it('renders modern Office preview HTML', async () => {
    const c = await loadContexts();
    c.uploadContextFile('scores.xlsx', makeMinimalXlsx({
      rows: [['Name'], ['Ada']],
    }));

    const preview = await c.readContextOfficeHtml('scores.xlsx');
    expect(preview.ok).toBe(true);
    expect((preview as any).kind).toBe('spreadsheet');
    expect((preview as any).html).toContain('Ada');
    expect((preview as any).html).toContain('office-preview office-spreadsheet');
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

  it('moves a folder recursively and rejects moving it into itself', async () => {
    fs.mkdirSync(path.join(ctxRoot(), 'inbox/nested'), { recursive: true });
    fs.mkdirSync(path.join(ctxRoot(), 'archive'), { recursive: true });
    writeFile('inbox/nested/note.md', '# body');
    const c = await loadContexts();

    expect(c.renameContextEntry('inbox', 'inbox/nested/inbox').ok).toBe(false);
    expect(c.renameContextEntry('inbox', 'archive/inbox').ok).toBe(true);
    expect(fs.existsSync(path.join(ctxRoot(), 'inbox'))).toBe(false);
    expect(fs.readFileSync(path.join(ctxRoot(), 'archive/inbox/nested/note.md'), 'utf8')).toBe('# body');
  });
});

describe('contexts › copyContextEntryFromPath', () => {
  it('copies a folder recursively and re-enqueues the destination paths', async () => {
    writeFile('source/nested/note.md', '# body');
    fs.mkdirSync(path.join(ctxRoot(), 'archive'), { recursive: true });
    const c = await loadContexts();
    const source = c.resolveContextEntryAbsPath('source');
    kbEnqueueCalls.length = 0;

    const copied = c.copyContextEntryFromPath(source, 'archive/source');

    expect(copied).toMatchObject({ ok: true, fileCount: 1 });
    expect(fs.readFileSync(path.join(ctxRoot(), 'archive/source/nested/note.md'), 'utf8')).toBe('# body');
    expect(kbEnqueueCalls).toContainEqual(expect.objectContaining({ relPath: 'archive/source/nested/note.md', op: 'upsert' }));
  });

  it('does not overwrite an existing target', async () => {
    writeFile('source.md', 'source');
    writeFile('target.md', 'target');
    const c = await loadContexts();

    const copied = c.copyContextEntryFromPath(c.resolveContextEntryAbsPath('source.md'), 'target.md');

    expect(copied).toMatchObject({ ok: false, error: 'target_exists' });
    expect(fs.readFileSync(path.join(ctxRoot(), 'target.md'), 'utf8')).toBe('target');
  });

  it('does not recreate a destination folder that no longer exists', async () => {
    writeFile('source.md', 'source');
    const c = await loadContexts();

    const copied = c.copyContextEntryFromPath(c.resolveContextEntryAbsPath('source.md'), 'missing/source.md');

    expect(copied).toMatchObject({ ok: false, error: 'not_found' });
    expect(fs.existsSync(path.join(ctxRoot(), 'missing'))).toBe(false);
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
  it('offers a bounded CSV preview while preserving the full stored source', async () => {
    const c = await loadContexts();
    const body = 'id,value\n' + '001,中文\n'.repeat(300_000);
    writeFile('large.csv', body);
    const result = c.readContextFile('large.csv', true);
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect((result as any).content.startsWith('id,value\n001,中文')).toBe(true);
    expect(Buffer.byteLength((result as any).content)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(fs.readFileSync(path.join(ctxRoot(), 'large.csv'), 'utf8')).toBe(body);
    expect(c.readContextFile('../outside.csv', true).ok).toBe(false);
  });
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
  it('lists a populated Library without a synchronous directory walk on the UI process', async () => {
    for (let i = 0; i < 200; i += 1) writeFile(`folder/f${i}.md`, `# Document ${i}`);
    const contexts = await loadContexts();
    const nodeFs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const readDirectory = nodeFs.readdirSync;
    let synchronousWalks = 0;
    const spy = vi.spyOn(nodeFs, 'readdirSync').mockImplementation(((directory: any, ...args: any[]) => {
      if (String(directory).startsWith(ctxRoot())) synchronousWalks += 1;
      return (readDirectory as any)(directory, ...args);
    }) as any);
    syncBuiltinESMExports();
    let tree: Awaited<ReturnType<typeof contexts.listContextsTree>>;
    try { tree = await contexts.listContextsTree(); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect(tree[0].children).toHaveLength(200);
    expect(tree[0].children!.map(node => node.name)).toEqual(
      Array.from({ length: 200 }, (_, n) => `f${n}.md`).sort((a, b) => a.localeCompare(b)),
    );
    expect(synchronousWalks).toBe(0);
  });
  it('coalesces a complete wide-folder read with bounded metadata I/O and observes later additions', async () => {
    const names = Array.from({ length: 64 }, (_, n) => `f${String(n).padStart(3, '0')}.md`);
    names.forEach(name => writeFile(name, 'Complete body'));
    const c = await loadContexts();
    const nodeFs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const stat = nodeFs.promises.stat;
    let active = 0, peak = 0;
    const spy = vi.spyOn(nodeFs.promises, 'stat').mockImplementation((async (...args: any[]) => {
      active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => setTimeout(resolve, 2)); return await (stat as any)(...args); }
      finally { active--; }
    }) as any);
    syncBuiltinESMExports();
    try {
      const first = c.listContextsTree();
      expect(c.listContextsTree()).toBe(first);
      expect((await first).map(node => node.name)).toEqual(names);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(8);
      writeFile('z-last.md', 'New complete body');
      expect((await c.listContextsTree()).map(node => node.name)).toEqual([...names, 'z-last.md']);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });
  it('lists text + binary files, hides dotfiles + _INDEX.md', async () => {
    writeFile('a.md', '# a');
    writeFile('sub/b.pdf', 'PDF');
    writeFile('.kb/vector.db', 'bin');
    writeFile('_INDEX.md', '# idx');
    const c = await loadContexts();
    const tree = await c.listContextsTree();
    const top = tree.map((n) => n.name).sort();
    expect(top).toEqual(['sub', 'a.md'].sort());
    const sub = tree.find((n) => n.name === 'sub')!;
    expect((sub.children || []).map((n) => n.name)).toEqual(['b.pdf']);
  });

  // The renderer orders the Library newest-first, so folders need an mtime of
  // their own — without it every folder ties at the bottom of its group.
  it('stamps an mtime on folders as well as files', async () => {
    writeFile('sub/b.pdf', 'PDF');
    const c = await loadContexts();
    const tree = await c.listContextsTree();
    const sub = tree.find((n) => n.name === 'sub')!;
    expect(sub.mtime).toBeGreaterThan(0);
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

  it('keeps the in-memory index isolated when the active account changes', async () => {
    writeFile('account-a.md', '# Account A');
    const c = await loadContexts();
    expect((await c.getContextIndexEntries()).map((entry) => entry.path)).toEqual(['account-a.md']);

    writeFile('account-b.md', '# Account B', 'u2');
    const users = await import('../../../src/main/features/users');
    users.activateUser('u2');
    expect((await c.getContextIndexEntries()).map((entry) => entry.path)).toEqual(['account-b.md']);

    const inactiveRebuild = c.rebuildIndex(TEST_UID);
    expect(inactiveRebuild.entries.map((entry) => entry.path)).toEqual(['account-a.md']);
    expect((await c.getContextIndexEntries()).map((entry) => entry.path)).toEqual(['account-b.md']);
  });

});

describe('contexts › resolveContextFileAbsPath (ask-commander attach uses this)', () => {
  it('resolves a valid relpath to an existing abs path; rejects traversal / hidden / missing', async () => {
    const c = await loadContexts();
    expect(c.writeContextFile('notes.md', 'hello').ok).toBe(true);

    const abs = c.resolveContextFileAbsPath('notes.md');
    expect(path.isAbsolute(abs)).toBe(true);
    expect(abs.endsWith(`${path.sep}notes.md`)).toBe(true);
    expect(fs.existsSync(abs)).toBe(true);

    expect(() => c.resolveContextFileAbsPath('../escape.md')).toThrow();   // traversal
    expect(() => c.resolveContextFileAbsPath('.kb/secret.md')).toThrow();  // hidden segment
    expect(() => c.resolveContextFileAbsPath('does-not-exist.md')).toThrow(); // mustExist
  });
});


describe('contexts › resolved Library boundary', () => {
  it.each([
    'read', 'preview', 'image', 'word', 'office', 'write', 'new-write',
    'update', 'upload', 'mkdir', 'delete', 'rename-source', 'rename-target',
    'copy-target', 'resolve-file', 'resolve-entry',
  ])('refuses %s through an external directory link without touching external data or indexes', async operation => {
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const protectedFiles: Record<string, Buffer> = {
      'note.md': Buffer.from('Protected external source'),
      'data.csv': Buffer.from('id,value\n001,external\n'),
      'image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'word.docx': makeMinimalDocx({ paragraphs: ['Protected external Word source'] }),
      'sheet.xlsx': makeMinimalXlsx({ rows: [['Protected external spreadsheet']] }),
    };
    for (const [name, body] of Object.entries(protectedFiles)) fs.writeFileSync(path.join(outside, name), body);
    writeFile('source.md', 'Owned Library source');
    fs.symlinkSync(outside, path.join(ctxRoot(), 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const c = await loadContexts();
    kbEnqueueCalls.length = 0; searchCalls.length = 0;
    const invoke = async (): Promise<{ ok: boolean }> => {
      switch (operation) {
        case 'read': return c.readContextFile('linked/note.md');
        case 'preview': return c.readContextFile('linked/data.csv', true);
        case 'image': return c.readContextImage('linked/image.png');
        case 'word': return c.readContextDocxHtml('linked/word.docx');
        case 'office': return c.readContextOfficeHtml('linked/sheet.xlsx');
        case 'write': return c.writeContextFile('linked/note.md', 'replacement');
        case 'new-write': return c.writeContextFile('linked/new/note.md', 'replacement');
        case 'update': return c.updateContextFile('linked/note.md', 'replacement');
        case 'upload': return c.uploadContextFile('linked/note.md', Buffer.from('replacement'));
        case 'mkdir': return c.createContextDir('linked/new/folder');
        case 'delete': return c.deleteContextTarget('linked/note.md');
        case 'rename-source': return c.renameContextEntry('linked/note.md', 'moved.md');
        case 'rename-target': return c.renameContextEntry('source.md', 'linked/moved.md');
        case 'copy-target': return c.copyContextEntryFromPath(path.join(ctxRoot(), 'source.md'), 'linked/copied.md');
        case 'resolve-file':
          expect(() => c.resolveContextFileAbsPath('linked/note.md')).toThrow(/path escapes contexts root/);
          return { ok: false };
        case 'resolve-entry':
          expect(() => c.resolveContextEntryAbsPath('linked/note.md')).toThrow(/path escapes contexts root/);
          return { ok: false };
        default: throw new Error('Unknown boundary scenario');
      }
    };
    const result = await invoke();
    const externalBytesUnchanged = Object.entries(protectedFiles).every(([name, body]) =>
      fs.existsSync(path.join(outside, name)) && fs.readFileSync(path.join(outside, name)).equals(body));
    expect({
      ok: result.ok,
      externalBytesUnchanged,
      externalNames: fs.readdirSync(outside).sort(),
      source: fs.existsSync(path.join(ctxRoot(), 'source.md')) ? fs.readFileSync(path.join(ctxRoot(), 'source.md'), 'utf8') : null,
      moved: fs.existsSync(path.join(ctxRoot(), 'moved.md')),
      indexOperations: kbEnqueueCalls.length + searchCalls.length,
    }).toEqual({
      ok: false, externalBytesUnchanged: true,
      externalNames: Object.keys(protectedFiles).sort(), source: 'Owned Library source', moved: false, indexOperations: 0,
    });
  });

  it('keeps internal directory aliases and genuinely missing descendants usable', async () => {
    writeFile('real/note.md', 'Owned existing source');
    fs.symlinkSync(path.join(ctxRoot(), 'real'), path.join(ctxRoot(), 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const c = await loadContexts();
    expect(c.readContextFile('alias/note.md')).toMatchObject({ ok: true, content: 'Owned existing source' });
    expect(c.writeContextFile('alias/new/note.md', 'Owned new source')).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(ctxRoot(), 'real/new/note.md'), 'utf8')).toBe('Owned new source');
    expect(c.writeContextFile('missing/child/note.md', 'New direct source')).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(ctxRoot(), 'missing/child/note.md'), 'utf8')).toBe('New direct source');
  });

  it.runIf(process.platform !== 'win32').each(['external', 'internal'])(
    'publishes an owned generated index without overwriting its %s link target', async location => {
      writeFile('note.md', '# Owned title');
      const target = location === 'external' ? path.join(tmpDir, 'outside-index.md') : path.join(ctxRoot(), 'index-target.md');
      fs.writeFileSync(target, 'Protected index target');
      const index = path.join(ctxRoot(), '_INDEX.md');
      fs.symlinkSync(target, index, 'file');
      const c = await loadContexts();
      const rebuilt = c.rebuildIndex();
      expect(fs.readFileSync(target, 'utf8')).toBe('Protected index target');
      expect(rebuilt.entries).toContainEqual({ path: 'note.md', title: 'Owned title' });
      expect(fs.lstatSync(index).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(index, 'utf8')).toContain('Owned title');
    },
  );

  it.runIf(process.platform !== 'win32')('keeps the derived overview safe on index-publication failure and recovers on retry', async () => {
    writeFile('note.md', '# Owned title');
    const outside = path.join(tmpDir, 'outside-index.md');
    fs.writeFileSync(outside, 'Protected index target');
    const index = path.join(ctxRoot(), '_INDEX.md');
    fs.symlinkSync(outside, index, 'file');
    const c = await loadContexts();
    const nodeFs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const rename = nodeFs.renameSync, read = nodeFs.readFileSync;
    const privateMessage = `EIO: ${outside} PRIVATE_INDEX_FAILURE`;
    let indexReads = 0;
    const renameSpy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(((from: any, to: any) => {
      if (String(to) === index) throw Object.assign(new Error(privateMessage), { code: 'EIO' });
      return rename(from, to);
    }) as any);
    const readSpy = vi.spyOn(nodeFs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === index) indexReads++;
      return (read as any)(file, ...args);
    }) as any);
    diagnostics.warn.mockClear(); syncBuiltinESMExports();
    let markdown: string;
    try { markdown = c.rebuildIndex().rootMarkdown; }
    finally { renameSpy.mockRestore(); readSpy.mockRestore(); syncBuiltinESMExports(); }
    expect({ target: fs.readFileSync(outside, 'utf8'), indexReads, markdown: markdown!.includes('Owned title') }).toEqual({
      target: 'Protected index target', indexReads: 0, markdown: true,
    });
    expect(diagnostics.warn).toHaveBeenCalledExactlyOnceWith('failed to write root Library index', {
      message_hash: expect.stringMatching(/^[a-f0-9]{12}$/), message_chars: privateMessage.length,
    });
    expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toMatch(/PRIVATE_INDEX_FAILURE|outside-index|EIO/);
    expect(fs.readdirSync(ctxRoot()).sort()).toEqual(['_INDEX.md', 'note.md']);
    expect(fs.lstatSync(index).isSymbolicLink()).toBe(true);
    expect(c.rebuildIndex().rootMarkdown).toContain('Owned title');
    expect(fs.lstatSync(index).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('Protected index target');
  });
});


it.runIf(process.platform !== 'win32')('writes through a known missing internal Library file alias without widening its scope', async () => {
  fs.mkdirSync(ctxRoot(), { recursive: true });
  const target = path.join(ctxRoot(), 'future-source.md');
  fs.symlinkSync(target, path.join(ctxRoot(), 'future-alias.md'), 'file');
  const c = await loadContexts();
  expect(c.writeContextFile('future-alias.md', 'Owned future source')).toMatchObject({ ok: true });
  expect(fs.readFileSync(target, 'utf8')).toBe('Owned future source');
  expect(c.readContextFile('future-alias.md')).toMatchObject({ ok: true, content: 'Owned future source' });
});


it.each(['', ' ', '/', '///'])('refuses deleting the Library root for an empty target spelling %j', async relative => {
  writeFile('note.md', '# Preserved root source');
  writeFile('nested/other.txt', 'Preserved nested source');
  writeFile('_INDEX.md', 'Existing generated overview');
  const c = await loadContexts();
  const result = c.deleteContextTarget(relative);
  const preserved = (name: string, expected: string) => fs.existsSync(path.join(ctxRoot(), name))
    && fs.readFileSync(path.join(ctxRoot(), name), 'utf8') === expected;
  expect({
    ok: result.ok,
    source: preserved('note.md', '# Preserved root source'),
    nested: preserved('nested/other.txt', 'Preserved nested source'),
    index: preserved('_INDEX.md', 'Existing generated overview'),
    indexOperations: kbEnqueueCalls.length + searchCalls.length,
  }).toEqual({ ok: false, source: true, nested: true, index: true, indexOperations: 0 });
});


describe('Library copy and move source ownership', () => {

  it.each([
    ['file', 'file'], ['file', 'directory'],
    ['directory', 'file'], ['directory', 'directory'],
  ] as const)('preserves a concurrent %s-copy destination claimed by a %s winner', async (sourceKind, winnerKind) => {
    const root = ctxRoot(); fs.mkdirSync(root, { recursive: true });
    const source = path.join(tmpDir, sourceKind === 'file' ? 'source.md' : 'source-folder');
    const sourceFile = sourceKind === 'file' ? source : path.join(source, 'copied.md');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true }); fs.writeFileSync(sourceFile, 'Original copied source');
    const targetName = sourceKind === 'file' ? 'target.md' : 'target-folder';
    const target = path.join(root, targetName);
    const winnerFile = winnerKind === 'file' ? target : path.join(target, 'winner.md');
    const c = await loadContexts();
    const nodeFs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const exists = nodeFs.existsSync; let checks = 0; let injected = false;
    const spy = vi.spyOn(nodeFs, 'existsSync').mockImplementation((filename: any) => {
      const present = exists(filename);
      if (String(filename) === target && ++checks === 1 && !present) {
        if (winnerKind === 'directory') fs.mkdirSync(target);
        fs.writeFileSync(winnerFile, 'Concurrent winner source'); injected = true;
      }
      return present;
    });
    syncBuiltinESMExports();
    let result: any;
    try { result = c.copyContextEntryFromPath(source, targetName); } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect(injected).toBe(true);
    expect({
      ok: result.ok,
      winner: fs.existsSync(winnerFile) ? fs.readFileSync(winnerFile, 'utf8') : null,
      names: winnerKind === 'directory' && fs.existsSync(target) ? fs.readdirSync(target).sort() : [],
      source: fs.readFileSync(sourceFile, 'utf8'), indexOperations: kbEnqueueCalls.length + searchCalls.length,
    }).toEqual({ ok: false, winner: 'Concurrent winner source',
      names: winnerKind === 'directory' ? ['winner.md'] : [], source: 'Original copied source', indexOperations: 0 });
  });

  it('rejects moving a folder into a new descendant before creating that descendant', async () => {
    writeFile('source/note.md', 'Preserved source'); const c = await loadContexts();
    const result = c.renameContextEntry('source', 'source/new-parent/moved');
    expect({ ok: result.ok, names: fs.readdirSync(path.join(ctxRoot(), 'source')).sort(),
      source: fs.readFileSync(path.join(ctxRoot(), 'source/note.md'), 'utf8'),
      indexOperations: kbEnqueueCalls.length + searchCalls.length,
    }).toEqual({ ok: false, names: ['note.md'], source: 'Preserved source', indexOperations: 0 });
  });

  it.each(['parent-create', 'source-stat'])('returns a recoverable failed move after %s fails without losing the source', async failure => {
    writeFile('source.md', 'Preserved source'); const c = await loadContexts();
    const nodeFs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const method = failure === 'parent-create' ? 'mkdirSync' : 'statSync';
    const original = nodeFs[method];
    const failedPath = path.join(ctxRoot(), failure === 'parent-create' ? 'new-parent' : 'source.md');
    const spy = vi.spyOn(nodeFs, method).mockImplementation(((filename: any, ...args: any[]) => {
      if (String(filename) === failedPath) throw Object.assign(new Error('Filesystem unavailable'), { code: 'EACCES' });
      return (original as any)(filename, ...args);
    }) as any); syncBuiltinESMExports();
    let result: any;
    try { result = c.renameContextEntry('source.md', 'new-parent/moved.md'); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect({ ok: result.ok, source: fs.readFileSync(path.join(ctxRoot(), 'source.md'), 'utf8'),
      targetParent: fs.existsSync(path.join(ctxRoot(), 'new-parent')),
      indexOperations: kbEnqueueCalls.length + searchCalls.length,
    }).toEqual({ ok: false, source: 'Preserved source', targetParent: false, indexOperations: 0 });
  });

});


it.runIf(process.platform !== 'win32')('does not remove an existing internal dangling file alias when create-only copying fails', async () => {
  writeFile('source.md', 'Original source');
  const target = path.join(ctxRoot(), 'alias.md'), missing = path.join(ctxRoot(), 'future.md');
  fs.symlinkSync(missing, target, 'file'); const c = await loadContexts();
  const copied = c.copyContextEntryFromPath(path.join(ctxRoot(), 'source.md'), 'alias.md');
  expect(copied.ok).toBe(false); expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(target)).toBe(missing); expect(fs.existsSync(missing)).toBe(false);
  expect(fs.readFileSync(path.join(ctxRoot(), 'source.md'), 'utf8')).toBe('Original source');
  expect(kbEnqueueCalls.length + searchCalls.length).toBe(0);
});


it.runIf(process.platform !== 'win32')('moves an internal directory alias as an entry without confusing it with its referenced directory', async () => {
  writeFile('real/note.md', 'Referenced source');
  const source = path.join(ctxRoot(), 'alias'), real = path.join(ctxRoot(), 'real');
  fs.symlinkSync(real, source, 'dir'); const c = await loadContexts();
  expect(c.renameContextEntry('alias', 'real/alias').ok).toBe(true);
  expect(fs.existsSync(source)).toBe(false);
  expect(fs.lstatSync(path.join(real, 'alias')).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(path.join(real, 'note.md'), 'utf8')).toBe('Referenced source');
});
