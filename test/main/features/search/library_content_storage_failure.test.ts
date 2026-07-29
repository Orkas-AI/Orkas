import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

let tmpDir: string;
let previousWorkspace: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-search-storage-failure-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const vectorStore = await import('../../../../src/main/features/vec_store');
    vectorStore.closeAllVecStores();
  } catch { /* ignore */ }
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function queryVector(): number[] {
  const vector = new Array(512).fill(0);
  vector[0] = 1;
  return vector;
}

async function loadSearchWithRealStores(projectId: string) {
  const [search, kb, projectLibrary] = await Promise.all([
    import('../../../../src/main/features/search'),
    import('../../../../src/main/features/kb_vector'),
    import('../../../../src/main/features/project_library_indexer'),
  ]);
  search.__searchTestHooks.setLibraryContentSearchProvider({
    embedQuery: async () => queryVector(),
    searchGlobal: (userId, vector, limit) => (
      kb.searchExisting(userId, vector, { k: limit })
    ),
    listProjects: async () => [{ project_id: projectId, name: 'Project' }],
    searchProject: (userId, selectedProjectId, vector, limit) => (
      projectLibrary.searchExisting(userId, selectedProjectId, vector, { k: limit })
    ),
  });
  return { search, kb };
}

describe('Library content search storage failures', () => {
  it('returns a healthy global hit when a project vector database is corrupt', async () => {
    const userId = 'user-a';
    const projectId = 'project-a';
    const paths = await import('../../../../src/main/paths');
    const { search, kb } = await loadSearchWithRealStores(projectId);
    await kb.upsertFile(userId, {
      relPath: 'healthy-global.md',
      kind: 'text',
      bytes: 12,
      mtime: 1,
      sha1: 'healthy-global',
      chunks: [{
        title: 'Healthy global',
        content: 'storage failure marker remains globally searchable',
        embedding: queryVector(),
      }],
    });
    const corruptProjectDb = paths.projectLibraryVectorDbPath(userId, projectId);
    fs.mkdirSync(path.dirname(corruptProjectDb), { recursive: true });
    fs.writeFileSync(corruptProjectDb, 'not a sqlite database');

    const results = await search.searchLibraryContents(
      userId,
      'storage failure marker',
      { limit: 10 },
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      library_scope: 'global',
      path: 'healthy-global.md',
    });
    expect(fs.readFileSync(corruptProjectDb, 'utf8')).toBe('not a sqlite database');
  });

  it('returns a healthy project hit when the global vector database is corrupt', async () => {
    const userId = 'user-a';
    const projectId = 'project-a';
    const paths = await import('../../../../src/main/paths');
    const vectorStore = await import('../../../../src/main/features/vec_store');
    const { search } = await loadSearchWithRealStores(projectId);
    const projectDb = paths.projectLibraryVectorDbPath(userId, projectId);
    const projectStore = vectorStore.openVecStore(path.dirname(projectDb));
    await projectStore.upsertFile({
      id: 'healthy-project.md',
      kind: 'text',
      bytes: 12,
      mtime: 1,
      sha1: 'healthy-project',
      chunks: [{
        title: 'Healthy project',
        content: 'storage failure marker remains searchable in the project',
        embedding: queryVector(),
      }],
    });
    const corruptGlobalDb = paths.userKbVectorDbPath(userId);
    fs.mkdirSync(path.dirname(corruptGlobalDb), { recursive: true });
    fs.writeFileSync(corruptGlobalDb, 'not a sqlite database');

    const results = await search.searchLibraryContents(
      userId,
      'storage failure marker',
      { projectId, limit: 10 },
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      library_scope: 'project',
      project_id: projectId,
      path: 'healthy-project.md',
    });
    expect(fs.readFileSync(corruptGlobalDb, 'utf8')).toBe('not a sqlite database');
  });
});
