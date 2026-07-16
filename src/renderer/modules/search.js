// ─── Global search (Cmd+K) ───────────────────────────────────────────────
// Live-search the Library + chat history (per-user). Results are
// grouped by kind; clicking one navigates to the source. Search history is
// persisted in localStorage per user.

const _SEARCH_HISTORY_KEY = 'search_history';
const _SEARCH_HISTORY_MAX = 12;
const _SEARCH_FETCH_LIMIT = 200;   // backend cap; we filter/slice locally per tab
const _SEARCH_ALL_PER_SECTION = 10; // "all" tab shows up to N per section, overflow → "view more"
let _searchTimer = null;
let _searchSeq = 0;
let _searchTab = 'all';             // 'all' | 'chat' | 'agent' | 'skill' | 'context'
let _searchResults = [];
let _searchActiveIdx = -1;
let _searchLastQuery = '';

function _bindGlobalSearch() {
  document.getElementById('sidebar-search-btn')?.addEventListener('click', openGlobalSearch);
  // Library page-header search button reuses the same Cmd+K overlay
  // (Step 7 in the main-screen redesign — confirmed by user).
  document.getElementById('contexts-page-header-search')?.addEventListener('click', openGlobalSearch);
  document.getElementById('search-close-btn')?.addEventListener('click', closeGlobalSearch);
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
  const overlay = document.getElementById('search-overlay');
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) closeGlobalSearch();
  });
  // Global Cmd/Ctrl+K shortcut. Toggle behaviour: if the overlay is already
  // open, a second Cmd+K closes it (parity with Cmd+K-style command palettes
  // in VS Code / Notion / etc.) — without this, the keystroke would re-call
  // openGlobalSearch() and reset query + tab state mid-typing.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      const overlay = document.getElementById('search-overlay');
      if (overlay && overlay.style.display !== 'none') {
        closeGlobalSearch();
      } else {
        openGlobalSearch();
      }
    } else if (e.key === 'Escape' && document.getElementById('search-overlay').style.display !== 'none') {
      closeGlobalSearch();
    }
  });
}

const _SEARCH_VALID_TABS = new Set(['all', 'chat', 'agent', 'skill', 'context']);
function _setSearchTab(tab) {
  if (!tab || !_SEARCH_VALID_TABS.has(tab)) return;
  _searchTab = tab;
  document.querySelectorAll('.search-tab').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tab === tab);
  });
  _renderSearchResults(_searchLastQuery);
}

function openGlobalSearch() {
  const overlay = document.getElementById('search-overlay');
  if (!overlay) return;
  overlay.style.display = '';
  const input = document.getElementById('search-input');
  if (input) {
    input.value = '';
    _searchResults = [];
    _searchActiveIdx = -1;
    _searchLastQuery = '';
    _searchSeq++;    // invalidate any in-flight query from a previous session
    _setSearchTab('all');           // reset to default tab each open
    _setSearchTabsVisible(false);   // hide tabs while empty/history state is shown
    setTimeout(() => input.focus(), 30);
    _renderSearchEmptyState();
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
  overlay.style.display = 'none';
  if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
}

function _scheduleSearch(query) {
  if (_searchTimer) clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => _runSearchNow(query), 150);
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

async function _runSearchNow(queryArg) {
  const input = document.getElementById('search-input');
  const query = (queryArg !== undefined ? queryArg : (input?.value || '')).trim();
  if (!query) { _setSearchTabsVisible(false); _renderSearchEmptyState(); return; }
  const seq = ++_searchSeq;
  try {
    const projectId = _activeProjectIdForSearch();
    const res = await apiFetch('/api/search/global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        scope: 'all',
        limit: _SEARCH_FETCH_LIMIT,
        ...(projectId ? { projectId } : {}),
      }),
    });
    const data = await res.json();
    if (seq !== _searchSeq) return;     // a newer query arrived; drop this
    if (!data.ok) { _renderSearchError(data.error); return; }
    _searchResults = data.results || [];
    _searchLastQuery = query;
    _setSearchTabsVisible(true);
    _renderSearchResults(query);
  } catch (e) {
    if (seq !== _searchSeq) return;
    _renderSearchError(e.message || String(e));
  }
}

