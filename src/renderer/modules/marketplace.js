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
// Per-card Install button (in detail) materializes the cached item into the local
// platform-install tree (<uid>/local/marketplace/{agents,skills}/<id>/).
//
// Dev-only upload (`openMarketplaceUpload`) is exposed for agents.js / skills.js (⋯ menu +
// detail-page actions). Category is NO LONGER asked — it lives in the spec now (agent.json
// `category` field / SKILL.md `category` frontmatter).

let _mpState = null;
let _mpBound = false;
let _mpReturnView = 'agents';

// Renderer-side in-memory cache of the category registry. Main also caches in-memory + on disk
// + boots with a local-only primeCategoryCache so the first openMarketplace avoids startup
// network pressure while still finding main's cache hot;
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
const MP_UNKNOWN_CATEGORY_REFRESH_MIN_MS = 5 * 60 * 1000;
let _mpUnknownCategoryRefreshAt = 0;
let _mpUnknownCategoryRefreshInFlight = null;
const MP_REVIEW_STATUS_UI_ENABLED = false;

function _mpUnknownCategoryLabel() {
  const raw = t('marketplace.category_unknown');
  return raw && raw !== 'marketplace.category_unknown' ? raw : 'Unknown';
}

function _mpCanonicalCategoryCode(code) {
  const c = String(code || '').trim();
  return c === 'writing' ? 'creation' : c;
}

function _mpUserErrorMessage(errLike, fallbackKey) {
  const source = errLike && errLike.marketplaceReason
    ? {
        error: errLike.marketplaceReason,
        message: errLike.marketplaceReason,
        code: errLike.code,
      }
    : errLike;
  if (typeof userErrorMessage === 'function') {
    return userErrorMessage(source, { fallbackKey });
  }
  return (source && (source.error || source.message)) || String(source || '') || t(fallbackKey);
}

function _mpErrorFromResponse(res, fallbackMessage) {
  const responseForMessage = res && res.marketplaceReason
    ? { ...res, error: res.marketplaceReason }
    : res;
  const err = typeof userErrorFromResponse === 'function'
    ? userErrorFromResponse(responseForMessage, fallbackMessage)
    : new Error((responseForMessage && (responseForMessage.error || responseForMessage.message || responseForMessage.msg)) || fallbackMessage || 'failed');
  if (res && res.marketplaceKind) err.marketplaceKind = res.marketplaceKind;
  if (res && res.marketplaceId) err.marketplaceId = res.marketplaceId;
  if (res && res.marketplaceName) err.marketplaceName = res.marketplaceName;
  if (res && res.marketplaceReason) err.marketplaceReason = res.marketplaceReason;
  if (res && res.marketplaceAppUpdateRequired) {
    err.marketplaceAppUpdateRequired = true;
    err.marketplaceMinAppVersion = res.marketplaceMinAppVersion || '';
    err.marketplaceCurrentAppVersion = res.marketplaceCurrentAppVersion || '';
  }
  if (res && res.qualityReport) err.qualityReport = res.qualityReport;
  return err;
}

function _mpShowReviewStatusUi() {
  return MP_REVIEW_STATUS_UI_ENABLED && typeof isDevMode === 'function' && false;
}

function _mpUnknownCategoryCodes(codes) {
  const list = Array.isArray(_mpCategoriesCache) ? _mpCategoriesCache : [];
  const known = new Set(list.map((c) => c && _mpCanonicalCategoryCode(c.code)).filter(Boolean));
  return [...codes]
    .map((code) => _mpCanonicalCategoryCode(code))
    .filter((code) => code && !known.has(code));
}

function _mpMaybeRefreshCategoriesForCodes(codes) {
  const unknown = _mpUnknownCategoryCodes(codes);
  if (!unknown.length) return;
  const now = Date.now();
  if (_mpUnknownCategoryRefreshInFlight) return;
  if (now - _mpUnknownCategoryRefreshAt < MP_UNKNOWN_CATEGORY_REFRESH_MIN_MS) return;
  _mpUnknownCategoryRefreshAt = now;
  try {
    _mpUnknownCategoryRefreshInFlight = window.orkas.invoke('marketplace.categories', { force_refresh: true })
      .then((r) => {
        const list = (r && r.list) || [];
        if (!list.length) return;
        _mpCategoriesCache = list;
        _mpPersistCategoriesCache(list);
        if (_mpState) {
          _mpState.categories = list;
          _mpRender();
        }
        if (typeof renderAgentsGrid === 'function' && typeof _agentsCache !== 'undefined' && _agentsCache) {
          renderAgentsGrid(_agentsCache);
        }
        if (typeof renderSkillsGrid === 'function' && typeof _skillsCache !== 'undefined' && _skillsCache) {
          renderSkillsGrid(_skillsCache);
        }
      })
      .catch((err) => {
        console.warn('marketplace categories forced refresh failed:', err);
      })
      .finally(() => {
        _mpUnknownCategoryRefreshInFlight = null;
      });
  } catch (err) {
    _mpUnknownCategoryRefreshInFlight = null;
    console.warn('marketplace categories forced refresh failed:', err);
  }
}

// Installed-state cache (synchronous via localStorage). Without this, every panel open
// waits 1-2s for `agents.list` / `skills.list` IPCs before card buttons can show the
// installed state; users see all cards flash "Install" first. The cache is updated after
// each successful install/uninstall + after every successful background
// `agents.list` / `skills.list` refresh.
const MP_INSTALLED_LS_KEY = 'orkas:mp:installed';
function _mpLoadInstalledFromLs() {
  try {
    const raw = localStorage.getItem(MP_INSTALLED_LS_KEY);
    if (!raw) {
      return {
        agentIds: new Set(), skillIds: new Set(),
        agentMeta: new Map(), skillMeta: new Map(),
      };
    }
    const parsed = JSON.parse(raw);
    const agentRows = Array.isArray(parsed?.agents)
      ? parsed.agents
      : (Array.isArray(parsed?.agentIds) ? parsed.agentIds.map((id) => ({ id })) : []);
    const skillRows = Array.isArray(parsed?.skills)
      ? parsed.skills
      : (Array.isArray(parsed?.skillIds) ? parsed.skillIds.map((id) => ({ id })) : []);
    return {
      agentIds: new Set(agentRows.map((x) => x?.id).filter(Boolean)),
      skillIds: new Set(skillRows.map((x) => x?.id).filter(Boolean)),
      agentMeta: new Map(agentRows.filter((x) => x?.id).map((x) => [String(x.id), _mpNormalizeInstallMeta(x)])),
      skillMeta: new Map(skillRows.filter((x) => x?.id).map((x) => [String(x.id), _mpNormalizeInstallMeta(x)])),
    };
  } catch {
    return {
      agentIds: new Set(), skillIds: new Set(),
      agentMeta: new Map(), skillMeta: new Map(),
    };
  }
}
function _mpNormalizeInstallMeta(row) {
  const meta = { id: String(row?.id || '') };
  if (row && typeof row.version === 'string') meta.version = row.version;
  const published = row?.published_at ?? row?.marketplace_published_at;
  const updated = row?.updated_at ?? row?.marketplace_updated_at;
  if (typeof published === 'number') meta.published_at = published;
  if (typeof updated === 'number') meta.updated_at = updated;
  const minAppVersion = _mpMinAppVersion(row);
  if (minAppVersion) meta.min_app_version = minAppVersion;
  return meta;
}

function _mpMinAppVersion(row) {
  const value = row?.min_app_version
    || row?.minAppVersion
    || row?.min_version
    || row?.minVersion
    || row?.min_pc_version
    || row?.minPcVersion
    || '';
  return typeof value === 'string' ? value.trim() : '';
}

// Renderer-local mirror of util/app-version-compat; classic scripts cannot import it.
function _mpVersionTokens(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return [];
  return text.replace(/^v/i, '').split(/[.+_-]/).filter(Boolean)
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p.toLowerCase()));
}

function _mpCompareVersions(a, b) {
  const aa = _mpVersionTokens(a);
  const bb = _mpVersionTokens(b);
  if (!aa.length || !bb.length) return 0;
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
  }
  return 0;
}
/** True when the item has no minimum or this client is known to meet it. */
function _mpItemAppCompatible(item) {
  const min = _mpMinAppVersion(item);
  if (!min) return true;
  const current = _mpState && _mpState.appVersion;
  if (!current) return false;
  return _mpCompareVersions(current, min) >= 0;
}

function _mpInstallMetaRows(kind) {
  const ids = kind === 'agent' ? _mpState.installedAgentIds : _mpState.installedSkillIds;
  const map = kind === 'agent' ? _mpState.installedAgentMeta : _mpState.installedSkillMeta;
  return [...ids].map((id) => ({ id, ...(map?.get(id) || {}) }));
}
function _mpPersistInstalled() {
  try {
    const agents = _mpInstallMetaRows('agent');
    const skills = _mpInstallMetaRows('skill');
    localStorage.setItem(MP_INSTALLED_LS_KEY, JSON.stringify({
      agentIds: agents.map((x) => x.id),
      skillIds: skills.map((x) => x.id),
      agents,
      skills,
    }));
  } catch { /* ignore */ }
}

// Latest reconcile snapshot pushed from main (boot-time marketplace install reconcile).
// Bootstrap subscription runs at module load — see _mpInitReconcileWatch() — so a hot reconcile
// transitioning to `running` reaches the panel even if the user opens it mid-fetch.
let _mpReconcileStatus = {
  state: 'idle',
  total: 0,
  total_agents: 0,
  total_skills: 0,
  pulled: 0,
  pulled_agents: 0,
  pulled_skills: 0,
};

