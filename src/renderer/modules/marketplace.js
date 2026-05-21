// ─── Marketplace (full-page panel: grid + detail sub-views) ───
// Browse + install official agents / skills from the Orkas Server. Entered via the "More"
// button on the agents / skills tabs (#agents-more-btn / #skills-more-btn — wired in state.js).
//
// Two sub-views inside panel-marketplace (mirrors the agents / skills panel shape):
//   - grid-view   : tab switcher + categories + card grid
//   - detail-view : per-item content (workflow / SKILL.md + file list) with Install button
//
// Cache contract (see features/marketplace_cache.ts):
//   - Detail-page reads hit the cache first; main fetches via the spec / bundle endpoint when
//     cache stale / missing and writes back. Install reads from cache too.
//   - openMarketplace() runs sweepCache() once on entry — 100 MB / 7d eviction.
//
// Per-card 安装 button (in detail) materializes the cached item into the local
// `data/builtin/{agents,skills}/` tree with a `_marketplace.json` sentinel.
//
// Dev-only upload (`openMarketplaceUpload`) is exposed for agents.js / skills.js (⋯ menu +
// detail-page actions). Category is NO LONGER asked — it lives in the spec now (agent.json
// `category` field / SKILL.md `category` frontmatter).

let _mpState = null;
let _mpBound = false;
let _mpReturnView = 'agents';

