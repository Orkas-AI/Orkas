import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * kb_search / kb_read tool contract tests. kb_embed is mocked so tests don't
 * load ONNX. kb_vector is exercised for real (better-sqlite3 + sqlite-vec).
 */

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'kbtools';

vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedTexts: async (texts: string[]) => texts.map(() => new Array(512).fill(0)),
  embedQuery: async () => {
    // Any fixed direction. We mostly care about the plumbing / result shape
    // here, not the neighbour ranking itself (covered in kb_vector.test.ts).
    const v = new Array(512).fill(0); v[0] = 1; return v;
  },
  closeEmbedder: () => {},
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kbtools-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  try {
    const kb = await import('../../../../src/main/features/kb_vector');
    kb.closeAllKb();
  } catch { /* ignore */ }
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctxFor(state: Record<string, unknown> = {}) {
  return { state } as unknown as { state: Record<string, unknown> };
}

async function seedFiles() {
  const kb = await import('../../../../src/main/features/kb_vector');
  const v = (a: number) => { const x = new Array(512).fill(0); x[0] = a; return x; };
  await kb.upsertFile(TEST_UID, {
    relPath: 'notes/a.md', kind: 'text', bytes: 10, mtime: 1, sha1: 'a',
    chunks: [
      { title: 'intro', content: 'alpha content', embedding: v(1) },
      { title: 'body', content: 'second chunk body', embedding: v(0.8) },
    ],
  });
  await kb.upsertFile(TEST_UID, {
    relPath: 'drafts/b.md', kind: 'text', bytes: 10, mtime: 1, sha1: 'b',
    chunks: [{ title: 'draft', content: 'a draft', embedding: v(0.5) }],
  });
  await kb.upsertFile(TEST_UID, {
    relPath: 'imgs/c.png', kind: 'image', bytes: 10, mtime: 1, sha1: 'c',
    chunks: [{ title: 'caption', content: 'image description', embedding: v(0.2) }],
  });
}

describe('kb-tools › kb_search', () => {
  it('returns formatted hits with path/chunk/score/preview', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [kbSearch] = createKbTools({ userId: TEST_UID });
    const r = await kbSearch.execute({ query: 'alpha', k: 3 }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/path=notes\/a\.md/);
    expect(r.content).toMatch(/chunk=\d/);
    expect(r.content).toMatch(/score=\d/);
    expect(r.content).toMatch(/alpha content/);   // preview body
  });

  it('rejects empty query', async () => {
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [kbSearch] = createKbTools({ userId: TEST_UID });
    const r = await kbSearch.execute({ query: '   ' }, ctxFor());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/required/);
  });

  it('respects kind filter', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [kbSearch] = createKbTools({ userId: TEST_UID });
    const r = await kbSearch.execute({ query: 'anything', k: 5, kind: 'image' }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/imgs\/c\.png/);
    expect(r.content).not.toMatch(/notes\/a\.md/);
    expect(r.content).not.toMatch(/drafts\/b\.md/);
  });

  it('reports processing count when KB has in-flight files', async () => {
    const kb = await import('../../../../src/main/features/kb_vector');
    await kb.setFileStatus(TEST_UID, 'pending.md', 'processing', {
      kind: 'text', bytes: 1, mtime: 1, sha1: 'p',
    });
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [kbSearch] = createKbTools({ userId: TEST_UID });
    const r = await kbSearch.execute({ query: 'x' }, ctxFor());
    expect(r.content).toMatch(/still being processed|processing=1/);
  });
});

describe('kb-tools › kb_read', () => {
  it('returns full body by default (joined chunks)', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbRead] = createKbTools({ userId: TEST_UID });
    const r = await kbRead.execute({ path: 'notes/a.md' }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/<kb-file path="notes\/a\.md"/);
    expect(r.content).toMatch(/alpha content/);
    expect(r.content).toMatch(/second chunk body/);
    expect(r.content).toMatch(/<\/kb-file>/);
  });

  it('returns just one chunk when index given', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbRead] = createKbTools({ userId: TEST_UID });
    const r = await kbRead.execute({ path: 'notes/a.md', chunk: 2 }, ctxFor());
    expect(r.content).toMatch(/second chunk body/);
    expect(r.content).not.toMatch(/alpha content/);
  });

  it('rejects non-existent path', async () => {
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbRead] = createKbTools({ userId: TEST_UID });
    const r = await kbRead.execute({ path: 'nope.md' }, ctxFor());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not found/);
  });

  it('rejects file whose status != ready', async () => {
    const kb = await import('../../../../src/main/features/kb_vector');
    await kb.setFileStatus(TEST_UID, 'bad.md', 'failed', {
      kind: 'text', bytes: 1, mtime: 1, sha1: 'x', error: 'extract blew up',
    });
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbRead] = createKbTools({ userId: TEST_UID });
    const r = await kbRead.execute({ path: 'bad.md' }, ctxFor());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/status=failed/);
    expect(r.content).toMatch(/extract blew up/);
  });

  it('expands via window to include neighbour chunks', async () => {
    // 3-chunk file, ask for middle with window=1 → should return all three,
    // and tag the middle one as the hit.
    const kb = await import('../../../../src/main/features/kb_vector');
    const v = (a: number) => { const x = new Array(512).fill(0); x[0] = a; return x; };
    await kb.upsertFile(TEST_UID, {
      relPath: 'multi.md', kind: 'text', bytes: 30, mtime: 1, sha1: 'm',
      chunks: [
        { title: 'first', content: 'chunk one body', embedding: v(0.1) },
        { title: 'second', content: 'chunk two body', embedding: v(0.2) },
        { title: 'third', content: 'chunk three body', embedding: v(0.3) },
      ],
    });
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbRead] = createKbTools({ userId: TEST_UID });
    const r = await kbRead.execute({ path: 'multi.md', chunk: 2, window: 1 }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/chunk one body/);
    expect(r.content).toMatch(/chunk two body/);
    expect(r.content).toMatch(/chunk three body/);
    expect(r.content).toMatch(/hit=2/);
  });

  it('window clamps to file bounds without error', async () => {
    // Window extends past both ends of a 1-chunk file — just returns that chunk.
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbRead] = createKbTools({ userId: TEST_UID });
    const r = await kbRead.execute({ path: 'drafts/b.md', chunk: 1, window: 5 }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/a draft/);
  });

  it('rejects out-of-range chunk index', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbRead] = createKbTools({ userId: TEST_UID });
    const r = await kbRead.execute({ path: 'notes/a.md', chunk: 99 }, ctxFor());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/out of range/);
  });
});

describe('kb-tools › shape', () => {
  it('createKbTools returns exactly two tools (search + read)', async () => {
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const tools = createKbTools({ userId: TEST_UID });
    expect(tools.map((t) => t.name)).toEqual(['kb_search', 'kb_read']);
  });

  it('tools have required JSON schema fields', async () => {
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [kbSearch, kbRead] = createKbTools({ userId: TEST_UID });
    expect(kbSearch.inputSchema?.required).toContain('query');
    expect(kbRead.inputSchema?.required).toContain('path');
  });
});