// Paginated listings cache (cross-process via main `marketplace.{get,set}ListingsCache`).
// Key = `${kind}|${category||''}|${status||''}|${q||''}`. Value:
//   { items, ts, nextPage, exhausted }
// Where `items` accumulates across pages (deduped by id), `nextPage` is the next page-num to
// request on infinite-scroll, and `exhausted` flips true once a /list response is shorter
// than `MP_LISTINGS_PAGE_SIZE` or covers `total`.
//
// SWR semantics ("switching tab/category still fires a request, but the cache renders first"):
//   - Switching tab / category / opening panel:
//     * Hydrate cache immediately so the grid renders prior items (no blank flash).
//     * Always re-fetch page 1 in the background to overwrite stale rows.
//   - Infinite scroll: when the sentinel near the grid bottom enters the viewport, fetch
//     page = cached.nextPage and APPEND (dedupe by id) — never overwrite earlier pages.
//   - "All" tab (category = '') feeds rows into per-category cache slots so a subsequent
//     category tab open paints fast. The reverse (cat slot → "All") is NOT done — All needs
//     a fresh name-sort-key-ordered slice from the server.
const MP_LISTINGS_PAGE_SIZE = 50;
const _mpListingsCache = new Map();
let _mpListingsHydrated = false;
function _mpListingsKey(kind, category, status, q) { return `${kind}|${category || ''}|${status || ''}|${q || ''}`; }

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

function openMarketplace(initialTab = 'agent', opts = {}) {
  const panel = document.getElementById('panel-marketplace');
  if (!panel) return;

  // Idempotent; normally already started at module load so the Agents/Skills pages can show
  // boot-time default-install progress before the user opens Marketplace.
  _mpInitReconcileWatch();

  _mpReturnView = (typeof currentView === 'string' && currentView !== 'marketplace')
    ? currentView : 'agents';

  _mpState = {
    view: 'grid',
    appVersion: (_mpState && _mpState.appVersion) || '',
    tab: (initialTab === 'skill' || initialTab === 'oss') ? initialTab : 'agent',
    category: '',
    // Open-source projects专区 (curated, config-as-code; isolated from the
    // agent/skill SWR path — see _mpLoadOss / _mpRenderOss).
    ossProjects: [],
    ossCategories: [],
    ossInstalled: new Set(),
    ossCategory: '',
    ossQ: '',
    ossLoadKey: '',
    ossLoaded: false,
    ossLoading: false,
    ossError: '',
    ossSearchBusy: false,
    status: '',
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
      return {
        installedAgentIds: cached.agentIds,
        installedSkillIds: cached.skillIds,
        installedAgentMeta: cached.agentMeta,
        installedSkillMeta: cached.skillMeta,
      };
    })(),
    loading: true,
    searchBusy: false,
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
    detailSkillLoadError: '',
    detailSkillSourceOpen: true,
  };

  if (!_mpBound) {
    _mpBindPanel(panel);
    document.addEventListener('keydown', _mpKey, true);
    _mpBound = true;
  }

  // Reset the search box so it matches the freshly-reset `q` above (clean slate on reopen).
  const searchEl = panel.querySelector('[data-mp-search]');
  if (searchEl) searchEl.value = '';

  // Show the panel + a loading affordance synchronously — before ANY async work — so a slow
  // cache-read IPC or a slow server fetch never leaves the user on the prior view with no
  // feedback. `_mpLoadAll` then hydrates the listings cache, paints cached rows when present,
  // and overlays fresh data — all via its own `_mpRender` calls.
  if (typeof setView === 'function') setView('marketplace');
  _mpShowGridView();
  _mpRender();

  // Best-effort cache sweep — never blocks the UI.
  window.orkas.invoke('marketplace.sweepCache').catch(() => { /* ignore */ });

  if (!_mpState.appVersion && window.orkas && typeof window.orkas.env === 'function') {
    window.orkas.env().then((env) => {
      const v = env && env.version;
      if (typeof v === 'string' && v && _mpState) {
        _mpState.appVersion = v;
        _mpRender();
      }
    }).catch(() => { /* ignore */ });
  }

  const deepLinkItem = opts && opts.detailItem && opts.detailItem.id ? opts.detailItem : null;
  const deepLinkKind = opts && opts.detailKind ? opts.detailKind : _mpState.tab;
  if (deepLinkItem) {
    Promise.resolve().then(() => _mpOpenDetail(deepLinkKind === 'skill' ? 'skill' : 'agent', deepLinkItem)).catch(() => {});
  }

  _mpLoadAll();
  if (_mpState.tab === 'oss') _mpLoadOss();
}

function closeMarketplace() {
  if (!isMarketplaceOpen()) return;
  if (typeof setView === 'function') setView(_mpReturnView || 'agents');
}

function _mpOnI18n() {
  if (isMarketplaceOpen()) _mpRender();
  _mpUpdateReconcileBanner();
}

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

// Initialize on module load so Agents/Skills pages can show boot-time default-install progress
// without requiring the Marketplace panel to be opened first. Subscribe before taking the
// snapshot: the snapshot returns the current main-process state, and the push handler then keeps
// it live.
let _mpReconcileWatchStarted = false;
let _mpReconcileWatchStarting = false;
let _mpReconcileLastState = _mpReconcileStatus.state;

