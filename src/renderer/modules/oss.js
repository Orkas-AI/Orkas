// Open-source-driven · ① new-chat capability strip + shared helpers for the
// marketplace「开源项目」专区 (②).
//
// Data is the curated catalog served by `marketplace.listProjects` (config-as-
// code on the Server — see PC/docs/plans/oss-driven.md). ① and ② share the
// same cache layer, keyed by home/category/search options.
//
// Clicking any card PREFILLS the Commander composer with a user-language task
// and focuses it — it does NOT auto-send (same contract as the scenario chips).
// The Commander then "installs-then-runs" the project; no new frontend logic,
// it reuses the existing CLI / MCP / skill mechanisms.

const _ossLog = createLogger('oss');

// category code → centralized ui-icon name (icons.js). We deliberately do NOT
// render the unicode project glyph as an icon (CLAUDE.md: icons go through the
// icon module).
// Keyed by the OSS category codes the Server actually serves (see
// marketplace_mgr.py::_OSS_CATEGORIES). Unknown codes fall back to 'sparkles',
// so re-add an icon here when a category is restored Server-side.
const _OSS_CAT_ICON = {
  anim: 'sparkles',
  browser: 'globe',
};
function ossIconFor(cat) { return _OSS_CAT_ICON[cat] || 'sparkles'; }

// Cache contract mirrors marketplace agent/skill listings:
// renderer Map for hot reads + main-process `marketplace/listings.json` for
// cold-start hydration + stale-while-revalidate when the cached row ages out.
const OSS_CATALOG_REVALIDATE_MS = 5 * 60 * 1000;
const OSS_MARKETPLACE_PAGE_SIZE = 100;
let _ossCatalogHydrated = false;
let _ossCatalogHydratePromise = null;
const _ossCatalogCache = new Map();
const _ossCatalogInflight = new Map();

function _ossNormalizeCatalogOpts(forceOrOpts) {
  if (typeof forceOrOpts === 'boolean') return { force: forceOrOpts };
  const raw = forceOrOpts && typeof forceOrOpts === 'object' ? forceOrOpts : {};
  const size = Number(raw.size);
  return {
    homeOnly: raw.homeOnly === true || raw.home_only === true,
    category: String(raw.category || '').trim(),
    q: String(raw.q || '').trim(),
    ...(Number.isFinite(size) && size > 0 ? { size: Math.min(100, Math.max(1, Math.floor(size))) } : {}),
    force: raw.force === true,
    revalidate: raw.revalidate !== false,
  };
}

function ossCatalogCacheKey(forceOrOpts) {
  const opts = _ossNormalizeCatalogOpts(forceOrOpts);
  return [
    'project',
    opts.homeOnly ? 'home' : 'all',
    opts.category || '',
    opts.q || '',
    opts.size || '',
  ].join('|');
}

function _ossCacheEntryFromListings(v) {
  if (!v || !Array.isArray(v.items) || typeof v.ts !== 'number') return null;
  return {
    projects: v.items,
    categories: Array.isArray(v.categories) ? v.categories : [],
    total: typeof v.total === 'number' ? v.total : v.items.length,
    ts: v.ts,
  };
}

async function _ossHydrateCatalogCache() {
  if (_ossCatalogHydrated) return;
  if (_ossCatalogHydratePromise) return _ossCatalogHydratePromise;
  _ossCatalogHydratePromise = (async () => {
    try {
      const data = await window.orkas.invoke('marketplace.getListingsCache');
      const entries = data && data.entries && typeof data.entries === 'object' ? data.entries : {};
      for (const [key, value] of Object.entries(entries)) {
        if (!String(key).startsWith('project|')) continue;
        const entry = _ossCacheEntryFromListings(value);
        if (entry) _ossCatalogCache.set(key, entry);
      }
    } catch { /* no disk cache yet */ }
    _ossCatalogHydrated = true;
  })().finally(() => { _ossCatalogHydratePromise = null; });
  return _ossCatalogHydratePromise;
}

function _ossPersistCatalogCache(key, entry) {
  try {
    window.orkas.invoke('marketplace.mergeListingsCache', {
      entries: {
        [key]: {
          items: entry.projects || [],
          categories: entry.categories || [],
          total: typeof entry.total === 'number' ? entry.total : (entry.projects || []).length,
          ts: entry.ts || Date.now(),
        },
      },
    }).catch(() => {});
  } catch { /* main IPC unavailable during early boot tests */ }
}

function _ossCatalogPayload(opts) {
  return {
    ...(opts.homeOnly ? { home_only: true } : {}),
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.q ? { q: opts.q } : {}),
    ...(typeof opts.size === 'number' ? { size: opts.size } : {}),
  };
}

