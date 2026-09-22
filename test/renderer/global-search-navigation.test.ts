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

function loadingHarness() {
  const body = { innerHTML: '', classList: { add: vi.fn(), remove: vi.fn() },
    querySelectorAll: () => [], querySelector: () => null };
  const input = { value: '', focus: vi.fn() };
  const overlay = { style: { display: '' } };
  const requests: Array<{ resolve: (data: any) => void; reject: (error: Error) => void }> = [];
  const locale = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
  const context: any = {
    setTimeout, clearTimeout, window: {},
    document: {
      addEventListener: vi.fn(), querySelectorAll: () => [],
      getElementById: (id: string) => ({ 'search-body': body, 'search-input': input,
        'search-overlay': overlay }[id] || null),
    },
    escapeHtml: (s: string) => s, t: (key: string) => locale[key], formatTime: () => '',
    localStorage: { getItem: () => null, setItem: vi.fn() },
    apiFetch: (url: string) => url.endsWith('/status')
      ? Promise.resolve({ json: async () => ({ ok: true, chat_index_complete: true }) })
      : new Promise((resolve, reject) => requests.push({
        resolve: data => resolve({ json: async () => data }), reject,
      })),
  };
  vm.createContext(context);
  vm.runInContext(searchSource, context);
  return { body, input, overlay, requests, context };
}

