// ─── Global search (Cmd+K) ───────────────────────────────────────────────
// Search submitted account queries, including automations and to-dos. Results are
// grouped by kind; clicking one navigates to the source. Search history is
// persisted in localStorage per user.

const _searchLog = (typeof createLogger === 'function')
  ? createLogger('search')
  : { warn() {} };

const _SEARCH_HISTORY_KEY = 'search_history';
const _SEARCH_HISTORY_MAX = 12;
const _SEARCH_FETCH_LIMIT = 200;   // backend cap; we filter/slice locally per tab
const _SEARCH_ALL_PER_SECTION = 10; // "all" tab shows up to N per section, overflow → "view more"
const _SEARCH_PRESS_HOLD_MAX_MS = 2000; // a lost mouse release must not freeze result paints
let _searchTimer = null;
let _searchSeq = 0;
let _searchStreamHandle = null;
let _searchSnippetHandle = null;
let _searchSnippetTimer = null;
let _searchSnippetCache = new Map();
let _searchSnippetAttempted = new Set();
let _searchPendingKinds = [];
let _searchFailedKinds = [];
let _searchTab = 'all';
let _searchResults = [];
let _searchActiveIdx = -1;
let _searchLastQuery = '';
// Only a first full build announces incomplete history. Catch-up after that
// (an unverified index waiting for its idle repair) stays quiet.
let _searchChatIndexBuilding = false;
let _searchLoading = false;
let _searchChatSnippetsFailed = false;
const _SEARCH_FAILURE_DEDUPE_MS = 60 * 1000;
const _SEARCH_FAILURE_MAX_KEYS = 16;
const _SEARCH_FAILURE_STAGES = new Set(['request', 'response', 'partial']);
const _searchFailureState = new Map();
const _SEARCH_RESULT_STAGES = new Set(['request', 'response', 'partial', 'complete', 'superseded']);
const _SEARCH_FAILURE_CODES = new Set([
  'search_failed',
  'search_request_failed',
  'search_degraded',
]);

function _searchFailureCode(value, fallback) {
  const raw = String((value && value.code) || '').trim().toLowerCase();
  if (_SEARCH_FAILURE_CODES.has(raw)) return raw;
  const safeFallback = String(fallback || '').trim().toLowerCase();
  return _SEARCH_FAILURE_CODES.has(safeFallback) ? safeFallback : 'search_failed';
}

function _reportGlobalSearchFailure(stage, error, fallbackCode) {
  const safeStage = _SEARCH_FAILURE_STAGES.has(stage) ? stage : 'unknown';
  const errorCode = _searchFailureCode(error, fallbackCode || 'search_failed');
  let key = `${safeStage}|${errorCode}`;
  if (!_searchFailureState.has(key) && _searchFailureState.size >= _SEARCH_FAILURE_MAX_KEYS) {
    key = 'unknown|search_failed';
  }
  const now = Date.now();
  const previous = _searchFailureState.get(key);
  if (previous && now - previous.at < _SEARCH_FAILURE_DEDUPE_MS) {
    previous.suppressed += 1;
    return { stage: safeStage, error_code: errorCode };
  }
  const suppressed = previous?.suppressed || 0;
  _searchFailureState.set(key, { at: now, suppressed: 0 });
  _searchLog.warn('global search failed', {
    stage: safeStage,
    error_code: errorCode,
    error,
    ...(suppressed > 0 ? { suppressed_count: suppressed } : {}),
  });
  return { stage: safeStage, error_code: errorCode };
}

function _bindGlobalSearch() {
  document.getElementById('sidebar-search-btn')?.addEventListener('click', () => openGlobalSearch('sidebar'));
  // Library page-header search button reuses the same Cmd+K overlay
  // (Step 7 in the main-screen redesign — confirmed by user).
  document.getElementById('contexts-page-header-search')?.addEventListener('click', () => openGlobalSearch('library_header'));
  document.getElementById('search-close-btn')?.addEventListener('click', closeGlobalSearch);
  const body = document.getElementById('search-body');
  if (body && !body.dataset.snippetsBound) {
    body.dataset.snippetsBound = '1';
    body.addEventListener('scroll', _scheduleVisibleChatSnippets, { passive: true });
    body.addEventListener('mousedown', _holdSearchPaintsForPress);
  }
  const input = document.getElementById('search-input');
  if (input && !input.dataset.bound) {
    input.dataset.bound = '1';
    input.addEventListener('input', () => _scheduleSearch(input.value));
    input.addEventListener('keydown', _onSearchKey);
  }
  // Category tabs — re-render from the cached _searchResults on switch.
  document.querySelectorAll('.search-tab').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => _setSearchTab(btn.dataset.tab));
  });
  // Global Cmd/Ctrl+K shortcut. Toggle behaviour: if the overlay is already
  // open, a second Cmd+K closes it (parity with Cmd+K-style command palettes
  // in VS Code / Notion / etc.) — without this, the keystroke would re-call
  // openGlobalSearch() and reset query + tab state mid-typing.
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      const overlay = document.getElementById('search-overlay');
      if (overlay && overlay.style.display !== 'none') {
        closeGlobalSearch();
      } else {
        openGlobalSearch('keyboard');
      }
    } else if (e.key === 'Escape' && document.getElementById('search-overlay').style.display !== 'none') {
      closeGlobalSearch();
    }
  });
}

