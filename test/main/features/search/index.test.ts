import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// index.ts wraps indexer + BM25 scoring + snippet extraction. Each test sets
// ORKAS_WORKSPACE_ROOT then resetModules so the module graph (paths +
// indexer's _cache) is re-created per test.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-search-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface TestLibraryHit {
  rel_path: string;
  chunk_idx: number;
  title?: string;
  content: string;
  score: number;
}

function libraryProvider(opts: {
  globalHits?: (userId: string) => TestLibraryHit[];
  projects?: Array<{ project_id: string; name: string }>;
  projectHits?: (userId: string, projectId: string) => TestLibraryHit[];
} = {}) {
  return {
    embedQuery: vi.fn(async () => [1, 0, 0]),
    searchGlobal: vi.fn((userId: string) => opts.globalHits?.(userId) || []),
    listProjects: vi.fn(async () => opts.projects || []),
    searchProject: vi.fn((userId: string, projectId: string) => (
      opts.projectHits?.(userId, projectId) || []
    )),
  };
}

async function loadSearch(provider = libraryProvider()) {
  const search = await import('../../../../src/main/features/search');
  search.__searchTestHooks.setLibraryContentSearchProvider(provider);
  return search;
}

function writeContext(rel: string, body: string): void {
  writeContextFor(TEST_UID, rel, body);
}