// Split results into 4 buckets per the tab-grouping spec:
//   - chats:    main-conversation messages, sorted by time DESC (recency)
//   - agents:   agent body matches, sorted by score DESC then name
//   - skills:   skill body matches, sorted by score DESC then name
//   - contexts: KB path matches, sorted by directory depth ASC then path
// Skill/agent EDIT conversations were removed from search — only the
// main-conversation jsonls feed the chats bucket.
function _partitionSearchResults(results) {
  const chats = results
    .filter((r) => r.kind === 'chat')
    .slice()
    .sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
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
      const pa = String(a.path || ''); const pb = String(b.path || '');
      const da = pa.split('/').length; const db = pb.split('/').length;
      if (da !== db) return da - db;
      return pa.localeCompare(pb);
    });
  return { chats, agents, skills, contexts };
}

function _renderSearchEmptyState() {
  const body = document.getElementById('search-body');
  if (!body) return;
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
  body.innerHTML = historyHtml || `<div class="search-empty">${escapeHtml(t('search.empty_hint'))}</div>`;
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
  } else if (r.kind === 'agent' || r.kind === 'skill') {
    title = r.name || r.id;
    const source = (typeof normalizeCatalogSource === 'function') ? normalizeCatalogSource(r.source) : r.source;
    const srcKey = _SEARCH_SOURCE_LABEL[source] || _SEARCH_SOURCE_LABEL[r.source] || '';
    sub = srcKey ? t(srcKey) : '';
  }
  const active = dataIdx === _searchActiveIdx ? ' active' : '';
  return `
    <div class="search-result${active}" data-idx="${dataIdx}">
      <div class="search-result-head">
        <span class="search-result-kind ${metaCfg.cls}">${escapeHtml(label)}</span>
        <span class="search-result-title">${escapeHtml(title)}</span>
        ${projectChip}
        <span class="search-result-meta">${escapeHtml(sub)}</span>
      </div>
      <div class="search-result-snippet">${_highlightSnippet(r.snippet, query)}</div>
    </div>`;
}

// Currently rendered (post-filter, post-slice) results in flat order so the
// dataIdx → result lookup for click/arrow/Enter is O(1). Rebuilt on every
// render. Think of `_searchResults` as "raw server output" and
// `_searchVisibleResults` as "what the user sees".
let _searchVisibleResults = [];

function _renderSearchResults(query) {
  const body = document.getElementById('search-body');
  if (!body) return;
  if (!_searchResults.length) {
    _searchVisibleResults = [];
    body.innerHTML = `<div class="search-empty">${escapeHtml(t('search.no_results', { query }))}</div>`;
    return;
  }
  const { chats, agents, skills, contexts } = _partitionSearchResults(_searchResults);
  const parts = [];
  const visible = [];

  // "All" tab order: chats → agents → skills → Library; each
  // section caps at _SEARCH_ALL_PER_SECTION rows, with overflow
  // surfacing a "view more" button that jumps to the matching tab.
  // Other tabs render their own section only (no cap, so the user can
  // scroll through everything).
  const sections = [
    { tab: 'chat',    bucket: chats,    labelKey: 'search.section.chat' },
    { tab: 'agent',   bucket: agents,   labelKey: 'search.section.agent' },
    { tab: 'skill',   bucket: skills,   labelKey: 'search.section.skill' },
    { tab: 'context', bucket: contexts, labelKey: 'search.section.context' },
  ];
  for (const s of sections) {
    if (_searchTab !== 'all' && _searchTab !== s.tab) continue;
    const slice = _searchTab === 'all' ? s.bucket.slice(0, _SEARCH_ALL_PER_SECTION) : s.bucket;
    if (!slice.length) continue;
    parts.push(`<div class="search-section-label">${escapeHtml(t(s.labelKey))}</div>`);
    for (const r of slice) { parts.push(_renderSearchRow(r, visible.length, query)); visible.push(r); }
    if (_searchTab === 'all' && s.bucket.length > slice.length) {
      parts.push(`<button class="search-show-more" data-goto="${s.tab}">${escapeHtml(t('search.show_more'))} (${s.bucket.length})</button>`);
    }
  }

  _searchVisibleResults = visible;
  if (!visible.length) {
    body.innerHTML = `<div class="search-empty">${escapeHtml(t('search.no_results', { query }))}</div>`;
    _searchActiveIdx = -1;
    return;
  }
  // Clamp active idx into range of the new visible list.
  _searchActiveIdx = Math.min(Math.max(_searchActiveIdx, 0), visible.length - 1);
  body.innerHTML = parts.join('');

  body.querySelectorAll('.search-result').forEach((row) => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.idx, 10);
      _searchActiveIdx = idx;
      _gotoSearchResult(_searchVisibleResults[idx]);
    });
  });
  body.querySelectorAll('.search-show-more').forEach((btn) => {
    btn.addEventListener('click', () => _setSearchTab(btn.dataset.goto));
  });
}