const _SEARCH_VALID_TABS = new Set(['all', 'chat', 'agent', 'skill', 'context', 'automation', 'todo', 'connector']);
function _setSearchTab(tab) {
  if (!tab || !_SEARCH_VALID_TABS.has(tab)) return;
  _searchTab = tab;
  document.querySelectorAll('.search-tab').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tab === tab);
    b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    if (b.dataset.tab === tab) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  _renderSearchResults(_searchLastQuery);
}

function openGlobalSearch(entryPoint = 'unknown') {
  const overlay = document.getElementById('search-overlay');
  if (!overlay) return;
  void entryPoint;
  overlay.style.display = '';
  const input = document.getElementById('search-input');
  if (input) {
    input.value = '';
    _searchLoading = false;
    _searchPendingKinds = [];
    _searchFailedKinds = [];
    _searchChatSnippetsFailed = false;
    _searchResults = [];
    _searchActiveIdx = -1;
    _searchLastQuery = '';
    _searchChatIndexBuilding = false;
    _searchSeq++;    // invalidate any in-flight query from a previous session
    _setSearchTab('all');           // reset to default tab each open
    _setSearchTabsVisible(false);   // hide tabs while empty/history state is shown
    setTimeout(() => input.focus(), 30);
    _renderSearchEmptyState();
    void _refreshSearchIndexStatus(_searchSeq, '', { active: true });
  }
}

function _setSearchTabsVisible(show) {
  document.getElementById('search-tabs')?.classList.toggle('is-hidden', !show);
}

function closeGlobalSearch() {
  const overlay = document.getElementById('search-overlay');
  if (!overlay || overlay.style.display === 'none') return;
  // Persist the input content on close: covers both "user picked a result"
  // (_gotoSearchResult ends here) and "user walked away with text in the box".
  // Per-keystroke saves would fill history with noise.
  const input = document.getElementById('search-input');
  const q = (input?.value || '').trim();
  if (q) _saveSearchHistoryEntry(q);
  // A closed overlay has no current query. Invalidate any response still in
  // flight so it cannot repaint hidden state or report a failure the user no
  // longer encountered.
  _searchSeq++;
  _cancelSearchStream();
  _searchLoading = false;
  _searchPendingKinds = [];
  _searchFailedKinds = [];
  _searchChatSnippetsFailed = false;
  overlay.style.display = 'none';
  if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
}

function _scheduleSearch(query) {
  if (_searchTimer) clearTimeout(_searchTimer);
  _searchTimer = null;
  const wasLoading = _searchLoading || _searchPendingKinds.length > 0 || !!_searchSnippetHandle;
  // Invalidate immediately when editing a submitted query.
  _searchSeq++;
  _cancelSearchStream();
  if (!query.trim()) { void _runSearchNow(''); return; }
  // Editing a draft cancels obsolete work; only Enter submits the new query.
  _searchLoading = false;
  _searchPendingKinds = [];
  // A keystroke changes no result, so only cancelled progress needs painting.
  if (!wasLoading) { _scheduleVisibleChatSnippets(); return; }
  if (_searchLastQuery) _renderSearchResults(_searchLastQuery);
  else _renderSearchEmptyState();
}

function _activeProjectIdForSearch() {
  if (typeof currentView !== 'undefined' && currentView === 'project'
      && typeof _projectDetailPid !== 'undefined' && _projectDetailPid) {
    return _projectDetailPid;
  }
  if (typeof currentView !== 'undefined' && currentView === 'conversation'
      && typeof currentCid !== 'undefined' && currentCid && Array.isArray(conversations)) {
    const owner = conversations.find((c) => c && c.conversation_id === currentCid);
    if (owner && owner.project_id) return owner.project_id;
  }
  return '';
}

// Coverage must not wait for the all-scope query (including embeddings and
// snippets). A late status response must never overwrite newer query results.
async function _refreshSearchIndexStatus(seq, query, pending) {
  try {
    const response = await apiFetch('/api/search/status');
    const data = await response.json();
    if (seq !== _searchSeq || !pending.active || !data.ok) return;
    _searchChatIndexBuilding = data.chat_index_building === true;
    if (_searchChatIndexBuilding) {
      if (query) {
        if (query !== _searchLastQuery) {
          _searchResults = [];
          _searchVisibleResults = [];
        }
        _searchLastQuery = query;
        _setSearchTabsVisible(true);
        _renderSearchResults(query);
      } else _renderSearchEmptyState();
    }
  } catch (_) { /* the result response remains the authoritative fallback */ }
}

function _showSearchLoading(query) {
  _searchLoading = true;
  _searchChatSnippetsFailed = false;
  _searchResults = [];
  _searchVisibleResults = [];
  _searchActiveIdx = -1;
  _searchLastQuery = query;
  _setSearchTabsVisible(true);
  _renderSearchResults(query);
}

