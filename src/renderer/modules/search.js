// ─── Global search (Cmd+K) ───────────────────────────────────────────────
// Live-search the knowledge base + chat history (per-user). Results are
// grouped by kind; clicking one navigates to the source. Search history is
// persisted in localStorage per user.

const _SEARCH_HISTORY_KEY = 'search_history';
const _SEARCH_HISTORY_MAX = 12;
const _SEARCH_FETCH_LIMIT = 200;   // backend cap; we filter/slice locally per tab
const _SEARCH_ALL_PER_SECTION = 10; // "all" tab shows up to N per section, overflow → 查看更多
let _searchTimer = null;
let _searchSeq = 0;
let _searchTab = 'all';             // 'all' | 'chat' | 'context'
let _searchResults = [];
let _searchActiveIdx = -1;
let _searchLastQuery = '';

function _bindGlobalSearch() {
  document.getElementById('sidebar-search-btn')?.addEventListener('click', openGlobalSearch);
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
  // Global Cmd/Ctrl+K shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openGlobalSearch();
    } else if (e.key === 'Escape' && document.getElementById('search-overlay').style.display !== 'none') {
      closeGlobalSearch();
    }
  });
}

function _setSearchTab(tab) {
  if (!tab || (tab !== 'all' && tab !== 'chat' && tab !== 'context')) return;
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

async function _runSearchNow(queryArg) {
  const input = document.getElementById('search-input');
  const query = (queryArg !== undefined ? queryArg : (input?.value || '')).trim();
  if (!query) { _setSearchTabsVisible(false); _renderSearchEmptyState(); return; }
  const seq = ++_searchSeq;
  try {
    const res = await apiFetch('/api/search/global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, scope: 'all', limit: _SEARCH_FETCH_LIMIT }),
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

// Split results into 2 buckets per the tab-grouping spec:
//   - chats: chat + skill_chat + agent_chat, sorted by time DESC
//   - contexts: context kind only, sorted by path-segment count ASC then path alpha
// Chats sort by time (recency is the useful signal); contexts sort by
// "shortest directory path first" so root-level files come before deeply
// nested ones.
function _partitionSearchResults(results) {
  const chats = results
    .filter((r) => r.kind === 'chat' || r.kind === 'skill_chat' || r.kind === 'agent_chat')
    .slice()
    .sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  const contexts = results
    .filter((r) => r.kind === 'context')
    .slice()
    .sort((a, b) => {
      const pa = String(a.path || ''); const pb = String(b.path || '');
      const da = pa.split('/').length; const db = pb.split('/').length;
      if (da !== db) return da - db;
      return pa.localeCompare(pb);
    });
  return { chats, contexts };
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
  context:    { labelKey: 'search.scope.context',    cls: 'is-context' },
  chat:       { labelKey: 'search.scope.chat',       cls: 'is-chat' },
  skill_chat: { labelKey: 'search.scope.skill_chat', cls: 'is-skill' },
  agent_chat: { labelKey: 'search.scope.agent_chat', cls: 'is-agent' },
};

// Render one result into HTML. Uses the shared `_renderSearchRow` helper for
// title/sub/snippet; `dataIdx` is the position within the currently-rendered
// visible list (for keyboard navigation).
function _renderSearchRow(r, dataIdx, query) {
  const metaCfg = _SEARCH_KIND_META[r.kind] || { labelKey: '', cls: '' };
  const label = metaCfg.labelKey ? t(metaCfg.labelKey) : r.kind;
  const roleLabel = (role) => (role === 'user' ? t('search.role.user') : t('search.role.ai'));
  let title = ''; let sub = '';
  if (r.kind === 'context') {
    title = r.title || r.path;
    sub = r.path;
  } else if (r.kind === 'chat') {
    title = r.conv_title || t('chat.new_conv_title');
    sub = `${roleLabel(r.role)} · ${formatTime(r.time || '')}`;
  } else if (r.kind === 'skill_chat') {
    title = r.skill_id;
    sub = `${roleLabel(r.role)} · ${formatTime(r.time || '')}`;
  } else if (r.kind === 'agent_chat') {
    // agent_id is an opaque hex (e.g. "51bc903ae443") — never show that
    // to the user. Resolve through the global agents cache loaded on
    // view-mount; fall back to the id only if the cache hasn't filled.
    const agent = (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache))
      ? _agentsCache.find((a) => a && a.agent_id === r.agent_id)
      : null;
    title = (agent && agent.name) || r.agent_id;
    sub = `${roleLabel(r.role)} · ${formatTime(r.time || '')}`;
  }
  const active = dataIdx === _searchActiveIdx ? ' active' : '';
  return `
    <div class="search-result${active}" data-idx="${dataIdx}">
      <div class="search-result-head">
        <span class="search-result-kind ${metaCfg.cls}">${escapeHtml(label)}</span>
        <span class="search-result-title">${escapeHtml(title)}</span>
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
  const { chats, contexts } = _partitionSearchResults(_searchResults);
  const parts = [];
  const visible = [];

  // "全部" 显示 chats (前 10) + contexts (前 10)，超出给"查看更多"→对应 tab。
  // "对话" 只显示 chats；"知识库" 只显示 contexts。
  if (_searchTab === 'all' || _searchTab === 'chat') {
    const slice = _searchTab === 'all' ? chats.slice(0, _SEARCH_ALL_PER_SECTION) : chats;
    if (slice.length) {
      parts.push(`<div class="search-section-label">${escapeHtml(t('search.section.chat'))}</div>`);
      for (const r of slice) { parts.push(_renderSearchRow(r, visible.length, query)); visible.push(r); }
      if (_searchTab === 'all' && chats.length > slice.length) {
        parts.push(`<button class="search-show-more" data-goto="chat">${escapeHtml(t('search.show_more'))} (${chats.length})</button>`);
      }
    }
  }
  if (_searchTab === 'all' || _searchTab === 'context') {
    const slice = _searchTab === 'all' ? contexts.slice(0, _SEARCH_ALL_PER_SECTION) : contexts;
    if (slice.length) {
      parts.push(`<div class="search-section-label">${escapeHtml(t('search.section.context'))}</div>`);
      for (const r of slice) { parts.push(_renderSearchRow(r, visible.length, query)); visible.push(r); }
      if (_searchTab === 'all' && contexts.length > slice.length) {
        parts.push(`<button class="search-show-more" data-goto="context">${escapeHtml(t('search.show_more'))} (${contexts.length})</button>`);
      }
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

function _gotoSearchResult(r) {
  if (!r) return;
  closeGlobalSearch();
  if (r.kind === 'context') {
    setView('contexts');
    // Defer the file open so the contexts view has mounted its tree first —
    // openCtxFile renders into the viewer pane which only exists after setView.
    setTimeout(() => {
      if (typeof openCtxFile === 'function') openCtxFile(r.path);
    }, 50);
  } else if (r.kind === 'chat') {
    setView('conversation', r.cid);
    // Scroll to the matched message after history loads.
    setTimeout(() => _scrollToMsgIndex('chat-history', r.msg_index), 300);
  } else if (r.kind === 'skill_chat') {
    // Navigate to skills, select that skill, enter edit mode.
    setView('skills');
    setTimeout(async () => {
      const cached = (_skillsCache || []).find((s) => s.id === r.skill_id);
      if (cached && typeof _showSkillsDetailView === 'function') {
        await _showSkillsDetailView(cached.source, cached.id);
        if (typeof toggleSkillEditMode === 'function' && !_skillEditMode) {
          await toggleSkillEditMode();
        }
        setTimeout(() => _scrollToMsgIndex('skills-chat-messages', r.msg_index), 300);
      }
    }, 100);
  } else if (r.kind === 'agent_chat') {
    setView('agents');
    setTimeout(async () => {
      // Use _showAgentsDetailView (not selectAgent) so the grid → detail
      // view swap actually happens — selectAgent only fills the detail
      // pane's content, leaving grid-view on top.
      if (typeof _showAgentsDetailView === 'function') {
        await _showAgentsDetailView(r.agent_id);
        if (typeof toggleAgentEditMode === 'function' && !_agentEditing) {
          await toggleAgentEditMode();
        }
        setTimeout(() => _scrollToMsgIndex('agents-chat-messages', r.msg_index), 300);
      }
    }, 100);
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

