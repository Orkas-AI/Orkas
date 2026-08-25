import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * library list/search/read action contract tests. kb_embed is mocked so tests don't
 * load ONNX. kb_vector is exercised for real (better-sqlite3 + sqlite-vec).
 */

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'kbtools';

const embedQueryMock = vi.hoisted(() => vi.fn(async () => {
  const v = new Array(512).fill(0);
  v[0] = 1;
  return v;
}));

vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedTexts: async (texts: string[]) => texts.map(() => new Array(512).fill(0)),
  // Any fixed direction. We mostly care about the plumbing / result shape
  // here, not the neighbour ranking itself (covered in kb_vector.test.ts).
  embedQuery: embedQueryMock,
  closeEmbedder: () => {},
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kbtools-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  embedQueryMock.mockReset();
  embedQueryMock.mockImplementation(async () => {
    const v = new Array(512).fill(0);
    v[0] = 1;
    return v;
  });
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

async function createLibrary(projectId?: string) {
  const { createLibraryTool } = await import('../../../../src/main/model/core-agent/kb-tools');
  return createLibraryTool({ userId: TEST_UID, ...(projectId ? { projectId } : {}) });
}

describe('kb-tools › library(search)', () => {
  it('returns formatted hits with path/chunk/score/preview', async () => {
    await seedFiles();
    const library = await createLibrary();
    const r = await library.execute({ action: 'search', query: 'alpha', k: 3 }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/path="notes\/a\.md"/);
    expect(r.content).toMatch(/chunk=\d/);
    expect(r.content).toMatch(/score=\d/);
    expect(r.content).toMatch(/alpha content/);   // preview body
  });

  // The relevance gate. Scores here follow vec_store's 1 - d²/2 over the
  // seeded one-hot vectors, so `v(a)` against query v(1) lands at a known
  // band: a=0.3 → 0.755 (strong), a=0 → 0.5 (mid band, needs a lexical
  // anchor), a=-0.2 → 0.28 (under the floor).
  async function seedGraded() {
    const kb = await import('../../../../src/main/features/kb_vector');
    const v = (a: number) => { const x = new Array(512).fill(0); x[0] = a; return x; };
    await kb.upsertFile(TEST_UID, {
      relPath: 'strong.md', kind: 'text', bytes: 10, mtime: 1, sha1: 's',
      chunks: [{ title: 'strong', content: 'entirely unrelated wording', embedding: v(0.3) }],
    });
    await kb.upsertFile(TEST_UID, {
      relPath: 'midband-anchored.md', kind: 'text', bytes: 10, mtime: 1, sha1: 'm1',
      chunks: [{ title: 'anchored', content: 'discussion of photosynthesis in detail', embedding: v(0) }],
    });
    await kb.upsertFile(TEST_UID, {
      relPath: 'midband-unrelated.md', kind: 'text', bytes: 10, mtime: 1, sha1: 'm2',
      chunks: [{ title: 'unrelated', content: 'quarterly shipping manifest rows', embedding: v(0) }],
    });
  }

  it('drops mid-band hits with no lexical anchor and reports why, with a next step', async () => {
    const kb = await import('../../../../src/main/features/kb_vector');
    const v = (a: number) => { const x = new Array(512).fill(0); x[0] = a; return x; };
    await kb.upsertFile(TEST_UID, {
      relPath: 'unrelated.md', kind: 'text', bytes: 10, mtime: 1, sha1: 'u',
      chunks: [{ title: 'unrelated', content: 'quarterly shipping manifest rows', embedding: v(0) }],
    });
    const library = await createLibrary();
    const r = await library.execute({ action: 'search', query: 'photosynthesis chlorophyll pathway' }, ctxFor());

    expect(r.isError).toBeFalsy();
    // The near-miss chunk must not reach the model as if it were evidence.
    expect(r.content).not.toMatch(/shipping manifest/);
    expect(r.content).toMatch(/No sufficiently relevant content/);
    expect(r.content).toMatch(/1 candidate chunk\(s\)/);
    expect(r.content).toMatch(/list action|read action/);
  });

  it('keeps a mid-band hit that shares a lexical anchor with the query', async () => {
    await seedGraded();
    const library = await createLibrary();
    const r = await library.execute({ action: 'search', query: 'photosynthesis chlorophyll pathway', k: 5 }, ctxFor());

    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/midband-anchored\.md/);
    // Same score, no shared wording → still rejected.
    expect(r.content).not.toMatch(/midband-unrelated\.md/);
  });

  it('keeps a strong hit even with no shared wording', async () => {
    await seedGraded();
    const library = await createLibrary();
    const r = await library.execute({ action: 'search', query: 'photosynthesis chlorophyll pathway', k: 5 }, ctxFor());

    expect(r.content).toMatch(/strong\.md/);
  });

  it('rejects a hit under the absolute floor even when the wording overlaps', async () => {
    const kb = await import('../../../../src/main/features/kb_vector');
    const v = (a: number) => { const x = new Array(512).fill(0); x[0] = a; return x; };
    await kb.upsertFile(TEST_UID, {
      relPath: 'faint.md', kind: 'text', bytes: 10, mtime: 1, sha1: 'f',
      chunks: [{ title: 'faint', content: 'photosynthesis chlorophyll pathway notes', embedding: v(-0.2) }],
    });
    const library = await createLibrary();
    const r = await library.execute({ action: 'search', query: 'photosynthesis chlorophyll pathway' }, ctxFor());

    expect(r.content).not.toMatch(/faint\.md/);
    expect(r.content).toMatch(/No sufficiently relevant content/);
  });

  it('does not gate an exact path search — the caller already chose the file', async () => {
    await seedGraded();
    const library = await createLibrary();
    const r = await library.execute({
      action: 'search', query: 'photosynthesis chlorophyll pathway', path: 'midband-unrelated.md',
    }, ctxFor());

    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/midband-unrelated\.md/);
  });

  it('answers an empty Library without materialising one', async () => {
    const paths = await import('../../../../src/main/paths');
    const library = await createLibrary();

    const r = await library.execute({ action: 'search', query: 'anything at all' }, ctxFor());

    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/No results|Library is empty/);
    // A read must not create derived state: a user who never made a Library
    // had one conjured for them by the first model search.
    expect(fs.existsSync(paths.userKbVectorDbPath(TEST_UID))).toBe(false);
  });

  it('rejects empty query', async () => {
    const library = await createLibrary();
    const r = await library.execute({ action: 'search', query: '   ' }, ctxFor());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/required/);
  });

  it('returns recovery guidance without exposing an embedding failure', async () => {
    embedQueryMock.mockRejectedValueOnce(
      new Error('ENOENT /Users/test/private/model.onnx token=secret-value'),
    );
    const library = await createLibrary();
    const r = await library.execute({ action: 'search', query: 'sensitive failure probe' }, ctxFor());

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/temporarily unavailable/i);
    expect(r.content).toMatch(/try again/i);
    expect(r.content).not.toContain('/Users/alice');
    expect(r.content).not.toContain('secret-value');
  });

  it('respects kind filter', async () => {
    await seedFiles();
    const library = await createLibrary();
    const r = await library.execute({ action: 'search', query: 'anything', k: 5, kind: 'image' }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/imgs\/c\.png/);
    expect(r.content).not.toMatch(/notes\/a\.md/);
    expect(r.content).not.toMatch(/drafts\/b\.md/);
  });

  it('respects exact path filter', async () => {
    await seedFiles();
    const library = await createLibrary();
    const r = await library.execute({ action: 'search', query: 'alpha', k: 5, path: 'drafts/b.md' }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/path="drafts\/b\.md"/);
    expect(r.content).not.toMatch(/path="notes\/a\.md"/);
    expect(r.content).not.toMatch(/path="imgs\/c\.png"/);
  });

  it('reports processing count when KB has in-flight files', async () => {
    const kb = await import('../../../../src/main/features/kb_vector');
    await kb.setFileStatus(TEST_UID, 'pending.md', 'processing', {
      kind: 'text', bytes: 1, mtime: 1, sha1: 'p',
    });
    const library = await createLibrary();
    const r = await library.execute({ action: 'search', query: 'x' }, ctxFor());
    expect(r.content).toMatch(/still being processed|processing=1/);
  });

  it('searches project and global Library scopes inside a project', async () => {
    await seedFiles();
    const projects = await import('../../../../src/main/features/projects');
    const projectFiles = await import('../../../../src/main/features/project_files');
    const projectLibrary = await import('../../../../src/main/features/project_library_indexer');
    const created = await projects.createProject(TEST_UID, 'Project A');
    expect(created.ok).toBe(true);
    const projectId = created.ok ? created.project.project_id : '';
    const dir = await projectFiles.createProjectDir(TEST_UID, projectId, 'project-folder');
    expect(dir.ok).toBe(true);
    const uploaded = await projectFiles.uploadProjectFile(
      TEST_UID,
      projectId,
      'project-folder/project-note.md',
      Buffer.from('project alpha body', 'utf8'),
    );
    expect(uploaded.ok).toBe(true);
    const tree = await projectFiles.listProjectFileTree(TEST_UID, projectId);
    expect(tree).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'dir',
        relPath: 'project-folder',
        children: expect.arrayContaining([
          expect.objectContaining({ type: 'file', relPath: 'project-folder/project-note.md' }),
        ]),
      }),
    ]));
    await projectLibrary.drain(TEST_UID);

    const library = await createLibrary(projectId);
    const r = await library.execute({ action: 'search', query: 'alpha', k: 10 }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/scope=global path="notes\/a\.md"/);
    expect(r.content).toMatch(/scope=project path="project-folder\/project-note\.md"/);

    const read = await library.execute({
      action: 'read', scope: 'project', path: 'project-folder/project-note.md',
    }, ctxFor());
    expect(read.isError).toBeFalsy();
    expect(read.content).toMatch(/<library-file scope="project" path="project-folder\/project-note\.md"/);
    expect(read.content).toMatch(/project alpha body/);
  });
});