async function _runSearchNow(queryArg) {
  _cancelSearchStream();
  _searchPendingKinds = [];
  _searchFailedKinds = [];
  if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
  const input = document.getElementById('search-input');
  const query = (queryArg !== undefined ? queryArg : (input?.value || '')).trim();
  if (!query) {
    _searchLoading = false;
    _searchChatSnippetsFailed = false;
    _searchSeq++;
    _searchResults = [];
    _searchVisibleResults = [];
    _searchActiveIdx = -1;
    _searchLastQuery = '';
    _searchChatIndexBuilding = false;
    _setSearchTabsVisible(false);
    _renderSearchEmptyState();
    void _refreshSearchIndexStatus(_searchSeq, '', { active: true });
    return;
  }
  const seq = ++_searchSeq;
  const startedAt = Date.now();
  const projectId = _activeProjectIdForSearch();
  _showSearchLoading(query);
  const pending = { active: true };
  void _refreshSearchIndexStatus(seq, query, pending);
  await _runProgressiveSearch(query, seq, startedAt, projectId, pending);
}

function _cancelSearchStream() {
  const handle = _searchStreamHandle;
  _searchStreamHandle = null;
  if (handle) handle.cancel();
  if (_searchSnippetTimer) { clearTimeout(_searchSnippetTimer); _searchSnippetTimer = null; }
  const snippets = _searchSnippetHandle;
  _searchSnippetHandle = null;
  if (snippets) snippets.cancel();
}

function _scheduleVisibleChatSnippets() {
  if (_searchSnippetHandle || !_searchLastQuery) return;
  const input = document.getElementById('search-input');
  if (input && input.value.trim() !== _searchLastQuery) return;
  if (_searchSnippetTimer) clearTimeout(_searchSnippetTimer);
  _searchSnippetTimer = setTimeout(() => { _searchSnippetTimer = null; void _loadVisibleChatSnippets(); }, 40);
}

async function _loadVisibleChatSnippets() {
  if (_searchSnippetHandle) return;
  const body = document.getElementById('search-body');
  if (!body?.getBoundingClientRect) return;
  const bounds = body.getBoundingClientRect();
  const refs = [];
  for (const element of body.querySelectorAll('.search-result')) {
    const row = _searchVisibleResults[Number(element.dataset.idx)];
    if (row?.kind !== 'chat') continue;
    const key = `${row.cid}:${row.msg_index}`;
    if (_searchSnippetAttempted.has(key)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom < bounds.top - 120 || rect.top > bounds.bottom + 120) continue;
    refs.push({ cid: row.cid, msg_index: row.msg_index });
    if (refs.length === 20) break;
  }
  if (!refs.length) return;
  const seq = _searchSeq, query = _searchLastQuery;
  refs.forEach(ref => _searchSnippetAttempted.add(`${ref.cid}:${ref.msg_index}`));
  let handle, failed = false, complete = false;
  const repaint = () => {
    const top = body.scrollTop;
    const anchor = body.querySelector('.search-result.active');
    const rect = anchor?.getBoundingClientRect();
    const bounds = body.getBoundingClientRect();
    const visible = top > 0 && rect && rect.bottom > bounds.top && rect.top < bounds.bottom;
    _renderSearchResults(query);
    body.scrollTop = top;
    const retained = visible && body.querySelector('.search-result.active');
    if (retained) body.scrollTop += retained.getBoundingClientRect().top - rect.top;
  };
  try {
    handle = window.orkas.stream('search.global', { query, scope: 'chat', limit: _SEARCH_FETCH_LIMIT, chatSnippetRefs: refs }, message => {
      if (seq !== _searchSeq) return;
      if (message.type === 'error') { failed = true; return; }
      const page = message.event;
      if (message.type !== 'event' || !Array.isArray(page?.results)) return;
      failed ||= !!page.failed_kinds?.length;
      complete = !page.pending_kinds?.length;
      if (page.failed_kinds?.includes('chat')) return;
      const eligible = new Set(page.results.map(row => `${row.cid}:${row.msg_index}`));
      for (const row of page.results) if (row.snippet_loaded) _searchSnippetCache.set(`${row.cid}:${row.msg_index}`, row);
      _searchResults = _searchResults.filter(row => row.kind !== 'chat' || eligible.has(`${row.cid}:${row.msg_index}`))
        .map(row => row.kind === 'chat' ? { ...row, ..._searchSnippetCache.get(`${row.cid}:${row.msg_index}`) } : row);
      repaint();
    });
    _searchSnippetHandle = handle;
    repaint();
    await handle.promise;
    if (failed || !complete) throw new Error('Search summaries unavailable');
  } catch (error) {
    if (seq === _searchSeq) {
      if (!_searchChatSnippetsFailed) _reportGlobalSearchFailure('partial', error, 'search_degraded');
      _searchChatSnippetsFailed = true;
    }
  } finally {
    if (_searchSnippetHandle === handle) _searchSnippetHandle = null;
    if (seq === _searchSeq) { repaint(); _scheduleVisibleChatSnippets(); }
  }
}