// Renderer-side in-memory cache of the category registry. Main also caches in-memory + on disk
// + boots with primeCategoryCache so the very first openMarketplace finds main's cache hot;
// keeping a copy here too avoids paying the IPC roundtrip when the panel reopens within the
// same session. Cleared on i18n-change is unnecessary — the API surface doesn't include the
// translated labels (locale picking happens at render time in _mpCategoryLabel).
// Categories are read on every panel open. Caching at three levels (renderer in-mem ↑↑↑
// localStorage ↑↑ main biz file ↑) so the first openMarketplace after PC launch finds the
// chip strip painted *synchronously* — no IPC roundtrip latency. localStorage is sync and
// available before window.orkas IPC is ready; the in-memory variable is the hot path; the
// async preload below refreshes localStorage in the background.
const MP_CATEGORIES_LS_KEY = 'orkas:mp:categories';
let _mpCategoriesCache = (() => {
  try {
    const raw = localStorage.getItem(MP_CATEGORIES_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
})();

// Installed-state cache (synchronous via localStorage). Without this, every panel open
// waits 1-2s for `agents.list` / `skills.list` IPCs before card buttons can show "已安装";
// users see all cards flash "Install" first. The cache is updated after each successful
// install/uninstall + after every successful background `agents.list` / `skills.list` refresh.
const MP_INSTALLED_LS_KEY = 'orkas:mp:installed';
function _mpLoadInstalledFromLs() {
  try {
    const raw = localStorage.getItem(MP_INSTALLED_LS_KEY);
    if (!raw) return { agentIds: new Set(), skillIds: new Set() };
    const parsed = JSON.parse(raw);
    return {
      agentIds: new Set(Array.isArray(parsed?.agentIds) ? parsed.agentIds : []),
      skillIds: new Set(Array.isArray(parsed?.skillIds) ? parsed.skillIds : []),
    };
  } catch { return { agentIds: new Set(), skillIds: new Set() }; }
}
function _mpPersistInstalled() {
  try {
    localStorage.setItem(MP_INSTALLED_LS_KEY, JSON.stringify({
      agentIds: [..._mpState.installedAgentIds],
      skillIds: [..._mpState.installedSkillIds],
    }));
  } catch { /* ignore */ }
}

// Latest reconcile snapshot pushed from main (boot-time marketplace install reconcile).
// Bootstrap subscription runs at module load — see _mpInitReconcileWatch() — so a hot reconcile
// transitioning to `running` reaches the panel even if the user opens it mid-fetch.
let _mpReconcileStatus = { state: 'idle', total: 0, pulled: 0 };

// Paginated listings cache (cross-process via main `marketplace.{get,set}ListingsCache`).
// Key = `${kind}|${category||''}|${q||''}`. Value:
//   { items, ts, nextPage, exhausted }
// Where `items` accumulates across pages (deduped by id), `nextPage` is the next page-num to
// request on infinite-scroll, and `exhausted` flips true once a /list response is shorter
// than `MP_LISTINGS_PAGE_SIZE` or covers `total`.
//
// SWR semantics (matches user expectation "切 tab/category 仍发请求,只是优先用缓存"):
//   - Switching tab / category / opening panel:
//     * Hydrate cache immediately so the grid renders prior items (no blank flash).
//     * Always re-fetch page 1 in the background to overwrite stale rows.
//   - Infinite scroll: when the sentinel near the grid bottom enters the viewport, fetch
//     page = cached.nextPage and APPEND (dedupe by id) — never overwrite earlier pages.
//   - "All" tab (category = '') feeds rows into per-category cache slots so a subsequent
//     "教育" tab open paints fast. The reverse (cat slot → "All") is NOT done — All needs
//     a fresh time-ordered slice from the server.
const MP_LISTINGS_PAGE_SIZE = 50;
const _mpListingsCache = new Map();
let _mpListingsHydrated = false;
function _mpListingsKey(kind, category, q) { return `${kind}|${category || ''}|${q || ''}`; }

async function _mpHydrateListingsCache() {
  if (_mpListingsHydrated) return;
  _mpListingsHydrated = true;
  try {
    const data = await window.orkas.invoke('marketplace.getListingsCache');
    const entries = data?.entries || {};
    for (const [k, v] of Object.entries(entries)) {
      if (v && Array.isArray(v.items) && typeof v.ts === 'number') {
        _mpListingsCache.set(k, { items: v.items, ts: v.ts });
      }
    }
  } catch { /* no cache yet — first run */ }
}

function _mpPersistListingsCache() {
  // Fire-and-forget: serialization happens in main. Renderer just snapshots the Map.
  const entries = {};
  for (const [k, v] of _mpListingsCache.entries()) entries[k] = v;
  window.orkas.invoke('marketplace.setListingsCache', { entries }).catch(() => { /* ignore */ });
}


function isMarketplaceOpen() {
  return document.getElementById('panel-marketplace')?.classList.contains('active') === true;
}

async function openMarketplace(initialTab = 'agent') {
  const panel = document.getElementById('panel-marketplace');
  if (!panel) return;

  // Kick off the reconcile watcher on first marketplace open (rather than at script load) so
  // we don't fire IPC during early renderer init. Idempotent on later calls.
  _mpInitReconcileWatch();
  // Hydrate persisted listings cache before first render — populates the in-memory Map so
  // `_mpHydrateFromCache` below finds entries even on a cold app start.
  await _mpHydrateListingsCache();

  _mpReturnView = (typeof currentView === 'string' && currentView !== 'marketplace')
    ? currentView : 'agents';

  _mpState = {
    view: 'grid',
    tab: initialTab === 'skill' ? 'skill' : 'agent',
    category: '',
    q: '',
    agents: [],
    skills: [],
    // Pre-populate categories from the renderer cache so the chip strip renders on first
    // paint — no waiting on IPC. If cache is cold, this stays [] and gets filled by _mpLoadAll
    // before the listings come back.
    categories: _mpCategoriesCache || [],
    // Seed installed-state from the localStorage cache so card buttons show the right label
    // on first paint. The IPC `agents.list` / `skills.list` will overwrite once it resolves
    // (and persist the updated set back to localStorage).
    ...(() => {
      const cached = _mpLoadInstalledFromLs();
      return { installedAgentIds: cached.agentIds, installedSkillIds: cached.skillIds };
    })(),
    loading: true,
    installing: new Set(),
    error: '',
    // Detail-view scratchpad
    detailKind: null,
    detailItem: null,
    detailLoading: false,
    detailError: '',
    detailAgentJson: null,
    detailSkillFiles: [],
    detailSkillSelected: 'SKILL.md',
    detailSkillFileText: '',
  };

  if (!_mpBound) {
    _mpBindPanel(panel);
    window.addEventListener('i18n-change', _mpOnI18n);
    document.addEventListener('keydown', _mpKey, true);
    _mpBound = true;
  }

  if (typeof setView === 'function') setView('marketplace');
  _mpShowGridView();
  _mpRender();

  // Best-effort sweep — never block UI on a failure.
  window.orkas.invoke('marketplace.sweepCache').catch(() => { /* ignore */ });

  // Fire-and-forget: `_mpLoadAll` paints cache + fresh data internally via its own
  // `_mpRender` calls. Awaiting here would only delay returning control to the user.
  _mpLoadAll();
}

function closeMarketplace() {
  if (!isMarketplaceOpen()) return;
  if (typeof setView === 'function') setView(_mpReturnView || 'agents');
}

function _mpOnI18n() { if (isMarketplaceOpen()) _mpRender(); }

function _mpKey(e) {
  if (e.key !== 'Escape' || !isMarketplaceOpen()) return;
  if (e.isComposing || e.keyCode === 229) return;
  if (_mpState?.view === 'detail') {
    e.stopPropagation();
    _mpShowGridView();
    _mpRender();
  } else {
    closeMarketplace();
  }
}

function _mpShowGridView() {
  document.getElementById('marketplace-grid-view').style.display = '';
  document.getElementById('marketplace-detail-view').style.display = 'none';
  if (_mpState) _mpState.view = 'grid';
}

function _mpShowDetailView() {
  document.getElementById('marketplace-grid-view').style.display = 'none';
  document.getElementById('marketplace-detail-view').style.display = '';
  if (_mpState) _mpState.view = 'detail';
}

// Initialize on module load: snapshot current state via IPC, then subscribe to push-events.
// Order matters — if we subscribed first the snapshot could land before the push handler is
// attached and we'd miss in-flight progress. Idempotent: only the first call performs setup.
let _mpReconcileWatchStarted = false;
async function _mpInitReconcileWatch() {
  if (_mpReconcileWatchStarted) return;
  _mpReconcileWatchStarted = true;
  try {
    const initial = await window.orkas.invoke('marketplace.reconcileStatus');
    if (initial) _mpReconcileStatus = initial;
  } catch { /* main not ready yet — push event will fill us in */ }
  try {
    let lastState = _mpReconcileStatus.state;
    window.orkas.onPushEvent('marketplace:reconcile-status', (status) => {
      if (!status) return;
      const prevState = lastState;
      _mpReconcileStatus = status;
      lastState = status.state;
      // Auto-hide a finished banner after 3s so a successful reconcile doesn't linger.
      if (status.state === 'done') {
        setTimeout(() => {
          if (_mpReconcileStatus === status) {
            _mpReconcileStatus = { ...status, state: 'idle' };
            _mpUpdateReconcileBanner();
          }
        }, 3000);
      }
      _mpUpdateReconcileBanner();
      // Reconcile just pulled new content into install dirs. Refresh the agents / skills /
      // marketplace-installed-state caches so the new items appear without the user having to
      // switch tabs. Force re-fetch (loadAgents(true) / loadSkills(true)) bypasses the renderer
      // module-level lists cache; the marketplace listed-state hydrates from those.
      if (status.state === 'done' && prevState === 'running' && status.pulled > 0) {
        try { if (typeof loadAgents === 'function') loadAgents(true); } catch { /* ignore */ }
        try { if (typeof loadSkills === 'function') loadSkills(true); } catch { /* ignore */ }
        // If marketplace panel is open right now, also re-run the install-state hydration
        // so card buttons flip from "安装" to "已安装" without a tab switch.
        if (isMarketplaceOpen()) _mpLoadAll();
      }
    });
  } catch { /* push channel not allowed (shouldn't happen) — silently degrade to no banner */ }
}

// Updates ALL banners with `data-reconcile-banner` (marketplace panel + agents-grid-view +
// skills-grid-view). User opens any of those tabs during reconcile → sees same status, no
// "panel looks empty, what happened" confusion. Each panel embeds its own banner div via
// HTML so we don't have to manage DOM insertion / removal.
function _mpUpdateReconcileBanner() {
  const banners = document.querySelectorAll('[data-reconcile-banner]');
  if (!banners.length) return;
  const s = _mpReconcileStatus;
  let text = '';
  let visible = false;
  if (s.state === 'running') {
    visible = true;
    text = t('marketplace.reconcile_running')
      .replace('{pulled}', String(s.pulled))
      .replace('{total}', String(s.total));
  } else if (s.state === 'done' && (s.failed || []).length > 0) {
    visible = true;
    text = t('marketplace.reconcile_partial').replace('{failed}', String(s.failed.length));
  }
  for (const banner of banners) {
    banner.style.display = visible ? '' : 'none';
    banner.textContent = text;
  }
}

function _mpBindPanel(panel) {
  // Inject a banner inside the marketplace grid header if one isn't there yet. The agents /
  // skills panels have their own static `[data-reconcile-banner]` in index.html; this just
  // covers the marketplace panel which historically didn't.
  if (!panel.querySelector('[data-reconcile-banner]')) {
    const banner = document.createElement('div');
    banner.className = 'marketplace-reconcile-banner';
    banner.setAttribute('data-reconcile-banner', '');
    banner.style.display = 'none';
    const host = panel.querySelector('[data-mp-categories]')?.parentElement || panel;
    host.insertBefore(banner, host.firstChild);
    _mpUpdateReconcileBanner();
  }

  panel.querySelectorAll('[data-mp-close]').forEach((btn) =>
    btn.addEventListener('click', closeMarketplace),
  );
  panel.querySelectorAll('[data-mp-detail-back]').forEach((btn) =>
    btn.addEventListener('click', () => { _mpShowGridView(); _mpRender(); }),
  );
  panel.querySelectorAll('[data-mp-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!_mpState) return;
      _mpState.tab = btn.dataset.mpTab;
      _mpState.category = '';
      _mpRender();
    });
  });
  const search = panel.querySelector('[data-mp-search]');
  if (search) {
    search.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        const next = search.value.trim();
        if (next === _mpState.q) return;
        _mpState.q = next;
        _mpRefreshListings();
      }
    });
  }
  panel.querySelector('[data-mp-detail-install]')?.addEventListener('click', _mpInstallFromDetail);
  // Dev-only delete button click handler is bound by marketplace_dev.js (file absent in
  // OrkasOpen). HTML element ships in index.html with display:none — dev module flips it
  // on via the `onMarketplaceDetailRendered` hook (see below).
}

