import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => logger }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let workspace: string;
let previous: string | undefined;
const uid = 'search-cost-account';
beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-search-cost-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = workspace;
  vi.resetModules(); vi.clearAllMocks();
  (await import('../../../../src/main/features/users')).activateUser(uid);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('interactive search resource cost', () => {
  it('attributes slow retrieval to bounded stages without logging search text or resource identities', async () => {
    const search = await import('../../../../src/main/features/search');
    const store = await import('../../../../src/main/features/search/chat_store');
    const snippets = await import('../../../../src/main/features/search/chat-snippets');
    search.__searchTestHooks.setLibraryContentSearchProvider({
      hasSources: async () => false, embedQuery: async () => [1], searchGlobal: () => [],
      listProjects: async () => [], searchProject: () => [],
    });
    await search.searchAll(uid, 'GitHub');
    const query = 'private-query-marker', cid = 'private-conversation-marker';
    const chatRoot = path.join(workspace, uid, 'cloud', 'chats');
    fs.mkdirSync(chatRoot, { recursive: true });
    fs.writeFileSync(path.join(chatRoot, `${cid}.jsonl`), JSON.stringify({ role: 'user', content: query }) + '\n');
    store.replaceConversation(uid, cid, [{ cid, msgIndex: 0, role: 'user', time: '', text: query }],
      { mtime: 1, size: 1, next: 1 });
    logger.info.mockClear();
    // Initial module/catalog setup can itself exceed the slow threshold on a
    // loaded host; begin a fresh reporting window for the controlled stage.
    let clock = Date.now() + 60_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.spyOn(snippets, 'readChatSnippets').mockImplementation(async () => {
      clock += 700;
      return new Map([[0, { snippet: query, msg_id: 'private-message-marker', visible: true }]]);
    });
    for (let index = 0; index < 2; index++) await search.searchAll(uid, query);
    const diagnostics = () => logger.info.mock.calls.filter(([message]) => message === 'slow global search');
    expect(diagnostics()).toHaveLength(1);
    expect(diagnostics()[0][1]).toMatchObject({ mode: 'complete', scope: 'all', duration_ms: 700, chat_ms: 700 });
    expect(JSON.stringify(diagnostics())).not.toMatch(/private-|search-cost-account/);
    clock += 60_000;
    await search.searchAll(uid, query);
    expect(diagnostics()).toHaveLength(2);
  });

  it('returns ranked chat metadata without source reads and keeps complete snippets for ordinary callers', async () => {
    const search = await import('../../../../src/main/features/search');
    const store = await import('../../../../src/main/features/search/chat_store');
    const snippets = await import('../../../../src/main/features/search/chat-snippets');
    search.__searchTestHooks.setLibraryContentSearchProvider({
      hasSources: async () => false, embedQuery: async () => [1], searchGlobal: () => [],
      listProjects: async () => [], searchProject: () => [],
    });
    await search.searchAll(uid, 'GitHub', { includeLibraryContent: false });
    const chatRoot = path.join(workspace, uid, 'cloud', 'chats');
    fs.mkdirSync(chatRoot, { recursive: true });
    fs.writeFileSync(path.join(chatRoot, 'cold-history.jsonl'), JSON.stringify({ role: 'user', content: 'GitHub cold history marker' }) + '\n');
    store.replaceConversation(uid, 'cold-history', [{ cid: 'cold-history', msgIndex: 17,
      role: 'user', time: '2026-10-29T00:00:00Z', text: 'GitHub cold history marker' }],
    { mtime: 1, size: 1, next: 18 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const read = vi.spyOn(snippets, 'readChatSnippets').mockImplementation(async () => {
      await gate;
      return new Map([[17, { snippet: 'GitHub cold history marker', msg_id: 'cold-message', visible: true }]]);
    });
    let settled = false;
    const preview = search.searchAll(uid, 'GitHub', {
      includeLibraryContent: false, includeChatSnippets: false, limit: 200,
    }).then(page => { settled = true; return page; });
    try {
      await vi.waitFor(() => expect(settled, 'Chat JSONL reads cannot hold up initial matches').toBe(true));
      const page = await preview;
      expect(page.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'chat', cid: 'cold-history', msg_index: 17, snippet: '' }),
        expect.objectContaining({ kind: 'connector', id: 'github' }),
      ]));
      expect(page.chat_snippets_pending).toBe(true);
      expect(page.library_content_pending).toBe(false);
      expect(read).not.toHaveBeenCalled();
    } finally { release(); await preview; }
    const complete = await search.searchAll(uid, 'GitHub', { limit: 200 });
    expect(complete.results).toContainEqual(expect.objectContaining({
      kind: 'chat', cid: 'cold-history', msg_index: 17, msg_id: 'cold-message', snippet: 'GitHub cold history marker',
    }));
    expect(complete.chat_snippets_pending).not.toBe(true);
    expect(read).toHaveBeenCalledOnce();
  });

  it('keeps local hits available when Library source discovery fails', async () => {
    const search = await import('../../../../src/main/features/search');
    search.__searchTestHooks.setLibraryContentSearchProvider({
      hasSources: async () => { throw new Error('controlled Library source failure'); },
      embedQuery: async () => [1], searchGlobal: () => [], listProjects: async () => [], searchProject: () => [],
    });
    const preview = await search.searchAll(uid, 'GitHub', { includeLibraryContent: false });
    expect(preview.results.some(row => row.kind === 'connector' && row.id === 'github')).toBe(true);
    expect(preview.library_content_pending).toBe(true);
    const final = await search.searchAll(uid, 'GitHub');
    expect(final.results.some(row => row.kind === 'connector' && row.id === 'github')).toBe(true);
    expect(final.degradation_code).toBe('library_content_embedding_unavailable');
    expect(logger.warn).toHaveBeenCalledWith('library content query embedding unavailable', expect.any(Object));
  });

  it('hydrates only a bounded ranked window from a large matching chat corpus without losing full-query hits', async () => {
    const store = await import('../../../../src/main/features/search/chat_store');
    const search = await import('../../../../src/main/features/search');
    const paths = await import('../../../../src/main/paths');
    const cid = 'ranked-history';
    const rows = Array.from({ length: 2500 }, (_, index) => ({
      from: 'user', ts: '2026-10-29T00:00:00Z',
      text: index === 2499 ? 'needle target' : 'needle '.repeat(20),
    }));
    const file = path.join(paths.userCloudRoot(uid), 'chats', `${cid}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
    const stat = fs.statSync(file);
    store.replaceConversation(uid, cid, rows.map((row, msgIndex) => ({
      cid, msgIndex, text: row.text, role: 'user', time: row.ts,
    })), { mtime: stat.mtimeMs, size: stat.size, next: rows.length });
    const readDocs = vi.spyOn(store, 'docsByIds');
    const found = await search.searchChats(uid, 'needle target', { limit: 5 });
    expect(found).toHaveLength(5);
    expect(found[0]).toMatchObject({ cid, msg_index: 2499, snippet: 'needle target' });
    expect(readDocs.mock.calls.reduce((total, [, ids]) => total + ids.length, 0),
      'A frequent token must not hydrate every matching message to display five hits').toBeLessThanOrEqual(64);
    expect(await search.searchChats(uid, 'needle target', { limit: 1, includeSnippets: false, userVisibleOnly: true }))
      .toEqual([expect.objectContaining({ cid, msg_index: 2499, snippet: 'needle target' })]);
    const otherCid = 'lower-ranked-history';
    const otherRows = Array.from({ length: 5 }, () => ({ from: 'user', ts: rows[0].ts, text: 'needle ' + 'padding '.repeat(100) }));
    const otherFile = path.join(paths.userCloudRoot(uid), 'chats', `${otherCid}.jsonl`);
    fs.writeFileSync(otherFile, otherRows.map(row => JSON.stringify(row)).join('\n'));
    const otherStat = fs.statSync(otherFile);
    store.replaceConversation(uid, otherCid, otherRows.map((row, msgIndex) => ({
      cid: otherCid, msgIndex, text: row.text, role: 'user', time: row.ts,
    })), { mtime: otherStat.mtimeMs, size: otherStat.size, next: otherRows.length });
    // Eligibility is applied before stopping: excluded high-ranked history
    // must not hide valid hits beyond the first metadata window.
    const scoped = await search.searchChats(uid, 'needle', { excludeCid: cid, limit: 5 });
    expect(scoped).toHaveLength(5);
    expect(scoped.every(row => row.cid === otherCid)).toBe(true);
  });

  it('returns metadata before semantic work and preserves complete retrieval for ordinary callers', async () => {
    const search = await import('../../../../src/main/features/search');
    const embedQuery = vi.fn(async () => [1]);
    search.__searchTestHooks.setLibraryContentSearchProvider({
      embedQuery, searchGlobal: () => [{ rel_path: 'body.md', chunk_idx: 0, content: 'GitHub project body', score: 0.99 }],
      listProjects: async () => [], searchProject: () => [],
    });
    const first = await search.searchAll(uid, 'GitHub', { includeLibraryContent: false, limit: 200 });
    expect(first.results.some(row => row.kind === 'connector' && row.id === 'github')).toBe(true);
    expect(first.library_content_pending).toBe(true);
    expect(embedQuery).not.toHaveBeenCalled();
    const complete = await search.searchAll(uid, 'GitHub', { limit: 200 });
    expect(complete.results.some(row => row.path === 'body.md')).toBe(true);
    expect(embedQuery).toHaveBeenCalledTimes(1);
  });

  it('does not start inference for an account with no global or project vector indexes', async () => {
    const search = await import('../../../../src/main/features/search');
    const embed = await import('../../../../src/main/features/kb_embed');
    const projects = await import('../../../../src/main/features/projects');
    const created = await projects.createProject(uid, 'Empty Library project');
    expect(created.ok).toBe(true);
    let messages = 0;
    let reply: (message: unknown) => void;
    embed._setEmbedChannelFactoryForTest(() => ({
      postMessage: (message: any) => {
        messages++;
        queueMicrotask(() => reply({ id: message.id, ok: true, vectors: [new Array(512).fill(0)] }));
      },
      onMessage: callback => { reply = callback; }, onExit: () => {}, kill: () => {},
    }));
    const result = await search.searchAll(uid, 'GitHub', { limit: 200 });
    expect(result.results.some(row => row.kind === 'connector' && row.id === 'github')).toBe(true);
    expect(messages, 'No searchable vectors means inference cannot contribute a result').toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    const paths = await import('../../../../src/main/paths');
    expect(fs.existsSync(paths.userKbVectorDbPath(uid))).toBe(false);
  });

  it('reuses unchanged task/project data but sees same-size external rewrites and removals on the next query', async () => {
    const search = await import('../../../../src/main/features/search');
    search.__searchTestHooks.setLibraryContentSearchProvider({
      embedQuery: async () => [1], searchGlobal: () => [], listProjects: async () => [], searchProject: () => [],
    });
    const todos = await import('../../../../src/main/features/project_tasks');
    const autos = await import('../../../../src/main/features/auto_tasks');
    const projects = await import('../../../../src/main/features/projects');
    const paths = await import('../../../../src/main/paths');
    const layout = await import('../../../../src/main/util/project-layout');
    const project = await projects.createProject(uid, 'Snapshot project');
    if (!project.ok) throw new Error('Project fixture failed');
    const pid = project.project.project_id;
    const todo = await todos.createTask(uid, pid, { content: 'Snapshot marker alpha', created_by: 'user' });
    const auto = await autos.createTask(uid, {
      title: 'Snapshot marker alpha', content: 'Read-only fixture', enabled: false,
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    if (!todo.ok || !auto.ok) throw new Error('Task fixture failed');
    const files = [paths.projectTaskFile(uid, pid, todo.task.id),
      layout.globalAutoTaskLocation(uid, auto.task.id).configFile, paths.projectMetaFile(uid, pid)];
    await search.searchAll(uid, 'Snapshot marker');
    const reads = vi.spyOn(fsp, 'readFile');
    reads.mockClear();
    const again = await search.searchAll(uid, 'Snapshot');
    expect(again.results.filter(row => row.kind === 'automation' || row.kind === 'todo')).toHaveLength(2);
    expect(reads.mock.calls.filter(([file]) => files.includes(String(file))), 'Unchanged source JSON must not be read on each keystroke').toEqual([]);

    for (const file of files.slice(0, 2)) {
      const st = fs.statSync(file);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('alpha', 'bravo'));
      fs.utimesSync(file, st.atime, st.mtime);
    }
    const renamed = await search.searchAll(uid, 'Snapshot marker bravo');
    expect(renamed.results.filter(row => row.kind === 'automation' || row.kind === 'todo')).toHaveLength(2);
    expect((await search.searchAll(uid, 'Snapshot marker alpha')).results).toEqual([]);
    for (const file of files.slice(0, 2)) fs.rmSync(file);
    expect((await search.searchAll(uid, 'Snapshot marker bravo')).results).toEqual([]);
  });

  it('searches custom metadata without hydrating secrets or retaining tool schemas between keystrokes', async () => {
    const paths = await import('../../../../src/main/paths');
    const file = paths.userConnectorsConfigFile(uid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 2, connections: {
      'custom-cost': { id: 'custom-cost', origin: 'custom', display_name: 'Metadata search marker',
        secrets_enc: 'unavailable-on-this-device', tools_cache: [{ description: 'x'.repeat(500_000) }] },
    } }));
    const search = await import('../../../../src/main/features/search');
    const registry = await import('../../../../src/main/features/connectors/registry');
    const hydrate = vi.spyOn(registry, 'load');
    const first = await search.searchConnectors(uid, 'Metadata search');
    expect(first.map(row => row.id)).toEqual(['custom-cost']);
    const reads = vi.spyOn(fsp, 'readFile');
    const syncReads = vi.spyOn(fs, 'readFileSync');
    reads.mockClear(); syncReads.mockClear();
    expect((await search.searchConnectors(uid, 'search marker')).map(row => row.id)).toEqual(['custom-cost']);
    expect(hydrate, 'Name lookup must not decrypt grants or enter connector authorization lifecycle').not.toHaveBeenCalled();
    expect([...reads.mock.calls, ...syncReads.mock.calls].filter(([source]) => String(source) === file)).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toContain('unavailable-on-this-device');
  });
});

it('retrieves to-dos while automation storage is held and overlaps a bounded number of project reads', async () => {
  const projects = await import('../../../../src/main/features/projects');
  for (let index = 0; index < 9; index++) await projects.createProject(uid, `Project ${index}`);
  const auto = await import('../../../../src/main/features/auto_tasks');
  const todos = await import('../../../../src/main/features/project_tasks');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const automation = vi.spyOn(auto, 'listTaskSearchRows').mockImplementation(async () => { await gate; return []; });
  let active = 0, peak = 0;
  const todo = vi.spyOn(todos, 'listTaskSearchRows').mockImplementation(async (_uid, pid) => {
    active++; peak = Math.max(peak, active);
    await gate; active--;
    return [{ id: 'todo-' + pid, content: 'concurrency marker', status: 'todo' }] as any;
  });
  const search = await import('../../../../src/main/features/search');
  search.__searchTestHooks.setLibraryContentSearchProvider({ hasSources: async () => false,
    embedQuery: async () => [1], searchGlobal: () => [], listProjects: async () => [], searchProject: () => [] });
  const query = search.searchAll(uid, 'concurrency marker', { includeChatSnippets: false, includeLibraryContent: false });
  try {
    await vi.waitFor(() => expect(automation).toHaveBeenCalled());
    await vi.waitFor(() => expect(todo.mock.calls.length).toBeGreaterThan(1));
    expect(peak).toBeLessThanOrEqual(4);
  } finally { release(); }
  const page = await query;
  expect(page.results.filter(row => row.kind === 'todo')).toHaveLength(10);
  expect(new Set(page.results.map(row => row.id)).size).toBe(10);
});