function _mpCompactResourceSyncNames(skipped) {
  const names = [];
  const seen = new Set();
  for (const item of skipped || []) {
    const name = String((item && (item.name || item.id)) || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  const visible = names.slice(0, 5);
  const more = Math.max(0, names.length - visible.length);
  let text = visible.join(', ');
  if (more) text = text ? `${text} +${more}` : `+${more}`;
  if (text.length > 160) text = `${text.slice(0, 157)}...`;
  return { count: names.length, text };
}

function _mpShowResourceSyncSkippedToast(payload) {
  const skipped = Array.isArray(payload && payload.skipped) ? payload.skipped : [];
  if (!skipped.length || typeof uiToast !== 'function') return;
  const compact = _mpCompactResourceSyncNames(skipped);
  const names = compact.text || String(compact.count);
  const message = t('marketplace.resource_sync_skipped', {
    count: compact.count,
    names,
  });
  uiToast(message, { variant: 'warning', timeoutMs: 9000 });
}

async function _mpInitReconcileWatch() {
  if (_mpReconcileWatchStarted || _mpReconcileWatchStarting) return;
  if (!window.orkas || typeof window.orkas.invoke !== 'function' || typeof window.orkas.onPushEvent !== 'function') {
    return;
  }
  _mpReconcileWatchStarting = true;
  try {
    window.orkas.onPushEvent('marketplace:reconcile-status', (status) => {
      _mpApplyReconcileStatus(status);
    });
    window.orkas.onPushEvent('marketplace:resource-sync-skipped', (payload) => {
      _mpShowResourceSyncSkippedToast(payload);
    });
    _mpReconcileWatchStarted = true;
  } catch {
    _mpReconcileWatchStarting = false;
    return;
  }
  try {
    const initial = await window.orkas.invoke('marketplace.reconcileStatus');
    _mpApplyReconcileStatus(initial);
  } catch { /* main not ready yet — push event will fill us in */ }
  _mpReconcileWatchStarting = false;
}

function _mpApplyReconcileStatus(status) {
  if (!status) return;
  const prevState = _mpReconcileLastState;
  _mpReconcileStatus = status;
  _mpReconcileLastState = status.state;
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
    Promise.resolve().then(async () => {
      try {
        if (typeof refreshAgentsAfterMarketplaceReconcile === 'function') {
          await refreshAgentsAfterMarketplaceReconcile();
        } else if (typeof loadAgents === 'function') {
          await loadAgents(true);
        }
      } catch { /* ignore */ }
      try {
        if (typeof refreshSkillsAfterMarketplaceReconcile === 'function') {
          await refreshSkillsAfterMarketplaceReconcile();
        } else if (typeof loadSkills === 'function') {
          await loadSkills(true);
        }
      } catch { /* ignore */ }
      // If marketplace panel is open right now, also re-run the install-state hydration
      // so card buttons flip from Install to Installed without a tab switch.
      if (isMarketplaceOpen()) {
        try { await _mpLoadAll(); } catch { /* ignore */ }
      }
    }).catch(() => { /* ignore */ });
  }
}

function _mpScheduleReconcileWatchInit(attempt = 0) {
  if (_mpReconcileWatchStarted) return;
  _mpInitReconcileWatch();
  if (_mpReconcileWatchStarted) return;
  if (attempt >= 40) return;
  setTimeout(() => _mpScheduleReconcileWatchInit(attempt + 1), 250);
}

// Updates ALL banners with `data-reconcile-banner` (marketplace panel + agents-grid-view +
// skills-grid-view). User opens any of those tabs during reconcile → sees same status, no
// "panel looks empty, what happened" confusion. Each panel embeds its own banner div via
// HTML so we don't have to manage DOM insertion / removal.
function _mpUpdateReconcileBanner() {
  const banners = document.querySelectorAll('[data-reconcile-banner]');
  if (!banners.length) return;
  const s = _mpReconcileStatus;
  for (const banner of banners) {
    const kind = banner.dataset.reconcileKind || '';
    let visible = false;
    let text = '';
    if (s.state === 'running') {
      visible = kind ? _mpReconcileKindTotal(kind) > 0 : true;
      const key = kind === 'agent'
        ? (s.phase === 'default_seed' ? 'agents.default_install_empty' : 'agents.default_install_running')
        : (kind === 'skill'
          ? (s.phase === 'default_seed' ? 'skills.default_install_empty' : 'skills.default_install_running')
          : 'marketplace.reconcile_running');
      text = t(key)
        .replace('{pulled}', String(kind ? _mpReconcileKindPulled(kind) : s.pulled))
        .replace('{total}', String(kind ? _mpReconcileKindTotal(kind) : s.total));
    } else if (s.state === 'done' && (s.failed || []).length > 0) {
      visible = true;
      text = t('marketplace.reconcile_partial').replace('{failed}', String(s.failed.length));
    }
    banner.style.display = visible ? '' : 'none';
    banner.textContent = text;
  }
  _mpUpdateInstallingEmptyStates();
}

function _mpSetInstallingEmptyState({ emptyId, gridId, normalKey, installingKey }) {
  const emptyEl = document.getElementById(emptyId);
  const gridEl = document.getElementById(gridId);
  if (!emptyEl || !gridEl) return;
  const hasRenderedItems = gridEl.children.length > 0;
  const kind = gridId === 'agents-grid' ? 'agent' : (gridId === 'skills-grid' ? 'skill' : '');
  const installing = _mpReconcileStatus.state === 'running'
    && !hasRenderedItems
    && (!kind || _mpReconcileKindTotal(kind) > 0);
  emptyEl.textContent = t(installing ? installingKey : normalKey);
  if (installing) emptyEl.style.display = '';
}

function _mpReconcileKindTotal(kind) {
  const key = kind === 'agent' ? 'total_agents' : (kind === 'skill' ? 'total_skills' : 'total');
  const n = Number(_mpReconcileStatus[key]);
  if (Number.isFinite(n)) return n;
  return Number(_mpReconcileStatus.total) || 0;
}

function _mpReconcileKindPulled(kind) {
  const key = kind === 'agent' ? 'pulled_agents' : (kind === 'skill' ? 'pulled_skills' : 'pulled');
  const n = Number(_mpReconcileStatus[key]);
  if (Number.isFinite(n)) return n;
  return Number(_mpReconcileStatus.pulled) || 0;
}

function _mpUpdateInstallingEmptyStates() {
  _mpSetInstallingEmptyState({
    emptyId: 'agents-empty',
    gridId: 'agents-grid',
    normalKey: 'agents.empty',
    installingKey: 'agents.default_install_empty',
  });
  _mpSetInstallingEmptyState({
    emptyId: 'skills-empty',
    gridId: 'skills-grid',
    normalKey: 'skills.empty',
    installingKey: 'skills.default_install_empty',
  });
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
      if (!_mpState || _mpState.tab === btn.dataset.mpTab) return;
      _mpState.tab = btn.dataset.mpTab;
      _mpState.category = '';
      if (_mpState.tab === 'oss') {
        // Open-source projects专区 — its own render + (cached) fetch, fully
        // bypassing the agent/skill listings cache machinery.
        _mpState.ossCategory = '';
        _mpState.ossQ = '';
        _mpSyncSearchInputForTab(panel);
        _mpRender();
        _mpLoadOss();
        return;
      }
      // Re-hydrate from cache for the new (kind, '', q) and re-fetch — same cache-first path
      // as category clicks, so the grid doesn't show the previous tab's rows under "All".
      _mpRefreshListings();
    });
  });
  const search = panel.querySelector('[data-mp-search]');
  if (search) {
    search.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') _mpRunSearch();
    });
    search.addEventListener('input', _mpRenderSearchClear);
  }
  panel.querySelector('[data-mp-search-btn]')?.addEventListener('click', _mpRunSearch);
  panel.querySelector('[data-mp-search-clear]')?.addEventListener('click', _mpClearSearch);
  panel.querySelector('[data-mp-detail-install]')?.addEventListener('click', _mpInstallFromDetail);
  // Dev-only delete button click handler is bound by marketplace_dev.js (file absent in
  // the open-source build). HTML element ships in index.html with display:none — dev module flips it
  // on via the `onMarketplaceDetailRendered` hook (see below).
}

// SWR entry: paint cached rows immediately, then fan out three independent network tasks
// (installed-state / categories / listings). Each task owns its slice of `_mpState`, its own
// error handling, and renders on completion. Previously these three lived inside a single
// try/catch which silently swallowed `_mpLoadListings` whenever the installed-state or
// categories IPCs hung or rejected — fresh listings never landed and the user stayed on
// stale cached rows. Decoupling restores the SWR contract: any one task failing leaves the
// other two free to update their slice.
async function _mpLoadAll() {
  await _mpHydrateListingsCache();
  _mpHydrateFromCache();
  if (_mpCategoriesCache) _mpState.categories = _mpCategoriesCache;
  _mpState.loading = _mpVisibleItems().length === 0;
  _mpState.error = '';
  _mpRender();

  await Promise.all([
    _mpRefreshInstalledState(),
    _mpRefreshCategoriesIfMissing(),
    _mpRefreshListingsAndRender(),
  ]);
}

// Pulls the local installed-state and flips card buttons between Install / Installed.
async function _mpRefreshInstalledState() {
  try {
    const [instAgents, instSkills] = await Promise.all([
      window.orkas.invoke('agents.list'),
      window.orkas.invoke('skills.list'),
    ]);
    if (!_mpState) return;
    const agentRows = ((instAgents && instAgents.agents) || [])
      .filter((a) => _mpInstalledSource(a?.source) === 'marketplace')
      .map((a) => ({
        id: a.agent_id,
        version: a.version,
        published_at: a.marketplace_published_at,
        updated_at: a.marketplace_updated_at,
      }));
    const skillRows = ((instSkills && instSkills.skills) || [])
      .filter((s) => _mpInstalledSource(s?.source) === 'marketplace')
      .map((s) => ({
        id: s.id,
        version: s.version,
        published_at: s.marketplace_published_at,
        updated_at: s.marketplace_updated_at,
      }));
    _mpState.installedAgentIds = new Set(agentRows.map((a) => a.id).filter(Boolean));
    _mpState.installedSkillIds = new Set(skillRows.map((s) => s.id).filter(Boolean));
    _mpState.installedAgentMeta = new Map(agentRows.filter((a) => a.id).map((a) => [String(a.id), _mpNormalizeInstallMeta(a)]));
    _mpState.installedSkillMeta = new Map(skillRows.filter((s) => s.id).map((s) => [String(s.id), _mpNormalizeInstallMeta(s)]));
    _mpPersistInstalled();
    _mpRender();
  } catch (err) {
    console.warn('marketplace installed-state refresh failed:', err);
  }
}
function _mpInstalledSource(source) {
  if (typeof normalizeCatalogSource === 'function') return normalizeCatalogSource(source);
  if (source === 'builtin' || source === 'platform') return 'marketplace';
  return source;
}

// One-shot fetch of the category list (24h server-cached). Skipped when the renderer-level
// cache already has it — the categories chip strip is allowed to lag a session.
async function _mpRefreshCategoriesIfMissing() {
  if (_mpCategoriesCache) return;
  try {
    const r = await window.orkas.invoke('marketplace.categories', {});
    const list = (r && r.list) || [];
    if (!list.length || !_mpState) return;
    _mpCategoriesCache = list;
    _mpState.categories = list;
    _mpPersistCategoriesCache(list);
    _mpRender();
  } catch (err) {
    console.warn('marketplace categories refresh failed:', err);
  }
}

// Fresh listings for the current (kind, category, q). `_mpLoadListings` catches per-kind
// errors internally and never rejects; this wrapper just flips `loading` off + re-renders +
// reconciles an open detail page.
async function _mpRefreshListingsAndRender() {
  await _mpLoadListings();
  if (!_mpState) return;
  _mpState.loading = false;
  _mpRender();
  await _mpRefreshOpenDetailFromListings();
}

