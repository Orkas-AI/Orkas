import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { MiniDocument, MiniElement, MiniEvent } from './helpers/mini-dom';

const root = path.join(__dirname, '../..');
const searchSource = fs.readFileSync(path.join(root, 'src/renderer/modules/search.js'), 'utf8');
const bootSource = fs.readFileSync(path.join(root, 'src/renderer/modules/boot.js'), 'utf8');
const conversationSource = fs.readFileSync(path.join(root, 'src/renderer/modules/conversation.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8');

describe('resource search navigation', () => {
  it('reveals a connector card without starting its authorization flow', async () => {
    const focusConnectorById = vi.fn(async () => true);
    const loadConnectors = vi.fn(async () => {});
    const setView = vi.fn();
    const context: any = {
      _SEARCH_KIND_META: { connector: {} }, _searchActiveIdx: 0,
      closeGlobalSearch: vi.fn(), setView, loadConnectors,
      window: { focusConnectorById },
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_gotoSearchResult'), context);
    await context._gotoSearchResult({ kind: 'connector', id: 'github' }, 'keyboard');
    expect(setView).toHaveBeenCalledWith('connectors');
    expect(loadConnectors).toHaveBeenCalledOnce();
    expect(focusConnectorById).toHaveBeenCalledWith('github');
  });

  it('keeps a project result distinguishable from global work when its display name is unavailable', () => {
    const context: any = {
      _SEARCH_KIND_META: {}, _searchActiveIdx: -1,
      t: (key: string) => key, escapeHtml: (value: string) => value,
      _highlightSnippet: () => '',
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_renderSearchRow'), context);
    const project = context._renderSearchRow({ kind: 'todo', id: 'target', project_id: 'project', status: 'done' }, 0, '');
    expect(project).toContain('todo.project');
    expect(project).not.toContain('todo.global');
    const global = context._renderSearchRow({ kind: 'todo', id: 'target', project_id: '', status: 'done' }, 0, '');
    expect(global).toContain('todo.global');
  });

  it.each(['automation', 'todo'])('reveals the current %s entry through its owning feature', async (kind) => {
    const loadRendererFeature = vi.fn(async () => {});
    const focusAutoTaskById = vi.fn(async () => true);
    const focusTodo = vi.fn();
    const setView = vi.fn();
    const context: any = {
      _SEARCH_KIND_META: { automation: {}, todo: {} }, _searchActiveIdx: 0,
      closeGlobalSearch: vi.fn(), setView, loadRendererFeature, focusTodo,
      window: { loadRendererFeature, focusAutoTaskById },
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_gotoSearchResult'), context);
    await context._gotoSearchResult({ kind, id: 'target', project_id: 'owning-project' }, 'keyboard');
    if (kind === 'automation') {
      expect(loadRendererFeature).toHaveBeenCalledWith('auto');
      expect(setView).toHaveBeenCalledWith('auto');
      expect(focusAutoTaskById).toHaveBeenCalledWith('target');
    } else {
      expect(loadRendererFeature).toHaveBeenCalledWith('project');
      expect(focusTodo).toHaveBeenCalledWith('owning-project', 'target', { reportMissing: true });
    }
  });
});

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
    apiFetch: async () => ({ json: async () => ({ ok: true, chat_index_complete: true }) }),
  };
  vm.createContext(context);
  vm.runInContext(searchSource, context);
  return { body, input, overlay, context };
}

describe('global search conversation navigation', () => {
  it('loads the Agent detail dependencies before opening a search hit and preserves its return target', async () => {
    const callbacks: Array<() => Promise<void>> = [];
    const target = { view: 'conversation', id: 'previous-conversation' };
    let release!: () => void;
    const loader = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const open = vi.fn();
    const context: any = {
      _searchActiveIdx: 0, _SEARCH_KIND_META: { agent: {} }, window: {},
      _captureAgentDetailReturnTarget: () => target,
      closeGlobalSearch: vi.fn(), loadRendererFeature: loader, openAgentDetail: open,
      setTimeout: (callback: () => Promise<void>) => { callbacks.push(callback); return 1; },
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_gotoSearchResult'), context);
    await context._gotoSearchResult({ kind: 'agent', id: 'matching-agent' });
    const navigation = callbacks[0]();
    expect(loader).toHaveBeenCalledWith('agents');
    expect(open).not.toHaveBeenCalled();
    release();
    await navigation;
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('matching-agent', { returnTarget: target });
  });

  it('ignores preparation status from a closed or superseded search session', async () => {
    let reply!: (value: any) => void;
    const context: any = {
      _searchSeq: 1, _searchChatIndexBuilding: false,
      apiFetch: () => new Promise(resolve => { reply = data => resolve({ json: async () => data }); }),
      _renderSearchEmptyState: vi.fn(), _renderSearchResults: vi.fn(),
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(searchSource, '_refreshSearchIndexStatus'), context);
    const pending = context._refreshSearchIndexStatus(1, '', { active: true });
    context._searchSeq++;
    reply({ ok: true, chat_index_complete: false, chat_index_building: true });
    await pending;
    expect(context._searchChatIndexBuilding).toBe(false);
    expect(context._renderSearchEmptyState).not.toHaveBeenCalled();
    expect(context._renderSearchResults).not.toHaveBeenCalled();
  });

  it('shows incomplete-history status for empty and partial results, clears it after migration, and scopes it to chats', () => {
    const body = { innerHTML: '', classList: { remove: vi.fn() }, querySelectorAll: () => [] };
    const context: any = {
      _searchResults: [], _searchVisibleResults: [], _searchActiveIdx: -1,
      _searchLoading: false, _searchTab: 'all', _searchChatIndexBuilding: true,
      document: { getElementById: () => body },
      escapeHtml: (s: string) => s, t: (key: string) => key,
      _partitionSearchResults: (rows: any[]) => ({ chats: rows, agents: [], skills: [], contexts: [], automations: [], todos: [], connectors: [] }),
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
    context._searchChatIndexBuilding = false;
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
    // Bounded hit windows and complete bidirectional traversal are exercised
    // against real history files in chats.test.ts. Do not require an unbounded
    // target-to-latest read here: that is the retired search contract.
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

// Real markup, selectors and bubbling, for the paints that patch rows in place.
function domHarness() {
  const doc = new MiniDocument();
  doc.body.innerHTML = '<div id="search-overlay"><input id="search-input" /><div id="search-tabs"></div><div id="search-body"></div></div>';
  const locale = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
  const windowListeners = new Map<string, Array<() => void>>();
  const context: any = {
    setTimeout, clearTimeout, document: doc,
    window: {
      addEventListener: (type: string, fn: () => void) => windowListeners.set(type, [...(windowListeners.get(type) || []), fn]),
      removeEventListener: (type: string, fn: () => void) => windowListeners.set(type, (windowListeners.get(type) || []).filter(item => item !== fn)),
    },
    escapeHtml: (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    t: (key: string) => locale[key] ?? key, formatTime: (value: unknown) => String(value ?? ''),
    localStorage: { getItem: () => null, setItem: vi.fn() },
    apiFetch: async () => ({ json: async () => ({ ok: true, chat_index_complete: true }) }),
  };
  vm.createContext(context);
  vm.runInContext(searchSource, context);
  context._bindGlobalSearch();
  const element = (id: string) => doc.getElementById(id)!;
  return { doc, context, windowListeners, body: element('search-body') as any, input: element('search-input') as any, overlay: element('search-overlay') as any };
}

function progressiveHarness<T extends { context: any }>(base?: T) {
  const harness = (base ?? loadingHarness()) as T & ReturnType<typeof loadingHarness>;
  const streams: Array<{ payload: any; emit: (page: any) => void; finish: (page: any) => void; transportError: (text: string) => void;
    resolve: () => void; reject: (error: Error) => void; cancel: ReturnType<typeof vi.fn> }> = [];
  harness.context.window.orkas = { stream: (_channel: string, _payload: unknown, onEvent: (event: any) => void) => {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const cancel = vi.fn(() => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
    streams.push({ payload: _payload, emit: page => onEvent({ type: 'event', event: page }),
      finish: page => { onEvent({ type: 'event', event: page }); resolve(); },
      transportError: text => onEvent({ type: 'error', text }), resolve, reject, cancel });
    return { promise, cancel };
  } };
  return { ...harness, streams };
}

it('hydrates only visible chat rows and requests newly visible rows after scrolling without losing other matches', async () => {
  vi.useFakeTimers();
  try {
    const { body, input, context, streams } = progressiveHarness(domHarness());
    let visibleIndex = 0;
    vi.spyOn(MiniElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: MiniElement) {
      if (this.id === 'search-body') return { top: 0, bottom: 100, left: 0, right: 0, width: 0, height: 100 };
      const top = Number(this.dataset.idx) === visibleIndex ? 0 : 1000;
      return { top, bottom: top + 80, left: 0, right: 0, width: 0, height: 80 };
    });
    input.value = 'needle';
    const pending = context._runSearchNow(input.value);
    expect(streams[0].payload.chatSnippetRefs).toEqual([]);
    const rows = Array.from({ length: 12 }, (_, index) => ({ kind: 'chat', cid: `c${index}`, msg_index: 0, score: 12 - index, conv_title: `Result ${index}` }));
    streams[0].emit({ results: rows, pending_kinds: [], failed_kinds: [] });
    streams[0].resolve(); await pending;
    await vi.advanceTimersByTimeAsync(40);
    expect(streams[1].payload.chatSnippetRefs).toEqual([{ cid: 'c0', msg_index: 0 }]);
    streams[1].emit({ results: rows.map((row, index) => index === 0 ? { ...row, snippet: 'needle first', snippet_loaded: true } : row), pending_kinds: [], failed_kinds: [] });
    streams[1].resolve(); await vi.advanceTimersByTimeAsync(40);
    expect(body.innerHTML).toContain('Result 9');
    expect(body.querySelector('.search-result-snippet').textContent).toBe('needle first');
    visibleIndex = 1; context._scheduleVisibleChatSnippets();
    await vi.advanceTimersByTimeAsync(40);
    expect(streams[2].payload.chatSnippetRefs).toEqual([{ cid: 'c1', msg_index: 0 }]);
    input.value = 'edited'; context._scheduleSearch(input.value);
    expect(streams[2].cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(streams).toHaveLength(3);
  } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});

it('paints completed modules while chats are held and retains selection when chat and Library results arrive', async () => {
  const { body, context, streams } = progressiveHarness();
   
  const pending = context._runSearchNow('marker');
  expect(streams).toHaveLength(1);
  const todo = { kind: 'todo', id: 'fast', name: 'Fast marker' };
  streams[0].emit({ results: [todo], pending_kinds: ['chat', 'context'], failed_kinds: [] });
  expect(body.innerHTML).toContain('Fast marker');
  expect(body.innerHTML).toContain('加载中…');
  context._setSearchTab('todo');
  expect(body.innerHTML).not.toContain('加载中…');
  context._setSearchTab('all');
  streams[0].emit({ results: [{ kind: 'chat', cid: 'slow', msg_index: 0, conv_title: 'Slow marker' }, todo], pending_kinds: ['context'], failed_kinds: [] });
  expect(vm.runInContext('_searchVisibleResults[_searchActiveIdx]', context)).toMatchObject({ id: 'fast' });
  streams[0].emit({ results: [todo], pending_kinds: [], failed_kinds: [] });
  streams[0].resolve(); await pending;
  expect(body.innerHTML).not.toContain('Slow marker');
  
});

it('does not claim no results while chats are pending, then shows the match that arrives', async () => {
  const { body, context, streams } = progressiveHarness();
   
  const pending = context._runSearchNow('fresh');
  streams[0].emit({ results: [], pending_kinds: ['chat'], failed_kinds: [] });
  expect(body.innerHTML).toContain('加载中…');
  expect(body.innerHTML).not.toContain('未找到');
  
  streams[0].emit({ results: [{ kind: 'chat', cid: 'sent', msg_index: 1, conv_title: 'Just sent' }], pending_kinds: [], failed_kinds: [] });
  streams[0].resolve(); await pending;
  expect(body.innerHTML).toContain('Just sent');
  expect(body.innerHTML).not.toContain('加载中…');
  
  
});

it('resubmits an unchanged pending query and ignores the cancelled search response', async () => {
  const { body, input, context, streams } = progressiveHarness();
  const navigate = vi.fn(); context._gotoSearchResult = navigate;
  input.value = 'marker';
  context._onSearchKey({ key: 'Enter', preventDefault: vi.fn() });
  streams[0].emit({ results: [{ kind: 'todo', id: 'old', name: 'Old match' }], pending_kinds: ['chat'], failed_kinds: [] });
  context._onSearchKey({ key: 'Enter', preventDefault: vi.fn() });
  expect(streams).toHaveLength(2);
  expect(streams[0].cancel).toHaveBeenCalledOnce();
  streams[1].emit({ results: [{ kind: 'todo', id: 'fresh', name: 'Fresh match' }], pending_kinds: [], failed_kinds: [] });
  streams[0].emit({ results: [{ kind: 'todo', id: 'old', name: 'Old match' }], pending_kinds: [], failed_kinds: [] });
  streams[0].resolve(); streams[1].resolve();
  await Promise.resolve();
  expect(body.innerHTML).toContain('Fresh match');
  expect(body.innerHTML).not.toContain('Old match');
  expect(navigate).not.toHaveBeenCalled();
});

it.each(['input', 'close'])('cancels obsolete module work on %s and ignores late snapshots', async action => {
  const { body, input, context, streams } = progressiveHarness();
  const pending = context._runSearchNow('old');
  streams[0].emit({ results: [{ kind: 'todo', id: 'old', name: 'Old hit' }], pending_kinds: ['chat'], failed_kinds: [] });
  if (action === 'close') context.closeGlobalSearch();
  else { context._scheduleSearch(''); input.value = ''; }
  expect(streams[0].cancel).toHaveBeenCalledOnce();
  const before = body.innerHTML;
  streams[0].emit({ results: [{ kind: 'chat', cid: 'late', conv_title: 'Late old hit' }], pending_kinds: [], failed_kinds: [] });
  await pending;
  expect(body.innerHTML).toBe(before);
});

it('keeps useful module results after a failed branch and reports one partial terminal outcome', async () => {
  const { body, context, streams } = progressiveHarness();
   
  const pending = context._runSearchNow('marker');
  streams[0].emit({ results: [{ kind: 'connector', id: 'healthy', name: 'Healthy marker' }], pending_kinds: [], failed_kinds: ['chat'] });
  streams[0].resolve(); await pending;
  expect(body.innerHTML).toContain('Healthy marker'); expect(body.innerHTML).toContain('搜索失败');
   
});

it('retains usable chat matches after summary failure and reports the failure once', async () => {
  vi.useFakeTimers();
  try {
    const { body, input, context, streams } = progressiveHarness(domHarness());
    const report = vi.fn(); context._reportGlobalSearchFailure = report;
    input.value = 'needle';
    const pending = context._runSearchNow(input.value);
    const rows = [{ kind: 'chat', cid: 'retained', msg_index: 0, conv_title: 'Known match' }];
    streams[0].emit({ results: rows, pending_kinds: ['context'], failed_kinds: [] });
    await vi.advanceTimersByTimeAsync(40);
    streams[1].emit({ results: [], pending_kinds: [], failed_kinds: ['chat'] });
    streams[1].resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(body.innerHTML).toContain('Known match');
    expect(report).toHaveBeenCalledOnce();
    // A later successful module must not erase the summary failure notice.
    streams[0].emit({ results: rows, pending_kinds: [], failed_kinds: [] });
    streams[0].resolve(); await pending;
    expect(body.innerHTML).toContain('Known match');
    expect(body.querySelector('.search-section-label.is-status').textContent).toContain('搜索失败');
    await vi.advanceTimersByTimeAsync(200);
    expect(streams).toHaveLength(2);
    expect(report).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

describe('progressive search submission and outcomes', () => {
  const page = (results: any[], pending: string[] = [], failed: string[] = [], extra: Record<string, unknown> = {}) => ({
    results, pending_kinds: pending, failed_kinds: failed, ...extra,
  });
  const settleEvents = () => new Promise(resolve => setImmediate(resolve));

  it('only submits on Enter, including unchanged results, while preserving IME and empty input', async () => {
    vi.useFakeTimers();
    try {
      const { input, streams, context } = progressiveHarness();
      const navigate = vi.fn(); context._gotoSearchResult = navigate;
      const enter = (extra = {}) => context._onSearchKey({ key: 'Enter', preventDefault: vi.fn(), ...extra });
      input.value = '电商领域'; context._scheduleSearch(input.value);
      await vi.advanceTimersByTimeAsync(1000);
      expect(streams).toHaveLength(0);
      enter({ isComposing: true }); enter({ keyCode: 229 });
      expect(streams).toHaveLength(0);
      enter();
      expect(streams).toHaveLength(1);
      streams[0].finish(page([{ kind: 'chat', cid: 'kept', msg_index: 0, conv_title: 'Match' }]));
      await vi.advanceTimersByTimeAsync(0);
      // The unchanged query must refresh results, never activate the selection.
      enter();
      expect(navigate).not.toHaveBeenCalled();
      expect(streams).toHaveLength(2);
      streams[1].finish(page([]));
      await vi.advanceTimersByTimeAsync(0);
      input.value = '另一查询'; context._scheduleSearch(input.value);
      await vi.advanceTimersByTimeAsync(1000);
      expect(streams).toHaveLength(2);
      enter();
      expect(streams).toHaveLength(3);
      streams[2].finish(page([{ kind: 'chat', cid: 'new', msg_index: 0, conv_title: 'New match' }]));
      await vi.advanceTimersByTimeAsync(0);
      input.value = '  ';
      enter();
      expect(streams).toHaveLength(3);
      expect(vm.runInContext('_searchVisibleResults.length', context)).toBe(0);
      expect(navigate).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('shows chat hits before snippet retrieval, scopes progress to chats, and fills snippets afterwards', async () => {
    const { body, streams, context } = progressiveHarness();
     
    const row = { kind: 'chat', cid: 'cold-history', msg_index: 17, conv_title: 'Cold history' };
    const pending = context._runSearchNow('marker');
    streams[0].emit(page([row], ['chat']));
    expect(body.innerHTML).toContain('Cold history');
    expect(body.innerHTML).toContain('加载中…');
    context._setSearchTab('context');
    expect(body.innerHTML).not.toContain('加载中…');
    context._setSearchTab('chat');
    expect(body.innerHTML).toContain('加载中…');
    
    streams[0].finish(page([{ ...row, msg_id: 'message', snippet: 'Body marker match' }]));
    await pending;
    expect(body.innerHTML).toContain('Cold history');
    expect(body.innerHTML.replace(/<[^>]+>/g, '')).toContain('Body marker match');
    expect(body.innerHTML).not.toContain('加载中…');
    
  });

  it('keeps the selected chat message when snippets add ids and a newer hit changes its row position', async () => {
    const { streams, context } = progressiveHarness();
    const oldest = { kind: 'chat', cid: 'history', msg_index: 0, time: '2026-01-01', conv_title: 'History' };
    const later = { ...oldest, msg_index: 1, time: '2026-01-02' };
    const pending = context._runSearchNow('marker');
    streams[0].emit(page([oldest, later], ['chat']));
    context._onSearchKey({ key: 'ArrowDown', preventDefault: vi.fn() });
    expect(vm.runInContext('_searchVisibleResults[_searchActiveIdx]', context)).toEqual(oldest);
    streams[0].finish(page([
      { ...oldest, msg_id: 'oldest', snippet: 'marker' },
      { ...later, msg_id: 'later', snippet: 'marker' },
      { ...later, msg_index: 2, msg_id: 'newest', time: '2026-01-03', snippet: 'marker' },
    ]));
    await pending;
    expect(vm.runInContext('_searchVisibleResults[_searchActiveIdx]', context)).toMatchObject({ msg_index: 0, msg_id: 'oldest' });
  });

  it('groups all resource kinds in sidebar order and follows that order for keyboard selection', async () => {
    const { body, streams, context } = progressiveHarness();
    const order = ['chat', 'todo', 'automation', 'agent', 'skill', 'connector', 'context'];
    // Deliberately return another order: retrieval ranking must not dictate
    // category placement or make arrow keys select a different row than displayed.
    const rows = order.slice().reverse().map(kind => ({
      kind, id: kind, cid: kind, path: `${kind}.md`,
      name: `Marker ${kind}`, conv_title: 'Marker chat', title: 'Marker context',
    }));
    const pending = context._runSearchNow('Marker');
    streams[0].finish(page(rows));
    await pending;
    expect([...body.innerHTML.matchAll(/class="search-result-title" title="([^"]+)"/g)]
      .map(match => match[1])).toEqual(order.map(kind => `Marker ${kind}`));
    for (const kind of order) {
      expect(vm.runInContext('_searchVisibleResults[_searchActiveIdx]', context)).toMatchObject({ kind });
      context._onSearchKey({ key: 'ArrowDown', preventDefault: vi.fn() });
    }
    context._setSearchTab('todo');
    expect(vm.runInContext('_searchVisibleResults[_searchActiveIdx]', context)).toMatchObject({ kind: 'todo' });
  });

  it.each([
    ['failed module', 'context'], ['transport rejection', 'context'], ['stream error', 'context'],
    ['failed module', 'chat'], ['transport rejection', 'chat'], ['stream error', 'chat'],
  ])('keeps usable local hits on a %s while %s results are pending and permits a fresh query', async (outcome, kind) => {
    const { body, streams, context } = progressiveHarness();
     
    const local = { kind: 'connector', id: 'local', name: 'Local marker' };
    const pending = context._runSearchNow('marker');
    streams[0].emit(page([local], [kind]));
    if (outcome === 'failed module') streams[0].finish(page([local], [], [kind]));
    else if (outcome === 'transport rejection') streams[0].reject(new Error('private raw transport error'));
    else { streams[0].transportError('private raw transport error'); streams[0].resolve(); }
    await pending;
    expect(body.innerHTML).toContain('Local marker');
    expect(body.innerHTML).toContain('搜索失败');
    expect(body.innerHTML).not.toContain('private raw');
    
    
    const retry = context._runSearchNow('retry');
    streams[1].finish(page([{ kind: 'todo', id: 'recovered', name: 'Recovered hit' }]));
    await retry;
    expect(body.innerHTML).toContain('Recovered hit');
    expect(body.innerHTML).not.toContain('搜索失败');
  });

  it.each(['context', 'chat'])('cancels a superseded %s retrieval and ignores its late results after a newer query has completed', async kind => {
    const { body, streams, context } = progressiveHarness();
    const old = context._runSearchNow('old');
    streams[0].emit(page([{ kind: 'todo', id: 'old', name: 'Old preview' }], [kind]));
    expect(body.innerHTML).toContain('Old preview');
    const latest = context._runSearchNow('new');
    expect(streams[0].cancel).toHaveBeenCalledOnce();
    expect(streams).toHaveLength(2);
    streams[1].finish(page([{ kind: 'connector', id: 'latest', name: 'Latest hit' }]));
    await latest;
    const painted = body.innerHTML;
    streams[0].emit(page([{ kind: 'context', path: 'old.md', title: 'Old semantic hit' }]));
    await old;
    expect(body.innerHTML).toBe(painted);
    expect(body.innerHTML).toContain('Latest hit');
    expect(body.innerHTML).not.toContain('Old semantic hit');
    expect(body.innerHTML).not.toContain('Old preview');
  });

  it('shows metadata while semantic results are pending and emits only one completed outcome', async () => {
    const { body, streams, context } = progressiveHarness();
     
    const local = { kind: 'connector', id: 'local', name: 'Local marker' };
    const pending = context._runSearchNow('marker');
    streams[0].emit(page([local], ['context']));
    expect(body.innerHTML).toContain('Local marker');
    expect(body.innerHTML).toContain('role="status"');
    
    streams[0].finish(page([local, { kind: 'context', path: 'body.md', title: 'Semantic marker', snippet: 'body marker' }]));
    await pending;
    expect(body.innerHTML).toContain('Local marker');
    expect(body.innerHTML).toContain('Semantic marker');
    
    
  });

  it.each(['automation', 'todo', 'connector'])('expands %s hits, clears hidden selections, and preserves IME input while browsing', async kind => {
    const { body, streams, context } = progressiveHarness();
    const navigate = vi.fn();
    context._gotoSearchResult = navigate;
    const rows = Array.from({ length: 11 }, (_, index) => ({
      kind, id: `target-${index}`, name: `Result ${index}`, snippet: '', score: 100 - index,
    }));
    const pending = context._runSearchNow('Result');
    streams[0].finish(page([
      ...rows,
      // The same resource id in another category must remain distinguishable.
      { kind: 'chat', cid: 'target-0', conv_title: 'Other category', score: 100 },
    ]));
    await pending;
    expect(body.innerHTML).toContain(`data-goto="${kind}"`);
    expect(body.innerHTML.match(/class="search-result(?: active)?"/g)).toHaveLength(11);
    context._setSearchTab(kind);
    expect(body.innerHTML).not.toContain('Other category');
    expect(body.innerHTML.match(/class="search-result(?: active)?"/g)).toHaveLength(11);
    context._onSearchKey({ key: 'ArrowUp', preventDefault: vi.fn() });
    context._onSearchKey({ key: 'Enter', isComposing: true, preventDefault: vi.fn() });
    context._onSearchKey({ key: 'Enter', keyCode: 229, preventDefault: vi.fn() });
    expect(navigate).not.toHaveBeenCalled();
    expect(vm.runInContext('_searchVisibleResults[_searchActiveIdx]', context)).toEqual(rows[10]);

    context._setSearchTab('skill');
    expect(body.innerHTML).toContain('未找到');
    context._onSearchKey({ key: 'ArrowDown', preventDefault: vi.fn() });
    expect(vm.runInContext('_searchVisibleResults[_searchActiveIdx]', context)).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();
    context._setSearchTab(kind);
    expect(vm.runInContext('_searchVisibleResults[_searchActiveIdx]', context)).toEqual(rows[0]);
  });

  // A draft is not a pending query. Old replies cannot revive cancelled hits.
  it('waits for submission through stale replies, tabs, clearing and reopening', async () => {
    vi.useFakeTimers();
    try {
      const { body, input, overlay, streams, context } = progressiveHarness();
      const old = context._runSearchNow('old');
      expect(body.innerHTML).toContain('加载中…');
      input.value = 'next'; context._scheduleSearch(input.value);
      streams[0].emit(page([{ kind: 'chat', cid: 'stale', conv_title: 'stale hit' }]));
      await old;
      expect(body.innerHTML).not.toContain('加载中…');
      expect(body.innerHTML).not.toContain('stale hit');
      context._setSearchTab('chat');
      expect(body.innerHTML).not.toContain('加载中…');
      await vi.advanceTimersByTimeAsync(300);
      expect(streams).toHaveLength(1);
      context._onSearchKey({ key: 'Enter', preventDefault: vi.fn() });
      expect(streams).toHaveLength(2);
      context._scheduleSearch('');
      expect(body.innerHTML).not.toContain('search-loading');
      streams[1].transportError('obsolete failure');
      await vi.advanceTimersByTimeAsync(0);
      expect(body.innerHTML).not.toContain('obsolete failure');
      expect(body.innerHTML).not.toContain('搜索失败');
      expect(body.innerHTML).not.toContain('search-loading');

      input.value = 'closing';
      context._scheduleSearch(input.value);
      context.closeGlobalSearch();
      expect(overlay.style.display).toBe('none');
      context.openGlobalSearch();
      await vi.advanceTimersByTimeAsync(300);
      expect(streams).toHaveLength(2);
      expect(body.innerHTML).not.toContain('search-loading');
    } finally { vi.useRealTimers(); }
  });

  it.each(['results', 'empty', 'stream error', 'transport rejection'])('replaces loading with the current %s outcome and permits retry', async outcome => {
    const { body, streams, context } = progressiveHarness();
    const pending = context._runSearchNow('marker');
    expect(body.innerHTML).toContain('role="status"');
    expect(body.innerHTML).toContain('加载中…');
    expect(body.innerHTML).not.toContain('search-result');
    if (outcome === 'transport rejection') streams[0].reject(new Error('offline'));
    else if (outcome === 'stream error') { streams[0].transportError('unavailable'); streams[0].resolve(); }
    else streams[0].finish(page(outcome === 'empty' ? [] : [{ kind: 'chat', cid: 'hit', conv_title: 'matching conversation' }]));
    await pending;
    expect(body.innerHTML).not.toContain('search-loading');
    if (outcome === 'results') expect(body.innerHTML).toContain('matching conversation');
    else if (outcome === 'empty') expect(body.innerHTML).toContain('未找到');
    else {
      expect(body.innerHTML).toContain('搜索失败');
      expect(body.innerHTML).not.toContain('offline');
      expect(body.innerHTML).not.toContain('unavailable');
    }
    const retry = context._runSearchNow('retry');
    expect(body.innerHTML).toContain('加载中…');
    streams[1].finish(page([{ kind: 'chat', cid: 'retry', conv_title: 'retry hit' }]));
    await retry;
    expect(body.innerHTML).toContain('retry hit');
    expect(body.innerHTML).not.toContain('search-loading');
  });

  it('paints the localized preparation notice before results settle and rejects late status after a ready result', async () => {
    const { body, streams, context } = progressiveHarness();
    const statuses: Array<(data: unknown) => void> = [];
    context.apiFetch = () => new Promise(resolve => statuses.push(data => resolve({ json: async () => data })));
    const copy = '正在准备中，结果暂不完整，请稍后重试。';
    const hit = { kind: 'chat', cid: 'hit', msg_index: 0, conv_title: 'existing hit' };
    const pending = context._runSearchNow('marker');
    expect(body.innerHTML).toContain('search-loading');
    expect(body.innerHTML).toContain('加载中…');
    statuses[0]({ ok: true, chat_index_complete: false, chat_index_building: true });
    await settleEvents();
    expect(body.innerHTML).toContain(copy);
    expect(body.innerHTML).toContain('search-loading');
    expect(body.innerHTML).not.toContain('未找到');
    streams[0].finish(page([hit], [], [], { chat_index_complete: false, chat_index_building: true }));
    await pending;
    expect(body.innerHTML).toContain(copy);
    expect(body.innerHTML).toContain('existing hit');
    expect(body.innerHTML).not.toContain('search-loading');

    const ready = context._runSearchNow('marker');
    streams[1].finish(page([hit], [], [], { chat_index_complete: true, chat_index_building: false }));
    await ready;
    statuses[1]({ ok: true, chat_index_complete: false, chat_index_building: true });
    await settleEvents();
    expect(body.innerHTML).not.toContain(copy);
    expect(body.innerHTML).toContain('existing hit');
    expect(body.innerHTML).not.toContain('搜索失败');
  });

  // An index that was built once and only waits for its catch-up repair
  // (after a restart, a crash or a sync) is not announced: it lacks at most
  // the newest history, and the notice read as broken search.
  it('stays quiet while an index that was built once only waits for catch-up', async () => {
    const { body, streams, context } = progressiveHarness();
    context.apiFetch = async () => ({ json: async () => ({ ok: true, chat_index_complete: false, chat_index_building: false }) });
    context._loadSearchHistory = () => ['earlier query'];
    const copy = '正在准备中，结果暂不完整，请稍后重试。';
    await context._runSearchNow('');
    await settleEvents();
    expect(body.innerHTML).toContain('earlier query');
    expect(body.innerHTML).not.toContain(copy);

    const pending = context._runSearchNow('absent');
    await settleEvents();
    expect(body.innerHTML).not.toContain(copy);
    streams[0].finish(page([], [], [], { chat_index_complete: false, chat_index_building: false }));
    await pending;
    expect(body.innerHTML).not.toContain(copy);
    expect(body.innerHTML).toContain('未找到');
    expect(vm.runInContext('_searchChatIndexBuilding', context)).toBe(false);
  });

  it('does not let a slow previous query replace the cleared empty state', async () => {
    const { body, streams, context } = progressiveHarness();
     
    const old = context._runSearchNow('old');
    await context._runSearchNow('');
    const emptyState = body.innerHTML;
    streams[0].emit(page([{ kind: 'chat', cid: 'stale', conv_title: 'Stale hit' }]));
    await old;
    expect(body.innerHTML).toBe(emptyState);
    expect(body.innerHTML).not.toContain('Stale hit');
    expect(vm.runInContext('_searchResults.length', context)).toBe(0);
    expect(vm.runInContext('_searchVisibleResults.length', context)).toBe(0);
    expect(vm.runInContext('_searchActiveIdx', context)).toBe(-1);
    
  });

  it('invalidates an in-flight query when the search overlay closes', async () => {
    const { body, input, overlay, streams, context } = progressiveHarness();
    const report = vi.fn(); context._reportGlobalSearchFailure = report;
     
    input.value = 'private query';
    const pending = context._runSearchNow('private query');
    context.closeGlobalSearch();
    expect(streams[0].cancel).toHaveBeenCalledOnce();
    streams[0].transportError('late failure with private query');
    await pending;
    expect(overlay.style.display).toBe('none');
    expect(report).not.toHaveBeenCalled();
    
    
    expect(body.innerHTML).not.toContain('搜索失败');
  });

  
});

describe('result paints under the pointer', () => {
  const rowNodes = (body: any): any[] => body.querySelectorAll('.search-result');
  const chat = (index: number, extra: Record<string, unknown> = {}) => ({ kind: 'chat', cid: `c${index}`, msg_index: index, role: 'user',
    time: `2026-01-0${9 - index}`, conv_title: `Conversation ${index}`, score: 10 - index, ...extra });
  type State = { rows: any[]; pending?: string[]; failed?: string[]; building?: boolean; tab?: string; query?: string };
  const paint = (harness: { context: any }, { rows, pending = [], failed = [], building = false, tab = 'all', query = 'needle' }: State) => {
    harness.context.__state = { rows, pending, failed, building, tab };
    vm.runInContext(`_searchResults = __state.rows; _searchPendingKinds = __state.pending; _searchFailedKinds = __state.failed;
      _searchChatIndexBuilding = __state.building; _searchTab = __state.tab; _searchLoading = false; _searchLastQuery = ${JSON.stringify(query)};`, harness.context);
    harness.context._renderSearchResults(query);
  };
  const press = (row: any, init: Record<string, unknown> = { button: 0 }) => row.dispatchEvent(new MiniEvent('mousedown', init));
  const fire = (harness: { windowListeners: Map<string, Array<() => void>> }, type: string) => {
    for (const listener of harness.windowListeners.get(type) || []) listener();
  };

  it('fills summaries and status on the existing rows, and a click opens the row with its latest fields', async () => {
    const { body, context, streams } = progressiveHarness(domHarness());
    const navigate = vi.fn(); context._gotoSearchResult = navigate;
    const pending = context._runSearchNow('needle');
    streams[0].emit({ results: [chat(0), chat(1)], pending_kinds: ['chat'], failed_kinds: [] });
    const [first, second] = rowNodes(body);
    const spinner = body.querySelector('.search-section-label.is-status');
    expect(spinner.textContent).toContain('加载中…');
    expect(second.querySelector('.search-result-snippet')).toBeNull();
    streams[0].finish({ results: [chat(0), chat(1, { msg_id: 'message-1', snippet: 'a needle body' })], pending_kinds: [], failed_kinds: [] });
    await pending;
    expect(rowNodes(body)[0]).toBe(first);
    expect(rowNodes(body)[1]).toBe(second);
    expect(body.querySelector('.search-section-label.is-status')).toBeNull();
    expect(second.querySelector('.search-result-snippet').innerHTML).toBe('a <mark>needle</mark> body');
    second.click();
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate.mock.calls[0][0]).toMatchObject({ cid: 'c1', msg_id: 'message-1' });
    expect(navigate.mock.calls[0][1]).toBe('mouse');
  });

  // A from-scratch paint of the final state is the independent oracle: any field
  // the in-place path forgets leaves the two renders different.
  const base = [chat(0), chat(1, { snippet: 'needle one' }), chat(2)];
  const resources = [
    { kind: 'context', path: 'a.md', title: 'Doc', library_scope: 'global', score: 1 },
    { kind: 'agent', id: 'agent-a', name: 'Agent', source: 'custom', score: 1 },
    { kind: 'skill', id: 'skill-a', name: 'Skill', source: 'custom', score: 1 },
    { kind: 'connector', id: 'connector-a', name: 'Connector', source: 'custom', score: 1 },
    { kind: 'automation', id: 'at_1', name: 'Automation', enabled: true, project_id: 'p1', project_name: 'Project', score: 1 },
    { kind: 'todo', id: 't_1', name: 'Todo', status: 'todo', project_id: '', score: 1 },
  ];
  const edit = (rows: any[], kind: string, change: Record<string, unknown>) => rows.map(row => row.kind === kind ? { ...row, ...change } : row);
  it.each<[string, State, State]>([
    ['a summary appears', { rows: base }, { rows: base.map((row, index) => index === 0 ? { ...row, snippet: 'needle zero' } : row) }],
    ['a summary changes', { rows: base }, { rows: base.map((row, index) => index === 1 ? { ...row, snippet: 'other needle' } : row) }],
    ['a summary disappears', { rows: base }, { rows: base.map((row, index) => index === 1 ? { ...row, snippet: '' } : row) }],
    ['progress appears', { rows: base }, { rows: base, pending: ['chat'] }],
    ['progress finishes', { rows: base, pending: ['chat'] }, { rows: base }],
    ['a failure appears', { rows: base, pending: ['chat'] }, { rows: base, failed: ['chat'] }],
    ['the preparation notice appears', { rows: base }, { rows: base, building: true, pending: ['context'] }],
    ['the preparation notice clears', { rows: base, building: true, pending: ['context'] }, { rows: base }],
    ['a chat title changes', { rows: base }, { rows: edit(base, 'chat', { conv_title: 'Renamed' }) }],
    ['a chat role changes', { rows: base }, { rows: edit(base, 'chat', { role: 'assistant' }) }],
    ['a chat project name arrives', { rows: base }, { rows: edit(base, 'chat', { project_name: 'Project' }) }],
    ['a Library title changes', { rows: resources }, { rows: edit(resources, 'context', { title: 'Renamed' }) }],
    ['a Library scope changes', { rows: resources }, { rows: edit(resources, 'context', { library_scope: 'project', project_id: 'p1', project_name: 'Project' }) }],
    ['a resource name changes', { rows: resources }, { rows: edit(resources, 'agent', { name: 'Renamed' }) }],
    ['a resource source changes', { rows: resources }, { rows: edit(resources, 'skill', { source: 'marketplace' }) }],
    ['an automation is disabled', { rows: resources }, { rows: edit(resources, 'automation', { enabled: false }) }],
    ['an automation project name changes', { rows: resources }, { rows: edit(resources, 'automation', { project_name: 'Renamed' }) }],
    ['a to-do status changes', { rows: resources }, { rows: edit(resources, 'todo', { status: 'done' }) }],
    ['rows change order', { rows: base }, { rows: base.map((row, index) => ({ ...row, time: `2026-02-0${index + 1}` })) }],
    ['a row appears', { rows: base }, { rows: [...base, chat(3)] }],
    ['a row disappears', { rows: base }, { rows: base.slice(1) }],
    ['the overflow count changes', { rows: Array.from({ length: 11 }, (_, index) => chat(index % 9, { msg_index: index })) },
      { rows: Array.from({ length: 12 }, (_, index) => chat(index % 9, { msg_index: index })) }],
    ['the tab changes', { rows: resources }, { rows: resources, tab: 'todo' }],
    ['the query changes', { rows: base }, { rows: base, query: 'one' }],
  ])('paints what a fresh render shows when %s', (_change, before, after) => {
    const patched = domHarness();
    paint(patched, before);
    paint(patched, after);
    const fresh = domHarness();
    paint(fresh, after);
    const shown = (body: any) => body.innerHTML.replace(/ active"/g, '"');
    expect(shown(patched.body)).toBe(shown(fresh.body));
    // Every row still responds, whichever path painted it.
    for (const row of rowNodes(patched.body)) expect(row.listeners.get('click')).toHaveLength(1);
  });

  it('keeps the selection on its row through in-place paints', () => {
    const harness = domHarness();
    paint(harness, { rows: base });
    harness.context._onSearchKey({ key: 'ArrowDown', preventDefault: vi.fn() });
    paint(harness, { rows: base, pending: ['chat'] });
    const active = harness.body.querySelectorAll('.search-result.active');
    expect(active).toHaveLength(1);
    expect(active[0]).toBe(rowNodes(harness.body)[1]);
  });

  it('rebuilds the rows after a loading, error or history paint replaced them', () => {
    const harness = domHarness();
    paint(harness, { rows: base });
    const before = rowNodes(harness.body)[0];
    harness.context._showSearchLoading('needle');
    expect(rowNodes(harness.body)).toHaveLength(0);
    paint(harness, { rows: base });
    expect(rowNodes(harness.body)).toHaveLength(3);
    expect(rowNodes(harness.body)[0] === before, 'Rows return as new nodes with their own listeners').toBe(false);
    harness.context._renderSearchError('private');
    paint(harness, { rows: base });
    expect(rowNodes(harness.body)).toHaveLength(3);
    harness.context._renderSearchEmptyState();
    paint(harness, { rows: base });
    expect(rowNodes(harness.body)).toHaveLength(3);
    expect(harness.body.classList.contains('is-start-state')).toBe(false);
  });

  it('relabels rows when the language changes even if the section label reads the same', () => {
    const harness = domHarness();
    paint(harness, { rows: base });
    const original = harness.context.t;
    harness.context.t = (key: string) => key === 'search.role.user' ? 'Relabeled' : original(key);
    const change = (harness.doc as any).listeners.get('i18n-change')[0].fn;
    change();
    expect(harness.body.querySelector('.search-result-meta').textContent).toContain('Relabeled');
  });

  it('leaves result rows and history untouched while editing a draft with nothing in flight', () => {
    const harness = domHarness();
    harness.context._loadSearchHistory = () => ['earlier query'];
    harness.context._renderSearchEmptyState();
    const history = harness.body.querySelector('[data-history-q]');
    harness.context._scheduleSearch('d');
    expect(harness.body.querySelector('[data-history-q]')).toBe(history);

    paint(harness, { rows: base });
    const rows = rowNodes(harness.body);
    const html = harness.body.innerHTML;
    harness.context._scheduleSearch('dr');
    harness.context._scheduleSearch('dra');
    rowNodes(harness.body).forEach((row, index) => expect(row === rows[index]).toBe(true));
    expect(harness.body.innerHTML).toBe(html);
  });

  it('clears cancelled progress while editing a draft and keeps the rows', () => {
    const harness = domHarness();
    paint(harness, { rows: base, pending: ['chat'] });
    const first = rowNodes(harness.body)[0];
    harness.context._scheduleSearch('draft');
    expect(harness.body.querySelector('.search-section-label.is-status')).toBeNull();
    expect(rowNodes(harness.body)[0]).toBe(first);
  });

  it('keeps a failed search message while editing a draft instead of claiming no results', async () => {
    const { body, context, streams } = progressiveHarness(domHarness());
    const pending = context._runSearchNow('needle');
    streams[0].reject(new Error('offline'));
    await pending;
    expect(body.textContent).toContain('搜索失败');
    context._scheduleSearch('draft');
    expect(body.textContent).toContain('搜索失败');
    expect(body.textContent).not.toContain('未找到');
  });

  it('loads summaries again when a draft returns to the submitted query', async () => {
    vi.useFakeTimers();
    try {
      const { input, context, streams } = progressiveHarness(domHarness());
      input.value = 'needle';
      const pending = context._runSearchNow('needle');
      streams[0].finish({ results: [chat(0)], pending_kinds: [], failed_kinds: [] });
      await pending;
      input.value = 'needl'; context._scheduleSearch(input.value);
      await vi.advanceTimersByTimeAsync(100);
      expect(streams).toHaveLength(1);
      input.value = 'needle'; context._scheduleSearch(input.value);
      await vi.advanceTimersByTimeAsync(40);
      expect(streams).toHaveLength(2);
      expect(streams[1].payload.chatSnippetRefs).toEqual([{ cid: 'c0', msg_index: 0 }]);
    } finally { vi.useRealTimers(); }
  });

  it('holds paints while a row is pressed so that row opens, then shows the page that arrived', async () => {
    vi.useFakeTimers();
    try {
      const harness = progressiveHarness(domHarness());
      const { body, context, streams } = harness;
      const navigate = vi.fn(); context._gotoSearchResult = navigate;
      const pending = context._runSearchNow('needle');
      streams[0].emit({ results: [chat(0), chat(1)], pending_kinds: ['chat'], failed_kinds: [] });
      const pressed = rowNodes(body)[1];
      const shown = body.innerHTML;
      body.scrollTop = 40;
      press(pressed.querySelector('.search-result-title'));
      streams[0].finish({ results: [chat(0, { snippet: 'needle moves rows' }), chat(1), chat(2)], pending_kinds: [], failed_kinds: [] });
      await pending;
      expect(body.innerHTML).toBe(shown);
      fire(harness, 'mouseup');
      pressed.click();
      expect(navigate).toHaveBeenCalledOnce();
      expect(navigate.mock.calls[0][0]).toMatchObject({ cid: 'c1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(rowNodes(body)).toHaveLength(3);
      expect(body.querySelector('.search-section-label.is-status')).toBeNull();
      expect(body.textContent).toContain('needle moves rows');
      expect(body.scrollTop, 'A held page keeps the reading position').toBe(40);
    } finally { vi.useRealTimers(); }
  });

  it('paints nothing after the press when the click closed the overlay', async () => {
    vi.useFakeTimers();
    try {
      const harness = domHarness();
      harness.context._gotoSearchResult = vi.fn();
      paint(harness, { rows: base });
      const shown = harness.body.innerHTML;
      press(rowNodes(harness.body)[0]);
      paint(harness, { rows: base, pending: ['chat'] });
      harness.overlay.style.display = 'none';
      fire(harness, 'mouseup');
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.body.innerHTML).toBe(shown);
    } finally { vi.useRealTimers(); }
  });

  it.each(['no release arrives', 'the window loses focus'])('resumes paints when %s', async cause => {
    vi.useFakeTimers();
    try {
      const harness = domHarness();
      paint(harness, { rows: base });
      press(rowNodes(harness.body)[0]);
      paint(harness, { rows: base, pending: ['chat'] });
      expect(harness.body.querySelector('.search-section-label.is-status')).toBeNull();
      if (cause === 'no release arrives') {
        await vi.advanceTimersByTimeAsync(1999);
        expect(harness.body.querySelector('.search-section-label.is-status')).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
      } else {
        fire(harness, 'blur');
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(harness.body.querySelector('.search-section-label.is-status')).not.toBeNull();
      expect(harness.windowListeners.get('mouseup')).toEqual([]);
      expect(harness.windowListeners.get('blur')).toEqual([]);
      // The hold is over: a later page paints straight away.
      paint(harness, { rows: base });
      expect(harness.body.querySelector('.search-section-label.is-status')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it.each<[string, (body: any) => any, Record<string, unknown>]>([
    ['a secondary button on a row', body => rowNodes(body)[0], { button: 2 }],
    ['the primary button outside a row', body => body, { button: 0 }],
  ])('does not hold paints for %s', (_name, target, init) => {
    const harness = domHarness();
    paint(harness, { rows: base });
    press(target(harness.body), init);
    paint(harness, { rows: base, pending: ['chat'] });
    expect(harness.body.querySelector('.search-section-label.is-status')).not.toBeNull();
  });

  it('does not repaint old results over a newer history or error paint when the press ends', async () => {
    vi.useFakeTimers();
    try {
      const harness = domHarness();
      paint(harness, { rows: base });
      press(rowNodes(harness.body)[0]);
      paint(harness, { rows: base, pending: ['chat'] });
      harness.context._renderSearchError('unavailable');
      fire(harness, 'mouseup');
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.body.textContent).toContain('搜索失败');
      expect(rowNodes(harness.body)).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
});
