import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Tests kb_indexer's queue + reconcile logic. kb_embed is mocked to avoid
 * loading the 95MB ONNX model on every test run.
 */

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'kbidx';

// Mocks are module-scoped — they apply to every dynamic import below.
vi.mock('../../../src/main/features/kb_embed', () => ({
  embedTexts: async (texts: string[]) => {
    // Sentinel makes extraction fail — simpler than re-mocking per-test.
    if (texts.some((t) => t.includes('__FAIL_EMBED__'))) {
      throw new Error('mocked embed failure');
    }
    // Deterministic 512-dim vectors keyed by text hash — enough for
    // "same input → same vector" without actually running ONNX.
    return texts.map((t) => {
      const v = new Array(512).fill(0);
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      v[0] = ((h >>> 0) % 1000) / 1000;
      v[1] = (((h >>> 8) & 0xff) % 100) / 100;
      return v;
    });
  },
  embedQuery: async () => new Array(512).fill(0),
  closeEmbedder: () => {},
}));

// Image tests mock chatWithModel so we never hit a real LLM.
const chatWithModelMock = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  text: 'mock image description',
  error: '',
  aborted: false,
})));
vi.mock('../../../src/main/model/client', () => ({
  chatWithModel: chatWithModelMock,
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kbidx-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  chatWithModelMock.mockReset();
  chatWithModelMock.mockResolvedValue({
    ok: true,
    text: 'mock image description',
    error: '',
    aborted: false,
  });
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  try {
    const idx = await import('../../../src/main/features/kb_indexer');
    idx._resetQueuesForTests();
    const kb = await import('../../../src/main/features/kb_vector');
    kb.closeAllKb();
  } catch { /* ignore */ }
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function contextsRoot(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'contexts');
}

function writeCtx(rel: string, body: string): void {
  const full = path.join(contextsRoot(), rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function writeCtxBuffer(rel: string, body: Buffer): void {
  const full = path.join(contextsRoot(), rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function collectEvents(ev: { on: (e: string, fn: (x: unknown) => void) => void }): unknown[] {
  const events: unknown[] = [];
  ev.on('status', (x) => events.push(x));
  return events;
}

describe('kb_indexer › enqueue + processJob', () => {
  it('vectorizes a new text file: pending → processing → ready', async () => {
    writeCtx('a.md', '# hello\n\nsome content');
    const idx = await import('../../../src/main/features/kb_indexer');
    const kb = await import('../../../src/main/features/kb_vector');
    const events = collectEvents(idx.kbEvents);

    idx.enqueue(TEST_UID, 'a.md');
    await idx.drain(TEST_UID);

    const row = kb.getFileByPath(TEST_UID, 'a.md');
    expect(row?.status).toBe('ready');
    expect(row?.chunks).toBe(1);

    // Event sequence contains pending, processing, ready — order matters.
    const statuses = events.map((e) => (e as { status: string }).status);
    expect(statuses).toContain('pending');
    expect(statuses).toContain('processing');
    expect(statuses).toContain('ready');
    expect(statuses.indexOf('pending')).toBeLessThan(statuses.indexOf('processing'));
    expect(statuses.indexOf('processing')).toBeLessThan(statuses.indexOf('ready'));
  });

  it('emits deleted event + drops row on op=delete', async () => {
    writeCtx('a.md', 'x');
    const idx = await import('../../../src/main/features/kb_indexer');
    const kb = await import('../../../src/main/features/kb_vector');
    idx.enqueue(TEST_UID, 'a.md');
    await idx.drain(TEST_UID);

    const events = collectEvents(idx.kbEvents);
    idx.enqueue(TEST_UID, 'a.md', 'delete');
    await idx.drain(TEST_UID);

    expect(kb.getFileByPath(TEST_UID, 'a.md')).toBeNull();
    expect(events.some((e) => (e as { status: string }).status === 'deleted')).toBe(true);
  });

  it('skips re-embed when sha1 unchanged (cache hit)', async () => {
    writeCtx('a.md', 'stable content');
    const idx = await import('../../../src/main/features/kb_indexer');
    idx.enqueue(TEST_UID, 'a.md');
    await idx.drain(TEST_UID);

    const events = collectEvents(idx.kbEvents);
    idx.enqueue(TEST_UID, 'a.md');
    await idx.drain(TEST_UID);
    // No status transitions since cache hit short-circuited the worker
    // (only a 'pending' event from enqueue — no 'processing' / 'ready').
    const post = events.map((e) => (e as { status: string }).status);
    expect(post.filter((s) => s === 'processing')).toHaveLength(0);
    expect(post.filter((s) => s === 'ready')).toHaveLength(0);
  });

  it('rapid-fire enqueue on same content is cheap after first run', async () => {
    // After the first successful vectorize, subsequent enqueues for the same
    // content hit the sha1 cache guard inside processJob — no 'processing'
    // or 'ready' transition, just the noise of 'pending' events the UI can
    // ignore on its own. Guards against "user mashes refresh".
    writeCtx('a.md', 'stable');
    const idx = await import('../../../src/main/features/kb_indexer');
    idx.enqueue(TEST_UID, 'a.md');
    await idx.drain(TEST_UID);

    const events = collectEvents(idx.kbEvents);
    for (let i = 0; i < 5; i++) idx.enqueue(TEST_UID, 'a.md');
    await idx.drain(TEST_UID);

    const statuses = events.map((e) => (e as { status: string }).status);
    expect(statuses.filter((s) => s === 'processing')).toHaveLength(0);
    expect(statuses.filter((s) => s === 'ready')).toHaveLength(0);
  });

  it('marks file failed when extraction throws', async () => {
    // Sentinel `__FAIL_EMBED__` makes the module-scoped embed mock throw —
    // avoids test-local re-mocking that leaks state into later tests.
    writeCtx('a.md', 'this content has __FAIL_EMBED__ in it');
    const idx = await import('../../../src/main/features/kb_indexer');
    const kb = await import('../../../src/main/features/kb_vector');
    idx.enqueue(TEST_UID, 'a.md');
    await idx.drain(TEST_UID);

    const row = kb.getFileByPath(TEST_UID, 'a.md');
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/mocked embed failure/);
  });

  it('splits long text into multiple small chunks (paragraph-aware, ≤ EMBED_MAX_CHARS)', async () => {
    // Three oversized paragraphs separated by blank lines — forces the packer to
    // (a) emit at least one chunk per paragraph boundary, (b) sentence-split
    // inside each oversized paragraph. Sanity-check: chunk count > 3 and each
    // chunk stays near the 400-char budget (generous slack for overlap tail).
    const para = '这是一个很长的段落，'.repeat(60); // ~540 chars, > 400 budget
    const body = [para, para, para].join('\n\n');
    writeCtx('long.md', body);

    const idx = await import('../../../src/main/features/kb_indexer');
    const kb = await import('../../../src/main/features/kb_vector');
    idx.enqueue(TEST_UID, 'long.md');
    await idx.drain(TEST_UID);

    const row = kb.getFileByPath(TEST_UID, 'long.md');
    expect(row?.status).toBe('ready');
    expect(row?.chunks).toBeGreaterThan(3);
    const chunks = kb.readFileChunks(TEST_UID, 'long.md');
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(460);
  });

  it('keeps a short paragraph as a single chunk', async () => {
    // 80-char paragraph — well under budget, must not be sliced.
    writeCtx('short.md', '这是一段短短的话，完全装得下一个 chunk。'.padEnd(80, '。'));
    const idx = await import('../../../src/main/features/kb_indexer');
    const kb = await import('../../../src/main/features/kb_vector');
    idx.enqueue(TEST_UID, 'short.md');
    await idx.drain(TEST_UID);

    expect(kb.getFileByPath(TEST_UID, 'short.md')?.chunks).toBe(1);
  });

  it('uses a fallback chunk when image vision extraction fails', async () => {
    const { Jimp } = await import('jimp' as any);
    const img: any = new Jimp({ width: 16, height: 16, color: 0x336699FF });
    writeCtxBuffer('photo.png', await img.getBuffer('image/png'));
    chatWithModelMock.mockResolvedValueOnce({
      ok: false,
      text: '',
      error: 'vision model unavailable',
      aborted: false,
    });

    const idx = await import('../../../src/main/features/kb_indexer');
    const kb = await import('../../../src/main/features/kb_vector');
    idx.enqueue(TEST_UID, 'photo.png');
    await idx.drain(TEST_UID);

    const row = kb.getFileByPath(TEST_UID, 'photo.png');
    expect(row?.status).toBe('ready');
    expect(row?.chunks).toBe(1);
    const chunks = kb.readFileChunks(TEST_UID, 'photo.png');
    expect(chunks[0]?.content).toMatch(/automatic visual description is unavailable/);
  });

  it('short-circuits empty files to ready with 0 chunks (no embed call)', async () => {
    // A freshly-created empty .md must not hang in processing — embedding an
    // empty string has no signal and previously could stall the worker.
    writeCtx('empty.md', '');
    writeCtx('whitespace.md', '   \n\n   \n');
    const idx = await import('../../../src/main/features/kb_indexer');
    const kb = await import('../../../src/main/features/kb_vector');
    const events = collectEvents(idx.kbEvents);
    idx.enqueue(TEST_UID, 'empty.md');
    idx.enqueue(TEST_UID, 'whitespace.md');
    await idx.drain(TEST_UID);

    for (const p of ['empty.md', 'whitespace.md']) {
      const row = kb.getFileByPath(TEST_UID, p);
      expect(row?.status).toBe('ready');
      expect(row?.chunks).toBe(0);
    }
    // Should go pending → ready directly; no processing transition (short-circuited).
    const statuses = events.map((e) => (e as { status: string; relPath: string }));
    const emptyEvents = statuses.filter((e) => e.relPath === 'empty.md');
    expect(emptyEvents.some((e) => e.status === 'processing')).toBe(false);
    expect(emptyEvents.some((e) => e.status === 'ready')).toBe(true);
  });

  it('ignores unsupported extensions', async () => {
    writeCtx('a.xyz', 'content');
    const idx = await import('../../../src/main/features/kb_indexer');
    const kb = await import('../../../src/main/features/kb_vector');
    idx.enqueue(TEST_UID, 'a.xyz');
    await idx.drain(TEST_UID);

    expect(kb.getFileByPath(TEST_UID, 'a.xyz')).toBeNull();
  });
});

describe('kb_indexer › reconcile', () => {
  it('enqueues upsert for new files', async () => {
    writeCtx('a.md', 'one');
    writeCtx('dir/b.md', 'two');
    const idx = await import('../../../src/main/features/kb_indexer');
    const r = await idx.reconcile(TEST_UID);
    expect(r.enqueuedUpsert).toBe(2);
    expect(r.enqueuedDelete).toBe(0);
    await idx.drain(TEST_UID);

    const kb = await import('../../../src/main/features/kb_vector');
    expect(kb.getFileByPath(TEST_UID, 'a.md')?.status).toBe('ready');
    expect(kb.getFileByPath(TEST_UID, 'dir/b.md')?.status).toBe('ready');
  });

  it('enqueues upsert when sha1 changed', async () => {
    writeCtx('a.md', 'v1');
    const idx = await import('../../../src/main/features/kb_indexer');
    await idx.reconcile(TEST_UID);
    await idx.drain(TEST_UID);

    writeCtx('a.md', 'v2 different content');
    const r = await idx.reconcile(TEST_UID);
    expect(r.enqueuedUpsert).toBe(1);
    expect(r.unchanged).toBe(0);
  });

  it('unchanged ready file yields no enqueue', async () => {
    writeCtx('a.md', 'stable');
    const idx = await import('../../../src/main/features/kb_indexer');
    await idx.reconcile(TEST_UID);
    await idx.drain(TEST_UID);

    const r = await idx.reconcile(TEST_UID);
    expect(r.enqueuedUpsert).toBe(0);
    expect(r.unchanged).toBe(1);
  });

  it('reuses the stored hash when size and mtime are unchanged', async () => {
    writeCtx('a.md', 'stable');
    const idx = await import('../../../src/main/features/kb_indexer');
    await idx.reconcile(TEST_UID);
    await idx.drain(TEST_UID);

    const r = await idx.reconcile(TEST_UID);
    expect(r.unchanged).toBe(1);
    expect(r.reusedHashes).toBe(1);
  });

  it('enqueues delete when file disappears from disk', async () => {
    writeCtx('a.md', 'x');
    writeCtx('b.md', 'y');
    const idx = await import('../../../src/main/features/kb_indexer');
    await idx.reconcile(TEST_UID);
    await idx.drain(TEST_UID);

    fs.unlinkSync(path.join(contextsRoot(), 'a.md'));
    const r = await idx.reconcile(TEST_UID);
    expect(r.enqueuedDelete).toBe(1);
    await idx.drain(TEST_UID);

    const kb = await import('../../../src/main/features/kb_vector');
    expect(kb.getFileByPath(TEST_UID, 'a.md')).toBeNull();
    expect(kb.getFileByPath(TEST_UID, 'b.md')?.status).toBe('ready');
  });

  it('skips dot-prefixed dirs and _INDEX.md during walk', async () => {
    writeCtx('a.md', 'real');
    writeCtx('.hidden/junk.md', 'should be skipped');   // dot-dir (same rule as .kb/)
    writeCtx('_INDEX.md', '# index');                   // generated file
    writeCtx('sub/_INDEX.md', '# sub index');           // legacy subdir index (also .md but name-filtered)

    const idx = await import('../../../src/main/features/kb_indexer');
    const r = await idx.reconcile(TEST_UID);
    expect(r.enqueuedUpsert).toBe(1);

    await idx.drain(TEST_UID);
    const kb = await import('../../../src/main/features/kb_vector');
    expect(kb.getFileByPath(TEST_UID, 'a.md')).not.toBeNull();
    expect(kb.getFileByPath(TEST_UID, '_INDEX.md')).toBeNull();
    expect(kb.getFileByPath(TEST_UID, 'sub/_INDEX.md')).toBeNull();
    expect(kb.getFileByPath(TEST_UID, '.hidden/junk.md')).toBeNull();
  });

  it('re-enqueues files previously marked failed', async () => {
    const kb = await import('../../../src/main/features/kb_vector');
    const idx = await import('../../../src/main/features/kb_indexer');
    writeCtx('a.md', 'x');
    await kb.setFileStatus(TEST_UID, 'a.md', 'failed', {
      kind: 'text', bytes: 1, mtime: 1, sha1: 'mismatch', error: 'prior',
    });
    const r = await idx.reconcile(TEST_UID);
    expect(r.enqueuedUpsert).toBe(1);
  });

  it('does not enqueue deletes from a cancelled partial filesystem snapshot', async () => {
    const kb = await import('../../../src/main/features/kb_vector');
    const idx = await import('../../../src/main/features/kb_indexer');
    await kb.setFileStatus(TEST_UID, 'missing.md', 'ready', {
      kind: 'text', bytes: 1, mtime: 1, sha1: 'known', chunks: 1,
    });
    const controller = new AbortController();
    controller.abort();

    const r = await idx.reconcile(TEST_UID, controller.signal);
    expect(r).toEqual({
      enqueuedUpsert: 0,
      enqueuedDelete: 0,
      unchanged: 0,
      cancelled: true,
    });
    await idx.drain(TEST_UID);
    expect(kb.getFileByPath(TEST_UID, 'missing.md')).not.toBeNull();
  });
});