async function _mpLoadAll() {
  // SWR open: paint cache immediately so the grid never goes blank between IPC roundtrips.
  // Even when the TTL has elapsed (dev mode TTL=0 always fires a refresh), the user sees the
  // stale list right away — fresh data swaps in once the background fetch lands.
  const hadCache = _mpHydrateFromCache();
  _mpState.loading = !hadCache;
  _mpState.error = '';
  if (_mpCategoriesCache) _mpState.categories = _mpCategoriesCache;
  // First paint with whatever we already know — categories from the renderer cache (set on
  // a prior session if it ran), listings from the hydrated cache. Avoids the "wait for the
  // IPC roundtrip before showing anything" flash that broke the cache-first promise.
  _mpRender();

  try {
    const tasks = [
      window.orkas.invoke('agents.list'),
      window.orkas.invoke('skills.list'),
    ];
    if (!_mpCategoriesCache) {
      tasks.push(window.orkas.invoke('marketplace.categories', {}));
    }
    const results = await Promise.all(tasks);
    const instAgents = results[0];
    const instSkills = results[1];
    if (!_mpCategoriesCache && results[2]) {
      _mpCategoriesCache = (results[2] && results[2].list) || [];
      _mpState.categories = _mpCategoriesCache;
      _mpPersistCategoriesCache(_mpCategoriesCache);
    }
    _mpState.installedAgentIds = new Set(((instAgents && instAgents.agents) || []).map((a) => a.agent_id));
    _mpState.installedSkillIds = new Set(((instSkills && instSkills.skills) || []).map((s) => s.id));
    _mpPersistInstalled();
    await _mpLoadListings();
  } catch (err) {
    // Background-refresh failure must NOT wipe what's already on screen. Only surface as a
    // body-level error when we never managed to paint any cached items in the first place;
    // otherwise log + keep the stale view (matches SWR semantics).
    console.warn('marketplace background fetch failed:', err);
    if (!hadCache && _mpState.agents.length === 0 && _mpState.skills.length === 0) {
      _mpState.error = (err && err.message) || String(err);
    }
  } finally {
    _mpState.loading = false;
    _mpRender();
  }
}

