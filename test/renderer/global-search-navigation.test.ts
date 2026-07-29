import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const searchSource = fs.readFileSync(path.join(root, 'src/renderer/modules/search.js'), 'utf8');
const bootSource = fs.readFileSync(path.join(root, 'src/renderer/modules/boot.js'), 'utf8');
const conversationSource = fs.readFileSync(path.join(root, 'src/renderer/modules/conversation.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8');
const chatsSource = fs.readFileSync(path.join(root, 'src/main/features/chats.ts'), 'utf8');

function extractFunction(source: string, name: string): string {
  const asyncMarker = `async function ${name}`;
  const syncMarker = `function ${name}`;
  const start = source.indexOf(asyncMarker) >= 0
    ? source.indexOf(asyncMarker)
    : source.indexOf(syncMarker);
  if (start < 0) throw new Error(`missing ${name}`);
  const signatureEnd = source.indexOf(') {', start);
  const braceStart = signatureEnd >= 0 ? signatureEnd + 2 : -1;
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

describe('global search conversation navigation', () => {
  it('derives Library scope from the active project page or project conversation', () => {
    const context: any = {
      currentView: 'project',
      _projectDetailPid: 'project-a',
      currentCid: '',
      conversations: [],
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_activeProjectIdForSearch'), context);

    expect(context._activeProjectIdForSearch()).toBe('project-a');

    context.currentView = 'conversation';
    context.currentCid = 'conversation-b';
    context.conversations = [
      { conversation_id: 'conversation-a' },
      { conversation_id: 'conversation-b', project_id: 'project-b' },
    ];
    expect(context._activeProjectIdForSearch()).toBe('project-b');

    context.currentView = 'contexts';
    expect(context._activeProjectIdForSearch()).toBe('');
  });

  it('keeps Library body results in relevance order before path tie-breakers', () => {
    const context: any = { Array, String };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_partitionSearchResults'), context);

    const partitioned = context._partitionSearchResults([
      { kind: 'context', path: 'a/short.md', score: 0.2 },
      { kind: 'context', path: 'deep/nested/high.md', score: 0.9 },
      { kind: 'context', path: 'b/equal.md', score: 0.2 },
    ]);

    expect(Array.from(partitioned.contexts, (row: any) => row.path)).toEqual([
      'deep/nested/high.md',
      'a/short.md',
      'b/equal.md',
    ]);
  });

  it('opens a global Library body hit in the Library viewer', async () => {
    const setView = vi.fn();
    const loadRendererFeature = vi.fn(async () => {});
    const loadContexts = vi.fn(async () => {});
    const openCtxFile = vi.fn();
    const context: any = {
      _SEARCH_KIND_META: { context: {} },
      _searchActiveIdx: 0,
      closeGlobalSearch: vi.fn(),
      setView,
      loadRendererFeature,
      loadContexts,
      openCtxFile,
      window: { loadRendererFeature },
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_gotoSearchResult'), context);

    await context._gotoSearchResult({
      kind: 'context',
      library_scope: 'global',
      path: 'global/source.md',
      title: 'Source',
      match_source: 'content',
    }, 'keyboard');

    expect(setView).toHaveBeenCalledWith('contexts');
    expect(loadRendererFeature).toHaveBeenCalledWith('contexts');
    expect(loadContexts).toHaveBeenCalledOnce();
    expect(openCtxFile).toHaveBeenCalledWith('global/source.md');
  });

  it.each([
    'source.md',
    'report.pdf',
    'notes.docx',
    'scores.xlsx',
    'slides.pptx',
    'image.png',
  ])('opens a project Library body hit in its owning viewer with the %s extension', async (fileName) => {
    const setView = vi.fn();
    const openChatFileViewer = vi.fn();
    const invoke = vi.fn(async () => ({ ok: true, path: `/project/${fileName}` }));
    const context: any = {
      _SEARCH_KIND_META: { context: {} },
      _searchActiveIdx: 0,
      closeGlobalSearch: vi.fn(),
      setView,
      setTimeout: (fn: () => void) => { void fn(); return 1; },
      openChatFileViewer,
      window: { orkas: { invoke } },
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_gotoSearchResult'), context);

    await context._gotoSearchResult({
      kind: 'context',
      library_scope: 'project',
      project_id: 'project-a',
      path: fileName,
      title: 'Source',
      match_source: 'content',
    }, 'mouse');
    await Promise.resolve();

    expect(setView).toHaveBeenCalledWith('project', 'project-a');
    expect(invoke).toHaveBeenCalledWith('projects.files.absPath', {
      projectId: 'project-a',
      name: fileName,
    });
    expect(openChatFileViewer).toHaveBeenCalledWith(
      `/project/${fileName}`,
      fileName,
      { projectId: 'project-a' },
    );
  });

  it('does not open a viewer when a stale project search hit no longer resolves', async () => {
    const openChatFileViewer = vi.fn();
    const context: any = {
      _SEARCH_KIND_META: { context: {} },
      _searchActiveIdx: 0,
      closeGlobalSearch: vi.fn(),
      setView: vi.fn(),
      setTimeout: (fn: () => void) => { void fn(); return 1; },
      openChatFileViewer,
      window: {
        orkas: {
          invoke: vi.fn(async () => ({ ok: false, error: 'not_found' })),
        },
      },
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_gotoSearchResult'), context);

    await context._gotoSearchResult({
      kind: 'context',
      library_scope: 'project',
      project_id: 'project-a',
      path: 'deleted.pdf',
      match_source: 'content',
    });
    await Promise.resolve();

    expect(openChatFileViewer).not.toHaveBeenCalled();
  });

  it('does not let a slow previous query replace the cleared empty state', async () => {
    let resolveFetch!: (value: unknown) => void;
    const rendered: string[] = [];
    const context: any = {
      _SEARCH_FETCH_LIMIT: 200,
      _searchSeq: 0,
      _searchResults: [],
      _searchVisibleResults: [{ kind: 'chat', cid: 'stale' }],
      _searchActiveIdx: 0,
      _searchLastQuery: 'old',
      document: {
        getElementById: (id: string) => (id === 'search-input' ? { value: '' } : null),
      },
      _activeProjectIdForSearch: () => '',
      _setSearchTabsVisible: () => {},
      _renderSearchEmptyState: () => { rendered.push('empty'); },
      _renderSearchResults: (query: string) => { rendered.push(`results:${query}`); },
      _renderSearchError: (message: string) => { rendered.push(`error:${message}`); },
      apiFetch: () => new Promise((resolve) => { resolveFetch = resolve; }),
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_runSearchNow'), context);

    const oldQuery = context._runSearchNow('old');
    await Promise.resolve();
    await context._runSearchNow('');
    resolveFetch({
      json: async () => ({
        ok: true,
        results: [{ kind: 'chat', cid: 'stale' }],
      }),
    });
    await oldQuery;

    expect(rendered).toEqual(['empty']);
    expect(Array.from(context._searchResults)).toEqual([]);
    expect(Array.from(context._searchVisibleResults)).toEqual([]);
    expect(context._searchActiveIdx).toBe(-1);
  });

  it('keeps search history isolated between local user accounts', () => {
    const values = new Map<string, string>();
    const context: any = {
      Array,
      JSON,
      String,
      _SEARCH_HISTORY_KEY: 'search_history',
      _SEARCH_HISTORY_MAX: 12,
      currentUserId: 'account-a',
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      },
    };
    vm.createContext(context);
    const storageKey = searchSource.includes('function _searchHistoryStorageKey')
      ? extractFunction(searchSource, '_searchHistoryStorageKey')
      : '';
    vm.runInContext([
      storageKey,
      extractFunction(searchSource, '_loadSearchHistory'),
      extractFunction(searchSource, '_saveSearchHistory'),
      extractFunction(searchSource, '_saveSearchHistoryEntry'),
    ].join('\n'), context);

    context._saveSearchHistoryEntry('alpha-only');
    context.currentUserId = 'account-b';
    expect(Array.from(context._loadSearchHistory())).toEqual([]);
    context._saveSearchHistoryEntry('beta-only');
    context.currentUserId = 'account-a';
    expect(Array.from(context._loadSearchHistory())).toEqual(['alpha-only']);
  });

  it('passes the stable message identity into paged conversation loading', () => {
    expect(searchSource).toContain("msgId: r.msg_id || ''");
    expect(searchSource).toContain('msgIndex: r.msg_index');
    expect(searchSource).toContain('historyTarget: {');
    expect(searchSource).not.toContain('_scrollToMsgIndex');
    expect(bootSource).toContain('{ searchTarget: opts.historyTarget }');
    expect(bootSource).toContain('_revealConversationHistorySearchTarget(cid, opts.historyTarget)');
    expect(ipcSource).toContain('chats.getMessagesPageAtIndex(');
    expect(ipcSource).toContain('history_indexes: page.historyIndexes');
    expect(chatsSource).toContain(
      'readJsonlWindow<MessageRecord>(file, pageStart, Number.MAX_SAFE_INTEGER)',
    );
    const loadStart = conversationSource.indexOf('async function loadConversationHistory');
    const loadBody = conversationSource.slice(loadStart, conversationSource.indexOf('\nfunction _messageRecordHasMountedSidecars', loadStart));
    expect(loadBody).toContain('Array.isArray(data.history_indexes)');
    expect(loadBody).toContain('_history_index: sourceIndex');
    expect(loadBody.indexOf('_revealConversationHistorySearchTarget(cid, opts.searchTarget)')).toBeLessThan(
      loadBody.indexOf('await _evaluateAutoRecipient(cid)'),
    );
  });

  it('keeps normal first paint at 10 rows and requests the target page directly', () => {
    const context: any = {
      Math,
      Number,
      encodeURIComponent,
      HISTORY_PAGE_SIZE: 10,
      _projectIdForConversation: () => 'p1',
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(conversationSource, '_historyRequestUrl'), context);

    expect(context._historyRequestUrl('c1')).toBe(
      '/api/conversations/c1/history?limit=10&project_id=p1',
    );
    expect(context._historyRequestUrl('c1', 120, 100)).toBe(
      '/api/conversations/c1/history?limit=100&before=120&project_id=p1',
    );
    expect(context._historyRequestUrl('c1', null, 10, 23)).toBe(
      '/api/conversations/c1/history?limit=10&around_index=23&project_id=p1',
    );
    expect(conversationSource).not.toContain('HISTORY_SEARCH_PAGE_SIZE');
  });

  it('positions an identity-less legacy target by its global index without catch-up loads', () => {
    const added: string[] = [];
    let olderLoads = 0;
    const container: any = {
      scrollTop: 0,
      clientHeight: 400,
      style: { scrollBehavior: '' },
      getBoundingClientRect: () => ({ top: 0, height: 400 }),
      querySelectorAll: () => [matched],
      querySelector: () => ({ dataset: { state: 'idle', cursor: '100', cid: 'c1' } }),
    };
    const matched = {
      dataset: { msgIndex: '23' },
      classList: {
        contains: () => true,
        add: (name: string) => added.push(name),
        remove: (name: string) => added.push(`removed:${name}`),
      },
      closest: () => container,
      getBoundingClientRect: () => ({ top: 100, height: 50 }),
    };
    const context: any = {
      Array,
      Math,
      Number,
      String,
      HISTORY_AUTO_LOAD_THRESHOLD: 48,
      currentCid: 'c1',
      document: { getElementById: () => container },
      _msTs: () => 0,
      _markProgrammaticStickyScroll: (el: any) => { el._programmatic = true; },
      _isProgrammaticStickyScroll: (el: any) => el._programmatic === true,
      _loadOlderConversationHistory: () => { olderLoads += 1; },
      _historyNextCursor: (value: unknown) => Number(value),
      _setEarlierHistoryLoaderState: () => {},
      requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
      setTimeout: (fn: () => void) => { fn(); return 1; },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(conversationSource, '_findConversationHistorySearchTarget'),
      extractFunction(conversationSource, '_flashConversationHistorySearchTarget'),
      extractFunction(conversationSource, '_revealConversationHistorySearchTarget'),
      extractFunction(conversationSource, '_maybeAutoLoadEarlierHistory'),
    ].join('\n'), context);

    const found = context._revealConversationHistorySearchTarget('c1', {
      msgIndex: 23,
    });
    context._maybeAutoLoadEarlierHistory(container);

    expect(found).toBe(true);
    expect(container.scrollTop).toBe(0);
    expect(container._stickyEnabled).toBe(false);
    expect(olderLoads).toBe(0);
    expect(added).toEqual(['search-flash', 'removed:search-flash']);
    expect(conversationSource).not.toContain("target.scrollIntoView({ block: 'center' })");
  });
});