async function _runProgressiveSearch(query, seq, startedAt, projectId, pending) {
  _searchSnippetCache = new Map();
  _searchSnippetAttempted = new Set();
  let received = false, complete = false, transportError = false;
  let handle;
  const repaint = () => {
    const body = document.getElementById('search-body');
    const top = body?.scrollTop || 0;
    const anchor = body?.querySelector('.search-result.active');
    const rect = anchor?.getBoundingClientRect();
    const bounds = anchor ? body.getBoundingClientRect() : null;
    // At the start of the list, late categories must not pull the viewport
    // down to the row that happened to be selected by the first page.
    const visible = top > 0 && rect && rect.bottom > bounds.top && rect.top < bounds.bottom;
    _renderSearchResults(query);
    if (body) {
      body.scrollTop = top;
      const retained = visible && body.querySelector('.search-result.active');
      if (retained) body.scrollTop += retained.getBoundingClientRect().top - rect.top;
    }
  };
  try {
    handle = window.orkas.stream('search.global', { query, scope: 'all', limit: _SEARCH_FETCH_LIMIT, chatSnippetRefs: [],
      ...(projectId ? { projectId } : {}) }, message => {
      if (seq !== _searchSeq) return;
      if (message.type === 'error') { transportError = true; return; }
      const page = message.event;
      if (message.type !== 'event' || !page || !Array.isArray(page.results)) return;
      received = true;
      _searchLoading = false;
      _searchPendingKinds = page.pending_kinds || [];
      _searchFailedKinds = page.failed_kinds || [];
      complete = !_searchPendingKinds.length;
      _searchChatSnippetsFailed ||= _searchFailedKinds.includes('chat');
      if (typeof page.chat_index_building === 'boolean') _searchChatIndexBuilding = page.chat_index_building;
      _searchResults = page.results.map(row => row.kind === 'chat'
        ? { ...row, ..._searchSnippetCache.get(`${row.cid}:${row.msg_index}`) } : row);
      _searchLastQuery = query;
      _setSearchTabsVisible(true);
      repaint();
    });
    _searchStreamHandle = handle;
    await handle.promise;
    if (seq !== _searchSeq) {
      
      return;
    }
    if (transportError || !received || !complete) throw new Error('Search incomplete');
    
  } catch (error) {
    if (seq !== _searchSeq) {
      
      return;
    }
    _searchLoading = false;
    _searchFailedKinds = [...new Set([..._searchFailedKinds, ..._searchPendingKinds])];
    _searchPendingKinds = [];
    const failure = _reportGlobalSearchFailure('request', error, 'search_request_failed');
    
    if (received) repaint(); else _renderSearchError(t('memory.error_generic'));
  } finally {
    pending.active = false;
    if (_searchStreamHandle === handle) _searchStreamHandle = null;
  }
}

// Split results into resource buckets per the tab-grouping spec:
//   - chats:    main-conversation messages, sorted by relevance
//               (query coverage, then score) — see _sectionRows for why the
//               displayed rows are then re-ordered by recency
//   - agents:   agent body matches, sorted by score DESC then name
//   - skills:   skill body matches, sorted by score DESC then name
//   - contexts: Library filename/body matches, sorted by relevance then path
// Skill/agent EDIT conversations were removed from search — only the
// main-conversation jsonls feed the chats bucket.
function _partitionSearchResults(results) {
  const chats = results
    .filter((r) => r.kind === 'chat')
    .slice()
    .sort((a, b) => ((Number(b.term_coverage) || 0) - (Number(a.term_coverage) || 0))
      || ((b.score || 0) - (a.score || 0))
      || String(b.time || '').localeCompare(String(a.time || '')));
  const agents = results
    .filter((r) => r.kind === 'agent')
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0)
      || String(a.name || '').localeCompare(String(b.name || '')));
  const skills = results
    .filter((r) => r.kind === 'skill')
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0)
      || String(a.name || '').localeCompare(String(b.name || '')));
  const contexts = results
    .filter((r) => r.kind === 'context')
    .slice()
    .sort((a, b) => {
      const scoreDelta = (b.score || 0) - (a.score || 0);
      if (scoreDelta !== 0) return scoreDelta;
      const pa = String(a.path || ''); const pb = String(b.path || '');
      const da = pa.split('/').length; const db = pb.split('/').length;
      if (da !== db) return da - db;
      return pa.localeCompare(pb);
    });
  const byName = (kind) => results.filter((r) => r.kind === kind)
    .sort((a, b) => (b.score || 0) - (a.score || 0)
      || String(a.name || '').localeCompare(String(b.name || '')));
  return { chats, agents, skills, contexts, automations: byName('automation'), todos: byName('todo'), connectors: byName('connector') };
}