function writeContextFor(uid: string, rel: string, body: string): void {
  const full = path.join(tmpDir, uid, 'cloud', 'contexts', rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function writeChat(uid: string, cid: string, messages: unknown[]): void {
  const dir = path.join(tmpDir, uid, 'cloud', 'chats');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${cid}.jsonl`), messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
}

describe('search › searchAll', () => {
  it('returns empty for blank query', async () => {
    const provider = libraryProvider();
    const s = await loadSearch(provider);
    const result = await s.searchAll('u1', '');
    expect(result).toEqual({ results: [] });
    expect(provider.embedQuery).not.toHaveBeenCalled();
    expect(provider.searchGlobal).not.toHaveBeenCalled();
    expect(provider.listProjects).not.toHaveBeenCalled();
  });

  it('surfaces a context doc by filename', async () => {
    writeContext('pangolins.md', '# Guide\nThis document discusses pangolins in depth.');
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    const { results } = await s.searchAll('u1', 'pangolins');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].kind).toBe('context');
    expect(results[0].path).toBe('pangolins.md');
    expect(results[0].snippet).toBe('pangolins.md');
  });

  it('finds a global Library file by body content when its filename does not match', async () => {
    writeContext('guide.md', '# Guide\npangolins everywhere in the body');
    const s = await loadSearch(libraryProvider({
      globalHits: (userId) => userId === 'u1' ? [{
        rel_path: 'guide.md',
        chunk_idx: 0,
        title: 'Guide',
        content: 'pangolins everywhere in the body',
        score: 0.91,
      }] : [],
    }));
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    const { results } = await s.searchAll('u1', 'pangolins', { scope: 'context' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'context',
      path: 'guide.md',
      title: 'Guide',
      match_source: 'content',
      library_scope: 'global',
    });
    expect(results[0].snippet).toMatch(/pangolins/);
  });

  it('includes the semantic threshold boundary and drops the nearest chunk below it', async () => {
    const s = await loadSearch(libraryProvider({
      globalHits: () => [
        {
          rel_path: 'boundary.md',
          chunk_idx: 0,
          title: 'Boundary',
          content: 'This pangolins result is exactly on the accepted relevance boundary.',
          score: 0.45,
        },
        {
          rel_path: 'unrelated.md',
          chunk_idx: 0,
          title: 'Unrelated',
          content: 'This is merely the nearest vector, not a relevant result.',
          score: 0.449,
        },
      ],
    }));

    const { results } = await s.searchAll('u1', 'pangolins', { scope: 'context' });

    expect(results.map((row) => row.path)).toEqual(['boundary.md']);
  });

  it('searches global plus every project outside a project, then global plus only the active project inside one', async () => {
    const provider = libraryProvider({
      globalHits: () => [{
        rel_path: 'global-source.md',
        chunk_idx: 0,
        content: 'global source contains the nebula marker',
        score: 0.95,
      }],
      projects: [
        { project_id: 'project-a', name: 'Project A' },
        { project_id: 'project-b', name: 'Project B' },
      ],
      projectHits: (_userId, projectId) => [{
        rel_path: `${projectId}-source.md`,
        chunk_idx: 0,
        content: `${projectId} contains the nebula marker`,
        score: projectId === 'project-a' ? 0.8 : 0.9,
      }],
    });
    const s = await loadSearch(provider);

    const global = await s.searchAll('u1', 'nebula marker', {
      scope: 'context',
      limit: 20,
    });
    expect(global.results.map((row) => [
      row.library_scope,
      row.project_id || '',
      row.path,
    ])).toEqual([
      ['global', '', 'global-source.md'],
      ['project', 'project-b', 'project-b-source.md'],
      ['project', 'project-a', 'project-a-source.md'],
    ]);
    expect(provider.searchProject).toHaveBeenCalledTimes(2);

    provider.searchProject.mockClear();
    const scoped = await s.searchAll('u1', 'nebula marker', {
      scope: 'context',
      projectId: 'project-a',
      limit: 20,
    });
    expect(scoped.results.map((row) => [
      row.library_scope,
      row.project_id || '',
      row.path,
    ])).toEqual([
      ['global', '', 'global-source.md'],
      ['project', 'project-a', 'project-a-source.md'],
    ]);
    expect(provider.searchProject).toHaveBeenCalledTimes(1);
    expect(provider.searchProject).toHaveBeenCalledWith(
      'u1',
      'project-a',
      expect.any(Array),
      20,
    );
  });

  it('searches project filenames across all projects and restricts them inside a project', async () => {
    const projects = await import('../../../../src/main/features/projects');
    const first = await projects.createProject(TEST_UID, 'First project');
    const second = await projects.createProject(TEST_UID, 'Second project');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    for (const [projectId, fileName] of [
      [first.project.project_id, 'shared-filename-first.md'],
      [second.project.project_id, 'shared-filename-second.md'],
    ]) {
      const root = path.join(
        tmpDir, TEST_UID, 'cloud', 'projects', projectId, 'contexts',
      );
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, fileName), '# body');
    }
    const s = await loadSearch();

    const global = await s.searchAll(TEST_UID, 'shared-filename', {
      scope: 'context',
      limit: 20,
    });
    expect(global.results.map((row) => row.project_id).sort()).toEqual([
      first.project.project_id,
      second.project.project_id,
    ].sort());

    const scoped = await s.searchAll(TEST_UID, 'shared-filename', {
      scope: 'context',
      projectId: first.project.project_id,
      limit: 20,
    });
    expect(scoped.results.map((row) => row.project_id)).toEqual([
      first.project.project_id,
    ]);
  });

  it('embeds a normalized query once while searching global and multiple project indexes', async () => {
    const provider = libraryProvider({
      projects: [
        { project_id: 'project-a', name: 'Project A' },
        { project_id: 'project-b', name: 'Project B' },
      ],
    });
    const s = await loadSearch(provider);

    await s.searchLibraryContents('u1', '  Nebula Marker  ', { limit: 7 });
    await s.searchLibraryContents('u1', 'nebula marker', { limit: 7 });

    expect(provider.embedQuery).toHaveBeenCalledTimes(1);
    expect(provider.searchGlobal).toHaveBeenCalledTimes(2);
    expect(provider.searchProject).toHaveBeenCalledTimes(4);
    expect(provider.searchProject).toHaveBeenCalledWith(
      'u1',
      'project-a',
      [1, 0, 0],
      7,
    );
  });

  it('bounds merged body results while scanning a large project catalog', async () => {
    const projects = Array.from({ length: 120 }, (_, index) => ({
      project_id: `project-${index}`,
      name: `Project ${index}`,
    }));
    const provider = libraryProvider({
      projects,
      projectHits: (_userId, projectId) => [0, 1].map((chunkIndex) => ({
        rel_path: `${projectId}/scale-${chunkIndex}.md`,
        chunk_idx: 0,
        content: `scale marker content ${projectId} ${chunkIndex}`,
        score: 0.9,
      })),
    });
    const s = await loadSearch(provider);

    const results = await s.searchLibraryContents('u1', 'scale marker', {
      limit: 200,
    });

    expect(results).toHaveLength(200);
    expect(new Set(results.map((row) => `${row.project_id}:${row.path}`)).size).toBe(200);
    expect(provider.embedQuery).toHaveBeenCalledTimes(1);
    expect(provider.searchGlobal).toHaveBeenCalledTimes(1);
    expect(provider.searchProject).toHaveBeenCalledTimes(120);
  });

  it('keeps healthy Library scopes searchable when another vector index fails', async () => {
    const provider = libraryProvider({
      projects: [
        { project_id: 'broken-project', name: 'Broken project' },
        { project_id: 'healthy-project', name: 'Healthy project' },
      ],
    });
    provider.searchGlobal.mockImplementation(() => {
      throw new Error('global vector db unavailable');
    });
    provider.searchProject.mockImplementation((_userId, projectId) => {
      if (projectId === 'broken-project') throw new Error('project vector db unavailable');
      return [{
        rel_path: 'healthy.md',
        chunk_idx: 0,
        content: 'healthy project still contains the marker',
        score: 0.9,
      }];
    });
    const s = await loadSearch(provider);
    const degradations: string[] = [];

    const results = await s.searchLibraryContents('u1', 'marker', {
      limit: 10,
      onDegraded: (code) => degradations.push(code),
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      library_scope: 'project',
      project_id: 'healthy-project',
      path: 'healthy.md',
    });
    expect(new Set(degradations)).toEqual(new Set([
      'library_global_content_unavailable',
      'library_project_content_unavailable',
    ]));
  });

  it('falls back to filename results when query embedding is unavailable', async () => {
    writeContext('embedding-fallback.md', '# body');
    const provider = libraryProvider();
    provider.embedQuery.mockRejectedValue(new Error('embedder unavailable'));
    const s = await loadSearch(provider);
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();

    const searchResult = await s.searchAll('u1', 'embedding-fallback', {
      scope: 'context',
    });

    expect(searchResult.results.map((row) => row.path)).toEqual(['embedding-fallback.md']);
    expect(searchResult.degradation_code).toBe('library_content_embedding_unavailable');
    expect(provider.searchGlobal).not.toHaveBeenCalled();
    expect(provider.listProjects).not.toHaveBeenCalled();
  });

  it('keeps Library body search isolated to the requested user', async () => {
    const s = await loadSearch(libraryProvider({
      globalHits: (userId) => userId === 'u2' ? [{
        rel_path: 'u2-only.md',
        chunk_idx: 0,
        content: 'requested-account-only marker',
        score: 0.9,
      }] : [{
        rel_path: 'u1-only.md',
        chunk_idx: 0,
        content: 'active-account-only marker',
        score: 0.9,
      }],
    }));

    const { results } = await s.searchAll('u2', 'marker', { scope: 'context' });

    expect(results.map((row) => row.path)).toEqual(['u2-only.md']);
  });

  it('deduplicates filename and body hits and keeps an exact filename match', async () => {
    writeContext('nebula-guide.md', '# Guide\nnebula marker');
    const s = await loadSearch(libraryProvider({
      globalHits: () => [{
        rel_path: 'nebula-guide.md',
        chunk_idx: 0,
        content: 'nebula marker in the source body',
        score: 0.92,
      }],
    }));
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();

    const { results } = await s.searchAll('u1', 'nebula-guide.md', {
      scope: 'context',
      limit: 20,
    });

    expect(results.filter((row) => row.path === 'nebula-guide.md')).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: 'nebula-guide.md',
      snippet: 'nebula-guide.md',
      score: 95,
    });
    expect(results[0].match_source).toBeUndefined();
  });

  it('keeps the best chunk per file without merging identical paths from different projects', async () => {
    const s = await loadSearch(libraryProvider({
      projects: [
        { project_id: 'project-a', name: 'Project A' },
        { project_id: 'project-b', name: 'Project B' },
      ],
      projectHits: (_userId, projectId) => [
        {
          rel_path: 'same-name.md',
          chunk_idx: 0,
          content: `${projectId} weaker chunk`,
          score: 0.6,
        },
        {
          rel_path: 'same-name.md',
          chunk_idx: 1,
          content: `${projectId} best chunk`,
          score: projectId === 'project-a' ? 0.9 : 0.8,
        },
      ],
    }));

    const results = await s.searchLibraryContents('u1', 'best chunk', { limit: 20 });

    expect(results).toHaveLength(2);
    expect(results.map((row) => [row.project_id, row.chunk_idx])).toEqual([
      ['project-a', 1],
      ['project-b', 1],
    ]);
  });

  it('respects scope=chat (no context results)', async () => {
    writeContext('pangolins.md', '# Guide\nunrelated body');
    writeChat('u1', 'c1', [{ role: 'user', content: 'pangolins everywhere', time: 't' }]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    await ix.reconcileChatsIndex('u1');
    const { results } = await s.searchAll('u1', 'pangolins', { scope: 'chat' });
    expect(results.every((r) => r.kind === 'chat')).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('limits results to the given limit', async () => {
    for (let i = 0; i < 5; i++) writeContext(`keyword-${i}.md`, `# D${i}\nbody`);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    const { results } = await s.searchAll('u1', 'keyword', { limit: 2 });
    expect(results.length).toBe(2);
  });

  it('honors a requested single-scope limit above the old 30-row ceiling', async () => {
    for (let i = 0; i < 40; i++) writeContext(`expanded-limit-${i}.md`, `# D${i}\nbody`);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();

    const { results } = await s.searchAll('u1', 'expanded limit', {
      scope: 'context',
      limit: 40,
    });

    expect(results).toHaveLength(40);
  });

  it('reserves space for every result kind in the all-results limit', async () => {
    const s = await loadSearch();
    const rows = [
      ...Array.from({ length: 20 }, (_, index) => ({
        kind: 'context' as const,
        path: `context-${index}.md`,
        snippet: '',
        score: 100 - index,
      })),
      { kind: 'chat' as const, cid: 'chat-1', snippet: '', score: 5 },
      { kind: 'agent' as const, id: 'agent-1', snippet: '', score: 4 },
      { kind: 'skill' as const, id: 'skill-1', snippet: '', score: 3 },
    ];

    const limited = s.__searchTestHooks.limitSearchResults(rows, 8, 'all');

    expect(limited).toHaveLength(8);
    expect(new Set(limited.map((row) => row.kind))).toEqual(new Set([
      'context',
      'chat',
      'agent',
      'skill',
    ]));
    expect(limited.filter((row) => row.kind === 'context')).toHaveLength(5);
  });

  it('uses the requested user context index even when another user is active', async () => {
    writeContextFor('u1', 'private-u1-marker.md', 'active user data');
    writeContextFor('u2', 'private-u2-marker.md', 'requested user data');
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex('u1');
    await ix.reconcileContextsIndex('u2');

    const { results } = await s.searchAll('u2', 'private', { scope: 'context' });

    expect(results.map((result) => result.path)).toEqual(['private-u2-marker.md']);
  });
});

