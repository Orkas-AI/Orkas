// Open-source-driven · new-chat Quick task entry + shared helpers for the
// marketplace「开源项目」专区.
//
// Data is the curated catalog served by `marketplace.listProjects` (config-as-
// code on the Server — see PC/docs/plans/oss-driven.md). Marketplace listings
// use the cache layer below, keyed by category/search options.
//
// The new-chat entry opens the marketplace's Open Source page in the current
// content surface. Marketplace owns the return stack, so Back returns directly
// to New Task without switching the selected sidebar tab.

const _ossLog = createLogger('oss');

function _ossTrackClick(action, data) {
  void action;
  void data;
}

function _ossTrackEvent(action, data) {
  void action;
  void data;
}

// category code → centralized ui-icon name (icons.js). We deliberately do NOT
// render the unicode project glyph as an icon (CLAUDE.md: icons go through the
// icon module).
// Keyed by the OSS category codes the Server actually serves (see
// oss_catalog_mgr.py::DEFAULT_OSS_CATEGORIES + conf/marketplace/oss_projects.json).
// Unknown codes fall back to 'sparkles', so keep this in sync when a category is
// added Server-side (office/slides are first-party curated categories).
const _OSS_CAT_ICON = {
  anim: 'sparkles',
  browser: 'globe',
  office: 'file-text',
  slides: 'presentation',
};
function ossIconFor(cat) { return _OSS_CAT_ICON[cat] || 'sparkles'; }

// Cache contract mirrors marketplace agent/skill listings:
// renderer Map for hot reads + main-process `marketplace/listings.json` for
// cold-start hydration + stale-while-revalidate. Cached rows render first;
// network refreshes are throttled per key so re-renders/i18n changes do not
// hammer the Server.
const OSS_CATALOG_REVALIDATE_MS = 5 * 60 * 1000;
const OSS_MARKETPLACE_PAGE_SIZE = 100;
// Bump this when the built-in OSS catalog shape changes. The renderer hydrates
// disk cache before asking main/server, so old project keys can otherwise keep
// the home strip pinned to a pre-release catalog after an app restart.
const OSS_CATALOG_CACHE_VERSION = 5;
let _ossCatalogHydrated = false;
let _ossCatalogHydratePromise = null;
const _ossCatalogCache = new Map();
const _ossCatalogInflight = new Map();
const _ossCatalogNextRefreshAt = new Map();
const _ossCatalogColdRefreshChecked = new Set();

function _ossNormalizeCatalogOpts(forceOrOpts) {
  if (typeof forceOrOpts === 'boolean') return { force: forceOrOpts };
  const raw = forceOrOpts && typeof forceOrOpts === 'object' ? forceOrOpts : {};
  const size = Number(raw.size);
  const revalidate = raw.revalidate === 'always' || raw.revalidate === 'cold-start'
    ? raw.revalidate
    : raw.revalidate !== false;
  return {
    homeOnly: raw.homeOnly === true || raw.home_only === true,
    category: String(raw.category || '').trim(),
    q: String(raw.q || '').trim(),
    ...(Number.isFinite(size) && size > 0 ? { size: Math.min(100, Math.max(1, Math.floor(size))) } : {}),
    force: raw.force === true,
    revalidate,
  };
}

