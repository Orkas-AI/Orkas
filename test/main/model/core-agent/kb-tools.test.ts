import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * kb_list / kb_search / kb_read tool contract tests. kb_embed is mocked so tests don't
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

describe('kb-tools › kb_search', () => {
  it('returns formatted hits with path/chunk/score/preview', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbSearch] = createKbTools({ userId: TEST_UID });
    const r = await kbSearch.execute({ query: 'alpha', k: 3 }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/path="notes\/a\.md"/);
    expect(r.content).toMatch(/chunk=\d/);
    expect(r.content).toMatch(/score=\d/);
    expect(r.content).toMatch(/alpha content/);   // preview body
  });

  it('rejects empty query', async () => {
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbSearch] = createKbTools({ userId: TEST_UID });
    const r = await kbSearch.execute({ query: '   ' }, ctxFor());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/required/);
  });

  it('returns recovery guidance without exposing an embedding failure', async () => {
    embedQueryMock.mockRejectedValueOnce(
      new Error('ENOENT /Users/test/private/model.onnx token=secret-value'),
    );
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbSearch] = createKbTools({ userId: TEST_UID });
    const r = await kbSearch.execute({ query: 'sensitive failure probe' }, ctxFor());

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/temporarily unavailable/i);
    expect(r.content).toMatch(/try again/i);
    expect(r.content).not.toContain('/Users/alice');
    expect(r.content).not.toContain('secret-value');
  });

  it('respects kind filter', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbSearch] = createKbTools({ userId: TEST_UID });
    const r = await kbSearch.execute({ query: 'anything', k: 5, kind: 'image' }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/imgs\/c\.png/);
    expect(r.content).not.toMatch(/notes\/a\.md/);
    expect(r.content).not.toMatch(/drafts\/b\.md/);
  });

  it('respects exact path filter', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbSearch] = createKbTools({ userId: TEST_UID });
    const r = await kbSearch.execute({ query: 'alpha', k: 5, path: 'drafts/b.md' }, ctxFor());
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
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbSearch] = createKbTools({ userId: TEST_UID });
    const r = await kbSearch.execute({ query: 'x' }, ctxFor());
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

    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, kbSearch, kbRead] = createKbTools({ userId: TEST_UID, projectId });
    const r = await kbSearch.execute({ query: 'alpha', k: 10 }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/scope=global path="notes\/a\.md"/);
    expect(r.content).toMatch(/scope=project path="project-folder\/project-note\.md"/);

    const read = await kbRead.execute({ scope: 'project', path: 'project-folder/project-note.md' }, ctxFor());
    expect(read.isError).toBeFalsy();
    expect(read.content).toMatch(/<library-file scope="project" path="project-folder\/project-note\.md"/);
    expect(read.content).toMatch(/project alpha body/);
  });
});

describe('kb-tools › kb_list', () => {
  it('lists Library files with status, kind, scope, chunks, and size', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [kbList] = createKbTools({ userId: TEST_UID });
    const r = await kbList.execute({}, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Library files \(global total=3 ready=3/);
    expect(r.content).toMatch(/scope=global path="notes\/a\.md" kind=text status=ready chunks=2 size=10 B/);
    expect(r.content).toMatch(/scope=global path="imgs\/c\.png" kind=image status=ready chunks=1 size=10 B/);
  });

  it('filters by dir, kind, status, and limit', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [kbList] = createKbTools({ userId: TEST_UID });
    const r = await kbList.execute({ dir: 'notes', kind: 'text', status: 'ready', limit: 1 }, ctxFor());
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

    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [kbList] = createKbTools({ userId: TEST_UID, projectId });
    const r = await kbList.execute({}, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/global total=3 ready=3/);
    expect(r.content).toMatch(/project total=1 ready=1/);
    expect(r.content).toMatch(/scope=project path="project-note\.md"/);
    expect(r.content).toMatch(/scope=global path="notes\/a\.md"/);
  });
});

describe('kb-tools › kb_read', () => {
  it('returns full body by default (joined chunks)', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, , kbRead] = createKbTools({ userId: TEST_UID });
    const r = await kbRead.execute({ path: 'notes/a.md' }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/<library-file scope="global" path="notes\/a\.md"/);
    expect(r.content).toMatch(/alpha content/);
    expect(r.content).toMatch(/second chunk body/);
    expect(r.content).toMatch(/<\/library-file>/);
  });

  it('returns just one chunk when index given', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, , kbRead] = createKbTools({ userId: TEST_UID });
    const r = await kbRead.execute({ path: 'notes/a.md', chunk: 2 }, ctxFor());
    expect(r.content).toMatch(/second chunk body/);
    expect(r.content).not.toMatch(/alpha content/);
  });

  it('rejects non-existent path', async () => {
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, , kbRead] = createKbTools({ userId: TEST_UID });
    const r = await kbRead.execute({ path: 'nope.md' }, ctxFor());
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
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [kbList, , kbRead] = createKbTools({ userId: TEST_UID });
    const listed = await kbList.execute({ status: 'failed' }, ctxFor());
    const read = await kbRead.execute({ path: 'bad.md' }, ctxFor());

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
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [kbList, kbSearch, kbRead] = createKbTools({ userId: TEST_UID });
    const listed = await kbList.execute({ dir: 'notes' }, ctxFor());
    const searched = await kbSearch.execute({ query: 'source body', path: specialPath }, ctxFor());
    const read = await kbRead.execute({ path: specialPath }, ctxFor());

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
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, , kbRead] = createKbTools({ userId: TEST_UID });
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
    const [, , kbRead] = createKbTools({ userId: TEST_UID });
    const r = await kbRead.execute({ path: 'drafts/b.md', chunk: 1, window: 5 }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/a draft/);
  });

  it('rejects out-of-range chunk index', async () => {
    await seedFiles();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [, , kbRead] = createKbTools({ userId: TEST_UID });
    const r = await kbRead.execute({ path: 'notes/a.md', chunk: 99 }, ctxFor());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/out of range/);
  });
});

describe('kb-tools › shape', () => {
  it('createKbTools returns exactly three tools (list + search + read)', async () => {
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const tools = createKbTools({ userId: TEST_UID });
    expect(tools.map((t) => t.name)).toEqual(['kb_list', 'kb_search', 'kb_read']);
  });

  it('tools have required JSON schema fields', async () => {
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const [kbList, kbSearch, kbRead] = createKbTools({ userId: TEST_UID });
    expect(kbList.inputSchema?.properties).toHaveProperty('scope');
    expect(kbSearch.inputSchema?.required).toContain('query');
    expect(kbRead.inputSchema?.required).toContain('path');
  });
});