describe('search › searchContexts', () => {
  it('returns empty when no contexts indexed', async () => {
    const s = await loadSearch();
    const r = await s.searchContexts('anything');
    expect(r).toEqual([]);
  });

  it('ranks a direct filename match (body no longer matters)', async () => {
    writeContext('rhubarb.md', '# Tight\nunrelated body');
    writeContext('noisy.md', '# Noisy\n' + 'lorem '.repeat(500) + 'rhubarb ' + 'ipsum '.repeat(500));
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    const results = await s.searchContexts('rhubarb');
    // Only the file whose name contains "rhubarb" should surface.
    expect(results.length).toBe(1);
    expect(results[0].path).toBe('rhubarb.md');
  });

  it('matches on directory segment', async () => {
    writeContext('notes/2024/meeting.md', 'body');
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    const results = await s.searchContexts('notes');
    expect(results[0].path).toBe('notes/2024/meeting.md');
  });

  it('reuses the reconciled context snapshot across query keystrokes', async () => {
    writeContext('stable-name.md', 'body');
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    fs.rmSync(path.join(tmpDir, TEST_UID, 'cloud', 'contexts', 'stable-name.md'));

    expect((await s.searchContexts('stable')).length).toBe(1);
    ix.invalidateContextsIndex(TEST_UID);
    expect(await s.searchContexts('stable')).toEqual([]);
  });
});