function _mpPersistCategoriesCache(list) {
  try { localStorage.setItem(MP_CATEGORIES_LS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

async function _mpRefreshOpenDetailFromListings() {
  if (!_mpState || _mpState.view !== 'detail' || !_mpState.detailKind || !_mpState.detailItem) return;
  const kind = _mpState.detailKind;
  const list = kind === 'agent' ? _mpState.agents : _mpState.skills;
  const fresh = list.find((x) => x.id === _mpState.detailItem.id);
  if (!fresh) return;
  const prev = _mpState.detailItem;
  const changed = prev.version !== fresh.version
    || prev.published_at !== fresh.published_at
    || prev.updated_at !== fresh.updated_at;
  if (!changed) {
    _mpState.detailItem = { ...prev, ...fresh };
    _mpRenderDetail();
    return;
  }
  await _mpOpenDetail(kind, fresh, { preserveSkillState: true });
}

// Module-load: kick off the reconcile-status watch so the banner in `agents-grid-view` /
// `skills-grid-view` lights up DURING boot reconcile, not only after the user enters
// marketplace. Idempotent — `_mpInitReconcileWatch` runs once and a second call no-ops.
setTimeout(() => { _mpInitReconcileWatch().catch(() => {}); }, 0);
window.addEventListener('i18n-change', () => { _mpUpdateReconcileBanner(); });

// Public hook: re-pull the SWR network half while the marketplace panel is the active view.
// Cheap when stale — the cache stays on screen and only the slices whose IPC returns fresh
// rows re-render. Callers: the visibility/focus listeners below, post-upload + post-delete
// hooks from marketplace_dev.js, and any future "I just changed server-side state" path.
// No-op when the panel isn't visible (avoids burning IPC on a panel the user can't see; the
// next openMarketplace will SWR-refresh anyway).
function refreshMarketplaceIfActive() {
  if (!isMarketplaceOpen() || !_mpState) return;
  if (_mpState.tab === 'oss') {
    _mpLoadOss({ forceState: true }).catch(() => {});
    return;
  }
  Promise.all([
    _mpRefreshInstalledState(),
    _mpRefreshListingsAndRender(),
  ]).catch(() => { /* per-task handlers already logged */ });
}

// Re-fetch when the window comes back to the foreground (Cmd-Tab back, switch desktop,
// browser tab visible again). Debounced so a rapid focus/blur burst fires one request.
// Why this exists in addition to openMarketplace: the panel can sit open for minutes while
// the user is in another app or another conversation — without this hook the listing stays
// frozen at whatever was on screen when the user left, and admin republishes / dev uploads
// from another window don't surface until the user clicks "More" again.
let _mpVisRefreshTimer = null;
function _mpScheduleVisibilityRefresh() {
  if (!isMarketplaceOpen() || !_mpState) return;
  clearTimeout(_mpVisRefreshTimer);
  _mpVisRefreshTimer = setTimeout(() => {
    _mpVisRefreshTimer = null;
    refreshMarketplaceIfActive();
  }, 250);
}
window.addEventListener('focus', _mpScheduleVisibilityRefresh);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) _mpScheduleVisibilityRefresh();
});

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
        if (_mpState) {
          _mpState.categories = list;
          _mpRender();
        }
      }
    }).catch(() => { /* ignore */ });
  } catch { /* preload happens at script load; window.orkas not ready is OK */ }
})();

(function _mpBindDeepLinkOpen() {
  try {
    window.orkas.onPushEvent('marketplace:open-detail', (payload) => {
      const normalized = _mpNormalizeDeepLinkPayload(payload);
      if (!normalized) return;
      openMarketplace(normalized.kind, {
        detailKind: normalized.kind,
        detailItem: normalized.item,
      });
    });
  } catch { /* push channel unavailable during very early dev boot — ignore */ }
})();

function _mpNormalizeDeepLinkPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const kind = payload.kind === 'skill' ? 'skill' : payload.kind === 'agent' ? 'agent' : null;
  const item = payload.item && typeof payload.item === 'object' ? { ...payload.item } : {};
  const id = String(payload.id || item.id || '').trim();
  if (!kind || !id) return null;
  item.id = id;
  return { kind, item };
}

// Single entry point for category-chip clicks and search submits: hydrate the cached rows for
// the new (kind, category, q) and paint them; if the visible tab has no rows, show the body
// spinner instead. Either way, re-fetch page 1 in the background and swap fresh data in.
// `opts.searchBusy` additionally spins the search button while the fetch is in flight.
async function _mpRefreshListings(opts = {}) {
  if (!_mpState) return;
  _mpHydrateFromCache();
  _mpState.loading = _mpVisibleItems().length === 0;
  _mpState.error = '';
  if (opts.searchBusy) _mpState.searchBusy = true;
  _mpRender();
  try {
    await _mpLoadListings();
  } finally {
    _mpState.loading = false;
    if (opts.searchBusy) _mpState.searchBusy = false;
    _mpRender();
  }
}

// ─── Search box (input + Enter / search button + clear ×) ───
// Triggered by Enter in the input OR a click on the search button — reads the live input
// value, refreshes the listings for that query, and spins the search button while it loads.
function _mpRunSearch() {
  if (!_mpState) return;
  const input = document.getElementById('panel-marketplace')?.querySelector('[data-mp-search]');
  if (_mpState.tab === 'oss') {
    _mpState.ossQ = (input?.value || '').trim();
    _mpLoadOss({ force: true, searchBusy: true });
    return;
  }
  _mpState.q = (input?.value || '').trim();
  _mpRefreshListings({ searchBusy: true });
}

// Clear (×) button inside the input: empties the box and, if a search was active, refreshes
// back to the unfiltered list.
function _mpClearSearch() {
  if (!_mpState) return;
  const input = document.getElementById('panel-marketplace')?.querySelector('[data-mp-search]');
  if (input) { input.value = ''; input.focus(); }
  _mpRenderSearchClear();
  if (_mpState.tab === 'oss') {
    if (_mpState.ossQ) {
      _mpState.ossQ = '';
      _mpLoadOss({ force: true, searchBusy: true });
    }
    return;
  }
  if (_mpState.q) {
    _mpState.q = '';
    _mpRefreshListings({ searchBusy: true });
  }
}

// Reflect `_mpState.searchBusy` on the search button — spinner + greyed/disabled while a
// search fetch is in flight, plain accent button otherwise (mirrors the install-button pattern).
function _mpRenderSearchBtn() {
  const btn = document.getElementById('panel-marketplace')?.querySelector('[data-mp-search-btn]');
  if (!btn) return;
  const busy = !!(_mpState && (_mpState.tab === 'oss' ? _mpState.ossSearchBusy : _mpState.searchBusy));
  btn.className = busy ? 'btn btn-sm is-disabled marketplace-search-btn' : 'btn btn-sm btn-primary marketplace-search-btn';
  btn.disabled = busy;
  const label = escapeHtml(t('marketplace.search'));
  btn.innerHTML = busy ? `<span class="marketplace-btn-spinner"></span>${label}` : label;
}

function _mpSyncSearchInputForTab(panel = document.getElementById('panel-marketplace'), opts = {}) {
  const input = panel?.querySelector('[data-mp-search]');
  if (!input || !_mpState) return;
  if (!opts.force && document.activeElement === input) return;
  input.value = _mpState.tab === 'oss' ? (_mpState.ossQ || '') : (_mpState.q || '');
  _mpRenderSearchClear();
}

// Show the clear (×) button only when the input has text.
function _mpRenderSearchClear() {
  const panel = document.getElementById('panel-marketplace');
  const input = panel?.querySelector('[data-mp-search]');
  const clearBtn = panel?.querySelector('[data-mp-search-clear]');
  if (!clearBtn) return;
  clearBtn.hidden = !(input && input.value.length > 0);
}

function _mpRenderStatusSelect(panel) {
  const host = panel.querySelector('.marketplace-status-filter');
  if (host) host.style.display = 'none';
  if (_mpState) _mpState.status = '';
}

// Re-point _mpState.agents/skills at the cached rows for the current (kind, category, q).
// (Stale-response protection lives in `_mpLoadListingsPage`'s per-kind generation token.)
function _mpHydrateFromCache() {
  const cat = _mpState.category, status = _mpState.status, q = _mpState.q;
  const cachedA = _mpListingsCache.get(_mpListingsKey('agent', cat, status, q));
  const cachedS = _mpListingsCache.get(_mpListingsKey('skill', cat, status, q));
  // No cache for this (kind, cat, q) → clear that list rather than leave the previous
  // tab/category's rows on screen; the caller's `loading` flag (set from
  // `_mpVisibleItems().length`) then decides spinner vs empty-state for the now-empty tab.
  _mpState.agents = cachedA ? cachedA.items : [];
  _mpState.skills = cachedS ? cachedS.items : [];
  return !!(cachedA || cachedS);
}