function _ossDispatchCatalogUpdated(key, opts, entry) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
  try {
    window.dispatchEvent(new CustomEvent('oss-catalog-updated', {
      detail: {
        key,
        homeOnly: opts.homeOnly === true,
        category: opts.category || '',
        q: opts.q || '',
        size: opts.size || null,
        total: entry && typeof entry.total === 'number' ? entry.total : 0,
      },
    }));
  } catch { /* ignore */ }
}

async function _ossFetchCatalog(key, opts, notify) {
  if (_ossCatalogInflight.has(key)) return _ossCatalogInflight.get(key);
  const p = window.orkas.invoke('marketplace.listProjects', _ossCatalogPayload(opts))
    .then((res) => {
      const entry = {
        projects: Array.isArray(res && res.list) ? res.list : [],
        categories: Array.isArray(res && res.categories) ? res.categories : [],
        total: typeof (res && res.total) === 'number' ? res.total : (Array.isArray(res && res.list) ? res.list.length : 0),
        ts: Date.now(),
      };
      _ossCatalogCache.set(key, entry);
      _ossPersistCatalogCache(key, entry);
      if (notify) _ossDispatchCatalogUpdated(key, opts, entry);
      return entry;
    })
    .finally(() => { _ossCatalogInflight.delete(key); });
  _ossCatalogInflight.set(key, p);
  return p;
}

async function loadOssCatalog(forceOrOpts) {
  const opts = _ossNormalizeCatalogOpts(forceOrOpts);
  const key = ossCatalogCacheKey(opts);
  if (opts.force) _ossCatalogCache.delete(key);
  await _ossHydrateCatalogCache();
  const cached = _ossCatalogCache.get(key);
  if (cached && !opts.force) {
    const missingCategories = !opts.homeOnly && !(cached.categories || []).length;
    if (opts.revalidate && (missingCategories || Date.now() - cached.ts > OSS_CATALOG_REVALIDATE_MS)) {
      _ossFetchCatalog(key, opts, true).catch((err) => {
        _ossLog.warn('oss catalog refresh failed', { error: err && err.message });
      });
    }
    return cached;
  }
  return _ossFetchCatalog(key, opts, false);
}


function _ossLang() { return (typeof getLang === 'function' ? getLang() : 'en'); }
function ossTaskFor(p) { return (_ossLang() === 'zh' ? p.task_zh : p.task_en) || p.task_en || p.task_zh || ''; }
function ossDescFor(p) { return (_ossLang() === 'zh' ? p.description_zh : p.description_en) || p.description_en || p.description_zh || ''; }
function ossCatLabel(cat, categories) {
  const c = (categories || []).find((x) => x.code === cat);
  if (!c) return cat || '';
  return (typeof pickLocalizedName === 'function' ? pickLocalizedName(c, _ossLang()) : (c['name_' + _ossLang()] || c.name_en)) || c.code;
}

// Reusable driver badge (② only): install=box/blue · cli=terminal/violet ·
// mcp=plug/emerald. The colors live in CSS (.driver-badge--<driver>).
function ossDriverBadgeHtml(driver) {
  const map = { install: ['box', 'driver.install'], cli: ['terminal', 'driver.cli'], mcp: ['plug', 'driver.mcp'] };
  const m = map[driver];
  if (!m) return '';
  const label = (typeof t === 'function') ? t(m[1]) : m[1];
  return `<span class="driver-badge driver-badge--${escapeHtml(driver)}">${uiIconHtml(m[0], 'driver-badge-icon')}<span>${escapeHtml(label)}</span></span>`;
}

function ossGithubUrl(p) { return (p && p.repo) ? ('https://github.com/' + p.repo) : ''; }

// Prompt for ① capability cards: NAMES the project + URL, leaves the user's
// concrete task blank (a `[...]` placeholder the caret lands on), and tells the
// Commander to use the project (install first only if needed).
function ossPromptFor(p) {
  const tmpl = (typeof t === 'function') ? t('oss.prompt') : '';
  return tmpl.replace(/\{name\}/g, (p && p.name) || '').replace(/\{url\}/g, ossGithubUrl(p));
}

// Prompt for the ② marketplace「接入」button: an explicit install request (the
// button only shows for NOT-yet-installed packages, and there is no user task
// here) — so it just asks the Commander to install the project, no task slot.
function ossInstallPromptFor(p) {
  const tmpl = (typeof t === 'function') ? t('oss.install_prompt') : '';
  return tmpl.replace(/\{name\}/g, (p && p.name) || '').replace(/\{url\}/g, ossGithubUrl(p));
}

// Installed external packages (local/packages). Memoized; a row's `name`
// matches an OSS project `id` when the user already has it. Errors → empty set
// (everything shows as "接入"), and the memo is cleared so a later open retries.
let _ossInstalledPromise = null;
function loadOssInstalled(force) {
  if (force) _ossInstalledPromise = null;
  if (!_ossInstalledPromise) {
    _ossInstalledPromise = window.orkas.invoke('packages.list')
      .then((res) => new Set((res && res.ok && Array.isArray(res.packages) ? res.packages : []).map((p) => p.name)))
      .catch(() => { _ossInstalledPromise = null; return new Set(); });
  }
  return _ossInstalledPromise;
}