function _mpPersistCategoriesCache(list) {
  try { localStorage.setItem(MP_CATEGORIES_LS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

// Module-load: kick off the reconcile-status watch so the banner in `agents-grid-view` /
// `skills-grid-view` lights up DURING boot reconcile, not only after the user enters
// marketplace. Idempotent — `_mpInitReconcileWatch` runs once and a second call no-ops.
setTimeout(() => { _mpInitReconcileWatch().catch(() => {}); }, 0);

// Module-level background refresh of categories. We already have whatever was in localStorage
// (set when the module evaluated). This refresh keeps the cache current with the server
// without ever blocking the UI — fire-and-forget; failures keep the localStorage copy.
(function _mpPreloadCategories() {
  try {
    window.orkas.invoke('marketplace.categories', {}).then((r) => {
      const list = (r && r.list) || [];
      if (list.length) {
        _mpCategoriesCache = list;
        _mpPersistCategoriesCache(list);
      }
    }).catch(() => { /* ignore */ });
  } catch { /* preload happens at script load; window.orkas not ready is OK */ }
})();

// Top-level listings refresh: hydrate cache → render immediately if hit, then background
// fetch + re-render. The single entry point for category-chip clicks and the search Enter
// handler so the loading-state / cache-hit decision lives in one place.
async function _mpRefreshListings() {
  const hadCache = _mpHydrateFromCache();
  _mpState.loading = !hadCache;
  _mpRender();
  await _mpLoadListings();
  _mpState.loading = false;
  _mpRender();
}

// Generation token: every call to a load fn bumps `_loadGen`; only responses from the
// latest gen get applied. Prevents stale responses (tab / category / search switched
// mid-flight) from overwriting current state.
function _mpHydrateFromCache() {
  const cat = _mpState.category, q = _mpState.q;
  const cachedA = _mpListingsCache.get(_mpListingsKey('agent', cat, q));
  const cachedS = _mpListingsCache.get(_mpListingsKey('skill', cat, q));
  if (cachedA) _mpState.agents = cachedA.items;
  if (cachedS) _mpState.skills = cachedS.items;
  return !!(cachedA || cachedS);
}

// Spread rows pulled from the "All" tab (category='') into each row's own category cache
// slot. One-way: All → per-category. The reverse would corrupt the time-ordered "All" view.
function _mpSpreadAllIntoCategoryCaches(kind, rows, q) {
  if (!rows.length) return;
  const byCat = new Map();
  for (const row of rows) {
    const c = String(row.category || '').trim();
    if (!c) continue;
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(row);
  }
  for (const [cat, catRows] of byCat) {
    const key = _mpListingsKey(kind, cat, q);
    const existing = _mpListingsCache.get(key);
    const items = existing ? existing.items.slice() : [];
    const seen = new Set(items.map((x) => x.id));
    for (const r of catRows) if (!seen.has(r.id)) items.push(r);
    items.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    _mpListingsCache.set(key, {
      items,
      ts: existing?.ts || Date.now(),
      nextPage: existing?.nextPage || 1,
      // We didn't fully scan this category, so a real category-tab fetch is still allowed.
      exhausted: existing?.exhausted || false,
    });
  }
}

// Fetch one page of (kind, category, q). `append=false` overwrites the cache slot (page 1
// reload on tab/category switch). `append=true` extends the existing items (infinite scroll).
// Per-kind gen token: agent and skill fetches run in parallel from `_mpLoadListings`; a single
// shared counter would have the second sync-prefix bump invalidating the first kind's response.
async function _mpLoadListingsPage(kind, { append, page }) {
  if (!_mpState._loadGen) _mpState._loadGen = { agent: 0, skill: 0 };
  const myGen = ++_mpState._loadGen[kind];
  const cat = _mpState.category, q = _mpState.q;
  const key = _mpListingsKey(kind, cat, q);
  const channel = kind === 'agent' ? 'marketplace.listAgents' : 'marketplace.listSkills';
  try {
    const r = await window.orkas.invoke(channel, {
      category: cat || null, q: q || null, page, size: MP_LISTINGS_PAGE_SIZE,
    });
    if (_mpState._loadGen[kind] !== myGen) return;
    const rows = (r && r.list) || [];
    const total = (r && r.total) || 0;
    // exhausted when the row count returned is short of the page size, or we've covered total.
    const exhausted = rows.length < MP_LISTINGS_PAGE_SIZE || (page * MP_LISTINGS_PAGE_SIZE >= total);
    const existing = _mpListingsCache.get(key);
    let merged;
    if (append && existing) {
      const seen = new Set(existing.items.map((x) => x.id));
      const dedup = rows.filter((x) => !seen.has(x.id));
      merged = existing.items.concat(dedup);
    } else {
      merged = rows;
    }
    _mpListingsCache.set(key, {
      items: merged, ts: Date.now(), nextPage: page + 1, exhausted,
    });
    if (kind === 'agent') _mpState.agents = merged;
    else _mpState.skills = merged;
    // "All" tab feeds per-category caches one-way.
    if (!cat) _mpSpreadAllIntoCategoryCaches(kind, rows, q);
    _mpPersistListingsCache();
  } catch (err) {
    if (_mpState._loadGen[kind] !== myGen) return;
    console.warn('marketplace listings fetch failed:', err);
    if (_mpState.agents.length === 0 && _mpState.skills.length === 0) {
      _mpState.error = (err && err.message) || String(err);
    }
  }
}

// Convenience: SWR-reload page 1 for both kinds (called from openMarketplace + tab/category
// switch + search submit). Cache hydration happened in the caller.
async function _mpLoadListings() {
  await Promise.all([
    _mpLoadListingsPage('agent', { append: false, page: 1 }),
    _mpLoadListingsPage('skill', { append: false, page: 1 }),
  ]);
}

// Infinite scroll trigger — pulls the next page for the currently-visible kind.
let _mpLoadMoreInflight = false;
async function _mpLoadMoreCurrentKind() {
  if (_mpLoadMoreInflight) return;
  const kind = _mpState.tab;
  const cat = _mpState.category, q = _mpState.q;
  const cached = _mpListingsCache.get(_mpListingsKey(kind, cat, q));
  if (!cached || cached.exhausted) return;
  _mpLoadMoreInflight = true;
  try {
    await _mpLoadListingsPage(kind, { append: true, page: cached.nextPage || 2 });
    _mpRender();
  } finally {
    _mpLoadMoreInflight = false;
  }
}

// ─── Grid view rendering ───
function _mpRender() {
  const panel = document.getElementById('panel-marketplace');
  if (!panel || !_mpState) return;
  if (_mpState.view === 'detail') { _mpRenderDetail(); return; }

  const lang = getLang();
  for (const btn of panel.querySelectorAll('[data-mp-tab]')) {
    btn.textContent = btn.dataset.mpTab === 'agent' ? t('marketplace.tab_agent') : t('marketplace.tab_skill');
    btn.classList.toggle('is-active', btn.dataset.mpTab === _mpState.tab);
  }
  const searchEl = panel.querySelector('[data-mp-search]');
  if (searchEl) searchEl.setAttribute('placeholder', t('marketplace.search_ph'));

  const cats = _mpState.categories;
  const chips = [
    `<button type="button" class="marketplace-chip${_mpState.category === '' ? ' is-active' : ''}" data-mp-cat="">${escapeHtml(t('marketplace.all'))}</button>`,
    ...cats.map((c) => {
      const label = lang === 'zh' ? (c.name_zh || c.name_en || c.code) : (c.name_en || c.name_zh || c.code);
      const active = _mpState.category === c.code ? ' is-active' : '';
      return `<button type="button" class="marketplace-chip${active}" data-mp-cat="${escapeHtml(c.code)}">${escapeHtml(label)}</button>`;
    }),
  ].join('');
  const catsEl = panel.querySelector('[data-mp-categories]');
  catsEl.innerHTML = chips;
  catsEl.querySelectorAll('[data-mp-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _mpState.category = btn.dataset.mpCat || '';
      _mpRefreshListings();
    });
  });

  const body = panel.querySelector('[data-mp-body]');
  if (_mpState.loading) {
    body.innerHTML = `
      <div class="marketplace-detail-loading">
        <div class="marketplace-upload-spinner"></div>
        <div class="marketplace-detail-loading-text">${escapeHtml(t('marketplace.list_loading'))}</div>
      </div>
    `;
    return;
  }
  if (_mpState.error) {
    body.innerHTML = `<div class="empty">${escapeHtml(t('marketplace.load_failed'))}: ${escapeHtml(_mpState.error)}</div>`;
    return;
  }
  // Order = server-side `updated_at DESC` (newest first). No further client sort — the
  // accumulator in `_mpLoadListingsPage` preserves the server's slicing.
  const items = (_mpState.tab === 'agent' ? _mpState.agents : _mpState.skills);
  if (items.length === 0) {
    body.innerHTML = `<div class="empty">${escapeHtml(t('marketplace.empty'))}</div>`;
    return;
  }
  // Render grid + a trailing sentinel — the sentinel sits one card-height below the visible
  // grid end, IntersectionObserver fires `_mpLoadMoreCurrentKind` when it enters the viewport.
  body.innerHTML = `
    <div class="marketplace-grid">${items.map((it) => _mpCardHtml(it, lang)).join('')}</div>
    <div class="mp-load-more-sentinel" data-mp-sentinel aria-hidden="true"></div>
  `;
  body.querySelectorAll('.marketplace-card').forEach((card) => {
    const id = card.dataset.id;
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-mp-install]')) {
        e.stopPropagation();
        _mpInstall(_mpState.tab, id);
      } else {
        const item = (_mpState.tab === 'agent' ? _mpState.agents : _mpState.skills).find((x) => x.id === id);
        if (item) _mpOpenDetail(_mpState.tab, item);
      }
    });
  });
  _mpAttachInfiniteScroll(body);
}