// Spread rows pulled from the "All" tab (category='') into each row's own category cache
// slot. One-way: All → per-category. The reverse would corrupt the name-sort-key-ordered "All" view.
function _mpSpreadAllIntoCategoryCaches(kind, rows, q) {
  if (!rows.length) return;
  const byCat = new Map();
  for (const row of rows) {
    const c = _mpCanonicalCategoryCode(row.category);
    if (!c) continue;
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(row);
  }
  for (const [cat, catRows] of byCat) {
    const key = _mpListingsKey(kind, cat, _mpState.status, q);
    const existing = _mpListingsCache.get(key);
    const items = existing ? existing.items.slice() : [];
    const seen = new Set(items.map((x) => x.id));
    for (const r of catRows) if (!seen.has(r.id)) items.push(r);
    items.sort(_mpCompareMarketplaceName);
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
  const cat = _mpState.category, status = _mpState.status, q = _mpState.q;
  const key = _mpListingsKey(kind, cat, status, q);
  const channel = kind === 'agent' ? 'marketplace.listAgents' : 'marketplace.listSkills';
  try {
    const r = await window.orkas.invoke(channel, {
      category: cat || null, status: status || null, q: q || null, page, size: MP_LISTINGS_PAGE_SIZE,
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
  const cat = _mpState.category, status = _mpState.status, q = _mpState.q;
  const cached = _mpListingsCache.get(_mpListingsKey(kind, cat, status, q));
  if (!cached || cached.exhausted) return;
  _mpLoadMoreInflight = true;
  try {
    await _mpLoadListingsPage(kind, { append: true, page: cached.nextPage || 2 });
    _mpRender();
  } finally {
    _mpLoadMoreInflight = false;
  }
}

// The list the user is currently looking at — the basis for "is the page empty → show
// loading", and for rendering / finding cards on the active tab.
function _mpVisibleItems() {
  return _mpState.tab === 'agent' ? _mpState.agents : _mpState.skills;
}

// ─── Grid view rendering ───
function _mpRender() {
  const panel = document.getElementById('panel-marketplace');
  if (!panel || !_mpState) return;
  if (_mpState.view === 'detail') { _mpRenderDetail(); return; }

  const lang = getLang();
  for (const btn of panel.querySelectorAll('[data-mp-tab]')) {
    const k = btn.dataset.mpTab;
    // 'oss' keeps its static markup (label span + NEW badge); only its active
    // state toggles. agent/skill labels are set here.
    if (k === 'agent') btn.textContent = t('marketplace.tab_agent');
    else if (k === 'skill') btn.textContent = t('marketplace.tab_skill');
    btn.classList.toggle('is-active', k === _mpState.tab);
  }
  // Hide the agent/skill-only status select on the oss tab via CSS.
  panel.classList.toggle('mp-oss-mode', _mpState.tab === 'oss');
  const searchEl = panel.querySelector('[data-mp-search]');
  if (searchEl) searchEl.setAttribute('placeholder', t('marketplace.search_ph'));
  _mpSyncSearchInputForTab(panel);
  _mpRenderSearchBtn();
  _mpRenderSearchClear();
  if (_mpState.tab === 'oss') { _mpRenderOss(panel, lang); return; }
  _mpRenderStatusSelect(panel);

  const cats = _mpState.categories;
  const chips = [
    `<button type="button" class="marketplace-chip${_mpState.category === '' ? ' is-active' : ''}" data-mp-cat="">${escapeHtml(t('marketplace.all'))}</button>`,
    ...cats.map((c) => {
      const label = pickLocalizedName(c, lang) || c.code;
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
  // Order comes from the server: relevance for searches, name sort otherwise.
  // No further client sort — `_mpLoadListingsPage` preserves the server's slicing.
  const items = _mpVisibleItems();
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
        const item = _mpVisibleItems().find((x) => x.id === id);
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

// ─── Open-source projects专区 (②) ───
// Curated catalog fetched via oss.js::loadOssCatalog (keyed SWR cache).
// Fully isolated from the agent/skill SWR path: own state on _mpState.oss*,
// own render, Server-side category/search filtering. No install/detail/pagination.

function _mpOssLoadKey() {
  if (!_mpState) return '';
  return [
    _mpState.ossCategory || '',
    _mpState.ossQ || '',
    (typeof OSS_MARKETPLACE_PAGE_SIZE === 'number' ? OSS_MARKETPLACE_PAGE_SIZE : 100),
  ].join('|');
}

async function _mpLoadOss(opts = {}) {
  if (!_mpState) return;
  const loadKey = _mpOssLoadKey();
  if (_mpState.ossLoaded && _mpState.ossLoadKey === loadKey && !opts.force && !opts.forceState) {
    if (_mpState.tab === 'oss') _mpRender();
    return;
  }
  const myGen = (_mpState._ossLoadGen || 0) + 1;
  _mpState._ossLoadGen = myGen;
  _mpState.ossLoading = !_mpState.ossProjects.length;
  _mpState.ossError = '';
  if (opts.searchBusy) _mpState.ossSearchBusy = true;
  if (_mpState.tab === 'oss') _mpRender();
  try {
    // Catalog + locally-installed external packages, in parallel — the latter
    // decides whether each card shows 接入 (Connect) or 已安装 (Installed).
    const [data, installed] = await Promise.all([
      loadOssCatalog({
        category: _mpState.ossCategory || '',
        q: _mpState.ossQ || '',
        size: typeof OSS_MARKETPLACE_PAGE_SIZE === 'number' ? OSS_MARKETPLACE_PAGE_SIZE : 100,
        force: opts.force === true,
        revalidate: opts.revalidate === false ? false : 'always',
      }),
      loadOssInstalled(),
    ]);
    if (!_mpState || _mpState._ossLoadGen !== myGen) return;
    _mpState.ossProjects = data.projects || [];
    _mpState.ossCategories = data.categories || [];
    _mpState.ossInstalled = installed instanceof Set ? installed : new Set();
    _mpState.ossLoaded = true;
    _mpState.ossLoadKey = loadKey;
  } catch (err) {
    if (!_mpState || _mpState._ossLoadGen !== myGen) return;
    _mpState.ossError = (err && err.message) || 'load failed';
  } finally {
    if (!_mpState || _mpState._ossLoadGen !== myGen) return;
    _mpState.ossLoading = false;
    if (opts.searchBusy) _mpState.ossSearchBusy = false;
    if (_mpState.tab === 'oss') _mpRender();
  }
}

function _mpRenderOss(panel, lang) {
  const catsEl = panel.querySelector('[data-mp-categories]');
  if (catsEl) catsEl.innerHTML = ''; // chips live inside the body for oss
  const body = panel.querySelector('[data-mp-body]');
  if (!body) return;

  const hero = `
    <div class="mp-oss-hero">
      <span class="mp-oss-hero-icon">${uiIconHtml('code', 'mp-oss-hero-svg')}</span>
      <div class="mp-oss-hero-text">
        <div class="mp-oss-hero-title">${escapeHtml(t('marketplace.oss_hero_title'))}</div>
        <div class="mp-oss-hero-sub">${escapeHtml(t('marketplace.oss_hero_sub'))}</div>
      </div>
    </div>`;

  if (_mpState.ossLoading && !_mpState.ossLoaded) {
    body.innerHTML = hero + `
      <div class="marketplace-detail-loading">
        <div class="marketplace-upload-spinner"></div>
        <div class="marketplace-detail-loading-text">${escapeHtml(t('marketplace.list_loading'))}</div>
      </div>`;
    return;
  }
  if (_mpState.ossError) {
    body.innerHTML = hero + `<div class="empty">${escapeHtml(t('marketplace.load_failed'))}: ${escapeHtml(_mpState.ossError)}</div>`;
    return;
  }

  const cats = _mpState.ossCategories || [];
  const chips = [
    `<button type="button" class="marketplace-chip${_mpState.ossCategory === '' ? ' is-active' : ''}" data-oss-cat="">${escapeHtml(t('marketplace.all'))}</button>`,
    ...cats.map((c) => {
      const label = pickLocalizedName(c, lang) || c.code;
      const active = _mpState.ossCategory === c.code ? ' is-active' : '';
      return `<button type="button" class="marketplace-chip${active}" data-oss-cat="${escapeHtml(c.code)}">${escapeHtml(label)}</button>`;
    }),
  ].join('');

  const installed = _mpState.ossInstalled instanceof Set ? _mpState.ossInstalled : new Set();
  const items = _mpState.ossProjects || [];
  const grid = items.length
    ? `<div class="marketplace-grid mp-oss-grid">${items.map((p) => _mpOssCardHtml(
      p,
      cats,
      lang,
      (typeof isOssProjectInstalled === 'function') ? isOssProjectInstalled(p, installed) : installed.has(p.id),
    )).join('')}</div>`
    : `<div class="empty">${escapeHtml(t('marketplace.empty'))}</div>`;

  body.innerHTML = hero + `<div class="mp-oss-chips">${chips}</div>` + grid;

  body.querySelectorAll('[data-oss-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _mpState.ossCategory = btn.dataset.ossCat || '';
      _mpLoadOss();
    });
  });
  // Card click → open the project's GitHub page; the 接入 button → prefill the
  // Commander (install-then-use). The 已安装 chip is inert.
  body.querySelectorAll('.mp-oss-card').forEach((card) => {
    const p = (_mpState.ossProjects || []).find((x) => x.id === card.dataset.ossId);
    card.addEventListener('click', (e) => {
      // 接入 is an explicit install request (button shows only when not
      // installed) → install prompt, no task slot.
      if (e.target.closest('[data-oss-connect]')) { e.stopPropagation(); if (p) prefillCommander(ossInstallPromptFor(p)); return; }
      if (e.target.closest('[data-oss-installed]')) { e.stopPropagation(); return; }
      if (p) ossOpenRepo(p);
    });
  });
}

function _mpOssCardHtml(p, cats, lang, isInstalled) {
  const desc = escapeHtml(ossDescFor(p));
  const icon = uiIconHtml(ossIconFor(p.category), 'mp-oss-card-icon');
  const catLabel = escapeHtml(ossCatLabel(p.category, cats));
  const action = isInstalled
    ? `<span class="mp-oss-installed" data-oss-installed>${uiIconHtml('check', 'mp-oss-installed-icon')}${escapeHtml(t('marketplace.oss_installed'))}</span>`
    : `<button type="button" class="btn btn-sm btn-primary mp-oss-connect" data-oss-connect>${escapeHtml(t('marketplace.oss_connect'))}</button>`;
  return `
    <div class="mp-oss-card" data-oss-id="${escapeHtml(p.id)}">
      <div class="mp-oss-card-head">
        <span class="mp-oss-card-glyph" style="--oss-c:${escapeHtml(p.color || 'var(--primary)')}">${icon}</span>
        <div class="mp-oss-card-id">
          <div class="mp-oss-card-name">${escapeHtml(p.name)}</div>
          <div class="mp-oss-card-repo">${escapeHtml(p.repo)}</div>
        </div>
      </div>
      <div class="mp-oss-card-desc">${desc}</div>
      <div class="mp-oss-card-foot">
        ${ossDriverBadgeHtml(p.driver)}
        <span class="mp-oss-card-cat">${catLabel}</span>
        ${action}
      </div>
    </div>`;
}

function _mpCardHtml(item, lang) {
  const kind = _mpState.tab;
  const status = _mpInstallStatus(kind, item);
  const installing = _mpState.installing.has(`${kind}:${item.id}`);
  const desc = pickDesc(item, lang) || '';
  const catLabel = _mpCategoryLabel(item.category, lang);
  const statusLabel = '';
  const versionLabel = t('marketplace.version').replace('{version}', String(item.version || ''));
  const avatar = kind === 'agent'
    ? renderAvatarHtml(item.icon, item.color, { size: 32, seed: item.id, extraClass: 'marketplace-card-avatar' })
    : '';
  const appCompatible = status.installed || status.updateAvailable || _mpItemAppCompatible(item);
  let btnClass = 'btn btn-sm btn-primary';
  let btnLabel = t('marketplace.install');
  let btnAttrs = `data-mp-install="${escapeHtml(kind)}" data-mp-id="${escapeHtml(item.id)}"`;
  let btnSpinner = '';
  if (installing) {
    btnClass = 'btn btn-sm is-disabled';
    btnLabel = status.updateAvailable ? t('marketplace.updating') : t('marketplace.installing');
    btnAttrs = 'disabled';
    btnSpinner = '<span class="marketplace-btn-spinner"></span>';
  } else if (!appCompatible) {
    btnClass = 'btn btn-sm is-disabled';
    btnLabel = t('marketplace.requires_app').replace('{version}', _mpMinAppVersion(item));
    btnAttrs = 'disabled title="' + escapeHtml(btnLabel) + '"';
  } else if (status.updateAvailable) {
    btnClass = 'btn btn-sm btn-primary';
    btnLabel = t('marketplace.update');
  } else if (status.installed) {
    btnClass = 'btn btn-sm is-disabled';
    btnLabel = t('marketplace.installed');
    btnAttrs = 'disabled';
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
          ${statusLabel ? `<span class="marketplace-card-chip is-status">${escapeHtml(statusLabel)}</span>` : ''}
        </div>
        <div class="marketplace-card-actions">
          <button type="button" class="${btnClass}" ${btnAttrs}>${btnSpinner}${escapeHtml(btnLabel)}</button>
        </div>
      </div>
    </div>
  `;
}

function _mpCategoryLabel(code, lang) {
  const canonical = _mpCanonicalCategoryCode(code);
  if (!canonical) return '';
  _mpMaybeRefreshCategoriesForCodes([canonical]);
  const stateCats = Array.isArray(_mpState?.categories) ? _mpState.categories : [];
  const cacheCats = Array.isArray(_mpCategoriesCache) ? _mpCategoriesCache : [];
  const c = stateCats.find((x) => _mpCanonicalCategoryCode(x.code) === canonical)
    || cacheCats.find((x) => _mpCanonicalCategoryCode(x.code) === canonical);
  if (!c) return _mpUnknownCategoryLabel();
  return pickLocalizedName(c, lang) || canonical;
}

// ─── Detail view rendering ───
async function _mpOpenDetail(kind, item, opts = {}) {
  const prevSelected = opts.preserveSkillState ? (_mpState.detailSkillSelected || 'SKILL.md') : 'SKILL.md';
  const prevSourceOpen = opts.preserveSkillState ? _mpState.detailSkillSourceOpen !== false : true;
  _mpState.detailKind = kind;
  _mpState.detailItem = item;
  _mpState.detailLoading = true;
  _mpState.detailError = '';
  _mpState.detailAgentJson = null;
  _mpState.detailSkillFiles = [];
  _mpState.detailSkillSelected = prevSelected;
  _mpState.detailSkillFileText = '';
  _mpState.detailSkillLoadError = '';
  _mpState.detailSkillSourceOpen = prevSourceOpen;
  _mpShowDetailView();
  _mpRenderDetail();

  try {
    if (kind === 'agent') {
      const detail = await window.orkas.invoke('marketplace.detailAgent', {
        id: item.id, version: item.version,
        published_at: item.published_at, updated_at: item.updated_at,
        min_app_version: _mpMinAppVersion(item),
      });
      if (!detail || detail.ok === false) throw _mpErrorFromResponse(detail, 'detail failed');
      _mpState.detailAgentJson = detail.agent_json;
    } else {
      try {
        const detail = await window.orkas.invoke('marketplace.detailSkill', {
          id: item.id, version: item.version,
          published_at: item.published_at, updated_at: item.updated_at,
          min_app_version: _mpMinAppVersion(item),
        });
        if (!detail || detail.ok === false) throw _mpErrorFromResponse(detail, 'detail failed');
        const files = await window.orkas.invoke('marketplace.cacheSkillFiles', { id: item.id });
        _mpState.detailSkillFiles = (files && files.list) || [];
        const selected = _mpState.detailSkillFiles.find((f) => f.path === _mpState.detailSkillSelected)
          ? _mpState.detailSkillSelected
          : 'SKILL.md';
        _mpState.detailSkillSelected = selected;
        if (_mpState.detailSkillFiles.find((f) => f.path === selected)) {
          const r = await window.orkas.invoke('marketplace.cacheSkillRead', { id: item.id, file: selected });
          _mpState.detailSkillFileText = (r && r.content) || '';
        }
      } catch (err) {
        _mpState.detailSkillLoadError = _mpUserErrorMessage(err, 'marketplace.action_failed_retry_later');
      }
    }
  } catch (err) {
    _mpState.detailError = _mpUserErrorMessage(err, 'marketplace.action_failed_retry_later');
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
  const statusLabel = '';
  const versionLabel = t('marketplace.version').replace('{version}', String(item.version || ''));
  const status = _mpInstallStatus(kind, item);
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
  // Name stays ellipsized; version/category render as chips so both agent and skill details
  // expose marketplace version even when the title is long.
  panel.querySelector('[data-mp-detail-name]').textContent = item.name || item.id;
  panel.querySelector('[data-mp-detail-meta]').innerHTML = [
    item.version ? `<span class="marketplace-card-chip is-version">${escapeHtml(versionLabel)}</span>` : '',
    catLabel ? `<span class="marketplace-card-chip">${escapeHtml(catLabel)}</span>` : '',
    statusLabel ? `<span class="marketplace-card-chip is-status">${escapeHtml(statusLabel)}</span>` : '',
  ].filter(Boolean).join(' ');
  // (description used to render in a top-of-body `.marketplace-detail-desc` strip; now it's
  // the first section inside body — see `_mpAgentDetailHtml` / `_mpSkillDetailHtml`)

  const installBtn = panel.querySelector('[data-mp-detail-install]');
  installBtn.dataset.id = item.id;
  installBtn.dataset.kind = kind;
  installBtn.title = '';
  // When installed, repurpose the primary button as Uninstall (local-only — does NOT touch
  // the server row). When installing/uninstalling, disabled with progress text + inline
  // spinner so the user sees "still working" instead of a static label.
  const spinnerHtml = '<span class="marketplace-btn-spinner"></span>';
  if (installing) {
    const label = _mpState.uninstalling?.has(`${kind}:${item.id}`)
      ? t('marketplace.uninstalling')
      : (status.updateAvailable ? t('marketplace.updating') : t('marketplace.installing'));
    installBtn.innerHTML = `${spinnerHtml}${escapeHtml(label)}`;
    installBtn.classList.add('is-disabled'); installBtn.disabled = true;
    installBtn.dataset.action = '';
  } else if (status.updateAvailable) {
    installBtn.textContent = t('marketplace.update');
    installBtn.classList.remove('is-disabled', 'btn-danger');
    installBtn.classList.add('btn-primary');
    installBtn.disabled = false;
    installBtn.dataset.action = 'install';
  } else if (status.installed) {
    installBtn.textContent = t('marketplace.uninstall');
    installBtn.classList.remove('is-disabled', 'btn-primary');
    installBtn.classList.add('btn-danger');
    installBtn.disabled = false;
    installBtn.dataset.action = 'uninstall';
  } else if (!_mpItemAppCompatible(item)) {
    const label = t('marketplace.requires_app').replace('{version}', _mpMinAppVersion(item));
    installBtn.textContent = label;
    installBtn.title = label;
    installBtn.classList.remove('btn-primary', 'btn-danger');
    installBtn.classList.add('is-disabled');
    installBtn.disabled = true;
    installBtn.dataset.action = '';
  } else {
    installBtn.textContent = t('marketplace.install');
    installBtn.classList.remove('is-disabled', 'btn-danger');
    installBtn.classList.add('btn-primary');
    installBtn.disabled = false;
    installBtn.dataset.action = 'install';
  }

  // Dev-only delete button is rendered + revealed by marketplace_dev.js via the
  // `onMarketplaceDetailRendered` hook below. the open-source build has no such file — hook is undefined
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
          _mpState.detailSkillFileText = `// load failed: ${_mpUserErrorMessage(err, 'marketplace.action_failed_retry_later')}`;
        }
        _mpRenderDetail();
      });
    });
    // Source tree defaults open in marketplace skill previews; preserve the user's
    // current open/closed choice across re-renders while they stay in this detail view.
    const toggle = body.querySelector('[data-mp-source-toggle]');
    const panel = body.querySelector('[data-mp-source-panel]');
    if (toggle && panel) {
      const open = _mpState.detailSkillSourceOpen !== false;
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

function _mpAgentTextList(agent, key) {
  const raw = agent && (agent[key] || (agent.profile && agent.profile[key]));
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === 'string') return normalizeDisplayText(item);
    if (!item || typeof item !== 'object') return '';
    return normalizeDisplayText(item.description || item.title || item.name || '');
  }).filter(Boolean).slice(0, 20);
}