function _renderSearchEmptyState() {
  const body = document.getElementById('search-body');
  if (!body) return;
  body._searchPaintWaiting = false;
  body.classList.add('is-start-state');
  const history = _loadSearchHistory();
  const historyHtml = history.length
    ? `
      <div class="search-section-label" style="display:flex;align-items:center;justify-content:space-between">
        <span>${escapeHtml(t('search.history_title'))}</span>
        <button class="search-history-clear" id="search-history-clear">${escapeHtml(t('search.history_clear'))}</button>
      </div>
      <div class="search-history-list">
        ${history.map((q) => `<button class="search-history-item" data-history-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('')}
      </div>`
    : '';
  const notice = _searchChatIndexBuilding
    ? `<div class="search-section-label is-status" role="status">${escapeHtml(t('search.history_indexing'))}</div>` : '';
  body.innerHTML = notice + (historyHtml || (notice ? '' : `<div class="search-empty">${escapeHtml(t('search.empty_hint'))}</div>`));
  body.querySelectorAll('[data-history-q]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.historyQ;
      const input = document.getElementById('search-input');
      if (input) { input.value = q; input.focus(); }
      _runSearchNow(q);
    });
  });
  body.querySelector('#search-history-clear')?.addEventListener('click', () => {
    _saveSearchHistory([]);
    _renderSearchEmptyState();
  });
}

function _renderSearchError(msg) {
  const body = document.getElementById('search-body');
  if (!body) return;
  body._searchPaintWaiting = false;
  body.classList.remove('is-start-state');
  body.innerHTML = `<div class="search-empty" style="color:var(--danger)">${escapeHtml(t('search.failed', { msg: msg || '' }))}</div>`;
}

function _highlightSnippet(snippet, query) {
  const safe = escapeHtml(snippet || '');
  if (!query) return safe;
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

// Labels resolved lazily via t() so switching lang re-labels future renders.
const _SEARCH_KIND_META = {
  context: { labelKey: 'search.scope.context', cls: 'is-context' },
  chat:    { labelKey: 'search.scope.chat',    cls: 'is-chat' },
  agent:   { labelKey: 'search.scope.agent',   cls: 'is-agent' },
  skill:   { labelKey: 'search.scope.skill',   cls: 'is-skill' },
  automation: { labelKey: 'new_chat.home.source.automation', cls: 'is-automation' },
  todo: { labelKey: 'project.todo.title', cls: 'is-todo' },
  connector: { labelKey: 'connectors.title', cls: 'is-connector' },
};

const _SEARCH_SOURCE_LABEL = {
  custom:  'search.source.custom',
  builtin: 'search.source.marketplace',
  marketplace: 'search.source.marketplace',
};

// Render one result into HTML. Uses the shared `_renderSearchRow` helper for
// title/sub/snippet; `dataIdx` is the position within the currently-rendered
// visible list (for keyboard navigation).
function _renderSearchRow(r, dataIdx, query) {
  const metaCfg = _SEARCH_KIND_META[r.kind] || { labelKey: '', cls: '' };
  const label = metaCfg.labelKey ? t(metaCfg.labelKey) : r.kind;
  const roleLabel = (role) => (role === 'user' ? t('search.role.user') : t('search.role.ai'));
  let title = ''; let sub = '';
  let projectChip = '';
  if (r.kind === 'context') {
    title = r.title || r.path;
    sub = r.path;
    if (r.library_scope === 'project') {
      if (r.project_name) {
        projectChip = `<span class="search-result-project" title="${escapeHtml(r.project_name)}">${escapeHtml(r.project_name)}</span>`;
      }
      sub = r.project_name ? `${r.project_name} · ${r.path}` : r.path;
    }
  } else if (r.kind === 'chat') {
    title = r.conv_title || t('chat.new_conv_title');
    sub = `${roleLabel(r.role)} · ${formatTime(r.time || '')}`;
    if (r.project_name) {
      projectChip = `<span class="search-result-project" title="${escapeHtml(r.project_name)}">${escapeHtml(r.project_name)}</span>`;
    }
  } else if (r.kind === 'agent' || r.kind === 'skill' || r.kind === 'connector') {
    title = r.name || r.id;
    const source = (typeof normalizeCatalogSource === 'function') ? normalizeCatalogSource(r.source) : r.source;
    const srcKey = _SEARCH_SOURCE_LABEL[source] || _SEARCH_SOURCE_LABEL[r.source] || '';
    sub = srcKey ? t(srcKey) : '';
  } else if (r.kind === 'automation' || r.kind === 'todo') {
    title = r.name || r.id;
    sub = r.kind === 'automation'
      ? t(r.enabled ? 'auto.status_enabled' : 'auto.status_disabled')
      : t('project.todo.status_' + r.status);
    const scopeName = r.project_id ? (r.project_name || t('todo.project')) : t('todo.global');
    projectChip = `<span class="search-result-project" title="${escapeHtml(scopeName)}">${escapeHtml(scopeName)}</span>`;
  }
  const active = dataIdx === _searchActiveIdx ? ' active' : '';
  return `
    <div class="search-result${active}" data-idx="${dataIdx}">
      <div class="search-result-head">
        <span class="search-result-kind ${metaCfg.cls}">${escapeHtml(label)}</span>
        <span class="search-result-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
        ${projectChip}
        <span class="search-result-meta" title="${escapeHtml(sub)}">${escapeHtml(sub)}</span>
      </div>
      ${r.snippet ? _renderSearchSnippet(r.snippet, query) : ''}
    </div>`;
}

function _renderSearchSnippet(snippet, query) {
  return `<div class="search-result-snippet">${_highlightSnippet(snippet, query)}</div>`;
}

// Currently rendered (post-filter, post-slice) results in flat order so the
// dataIdx → result lookup for click/arrow is O(1). Rebuilt on every
// render. Think of `_searchResults` as "raw server output" and
// `_searchVisibleResults` as "what the user sees".
let _searchVisibleResults = [];

// Which rows a section shows, and in what order.
//
// Chats are *picked* by relevance and *shown* newest-first. The "all" tab has
// room for _SEARCH_ALL_PER_SECTION rows only, so picking them by recency
// buries the actual answer under whatever the user happened to discuss last —
// the backend already ranked the bucket, and the cut has to respect that
// ranking. Reading a chat list by time is still what the user expects, so the
// rows that survive the cut are re-ordered by recency for display.
function _sectionRows(section, tab) {
  const rows = tab === 'all'
    ? section.bucket.slice(0, _SEARCH_ALL_PER_SECTION)
    : section.bucket.slice();
  if (section.tab === 'chat') {
    rows.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  }
  return rows;
}

function _renderSearchResults(query) {
  const body = document.getElementById('search-body');
  if (!body) return;
  if (body._searchPressTimer) { body._searchPaintWaiting = true; return; }
  body.classList.remove('is-start-state');
  const indexing = _searchChatIndexBuilding && (_searchTab === 'all' || _searchTab === 'chat');
  const contentPending = (typeof _searchSnippetHandle !== 'undefined' && _searchSnippetHandle && (_searchTab === 'all' || _searchTab === 'chat'))
    || (typeof _searchPendingKinds !== 'undefined' && _searchPendingKinds.some(kind => _searchTab === 'all' || _searchTab === kind));
  const contentFailed = (typeof _searchFailedKinds !== 'undefined' && _searchFailedKinds.some(kind => _searchTab === 'all' || _searchTab === kind))
    || (typeof _searchChatSnippetsFailed !== 'undefined' && _searchChatSnippetsFailed
      && (_searchTab === 'all' || _searchTab === 'chat'));
  const notice = (indexing
    ? `<div class="search-section-label is-status" role="status">${escapeHtml(t('search.history_indexing'))}</div>`
    : '') + (contentPending
      ? `<div class="search-section-label is-status" role="status"><span class="search-loading-spinner" aria-hidden="true"></span> ${escapeHtml(t('common.loading'))}</div>`
      : contentFailed ? `<div class="search-section-label is-status" role="status">${escapeHtml(t('search.failed', { msg: t('memory.error_generic') }))}</div>` : '');
  if (_searchLoading) {
    body.innerHTML = notice + `<div class="search-empty search-loading" role="status"><span class="search-loading-spinner" aria-hidden="true"></span><span>${escapeHtml(t('common.loading'))}</span></div>`;
    return;
  }
  if (!_searchResults.length) {
    _searchVisibleResults = [];
    body.innerHTML = contentPending || contentFailed ? notice : indexing
      ? `<div class="search-empty" role="status">${escapeHtml(t('search.history_indexing'))}</div>`
      : `<div class="search-empty">${escapeHtml(t('search.no_results', { query }))}</div>`;
    return;
  }
  const { chats, agents, skills, contexts, automations, todos, connectors } = _partitionSearchResults(_searchResults);
  const identity = row => [row.kind, row.id || row.cid || row.path, row.project_id || '',
    Number.isInteger(row.msg_index) ? row.msg_index : (row.msg_id || '')].join('\0');
  // Everything a rendered row shows except its summary and selection.
  const rowLayout = row => [identity(row), row.conv_title, row.title, row.path, row.name, row.role, row.time,
    row.source, row.enabled, row.status, row.project_name, row.library_scope].join('\0');
  const parts = [notice];
  const layout = [query];
  const visible = [];

  // Match the sidebar and search tabs: chats → to-dos → automations → agents → skills → connectors → Library. Each
  // section caps at _SEARCH_ALL_PER_SECTION rows, with overflow
  // surfacing a "view more" button that jumps to the matching tab.
  // Other tabs render their own section only (no cap, so the user can
  // scroll through everything).
  const sections = [
    { tab: 'chat',    bucket: chats,    labelKey: 'search.section.chat' },
    { tab: 'todo', bucket: todos, labelKey: 'project.todo.title' },
    { tab: 'automation', bucket: automations, labelKey: 'new_chat.home.source.automation' },
    { tab: 'agent',   bucket: agents,   labelKey: 'search.section.agent' },
    { tab: 'skill',   bucket: skills,   labelKey: 'search.section.skill' },
    { tab: 'connector', bucket: connectors, labelKey: 'connectors.title' },
    { tab: 'context', bucket: contexts, labelKey: 'search.section.context' },
  ];
  for (const s of sections) {
    if (_searchTab !== 'all' && _searchTab !== s.tab) continue;
    const slice = _sectionRows(s, _searchTab);
    if (!slice.length) continue;
    const label = `<div class="search-section-label">${escapeHtml(t(s.labelKey))}</div>`;
    parts.push(label);
    layout.push(label);
    for (const r of slice) {
      const rowIndex = visible.length;
      parts.push(() => _renderSearchRow(r, rowIndex, query));
      layout.push(rowLayout(r));
      visible.push(r);
    }
    if (_searchTab === 'all' && s.bucket.length > slice.length) {
      const more = `<button class="search-show-more" data-goto="${s.tab}">${escapeHtml(t('search.show_more'))} (${s.bucket.length})</button>`;
      parts.push(more);
      layout.push(more);
    }
  }

  const previous = _searchVisibleResults[_searchActiveIdx];
  const retainedIndex = previous ? visible.findIndex(row => identity(row) === identity(previous)) : -1;
  _searchVisibleResults = visible;
  if (!visible.length) {
    body.innerHTML = contentPending || contentFailed ? notice : indexing
      ? `<div class="search-empty" role="status">${escapeHtml(t('search.history_indexing'))}</div>`
      : `<div class="search-empty">${escapeHtml(t('search.no_results', { query }))}</div>`;
    _searchActiveIdx = -1;
    return;
  }
  // Clamp active idx into range of the new visible list.
  _searchActiveIdx = retainedIndex >= 0 ? retainedIndex : Math.min(Math.max(_searchActiveIdx, 0), visible.length - 1);
  const signature = layout.join('\0');
  const painted = body.querySelectorAll('.search-result');
  if (body._searchLayout === signature && painted.length === visible.length) {
    _patchSearchRows(body, painted, visible, notice, query);
  } else {
    body._searchLayout = signature;
    body._searchNotice = notice;
    body.innerHTML = parts.map(part => (typeof part === 'function' ? part() : part)).join('');
    body.querySelectorAll('.search-result').forEach((row, index) => {
      row._searchSnippet = visible[index].snippet || '';
      row.classList.toggle('active', index === _searchActiveIdx);
      row.addEventListener('click', () => {
        const idx = parseInt(row.dataset.idx, 10);
        _searchActiveIdx = idx;
        _gotoSearchResult(_searchVisibleResults[idx], 'mouse');
      });
    });
    body.querySelectorAll('.search-show-more').forEach((btn) => {
      btn.addEventListener('click', () => _setSearchTab(btn.dataset.goto));
    });
  }
  if (typeof _scheduleVisibleChatSnippets === 'function') _scheduleVisibleChatSnippets();
}

// The browser clicks the common ancestor of the pressed and released nodes, so
// a row that moves or is replaced under the pointer loses the click and event
// delegation cannot recover it. Status and summaries move rows by more than
// their height, so nothing paints between press and release.
function _holdSearchPaintsForPress(event) {
  if (event.button !== 0 || !event.target?.closest?.('.search-result')) return;
  const body = event.currentTarget;
  if (body._searchPressTimer) return;
  const release = () => {
    clearTimeout(body._searchPressTimer);
    body._searchPressTimer = null;
    window.removeEventListener('mouseup', afterRelease, true);
    window.removeEventListener('blur', afterRelease);
    const waiting = body._searchPaintWaiting;
    body._searchPaintWaiting = false;
    const overlay = document.getElementById('search-overlay');
    if (!waiting || !_searchLastQuery || overlay?.style.display === 'none') return;
    const top = body.scrollTop;
    _renderSearchResults(_searchLastQuery);
    body.scrollTop = top;
  };
  // The click is dispatched right after mouseup in the same task; paint after it.
  const afterRelease = () => { setTimeout(release, 0); };
  body._searchPressTimer = setTimeout(release, _SEARCH_PRESS_HOLD_MAX_MS);
  window.addEventListener('mouseup', afterRelease, true);
  window.addEventListener('blur', afterRelease);
}

// A page that only fills summaries or status keeps the row nodes, their click
// listeners and any text selection.
function _patchSearchRows(body, rows, visible, notice, query) {
  if (body._searchNotice !== notice) {
    body._searchNotice = notice;
    body.querySelectorAll('.search-section-label.is-status').forEach(element => element.remove());
    body.insertAdjacentHTML('afterbegin', notice);
  }
  rows.forEach((row, index) => {
    row.classList.toggle('active', index === _searchActiveIdx);
    const snippet = visible[index].snippet || '';
    if (row._searchSnippet === snippet) return;
    row._searchSnippet = snippet;
    const current = row.querySelector('.search-result-snippet');
    if (current && snippet) current.innerHTML = _highlightSnippet(snippet, query);
    else {
      current?.remove();
      if (snippet) row.insertAdjacentHTML('beforeend', _renderSearchSnippet(snippet, query));
    }
  });
}

function _onSearchKey(e) {
  // IME candidate confirmation and arrow navigation belong to the composer.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _moveSearchSelection(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _moveSearchSelection(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    void _runSearchNow();
  }
}

function _moveSearchSelection(delta) {
  if (!_searchVisibleResults.length) return;
  const n = _searchVisibleResults.length;
  _searchActiveIdx = (_searchActiveIdx + delta + n) % n;
  document.querySelectorAll('.search-result').forEach((row, i) => {
    row.classList.toggle('active', i === _searchActiveIdx);
    if (i === _searchActiveIdx) row.scrollIntoView({ block: 'nearest' });
  });
}

async function _gotoSearchResult(r) {
  if (!r) return;
  const agentReturnTarget = r.kind === 'agent' && typeof _captureAgentDetailReturnTarget === 'function'
    ? _captureAgentDetailReturnTarget()
    : null;
  closeGlobalSearch();
  if (r.kind === 'context') {
    if (r.library_scope === 'project' && r.project_id) {
      setView('project', r.project_id);
      setTimeout(async () => {
        try {
          const res = await window.orkas.invoke('projects.files.absPath', { projectId: r.project_id, name: r.path });
          if (res && res.ok && typeof openChatFileViewer === 'function') {
            // Preserve the source extension for viewer kind detection. A
            // semantic hit title may be an extracted document heading rather
            // than a filename, which would otherwise fall into "unsupported".
            openChatFileViewer(res.path, r.path, { projectId: r.project_id });
          }
        } catch (_) { /* navigation best-effort */ }
      }, 120);
      return;
    }
    setView('contexts');
    const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    if (typeof loader === 'function') await loader('contexts');
    if (typeof switchCtxProject === 'function' && await switchCtxProject('') === false) return;
    if (typeof loadContexts === 'function') await loadContexts();
    if (typeof openCtxFile === 'function') openCtxFile(r.path);
  } else if (r.kind === 'chat') {
    setView('conversation', r.cid, {
      historyTarget: {
        msgId: r.msg_id || '',
        msgIndex: r.msg_index,
        time: r.time || '',
        role: r.role || '',
      },
    });
  } else if (r.kind === 'connector') {
    setView('connectors');
    if (typeof loadConnectors === 'function') await loadConnectors();
    if (typeof window.focusConnectorById === 'function') await window.focusConnectorById(r.id);
  } else if (r.kind === 'automation' || r.kind === 'todo') {
    const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    if (typeof loader === 'function') await loader(r.kind === 'automation' ? 'auto' : 'project');
    if (r.kind === 'automation') {
      setView('auto');
      if (typeof window.focusAutoTaskById === 'function') await window.focusAutoTaskById(r.id);
    } else if (typeof focusTodo === 'function') {
      focusTodo(r.project_id || '', r.id, { reportMissing: true });
    }
  } else if (r.kind === 'agent') {
    // Open the agent detail view in read mode. Edit mode is intentionally
    // NOT auto-toggled — the user is looking up "this agent", not editing.
    setTimeout(async () => {
      const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
      if (typeof loader === 'function') await loader('agents');
      if (typeof openAgentDetail === 'function') {
        await openAgentDetail(r.id, { returnTarget: agentReturnTarget });
      }
    }, 100);
  } else if (r.kind === 'skill') {
    const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    if (typeof loader === 'function') await loader('skills');
    if (typeof loadSkills === 'function') await loadSkills();
    const cached = (typeof _skillsCache !== 'undefined' && Array.isArray(_skillsCache))
      ? _skillsCache.find((s) => s.id === r.id)
      : null;
    if (cached && typeof openSkillDetail === 'function') {
      await openSkillDetail(cached.source, cached.id);
    } else if (typeof openSkillDetail === 'function') {
      // Cache may not be primed yet — fall back to the search result's own
      // source field so we still land on the right card.
      await openSkillDetail(r.source, r.id);
    }
  }
}

function _loadSearchHistory() {
  try {
    const key = _searchHistoryStorageKey();
    let raw = localStorage.getItem(key);
    // Assign the one pre-account-scoping history list to the first active
    // account that opens search, then remove the shared copy so a later local
    // account cannot inherit it.
    if (raw == null) {
      raw = localStorage.getItem(_SEARCH_HISTORY_KEY);
      if (raw != null) {
        localStorage.setItem(key, raw);
        localStorage.removeItem(_SEARCH_HISTORY_KEY);
      }
    }
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function _searchHistoryStorageKey() {
  const lexicalUid = (typeof currentUserId === 'string') ? currentUserId.trim() : '';
  const globalUid = (typeof globalThis.currentUserId === 'string') ? globalThis.currentUserId.trim() : '';
  return `${_SEARCH_HISTORY_KEY}:${lexicalUid || globalUid || 'anonymous'}`;
}

function _saveSearchHistory(arr) {
  try { localStorage.setItem(_searchHistoryStorageKey(), JSON.stringify(arr)); } catch {}
}

function _saveSearchHistoryEntry(query) {
  const q = (query || '').trim();
  if (!q) return;
  const cur = _loadSearchHistory().filter((x) => x !== q);
  cur.unshift(q);
  _saveSearchHistory(cur.slice(0, _SEARCH_HISTORY_MAX));
}

// Search results are cached across tab switches; refresh their status copy
// with the active locale as well.
document.addEventListener('i18n-change', () => {
  const overlay = document.getElementById('search-overlay');
  if (overlay && overlay.style.display !== 'none') {
    const body = document.getElementById('search-body');
    if (body) body._searchLayout = '';
    if (_searchLastQuery) _renderSearchResults(_searchLastQuery);
    else _renderSearchEmptyState();
  }
});