// Open the project's GitHub page in the system browser.
function ossOpenRepo(p) {
  const url = ossGithubUrl(p);
  if (url && window.orkas) window.orkas.invoke('auth.openExternal', { url }).catch(() => {});
}

// ③ behavior — prefill the Commander composer, focus, NO send. The caret lands
// on the first `[...]` placeholder (the blank task slot) when present, so the
// user types their specific task over it; otherwise it goes to the end.
function prefillCommander(text) {
  const value = String(text || '');
  if (!value) return;
  if (typeof setView === 'function') setView('new-chat');
  if (typeof setChatRecipient === 'function') setChatRecipient('new-chat', { kind: 'commander' });
  const input = document.getElementById('new-chat-input');
  if (!input) return;
  input.value = value;
  input.focus();
  const m = value.match(/\[[^\]]*\]/);
  try {
    if (m && typeof m.index === 'number') input.setSelectionRange(m.index, m.index + m[0].length);
    else input.setSelectionRange(value.length, value.length);
  } catch (_e) { /* selection unsupported */ }
  input.dispatchEvent(new Event('input', { bubbles: true })); // triggers autoGrow + chip state
  input.classList.add('is-prefilled');
  setTimeout(() => input.classList.remove('is-prefilled'), 1200);
}

// ① entry — render the task cards into #oss-entry-grid + bind clicks. Called on
// every new-chat view enter (and on i18n-change, since task text is localized).
async function initOssEntry(opts = {}) {
  const entry = document.getElementById('oss-entry');
  const grid = document.getElementById('oss-entry-grid');
  if (!entry || !grid) return;

  // Bind the "更多能力 →" header link once.
  const more = document.getElementById('oss-entry-more');
  if (more && !more.dataset.bound) {
    more.addEventListener('click', () => { if (typeof openMarketplace === 'function') openMarketplace('oss'); });
    more.dataset.bound = '1';
  }

  let data;
  try { data = await loadOssCatalog({ homeOnly: true, revalidate: opts.revalidate !== false }); }
  catch (err) { _ossLog.warn('oss entry load failed', { error: err && err.message }); entry.style.display = 'none'; return; }

  // ① receives the curated home subset from the Server. The Server config
  // controls how many rows are returned; the client renders whatever it gets.
  const projects = data.projects || [];
  if (!projects.length) { entry.style.display = 'none'; return; }
  entry.style.display = '';

  grid.innerHTML = projects.map((p) => {
    const task = escapeHtml(ossTaskFor(p));
    const by = escapeHtml(p.by || p.name || '');
    const icon = uiIconHtml(ossIconFor(p.category), 'oss-card-icon');
    const byLine = (typeof t === 'function') ? t('oss.driven_by').replace('{name}', by) : by;
    return `
      <button type="button" class="oss-card" data-oss-id="${escapeHtml(p.id)}">
        <span class="oss-card-top">
          <span class="oss-card-glyph" style="--oss-c:${escapeHtml(p.color || 'var(--primary)')}">${icon}</span>
          <span class="oss-card-task">${task}</span>
        </span>
        <span class="oss-card-by">${byLine}</span>
      </button>`;
  }).join('');

  grid.querySelectorAll('.oss-card').forEach((btn) => {
    const p = projects.find((x) => x.id === btn.dataset.ossId);
    btn.addEventListener('click', () => { if (p) prefillCommander(ossPromptFor(p)); });
  });
}

window.addEventListener('i18n-change', () => {
  if (document.getElementById('oss-entry-grid')) initOssEntry();
});
window.addEventListener('oss-catalog-updated', (e) => {
  const d = (e && e.detail) || {};
  if (!d.homeOnly) return;
  if (document.getElementById('oss-entry-grid')) initOssEntry({ revalidate: false });
});

// Exposed for marketplace.js (② rendering) + conversation.js (① init).
window.loadOssCatalog = loadOssCatalog;
window.ossCatalogCacheKey = ossCatalogCacheKey;
window.OSS_MARKETPLACE_PAGE_SIZE = OSS_MARKETPLACE_PAGE_SIZE;
window.loadOssInstalled = loadOssInstalled;
window.ossIconFor = ossIconFor;
window.ossTaskFor = ossTaskFor;
window.ossDescFor = ossDescFor;
window.ossCatLabel = ossCatLabel;
window.ossDriverBadgeHtml = ossDriverBadgeHtml;
window.ossGithubUrl = ossGithubUrl;
window.ossPromptFor = ossPromptFor;
window.ossInstallPromptFor = ossInstallPromptFor;
window.ossOpenRepo = ossOpenRepo;
window.prefillCommander = prefillCommander;
window.initOssEntry = initOssEntry;
