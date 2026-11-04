import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

const diagnostics = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => diagnostics }));

let root: string, previous: string | undefined;
const uid = 'progress-owner';
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-search-progress-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules(); vi.clearAllMocks();
  (await import('../../../../src/main/features/users')).activateUser(uid);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await drainMainRuntimeForTest();
  fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previous;
});

it('retains every candidate while reading only requested summaries and publishes fast summaries before a held source', async () => {
  const chats = await import('../../../../src/main/features/chats');
  const store = await import('../../../../src/main/features/search/chat_store');
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const cid = (await chats.createConversation(uid, { title: `Result ${i}` })).conversation_id;
    ids.push(cid);
    fs.writeFileSync(path.join(root, uid, 'cloud/chats', cid + '.jsonl'), JSON.stringify({ text: 'needle' }) + '\n');
    store.replaceConversation(uid, cid, [{ cid, msgIndex: 0, role: 'user', time: '', text: 'needle' }], { mtime: 1, size: 1, next: 1 });
  }
  const held = gate();
  const read = vi.spyOn(await import('../../../../src/main/features/search/chat-snippets'), 'readChatSnippets')
    .mockImplementation(async file => {
      if (file.endsWith(ids[1] + '.jsonl')) await held.promise;
      return new Map([[0, { snippet: 'needle', visible: true }]]);
    });
  const search = await import('../../../../src/main/features/search');
  const pages: any[] = [];
  const pending = (async () => {
    for await (const page of search.streamSearch(uid, 'needle', { scope: 'chat', limit: 200,
      chatSnippetRefs: [...ids.slice(0, 2).map(cid => ({ cid, msg_index: 0 })), { cid: 'other-account-chat', msg_index: 0 }, { cid: ids[2], msg_index: 999 }] })) pages.push(page);
  })();
  try {
    await vi.waitFor(() => expect(pages.some(p => p.results.some((r: any) => r.cid === ids[0] && r.snippet === 'needle'))).toBe(true), { timeout: 5000 });
    expect(pages.at(-1).results).toHaveLength(12);
    expect(pages.at(-1).pending_kinds).toContain('chat');
    expect(read).toHaveBeenCalledTimes(2);
  } finally { held.release(); await pending; }
  expect(pages.at(-1).results.filter((r: any) => r.snippet_loaded)).toHaveLength(2);
  read.mockClear();
  for await (const _page of search.streamSearch(uid, 'needle', { scope: 'chat', limit: 200, chatSnippetRefs: [] })) { /* metadata only */ }
  expect(read).not.toHaveBeenCalled();
});

// Hydration fills rows the renderer already shows. Scoring runs synchronously on
// main, so a batch that ranks the corpus twice stalls the Agent stream for nothing.
it.each([['a single-term', 'needle'], ['a multi-term', '项目计划']])('ranks %s query once per summary batch, like the first page, while still filling only eligible rows', async (_shape, query) => {
  const chats = await import('../../../../src/main/features/chats');
  const store = await import('../../../../src/main/features/search/chat_store');
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const cid = (await chats.createConversation(uid, { title: `Result ${i}` })).conversation_id;
    ids.push(cid);
    fs.writeFileSync(path.join(root, uid, 'cloud/chats', cid + '.jsonl'), JSON.stringify({ text: query }) + '\n');
    store.replaceConversation(uid, cid, [{ cid, msgIndex: 0, role: 'user', time: '', text: query }], { mtime: 1, size: 1, next: 1 });
  }
  vi.spyOn(await import('../../../../src/main/features/search/chat-snippets'), 'readChatSnippets')
    .mockImplementation(async () => new Map([[0, { snippet: query, visible: true }]]));
  const search = await import('../../../../src/main/features/search');
  const ranking = vi.spyOn(store, 'postingsWithLen');
  for await (const _page of search.streamSearch(uid, query, { scope: 'chat', limit: 200, chatSnippetRefs: [] })) { /* first page */ }
  const firstPage = ranking.mock.calls.length;
  expect(firstPage).toBeGreaterThan(0);
  ranking.mockClear();
  await chats.deleteConversation(uid, ids[2]);
  const pages: any[] = [];
  for await (const page of search.streamSearch(uid, query, { scope: 'chat', limit: 200,
    chatSnippetRefs: [{ cid: ids[0], msg_index: 0 }] })) pages.push(page);
  expect(ranking.mock.calls.length).toBe(firstPage);
  expect(pages.at(-1).pending_kinds).toEqual([]);
  expect(pages.at(-1).failed_kinds).toEqual([]);
  const rows = pages.at(-1).results;
  expect(rows.map((row: any) => row.cid).sort()).toEqual(ids.slice(0, 2).sort());
  expect(rows.find((row: any) => row.cid === ids[0])).toMatchObject({ snippet: query, snippet_loaded: true });
  expect(rows.find((row: any) => row.cid === ids[1]).snippet_loaded).toBeUndefined();
});