function _onSearchKey(e) {
  // Skip every shortcut while an IME composition is active (pinyin / kana /
  // hangul input). Without this guard, pressing Enter to commit an English
  // candidate from the IME panel — common when the primary suggestion is
  // already an English word — is interpreted as "submit the active result"
  // and navigates away mid-typing. Arrow keys are also IME-owned during
  // composition (they move the candidate cursor), so the same guard
  // prevents them from moving our selection. Mirrors `conversation.js` /
  // `state.js` chat input handlers (`!e.isComposing` + keyCode 229 belt-
  // and-suspenders for older Electron / Safari).
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _moveSearchSelection(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _moveSearchSelection(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (_searchActiveIdx >= 0 && _searchVisibleResults[_searchActiveIdx]) {
      _gotoSearchResult(_searchVisibleResults[_searchActiveIdx]);
    }
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
  closeGlobalSearch();
  if (r.kind === 'context') {
    if (r.library_scope === 'project' && r.project_id) {
      setView('project', r.project_id);
      setTimeout(async () => {
        try {
          const res = await window.orkas.invoke('projects.files.absPath', { projectId: r.project_id, name: r.path });
          if (res && res.ok && typeof openChatFileViewer === 'function') {
            openChatFileViewer(res.path, r.title || r.path, { projectId: r.project_id });
          }
        } catch (_) { /* navigation best-effort */ }
      }, 120);
      return;
    }
    setView('contexts');
    const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    if (typeof loader === 'function') await loader('contexts');
    if (typeof loadContexts === 'function') await loadContexts();
    if (typeof openCtxFile === 'function') openCtxFile(r.path);
  } else if (r.kind === 'chat') {
    setView('conversation', r.cid);
    // Scroll to the matched message after history loads.
    setTimeout(() => _scrollToMsgIndex('chat-history', r.msg_index), 300);
  } else if (r.kind === 'agent') {
    // Open the agent detail view in read mode. Edit mode is intentionally
    // NOT auto-toggled — the user is looking up "this agent", not editing.
    setView('agents');
    setTimeout(async () => {
      if (typeof _showAgentsDetailView === 'function') {
        await _showAgentsDetailView(r.id);
      }
    }, 100);
  } else if (r.kind === 'skill') {
    setView('skills');
    const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    if (typeof loader === 'function') await loader('skills');
    if (typeof loadSkills === 'function') await loadSkills();
    const cached = (typeof _skillsCache !== 'undefined' && Array.isArray(_skillsCache))
      ? _skillsCache.find((s) => s.id === r.id)
      : null;
    if (cached && typeof _showSkillsDetailView === 'function') {
      await _showSkillsDetailView(cached.source, cached.id);
    } else if (typeof _showSkillsDetailView === 'function') {
      // Cache may not be primed yet — fall back to the search result's own
      // source field so we still land on the right card.
      await _showSkillsDetailView(r.source, r.id);
    }
  }
}

function _scrollToMsgIndex(containerId, idx) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const items = container.querySelectorAll('.chat-message');
  const target = items[idx];
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('search-flash');
  setTimeout(() => target.classList.remove('search-flash'), 1600);
}

function _loadSearchHistory() {
  try {
    const raw = localStorage.getItem(_SEARCH_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function _saveSearchHistory(arr) {
  try { localStorage.setItem(_SEARCH_HISTORY_KEY, JSON.stringify(arr)); } catch {}
}

function _saveSearchHistoryEntry(query) {
  const q = (query || '').trim();
  if (!q) return;
  const cur = _loadSearchHistory().filter((x) => x !== q);
  cur.unshift(q);
  _saveSearchHistory(cur.slice(0, _SEARCH_HISTORY_MAX));
}