// IntersectionObserver-based infinite scroll. The sentinel sits ~300px below the last
// rendered card (one card-height of preload margin), so the next page fires while the user
// still has one card visible on screen. Re-attached on every `_mpRender` because the
// sentinel node is recreated each render — single observer, no leaks.
let _mpScrollObserver = null;
function _mpAttachInfiniteScroll(body) {
  if (_mpScrollObserver) _mpScrollObserver.disconnect();
  const sentinel = body.querySelector('[data-mp-sentinel]');
  if (!sentinel) return;
  _mpScrollObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) _mpLoadMoreCurrentKind();
  }, { root: body, rootMargin: '0px 0px 300px 0px' });
  _mpScrollObserver.observe(sentinel);
}

function _mpCardHtml(item, lang) {
  const kind = _mpState.tab;
  const installed = (kind === 'agent' ? _mpState.installedAgentIds : _mpState.installedSkillIds).has(item.id);
  const installing = _mpState.installing.has(`${kind}:${item.id}`);
  const desc = pickDesc(item, lang) || '';
  const catLabel = _mpCategoryLabel(item.category, lang);
  const versionLabel = t('marketplace.version').replace('{version}', String(item.version || ''));
  const avatar = kind === 'agent'
    ? renderAvatarHtml(item.icon, item.color, { size: 32, seed: item.id, extraClass: 'marketplace-card-avatar' })
    : '';
  let btnClass = 'btn btn-sm btn-primary';
  let btnLabel = t('marketplace.install');
  let btnAttrs = `data-mp-install="${escapeHtml(kind)}" data-mp-id="${escapeHtml(item.id)}"`;
  let btnSpinner = '';
  if (installed) { btnClass = 'btn btn-sm is-disabled'; btnLabel = t('marketplace.installed'); btnAttrs = 'disabled'; }
  else if (installing) {
    btnClass = 'btn btn-sm is-disabled'; btnLabel = t('marketplace.installing'); btnAttrs = 'disabled';
    btnSpinner = '<span class="marketplace-btn-spinner"></span>';
  }
  return `
    <div class="marketplace-card" data-id="${escapeHtml(item.id)}">
      <div class="marketplace-card-header">
        ${avatar}
        <span class="marketplace-card-name">${escapeHtml(item.name || item.id)}</span>
      </div>
      <div class="marketplace-card-desc">${escapeHtml(desc)}</div>
      <div class="marketplace-card-footer">
        <div class="marketplace-card-meta">
          ${item.version ? `<span class="marketplace-card-chip is-version">${escapeHtml(versionLabel)}</span>` : ''}
          ${catLabel ? `<span class="marketplace-card-chip">${escapeHtml(catLabel)}</span>` : ''}
          ${_mpAuthorBadgeHtml(item.create_uid)}
        </div>
        <div class="marketplace-card-actions">
          <button type="button" class="${btnClass}" ${btnAttrs}>${btnSpinner}${escapeHtml(btnLabel)}</button>
        </div>
      </div>
    </div>
  `;
}