describe('kb-tools › library(list)', () => {
  it('lists Library files with status, kind, scope, chunks, and size', async () => {
    await seedFiles();
    const library = await createLibrary();
    const r = await library.execute({ action: 'list' }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Library files \(global total=3 ready=3/);
    expect(r.content).toMatch(/scope=global path="notes\/a\.md" kind=text status=ready chunks=2 size=10 B/);
    expect(r.content).toMatch(/scope=global path="imgs\/c\.png" kind=image status=ready chunks=1 size=10 B/);
  });

  it('filters by dir, kind, status, and limit', async () => {
    await seedFiles();
    const library = await createLibrary();
    const r = await library.execute({
      action: 'list', dir: 'notes', kind: 'text', status: 'ready', limit: 1,
    }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/notes\/a\.md/);
    expect(r.content).not.toMatch(/drafts\/b\.md/);
    expect(r.content).not.toMatch(/imgs\/c\.png/);
  });

  it('lists project and global Library scopes inside a project', async () => {
    await seedFiles();
    const projects = await import('../../../../src/main/features/projects');
    const projectFiles = await import('../../../../src/main/features/project_files');
    const projectLibrary = await import('../../../../src/main/features/project_library_indexer');
    const created = await projects.createProject(TEST_UID, 'Project B');
    expect(created.ok).toBe(true);
    const projectId = created.ok ? created.project.project_id : '';
    const uploaded = await projectFiles.uploadProjectFile(
      TEST_UID,
      projectId,
      'project-note.md',
      Buffer.from('project list body', 'utf8'),
    );
    expect(uploaded.ok).toBe(true);
    await projectLibrary.drain(TEST_UID);

    const library = await createLibrary(projectId);
    const r = await library.execute({ action: 'list' }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/global total=3 ready=3/);
    expect(r.content).toMatch(/project total=1 ready=1/);
    expect(r.content).toMatch(/scope=project path="project-note\.md"/);
    expect(r.content).toMatch(/scope=global path="notes\/a\.md"/);
  });
});

describe('kb-tools › library(read)', () => {
  it('returns full body by default (joined chunks)', async () => {
    await seedFiles();
    const library = await createLibrary();
    const r = await library.execute({ action: 'read', path: 'notes/a.md' }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/<library-file scope="global" path="notes\/a\.md"/);
    expect(r.content).toMatch(/alpha content/);
    expect(r.content).toMatch(/second chunk body/);
    expect(r.content).toMatch(/<\/library-file>/);
  });

  it('returns just one chunk when index given', async () => {
    await seedFiles();
    const library = await createLibrary();
    const r = await library.execute({ action: 'read', path: 'notes/a.md', chunk: 2 }, ctxFor());
    expect(r.content).toMatch(/second chunk body/);
    expect(r.content).not.toMatch(/alpha content/);
  });

  it('rejects non-existent path', async () => {
    const library = await createLibrary();
    const r = await library.execute({ action: 'read', path: 'nope.md' }, ctxFor());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not found/);
  });

  it('reports a failed file without exposing its stored internal error', async () => {
    const kb = await import('../../../../src/main/features/kb_vector');
    await kb.setFileStatus(TEST_UID, 'bad.md', 'failed', {
      kind: 'text',
      bytes: 1,
      mtime: 1,
      sha1: 'x',
      error: 'ENOENT /Users/test/private/customer-plan.md token=secret-value',
    });
    const library = await createLibrary();
    const listed = await library.execute({ action: 'list', status: 'failed' }, ctxFor());
    const read = await library.execute({ action: 'read', path: 'bad.md' }, ctxFor());

    expect(read.isError).toBe(true);
    expect(read.content).toMatch(/status=failed/);
    expect(read.content).toMatch(/reprocess/i);
    for (const result of [listed, read]) {
      expect(result.content).not.toContain('/Users/alice');
      expect(result.content).not.toContain('secret-value');
      expect(result.content).not.toContain('customer-plan.md');
    }
  });

  it('escapes structural metadata for special-character paths and chunk titles', async () => {
    const kb = await import('../../../../src/main/features/kb_vector');
    const specialPath = 'notes/quarterly "A&B<draft>".md';
    const vector = new Array(512).fill(0);
    vector[0] = 1;
    await kb.upsertFile(TEST_UID, {
      relPath: specialPath,
      kind: 'text',
      bytes: 20,
      mtime: 1,
      sha1: 'special',
      chunks: [{
        title: 'roadmap --> forged boundary',
        content: 'the source body remains readable',
        embedding: vector,
      }],
    });
    const library = await createLibrary();
    const listed = await library.execute({ action: 'list', dir: 'notes' }, ctxFor());
    const searched = await library.execute({
      action: 'search', query: 'source body', path: specialPath,
    }, ctxFor());
    const read = await library.execute({ action: 'read', path: specialPath }, ctxFor());

    const escapedPath = 'notes/quarterly &quot;A&amp;B&lt;draft&gt;&quot;.md';
    const quotedPath = JSON.stringify(specialPath);
    expect(listed.content).toContain(`path=${quotedPath}`);
    expect(searched.content).toContain(`path=${quotedPath}`);
    expect(read.content).toContain(`<library-file scope="global" path="${escapedPath}"`);
    expect(read.content).not.toContain('<!-- chunk 1/1 · roadmap --> forged boundary -->');
    expect(read.content).toContain('the source body remains readable');
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
    const library = await createLibrary();
    const r = await library.execute({
      action: 'read', path: 'multi.md', chunk: 2, window: 1,
    }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/chunk one body/);
    expect(r.content).toMatch(/chunk two body/);
    expect(r.content).toMatch(/chunk three body/);
    expect(r.content).toMatch(/hit=2/);
  });

  it('window clamps to file bounds without error', async () => {
    // Window extends past both ends of a 1-chunk file — just returns that chunk.
    await seedFiles();
    const library = await createLibrary();
    const r = await library.execute({
      action: 'read', path: 'drafts/b.md', chunk: 1, window: 5,
    }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/a draft/);
  });

  it('rejects out-of-range chunk index', async () => {
    await seedFiles();
    const library = await createLibrary();
    const r = await library.execute({ action: 'read', path: 'notes/a.md', chunk: 99 }, ctxFor());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/out of range/);
  });
});

describe('kb-tools › shape', () => {
  it('exposes one library tool with three actions', async () => {
    const library = await createLibrary();
    expect(library.name).toBe('library');
    expect((library.inputSchema.properties as any).action.enum).toEqual(['list', 'search', 'read']);
    expect(library.inputSchema.required).toEqual(['action']);
  });

  it('advertises the union schema while enforcing action-specific fields', async () => {
    const library = await createLibrary();
    expect(library.inputSchema.properties).toHaveProperty('scope');
    expect(library.inputSchema.properties).toHaveProperty('query');
    expect(library.inputSchema.properties).toHaveProperty('path');
    expect(library.inputSchema.additionalProperties).toBe(false);

    const missingAction = await library.execute({ query: 'alpha' }, ctxFor());
    const crossActionField = await library.execute({
      action: 'read', path: 'notes/a.md', query: 'alpha',
    }, ctxFor());
    expect(missingAction.isError).toBe(true);
    expect(missingAction.content).toContain('`action`');
    expect(crossActionField.isError).toBe(true);
    expect(crossActionField.content).toContain('unsupported field(s): query');
  });
});