function _mpAgentReadonlyListItemHtml(text, key) {
  if (!text) return '';
  const iconKind = key === 'standards' ? 'standard' : 'ability';
  const iconHtml = typeof _agentDetailListIconHtml === 'function'
    ? _agentDetailListIconHtml(iconKind)
    : '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';
  return `
    <div class="agents-detail-list-item">
      <span class="agents-detail-list-icon is-${escapeHtml(iconKind)}" aria-hidden="true">${iconHtml}</span>
      <span class="agents-detail-list-text">${escapeHtml(text)}</span>
    </div>
  `;
}

function _mpAgentInputRefs(agent) {
  const cleanInputTitle = (value) => normalizeDisplayText(value)
    .replace(/\s*[（(]\s*(可选|选填|optional)\s*[）)]\s*$/i, '')
    .replace(/\s*[（(]\s*(必填|required)\s*[）)]\s*$/i, '')
    .trim();
  return Array.isArray(agent && agent.inputs)
    ? agent.inputs.map((input) => ({
        title: cleanInputTitle(input && (input.label || input.id || '')),
        description: normalizeDisplayText(input && (input.description || input.type || '')),
        required: !!(input && input.required === true),
      })).filter((input) => input.title)
    : [];
}

function _mpAgentInputChipHtml(input) {
  if (!input || !input.title) return '';
  const state = input.required ? t('agents.input_required') : t('agents.input_optional');
  return `
    <span class="agents-profile-chip agents-input-chip" title="${escapeHtml(input.description || '')}">
      <span>${escapeHtml(input.title)}</span>
      <small>${escapeHtml(state)}</small>
    </span>
  `;
}