it('publishes usable modules and enriched chats independently of slow automation and Library retrieval', async () => {
  const chats = await import('../../../../src/main/features/chats');
  const conv = await chats.createConversation(uid, { title: 'GitHub marker chat' });
  const cid = conv.conversation_id;
  fs.writeFileSync(path.join(root, uid, 'cloud/chats', cid + '.jsonl'), JSON.stringify({ id: 'message', text: 'GitHub marker body' }) + '\n');
  (await import('../../../../src/main/features/search/chat_store')).replaceConversation(uid, cid,
    [{ cid, msgIndex: 0, role: 'user', time: '', text: 'GitHub marker body' }], { mtime: 1, size: 1, next: 1 });
  const automation = gate(), library = gate(), snippet = gate();
  vi.spyOn(await import('../../../../src/main/features/auto_tasks'), 'listTaskSearchRows').mockImplementation(async () => {
    await automation.promise; return [];
  });
  vi.spyOn(await import('../../../../src/main/features/search/chat-snippets'), 'readChatSnippets').mockImplementation(async () => {
    await snippet.promise; return new Map([[0, { snippet: 'GitHub marker body', msg_id: 'message', visible: true }]]);
  });
  const search = await import('../../../../src/main/features/search');
  search.__searchTestHooks.setLibraryContentSearchProvider({ hasSources: async () => true,
    embedQuery: async () => { await library.promise; return [1]; },
    searchGlobal: () => [{ rel_path: 'held-doc.md', chunk_idx: 0, content: 'GitHub held body', score: .9 }],
    listProjects: async () => [], searchProject: () => [] });
  const pages: any[] = [];
  const read = (async () => { for await (const page of search.streamSearch(uid, 'GitHub', { limit: 200 })) pages.push(page); })();
  try {
    await vi.waitFor(() => expect(pages.some(page => page.results.some((row: any) => row.kind === 'connector'))).toBe(true));
    await vi.waitFor(() => expect(pages.some(page => page.results.some((row: any) => row.cid === cid))).toBe(true));
    expect(pages.at(-1).pending_kinds).toContain('automation');
    snippet.release();
    await vi.waitFor(() => expect(pages.some(page => page.results.some((row: any) => row.msg_id === 'message'))).toBe(true));
    expect(pages.at(-1).pending_kinds).toContain('context');
    // Deletion while other modules are still pending must win at every later publication.
    await chats.deleteConversation(uid, cid);
  } finally { snippet.release(); automation.release(); library.release(); }
  await read;
  expect(pages.at(-1).pending_kinds).toEqual([]);
  const terminal = pages.filter(page => !page.pending_kinds.length);
  expect(terminal).toHaveLength(1);
  expect(terminal[0].results).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'context', path: 'held-doc.md' })]));
  expect(pages.at(-1).results.some((row: any) => row.cid === cid)).toBe(false);
  expect(pages.every(page => page.results.length <= 200)).toBe(true);
  expect(pages.length).toBeLessThanOrEqual(10);
});

it('keeps healthy results after one module fails without publishing its private error', async () => {
  vi.spyOn(await import('../../../../src/main/features/auto_tasks'), 'listTaskSearchRows')
    .mockRejectedValue(new Error('private backend detail'));
  const search = await import('../../../../src/main/features/search');
  search.__searchTestHooks.setLibraryContentSearchProvider({ hasSources: async () => false,
    embedQuery: async () => [1], searchGlobal: () => [], listProjects: async () => [], searchProject: () => [] });
  const pages: any[] = [];
  for await (const page of search.streamSearch(uid, 'GitHub')) pages.push(page);
  expect(pages.at(-1).failed_kinds).toEqual(['automation']);
  expect(pages.at(-1).results.some((row: any) => row.kind === 'connector')).toBe(true);
  expect(JSON.stringify(pages)).not.toContain('private backend');
  for await (const _page of search.streamSearch(uid, 'GitHub')) { /* same failing source during the reporting window */ }
  expect(diagnostics.warn.mock.calls.filter(([message]) => message === 'progressive search module unavailable')).toHaveLength(1);
  expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('private backend');
});

it('cancels promptly while a module is blocked and does not start deferred source work', async () => {
  const held = gate();
  vi.spyOn(await import('../../../../src/main/features/auto_tasks'), 'listTaskSearchRows').mockImplementation(async () => {
    await held.promise; return [];
  });
  const search = await import('../../../../src/main/features/search');
  const embedQuery = vi.fn(async () => [1]);
  search.__searchTestHooks.setLibraryContentSearchProvider({ hasSources: async () => true,
    embedQuery, searchGlobal: () => [], listProjects: async () => [], searchProject: () => [] });
  const controller = new AbortController();
  const iterator = search.streamSearch(uid, 'GitHub', {}, controller.signal);
  try {
    await iterator.next(); controller.abort();
    expect((await iterator.next()).done).toBe(true);
    expect(embedQuery).not.toHaveBeenCalled();
  } finally { controller.abort(); held.release(); await iterator.return(); }
});