function ossCatalogCacheKey(forceOrOpts) {
  const opts = _ossNormalizeCatalogOpts(forceOrOpts);
  return [
    'project',
    OSS_CATALOG_CACHE_VERSION,
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
    sourceType: 'cache',
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
          ts: typeof entry.ts === 'number' ? entry.ts : Date.now(),
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

function _ossEntryFromCatalogResponse(res) {
  const bundledFallback = !!(res && (res.source === 'bundled' || res.stale === true));
  const reportedSource = String((res && res.source) || '').trim();
  return {
    projects: Array.isArray(res && res.list) ? res.list : [],
    categories: Array.isArray(res && res.categories) ? res.categories : [],
    total: typeof (res && res.total) === 'number' ? res.total : (Array.isArray(res && res.list) ? res.list.length : 0),
    ts: bundledFallback ? 0 : Date.now(),
    sourceType: /^(?:server|bundled|cache)$/.test(reportedSource)
      ? reportedSource
      : (bundledFallback ? 'bundled' : 'server'),
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
  _ossCatalogNextRefreshAt.set(key, Date.now() + OSS_CATALOG_REVALIDATE_MS);
  const p = window.orkas.invoke('marketplace.listProjects', _ossCatalogPayload(opts))
    .then((res) => {
      const bundledFallback = !!(res && (res.source === 'bundled' || res.stale === true));
      const existing = _ossCatalogCache.get(key);
      if (bundledFallback && existing && existing.ts > 0) return existing;
      const entry = _ossEntryFromCatalogResponse(res);
      _ossCatalogCache.set(key, entry);
      _ossPersistCatalogCache(key, entry);
      if (notify) _ossDispatchCatalogUpdated(key, opts, entry);
      return entry;
    })
    .finally(() => { _ossCatalogInflight.delete(key); });
  _ossCatalogInflight.set(key, p);
  return p;
}

async function _ossLoadLocalCatalog(key, opts) {
  const res = await window.orkas.invoke('marketplace.listProjects', {
    ..._ossCatalogPayload(opts),
    local_only: true,
  });
  const entry = _ossEntryFromCatalogResponse(res);
  _ossCatalogCache.set(key, entry);
  _ossPersistCatalogCache(key, entry);
  return entry;
}

function _ossShouldRefreshCached(key, cached, opts) {
  if (!opts.revalidate || _ossCatalogInflight.has(key)) return false;
  if (opts.revalidate === 'always') return true;
  if (opts.revalidate === 'cold-start') {
    // One background refresh per renderer boot (cached entry still paints
    // first). No staleness gate on purpose: a just-launched OSS project must
    // reach users on their next app open, not after a multi-hour window.
    if (_ossCatalogColdRefreshChecked.has(key)) return false;
    _ossCatalogColdRefreshChecked.add(key);
    return true;
  }
  const now = Date.now();
  const stale = !cached || !cached.ts || (now - cached.ts > OSS_CATALOG_REVALIDATE_MS);
  const nextRefreshAt = _ossCatalogNextRefreshAt.get(key) || 0;
  return stale || now >= nextRefreshAt;
}

function _ossRefreshCatalogInBackground(key, opts) {
  _ossFetchCatalog(key, opts, true).catch((err) => {
    _ossLog.warn('oss catalog refresh failed', { error: err && err.message });
  });
}

async function loadOssCatalog(forceOrOpts) {
  const opts = _ossNormalizeCatalogOpts(forceOrOpts);
  const key = ossCatalogCacheKey(opts);
  if (opts.force) _ossCatalogCache.delete(key);
  await _ossHydrateCatalogCache();
  const cached = _ossCatalogCache.get(key);
  if (cached && !opts.force) {
    const missingCategories = !opts.homeOnly && !(cached.categories || []).length;
    if (opts.revalidate && (missingCategories || _ossShouldRefreshCached(key, cached, opts))) {
      _ossRefreshCatalogInBackground(key, opts);
    }
    return cached;
  }
  if (!opts.force) {
    try {
      const localEntry = await _ossLoadLocalCatalog(key, opts);
      if (_ossShouldRefreshCached(key, localEntry, opts)) _ossRefreshCatalogInBackground(key, opts);
      return localEntry;
    } catch (err) {
      _ossLog.warn('oss bundled catalog load failed', { error: err && err.message });
    }
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

function ossRepoInstallKey(repoOrUrl) {
  const raw = String(repoOrUrl || '').trim();
  if (!raw) return '';
  const normalized = raw
    .replace(/^git\+/i, '')
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
  return normalized ? `repo:${normalized}` : '';
}

// Prompt for ① capability cards: NAMES the project + URL, leaves the user's
// concrete task blank (a `[...]` placeholder the caret lands on), and tells the
// Commander to use the project. OfficeCLI is special: it is also the bundled
// Office engine, so point the model at built-in Office tools instead of install.
function ossPromptFor(p) {
  const isOfficeCli = p && (p.id === 'OfficeCLI' || p.name === 'OfficeCLI');
  const tmpl = (typeof t === 'function') ? t(isOfficeCli ? 'oss.office_prompt' : 'oss.prompt') : '';
  return tmpl
    .replace(/\{id\}/g, (p && p.id) || '')
    .replace(/\{name\}/g, (p && p.name) || '')
    .replace(/\{url\}/g, ossGithubUrl(p));
}

// Prompt for the ② marketplace「接入」button: an explicit install request (the
// button only shows for NOT-yet-installed packages, and there is no user task
// here). OfficeCLI is already bundled, so its marketplace action explains the
// built-in Office tools instead of asking for install.
function ossInstallPromptFor(p) {
  const isOfficeCli = p && (p.id === 'OfficeCLI' || p.name === 'OfficeCLI');
  const tmpl = (typeof t === 'function') ? t(isOfficeCli ? 'oss.office_install_prompt' : 'oss.install_prompt') : '';
  return tmpl
    .replace(/\{id\}/g, (p && p.id) || '')
    .replace(/\{name\}/g, (p && p.name) || '')
    .replace(/\{url\}/g, ossGithubUrl(p));
}

// Installed external packages (local/packages). Memoized; a row's `name`
// matches an OSS project `id` when the user already has it. Errors → empty set
// (everything shows as "接入"), and the memo is cleared so a later open retries.
let _ossInstalledPromise = null;
function loadOssInstalled(force) {
  if (force) _ossInstalledPromise = null;
  if (!_ossInstalledPromise) {
    _ossInstalledPromise = window.orkas.invoke('packages.list')
      .then((res) => {
        const keys = new Set();
        for (const p of (res && res.ok && Array.isArray(res.packages) ? res.packages : [])) {
          if (p && p.name) keys.add(String(p.name));
          const repoKey = ossRepoInstallKey(p && p.repo_url);
          if (repoKey) keys.add(repoKey);
        }
        return keys;
      })
      .catch(() => { _ossInstalledPromise = null; return new Set(); });
  }
  return _ossInstalledPromise;
}

function isOssProjectInstalled(p, installed) {
  if (!(installed instanceof Set) || !p) return false;
  return installed.has(p.id) || installed.has(ossRepoInstallKey(p.repo));
}

// Open the project's GitHub page in the system browser.
function ossOpenRepo(p) {
  const url = ossGithubUrl(p);
  if (url && window.orkas) window.orkas.invoke('auth.openExternal', { url }).catch(() => {});
}

// ③ behavior — prefill the Commander composer, focus, NO send. The caret lands
// on the first `[...]` placeholder (the blank task slot) when present, so the
// user types their specific task over it; otherwise it goes to the end.
function _setOssCommanderAttribution(input, raw) {
  if (!input || !input.dataset || !raw || typeof raw !== 'object') return;
  if (typeof window.setCommanderTemplateAttribution === 'function') {
    window.setCommanderTemplateAttribution(input, raw);
    return;
  }
  const resourceId = String(raw.resource_id || '').trim();
  const position = Math.round(Number(raw.position) || 0);
  input.dataset.commanderEntryPoint = 'oss_tool';
  if (/^[A-Za-z0-9._-]{1,64}$/.test(resourceId)) input.dataset.commanderResourceId = resourceId;
  input.dataset.commanderSource = 'commander_home';
  input.dataset.commanderRecipientType = 'commander';
  if (position > 0 && position <= 100) input.dataset.commanderPosition = String(position);
}

function prefillCommander(text, attribution, opts = {}) {
  const value = String(text || '');
  if (!value) return false;
  if (typeof setView === 'function') setView('new-chat');
  if (typeof setChatRecipient === 'function') setChatRecipient('new-chat', { kind: 'commander' });
  const input = document.getElementById('new-chat-input');
  if (!input) {
    _ossLog.warn('Commander OSS prefill failed: composer missing', {
      resource_id: String((attribution && attribution.resource_id) || ''),
    });
    return false;
  }
  input.value = value;
  if (attribution) _setOssCommanderAttribution(input, attribution);
  const m = opts.trackPlaceholder === false ? null : value.match(/\[[^\]]*\]/);
  if (m) input.dataset.ossTemplatePlaceholder = m[0];
  else delete input.dataset.ossTemplatePlaceholder;
  input.focus();
  try {
    if (m && typeof m.index === 'number') input.setSelectionRange(m.index, m.index + m[0].length);
    else input.setSelectionRange(value.length, value.length);
  } catch (_e) { /* selection unsupported */ }
  input.dispatchEvent(new Event('input', { bubbles: true })); // triggers autoGrow + chip state
  input.classList.add('is-prefilled');
  setTimeout(() => input.classList.remove('is-prefilled'), 1200);
  return true;
}

/**
 * Return the exact placeholder inserted by prefillCommander when the user has
 * not replaced it yet. Ordinary bracketed text is never inspected unless this
 * renderer-owned marker exists, so code/prompts containing `[value]` are safe.
 */
function unresolvedOssTemplatePlaceholder(input) {
  if (!input || !input.dataset) return '';
  const marker = String(input.dataset.ossTemplatePlaceholder || '');
  if (!marker) return '';
  const value = String(input.value || '');
  if (!value.includes(marker)) {
    delete input.dataset.ossTemplatePlaceholder;
    return '';
  }
  const start = value.indexOf(marker);
  input.focus();
  try { input.setSelectionRange(start, start + marker.length); } catch (_) { /* unsupported */ }
  return marker;
}

// Shared helper retained for tool-specific task prompts outside the home rail.
// It preserves a manual or Quick start draft and avoids nesting OSS wrappers.
function _ossPromptForComposer(p, input) {
  const prompt = ossPromptFor(p);
  const existing = String((input && input.value) || '').trim();
  const existingEntryPoint = String((input && input.dataset && input.dataset.commanderEntryPoint) || '');
  if (!existing || existingEntryPoint === 'oss_tool') return prompt;
  if (/\[[^\]]*\]/.test(prompt)) return prompt.replace(/\[[^\]]*\]/, () => existing);
  return `${prompt}\n\n${existing}`;
}

function _openOssMarketplace() {
  _ossTrackClick('commander_oss_quick_task', {
    source_view: 'new_chat',
    destination: 'marketplace_oss',
  });
  const load = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
  if (typeof load !== 'function') {
    _ossLog.warn('Commander OSS quick task failed: marketplace loader unavailable');
    return;
  }
  load('marketplace').then(() => openMarketplace('oss', {
    returnView: 'new-chat',
    preserveReturnTab: true,
  })).catch((err) => {
    _ossLog.warn('Commander OSS quick task failed to load marketplace', {
      error: err && err.message ? err.message : String(err || ''),
    });
  });
}

/** Bind the quick-start header's open-source entry — the single path from the
 * landing page into the marketplace「开源项目」list. */
function initOssQuickTask() {
  const link = document.getElementById('quick-panel-oss-more');
  if (!link || link.dataset.bound === '1') return;
  link.dataset.bound = '1';
  link.addEventListener('click', _openOssMarketplace);
}

window.addEventListener('i18n-change', () => {
  initOssQuickTask();
});

// Exposed for marketplace.js rendering + conversation.js Quick task init.
window.loadOssCatalog = loadOssCatalog;
window.ossCatalogCacheKey = ossCatalogCacheKey;
window.OSS_MARKETPLACE_PAGE_SIZE = OSS_MARKETPLACE_PAGE_SIZE;
window.loadOssInstalled = loadOssInstalled;
window.isOssProjectInstalled = isOssProjectInstalled;
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
window.unresolvedOssTemplatePlaceholder = unresolvedOssTemplatePlaceholder;
window.initOssQuickTask = initOssQuickTask;