/** Author badge — distinguishes same-name uploads by different authors. uid=0 is the
 *  "Platform" marker (官方制作); everything else falls back to a truncated uid. */
function _mpAuthorBadgeHtml(createUid) {
  if (!createUid) return '';
  const label = String(createUid) === '0'
    ? t('marketplace.author_platform')
    : t('marketplace.author_user').replace('{uid}', String(createUid));
  const cls = String(createUid) === '0' ? 'marketplace-card-chip is-platform' : 'marketplace-card-chip is-user';
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

function _mpCategoryLabel(code, lang) {
  if (!code) return '';
  const c = _mpState.categories.find((x) => x.code === code);
  if (!c) return code;
  return lang === 'zh' ? (c.name_zh || c.name_en || code) : (c.name_en || c.name_zh || code);
}

// ─── Detail view rendering ───
async function _mpOpenDetail(kind, item) {
  _mpState.detailKind = kind;
  _mpState.detailItem = item;
  _mpState.detailLoading = true;
  _mpState.detailError = '';
  _mpState.detailAgentJson = null;
  _mpState.detailSkillFiles = [];
  _mpState.detailSkillSelected = 'SKILL.md';
  _mpState.detailSkillFileText = '';
  _mpShowDetailView();
  _mpRenderDetail();

  try {
    if (kind === 'agent') {
      const detail = await window.orkas.invoke('marketplace.detailAgent', {
        id: item.id, version: item.version, published_at: item.published_at,
      });
      if (!detail || detail.ok === false) throw new Error((detail && detail.error) || 'detail failed');
      _mpState.detailAgentJson = detail.agent_json;
    } else {
      const detail = await window.orkas.invoke('marketplace.detailSkill', {
        id: item.id, version: item.version, published_at: item.published_at,
      });
      if (!detail || detail.ok === false) throw new Error((detail && detail.error) || 'detail failed');
      const files = await window.orkas.invoke('marketplace.cacheSkillFiles', { id: item.id });
      _mpState.detailSkillFiles = (files && files.list) || [];
      if (_mpState.detailSkillFiles.find((f) => f.path === 'SKILL.md')) {
        const r = await window.orkas.invoke('marketplace.cacheSkillRead', { id: item.id, file: 'SKILL.md' });
        _mpState.detailSkillFileText = (r && r.content) || '';
      }
    }
  } catch (err) {
    _mpState.detailError = (err && err.message) || String(err);
  } finally {
    _mpState.detailLoading = false;
    _mpRenderDetail();
  }
}

function _mpRenderDetail() {
  const panel = document.getElementById('panel-marketplace');
  if (!panel || !_mpState) return;
  const item = _mpState.detailItem;
  const kind = _mpState.detailKind;
  if (!item || !kind) return;

  const lang = getLang();
  const desc = pickDesc(item, lang) || '';
  const catLabel = _mpCategoryLabel(item.category, lang);
  const versionLabel = t('marketplace.version').replace('{version}', String(item.version || ''));
  const installed = (kind === 'agent' ? _mpState.installedAgentIds : _mpState.installedSkillIds).has(item.id);
  const installing = _mpState.installing.has(`${kind}:${item.id}`);

  // Avatar slot — only agents have icon/color; skill detail keeps the slot empty so the
  // back-button + name still align horizontally.
  const avatarSlot = panel.querySelector('[data-mp-detail-avatar]');
  if (avatarSlot) {
    if (kind === 'agent') {
      avatarSlot.innerHTML = renderAvatarHtml(item.icon, item.color, {
        size: 32, seed: item.id, extraClass: 'marketplace-detail-avatar',
      });
      avatarSlot.style.display = '';
    } else {
      avatarSlot.innerHTML = '';
      avatarSlot.style.display = 'none';
    }
  }
  // Name + version share a row; category / author chips drop to the meta-row below.
  panel.querySelector('[data-mp-detail-name]').innerHTML = `
    ${escapeHtml(item.name || item.id)}
    <span class="marketplace-detail-version">${escapeHtml(versionLabel)}</span>
  `;
  panel.querySelector('[data-mp-detail-meta]').innerHTML = [
    catLabel ? `<span class="marketplace-card-chip">${escapeHtml(catLabel)}</span>` : '',
    _mpAuthorBadgeHtml(item.create_uid),
  ].filter(Boolean).join(' ');
  // (description used to render in a top-of-body `.marketplace-detail-desc` strip; now it's
  // the first section inside body — see `_mpAgentDetailHtml` / `_mpSkillDetailHtml`)

  const installBtn = panel.querySelector('[data-mp-detail-install]');
  installBtn.dataset.id = item.id;
  installBtn.dataset.kind = kind;
  // When installed, repurpose the primary button as "卸载" (local-only uninstall — does NOT
  // touch the server row). When installing/uninstalling, disabled with progress text + inline
  // spinner so the user sees "still working" instead of a static label.
  const spinnerHtml = '<span class="marketplace-btn-spinner"></span>';
  if (installing) {
    const label = _mpState.uninstalling?.has(`${kind}:${item.id}`)
      ? t('marketplace.uninstalling') : t('marketplace.installing');
    installBtn.innerHTML = `${spinnerHtml}${escapeHtml(label)}`;
    installBtn.classList.add('is-disabled'); installBtn.disabled = true;
    installBtn.dataset.action = '';
  } else if (installed) {
    installBtn.textContent = t('marketplace.uninstall');
    installBtn.classList.remove('is-disabled', 'btn-primary');
    installBtn.classList.add('btn-danger');
    installBtn.disabled = false;
    installBtn.dataset.action = 'uninstall';
  } else {
    installBtn.textContent = t('marketplace.install');
    installBtn.classList.remove('is-disabled', 'btn-danger');
    installBtn.classList.add('btn-primary');
    installBtn.disabled = false;
    installBtn.dataset.action = 'install';
  }

  // Dev-only delete button is rendered + revealed by marketplace_dev.js via the
  // `onMarketplaceDetailRendered` hook below. OrkasOpen has no such file — hook is undefined
  // and the button stays hidden (display:none from HTML).
  if (typeof onMarketplaceDetailRendered === 'function') {
    onMarketplaceDetailRendered({ kind, item });
  }

  const body = panel.querySelector('[data-mp-detail-body]');
  if (_mpState.detailLoading) {
    body.innerHTML = `
      <div class="marketplace-detail-loading">
        <div class="marketplace-upload-spinner"></div>
        <div class="marketplace-detail-loading-text">${escapeHtml(t('marketplace.detail_loading'))}</div>
      </div>
    `;
    return;
  }
  if (_mpState.detailError) {
    body.innerHTML = `<div class="empty">${escapeHtml(t('marketplace.load_failed'))}: ${escapeHtml(_mpState.detailError)}</div>`;
    return;
  }
  if (kind === 'agent') {
    body.innerHTML = _mpAgentDetailHtml(_mpState.detailAgentJson);
  } else {
    body.innerHTML = _mpSkillDetailHtml();
    // File-tree node click → fetch + re-render selected file
    body.querySelectorAll('[data-mp-skill-file]').forEach((el) => {
      el.addEventListener('click', async () => {
        const file = el.dataset.mpSkillFile;
        if (!file) return;
        _mpState.detailSkillSelected = file;
        try {
          const r = await window.orkas.invoke('marketplace.cacheSkillRead', { id: item.id, file });
          _mpState.detailSkillFileText = (r && r.content) || '';
        } catch (err) {
          _mpState.detailSkillFileText = `// load failed: ${(err && err.message) || err}`;
        }
        _mpRenderDetail();
      });
    });
    // Source-tree toggle (collapsed by default, matches app skill detail behavior)
    const toggle = body.querySelector('[data-mp-source-toggle]');
    const panel = body.querySelector('[data-mp-source-panel]');
    if (toggle && panel) {
      // Preserve open state across re-renders via _mpState
      const open = !!_mpState.detailSkillSourceOpen;
      panel.style.display = open ? '' : 'none';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.classList.toggle('is-open', open);
      toggle.addEventListener('click', () => {
        _mpState.detailSkillSourceOpen = !_mpState.detailSkillSourceOpen;
        const next = _mpState.detailSkillSourceOpen;
        panel.style.display = next ? '' : 'none';
        toggle.setAttribute('aria-expanded', String(next));
        toggle.classList.toggle('is-open', next);
      });
    }
  }
}

// Agent body uses the SAME CSS classes as the in-app `panel-agents` detail (Summary + Workflow
// sections + `.markdown-body` for rendered workflow). Marketplace context is read-only browse:
// `inputs` / `skill_list` are user-facing form schema + runtime details (only meaningful AFTER
// install), so we don't render them here — keeps the preview focused on "what does this agent
// do" rather than implementation. Marketplace header above stays in its own compact row layout.
function _mpAgentDetailHtml(agentJson) {
  if (!agentJson) return `<div class="empty">${escapeHtml(t('marketplace.empty'))}</div>`;
  const lang = getLang();
  const desc = pickDesc(agentJson, lang).trim();
  const workflow = String(agentJson.workflow || '').trim();
  const placeholderHtml = `<span class="agents-detail-placeholder">${escapeHtml(t('agents.placeholder_unset') || '—')}</span>`;

  return `<div class="agents-detail-body marketplace-detail-body-inner">
    <div class="agents-detail-section">
      <div class="agents-detail-label">${escapeHtml(t('agents.label_desc') || 'Summary')}</div>
      <div class="agents-detail-desc">${desc ? escapeHtml(desc) : placeholderHtml}</div>
    </div>
    <div class="agents-detail-section agents-detail-section-workflow">
      <div class="agents-detail-label">${escapeHtml(t('agents.label_workflow') || 'Workflow')}</div>
      <div class="agents-detail-workflow markdown-body">${workflow ? renderMarkdownFull(workflow) : placeholderHtml}</div>
    </div>
  </div>`;
}

// Skill body mirrors `panel-skills` detail: a Summary section + a Usage section that contains
// the source-tree (collapsed by default behind a "View source" toggle, matching app behavior)
// and the rendered SKILL.md body. The renderer relies on the SAME `.skills-doc-section` /
// `.skills-source-tree` / `.skills-doc-section-body markdown-body` CSS the app uses.
function _mpSkillDetailHtml() {
  const item = _mpState.detailItem;
  const lang = getLang();
  const summary = pickDesc(item || {}, lang).trim();
  const files = _mpState.detailSkillFiles || [];
  const selected = _mpState.detailSkillSelected;
  const text = _mpState.detailSkillFileText || '';

  const treeHtml = files.map((f) => {
    const active = f.path === selected ? ' active' : '';
    return `<div class="skill-tree-node skill-tree-file${active}" data-mp-skill-file="${escapeHtml(f.path)}">
      <span class="skill-tree-label">${escapeHtml(f.path)}</span>
      <span class="muted" style="margin-left:auto;font-size:11px">${_fmtBytes(f.bytes)}</span>
    </div>`;
  }).join('');

  const isMd = selected.toLowerCase().endsWith('.md');
  const bodyHtml = isMd
    ? renderMarkdownFull(text)
    : `<pre class="code-view"><code>${escapeHtml(text)}</code></pre>`;
  const placeholderHtml = `<span class="agents-detail-placeholder">${escapeHtml(t('agents.placeholder_unset') || '—')}</span>`;

  return `
    <div class="skills-detail-content marketplace-detail-body-inner">
      <section class="skills-doc-section">
        <h3 class="skills-doc-section-label">${escapeHtml(t('skills.label_summary') || 'Summary')}</h3>
        <div class="skills-doc-section-body">${summary ? escapeHtml(summary) : placeholderHtml}</div>
      </section>
      <section class="skills-doc-section skills-usage-section">
        <h3 class="skills-doc-section-label skills-usage-label">
          <span>${escapeHtml(t('skills.label_usage') || 'Usage')}</span>
          <button type="button" class="skills-source-toggle" data-mp-source-toggle aria-expanded="false">
            <span class="skills-source-toggle-caret" aria-hidden="true">▶</span>
            <span>${escapeHtml(t('skills.label_source') || 'View source')}</span>
          </button>
        </h3>
        <div class="skills-source-panel" data-mp-source-panel style="display:none">
          <div class="skills-source-tree">${treeHtml}</div>
        </div>
        <div class="skills-doc-section-body markdown-body">${bodyHtml}</div>
      </section>
    </div>
  `;
}

function _fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function _mpInstall(kind, id) {
  const item = (kind === 'agent' ? _mpState.agents : _mpState.skills).find((x) => x.id === id);
  if (!item) return;
  const key = `${kind}:${id}`;
  if (_mpState.installing.has(key)) return;
  _mpState.installing.add(key);
  _mpRender();
  try {
    const channel = kind === 'agent' ? 'marketplace.installAgent' : 'marketplace.installSkill';
    const r = await window.orkas.invoke(channel, {
      id, version: item.version, published_at: item.published_at,
    });
    if (!r || r.ok === false) throw new Error((r && r.error) || 'install failed');
    if (kind === 'agent') _mpState.installedAgentIds.add(id);
    else _mpState.installedSkillIds.add(id);
    _mpPersistInstalled();
    if (typeof loadAgents === 'function' && kind === 'agent') await loadAgents(true);
    if (typeof loadSkills === 'function' && kind === 'skill') await loadSkills(true);
    // Success: no toast — the button flips to "已安装" + state set above is the signal.
    // (Failure still alerts because the user otherwise has no way to know why nothing happened.)
  } catch (err) {
    const msg = (err && err.message) || String(err);
    uiAlert(t('marketplace.install_failed').replace('{reason}', msg));
  } finally {
    _mpState.installing.delete(key);
    _mpRender();
    if (_mpState.view === 'detail') _mpRenderDetail();
  }
}

async function _mpInstallFromDetail() {
  const item = _mpState.detailItem;
  const kind = _mpState.detailKind;
  if (!item || !kind) return;
  const installed = (kind === 'agent' ? _mpState.installedAgentIds : _mpState.installedSkillIds).has(item.id);
  if (installed) await _mpUninstall(kind, item.id);
  else await _mpInstall(kind, item.id);
}

async function _mpUninstall(kind, id) {
  if (!_mpState.uninstalling) _mpState.uninstalling = new Set();
  const key = `${kind}:${id}`;
  if (_mpState.installing.has(key)) return;
  _mpState.installing.add(key);
  _mpState.uninstalling.add(key);
  _mpRender();
  try {
    const channel = kind === 'agent' ? 'marketplace.uninstallAgent' : 'marketplace.uninstallSkill';
    const r = await window.orkas.invoke(channel, { id });
    if (!r || r.ok === false) throw new Error((r && r.error) || 'uninstall failed');
    if (kind === 'agent') _mpState.installedAgentIds.delete(id);
    else _mpState.installedSkillIds.delete(id);
    _mpPersistInstalled();
    if (typeof loadAgents === 'function' && kind === 'agent') await loadAgents(true);
    if (typeof loadSkills === 'function' && kind === 'skill') await loadSkills(true);
    // Success: button flips back to "安装" — no toast needed. (Failures still alert.)
  } catch (err) {
    const msg = (err && err.message) || String(err);
    uiAlert(t('marketplace.uninstall_failed').replace('{reason}', msg));
  } finally {
    _mpState.installing.delete(key);
    _mpState.uninstalling.delete(key);
    _mpRender();
    if (_mpState.view === 'detail') _mpRenderDetail();
  }
}

// Dev-only `_mpDeleteFromDetail` moved to marketplace_dev.js.

// ─── Shared: category dropdown mount ──────────────────────────────────
// Used by the create-agent and create-skill modals. Loads from main, which serves the 24h
// biz cache (features/marketplace_biz.ts) and falls back to a hard-coded default list on
// network failure — so the dropdown is never empty.
async function mountMarketplaceCategorySelect(elId, initialValue = '') {
  const el = document.getElementById(elId);
  if (!el) return;
  let categories = [];
  try {
    const r = await window.orkas.invoke('marketplace.categories', {});
    categories = (r && r.list) || [];
  } catch { /* swallowed — main's fallback handles it */ }
  const lang = (typeof getLang === 'function') ? getLang() : 'zh';
  _aiSelectMount(el, {
    options: categories.map((c) => ({
      value: c.code,
      label: lang === 'zh' ? (c.name_zh || c.name_en || c.code) : (c.name_en || c.name_zh || c.code),
    })),
    value: initialValue || (categories[0] && categories[0].code) || '',
  });
}

// Dev-only `openMarketplaceUpload` + `_mpShowUploadWithCategoryDialog` live in
// `marketplace_dev.js` (physically excluded from OrkasOpen via SyncCode strip-rules).
// Callers (agents.js / skills.js per-row menu) check `typeof openMarketplaceUpload === 'function'`
// to decide whether to show the upload entry — OrkasOpen has no marketplace_dev.js loaded,
// so the menu items just don't appear.