describe('global search conversation navigation', () => {
  // Visible wait feedback must survive reordering; no stale hit may become
  // actionable while the next input is still waiting for its debounce.
  it('keeps loading for the latest input through stale replies, tabs, clearing and reopening', async () => {
    vi.useFakeTimers();
    try {
      const { body, input, overlay, requests, context } = loadingHarness();
      const old = context._runSearchNow('old');
      expect(body.innerHTML).toContain('加载中…');
      context._scheduleSearch('next');
      requests[0].resolve({ ok: true, results: [{ kind: 'chat', conv_title: 'stale hit' }] });
      await old;
      expect(body.innerHTML).toContain('加载中…');
      expect(body.innerHTML).not.toContain('stale hit');
      context._setSearchTab('chat');
      expect(body.innerHTML).toContain('加载中…');
      await vi.advanceTimersByTimeAsync(300);
      expect(requests).toHaveLength(2);
      context._scheduleSearch('');
      expect(body.innerHTML).not.toContain('search-loading');
      requests[1].reject(new Error('obsolete failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(body.innerHTML).not.toContain('obsolete failure');
      expect(body.innerHTML).not.toContain('search-loading');

      input.value = 'closing';
      context._scheduleSearch(input.value);
      context.closeGlobalSearch();
      expect(overlay.style.display).toBe('none');
      context.openGlobalSearch();
      await vi.advanceTimersByTimeAsync(300);
      expect(requests).toHaveLength(2);
      expect(body.innerHTML).not.toContain('search-loading');
    } finally { vi.useRealTimers(); }
  });

  it.each(['results', 'empty', 'rejected', 'network'])('replaces loading with the current %s outcome and permits retry', async outcome => {
    const { body, requests, context } = loadingHarness();
    const pending = context._runSearchNow('marker');
    expect(body.innerHTML).toContain('role="status"');
    expect(body.innerHTML).toContain('加载中…');
    expect(body.innerHTML).not.toContain('search-result');
    if (outcome === 'network') requests[0].reject(new Error('offline'));
    else requests[0].resolve(outcome === 'rejected' ? { ok: false, error: 'unavailable' }
      : { ok: true, results: outcome === 'empty' ? [] : [{ kind: 'chat', conv_title: 'matching conversation' }] });
    await pending;
    expect(body.innerHTML).not.toContain('search-loading');
    if (outcome === 'results') expect(body.innerHTML).toContain('matching conversation');
    else if (outcome === 'empty') expect(body.innerHTML).toContain('未找到');
    else expect(body.innerHTML).toContain('搜索失败');
    const retry = context._runSearchNow('retry');
    expect(body.innerHTML).toContain('加载中…');
    requests[1].resolve({ ok: true, results: [{ kind: 'chat', conv_title: 'retry hit' }] });
    await retry;
    expect(body.innerHTML).toContain('retry hit');
    expect(body.innerHTML).not.toContain('search-loading');
  });

  it('paints the localized preparation notice before results settle and rejects late status after a ready result', async () => {
    const body = { innerHTML: '', classList: { remove: vi.fn() }, querySelectorAll: () => [] };
    const locale = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
    let resolveStatus!: (value: any) => void;
    let resolveResults!: (value: any) => void;
    const context: any = {
      _searchResults: [], _searchVisibleResults: [], _searchActiveIdx: -1,
      _searchLoading: false, _searchTab: 'all', _searchChatIndexComplete: true, _searchSeq: 0, _searchLastQuery: '',
      _searchTimer: null,
      _SEARCH_FETCH_LIMIT: 200,
      document: { getElementById: () => body }, escapeHtml: (s: string) => s,
      t: (key: string) => locale[key], _activeProjectIdForSearch: () => '',
      _setSearchTabsVisible: vi.fn(), _trackGlobalSearchResult: vi.fn(),
      _renderSearchError: vi.fn(), _reportGlobalSearchFailure: vi.fn(),
      _partitionSearchResults: (rows: any[]) => ({ chats: rows, agents: [], skills: [], contexts: [] }),
      _sectionRows: (s: any) => s.bucket, _renderSearchRow: () => '<div class="search-result">existing hit</div>',
      apiFetch: (url: string) => new Promise(resolve => {
        if (url.endsWith('/status')) resolveStatus = data => resolve({ json: async () => data });
        else resolveResults = data => resolve({ json: async () => data });
      }),
    };
    vm.createContext(context);
    for (const name of ['_refreshSearchIndexStatus', '_showSearchLoading', '_runSearchNow', '_renderSearchResults']) {
      vm.runInContext(extractFunction(searchSource, name), context);
    }
    const pending = context._runSearchNow('marker');
    expect(body.innerHTML).toContain('search-loading');
    expect(body.innerHTML).toContain(locale['common.loading']);
    resolveStatus({ ok: true, chat_index_complete: false });
    await new Promise(resolve => setImmediate(resolve));
    const copy = '正在准备中，结果暂不完整，请稍后重试。';
    expect(body.innerHTML).toContain(copy);
    expect(body.innerHTML).toContain('search-loading');
    expect(body.innerHTML).not.toContain(locale['search.no_results']);
    resolveResults({ ok: true, chat_index_complete: false, results: [{ kind: 'chat' }] });
    await pending;
    expect(body.innerHTML).toContain(copy);
    expect(body.innerHTML).toContain('existing hit');
    expect(body.innerHTML).not.toContain('search-loading');

    const ready = context._runSearchNow('marker');
    resolveResults({ ok: true, chat_index_complete: true, results: [{ kind: 'chat' }] });
    await ready;
    resolveStatus({ ok: true, chat_index_complete: false });
    await new Promise(resolve => setImmediate(resolve));
    expect(body.innerHTML).not.toContain(copy);
    expect(body.innerHTML).toContain('existing hit');
    expect(context._renderSearchError).not.toHaveBeenCalled();
  });

  it('ignores preparation status from a closed or superseded search session', async () => {
    let reply!: (value: any) => void;
    const context: any = {
      _searchSeq: 1, _searchChatIndexComplete: true,
      apiFetch: () => new Promise(resolve => { reply = data => resolve({ json: async () => data }); }),
      _renderSearchEmptyState: vi.fn(), _renderSearchResults: vi.fn(),
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_refreshSearchIndexStatus'), context);
    const pending = context._refreshSearchIndexStatus(1, '', { active: true });
    context._searchSeq++;
    reply({ ok: true, chat_index_complete: false });
    await pending;
    expect(context._searchChatIndexComplete).toBe(true);
    expect(context._renderSearchEmptyState).not.toHaveBeenCalled();
    expect(context._renderSearchResults).not.toHaveBeenCalled();
  });

  it('shows incomplete-history status for empty and partial results, clears it after migration, and scopes it to chats', () => {
    const body = { innerHTML: '', classList: { remove: vi.fn() }, querySelectorAll: () => [] };
    const context: any = {
      _searchResults: [], _searchVisibleResults: [], _searchActiveIdx: -1,
      _searchLoading: false, _searchTab: 'all', _searchChatIndexComplete: false,
      document: { getElementById: () => body },
      escapeHtml: (s: string) => s, t: (key: string) => key,
      _partitionSearchResults: (rows: any[]) => ({ chats: rows, agents: [], skills: [], contexts: [] }),
      _sectionRows: (s: any) => s.bucket,
      _renderSearchRow: () => '<div class="search-result">match</div>',
      Math,
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_renderSearchResults'), context);
    context._renderSearchResults('query');
    expect(body.innerHTML).toContain('role="status"');
    expect(body.innerHTML).toContain('search.history_indexing');
    expect(body.innerHTML).not.toContain('search.no_results');

    context._searchResults = [{ kind: 'chat' }];
    context._renderSearchResults('query');
    expect(body.innerHTML).toContain('search.history_indexing');
    expect(body.innerHTML).toContain('search-result');
    expect(context._searchVisibleResults).toHaveLength(1);

    context._searchTab = 'context';
    context._renderSearchResults('query');
    expect(body.innerHTML).not.toContain('search.history_indexing');
    expect(body.innerHTML).toContain('search.no_results');

    context._searchTab = 'chat';
    context._searchChatIndexComplete = true;
    context._renderSearchResults('query');
    expect(body.innerHTML).not.toContain('search.history_indexing');
    expect(body.innerHTML).toContain('search-result');
  });

  it('tracks the bounded entry that opened global search', () => {
    const events: Array<{ action: string; data: Record<string, unknown> }> = [];
    const input: any = { value: 'old query', focus: vi.fn() };
    const overlay: any = { style: { display: 'none' } };
    const context: any = {
      _searchResults: [{ kind: 'chat' }],
      _searchActiveIdx: 2,
      _searchLastQuery: 'old query',
      _searchSeq: 0,
      document: {
        getElementById: (id: string) => (id === 'search-overlay' ? overlay : (id === 'search-input' ? input : null)),
      },
      _setSearchTab: vi.fn(),
      _setSearchTabsVisible: vi.fn(),
      _renderSearchEmptyState: vi.fn(),
      _showSearchLoading: vi.fn(),
      _refreshSearchIndexStatus: vi.fn(),
      setTimeout: (fn: () => void) => { fn(); return 1; },
      window: { Monitor: true },
      Monitor: {
        click: (action: string, data: Record<string, unknown>) => events.push({ action, data }),
      },
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, 'openGlobalSearch'), context);

    context.openGlobalSearch('sidebar');

    expect(overlay.style.display).toBe('');
    expect(input.value).toBe('');
    expect(input.focus).toHaveBeenCalledOnce();
  });

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

  // The chat section of the "all" tab holds ten rows. Choosing them by recency
  // means the best match is displaced by whatever the user happened to discuss
  // most recently, which is how a search that did find the right message still
  // shows nothing useful. Pick by relevance, then read newest-first.
  it('picks chat rows by relevance and shows the ones it kept newest-first', () => {
    const context: any = { Array, String, Number, _SEARCH_ALL_PER_SECTION: 2 };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_partitionSearchResults'), context);
    vm.runInContext(extractFunction(searchSource, '_sectionRows'), context);

    const { chats } = context._partitionSearchResults([
      { kind: 'chat', cid: 'recent-partial', score: 9, term_coverage: 1, time: '2026-03-01T00:00:00Z' },
      { kind: 'chat', cid: 'older-full', score: 2, term_coverage: 2, time: '2026-01-01T00:00:00Z' },
      { kind: 'chat', cid: 'newest-full', score: 1, term_coverage: 2, time: '2026-02-01T00:00:00Z' },
    ]);

    // Relevance decides who survives the cut...
    expect(Array.from(chats, (row: any) => row.cid))
      .toEqual(['older-full', 'newest-full', 'recent-partial']);
    // ...and the rows that survived are read in time order.
    const shown = context._sectionRows({ tab: 'chat', bucket: chats }, 'all');
    expect(Array.from(shown, (row: any) => row.cid)).toEqual(['newest-full', 'older-full']);
  });

  it('keeps a non-chat section in its ranked order', () => {
    const context: any = { Array, String, Number, _SEARCH_ALL_PER_SECTION: 2 };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_sectionRows'), context);

    const bucket = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
    expect(Array.from(
      context._sectionRows({ tab: 'context', bucket }, 'all'),
      (row: any) => row.path,
    )).toEqual(['a', 'b']);
    expect(Array.from(
      context._sectionRows({ tab: 'context', bucket }, 'context'),
      (row: any) => row.path,
    )).toEqual(['a', 'b', 'c']);
  });

  it('opens a global Library body hit after leaving a selected project Library', async () => {
    const setView = vi.fn();
    const loadRendererFeature = vi.fn(async () => {});
    const loadContexts = vi.fn(async () => {});
    let selectedProject = 'project-a';
    const switchCtxProject = vi.fn(async (projectId: string) => { selectedProject = projectId; return true; });
    const openCtxFile = vi.fn(() => { expect(selectedProject).toBe(''); });
    const context: any = {
      _SEARCH_KIND_META: { context: {} },
      _searchActiveIdx: 0,
      closeGlobalSearch: vi.fn(),
      setView,
      loadRendererFeature,
      loadContexts,
      switchCtxProject,
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
    const trackResult = vi.fn();
    const context: any = {
      Date,
      _searchTimer: null,
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
      _showSearchLoading: vi.fn(),
      _refreshSearchIndexStatus: vi.fn(),
      _renderSearchResults: (query: string) => { rendered.push(`results:${query}`); },
      _renderSearchError: (message: string) => { rendered.push(`error:${message}`); },
      _trackGlobalSearchResult: trackResult,
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
    expect(trackResult).toHaveBeenCalledWith('cancelled', 'superseded', expect.any(Number), {
      has_project: false,
    });
  });

  it('invalidates an in-flight query when the search overlay closes', async () => {
    let rejectFetch!: (reason: Error) => void;
    const reportFailure = vi.fn();
    const trackResult = vi.fn();
    const renderError = vi.fn();
    const overlay: any = { style: { display: '' } };
    const input: any = { value: 'private query' };
    const context: any = {
      _searchTimer: null,
      _SEARCH_FETCH_LIMIT: 200,
      _searchSeq: 0,
      document: {
        getElementById: (id: string) => (id === 'search-overlay' ? overlay : (id === 'search-input' ? input : null)),
      },
      _saveSearchHistoryEntry: vi.fn(),
      _activeProjectIdForSearch: () => '',
      _setSearchTabsVisible: vi.fn(),
      _renderSearchEmptyState: vi.fn(),
      _showSearchLoading: vi.fn(),
      _refreshSearchIndexStatus: vi.fn(),
      _renderSearchResults: vi.fn(),
      _renderSearchError: renderError,
      _reportGlobalSearchFailure: reportFailure,
      _trackGlobalSearchResult: trackResult,
      apiFetch: () => new Promise((_resolve, reject) => { rejectFetch = reject; }),
      clearTimeout,
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(searchSource, 'closeGlobalSearch'),
      extractFunction(searchSource, '_runSearchNow'),
    ].join('\n'), context);

    const pending = context._runSearchNow('private query');
    await Promise.resolve();
    context.closeGlobalSearch();
    rejectFetch(new Error('late failure with private query'));
    await pending;

    expect(overlay.style.display).toBe('none');
    expect(context._searchSeq).toBe(2);
    expect(reportFailure).not.toHaveBeenCalled();
    expect(renderError).not.toHaveBeenCalled();
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
      'readJsonlWindow<MessageRecord>(sourceFile, pageStart, Number.MAX_SAFE_INTEGER)',
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
    expect(context._historyRequestUrl('c1', null, 10, 23, 'm23')).toBe(
      '/api/conversations/c1/history?limit=10&around_index=23&around_message_id=m23&project_id=p1',
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