function _mpOutputFormatLabel(value) {
  switch (value) {
    case 'text':
    case 'markdown_only':
      return t('agents.output_format_text');
    case 'dashboard':
      return t('agents.output_format_dashboard');
    case 'artifact':
    case 'allow_artifacts':
      return t('agents.output_format_artifact');
    case 'auto':
    default:
      return t('agents.output_format_auto');
  }
}

function _mpAgentInputOutputHtml(agent) {
  const inputRefs = _mpAgentInputRefs(agent);
  const outputLabel = agent && agent.runtime && agent.runtime.kind === 'cli'
    ? ''
    : _mpOutputFormatLabel(agent && agent.output_format);
  if (!inputRefs.length && !outputLabel) return '';
  return `
    <div class="agents-detail-section" id="marketplace-agent-input-output-section">
      <div class="agents-detail-label">${escapeHtml(t('agents.label_input_output'))}</div>
      <div class="agents-detail-io">
        ${inputRefs.length ? `
          <div class="agents-detail-io-row">
            <div class="agents-detail-io-label">${escapeHtml(t('agents.label_inputs'))}</div>
            <div class="agents-detail-tag-row">${inputRefs.map(_mpAgentInputChipHtml).join('')}</div>
          </div>
        ` : ''}
        ${outputLabel ? `
          <div class="agents-detail-io-row">
            <div class="agents-detail-io-label">${escapeHtml(t('agents.label_output_format'))}</div>
            <div class="agents-detail-output-text">${escapeHtml(outputLabel)}</div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// Agent body mirrors the installed agent detail style, but marketplace previews are
// install-time content only: no runtime data and no user-specific memory.
function _mpAgentDetailHtml(agentJson) {
  if (!agentJson) return `<div class="empty">${escapeHtml(t('marketplace.empty'))}</div>`;
  const lang = getLang();
  const desc = pickDesc(agentJson, lang).trim();
  const workflow = String(agentJson.workflow || '').trim();
  const knowhow = _mpAgentTextList(agentJson, 'knowhow');
  const standards = _mpAgentTextList(agentJson, 'standards');
  const placeholderHtml = `<span class="agents-detail-placeholder">${escapeHtml(t('agents.placeholder_unset'))}</span>`;

  return `<div class="agents-detail-body marketplace-detail-body-inner">
    <div class="agents-detail-hero">
      <div class="agents-detail-section agents-detail-intro-section">
        <div class="agents-detail-desc">${desc ? escapeHtml(desc) : placeholderHtml}</div>
      </div>
    </div>
    ${knowhow.length ? `
      <div class="agents-detail-section">
        <div class="agents-detail-label">${escapeHtml(t('agents.label_knowhow'))}</div>
        <p class="agents-detail-section-desc">${escapeHtml(t('agents.knowhow_desc'))}</p>
        <div class="agents-detail-list">${knowhow.map((item) => _mpAgentReadonlyListItemHtml(item, 'knowhow')).join('')}</div>
      </div>
    ` : ''}
    ${standards.length ? `
      <div class="agents-detail-section">
        <div class="agents-detail-label">${escapeHtml(t('agents.label_delivery_standards'))}</div>
        <p class="agents-detail-section-desc">${escapeHtml(t('agents.delivery_standards_desc'))}</p>
        <div class="agents-detail-list">${standards.map((item) => _mpAgentReadonlyListItemHtml(item, 'standards')).join('')}</div>
      </div>
    ` : ''}
    ${_mpAgentInputOutputHtml(agentJson)}
    <div class="agents-detail-section agents-detail-section-workflow">
      <div class="agents-detail-label">${escapeHtml(t('agents.label_workflow'))}</div>
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
  const loadError = _mpState.detailSkillLoadError || '';

  let treeHtml = '';
  if (loadError && !files.length) {
    treeHtml = `<div class="empty">${escapeHtml(t('marketplace.load_failed'))}: ${escapeHtml(loadError)}</div>`;
  } else {
    treeHtml = files.map((f) => {
      const active = f.path === selected ? ' active' : '';
      return `<div class="skill-tree-node skill-tree-file${active}" data-mp-skill-file="${escapeHtml(f.path)}">
        <span class="skill-tree-label">${escapeHtml(f.path)}</span>
        <span class="muted" style="margin-left:auto;font-size:11px">${_fmtBytes(f.bytes)}</span>
      </div>`;
    }).join('');
  }

  const isMd = selected.toLowerCase().endsWith('.md');
  let bodyHtml = '';
  if (loadError) {
    bodyHtml = `<div class="empty">${escapeHtml(t('marketplace.load_failed'))}: ${escapeHtml(loadError)}</div>`;
  } else if (isMd) {
    bodyHtml = renderMarkdownFull(text);
  } else {
    bodyHtml = `<pre class="code-view"><code>${escapeHtml(text)}</code></pre>`;
  }
  const placeholderHtml = `<span class="agents-detail-placeholder">${escapeHtml(t('agents.placeholder_unset'))}</span>`;
  const sourceOpen = _mpState.detailSkillSourceOpen !== false;

  return `
    <div class="skills-detail-content marketplace-detail-body-inner">
      <section class="skills-doc-section">
        <h3 class="skills-doc-section-label">${escapeHtml(t('skills.label_summary'))}</h3>
        <div class="skills-doc-section-body">${summary ? escapeHtml(summary) : placeholderHtml}</div>
      </section>
      <section class="skills-doc-section skills-usage-section">
        <h3 class="skills-doc-section-label skills-usage-label">
          <span>${escapeHtml(t('skills.label_usage'))}</span>
          <button type="button" class="skills-source-toggle${sourceOpen ? ' is-open' : ''}" data-mp-source-toggle aria-expanded="${sourceOpen ? 'true' : 'false'}">
            <span class="skills-source-toggle-caret" aria-hidden="true">${typeof window !== 'undefined' && typeof window.uiIconHtml === 'function' ? window.uiIconHtml('chevron-right', 'ui-icon') : ''}</span>
            <span>${escapeHtml(t('skills.label_source'))}</span>
          </button>
        </h3>
        <div class="skills-source-panel" data-mp-source-panel${sourceOpen ? '' : ' style="display:none"'}>
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

function _mpInstallKindLabel(kind) {
  const key = kind === 'skill' ? 'marketplace_request.kind_skill' : 'marketplace_request.kind_agent';
  const label = t(key);
  if (label && label !== key) return label;
  return kind === 'skill' ? 'Skill' : 'Agent';
}

function _mpInstallFailedName(kind, item, err) {
  const failedKind = err?.marketplaceKind || kind;
  const failedId = err?.marketplaceId || '';
  const itemId = item?.id || '';
  const itemName = item?.name || '';
  if (failedKind === kind && failedId && failedId === itemId && itemName) return itemName;
  if (err?.marketplaceName && err.marketplaceName !== failedId) return err.marketplaceName;
  if (failedKind !== kind && failedId) return failedId;
  if (failedKind === kind && itemName) return itemName;
  return err?.marketplaceName || itemName || itemId || failedId || '';
}

function _mpInstallFailedText(kind, item, err) {
  const failedKind = err?.marketplaceKind || kind;
  const failedName = _mpInstallFailedName(kind, item, err);
  const reason = (err && err.marketplaceAppUpdateRequired)
    ? t('marketplace.app_update_required')
        .replace('{minimum}', String(err.marketplaceMinAppVersion || _mpMinAppVersion(item) || ''))
        .replace('{current}', String(err.marketplaceCurrentAppVersion || ''))
    : _mpUserErrorMessage(err, 'marketplace.action_failed_retry_later');
  const tmpl = t('marketplace.install_failed_resource');
  if (tmpl && tmpl !== 'marketplace.install_failed_resource') {
    return tmpl
      .replace('{kind}', _mpInstallKindLabel(failedKind))
      .replace('{name}', failedName)
      .replace('{reason}', reason);
  }
  return t('marketplace.install_failed').replace(
    '{reason}',
    `${_mpInstallKindLabel(failedKind)}: ${failedName}: ${reason}`,
  );
}

function _mpInstallErrorFromResponse(r) {
  const err = _mpErrorFromResponse(r, 'install failed');
  if (r && r.marketplaceKind) err.marketplaceKind = r.marketplaceKind;
  if (r && r.marketplaceId) err.marketplaceId = r.marketplaceId;
  if (r && r.marketplaceName) err.marketplaceName = r.marketplaceName;
  if (r && r.marketplaceReason) err.marketplaceReason = r.marketplaceReason;
  if (r && r.qualityReport) err.qualityReport = r.qualityReport;
  return err;
}

function _mpIsMissingDependencySkillError(requestedKind, err) {
  const reason = String(err?.marketplaceReason || err?.message || err || '').toLowerCase();
  return requestedKind === 'agent'
    && err?.marketplaceKind === 'skill'
    && (reason === 'not_found' || reason.includes('not_found'));
}

function _mpTrackInstallFailure(kind, item, err, surface = 'marketplace') {
  try {
    if (!window.Monitor || !_mpIsMissingDependencySkillError(kind, err)) return;
    (() => {})('marketplace_dependency_skill_missing', {
      surface,
      requested_kind: kind,
      requested_id: item?.id || '',
      requested_name: item?.name || '',
      dependency_skill_id: err?.marketplaceId || '',
      dependency_skill_name: err?.marketplaceName || '',
      reason: err?.marketplaceReason || err?.message || String(err || ''),
    });
  } catch (_) { /* telemetry must never affect install UX */ }
}

async function _mpInstall(kind, id, itemOverride = null) {
  const item = itemOverride || (kind === 'agent' ? _mpState.agents : _mpState.skills).find((x) => x.id === id);
  if (!item) return;
  const key = `${kind}:${id}`;
  if (_mpState.installing.has(key)) return;
  _mpState.installing.add(key);
  _mpRender();
  const invokeInstall = async (force) => {
    const channel = kind === 'agent' ? 'marketplace.installAgent' : 'marketplace.installSkill';
    const r = await window.orkas.invoke(channel, {
      id, name: item.name || '',
      version: item.version,
      published_at: item.published_at, updated_at: item.updated_at,
      min_app_version: _mpMinAppVersion(item),
      ...(force ? { force: true } : {}),
    });
    if (!r || r.ok === false) throw _mpInstallErrorFromResponse(r);
  };
  const markInstalled = async () => {
    _mpMarkInstalled(kind, item);
    _mpPersistInstalled();
    if (typeof loadAgents === 'function' && kind === 'agent') await loadAgents(true);
    if (typeof loadSkills === 'function' && kind === 'skill') await loadSkills(true);
  };
  try {
    await invokeInstall(false);
    await markInstalled();
    // Success: no toast — the button flips to "Installed" + state set above is the signal.
    // (Failure still alerts because the user otherwise has no way to know why nothing happened.)
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _mpTrackInstallFailure(kind, item, err);
    // Quality validator rejection → show the structured violation list
    // instead of the generic install-failed alert. Falls back to alert if
    // the report can't be loaded.
    if (typeof isQualityRejectionError === 'function' && isQualityRejectionError(msg)) {
      const rejectedKind = err?.marketplaceKind || kind;
      const rejectedId = err?.marketplaceId || id;
      const rejectedName = err?.marketplaceName || item.name || id;
      const report = err?.qualityReport || await readQualityReport(rejectedKind, rejectedId);
      if (report) {
        const title = t('quality.install_rejected_title').replace('{name}', rejectedName);
        const forceLabel = (() => {
          const v = t('quality.force_install');
          return v === 'quality.force_install' ? 'Install anyway' : v;
        })();
        const action = await showValidationReport({ title, report, forceLabel });
        if (action === 'force') {
          try {
            await invokeInstall(true);
            await markInstalled();
          } catch (forceErr) {
            uiAlert(_mpInstallFailedText(kind, item, forceErr));
          }
        }
      } else {
        uiAlert(_mpInstallFailedText(kind, item, err));
      }
    } else {
      uiAlert(_mpInstallFailedText(kind, item, err));
    }
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
  const status = _mpInstallStatus(kind, item);
  if (status.installed && !status.updateAvailable) await _mpUninstall(kind, item.id);
  else await _mpInstall(kind, item.id, item);
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
    if (kind === 'agent') _mpState.installedAgentMeta?.delete(id);
    else _mpState.installedSkillMeta?.delete(id);
    _mpPersistInstalled();
    if (typeof loadAgents === 'function' && kind === 'agent') await loadAgents(true);
    if (typeof loadSkills === 'function' && kind === 'skill') await loadSkills(true);
    // Success: button flips back to "Install" — no toast needed. (Failures still alert.)
  } catch (err) {
    const msg = _mpUserErrorMessage(err, 'marketplace.action_failed_retry_later');
    uiAlert(t('marketplace.uninstall_failed').replace('{reason}', msg));
  } finally {
    _mpState.installing.delete(key);
    _mpState.uninstalling.delete(key);
    _mpRender();
    if (_mpState.view === 'detail') _mpRenderDetail();
  }
}

function _mpMarkInstalled(kind, item) {
  const ids = kind === 'agent' ? _mpState.installedAgentIds : _mpState.installedSkillIds;
  const map = kind === 'agent' ? _mpState.installedAgentMeta : _mpState.installedSkillMeta;
  ids.add(item.id);
  if (map) {
    map.set(item.id, _mpNormalizeInstallMeta({
      id: item.id,
      version: item.version,
      published_at: item.published_at,
      updated_at: item.updated_at,
      min_app_version: _mpMinAppVersion(item),
    }));
  }
}

function _mpInstallStatus(kind, item) {
  const ids = kind === 'agent' ? _mpState.installedAgentIds : _mpState.installedSkillIds;
  const map = kind === 'agent' ? _mpState.installedAgentMeta : _mpState.installedSkillMeta;
  const installed = ids?.has(item.id) === true;
  const meta = map?.get(item.id) || null;
  return { installed, updateAvailable: installed && _mpMarketplaceItemIsNewer(item, meta) };
}

function _mpMarketplaceItemIsNewer(item, local) {
  if (!item || !local) return false;
  const versionCmp = _mpCompareVersions(item.version, local.version);
  if (versionCmp > 0) return true;
  const remoteFresh = _mpFreshnessAt(item);
  const localFresh = _mpFreshnessAt(local);
  return Number.isFinite(remoteFresh) && Number.isFinite(localFresh) && remoteFresh > localFresh;
}

function _mpFreshnessAt(row) {
  const v = row?.updated_at ?? row?.marketplace_updated_at ?? row?.published_at ?? row?.marketplace_published_at;
  return typeof v === 'number' ? v : NaN;
}

function _mpCompareVersions(a, b) {
  const aa = _mpVersionTokens(a);
  const bb = _mpVersionTokens(b);
  if (!aa.length || !bb.length) return 0;
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
  }
  return 0;
}

function _mpCompareMarketplaceName(a, b) {
  const ka = _mpMarketplaceNameSortKey(a);
  const kb = _mpMarketplaceNameSortKey(b);
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return String(a?.id || '').localeCompare(String(b?.id || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function _mpMarketplaceNameSortKey(item) {
  const name = String(item?.name || item?.id || '');
  return (typeof pinyinSortKey === 'function') ? pinyinSortKey(name) : name.toLowerCase();
}

function _mpVersionTokens(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  if (!s) return [];
  return (s.match(/\d+|[a-zA-Z]+/g) || []).map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
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
    const r = await window.orkas.invoke('marketplace.categories', { local_only: true });
    categories = (r && r.list) || [];
  } catch { /* swallowed — main's fallback handles it */ }
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  _aiSelectMount(el, {
    options: categories.map((c) => ({
      value: c.code,
      label: pickLocalizedName(c, lang) || c.code,
    })),
    value: initialValue || (categories[0] && categories[0].code) || '',
  });
}

// Dev-only `openMarketplaceUpload` + `_mpShowUploadWithCategoryDialog` live in
// `marketplace_dev.js` (physically excluded from the open-source build via SyncCode strip-rules).
// Callers (agents.js / skills.js per-row menu) check `typeof openMarketplaceUpload === 'function'`
// to decide whether to show the upload entry — the open-source build has no marketplace_dev.js loaded,
// so the menu items just don't appear.
window.addEventListener('i18n-change', _mpOnI18n);
window.addEventListener('oss-catalog-updated', (e) => {
  if (!isMarketplaceOpen() || !_mpState || _mpState.tab !== 'oss') return;
  const d = (e && e.detail) || {};
  if (d.homeOnly) return;
  if ((d.category || '') !== (_mpState.ossCategory || '')) return;
  if ((d.q || '') !== (_mpState.ossQ || '')) return;
  _mpLoadOss({ forceState: true, revalidate: false }).catch(() => {});
});
_mpScheduleReconcileWatchInit();