describe('search › searchChats — group-chat shape end-to-end', () => {
  it('finds a query token in current group-chat jsonl shape and returns a snippet', async () => {
    // Pin the bug-fix path: bus refactor changed `<cid>.jsonl` from
    // `{role, content, time}` to `{id, ts, from, to, mentions, text}`.
    // `searchChats` must (a) read text via `text` field for snippet, and
    // (b) `searchAll` with scope=chat must surface the result.
    writeChat('u1', 'cgroup', [
      { id: 'm0', ts: '2026-01-01T00:00:00Z', from: 'user', to: ['commander'], mentions: [], text: 'discussing pangolin habitat' },
    ]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex('u1');
    const results = await s.searchChats('u1', 'pangolin');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].cid).toBe('cgroup');
    expect(results[0].msg_id).toBe('m0');
    expect(results[0].role).toBe('user');
    // Snippet must include the matched token (proves `text` field is being
    // read, not the absent `content`).
    expect(results[0].snippet).toMatch(/pangolin/);
  });
});

describe('search › searchChats', () => {
  it('fills conv_title from _index.json when present', async () => {
    writeChat('u1', 'c1', [{ role: 'user', content: 'widget question', time: 't' }]);
    const indexFile = path.join(tmpDir, 'u1', 'cloud', 'chats', '_index.json');
    fs.writeFileSync(indexFile, JSON.stringify([
      { conversation_id: 'c1', title: 'About widgets' },
    ]));
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex('u1');
    const results = await s.searchChats('u1', 'widget');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].conv_title).toBe('About widgets');
  });

  it('falls back to default title when _index.json is missing', async () => {
    writeChat('u1', 'c1', [{ role: 'user', content: 'thingamajig', time: 't' }]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex('u1');
    const results = await s.searchChats('u1', 'thingamajig');
    expect(results[0].conv_title).toBe('New conversation');
  });

  it('serves a usable invalidated snapshot and schedules one idle repair', async () => {
    writeChat(TEST_UID, 'c1', [{ role: 'user', content: 'stale snapshot token', time: 't' }]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex(TEST_UID);
    const compactIndex = path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json');
    fs.writeFileSync(compactIndex, JSON.stringify([
      { conversation_id: 'c1', title: 'Synced title' },
    ]));
    ix.invalidateChatsIndex(TEST_UID);

    const results = await s.searchChats(TEST_UID, 'snapshot token');
    expect(results.some((result) => result.cid === 'c1')).toBe(true);
    expect(s.__searchTestHooks.hasPendingChatRepair(TEST_UID)).toBe(true);

    await s.searchChats(TEST_UID, 'snapshot token');
    expect(s.__searchTestHooks.hasPendingChatRepair(TEST_UID)).toBe(true);
    s.__searchTestHooks.cancelChatRepair(TEST_UID);
  });

  it('caches display metadata and invalidates it on conversation/project rename', async () => {
    const projects = await import('../../../../src/main/features/projects');
    const chats = await import('../../../../src/main/features/chats');
    const createdProject = await projects.createProject(TEST_UID, 'Original project');
    expect(createdProject.ok).toBe(true);
    if (!createdProject.ok) return;
    const projectId = createdProject.project.project_id;
    const conversation = await chats.createConversation(TEST_UID, {
      title: 'Original conversation',
      projectId,
    });
    const jsonl = path.join(
      tmpDir, TEST_UID, 'cloud', 'projects', projectId, 'chats',
      `${conversation.conversation_id}.jsonl`,
    );
    fs.writeFileSync(jsonl, `${JSON.stringify({
      role: 'user', content: 'display catalog keyword', time: 't',
    })}\n`);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex(TEST_UID);

    let results = await s.searchChats(TEST_UID, 'catalog keyword');
    expect(results[0]).toMatchObject({
      conv_title: 'Original conversation',
      project_name: 'Original project',
    });

    await chats.renameConversation(
      TEST_UID, conversation.conversation_id, 'Renamed conversation', projectId);
    await projects.renameProject(TEST_UID, projectId, 'Renamed project');
    results = await s.searchChats(TEST_UID, 'catalog keyword');
    expect(results[0]).toMatchObject({
      conv_title: 'Renamed conversation',
      project_name: 'Renamed project',
    });

    const readSpy = vi.spyOn(fs.promises, 'readFile');
    try {
      await s.searchChats(TEST_UID, 'catalog keyword');
      const metadataReads = readSpy.mock.calls.filter(([file]) => (
        String(file).endsWith('_index.json') || String(file).endsWith('project.json')
      ));
      expect(metadataReads).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
  });
});

describe('search › context snippet', () => {
  it('uses the relPath as snippet (body is not read)', async () => {
    writeContext('deep/sub/distinctivemarker.md', 'body has a different word');
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    const results = await s.searchContexts('distinctivemarker');
    expect(results[0].snippet).toBe('deep/sub/distinctivemarker.md');
  });
});

describe('search › CJK bigram anchor (noise-doc rejection)', () => {
  // The bug shape that motivated the anchor filter: a user searches
  // `苏格拉底` (a 4-char term whose individual chars `苏`/`格`/`拉`/`底`
  // appear all over the corpus). Without anchoring, BM25 accumulates
  // unigram contributions for every doc that contains any of those chars
  // — and the noise docs flood the result list while the actual term
  // appears nowhere. With anchoring, the result list is empty whenever
  // no doc contains an adjacent-pair anchor (`苏格` / `格拉` / `拉底`).
  it('rejects docs that contain only individual CJK chars from a multi-char query', async () => {
    // None of these chats contains the full bigram `苏格` / `格拉` / `拉底`,
    // but every one contains at least one of `拉` / `底` (very common chars).
    writeChat('u1', 'noise1', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], mentions: [], text: '把这些候选拉成清单' },
    ]);
    writeChat('u1', 'noise2', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], mentions: [], text: '底层日志已经写好了' },
    ]);
    writeChat('u1', 'noise3', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], mentions: [], text: '关于学习教育的整理' },
    ]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex('u1');
    const results = await s.searchChats('u1', '苏格拉底');
    expect(results).toEqual([]);
  });

  it('keeps a doc that contains an adjacent-pair anchor from the query', async () => {
    writeChat('u1', 'hit', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], mentions: [], text: '苏格拉底的对话风格' },
    ]);
    writeChat('u1', 'noise', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], mentions: [], text: '把候选拉到底层' },
    ]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex('u1');
    const results = await s.searchChats('u1', '苏格拉底');
    expect(results.length).toBe(1);
    expect(results[0].cid).toBe('hit');
  });

  it('single-char CJK query still works (no bigram in tokens → no anchor filter)', async () => {
    writeChat('u1', 'c1', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], mentions: [], text: '今天聊水的处理' },
    ]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex('u1');
    const results = await s.searchChats('u1', '水');
    expect(results.length).toBe(1);
    expect(results[0].cid).toBe('c1');
  });
});