describe('cancelled Library body search', () => {
  const projects = Array.from({ length: 50 }, (_, index) => ({ project_id: `p${index}`, name: `Project ${index}` }));

  it('searches no index after the query embedding returns to a cancelled stream', async () => {
    const search = await import('../../../../src/main/features/search');
    const embedding = gate();
    const embedQuery = vi.fn(async () => { await embedding.promise; return [1]; });
    const searchGlobal = vi.fn(() => []), listProjects = vi.fn(async () => projects), searchProject = vi.fn(() => []);
    search.__searchTestHooks.setLibraryContentSearchProvider({ hasSources: async () => true, embedQuery, searchGlobal, listProjects, searchProject });
    const controller = new AbortController();
    const stream = (async () => {
      for await (const _page of search.streamSearch(uid, 'GitHub', { scope: 'context' }, controller.signal)) { /* metadata page */ }
    })();
    try {
      await vi.waitFor(() => expect(embedQuery).toHaveBeenCalledOnce(), { timeout: 5000 });
      controller.abort();
    } finally { embedding.release(); }
    await stream;
    await new Promise(resolve => setImmediate(resolve));
    expect(searchGlobal).not.toHaveBeenCalled();
    expect(listProjects).not.toHaveBeenCalled();
    expect(searchProject).not.toHaveBeenCalled();
  });

  it('starts no embedding when the search was cancelled during its source check', async () => {
    const search = await import('../../../../src/main/features/search');
    const controller = new AbortController();
    const embedQuery = vi.fn(async () => [1]);
    search.__searchTestHooks.setLibraryContentSearchProvider({
      hasSources: async () => { controller.abort(); return true; },
      embedQuery, searchGlobal: () => [], listProjects: async () => projects, searchProject: () => [],
    });
    await expect(search.searchLibraryContents(uid, 'GitHub', { signal: controller.signal })).resolves.toEqual([]);
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('stops between projects and reports no degradation for a user cancellation', async () => {
    const search = await import('../../../../src/main/features/search');
    const controller = new AbortController();
    const onDegraded = vi.fn();
    const searchProject = vi.fn(() => { controller.abort(); return []; });
    search.__searchTestHooks.setLibraryContentSearchProvider({ hasSources: async () => true, embedQuery: async () => [1],
      searchGlobal: () => [], listProjects: async () => projects, searchProject });
    await expect(search.searchLibraryContents(uid, 'GitHub', { signal: controller.signal, onDegraded })).resolves.toEqual([]);
    expect(searchProject).toHaveBeenCalledOnce();
    expect(onDegraded).not.toHaveBeenCalled();
  });

  it('lets pending main-process events run between project searches, including a cancel that arrives there', async () => {
    const search = await import('../../../../src/main/features/search');
    const controller = new AbortController();
    const searchProject = vi.fn(() => {
      // Scheduled from inside the synchronous search: it can only run if the loop yields.
      setImmediate(() => controller.abort());
      return [];
    });
    search.__searchTestHooks.setLibraryContentSearchProvider({ hasSources: async () => true, embedQuery: async () => [1],
      searchGlobal: () => [], listProjects: async () => projects, searchProject });
    await search.searchLibraryContents(uid, 'GitHub', { signal: controller.signal });
    expect(searchProject).toHaveBeenCalledOnce();
  });

  it('still returns every project match when nothing cancels', async () => {
    const search = await import('../../../../src/main/features/search');
    const searchProject = vi.fn((_uid: string, projectId: string) => [{ rel_path: `${projectId}.md`, chunk_idx: 0, content: 'GitHub body', score: .9 }]);
    search.__searchTestHooks.setLibraryContentSearchProvider({ hasSources: async () => true, embedQuery: async () => [1],
      searchGlobal: () => [], listProjects: async () => projects, searchProject });
    const rows = await search.searchLibraryContents(uid, 'GitHub', { signal: new AbortController().signal, limit: 200 });
    expect(searchProject).toHaveBeenCalledTimes(50);
    expect(rows.map(row => row.project_id).sort()).toEqual(projects.map(project => project.project_id).sort());
  });
});

it('attributes slow progressive enrichment without query text and rate-limits repeated diagnostics', async () => {
  const search = await import('../../../../src/main/features/search');
  let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  search.__searchTestHooks.setLibraryContentSearchProvider({ hasSources: async () => true,
    embedQuery: async () => { clock += 700; return [1]; }, searchGlobal: () => [],
    listProjects: async () => [], searchProject: () => [] });
  await search.searchAll(uid, 'warm', { includeLibraryContent: false, includeChatSnippets: false });
  for (let query = 0; query < 2; query++) {
    for await (const _page of search.streamSearch(uid, 'private-query-marker')) { /* consume real module settlement */ }
  }
  const slow = diagnostics.info.mock.calls.filter(([message, data]) => message === 'slow global search' && data.mode === 'progressive');
  expect(slow).toHaveLength(1);
  expect(slow[0][1]).toMatchObject({ scope: 'all', library_body_ms: 700 });
  expect(JSON.stringify(slow)).not.toContain('private-query-marker');
  expect(JSON.stringify(slow)).not.toContain(uid);
});