describe('search › reconcileAll', () => {
  it('runs without throwing on an empty workspace', async () => {
    const s = await loadSearch();
    await expect(s.reconcileAll()).resolves.toBeUndefined();
  });

  it('skips reserved top-level dirs instead of creating fake per-user indexes', async () => {
    // Create one real user dir with chats, plus some reserved dirs
    writeChat('real_user', 'c1', [{ role: 'user', content: 'target', time: 't' }]);
    const reserved = ['users', 'logs', 'shared', 'search', 'openclaw', 'venv'];
    for (const name of reserved) {
      // A sentinel user-shaped subtree makes the assertion prove that the
      // top-level directory was skipped, rather than merely observing that
      // an empty scan happened not to publish an index.
      writeChat(name, 'must-not-index', [{ role: 'user', content: 'reserved sentinel', time: 't' }]);
    }

    const s = await loadSearch();
    await s.reconcileAll();

    const paths = await import('../../../../src/main/paths');
    const ix = await import('../../../../src/main/features/search/indexer');
    const entry = await ix.getEntry(paths.userChatsIndexPath('real_user'), 'chat');
    expect(Object.keys(entry.idx.files)).toContain('c1');
    for (const name of reserved) {
      const reservedEntry = await ix.getEntry(paths.userChatsIndexPath(name), 'chat');
      expect(Object.keys(reservedEntry.idx.files), name).not.toContain('must-not-index');
      expect(fs.existsSync(paths.userContextsIndexPath(name)), name).toBe(false);
      expect(fs.existsSync(paths.userChatsIndexPath(name)), name).toBe(false);
    }
  });
});

describe('search › startup reconcile', () => {
  it('reuses an existing active-user snapshot and defers validation until the first query', async () => {
    writeChat(TEST_UID, 'active-chat', [
      { role: 'user', content: 'startup fallback token', time: 't' },
    ]);
    writeChat('inactive-user', 'inactive-chat', [
      { role: 'user', content: 'should not be scanned at startup', time: 't' },
    ]);
    const paths = await import('../../../../src/main/paths');
    const activeIndex = paths.userChatsIndexPath(TEST_UID);
    const inactiveIndex = paths.userChatsIndexPath('inactive-user');
    fs.mkdirSync(path.dirname(activeIndex), { recursive: true });
    // Deliberately invalid but non-empty: startup must not parse a large
    // persisted snapshot. Query-time reconcile remains the repair boundary.
    fs.writeFileSync(activeIndex, 'persisted-snapshot');

    const s = await loadSearch();
    await s.reconcileActive();

    expect(fs.readFileSync(activeIndex, 'utf-8')).toBe('persisted-snapshot');
    expect(fs.existsSync(inactiveIndex)).toBe(false);
    const results = await s.searchChats(TEST_UID, 'fallback token');
    expect(results.some((result) => result.cid === 'active-chat')).toBe(true);
  });

  it('bounds chat source stats instead of awaiting every JSONL serially', async () => {
    for (let i = 0; i < 96; i++) {
      writeChat(TEST_UID, `chat-${i}`, [{ role: 'user', content: `message ${i}`, time: 't' }]);
    }
    const indexer = await import('../../../../src/main/features/search/indexer');
    let active = 0;
    let maxActive = 0;
    const files = await indexer.__searchIndexerTestHooks.listUserChats(TEST_UID, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return { mtimeMs: 1, size: 1 };
    });

    expect(files).toHaveLength(96);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(indexer.__searchIndexerTestHooks.chatStatConcurrency);
  });
});

describe('search › re-exports from indexer', () => {
  it('re-exports the mutator hooks so callers can use one module', async () => {
    const s = await loadSearch();
    expect(typeof s.upsertContext).toBe('function');
    expect(typeof s.dropContext).toBe('function');
    expect(typeof s.indexChatMessage).toBe('function');
    expect(typeof s.dropChatConversation).toBe('function');
    expect(typeof s.flushAll).toBe('function');
    // skill / agent chat-message indexers were removed alongside the
    // skill_chats / agent_chats search scopes (see `_unlinkLegacyIndexes`).
    // Don't add assertions for them back — those scopes are intentionally
    // out of search.
  });
});
